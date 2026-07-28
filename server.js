import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const staticDir = path.join(__dirname, "surge-deploy");
const databaseUrl = process.env.DATABASE_URL || "";
const usePostgres = Boolean(databaseUrl);
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, "data", "badminton.sqlite");
const sessionMaxAgeMs = 1000 * 60 * 60 * 24 * 30;
const maxBodyBytes = 2 * 1024 * 1024;
const healthPaths = new Set(["/api/health", "/healthz", "/health"]);

const defaultSettings = {
  baseRating: 1500,
  kFactor: 32,
  marginBonus: true,
};

let db = null;
let pgPool = null;

if (!usePostgres && dbPath !== ":memory:") {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
}

if (!usePostgres) {
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {
    // WAL is not available for every SQLite target, such as in-memory databases.
  }
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
      user_id TEXT,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      seed_rating REAL,
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
      played_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_matches_sequence ON matches(sequence);
  `);

  migratePlayersTable();
  migrateMatchesTable();
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_players_user_id_unique ON players(user_id) WHERE user_id IS NOT NULL");

  const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)");
  insertSetting.run("baseRating", String(defaultSettings.baseRating));
  insertSetting.run("kFactor", String(defaultSettings.kFactor));
  insertSetting.run("marginBonus", defaultSettings.marginBonus ? "true" : "false");
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  ensurePendingPlayersForUsers();
}

function migratePlayersTable() {
  const columns = db.prepare("PRAGMA table_info(players)").all();
  const hasUserId = columns.some((column) => column.name === "user_id");
  const seedRatingColumn = columns.find((column) => column.name === "seed_rating");
  const seedRatingIsNotNull = Number(seedRatingColumn?.notnull || 0) === 1;

  if (hasUserId && !seedRatingIsNotNull) {
    return;
  }

  db.exec("ALTER TABLE players RENAME TO players_legacy");
  db.exec(`
    CREATE TABLE players (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      seed_rating REAL,
      created_at TEXT NOT NULL
    );
  `);

  db.prepare(`
    INSERT INTO players (id, user_id, name, normalized_name, seed_rating, created_at)
    SELECT id, ${hasUserId ? "user_id" : "NULL"}, name, normalized_name, seed_rating, created_at
    FROM players_legacy
  `).run();
  db.exec("DROP TABLE players_legacy");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_players_user_id_unique ON players(user_id) WHERE user_id IS NOT NULL");
}

function migrateMatchesTable() {
  const columns = db.prepare("PRAGMA table_info(matches)").all();
  const hasPlayedAt = columns.some((column) => column.name === "played_at");

  if (!hasPlayedAt) {
    db.exec("ALTER TABLE matches ADD COLUMN played_at TEXT");
  }

  db.prepare("UPDATE matches SET played_at = created_at WHERE played_at IS NULL OR played_at = ''").run();
  db.exec("CREATE INDEX IF NOT EXISTS idx_matches_played_at ON matches(played_at, sequence)");
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

function safeIsoDate(value, fallback = nowIso()) {
  const fallbackDate = new Date(fallback);
  const fallbackIso = Number.isNaN(fallbackDate.getTime()) ? new Date().toISOString() : fallbackDate.toISOString();
  const date = new Date(value || fallbackIso);
  return Number.isNaN(date.getTime()) ? fallbackIso : date.toISOString();
}

function normalizeMatchDate(value, fallback = nowIso()) {
  const date = new Date(value || fallback);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, "MATCH_INVALID_DATE");
  }
  return date.toISOString();
}

function matchOrderTime(match) {
  const date = new Date(match?.playedAt || match?.played_at || match?.createdAt || match?.created_at || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function compareMatchOrder(a, b) {
  const timeDiff = matchOrderTime(a) - matchOrderTime(b);
  if (timeDiff !== 0) {
    return timeDiff;
  }

  const sequenceDiff = Number(a?.sequence || 0) - Number(b?.sequence || 0);
  if (sequenceDiff !== 0) {
    return sequenceDiff;
  }

  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function sortMatchesByPlayOrder(matches) {
  return [...matches].sort(compareMatchOrder);
}

function earliestMatchOrder(...matches) {
  return sortMatchesByPlayOrder(matches.filter(Boolean))[0] || null;
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
  const user = {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    createdAt: row.created_at,
  };

  if (Object.prototype.hasOwnProperty.call(row, "player_id")) {
    user.playerId = row.player_id || null;
    user.playerSeedRating = row.player_seed_rating == null ? null : Number(row.player_seed_rating);
    user.playerStatus = row.player_id ? row.player_seed_rating == null ? "pending" : "active" : "none";
  }

  return user;
}

function getUsersSafe() {
  return db
    .prepare(`
      SELECT users.id,
             users.username,
             users.display_name,
             users.role,
             users.created_at,
             players.id AS player_id,
             players.seed_rating AS player_seed_rating
      FROM users
      LEFT JOIN players ON players.user_id = users.id
      ORDER BY users.created_at ASC
    `)
    .all()
    .map(userFromRow);
}

function playerFromRow(row) {
  return {
    id: row.id,
    userId: row.user_id || null,
    name: row.name,
    seedRating: row.seed_rating == null ? null : Number(row.seed_rating),
    status: row.seed_rating == null ? "pending" : "active",
    createdAt: row.created_at,
  };
}

function getPlayers(options = {}) {
  const includePending = Boolean(options.includePending);
  return db
    .prepare(`
      SELECT id, user_id, name, seed_rating, created_at
      FROM players
      ${includePending ? "" : "WHERE seed_rating IS NOT NULL"}
      ORDER BY created_at ASC, name ASC
    `)
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
    playedAt: row.played_at || row.created_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at || null,
  };
}

function getMatches() {
  return db
    .prepare("SELECT * FROM matches ORDER BY played_at ASC, sequence ASC")
    .all()
    .map(matchFromRow);
}

function getStatePayload(currentUser) {
  const includePendingPlayers = currentUser?.role === "admin";
  return {
    players: getPlayers({ includePending: includePendingPlayers }),
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

function recalculateMatchesFromOrder(startMatch = null) {
  const settings = getSettings();
  const ratings = new Map(getPlayers().map((player) => [player.id, player.seedRating]));

  getMatches().forEach((match) => {
    if (!startMatch || compareMatchOrder(match, startMatch) >= 0) {
      Object.assign(match, calculateMatchFields(match, ratings, settings));
      writeCalculatedFields(match);
    }
    applyRatingChanges(ratings, match);
  });
}

function validateMatchInput(input, options = {}) {
  const teamA = Array.isArray(input?.teamA) ? input.teamA.map(String) : [];
  const teamB = Array.isArray(input?.teamB) ? input.teamB.map(String) : [];
  const scoreA = Number(input?.scoreA);
  const scoreB = Number(input?.scoreB);
  const playedAt = normalizeMatchDate(input?.playedAt ?? input?.played_at ?? input?.matchAt, options.fallbackPlayedAt || nowIso());
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

  return { teamA, teamB, scoreA, scoreB, playedAt };
}

function insertMatch(input, currentUser) {
  const { teamA, teamB, scoreA, scoreB, playedAt } = validateMatchInput(input);
  const settings = getSettings();
  const baseMatch = {
    id: uid(),
    sequence: Number(db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM matches").get().next_sequence),
    teamA,
    teamB,
    scoreA,
    scoreB,
    playedAt,
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
      updated_by, updated_by_name, played_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    fullMatch.playedAt,
    fullMatch.createdAt,
    fullMatch.updatedAt,
  );
  recalculateMatchesFromOrder(fullMatch);
}

function updateMatch(matchId, input, currentUser) {
  const existing = db.prepare("SELECT * FROM matches WHERE id = ?").get(matchId);
  if (!existing) {
    throw new HttpError(404, "MATCH_NOT_FOUND");
  }

  const current = matchFromRow(existing);
  const { teamA, teamB, scoreA, scoreB, playedAt } = validateMatchInput(input, { fallbackPlayedAt: current.playedAt });
  const next = { ...current, teamA, teamB, scoreA, scoreB, playedAt };
  const recalculateFrom = earliestMatchOrder(current, next);
  db.prepare(`
    UPDATE matches
    SET team_a = ?,
        team_b = ?,
        score_a = ?,
        score_b = ?,
        played_at = ?,
        updated_by = ?,
        updated_by_name = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    JSON.stringify(teamA),
    JSON.stringify(teamB),
    scoreA,
    scoreB,
    playedAt,
    currentUser.id,
    currentUser.displayName,
    nowIso(),
    current.id,
  );

  recalculateMatchesFromOrder(recalculateFrom);
}

