import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import { hasClaimableVideoJob, readVideoJob, updatePostgresState } from "../lib/postgres-state.js";

const { PGlite } = await import(process.env.PGLITE_TEST_MODULE || "@electric-sql/pglite");
const database = new PGlite();
const statements = [];
let lock = Promise.resolve();
const pool = {
  async connect() {
    const previous = lock;
    let release;
    lock = new Promise((resolve) => { release = resolve; });
    await previous;
    return {
      query(sql, values = []) {
        statements.push({ sql, values: structuredClone(values) });
        return database.query(sql, values);
      },
      release,
    };
  },
  async query(sql, values) {
    const client = await this.connect();
    try {
      return await client.query(sql, values);
    } finally {
      client.release();
    }
  },
};

let api;
let fixture;
const serverUrl = new URL("../server.js", import.meta.url);

before(async () => {
  await database.exec("CREATE TABLE app_state (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  const source = await readFile(serverUrl, "utf8");
  // Exercise the real handlers without listening on a port or accessing production credentials.
  const isolatedSource = `
      const process = { env: { DATABASE_URL: "postgres://isolated-test", VIDEO_WORKER_TOKEN: "test-worker" } };
    ` + source.slice(0, source.lastIndexOf("\nstart().catch"))
      .replace("const __filename = fileURLToPath(import.meta.url);", `const __filename = ${JSON.stringify(fileURLToPath(serverUrl))};`)
      .replace('"./lib/postgres-state.js"', JSON.stringify(new URL("../lib/postgres-state.js", import.meta.url).href)) + `
      export { handleApiPostgres, normalizePostgresState, createDefaultPostgresState };
      export function setPool(pool) { pgPool = pool; }
    `;
  api = await import(`data:text/javascript;base64,${Buffer.from(isolatedSource).toString("base64")}`);
  api.setPool(pool);
  const now = new Date().toISOString();
  fixture = api.normalizePostgresState({
    ...api.createDefaultPostgresState(),
    users: [
      { id: "owner", username: "owner", displayName: "Owner", role: "member", passwordHash: "private-hash", createdAt: now },
      { id: "admin", username: "admin", displayName: "Admin", role: "admin", passwordHash: "private-hash", createdAt: now },
      { id: "other", username: "other", displayName: "Other", role: "member", passwordHash: "private-hash", createdAt: now },
    ],
    sessions: ["owner", "admin", "other"].map((id) => ({
      id: `${id}-session`, userId: id, expiresAt: Date.now() + 600000, createdAt: now,
    })),
    players: [1, 2, 3, 4].map((id) => ({ id: `p${id}`, name: `Player ${id}`, seedRating: 1500, createdAt: now })),
    videoAnalysisJobs: [{
      id: "job-1", status: "waiting_player_mapping", youtubeUrl: "https://www.youtube.com/watch?v=nf_W8XZa_mg",
      videoId: "nf_W8XZa_mg", createdBy: "owner", createdAt: now, updatedAt: now,
      playerSlots: [],
      referenceFrames: [{ timestamp: "00:39", imageDataUrl: `data:image/jpeg;base64,${"A".repeat(38000)}` }],
    }],
  });
});

beforeEach(async () => {
  await database.query("INSERT INTO app_state (key, value) VALUES ('state', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(fixture)]);
  statements.length = 0;
});

after(async () => { await database.close(); });

function writes() {
  return statements.filter(({ sql }) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql));
}

async function storedState() {
  return (await database.query("SELECT value FROM app_state WHERE key = 'state'")).rows[0].value;
}

async function saveFixture(state) {
  await database.query("UPDATE app_state SET value = $1::jsonb WHERE key = 'state'", [JSON.stringify(state)]);
  statements.length = 0;
}

async function request(url, { user = "owner", method = "GET", body, worker = false } = {}) {
  const req = {
    method, headers: { cookie: `sid=${user}-session`, ...(worker ? { authorization: "Bearer test-worker" } : {}) },
    socket: {},
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); },
  };
  let payload;
  const res = {
    writeHead(status) { assert.ok(status < 400); },
    end(value) { payload = JSON.parse(value); },
  };
  await api.handleApiPostgres(req, res, new URL(url, "http://localhost"));
  return payload;
}

