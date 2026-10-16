import { LiveError } from "../surge-deploy/live/engine.js";

export class LiveStore {
  constructor({ db, pool }) { this.db = db; this.pool = pool; }

  async init() {
    const sql = `CREATE TABLE IF NOT EXISTS live_sessions (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL, match_id TEXT UNIQUE, value TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS live_one_active_owner ON live_sessions(owner_id)
      WHERE status IN ('ready', 'live');`;
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

  async create(session) {
    const values = [session.id, session.ownerId, session.token, session.status, JSON.stringify(session)];
    try {
      if (this.pool) await this.pool.query("INSERT INTO live_sessions (id,owner_id,token,status,value) VALUES ($1,$2,$3,$4,$5)", values);
      else this.db.prepare("INSERT INTO live_sessions (id,owner_id,token,status,value) VALUES (?,?,?,?,?)").run(...values);
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
