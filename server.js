import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const staticDir = path.join(__dirname, "surge-deploy");
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, "data", "badminton.sqlite");
const sessionMaxAgeMs = 1000 * 60 * 60 * 24 * 30;
const maxBodyBytes = 2 * 1024 * 1024;

const defaultSettings = {
  baseRating: 1500,
  kFactor: 32,
  marginBonus: true,
};

if (dbPath !== ":memory:") {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");
try {
  db.exec("PRAGMA journal_mode = WAL");
} catch {
  // WAL is not available for every SQLite target, such as in-memory databases.
}

class HttpError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      seed_rating REAL NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL UNIQUE,
      team_a TEXT NOT NULL,
      team_b TEXT NOT NULL,
      score_a INTEGER NOT NULL,
      score_b INTEGER NOT NULL,
      winner TEXT NOT NULL,
      expected_a REAL NOT NULL,
      expected_b REAL NOT NULL,
      team_rating_a REAL NOT NULL,
      team_rating_b REAL NOT NULL,
      k_factor REAL NOT NULL,
      margin_bonus INTEGER NOT NULL,
      margin_factor REAL NOT NULL,
      changes TEXT NOT NULL,
      created_by TEXT,
      created_by_name TEXT NOT NULL,
      updated_by TEXT,
      updated_by_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_matches_sequence ON matches(sequence);
  `);

  const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)");
  insertSetting.run("baseRating", String(defaultSettings.baseRating));
  insertSetting.run("kFactor", String(defaultSettings.kFactor));
  insertSetting.run("marginBonus", defaultSettings.marginBonus ? "true" : "false");
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function uid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
}

function normalizeDisplayName(value, fallback) {
  return String(value || fallback || "").trim().replace(/\s+/g, " ").slice(0, 24);
}

function normalizePlayerName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeNameKey(value) {
  return normalizePlayerName(value).toLowerCase();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [method, salt, hash] = String(storedHash || "").split(":");
  if (method !== "scrypt" || !salt || !hash) {
    return false;
  }

  const actual = Buffer.from(hash, "hex");
  const expected = crypto.scryptSync(String(password), salt, actual.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getSettings() {
  const rows = db.prepare("SELECT name, value FROM settings").all();
  const values = Object.fromEntries(rows.map((row) => [row.name, row.value]));
  return {
    baseRating: clampNumber(Number(values.baseRating ?? defaultSettings.baseRating), 800, 2400),
    kFactor: clampNumber(Number(values.kFactor ?? defaultSettings.kFactor), 8, 64),
    marginBonus: values.marginBonus !== "false",
  };
}

function saveSettings(partialSettings = {}) {
  const current = getSettings();
  const next = {
    baseRating: clampNumber(Number(partialSettings.baseRating ?? current.baseRating), 800, 2400),
    kFactor: clampNumber(Number(partialSettings.kFactor ?? current.kFactor), 8, 64),
    marginBonus: partialSettings.marginBonus ?? current.marginBonus,
  };
  next.marginBonus = next.marginBonus !== false;

  const upsert = db.prepare(`
    INSERT INTO settings (name, value)
    VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value
  `);
  upsert.run("baseRating", String(next.baseRating));
  upsert.run("kFactor", String(next.kFactor));
  upsert.run("marginBonus", next.marginBonus ? "true" : "false");
  return next;
}

function userFromRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    createdAt: row.created_at,
  };
}

function getUsersSafe() {
  return db
    .prepare("SELECT id, username, display_name, role, created_at FROM users ORDER BY created_at ASC")
    .all()
    .map(userFromRow);
}

function playerFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    seedRating: Number(row.seed_rating),
    createdAt: row.created_at,
  };
}

function getPlayers() {
  return db
    .prepare("SELECT id, name, seed_rating, created_at FROM players ORDER BY created_at ASC, name ASC")
    .all()
    .map(playerFromRow);
}

function matchFromRow(row) {
  return {
    id: row.id,
    sequence: Number(row.sequence),
    teamA: parseJson(row.team_a, []),
    teamB: parseJson(row.team_b, []),
    scoreA: Number(row.score_a),
    scoreB: Number(row.score_b),
    winner: row.winner === "B" ? "B" : "A",
    expectedA: Number(row.expected_a),
    expectedB: Number(row.expected_b),
    teamRatingA: Number(row.team_rating_a),
    teamRatingB: Number(row.team_rating_b),
    kFactor: Number(row.k_factor),
    marginBonus: Boolean(row.margin_bonus),
    marginFactor: Number(row.margin_factor),
    changes: parseJson(row.changes, []),
    createdBy: row.created_by || null,
    createdByName: row.created_by_name || "Unknown",
    updatedBy: row.updated_by || null,
    updatedByName: row.updated_by_name || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at || null,
  };
}

function getMatches() {
  return db
    .prepare("SELECT * FROM matches ORDER BY sequence ASC")
    .all()
    .map(matchFromRow);
}

function getStatePayload(currentUser) {
  return {
    players: getPlayers(),
    matches: getMatches(),
    settings: getSettings(),
    users: currentUser?.role === "admin" ? getUsersSafe() : [],
    currentUser,
  };
}

function getMarginFactor(scoreA, scoreB) {
  const maxScore = Math.max(scoreA, scoreB, 21);
  const gap = Math.abs(scoreA - scoreB);
  return Math.min(1.35, 1 + gap / (maxScore * 3));
}

function calculateMatchFields(match, ratingById, settings = getSettings()) {
  const teamRatingA = average(match.teamA.map((id) => ratingById.get(id) ?? settings.baseRating));
  const teamRatingB = average(match.teamB.map((id) => ratingById.get(id) ?? settings.baseRating));
  const expectedA = 1 / (1 + 10 ** ((teamRatingB - teamRatingA) / 400));
  const expectedB = 1 - expectedA;
  const resultA = match.scoreA > match.scoreB ? 1 : 0;
  const resultB = 1 - resultA;
  const useMarginBonus = match.marginBonus !== false;
  const marginFactor = useMarginBonus ? getMarginFactor(match.scoreA, match.scoreB) : 1;
  const kFactor = clampNumber(Number(match.kFactor ?? settings.kFactor), 8, 64);
  const deltaA = round1(kFactor * marginFactor * (resultA - expectedA));
  const deltaB = round1(kFactor * marginFactor * (resultB - expectedB));

  return {
    winner: resultA === 1 ? "A" : "B",
    expectedA: round3(expectedA),
    expectedB: round3(expectedB),
    teamRatingA: round1(teamRatingA),
    teamRatingB: round1(teamRatingB),
    kFactor,
    marginFactor: round3(marginFactor),
    changes: [
      ...match.teamA.map((id) => ({ id, delta: deltaA })),
      ...match.teamB.map((id) => ({ id, delta: deltaB })),
    ],
  };
}

function applyRatingChanges(ratings, match) {
  match.changes.forEach((change) => {
    if (ratings.has(change.id)) {
      ratings.set(change.id, round1(ratings.get(change.id) + Number(change.delta || 0)));
    }
  });
}

function getCurrentRatingMap() {
  const ratings = new Map(getPlayers().map((player) => [player.id, player.seedRating]));
  getMatches().forEach((match) => applyRatingChanges(ratings, match));
  return ratings;
}

function writeCalculatedFields(match) {
  db.prepare(`
    UPDATE matches
    SET winner = ?,
        expected_a = ?,
        expected_b = ?,
        team_rating_a = ?,
        team_rating_b = ?,
        k_factor = ?,
        margin_factor = ?,
        changes = ?
    WHERE id = ?
  `).run(
    match.winner,
    match.expectedA,
    match.expectedB,
    match.teamRatingA,
    match.teamRatingB,
    match.kFactor,
    match.marginFactor,
    JSON.stringify(match.changes),
    match.id,
  );
}

function recalculateMatchesFromSequence(startSequence = 1) {
  const settings = getSettings();
  const ratings = new Map(getPlayers().map((player) => [player.id, player.seedRating]));

  getMatches().forEach((match) => {
    if (match.sequence >= startSequence) {
      Object.assign(match, calculateMatchFields(match, ratings, settings));
      writeCalculatedFields(match);
    }
    applyRatingChanges(ratings, match);
  });
}

function validateMatchInput(input) {
  const teamA = Array.isArray(input?.teamA) ? input.teamA.map(String) : [];
  const teamB = Array.isArray(input?.teamB) ? input.teamB.map(String) : [];
  const scoreA = Number(input?.scoreA);
  const scoreB = Number(input?.scoreB);
  const ids = [...teamA, ...teamB];
  const playerIds = new Set(getPlayers().map((player) => player.id));

  if (ids.length !== 4 || ids.some((id) => !id)) {
    throw new HttpError(400, "MATCH_NEEDS_PLAYERS");
  }
  if (new Set(ids).size !== 4) {
    throw new HttpError(400, "MATCH_DUPLICATE_PLAYER");
  }
  if (ids.some((id) => !playerIds.has(id))) {
    throw new HttpError(400, "MATCH_UNKNOWN_PLAYER");
  }
  if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0) {
    throw new HttpError(400, "MATCH_INVALID_SCORE");
  }
  if (scoreA === scoreB) {
    throw new HttpError(400, "MATCH_TIE_SCORE");
  }

  return { teamA, teamB, scoreA, scoreB };
}

function insertMatch(input, currentUser) {
  const { teamA, teamB, scoreA, scoreB } = validateMatchInput(input);
  const settings = getSettings();
  const baseMatch = {
    id: uid(),
    sequence: Number(db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM matches").get().next_sequence),
    teamA,
    teamB,
    scoreA,
    scoreB,
    kFactor: settings.kFactor,
    marginBonus: settings.marginBonus,
    createdBy: currentUser.id,
    createdByName: currentUser.displayName,
    updatedBy: null,
    updatedByName: "",
    createdAt: nowIso(),
    updatedAt: null,
  };
  const fullMatch = {
    ...baseMatch,
    ...calculateMatchFields(baseMatch, getCurrentRatingMap(), settings),
  };

  db.prepare(`
    INSERT INTO matches (
      id, sequence, team_a, team_b, score_a, score_b, winner,
      expected_a, expected_b, team_rating_a, team_rating_b, k_factor,
      margin_bonus, margin_factor, changes, created_by, created_by_name,
      updated_by, updated_by_name, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fullMatch.id,
    fullMatch.sequence,
    JSON.stringify(fullMatch.teamA),
    JSON.stringify(fullMatch.teamB),
    fullMatch.scoreA,
    fullMatch.scoreB,
    fullMatch.winner,
    fullMatch.expectedA,
    fullMatch.expectedB,
    fullMatch.teamRatingA,
    fullMatch.teamRatingB,
    fullMatch.kFactor,
    fullMatch.marginBonus ? 1 : 0,
    fullMatch.marginFactor,
    JSON.stringify(fullMatch.changes),
    fullMatch.createdBy,
    fullMatch.createdByName,
    fullMatch.updatedBy,
    fullMatch.updatedByName,
    fullMatch.createdAt,
    fullMatch.updatedAt,
  );
}

