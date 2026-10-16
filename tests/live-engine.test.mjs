import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createLiveSession, applyLiveCommand, liveSnapshot, publicLiveSession, youtubeId } from "../surge-deploy/live/engine.js";

const start = 1700000000000;
const players = [1, 2, 3, 4].map((id) => ({ id: `p${id}`, name: `Player ${id}` }));
function fixture() {
  return createLiveSession({ teamA: ["p1", "p2"], teamB: ["p3", "p4"], servingTeam: "A", nearTeam: "A" }, "owner", players, randomUUID(), "secret", start);
}
function send(s, type, extra = {}) {
  const command = { operationId: randomUUID(), expectedRevision: s.revision, capturedAt: start + 1000 + s.revision, type, ...extra };
  applyLiveCommand(s, command, start + 100000);
  return command;
}
function begin(s) { send(s, "start", { capturedAt: start }); }

test("delayed start and point delivery keep tap timestamps through retries and restore", () => {
  let s = fixture();
  const command = send(s, "start", { capturedAt: start + 2000 });
  assert.equal(s.startedAt, start + 2000);
  assert.equal(s.startReceivedAt, start + 100000);
  assert.equal(applyLiveCommand(s, command, start + 200000), false);
  send(s, "point", { team: "A", capturedAt: start + 22000 });
  const point = liveSnapshot(s).points[0];
  assert.equal(point.elapsedMs, 20000);
  assert.equal(point.capturedAt, start + 22000);
  assert.equal(point.receivedAt, start + 100000);
  s = JSON.parse(JSON.stringify(s));
  send(s, "video", { youtubeUrl: "https://youtu.be/nf_W8XZa_mg", videoOffsetSeconds: 1800 });
  send(s, "finish", { matchEndedConfirmed: true });
  assert.deepEqual(publicLiveSession(s).points, [point]);
});

test("start validates tap times without breaking legacy commands", () => {
  for (const capturedAt of [null, "", "1700000000000", NaN, Infinity, start - 6000, start + 200000]) {
    const s = fixture();
    assert.throws(() => send(s, "start", { capturedAt }), /시간/);
    assert.equal(s.status, "ready");
  }
  const s = fixture();
  send(s, "start", { capturedAt: undefined });
  assert.equal(s.startedAt, start + 100000);
});

test("doubles service follows parity, only serving winners swap positions", () => {
  const s = fixture(); begin(s);
  assert.equal(liveSnapshot(s).serverId, "p2");
  send(s, "point", { team: "A" });
  assert.equal(liveSnapshot(s).serverId, "p2");
  assert.equal(liveSnapshot(s).serviceSide, "left");
  assert.equal(liveSnapshot(s).receiverId, "p3");
  send(s, "point", { team: "B" });
  assert.equal(liveSnapshot(s).serverId, "p3");
  assert.deepEqual(liveSnapshot(s).positions.B, ["p3", "p4"]);
  send(s, "point", { team: "A" });
  assert.equal(liveSnapshot(s).serverId, "p1");
  send(s, "point", { team: "B" });
  assert.equal(liveSnapshot(s).serverId, "p4");
});
test("undo restores score, server, receiver and court; side switch is undoable", () => {
  const s = fixture(); begin(s);
  const before = liveSnapshot(s);
  send(s, "point", { team: "A" }); send(s, "undo");
  assert.deepEqual(liveSnapshot(s), before);
  send(s, "switchEnds"); assert.equal(liveSnapshot(s).nearTeam, "B");
  send(s, "undo"); assert.deepEqual(liveSnapshot(s), before);
});
test("no automatic stop at 21 or 30, explicit confirmed finish only", () => {
  const s = fixture(); begin(s);
  for (let i = 0; i < 35; i++) send(s, "point", { team: "A" });
  assert.equal(s.status, "live");
  assert.throws(() => send(s, "finish"), /최종 점수/);
  send(s, "finish", { streamEndedConfirmed: true });
  assert.equal(s.status, "finished"); assert.equal(liveSnapshot(s).scoreA, 35);
  assert.throws(() => send(s, "point", { team: "A" }), /진행 중/);
});

test("a game can finish while broadcasting continues, with legacy retry compatibility", () => {
  const s = fixture(); begin(s);
  send(s, "point", { team: "A" });
  const command = send(s, "finish", { matchEndedConfirmed: true });
  assert.equal(s.status, "finished");
  assert.equal(s.streamEndMode, "match-only");
  assert.equal(applyLiveCommand(s, command), false);
  const old = fixture(); begin(old);
  send(old, "point", { team: "B" });
  const legacy = send(old, "finish", { streamEndedConfirmed: true });
  assert.equal(old.streamEndMode, "user-confirmed");
  assert.equal(applyLiveCommand(old, legacy), false);
});
test("retries are idempotent and stale/different commands are rejected", () => {
  const s = fixture(); begin(s);
  const cmd = send(s, "point", { team: "A" });
  assert.equal(applyLiveCommand(s, cmd), false);
  assert.equal(liveSnapshot(s).scoreA, 1);
  assert.throws(() => applyLiveCommand(s, { ...cmd, team: "B" }), /중복/);
  assert.throws(() => applyLiveCommand(s, { ...cmd, operationId: randomUUID() }), /다른 화면/);
});
test("invalid players, timestamps, ties and arbitrary video URLs are refused", () => {
  assert.throws(() => createLiveSession({ teamA: ["p1", "p1"], teamB: ["p3", "p4"] }, "owner", players, randomUUID(), "secret"));
  const s = fixture(); begin(s);
  assert.throws(() => send(s, "point", { team: "A", capturedAt: start - 100000 }), /시간/);
  for (const capturedAt of [null, "", String(start), NaN, Infinity]) {
    assert.throws(() => send(s, "point", { team: "A", capturedAt }), /시간/);
  }
  assert.throws(() => send(s, "finish", { streamEndedConfirmed: true }), /동점/);
  assert.equal(youtubeId("https://evil.test/watch?v=nf_W8XZa_mg"), "");
  assert.equal(youtubeId("https://www.youtube.com/live/nf_W8XZa_mg"), "nf_W8XZa_mg");
});
test("public overlay contains no owner, token or command receipts", () => {
  const s = fixture(); begin(s);
  send(s, "point", { team: "A" });
  const publicView = publicLiveSession(s, false, true);
  assert.equal(publicView.ownerId, undefined); assert.equal(publicView.overlayToken, undefined);
  assert.equal(publicView.receipts, undefined); assert.equal(publicView.points, undefined);
  assert.equal(publicLiveSession(s, true).overlayToken, "secret");
});
