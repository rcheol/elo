import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";

const source = await readFile(new URL("../surge-deploy/app.js", import.meta.url), "utf8");
const code = source.slice(source.indexOf("async function refreshAfterExternalMatch("), source.indexOf("function revealLinkedMatch("));
function browser() {
  const calls = [];
  const errors = [];
  const context = vm.createContext({
    window: { badmintonEloAppReady: true }, document: { hidden: false, querySelector: () => null },
    Date: { now: () => 10000 },
    refreshState: async (options) => calls.push(options),
    showApiError: (error) => errors.push(error.message),
  });
  vm.runInContext(`let externalRefreshInFlight=false, lastExternalRefresh=0, editingMatchId=null, stickerDrag=null; ${code}`, context);
  return { context, calls, errors, run: () => vm.runInContext("refreshAfterExternalMatch()", context) };
}
test("returning to rankings refreshes once while preserving all scroll positions", async () => {
  const page = browser();
  await page.run(); await page.run();
  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0].preserveScroll, true);
  page.context.Date.now = () => 14000;
  await page.run(); assert.equal(page.calls.length, 2);
});
test("hidden and uninitialized rankings do not fetch full state", async () => {
  const page = browser();
  page.context.document.hidden = true; await page.run();
  page.context.document.hidden = false; page.context.window.badmintonEloAppReady = false; await page.run();
  assert.equal(page.calls.length, 0);
});
test("slow refreshes never overlap and failed refreshes can retry", async () => {
  const page = browser(); let reject; let calls = 0;
  page.context.refreshState = () => { calls++; return new Promise((_, fail) => { reject = fail; }); };
  const first = page.run();
  page.context.Date.now = () => 20000; await page.run();
  assert.equal(calls, 1);
  reject(new Error("offline")); await first;
  assert.deepEqual(page.errors, ["offline"]);
  page.context.refreshState = async () => { calls++; };
  await page.run(); assert.equal(calls, 2);
});
test("returning while a dialog is open does not overwrite edits", async () => {
  const page = browser();
  page.context.document.querySelector = () => ({});
  await page.run(); assert.equal(page.calls.length, 0);
});