function updateMatch(matchId, input, currentUser) {
  const existing = db.prepare("SELECT * FROM matches WHERE id = ?").get(matchId);
  if (!existing) {
    throw new HttpError(404, "MATCH_NOT_FOUND");
  }

  const current = matchFromRow(existing);
  const { teamA, teamB, scoreA, scoreB } = validateMatchInput(input);
  db.prepare(`
    UPDATE matches
    SET team_a = ?,
        team_b = ?,
        score_a = ?,
        score_b = ?,
        updated_by = ?,
        updated_by_name = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    JSON.stringify(teamA),
    JSON.stringify(teamB),
    scoreA,
    scoreB,
    currentUser.id,
    currentUser.displayName,
    nowIso(),
    current.id,
  );

  recalculateMatchesFromSequence(current.sequence);
}

function insertPlayer(input) {
  const name = normalizePlayerName(input?.name);
  if (!name) {
    throw new HttpError(400, "PLAYER_NAME_REQUIRED");
  }

  const seedRating = clampNumber(Number(input?.seedRating ?? input?.rating ?? getSettings().baseRating), 800, 2400);
  try {
    db.prepare(`
      INSERT INTO players (id, name, normalized_name, seed_rating, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(uid(), name, normalizeNameKey(name), seedRating, nowIso());
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      throw new HttpError(409, "PLAYER_NAME_TAKEN");
    }
    throw error;
  }
}