function insertPlayer(input) {
  const name = normalizePlayerName(input?.name);
  if (!name) {
    throw new HttpError(400, "PLAYER_NAME_REQUIRED");
  }

  const seedRating = clampNumber(Number(input?.seedRating ?? input?.rating ?? getSettings().baseRating), 800, 2400);
  try {
    db.prepare(`
      INSERT INTO players (id, user_id, name, normalized_name, seed_rating, created_at)
      VALUES (?, NULL, ?, ?, ?, ?)
    `).run(uid(), name, normalizeNameKey(name), seedRating, nowIso());
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      throw new HttpError(409, "PLAYER_NAME_TAKEN");
    }
    throw error;
  }
}

function countPlayerGames(playerId) {
  return Number(
    db
      .prepare("SELECT COUNT(*) AS count FROM matches WHERE team_a LIKE ? OR team_b LIKE ?")
      .get(`%"${playerId}"%`, `%"${playerId}"%`).count,
  );
}

function updatePlayerSeedRating(playerId, input) {
  const player = db.prepare("SELECT * FROM players WHERE id = ?").get(playerId);
  if (!player) {
    throw new HttpError(404, "PLAYER_NOT_FOUND");
  }

  if (countPlayerGames(playerId) > 0) {
    throw new HttpError(409, "PLAYER_HAS_MATCHES");
  }

  const seedRating = Number(input?.seedRating ?? input?.rating);
  if (!Number.isFinite(seedRating)) {
    throw new HttpError(400, "PLAYER_RATING_REQUIRED");
  }

  db.prepare("UPDATE players SET seed_rating = ? WHERE id = ?").run(clampNumber(seedRating, 800, 2400), playerId);
}

function deletePlayer(playerId) {
  if (countPlayerGames(playerId) > 0) {
    throw new HttpError(409, "PLAYER_HAS_MATCHES");
  }
  const result = db.prepare("DELETE FROM players WHERE id = ?").run(playerId);
  if (result.changes === 0) {
    throw new HttpError(404, "PLAYER_NOT_FOUND");
  }
}

function uniquePlayerNameForAccount(displayName, username) {
  const candidates = [
    normalizePlayerName(displayName),
    normalizePlayerName(`${displayName} (${username})`),
    normalizePlayerName(`${displayName} ${username}`),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const exists = db.prepare("SELECT id FROM players WHERE normalized_name = ?").get(normalizeNameKey(candidate));
    if (!exists) {
      return candidate;
    }
  }

  return normalizePlayerName(`${displayName} ${username} ${uid().slice(0, 8)}`);
}