test("unchanged normalized state is never written, including reordered JSONB object keys", async () => {
  const original = await storedState();
  await updatePostgresState(pool, "state", api.normalizePostgresState, api.createDefaultPostgresState, () => 42);
  assert.equal(writes().length, 0);
  assert.deepEqual(await storedState(), original);
});

test("only a changed top-level field is uploaded and existing players and jobs survive", async () => {
  const original = await storedState();
  await updatePostgresState(pool, "state", api.normalizePostgresState, api.createDefaultPostgresState, (state) => {
    state.queuePlayerIds = ["p1", "p2"];
  });
  const patch = JSON.parse(writes()[0].values[1]);
  assert.deepEqual(Object.keys(patch), ["queuePlayerIds"]);
  assert.deepEqual(patch, { queuePlayerIds: ["p1", "p2"] });
  assert.ok(Buffer.byteLength(writes()[0].values[1]) < 100);
  assert.deepEqual(await storedState(), { ...original, queuePlayerIds: ["p1", "p2"] });
});

test("failed mutations roll back and release the connection", async () => {
  const original = await storedState();
  await assert.rejects(updatePostgresState(pool, "state", api.normalizePostgresState, api.createDefaultPostgresState, (state) => {
    state.players = [];
    throw new Error("test failure");
  }), /test failure/);
  assert.equal(statements.at(-1).sql, "ROLLBACK");
  assert.deepEqual(await storedState(), original);
  assert.equal(await hasClaimableVideoJob(pool, "state", 3600000), false);
});

test("new state initialization still creates a row", async () => {
  await updatePostgresState(pool, "new-state", api.normalizePostgresState, api.createDefaultPostgresState, () => {});
  assert.equal(writes().length, 1);
  assert.deepEqual((await database.query("SELECT value FROM app_state WHERE key = 'new-state'")).rows[0].value.players, []);
});

test("100 idle worker polls use small existence queries with no writes or full-state downloads", async () => {
  for (let i = 0; i < 100; i++) {
    assert.deepEqual(await request("/api/video-analysis/worker/jobs/next", { worker: true }), { job: null });
  }
  assert.equal(writes().length, 0);
  assert.equal(statements.length, 100);
  assert.ok(statements.every(({ sql }) => sql.includes("SELECT EXISTS")));
});

test("queued jobs are claimed once even if two workers poll together", async () => {
  const state = await storedState();
  state.videoAnalysisJobs[0].status = "queued_player_detection";
  await saveFixture(state);
  const results = await Promise.all([
    request("/api/video-analysis/worker/jobs/next", { worker: true }),
    request("/api/video-analysis/worker/jobs/next", { worker: true }),
  ]);
  assert.equal(results.filter(({ job }) => job).length, 1);
  assert.equal(writes().length, 1);
  const job = (await storedState()).videoAnalysisJobs[0];
  assert.equal(job.status, "running_player_detection");
  assert.equal(job.attempts, 1);
});

test("an expired worker lock can be reclaimed, a recent one cannot", async () => {
  const state = await storedState();
  state.videoAnalysisJobs[0].status = "running_score_analysis";
  state.videoAnalysisJobs[0].lockedAt = new Date(Date.now() - 7200000).toISOString();
  await saveFixture(state);
  const first = await request("/api/video-analysis/worker/jobs/next", { worker: true });
  assert.equal(first.job.stage, "score_analysis");
  assert.deepEqual(await request("/api/video-analysis/worker/jobs/next", { worker: true }), { job: null });
});

