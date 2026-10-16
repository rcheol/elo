import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";

const code = await readFile(new URL("../surge-deploy/live/overlay.js", import.meta.url), "utf8");
const token = "a".repeat(48);
function snapshot(status, scoreA = 0, id = "game-1") {
  return { id, status, scoreA, scoreB: 0, players: [1, 2, 3, 4].map((n) => ({ id: `p${n}`, name: `Player ${n}` })),
    teamA: ["p1", "p2"], teamB: ["p3", "p4"], servingTeam: "A", serverId: "p2", serviceSide: "right" };
}
function response(data, etag = '"test"', status = 200) {
  return { ok: status === 200, status, json: async () => data, headers: { get: () => etag } };
}
async function widget(responses, continuous = true) {
  const elements = Object.fromEntries(["namesA", "namesB", "scoreA", "scoreB", "serveA", "serveB", "status"].map((id) =>
    [id, { textContent: "", classList: { add() {}, remove() {} } }]));
  const timers = [];
  const calls = [];
  const context = vm.createContext({
    location: { hash: continuous ? `#channel/${token}` : `#${token}` },
    document: { getElementById: (id) => elements[id] },
    AbortSignal: { timeout: () => null },
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
    fetch: async (url, options) => {
      calls.push({ url, options });
      assert.ok(responses.length, "unexpected extra request");
      const value = responses.shift();
      if (value instanceof Error) throw value;
      return value;
    },
  });
  await vm.runInContext(code, context);
  return { elements, calls, timers, next: async () => {
    assert.equal(timers.length, 1, "exactly one polling loop must remain active");
    await timers.shift().callback();
  } };
}

test("fixed widget follows waiting, live, finished and next game without reload", async () => {
  const page = await widget([
    response({ session: null }, '"waiting"'),
    response({ session: snapshot("ready") }, '"game-1-0"'),
    response({ session: snapshot("live", 3) }, '"game-1-4"'),
    response({ session: snapshot("finished", 3) }, '"game-1-5"'),
    response(null, '"game-1-5"', 304),
    response({ session: snapshot("ready", 0, "game-2") }, '"game-2-0"'),
    response({ session: snapshot("live", 1, "game-2") }, '"game-2-2"'),
  ]);
  assert.match(page.elements.status.textContent, /다음 경기 대기/);
  assert.equal(page.timers[0].delay, 5000);
  await page.next(); assert.equal(page.timers[0].delay, 2000);
  await page.next(); assert.equal(page.elements.scoreA.textContent, 3);
  await page.next(); assert.match(page.elements.status.textContent, /경기 종료.*다음 경기 대기/);
  assert.equal(page.timers[0].delay, 5000);
  await page.next(); assert.equal(page.elements.scoreA.textContent, 3);
  await page.next(); assert.equal(page.elements.scoreA.textContent, 0);
  assert.equal(page.elements.status.textContent, "경기 준비");
  await page.next(); assert.equal(page.elements.scoreA.textContent, 1);
  assert.ok(page.calls.every((call) => call.url === `/api/live/channel-overlay/${token}`));
  assert.equal(page.calls[5].options.headers["If-None-Match"], '"game-1-5"');
});

test("cancelled games keep polling for the next game", async () => {
  const page = await widget([
    response({ session: snapshot("cancelled") }), response({ session: snapshot("ready", 0, "next") }),
  ]);
  assert.match(page.elements.status.textContent, /기록 취소.*다음 경기 대기/);
  await page.next(); assert.equal(page.elements.status.textContent, "경기 준비");
});

test("temporary network failure preserves score and resumes the same channel", async () => {
  const page = await widget([
    response({ session: snapshot("live", 2) }, '"game-1-3"'),
    new Error("offline"),
    response({ session: snapshot("live", 3) }, '"game-1-4"'),
  ]);
  await page.next(); assert.equal(page.elements.scoreA.textContent, 2);
  assert.match(page.elements.status.textContent, /연결 지연/);
  assert.equal(page.timers[0].delay, 4000);
  await page.next(); assert.equal(page.elements.scoreA.textContent, 3);
  assert.equal(page.timers[0].delay, 2000);
});

test("legacy per-game widgets still stop after a final score", async () => {
  const page = await widget([response(snapshot("finished", 21))], false);
  assert.equal(page.elements.scoreA.textContent, 21);
  assert.equal(page.elements.status.textContent, "경기 종료");
  assert.equal(page.timers.length, 0);
  assert.equal(page.calls[0].url, `/api/live/overlay/${token}`);
});