function createPendingPlayerForUser(user) {
  const existing = db.prepare("SELECT id FROM players WHERE user_id = ?").get(user.id);
  if (existing) {
    return;
  }

  const name = uniquePlayerNameForAccount(user.displayName, user.username);
  db.prepare(`
    INSERT INTO players (id, user_id, name, normalized_name, seed_rating, created_at)
    VALUES (?, ?, ?, ?, NULL, ?)
  `).run(uid(), user.id, name, normalizeNameKey(name), nowIso());
}

function ensurePendingPlayersForUsers() {
  db
    .prepare("SELECT id, username, display_name, role, created_at FROM users ORDER BY created_at ASC")
    .all()
    .map(userFromRow)
    .forEach((user) => createPendingPlayerForUser(user));
}

function deleteMatch(matchId) {
  const existing = db.prepare("SELECT * FROM matches WHERE id = ?").get(matchId);
  if (!existing) {
    throw new HttpError(404, "MATCH_NOT_FOUND");
  }

  const match = matchFromRow(existing);
  db.prepare("DELETE FROM matches WHERE id = ?").run(match.id);
  recalculateMatchesFromOrder(match);
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

  const linkedPlayer = db.prepare("SELECT id, seed_rating FROM players WHERE user_id = ?").get(targetUserId);
  if (linkedPlayer) {
    if (countPlayerGames(linkedPlayer.id) === 0) {
      db.prepare("DELETE FROM players WHERE id = ?").run(linkedPlayer.id);
    } else {
      db.prepare("UPDATE players SET user_id = NULL WHERE id = ?").run(linkedPlayer.id);
    }
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
      userId: player?.userId ? String(player.userId) : null,
      name,
      normalizedName: key,
      seedRating:
        player?.seedRating == null && player?.rating == null
          ? null
          : clampNumber(Number(player?.seedRating ?? player?.rating), 800, 2400),
      createdAt: player?.createdAt || nowIso(),
    };
  });
}

