import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";

const source = await readFile(new URL("../surge-deploy/app.js", import.meta.url), "utf8");
const pollingCode = source.slice(source.indexOf("function setCurrentVideoAnalysisJob("), source.indexOf("function videoAnalysisStatusText("));

function browser() {
  const calls = [];
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    document: { hidden: false },
    window: {
      setInterval(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
      clearInterval(id) { timers.delete(id); },
    },
    apiFetch: async (url) => {
      calls.push(url);
      return calls.length === 1
        ? { job: { id: "job-1", status: "running_score_analysis", referenceFrames: ["photo"] }, version: "v1" }
        : { unchanged: true, version: "v1" };
    },
  });
  vm.runInContext(`
    let videoAnalysisPollTimer = null;
    let videoAnalysisPollInFlight = false;
    let videoAnalysisPollCache = null;
    let currentVideoAnalysisJob = { id: "job-1", status: "running_score_analysis" };
    let user = { id: "owner" };
    let renders = 0;
    const getCurrentUser = () => user;
    const normalizeVideoAnalysisJob = (job) => job;
    const mergeVideoAnalysisJobDetail = (previous, next) => ({ ...previous, ...next });
    const persistVideoAnalysisJobId = () => {};
    const renderVideoAnalysisPanel = () => { renders++; };
    const isVideoAnalysisPollingStatus = (status) => status === "running_score_analysis";
    const setVideoScoreResult = () => {};
    const apiMessage = (error) => error.message;
    const clearCurrentVideoAnalysisJob = () => { currentVideoAnalysisJob = null; };
    ${pollingCode}
  `, context);
  return { context, calls, timers, run: (code) => vm.runInContext(code, context) };
}

test("an unchanged response preserves the rendered frame and only sends a version", async () => {
  const page = browser();
  await page.run('pollVideoAnalysisJob("job-1")');
  await page.run('pollVideoAnalysisJob("job-1")');
  assert.deepEqual(page.calls, ["/api/video-analysis/jobs/job-1", "/api/video-analysis/jobs/job-1?version=v1"]);
  assert.equal(page.run("renders"), 1);
  assert.equal(page.run("currentVideoAnalysisJob.referenceFrames[0]"), "photo");
});

test("automatic polling uses 15 seconds and stops sending requests in a hidden tab", async () => {
  const page = browser();
  page.run('startVideoAnalysisPolling("job-1")');
  const timer = [...page.timers.values()][0];
  assert.equal(timer.ms, 15000);
  page.context.document.hidden = true;
  timer.fn();
  assert.equal(page.calls.length, 0);
  page.context.document.hidden = false;
  timer.fn();
  await Promise.resolve();
  assert.equal(page.calls.length, 1);
  page.run("stopVideoAnalysisPolling()");
  assert.equal(page.timers.size, 0);
});

test("slow requests do not overlap and a cleared job cannot reappear from a late response", async () => {
  const page = browser();
  let finish;
  let requests = 0;
  page.context.apiFetch = () => { requests++; return new Promise((resolve) => { finish = resolve; }); };
  const pending = page.run('pollVideoAnalysisJob("job-1")');
  await page.run('pollVideoAnalysisJob("job-1")');
  assert.equal(requests, 1);
  page.run("currentVideoAnalysisJob = null");
  finish({ job: { id: "job-1", status: "running_score_analysis" }, version: "v1" });
  await pending;
  assert.equal(page.run("currentVideoAnalysisJob"), null);
  assert.equal(page.run("renders"), 0);
  assert.equal(page.run("videoAnalysisPollInFlight"), false);
});

test("local changes invalidate the cached version and completion stops polling", async () => {
  const page = browser();
  await page.run('pollVideoAnalysisJob("job-1")');
  page.run('setCurrentVideoAnalysisJob({ id: "job-1", status: "running_score_analysis" })');
  assert.equal(page.run("videoAnalysisPollCache"), null);
  page.run('startVideoAnalysisPolling("job-1")');
  page.context.apiFetch = async () => ({ job: { id: "job-1", status: "waiting_confirmation" }, version: "v2" });
  await page.run('pollVideoAnalysisJob("job-1")');
  assert.equal(page.run("currentVideoAnalysisJob.status"), "waiting_confirmation");
  assert.equal(page.timers.size, 0);
});

test("a changed login discards the previous user's pending response", async () => {
  const page = browser();
  let finish;
  page.context.apiFetch = () => new Promise((resolve) => { finish = resolve; });
  const pending = page.run('pollVideoAnalysisJob("job-1")');
  page.run('user = { id: "other" }');
  finish({ job: { id: "job-1", status: "waiting_confirmation" }, version: "v2" });
  await pending;
  assert.equal(page.run("renders"), 0);
});