test("polling returns a frame once, then a small unchanged response without any writes", async () => {
  const original = await storedState();
  const first = await request("/api/video-analysis/jobs/job-1");
  assert.ok(first.job.referenceFrames[0].imageDataUrl.length > 38000);
  assert.ok(first.version);
  const second = await request(`/api/video-analysis/jobs/job-1?version=${first.version}`);
  assert.deepEqual(second, { unchanged: true, version: first.version });
  assert.ok(Buffer.byteLength(JSON.stringify(second)) < 100);
  const raw = await readVideoJob(pool, "state", "owner-session", "job-1", first.version);
  assert.equal(raw.job, null);
  assert.ok(Buffer.byteLength(JSON.stringify(raw)) < 500);
  assert.ok(!JSON.stringify(raw).includes("private-hash"));
  assert.equal(writes().length, 0);
  assert.deepEqual(await storedState(), original);
});

test("changed status is returned even when timestamps match", async () => {
  const first = await request("/api/video-analysis/jobs/job-1");
  const state = await storedState();
  state.videoAnalysisJobs[0].status = "queued_score_analysis";
  await saveFixture(state);
  const next = await request(`/api/video-analysis/jobs/job-1?version=${first.version}`);
  assert.equal(next.job.status, "queued_score_analysis");
  assert.notEqual(next.version, first.version);
});

test("polling enforces owner/admin access on both full and unchanged responses", async () => {
  const owner = await request("/api/video-analysis/jobs/job-1");
  assert.equal((await request("/api/video-analysis/jobs/job-1", { user: "admin" })).job.id, "job-1");
  await assert.rejects(request(`/api/video-analysis/jobs/job-1?version=${owner.version}`, { user: "other" }), { status: 403 });
  await assert.rejects(request("/api/video-analysis/jobs/job-1", { user: "missing" }), { status: 401 });
  await assert.rejects(request("/api/video-analysis/jobs/missing"), { status: 404 });
  const state = await storedState();
  state.sessions.find((session) => session.userId === "owner").expiresAt = Date.now() - 1000;
  await saveFixture(state);
  await assert.rejects(request(`/api/video-analysis/jobs/job-1?version=${owner.version}`), { status: 401 });
  assert.equal(writes().length, 0);
});

test("worker authentication is required before querying the database", async () => {
  await assert.rejects(request("/api/video-analysis/worker/jobs/next"), { status: 401 });
  assert.equal(statements.length, 0);
});

test("mapping, score completion, confirmation and ELO changes remain persisted", async () => {
  const slots = Object.fromEntries(["A1", "A2", "B1", "B2"].map((slot, i) => [slot, { playerId: `p${i + 1}` }]));
  await request("/api/video-analysis/jobs/job-1/players", { method: "PUT", body: { slots } });
  assert.equal((await request("/api/video-analysis/worker/jobs/next", { worker: true })).job.stage, "score_analysis");
  const result = await request("/api/video-analysis/worker/jobs/job-1/result", {
    worker: true, method: "POST", body: {
      stage: "score_analysis", status: "succeeded", scoreResult: {
        score: { teamA: 21, teamB: 19, winner: "A", confidence: 0.9 },
        matchPayload: { teamA: ["p1", "p2"], teamB: ["p3", "p4"], scoreA: 21, scoreB: 19 },
      },
    },
  });
  assert.equal(result.job.status, "waiting_confirmation");
  const confirmed = await request("/api/video-analysis/jobs/job-1/confirm", { method: "POST", body: { playedAt: new Date().toISOString() } });
  assert.equal(confirmed.videoAnalysisJob.status, "registered");
  const state = await storedState();
  assert.equal(state.matches.length, 1);
  assert.equal(state.matches[0].scoreA, 21);
  assert.ok(state.matches[0].changes.find((change) => change.id === "p1").delta > 0);
  assert.equal(state.videoAnalysisJobs[0].matchId, state.matches[0].id);
  assert.equal(state.users.length, 3);
  assert.equal(state.players.length, 4);
  assert.ok(writes().every(({ values }) => !Object.hasOwn(JSON.parse(values[1]), "users")));
});