function normalizeImportedMatches(inputMatches, players, currentUser) {
  if (!Array.isArray(inputMatches)) {
    return [];
  }

  const playerIds = new Set(players.map((player) => player.id));
  const activePlayerIds = new Set(players.filter((player) => player.seedRating != null).map((player) => player.id));
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
      ids.some((playerId) => !playerIds.has(playerId) || !activePlayerIds.has(playerId)) ||
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
      playedAt: normalizeMatchDate(match?.playedAt ?? match?.played_at ?? match?.createdAt ?? match?.created_at, nowIso()),
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
    INSERT INTO players (id, user_id, name, normalized_name, seed_rating, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  players.forEach((player) => {
    insertPlayerStatement.run(player.id, player.userId, player.name, player.normalizedName, player.seedRating, player.createdAt);
  });

  const insertMatchStatement = db.prepare(`
    INSERT INTO matches (
      id, sequence, team_a, team_b, score_a, score_b, winner,
      expected_a, expected_b, team_rating_a, team_rating_b, k_factor,
      margin_bonus, margin_factor, changes, created_by, created_by_name,
      updated_by, updated_by_name, played_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const ratings = new Map(players.filter((player) => player.seedRating != null).map((player) => [player.id, player.seedRating]));

  sortMatchesByPlayOrder(matches).forEach((baseMatch) => {
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
      fullMatch.playedAt,
      fullMatch.createdAt,
      fullMatch.updatedAt,
    );
    applyRatingChanges(ratings, fullMatch);
  });

  ensurePendingPlayersForUsers();
}

function resetData() {
  db.prepare("DELETE FROM matches").run();
  db.prepare("DELETE FROM players").run();
  saveSettings(defaultSettings);
  ensurePendingPlayersForUsers();
}

const postgresStateKey = "state";

async function createPostgresPool() {
  const pgModule = await import("pg");
  const { Pool } = pgModule.default || pgModule;
  const sslMode = new URL(databaseUrl).searchParams.get("sslmode") || process.env.PGSSLMODE || "";
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: clampNumber(Number(process.env.DATABASE_POOL_MAX || 5), 1, 20),
    ssl: sslMode === "require" ? { rejectUnauthorized: false } : undefined,
  });

  pool.on("error", (error) => {
    console.error("Unexpected PostgreSQL connection error", error);
  });
  return pool;
}

function cloneSettings(settings = defaultSettings) {
  return {
    baseRating: clampNumber(Number(settings.baseRating ?? defaultSettings.baseRating), 800, 2400),
    kFactor: clampNumber(Number(settings.kFactor ?? defaultSettings.kFactor), 8, 64),
    marginBonus: settings.marginBonus !== false,
  };
}

function createDefaultPostgresState() {
  return {
    schemaVersion: 1,
    users: [],
    sessions: [],
    players: [],
    matches: [],
    settings: cloneSettings(defaultSettings),
  };
}

function normalizeStoredUser(user, seenIds, seenUsernames) {
  const username = normalizeUsername(user?.username);
  const id = String(user?.id || uid());
  if (!username || seenIds.has(id) || seenUsernames.has(username)) {
    return null;
  }

  seenIds.add(id);
  seenUsernames.add(username);
  return {
    id,
    username,
    displayName: normalizeDisplayName(user?.displayName ?? user?.display_name, username),
    passwordHash: String(user?.passwordHash ?? user?.password_hash ?? ""),
    role: user?.role === "admin" ? "admin" : "member",
    createdAt: user?.createdAt ?? user?.created_at ?? nowIso(),
  };
}

function normalizeStoredPlayer(player, seenIds, seenNames) {
  const name = normalizePlayerName(player?.name);
  const id = String(player?.id || uid());
  const normalizedName = normalizeNameKey(player?.normalizedName || player?.normalized_name || name);
  if (!name || !normalizedName || seenIds.has(id) || seenNames.has(normalizedName)) {
    return null;
  }

  seenIds.add(id);
  seenNames.add(normalizedName);
  return {
    id,
    userId: player?.userId ?? player?.user_id ? String(player?.userId ?? player?.user_id) : null,
    name,
    normalizedName,
    seedRating:
      player?.seedRating == null && player?.seed_rating == null
        ? null
        : clampNumber(Number(player?.seedRating ?? player?.seed_rating), 800, 2400),
    createdAt: player?.createdAt ?? player?.created_at ?? nowIso(),
  };
}

function normalizeStoredMatch(match, index, seenIds) {
  const id = String(match?.id || uid());
  if (seenIds.has(id)) {
    return null;
  }

  seenIds.add(id);
  const rawMarginBonus = match?.marginBonus ?? match?.margin_bonus ?? defaultSettings.marginBonus;
  return {
    id,
    sequence: Number.isFinite(Number(match?.sequence)) ? Number(match.sequence) : index + 1,
    teamA: Array.isArray(match?.teamA) ? match.teamA.map(String) : [],
    teamB: Array.isArray(match?.teamB) ? match.teamB.map(String) : [],
    scoreA: Number(match?.scoreA ?? match?.score_a ?? 0),
    scoreB: Number(match?.scoreB ?? match?.score_b ?? 0),
    winner: match?.winner === "B" ? "B" : "A",
    expectedA: Number(match?.expectedA ?? match?.expected_a ?? 0),
    expectedB: Number(match?.expectedB ?? match?.expected_b ?? 0),
    teamRatingA: Number(match?.teamRatingA ?? match?.team_rating_a ?? defaultSettings.baseRating),
    teamRatingB: Number(match?.teamRatingB ?? match?.team_rating_b ?? defaultSettings.baseRating),
    kFactor: clampNumber(Number(match?.kFactor ?? match?.k_factor ?? defaultSettings.kFactor), 8, 64),
    marginBonus: rawMarginBonus !== false && rawMarginBonus !== 0,
    marginFactor: Number(match?.marginFactor ?? match?.margin_factor ?? 1),
    changes: Array.isArray(match?.changes) ? match.changes : [],
    createdBy: match?.createdBy ?? match?.created_by ?? null,
    createdByName: normalizeDisplayName(match?.createdByName ?? match?.created_by_name, "Unknown") || "Unknown",
    updatedBy: match?.updatedBy ?? match?.updated_by ?? null,
    updatedByName: match?.updatedByName ?? match?.updated_by_name ?? "",
    createdAt: safeIsoDate(match?.createdAt ?? match?.created_at, nowIso()),
    playedAt: safeIsoDate(
      match?.playedAt ?? match?.played_at ?? match?.matchAt ?? match?.createdAt ?? match?.created_at,
      match?.createdAt ?? match?.created_at ?? nowIso(),
    ),
    updatedAt: match?.updatedAt ?? match?.updated_at ?? null,
  };
}

function normalizePostgresState(value) {
  const source = value && typeof value === "object" ? value : {};
  const state = {
    schemaVersion: 1,
    users: [],
    sessions: [],
    players: [],
    matches: [],
    settings: cloneSettings(source.settings),
  };

  const userIds = new Set();
  const usernames = new Set();
  state.users = (Array.isArray(source.users) ? source.users : [])
    .map((user) => normalizeStoredUser(user, userIds, usernames))
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  const playerIds = new Set();
  const playerNames = new Set();
  state.players = (Array.isArray(source.players) ? source.players : [])
    .map((player) => normalizeStoredPlayer(player, playerIds, playerNames))
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.name.localeCompare(b.name));

  const activeUserIds = new Set(state.users.map((user) => user.id));
  const now = Date.now();
  state.sessions = (Array.isArray(source.sessions) ? source.sessions : [])
    .map((session) => ({
      id: String(session?.id || ""),
      userId: String(session?.userId ?? session?.user_id ?? ""),
      expiresAt: Number(session?.expiresAt ?? session?.expires_at ?? 0),
      createdAt: session?.createdAt ?? session?.created_at ?? nowIso(),
    }))
    .filter((session) => session.id && activeUserIds.has(session.userId) && session.expiresAt > now);

  const matchIds = new Set();
  state.matches = (Array.isArray(source.matches) ? source.matches : [])
    .map((match, index) => normalizeStoredMatch(match, index, matchIds))
    .filter(Boolean)
    .sort(compareMatchOrder);

  return state;
}

async function initPostgresDb() {
  if (!pgPool) {
    pgPool = await createPostgresPool();
  }

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await withPostgresState((state) => {
    pgEnsurePendingPlayersForUsers(state);
    pgRecalculateMatchesFromOrder(state);
  });
}

async function withPostgresState(callback) {
  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT value FROM app_state WHERE key = $1 FOR UPDATE", [postgresStateKey]);
    const state = normalizePostgresState(result.rows[0]?.value || createDefaultPostgresState());
    const callbackResult = await callback(state);
    const normalizedState = normalizePostgresState(state);

    await client.query(
      `
        INSERT INTO app_state (key, value, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `,
      [postgresStateKey, JSON.stringify(normalizedState)],
    );
    await client.query("COMMIT");
    return callbackResult;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function pgUserFromStored(user) {
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt,
  };
}

function pgPlayerFromStored(player) {
  return {
    id: player.id,
    userId: player.userId || null,
    name: player.name,
    seedRating: player.seedRating == null ? null : Number(player.seedRating),
    status: player.seedRating == null ? "pending" : "active",
    createdAt: player.createdAt,
  };
}

function pgMatchFromStored(match) {
  return {
    id: match.id,
    sequence: Number(match.sequence),
    teamA: [...match.teamA],
    teamB: [...match.teamB],
    scoreA: Number(match.scoreA),
    scoreB: Number(match.scoreB),
    winner: match.winner === "B" ? "B" : "A",
    expectedA: Number(match.expectedA),
    expectedB: Number(match.expectedB),
    teamRatingA: Number(match.teamRatingA),
    teamRatingB: Number(match.teamRatingB),
    kFactor: Number(match.kFactor),
    marginBonus: Boolean(match.marginBonus),
    marginFactor: Number(match.marginFactor),
    changes: Array.isArray(match.changes) ? match.changes.map((change) => ({ ...change })) : [],
    createdBy: match.createdBy || null,
    createdByName: match.createdByName || "Unknown",
    updatedBy: match.updatedBy || null,
    updatedByName: match.updatedByName || "",
    playedAt: match.playedAt || match.createdAt,
    createdAt: match.createdAt,
    updatedAt: match.updatedAt || null,
  };
}

function pgGetUsersSafe(state) {
  return state.users.map((user) => {
    const safeUser = pgUserFromStored(user);
    const player = state.players.find((candidate) => candidate.userId === user.id);
    safeUser.playerId = player?.id || null;
    safeUser.playerSeedRating = player?.seedRating == null ? null : Number(player.seedRating);
    safeUser.playerStatus = player ? player.seedRating == null ? "pending" : "active" : "none";
    return safeUser;
  });
}

function pgGetPlayers(state, options = {}) {
  const includePending = Boolean(options.includePending);
  return state.players
    .filter((player) => includePending || player.seedRating != null)
    .map(pgPlayerFromStored);
}

function pgGetMatches(state) {
  return sortMatchesByPlayOrder(state.matches).map(pgMatchFromStored);
}

function pgGetStatePayload(state, currentUser) {
  const includePendingPlayers = currentUser?.role === "admin";
  return {
    players: pgGetPlayers(state, { includePending: includePendingPlayers }),
    matches: pgGetMatches(state),
    settings: cloneSettings(state.settings),
    users: currentUser?.role === "admin" ? pgGetUsersSafe(state) : [],
    currentUser,
  };
}

function pgGetCurrentUser(req, state) {
  const sid = parseCookies(req.headers.cookie).sid;
  if (!sid) {
    return null;
  }

  const now = Date.now();
  state.sessions = state.sessions.filter((session) => Number(session.expiresAt) > now);
  const session = state.sessions.find((candidate) => candidate.id === sid);
  const user = session ? state.users.find((candidate) => candidate.id === session.userId) : null;
  if (!user) {
    state.sessions = state.sessions.filter((candidate) => candidate.id !== sid);
    return null;
  }

  return pgUserFromStored(user);
}

function pgRequireUser(req, state) {
  const currentUser = pgGetCurrentUser(req, state);
  if (!currentUser) {
    throw new HttpError(401, "UNAUTHORIZED");
  }
  return currentUser;
}

function pgRequireAdmin(req, state) {
  const currentUser = pgRequireUser(req, state);
  if (currentUser.role !== "admin") {
    throw new HttpError(403, "FORBIDDEN");
  }
  return currentUser;
}

function pgCreateSession(state, userId) {
  const sid = uid();
  state.sessions.push({
    id: sid,
    userId,
    expiresAt: Date.now() + sessionMaxAgeMs,
    createdAt: nowIso(),
  });
  return sid;
}

function pgGetCurrentRatingMap(state) {
  const ratings = new Map(
    state.players.filter((player) => player.seedRating != null).map((player) => [player.id, Number(player.seedRating)]),
  );
  sortMatchesByPlayOrder(state.matches).forEach((match) => applyRatingChanges(ratings, match));
  return ratings;
}

function pgRecalculateMatchesFromOrder(state, startMatch = null) {
  const settings = cloneSettings(state.settings);
  const ratings = new Map(
    state.players.filter((player) => player.seedRating != null).map((player) => [player.id, Number(player.seedRating)]),
  );

  sortMatchesByPlayOrder(state.matches).forEach((match) => {
    if (!startMatch || compareMatchOrder(match, startMatch) >= 0) {
      Object.assign(match, calculateMatchFields(match, ratings, settings));
    }
    applyRatingChanges(ratings, match);
  });
}

function pgValidateMatchInput(state, input, options = {}) {
  const teamA = Array.isArray(input?.teamA) ? input.teamA.map(String) : [];
  const teamB = Array.isArray(input?.teamB) ? input.teamB.map(String) : [];
  const scoreA = Number(input?.scoreA);
  const scoreB = Number(input?.scoreB);
  const playedAt = normalizeMatchDate(input?.playedAt ?? input?.played_at ?? input?.matchAt, options.fallbackPlayedAt || nowIso());
  const ids = [...teamA, ...teamB];
  const playerIds = new Set(state.players.filter((player) => player.seedRating != null).map((player) => player.id));

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

  return { teamA, teamB, scoreA, scoreB, playedAt };
}

function pgInsertMatch(state, input, currentUser) {
  const { teamA, teamB, scoreA, scoreB, playedAt } = pgValidateMatchInput(state, input);
  const settings = cloneSettings(state.settings);
  const baseMatch = {
    id: uid(),
    sequence: Math.max(0, ...state.matches.map((match) => Number(match.sequence) || 0)) + 1,
    teamA,
    teamB,
    scoreA,
    scoreB,
    playedAt,
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
    ...calculateMatchFields(baseMatch, pgGetCurrentRatingMap(state), settings),
  };
  state.matches.push(fullMatch);
  pgRecalculateMatchesFromOrder(state, fullMatch);
}

function pgUpdateMatch(state, matchId, input, currentUser) {
  const match = state.matches.find((candidate) => candidate.id === matchId);
  if (!match) {
    throw new HttpError(404, "MATCH_NOT_FOUND");
  }

  const current = { ...match };
  const { teamA, teamB, scoreA, scoreB, playedAt } = pgValidateMatchInput(state, input, { fallbackPlayedAt: match.playedAt });
  const next = { ...current, teamA, teamB, scoreA, scoreB, playedAt };
  const recalculateFrom = earliestMatchOrder(current, next);
  Object.assign(match, {
    teamA,
    teamB,
    scoreA,
    scoreB,
    playedAt,
    updatedBy: currentUser.id,
    updatedByName: currentUser.displayName,
    updatedAt: nowIso(),
  });
  pgRecalculateMatchesFromOrder(state, recalculateFrom);
}

function pgCountPlayerGames(state, playerId) {
  return state.matches.filter((match) => [...match.teamA, ...match.teamB].includes(playerId)).length;
}

function pgInsertPlayer(state, input) {
  const name = normalizePlayerName(input?.name);
  if (!name) {
    throw new HttpError(400, "PLAYER_NAME_REQUIRED");
  }

  const normalizedName = normalizeNameKey(name);
  if (state.players.some((player) => player.normalizedName === normalizedName)) {
    throw new HttpError(409, "PLAYER_NAME_TAKEN");
  }

  const seedRating = clampNumber(Number(input?.seedRating ?? input?.rating ?? state.settings.baseRating), 800, 2400);
  state.players.push({
    id: uid(),
    userId: null,
    name,
    normalizedName,
    seedRating,
    createdAt: nowIso(),
  });
}

function pgUpdatePlayerSeedRating(state, playerId, input) {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) {
    throw new HttpError(404, "PLAYER_NOT_FOUND");
  }
  if (pgCountPlayerGames(state, playerId) > 0) {
    throw new HttpError(409, "PLAYER_HAS_MATCHES");
  }

  const seedRating = Number(input?.seedRating ?? input?.rating);
  if (!Number.isFinite(seedRating)) {
    throw new HttpError(400, "PLAYER_RATING_REQUIRED");
  }
  player.seedRating = clampNumber(seedRating, 800, 2400);
}

function pgDeletePlayer(state, playerId) {
  if (pgCountPlayerGames(state, playerId) > 0) {
    throw new HttpError(409, "PLAYER_HAS_MATCHES");
  }

  const originalLength = state.players.length;
  state.players = state.players.filter((player) => player.id !== playerId);
  if (state.players.length === originalLength) {
    throw new HttpError(404, "PLAYER_NOT_FOUND");
  }
}

function pgUniquePlayerNameForAccount(state, displayName, username) {
  const candidates = [
    normalizePlayerName(displayName),
    normalizePlayerName(`${displayName} (${username})`),
    normalizePlayerName(`${displayName} ${username}`),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!state.players.some((player) => player.normalizedName === normalizeNameKey(candidate))) {
      return candidate;
    }
  }

  return normalizePlayerName(`${displayName} ${username} ${uid().slice(0, 8)}`);
}

function pgCreatePendingPlayerForUser(state, user) {
  if (state.players.some((player) => player.userId === user.id)) {
    return;
  }

  const name = pgUniquePlayerNameForAccount(state, user.displayName, user.username);
  state.players.push({
    id: uid(),
    userId: user.id,
    name,
    normalizedName: normalizeNameKey(name),
    seedRating: null,
    createdAt: nowIso(),
  });
}

function pgEnsurePendingPlayersForUsers(state) {
  state.users.forEach((user) => pgCreatePendingPlayerForUser(state, user));
}

function pgDeleteMatch(state, matchId) {
  const match = state.matches.find((candidate) => candidate.id === matchId);
  if (!match) {
    throw new HttpError(404, "MATCH_NOT_FOUND");
  }

  state.matches = state.matches.filter((candidate) => candidate.id !== matchId);
  pgRecalculateMatchesFromOrder(state, match);
}

function pgCreateAccount(state, input) {
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
  if (state.users.some((user) => user.username === username)) {
    throw new HttpError(409, "USERNAME_TAKEN");
  }

  const user = {
    id: uid(),
    username,
    displayName,
    passwordHash: hashPassword(password),
    role: state.users.length === 0 ? "admin" : "member",
    createdAt: nowIso(),
  };
  state.users.push(user);
  return pgUserFromStored(user);
}

function pgLoginAccount(state, input) {
  const username = normalizeUsername(input?.username);
  const password = String(input?.password || "");
  const user = state.users.find((candidate) => candidate.username === username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw new HttpError(401, "INVALID_CREDENTIALS");
  }
  return pgUserFromStored(user);
}

function pgToggleUserRole(state, targetUserId) {
  const target = state.users.find((user) => user.id === targetUserId);
  if (!target) {
    throw new HttpError(404, "USER_NOT_FOUND");
  }

  const adminCount = state.users.filter((user) => user.role === "admin").length;
  if (target.role === "admin" && adminCount <= 1) {
    throw new HttpError(409, "LAST_ADMIN");
  }

  target.role = target.role === "admin" ? "member" : "admin";
}

function pgDeleteUser(state, targetUserId, currentUser) {
  if (targetUserId === currentUser.id) {
    throw new HttpError(409, "CANNOT_DELETE_SELF");
  }

  const target = state.users.find((user) => user.id === targetUserId);
  if (!target) {
    throw new HttpError(404, "USER_NOT_FOUND");
  }

  const adminCount = state.users.filter((user) => user.role === "admin").length;
  if (target.role === "admin" && adminCount <= 1) {
    throw new HttpError(409, "LAST_ADMIN");
  }

  const linkedPlayer = state.players.find((player) => player.userId === targetUserId);
  if (linkedPlayer) {
    if (pgCountPlayerGames(state, linkedPlayer.id) === 0) {
      state.players = state.players.filter((player) => player.id !== linkedPlayer.id);
    } else {
      linkedPlayer.userId = null;
    }
  }

  state.sessions = state.sessions.filter((session) => session.userId !== targetUserId);
  state.users = state.users.filter((user) => user.id !== targetUserId);
}

function pgSaveSettings(state, partialSettings = {}) {
  const current = cloneSettings(state.settings);
  state.settings = {
    baseRating: clampNumber(Number(partialSettings.baseRating ?? current.baseRating), 800, 2400),
    kFactor: clampNumber(Number(partialSettings.kFactor ?? current.kFactor), 8, 64),
    marginBonus: partialSettings.marginBonus ?? current.marginBonus,
  };
  state.settings.marginBonus = state.settings.marginBonus !== false;
  return state.settings;
}

function pgReplaceData(state, input, currentUser) {
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

  state.players = players.map((player) => ({
    id: player.id,
    userId: player.userId,
    name: player.name,
    normalizedName: player.normalizedName,
    seedRating: player.seedRating,
    createdAt: player.createdAt,
  }));
  state.matches = [];
  state.settings = cloneSettings(settings);

  const ratings = new Map(players.filter((player) => player.seedRating != null).map((player) => [player.id, player.seedRating]));
  sortMatchesByPlayOrder(matches).forEach((baseMatch) => {
    const fullMatch = {
      ...baseMatch,
      ...calculateMatchFields(baseMatch, ratings, state.settings),
    };
    state.matches.push(fullMatch);
    applyRatingChanges(ratings, fullMatch);
  });
  pgEnsurePendingPlayersForUsers(state);
}

function pgResetData(state) {
  state.players = [];
  state.matches = [];
  state.settings = cloneSettings(defaultSettings);
  pgEnsurePendingPlayersForUsers(state);
}

async function handleApiPostgres(req, res, url) {
  const { pathname } = url;
  const method = req.method || "GET";

  if (method === "GET" && healthPaths.has(pathname)) {
    return sendJson(req, res, 200, { ok: true, storage: "postgres" });
  }

  if (method === "GET" && pathname === "/api/state") {
    const payload = await withPostgresState((state) => pgGetStatePayload(state, pgGetCurrentUser(req, state)));
    return sendJson(req, res, 200, payload);
  }

  if (method === "POST" && pathname === "/api/signup") {
    const body = await readJsonBody(req);
    const result = await withPostgresState((state) => {
      const user = pgCreateAccount(state, body);
      pgCreatePendingPlayerForUser(state, user);
      const sid = pgCreateSession(state, user.id);
      return { payload: pgGetStatePayload(state, user), sid };
    });
    return sendJson(req, res, 201, result.payload, [sessionCookie(req, result.sid)]);
  }

  if (method === "POST" && pathname === "/api/login") {
    const body = await readJsonBody(req);
    const result = await withPostgresState((state) => {
      const user = pgLoginAccount(state, body);
      const sid = pgCreateSession(state, user.id);
      return { payload: pgGetStatePayload(state, user), sid };
    });
    return sendJson(req, res, 200, result.payload, [sessionCookie(req, result.sid)]);
  }

  if (method === "POST" && pathname === "/api/logout") {
    const sid = parseCookies(req.headers.cookie).sid;
    const payload = await withPostgresState((state) => {
      if (sid) {
        state.sessions = state.sessions.filter((session) => session.id !== sid);
      }
      return pgGetStatePayload(state, null);
    });
    return sendJson(req, res, 200, payload, [clearSessionCookie(req)]);
  }

  if (method === "POST" && pathname === "/api/players") {
    const body = await readJsonBody(req);
    const payload = await withPostgresState((state) => {
      const currentUser = pgRequireAdmin(req, state);
      pgInsertPlayer(state, body);
      return pgGetStatePayload(state, currentUser);
    });
    return sendJson(req, res, 201, payload);
  }

  const playerMatch = pathname.match(/^\/api\/players\/([^/]+)$/);
  if (method === "PATCH" && playerMatch) {
    const body = await readJsonBody(req);
    const payload = await withPostgresState((state) => {
      const currentUser = pgRequireAdmin(req, state);
      pgUpdatePlayerSeedRating(state, decodeURIComponent(playerMatch[1]), body);
      return pgGetStatePayload(state, currentUser);
    });
    return sendJson(req, res, 200, payload);
  }

  if (method === "DELETE" && playerMatch) {
    const payload = await withPostgresState((state) => {
      const currentUser = pgRequireAdmin(req, state);
      pgDeletePlayer(state, decodeURIComponent(playerMatch[1]));
      return pgGetStatePayload(state, currentUser);
    });
    return sendJson(req, res, 200, payload);
  }

  if (method === "POST" && pathname === "/api/matches") {
    const body = await readJsonBody(req);
    const payload = await withPostgresState((state) => {
      const currentUser = pgRequireUser(req, state);
      pgInsertMatch(state, body, currentUser);
      return pgGetStatePayload(state, currentUser);
    });
    return sendJson(req, res, 201, payload);
  }

  const matchMatch = pathname.match(/^\/api\/matches\/([^/]+)$/);
  if (method === "PUT" && matchMatch) {
    const body = await readJsonBody(req);
    const payload = await withPostgresState((state) => {
      const currentUser = pgRequireAdmin(req, state);
      pgUpdateMatch(state, decodeURIComponent(matchMatch[1]), body, currentUser);
      return pgGetStatePayload(state, currentUser);
    });
    return sendJson(req, res, 200, payload);
  }

  if (method === "DELETE" && matchMatch) {
    const payload = await withPostgresState((state) => {
      const currentUser = pgRequireAdmin(req, state);
      pgDeleteMatch(state, decodeURIComponent(matchMatch[1]));
      return pgGetStatePayload(state, currentUser);
    });
    return sendJson(req, res, 200, payload);
  }

  if (method === "PATCH" && pathname === "/api/settings") {
    const body = await readJsonBody(req);
    const payload = await withPostgresState((state) => {
      const currentUser = pgRequireAdmin(req, state);
      pgSaveSettings(state, body);
      return pgGetStatePayload(state, currentUser);
    });
    return sendJson(req, res, 200, payload);
  }

  if (method === "POST" && pathname === "/api/import") {
    const body = await readJsonBody(req);
    const payload = await withPostgresState((state) => {
      const currentUser = pgRequireAdmin(req, state);
      pgReplaceData(state, body, currentUser);
      return pgGetStatePayload(state, currentUser);
    });
    return sendJson(req, res, 200, payload);
  }

  if (method === "POST" && pathname === "/api/reset") {
    const payload = await withPostgresState((state) => {
      const currentUser = pgRequireAdmin(req, state);
      pgResetData(state);
      return pgGetStatePayload(state, currentUser);
    });
    return sendJson(req, res, 200, payload);
  }

  const toggleAdminMatch = pathname.match(/^\/api\/users\/([^/]+)\/toggle-admin$/);
  if (method === "PATCH" && toggleAdminMatch) {
    const payload = await withPostgresState((state) => {
      const currentUser = pgRequireAdmin(req, state);
      pgToggleUserRole(state, decodeURIComponent(toggleAdminMatch[1]));
      return pgGetStatePayload(state, pgGetCurrentUser(req, state) || currentUser);
    });
    return sendJson(req, res, 200, payload);
  }

  const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (method === "DELETE" && userMatch) {
    const payload = await withPostgresState((state) => {
      const currentUser = pgRequireAdmin(req, state);
      pgDeleteUser(state, decodeURIComponent(userMatch[1]), currentUser);
      return pgGetStatePayload(state, currentUser);
    });
    return sendJson(req, res, 200, payload);
  }

  throw new HttpError(404, "NOT_FOUND");
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method || "GET";

  if (method === "GET" && healthPaths.has(pathname)) {
    return sendJson(req, res, 200, { ok: true, storage: "sqlite" });
  }

  if (method === "GET" && pathname === "/api/state") {
    return sendJson(req, res, 200, getStatePayload(getCurrentUser(req)));
  }

  if (method === "POST" && pathname === "/api/signup") {
    const body = await readJsonBody(req);
    const result = runInTransaction(() => {
      const user = createAccount(body);
      createPendingPlayerForUser(user);
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
  if (method === "PATCH" && playerMatch) {
    const currentUser = requireAdmin(req);
    const body = await readJsonBody(req);
    runInTransaction(() => updatePlayerSeedRating(decodeURIComponent(playerMatch[1]), body));
    return sendJson(req, res, 200, getStatePayload(currentUser));
  }

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

  if (method === "DELETE" && matchMatch) {
    const currentUser = requireAdmin(req);
    runInTransaction(() => deleteMatch(decodeURIComponent(matchMatch[1])));
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

function cacheControlFor(filePath) {
  const fileName = path.basename(filePath);
  if (["index.html", "app.js", "styles.css"].includes(fileName)) {
    return "no-store";
  }
  return "public, max-age=3600";
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
      "Cache-Control": cacheControlFor(filePath),
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/") || healthPaths.has(url.pathname)) {
      await (usePostgres ? handleApiPostgres(req, res, url) : handleApi(req, res, url));
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    sendError(req, res, error);
  }
});

const port = Number(process.env.PORT || 3000);

async function start() {
  if (usePostgres) {
    await initPostgresDb();
    console.log("Using PostgreSQL database from DATABASE_URL");
  } else {
    initDb();
    console.log(`Using SQLite database at ${dbPath}`);
  }

  server.listen(port, () => {
    console.log(`Badminton ELO server listening on port ${port}`);
  });
}

start().catch((error) => {
  console.error("Failed to start Badminton ELO server", error);
  process.exitCode = 1;
});
