import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const serverUrl = new URL("../server.js", import.meta.url);
const source = await readFile(serverUrl, "utf8");
async function isolated(mode) {
  const env = mode === "postgres" ? { DATABASE_URL: "postgres://isolated-test" } : { DATABASE_PATH: ":memory:" };
  const code = `const process = { env: ${JSON.stringify(env)} };\n` + source.slice(0, source.lastIndexOf("\nstart().catch"))
    .replace("const __filename = fileURLToPath(import.meta.url);", `const __filename = ${JSON.stringify(fileURLToPath(serverUrl))};`)
    .replace(/from "(\.\/[^\"]+)"/g, (_, name) => `from ${JSON.stringify(new URL(name, serverUrl).href)}`)
    + `\nexport { initDb, initLiveApi, db, sendError, normalizePostgresState, createDefaultPostgresState };
       export function setPool(pool) { pgPool = pool; }
       export function invoke(req,res,url) { return liveApi(req,res,url); }`;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
async function request(api, path, { user = "owner", method = "GET", body, headers = {} } = {}) {
  const req = { method, headers: { host: "localhost", cookie: `sid=${user}-session`, "content-type": "application/json", ...headers },
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
  const res = { status: 0, headers: {}, data: null, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(text) { this.data = text ? JSON.parse(text) : null; } };
  try { await api.invoke(req, res, new URL(path, "http://localhost")); }
  catch (error) { api.sendError(req, res, error); }
  return res;
}
for (const mode of ["sqlite", "postgres"]) {
  test(`${mode}: live API ownership, idempotency, atomic finish, compact overlay and replay`, async () => {
    const api = await isolated(mode);
    let database;
    if (mode === "postgres") {
      const { PGlite } = await import(process.env.PGLITE_TEST_MODULE || "@electric-sql/pglite");
      database = new PGlite();
      await database.exec("CREATE TABLE app_state(key TEXT PRIMARY KEY,value JSONB,updated_at TIMESTAMPTZ DEFAULT NOW())");
      let lock = Promise.resolve();
      const pool = {
        async connect() {
          const before = lock; let release; lock = new Promise((r) => { release = r; }); await before;
          return { query: (sql, params) => database.query(sql, params), release };
        },
        async query(sql, params) {
          if (sql.includes("CREATE TABLE")) { await database.exec(sql); return { rows: [] }; }
          const client = await this.connect(); try { return await client.query(sql, params); } finally { client.release(); }
        },
      };
      api.setPool(pool);
      const fixture = api.normalizePostgresState({ ...api.createDefaultPostgresState(),
        users: ["owner", "other"].map((id) => ({ id, username: id, displayName: id, passwordHash: "unused", role: "member", createdAt: new Date().toISOString() })),
        sessions: ["owner", "other"].map((id) => ({ id: `${id}-session`, userId: id, expiresAt: Date.now() + 600000 })),
        players: [1, 2, 3, 4].map((id) => ({ id: `p${id}`, name: `Player ${id}`, seedRating: 1500 })),
      });
      await database.query("INSERT INTO app_state(key,value) VALUES ('state',$1::jsonb)", [JSON.stringify(fixture)]);
    } else {
      api.initDb();
      for (const id of ["owner", "other"]) {
        api.db.prepare("INSERT INTO users(id,username,display_name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)").run(id, id, id, "unused", "member", new Date().toISOString());
        api.db.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES (?,?,?,?)").run(`${id}-session`, id, Date.now() + 600000, new Date().toISOString());
      }
      for (let id = 1; id <= 4; id++) api.db.prepare("INSERT INTO players(id,name,normalized_name,seed_rating,created_at) VALUES (?,?,?,?,?)").run(`p${id}`, `Player ${id}`, `player ${id}`, 1500, new Date().toISOString());
    }
    try {
      await api.initLiveApi();
      assert.equal((await request(api, "/api/live/bootstrap", { user: "nobody" })).status, 401);
      const boot = await request(api, "/api/live/bootstrap");
      assert.equal(boot.status, 200); assert.equal(boot.data.players.length, 4);
      const id = randomUUID();
      const create = () => request(api, "/api/live/sessions", { method: "POST", body: { id, teamA: ["p1", "p2"], teamB: ["p3", "p4"], nearTeam: "A", servingTeam: "A" } });
      let result = await create(); assert.equal(result.status, 200);
      let s = result.data;
      assert.equal((await create()).data.id, id);
      assert.equal((await request(api, `/api/live/sessions/${id}`, { user: "other" })).status, 403);
      const send = async (type, extra = {}) => {
        const body = { type, expectedRevision: s.revision, operationId: randomUUID(), capturedAt: Date.now(), ...extra };
        const res = await request(api, `/api/live/sessions/${id}/commands`, { method: "POST", body });
        if (res.status === 200) s = res.data;
        return { res, body };
      };
      assert.equal((await send("start")).res.status, 200);
      const point = await send("point", { team: "A" }); assert.equal(point.res.status, 200);
      const repeat = await request(api, `/api/live/sessions/${id}/commands`, { method: "POST", body: point.body });
      assert.equal(repeat.data.scoreA, 1);
      const conflict = await request(api, `/api/live/sessions/${id}/commands`, { method: "POST", body: { ...point.body, operationId: randomUUID() } });
      assert.equal(conflict.status, 409);
      const csrf = await request(api, `/api/live/sessions/${id}/commands`, { method: "POST", body: point.body, headers: { origin: "https://evil.test" } });
      assert.equal(csrf.status, 403);
      assert.equal((await send("video", { youtubeUrl: "https://youtu.be/nf_W8XZa_mg", videoOffsetSeconds: 12.5 })).res.status, 200);
      const overlay = await request(api, `/api/live/overlay/${s.overlayToken}`, { user: "nobody" });
      assert.equal(overlay.status, 200); assert.equal(overlay.data.scoreA, 1);
      assert.equal(overlay.data.points, undefined); assert.equal(overlay.data.overlayToken, undefined);
      const unchanged = await request(api, `/api/live/overlay/${s.overlayToken}`, { headers: { "if-none-match": overlay.headers.ETag } });
      assert.equal(unchanged.status, 304);
      assert.equal((await send("finish")).res.status, 400);
      const finished = await send("finish", { streamEndedConfirmed: true });
      assert.equal(finished.res.status, 200); assert.equal(s.status, "finished"); assert.ok(s.matchId);
      const duplicatedEnd = await request(api, `/api/live/sessions/${id}/commands`, { method: "POST", body: finished.body });
      assert.equal(duplicatedEnd.data.matchId, s.matchId);
      const replay = await request(api, `/api/live/replay/${s.matchId}`, { user: "nobody" });
      assert.equal(replay.data.points.length, 1); assert.equal(replay.data.videoOffsetSeconds, 12.5);
      if (mode === "postgres") {
        const state = (await database.query("SELECT value FROM app_state WHERE key='state'")).rows[0].value;
        assert.equal(state.matches.length, 1); assert.equal(state.matches[0].liveSessionId, id);
        assert.equal(state.matches[0].changes.length, 4);
      } else {
        assert.equal(api.db.prepare("SELECT COUNT(*) AS n FROM matches").get().n, 1);
        assert.equal(api.db.prepare("SELECT live_session_id FROM matches").get().live_session_id, id);
      }
      // A failed final insert must roll back the session too, not leave it 'finished'.
      const secondId = randomUUID();
      s = (await request(api, "/api/live/sessions", { method: "POST", body: { id: secondId, teamA: ["p1", "p2"], teamB: ["p3", "p4"], nearTeam: "A", servingTeam: "A" } })).data;
      const cmd = (type, extra = {}) => ({ type, operationId: randomUUID(), expectedRevision: s.revision, capturedAt: Date.now(), ...extra });
      s = (await request(api, `/api/live/sessions/${secondId}/commands`, { method: "POST", body: cmd("start") })).data;
      s = (await request(api, `/api/live/sessions/${secondId}/commands`, { method: "POST", body: cmd("point", { team: "B" }) })).data;
      if (mode === "postgres") await database.query("UPDATE app_state SET value=jsonb_set(value,'{players,0,seedRating}','null'::jsonb) WHERE key='state'");
      else api.db.prepare("UPDATE players SET seed_rating=NULL WHERE id='p1'").run();
      const failed = await request(api, `/api/live/sessions/${secondId}/commands`, { method: "POST", body: cmd("finish", { streamEndedConfirmed: true }) });
      assert.equal(failed.status, 400);
      assert.equal((await request(api, `/api/live/sessions/${secondId}`)).data.status, "live");
    } finally {
      if (database) await database.close(); else api.db.close();
    }
  });
}