function deletePlayer(playerId) {
  const match = db
    .prepare("SELECT id FROM matches WHERE team_a LIKE ? OR team_b LIKE ? LIMIT 1")
    .get(`%"${playerId}"%`, `%"${playerId}"%`);
  if (match) {
    throw new HttpError(409, "PLAYER_HAS_MATCHES");
  }
  const result = db.prepare("DELETE FROM players WHERE id = ?").run(playerId);
  if (result.changes === 0) {
    throw new HttpError(404, "PLAYER_NOT_FOUND");
  }
}

function runInTransaction(callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function parseCookies(cookieHeader = "") {
  return Object.fromEntries(
    String(cookieHeader)
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index < 0) {
          return [part, ""];
        }
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function getCurrentUser(req) {
  const sid = parseCookies(req.headers.cookie).sid;
  if (!sid) {
    return null;
  }

  const row = db
    .prepare(`
      SELECT users.id, users.username, users.display_name, users.role, users.created_at
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.id = ? AND sessions.expires_at > ?
    `)
    .get(sid, Date.now());

  if (!row) {
    db.prepare("DELETE FROM sessions WHERE id = ? OR expires_at <= ?").run(sid, Date.now());
    return null;
  }

  return userFromRow(row);
}

function requireUser(req) {
  const currentUser = getCurrentUser(req);
  if (!currentUser) {
    throw new HttpError(401, "UNAUTHORIZED");
  }
  return currentUser;
}

function requireAdmin(req) {
  const currentUser = requireUser(req);
  if (currentUser.role !== "admin") {
    throw new HttpError(403, "FORBIDDEN");
  }
  return currentUser;
}

function createSession(userId) {
  const sid = uid();
  db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(
    sid,
    userId,
    Date.now() + sessionMaxAgeMs,
    nowIso(),
  );
  return sid;
}

function sessionCookie(req, sid) {
  const secure = req.headers["x-forwarded-proto"] === "https";
  return [
    `sid=${encodeURIComponent(sid)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.floor(sessionMaxAgeMs / 1000)}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function clearSessionCookie(req) {
  const secure = req.headers["x-forwarded-proto"] === "https";
  return ["sid=", "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0", secure ? "Secure" : ""]
    .filter(Boolean)
    .join("; ");
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw new HttpError(413, "REQUEST_TOO_LARGE");
    }
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON");
  }
}

function sendJson(req, res, status, payload, cookies = []) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (cookies.length) {
    headers["Set-Cookie"] = cookies;
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}

function sendError(req, res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : "SERVER_ERROR";
  if (!(error instanceof HttpError)) {
    console.error(error);
  }
  sendJson(req, res, status, { error: code, code });
}

function createAccount(input) {
  const username = normalizeUsername(input?.username);
  const displayName = normalizeDisplayName(input?.displayName, username);
  const password = String(input?.password || "");

  if (username.length < 3) {
    throw new HttpError(400, "USERNAME_TOO_SHORT");
  }
  if (!displayName) {
    throw new HttpError(400, "DISPLAY_NAME_REQUIRED");
  }
  if (password.length < 4) {
    throw new HttpError(400, "PASSWORD_TOO_SHORT");
  }

  const userCount = Number(db.prepare("SELECT COUNT(*) AS count FROM users").get().count);
  const user = {
    id: uid(),
    username,
    displayName,
    role: userCount === 0 ? "admin" : "member",
    createdAt: nowIso(),
  };

  try {
    db.prepare(`
      INSERT INTO users (id, username, display_name, password_hash, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(user.id, user.username, user.displayName, hashPassword(password), user.role, user.createdAt);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      throw new HttpError(409, "USERNAME_TAKEN");
    }
    throw error;
  }

  return user;
}

function loginAccount(input) {
  const username = normalizeUsername(input?.username);
  const password = String(input?.password || "");
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!row || !verifyPassword(password, row.password_hash)) {
    throw new HttpError(401, "INVALID_CREDENTIALS");
  }
  return userFromRow(row);
}

function toggleUserRole(targetUserId) {
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(targetUserId);
  if (!target) {
    throw new HttpError(404, "USER_NOT_FOUND");
  }

  const adminCount = Number(db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count);
  if (target.role === "admin" && adminCount <= 1) {
    throw new HttpError(409, "LAST_ADMIN");
  }

  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(target.role === "admin" ? "member" : "admin", targetUserId);
}

function deleteUser(targetUserId, currentUser) {
  if (targetUserId === currentUser.id) {
    throw new HttpError(409, "CANNOT_DELETE_SELF");
  }

  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(targetUserId);
  if (!target) {
    throw new HttpError(404, "USER_NOT_FOUND");
  }

  const adminCount = Number(db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count);
  if (target.role === "admin" && adminCount <= 1) {
    throw new HttpError(409, "LAST_ADMIN");
  }

  db.prepare("DELETE FROM users WHERE id = ?").run(targetUserId);
}

function normalizeImportedPlayers(inputPlayers) {
  if (!Array.isArray(inputPlayers)) {
    return [];
  }

  const ids = new Set();
  const names = new Set();
  return inputPlayers.map((player) => {
    const id = player?.id && !ids.has(String(player.id)) ? String(player.id) : uid();
    ids.add(id);

    const name = normalizePlayerName(player?.name);
    if (!name) {
      throw new HttpError(400, "PLAYER_NAME_REQUIRED");
    }

    const key = normalizeNameKey(name);
    if (names.has(key)) {
      throw new HttpError(409, "PLAYER_NAME_TAKEN");
    }
    names.add(key);

    return {
      id,
      name,
      normalizedName: key,
      seedRating: clampNumber(Number(player?.seedRating ?? player?.rating ?? defaultSettings.baseRating), 800, 2400),
      createdAt: player?.createdAt || nowIso(),
    };
  });
}

function normalizeImportedMatches(inputMatches, players, currentUser) {
  if (!Array.isArray(inputMatches)) {
    return [];
  }

  const playerIds = new Set(players.map((player) => player.id));
  const matchIds = new Set();

  return inputMatches.map((match, index) => {
    const id = match?.id && !matchIds.has(String(match.id)) ? String(match.id) : uid();
    matchIds.add(id);

    const teamA = Array.isArray(match?.teamA) ? match.teamA.map(String) : [];
    const teamB = Array.isArray(match?.teamB) ? match.teamB.map(String) : [];
    const scoreA = Number(match?.scoreA);
    const scoreB = Number(match?.scoreB);
    const ids = [...teamA, ...teamB];

    if (
      ids.length !== 4 ||
      ids.some((playerId) => !playerIds.has(playerId)) ||
      new Set(ids).size !== 4 ||
      !Number.isInteger(scoreA) ||
      !Number.isInteger(scoreB) ||
      scoreA < 0 ||
      scoreB < 0 ||
      scoreA === scoreB
    ) {
      throw new HttpError(400, "IMPORT_INVALID_MATCH");
    }

    return {
      id,
      sequence: index + 1,
      teamA,
      teamB,
      scoreA,
      scoreB,
      kFactor: clampNumber(Number(match?.kFactor ?? defaultSettings.kFactor), 8, 64),
      marginBonus: match?.marginBonus !== false,
      createdBy: match?.createdBy ? String(match.createdBy) : currentUser.id,
      createdByName: normalizeDisplayName(match?.createdByName, currentUser.displayName) || currentUser.displayName,
      updatedBy: match?.updatedBy ? String(match.updatedBy) : null,
      updatedByName: match?.updatedByName ? String(match.updatedByName) : "",
      createdAt: match?.createdAt || nowIso(),
      updatedAt: match?.updatedAt || null,
    };
  });
}

function replaceData(input, currentUser) {
  const players = normalizeImportedPlayers(input?.players);
  if (!players.length) {
    throw new HttpError(400, "IMPORT_NEEDS_PLAYERS");
  }
  const matches = normalizeImportedMatches(input?.matches, players, currentUser);
  const settings = {
    baseRating: clampNumber(Number(input?.settings?.baseRating ?? defaultSettings.baseRating), 800, 2400),
    kFactor: clampNumber(Number(input?.settings?.kFactor ?? defaultSettings.kFactor), 8, 64),
    marginBonus: input?.settings?.marginBonus !== false,
  };

  db.prepare("DELETE FROM matches").run();
  db.prepare("DELETE FROM players").run();
  saveSettings(settings);

  const insertPlayerStatement = db.prepare(`
    INSERT INTO players (id, name, normalized_name, seed_rating, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  players.forEach((player) => {
    insertPlayerStatement.run(player.id, player.name, player.normalizedName, player.seedRating, player.createdAt);
  });

  const insertMatchStatement = db.prepare(`
    INSERT INTO matches (
      id, sequence, team_a, team_b, score_a, score_b, winner,
      expected_a, expected_b, team_rating_a, team_rating_b, k_factor,
      margin_bonus, margin_factor, changes, created_by, created_by_name,
      updated_by, updated_by_name, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const ratings = new Map(players.map((player) => [player.id, player.seedRating]));

  matches.forEach((baseMatch) => {
    const fullMatch = {
      ...baseMatch,
      ...calculateMatchFields(baseMatch, ratings, settings),
    };
    insertMatchStatement.run(
      fullMatch.id,
      fullMatch.sequence,
      JSON.stringify(fullMatch.teamA),
      JSON.stringify(fullMatch.teamB),
      fullMatch.scoreA,
      fullMatch.scoreB,
      fullMatch.winner,
      fullMatch.expectedA,
      fullMatch.expectedB,
      fullMatch.teamRatingA,
      fullMatch.teamRatingB,
      fullMatch.kFactor,
      fullMatch.marginBonus ? 1 : 0,
      fullMatch.marginFactor,
      JSON.stringify(fullMatch.changes),
      fullMatch.createdBy,
      fullMatch.createdByName,
      fullMatch.updatedBy,
      fullMatch.updatedByName,
      fullMatch.createdAt,
      fullMatch.updatedAt,
    );
    applyRatingChanges(ratings, fullMatch);
  });
}

function resetData() {
  db.prepare("DELETE FROM matches").run();
  db.prepare("DELETE FROM players").run();
  saveSettings(defaultSettings);
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method || "GET";

  if (method === "GET" && ["/api/health", "/healthz", "/health"].includes(pathname)) {
    return sendJson(req, res, 200, { ok: true });
  }

  if (method === "GET" && pathname === "/api/state") {
    return sendJson(req, res, 200, getStatePayload(getCurrentUser(req)));
  }

  if (method === "POST" && pathname === "/api/signup") {
    const body = await readJsonBody(req);
    const result = runInTransaction(() => {
      const user = createAccount(body);
      const sid = createSession(user.id);
      return { user, sid };
    });
    return sendJson(req, res, 201, getStatePayload(result.user), [sessionCookie(req, result.sid)]);
  }

  if (method === "POST" && pathname === "/api/login") {
    const body = await readJsonBody(req);
    const currentUser = runInTransaction(() => {
      const user = loginAccount(body);
      const sid = createSession(user.id);
      return { user, sid };
    });
    return sendJson(req, res, 200, getStatePayload(currentUser.user), [sessionCookie(req, currentUser.sid)]);
  }

  if (method === "POST" && pathname === "/api/logout") {
    const sid = parseCookies(req.headers.cookie).sid;
    if (sid) {
      db.prepare("DELETE FROM sessions WHERE id = ?").run(sid);
    }
    return sendJson(req, res, 200, getStatePayload(null), [clearSessionCookie(req)]);
  }

  if (method === "POST" && pathname === "/api/players") {
    const currentUser = requireAdmin(req);
    const body = await readJsonBody(req);
    runInTransaction(() => insertPlayer(body));
    return sendJson(req, res, 201, getStatePayload(currentUser));
  }

  const playerMatch = pathname.match(/^\/api\/players\/([^/]+)$/);
  if (method === "DELETE" && playerMatch) {
    const currentUser = requireAdmin(req);
    runInTransaction(() => deletePlayer(decodeURIComponent(playerMatch[1])));
    return sendJson(req, res, 200, getStatePayload(currentUser));
  }

  if (method === "POST" && pathname === "/api/matches") {
    const currentUser = requireUser(req);
    const body = await readJsonBody(req);
    runInTransaction(() => insertMatch(body, currentUser));
    return sendJson(req, res, 201, getStatePayload(currentUser));
  }

  const matchMatch = pathname.match(/^\/api\/matches\/([^/]+)$/);
  if (method === "PUT" && matchMatch) {
    const currentUser = requireAdmin(req);
    const body = await readJsonBody(req);
    runInTransaction(() => updateMatch(decodeURIComponent(matchMatch[1]), body, currentUser));
    return sendJson(req, res, 200, getStatePayload(currentUser));
  }

  if (method === "PATCH" && pathname === "/api/settings") {
    const currentUser = requireAdmin(req);
    const body = await readJsonBody(req);
    runInTransaction(() => saveSettings(body));
    return sendJson(req, res, 200, getStatePayload(currentUser));
  }

  if (method === "POST" && pathname === "/api/import") {
    const currentUser = requireAdmin(req);
    const body = await readJsonBody(req);
    runInTransaction(() => replaceData(body, currentUser));
    return sendJson(req, res, 200, getStatePayload(currentUser));
  }

  if (method === "POST" && pathname === "/api/reset") {
    const currentUser = requireAdmin(req);
    runInTransaction(resetData);
    return sendJson(req, res, 200, getStatePayload(currentUser));
  }

  const toggleAdminMatch = pathname.match(/^\/api\/users\/([^/]+)\/toggle-admin$/);
  if (method === "PATCH" && toggleAdminMatch) {
    const currentUser = requireAdmin(req);
    runInTransaction(() => toggleUserRole(decodeURIComponent(toggleAdminMatch[1])));
    return sendJson(req, res, 200, getStatePayload(getCurrentUser(req) || currentUser));
  }

  const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (method === "DELETE" && userMatch) {
    const currentUser = requireAdmin(req);
    runInTransaction(() => deleteUser(decodeURIComponent(userMatch[1]), currentUser));
    return sendJson(req, res, 200, getStatePayload(currentUser));
  }

  throw new HttpError(404, "NOT_FOUND");
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".webp": "image/webp",
    }[extension] || "application/octet-stream"
  );
}

function serveStatic(req, res, url) {
  let requestedPath = decodeURIComponent(url.pathname);
  if (requestedPath === "/") {
    requestedPath = "/index.html";
  }

  const filePath = path.resolve(staticDir, `.${requestedPath}`);
  const rootPath = path.resolve(staticDir);
  if (filePath !== rootPath && !filePath.startsWith(`${rootPath}${path.sep}`)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Cache-Control": path.basename(filePath) === "index.html" ? "no-store" : "public, max-age=3600",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

initDb();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    sendError(req, res, error);
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`Badminton ELO server listening on port ${port}`);
});
