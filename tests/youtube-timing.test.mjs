import assert from "node:assert/strict";
import { test } from "node:test";
import { createYouTubeTiming } from "../lib/youtube-timing.js";
import { pointClips } from "../surge-deploy/live/timeline.js";
import { createMatchDetails } from "../lib/match-details.js";
import { createLiveSession, applyLiveCommand } from "../surge-deploy/live/engine.js";
import { randomUUID } from "node:crypto";

const videoId = "nf_W8XZa_mg";
const now = Date.parse("2026-10-17T03:00:00Z");
test("YouTube actual start is cached, in-flight calls are shared, and the key stays in the server header", async () => {
  let count = 0;
  let time = now;
  const lookup = createYouTubeTiming({ apiKey: "test-only-key", now: () => time, fetchImpl: async (url, options) => {
    count++;
    assert.equal(url.origin, "https://www.googleapis.com");
    assert.equal(url.searchParams.get("part"), "liveStreamingDetails");
    assert.equal(url.searchParams.has("key"), false);
    assert.equal(options.headers["X-Goog-Api-Key"], "test-only-key");
    assert.equal(options.redirect, "error");
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { ok: true, json: async () => ({ items: [{ id: videoId, liveStreamingDetails: { actualStartTime: "2026-10-17T01:00:00Z" } }] }) };
  } });
  const first = lookup(videoId);
  const second = lookup(videoId);
  const result = await first;
  assert.deepEqual(await second, result);
  assert.equal(result.actualStartTime, now - 7200000);
  assert.equal(count, 1);
  assert.deepEqual(await lookup(videoId), result);
  assert.equal(count, 1);
  time += 3600001;
  await lookup(videoId);
  assert.equal(count, 2);
});

test("private/non-live/future/mismatched videos never use publication time as broadcast start", async () => {
  for (const item of [null, { id: videoId, snippet: { publishedAt: "2026-10-17T01:00:00Z" } },
    { id: videoId, liveStreamingDetails: { scheduledStartTime: "2026-10-17T01:00:00Z" } },
    { id: videoId, liveStreamingDetails: { actualStartTime: "2027-01-01T00:00:00Z" } },
    { id: "other-id", liveStreamingDetails: { actualStartTime: "2026-10-17T01:00:00Z" } }]) {
    const lookup = createYouTubeTiming({ apiKey: "test", now: () => now, fetchImpl: async () => ({ ok: true, json: async () => ({ items: item ? [item] : [] }) }) });
    const result = await lookup(videoId);
    assert.equal(result.actualStartTime, null);
    assert.ok(result.timingNotice);
  }
});

test("missing key and upstream errors are recoverable without leaking credentials", async () => {
  let count = 0;
  const fail = async () => { count++; throw new Error("private-key-in-upstream-error"); };
  assert.equal((await createYouTubeTiming({ fetchImpl: fail })(videoId)).actualStartTime, null);
  assert.equal(count, 0);
  const lookup = createYouTubeTiming({ apiKey: "private-key", fetchImpl: fail });
  const result = await lookup(videoId);
  assert.equal(result.actualStartTime, null);
  assert.ok(!JSON.stringify(result).includes("private-key"));
  await lookup(videoId);
  assert.equal(count, 1, "failures have a short cache rather than repeatedly consuming quota");
  await assert.rejects(lookup("https://attacker.test"), (error) => error.status === 400);
});

test("point links preserve ledger times and only seek when alignment is known", () => {
  const points = [{ team: "A", elapsedMs: 12000, capturedAt: now }, { team: "B", elapsedMs: 22000, capturedAt: now + 10000 }];
  const session = { videoId, videoOffsetSeconds: 7200, points };
  assert.deepEqual(pointClips(session).map((point) => point.time), [7212, 7222]);
  assert.equal(pointClips(session)[0].start, 7204);
  assert.equal(pointClips({ ...session, videoOffsetSeconds: null })[0].playable, false);
  assert.equal(pointClips({ ...session, videoId: "" })[0].playable, false);
  assert.deepEqual(pointClips({ ...session, videoOffsetSeconds: -20 }).map((point) => point.playable), [false, true]);
  assert.equal(points[0].elapsedMs, 12000);
});

test("match detail aligns a saved game's tap times to the broadcast without mutating a cached lookup", async () => {
  const players = [1, 2, 3, 4].map((id) => ({ id: `p${id}`, name: `Player ${id}` }));
  const live = createLiveSession({ teamA: ["p1", "p2"], teamB: ["p3", "p4"], servingTeam: "A", nearTeam: "A" }, "owner", players, randomUUID(), "token", now);
  const send = (type, capturedAt, extra = {}) => applyLiveCommand(live, { type, operationId: randomUUID(), expectedRevision: live.revision, capturedAt, ...extra }, now + 60000);
  send("start", now);
  send("point", now + 10000, { team: "A" });
  send("finish", now + 20000, { matchEndedConfirmed: true });
  const id = randomUUID();
  let media = null;
  const cached = { actualStartTime: now - 7200000, timingNotice: "" };
  const handler = createMatchDetails({
    store: { find: async () => live, getMedia: async () => media, saveMedia: async (id, revision, value) => { media = value; return value; } },
    getMatch: async () => ({ id, teamA: live.teamA, teamB: live.teamB, scoreA: 1, scoreB: 0, createdBy: "owner" }),
    players: async () => players, authenticate: async () => ({ id: "owner", role: "member" }),
    readBody: async (req) => req.body, sendJson: (req, res, status, data) => { res.data = data; }, youtubeTiming: async () => cached,
  });
  const request = async () => {
    const res = {};
    await handler({ method: "POST", body: { youtubeUrl: `https://youtu.be/${videoId}`, timingMode: "auto", expectedRevision: media?.revision || 0, operationId: randomUUID() } }, res, `/matches/${id}/video`);
    return res.data;
  };
  const result = await request();
  assert.equal(result.videoOffsetSeconds, 7200);
  assert.equal(pointClips(result)[0].time, 7210);
  assert.equal(result.points[0].capturedAt, now + 10000);
  cached.actualStartTime = now - 3 * 86400000;
  const mismatch = await request();
  assert.equal(mismatch.videoOffsetSeconds, null);
  assert.match(mismatch.timingNotice, /날짜/);
  assert.equal(cached.timingNotice, "", "per-match mismatch notices cannot poison the shared cache");
});
