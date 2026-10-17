import crypto from "node:crypto";
import { LiveError } from "../surge-deploy/live/engine.js";

export class LiveStore {
  constructor({ db, pool }) { this.db = db; this.pool = pool; }

  async init() {
    const sql = `CREATE TABLE IF NOT EXISTS live_sessions (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL, match_id TEXT UNIQUE, value TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS live_one_active_owner ON live_sessions(owner_id)
      WHERE status IN ('ready', 'live');
    CREATE TABLE IF NOT EXISTS live_channels (
      owner_id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, session_id TEXT
    );
    CREATE TABLE IF NOT EXISTS live_match_media (
      match_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL
    );`;
    if (this.pool) await this.pool.query(sql);
    else this.db.exec(sql);
  }

  async find(column, value) {
    if (!["id", "token", "owner_id", "match_id"].includes(column)) throw new Error("Invalid live lookup");
    const active = column === "owner_id" ? " AND status IN ('ready', 'live')" : "";
    const sql = `SELECT value FROM live_sessions WHERE ${column} = ${this.pool ? "$1" : "?"}${active}`;
    const row = this.pool ? (await this.pool.query(sql, [value])).rows[0] : this.db.prepare(sql).get(value);
    return row ? JSON.parse(row.value) : null;
  }

  async ensureChannel(ownerId) {
    const token = crypto.randomBytes(24).toString("hex");
    // Adopt an already-running session when upgrading an existing installation.
    const sql = `INSERT INTO live_channels(owner_id,token,session_id)
      VALUES (${this.pool ? "$1,$2" : "?,?"}, (SELECT id FROM live_sessions
        WHERE owner_id=${this.pool ? "$1" : "?"} AND status IN ('ready','live')))
      ON CONFLICT(owner_id) DO NOTHING`;
    if (this.pool) {
      await this.pool.query(sql, [ownerId, token]);
      return (await this.pool.query("SELECT token FROM live_channels WHERE owner_id=$1", [ownerId])).rows[0].token;
    }
    this.db.prepare(sql).run(ownerId, token, ownerId);
    return this.db.prepare("SELECT token FROM live_channels WHERE owner_id=?").get(ownerId).token;
  }

  async getMedia(id) {
    const sql = `SELECT value FROM live_match_media WHERE match_id=${this.pool ? "$1" : "?"}`;
    const row = this.pool ? (await this.pool.query(sql, [id])).rows[0] : this.db.prepare(sql).get(id);
    return row ? JSON.parse(row.value) : null;
  }

  async saveMedia(id, expectedRevision, value) {
    const params = [id, value.revision, JSON.stringify(value)];
    const sql = expectedRevision === 0
      ? `INSERT INTO live_match_media(match_id,revision,value) VALUES (${this.pool ? "$1,$2,$3" : "?,?,?"}) ON CONFLICT(match_id) DO NOTHING RETURNING value`
      : `UPDATE live_match_media SET revision=${this.pool ? "$1" : "?"},value=${this.pool ? "$2" : "?"}
         WHERE match_id=${this.pool ? "$3" : "?"} AND revision=${this.pool ? "$4" : "?"} RETURNING value`;
    const bindings = expectedRevision === 0 ? params : [value.revision, JSON.stringify(value), id, expectedRevision];
    const row = this.pool ? (await this.pool.query(sql, bindings)).rows[0] : this.db.prepare(sql).get(...bindings);
    if (row) return JSON.parse(row.value);
    const saved = await this.getMedia(id);
    if (saved?.operationId === value.operationId && saved.signature === value.signature) return saved;
    throw new LiveError(409, "LIVE_CONFLICT", "영상 설정이 변경되었습니다. 새로고침 후 확인하세요.");
  }

  async findChannel(token) {
    const sql = `SELECT s.value FROM live_channels c LEFT JOIN live_sessions s
      ON s.id=c.session_id AND s.owner_id=c.owner_id WHERE c.token=${this.pool ? "$1" : "?"}`;
    const row = this.pool ? (await this.pool.query(sql, [token])).rows[0] : this.db.prepare(sql).get(token);
    return row ? { session: row.value ? JSON.parse(row.value) : null } : null;
  }

  async create(session) {
    await this.ensureChannel(session.ownerId);
    const values = [session.id, session.ownerId, session.token, session.status, JSON.stringify(session)];
    try {
      // Switch the fixed scoreboard only when a new session is successfully created.
      if (this.pool) {
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("INSERT INTO live_sessions (id,owner_id,token,status,value) VALUES ($1,$2,$3,$4,$5)", values);
          await client.query("UPDATE live_channels SET session_id=$1 WHERE owner_id=$2", [session.id, session.ownerId]);
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; }
        finally { client.release(); }
      } else {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.prepare("INSERT INTO live_sessions (id,owner_id,token,status,value) VALUES (?,?,?,?,?)").run(...values);
          this.db.prepare("UPDATE live_channels SET session_id=? WHERE owner_id=?").run(session.id, session.ownerId);
          this.db.exec("COMMIT");
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      }
    } catch (error) {
      if (error.code === "23505" || String(error.message).includes("UNIQUE constraint")) {
        const old = await this.find("id", session.id);
        if (old?.ownerId === session.ownerId) return old;
        throw new LiveError(409, "LIVE_ALREADY_ACTIVE", "진행 중인 중계를 먼저 종료하거나 취소하세요.");
      }
      throw error;
    }
    return session;
  }

  async mutate(id, ownerId, callback) {
    if (!this.pool) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const row = this.db.prepare("SELECT value FROM live_sessions WHERE id = ?").get(id);
        const session = row ? JSON.parse(row.value) : null;
        this.checkOwner(session, ownerId);
        // SQLite callbacks must be synchronous: never hold a transaction across an await.
        const result = callback(session, null);
        if (result?.then) throw new Error("Async SQLite live mutation");
        this.db.prepare("UPDATE live_sessions SET status=?,match_id=?,value=? WHERE id=?")
          .run(session.status, session.matchId, JSON.stringify(session), id);
        this.db.exec("COMMIT");
        return session;
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("SELECT value FROM live_sessions WHERE id=$1 FOR UPDATE", [id]);
      const session = result.rows[0] ? JSON.parse(result.rows[0].value) : null;
      this.checkOwner(session, ownerId);
      await callback(session, client);
      await client.query("UPDATE live_sessions SET status=$1,match_id=$2,value=$3 WHERE id=$4",
        [session.status, session.matchId, JSON.stringify(session), id]);
      await client.query("COMMIT");
      return session;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  checkOwner(session, ownerId) {
    if (!session) throw new LiveError(404, "LIVE_NOT_FOUND", "중계를 찾을 수 없습니다.");
    if (session.ownerId !== ownerId) throw new LiveError(403, "LIVE_FORBIDDEN", "이 중계의 조작자만 변경할 수 있습니다.");
  }
}
