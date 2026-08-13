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
const visitorMaxAgeMs = 1000 * 60 * 60 * 24 * 400;
const visitorCookieName = "visitor_id";
const maxBodyBytes = 2 * 1024 * 1024;
const healthPaths = new Set(["/api/health", "/healthz", "/health"]);

const defaultSettings = {
  baseRating: 1500,
  kFactor: 32,
  marginBonus: true,
};
const validRoles = new Set(["admin", "manager", "member"]);
const validPlayerGenders = new Set(["male", "female"]);
const femalePlayerNames = [
  "안유진",
  "변영선",
  "장예향",
  "백지영",
  "신현정",
  "진수연",
  "이수연",
  "정해슬",
  "김수영",
  "현현영",
  "이예슬",
  "전한슬",
  "이화선",
  "이나은",
  "엘라",
  "최정현",
];
const femalePlayerNameKeys = new Set(femalePlayerNames.map((name) => normalizeNameKey(name)));
const playerCardStickerIds = [
  "shuttle",
  "racket",
  "sparkle",
  "star",
  "fire",
  "crown",
  "trophy",
  "medal",
  "diamond",
  "heart-gold",
  "heart-green",
  "bolt",
  "target",
  "hundred",
  "ribbon",
  "rainbow",
  "honey",
  "clover",
  "sun",
  "moon",
];
const playerCardStickerIdSet = new Set(playerCardStickerIds);

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
      role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'member')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS visitors (
      id TEXT PRIMARY KEY,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_seen_date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS visitor_counts (
      date_key TEXT PRIMARY KEY,
      count INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS queue_players (
      player_id TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      added_by TEXT,
      added_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      gender TEXT NOT NULL DEFAULT 'male' CHECK (gender IN ('male', 'female')),
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

    CREATE TABLE IF NOT EXISTS manner_votes (
      match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      voter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      voter_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      target_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (match_id, voter_user_id)
    );

    CREATE TABLE IF NOT EXISTS card_stickers (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sticker_id TEXT NOT NULL,
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      x REAL NOT NULL,
      y REAL NOT NULL,
      rotation REAL NOT NULL,
      scale REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, sticker_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_matches_sequence ON matches(sequence);
    CREATE INDEX IF NOT EXISTS idx_manner_votes_target ON manner_votes(target_player_id);
    CREATE INDEX IF NOT EXISTS idx_card_stickers_player ON card_stickers(player_id);
  `);

  migrateUsersTable();
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
  const hasGender = columns.some((column) => column.name === "gender");
  const seedRatingColumn = columns.find((column) => column.name === "seed_rating");
  const seedRatingIsNotNull = Number(seedRatingColumn?.notnull || 0) === 1;

  if (hasUserId && hasGender && !seedRatingIsNotNull) {
    backfillPlayerGenders();
    return;
  }

  db.exec("ALTER TABLE players RENAME TO players_legacy");
  db.exec(`
    CREATE TABLE players (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      gender TEXT NOT NULL DEFAULT 'male' CHECK (gender IN ('male', 'female')),
      seed_rating REAL,
      created_at TEXT NOT NULL
    );
  `);

  db.prepare(`
    INSERT INTO players (id, user_id, name, normalized_name, gender, seed_rating, created_at)
    SELECT id,
           ${hasUserId ? "user_id" : "NULL"},
           name,
           normalized_name,
           ${hasGender ? "gender" : "'male'"},
           seed_rating,
           created_at
    FROM players_legacy
  `).run();
  db.exec("DROP TABLE players_legacy");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_players_user_id_unique ON players(user_id) WHERE user_id IS NOT NULL");
  backfillPlayerGenders();
}

function migrateUsersTable() {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (!table?.sql || table.sql.includes("'manager'")) {
    return;
  }

  const users = db.prepare("SELECT id, username, display_name, password_hash, role, created_at FROM users").all();
  const sessions = db.prepare("SELECT id, user_id, expires_at, created_at FROM sessions").all();
  const userIds = new Set(users.map((user) => user.id));

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("DROP TABLE IF EXISTS sessions");
  db.exec("ALTER TABLE users RENAME TO users_legacy");
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'member')),
      created_at TEXT NOT NULL
    );
  `);
  const insertUser = db.prepare(`
    INSERT INTO users (id, username, display_name, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  users.forEach((user) => {
    insertUser.run(
      user.id,
      user.username,
      user.display_name,
      user.password_hash,
      normalizeRole(user.role),
      user.created_at,
    );
  });
  db.exec("DROP TABLE users_legacy");
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const insertSession = db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)");
  sessions
    .filter((session) => userIds.has(session.user_id))
    .forEach((session) => {
      insertSession.run(session.id, session.user_id, session.expires_at, session.created_at);
    });
  db.exec("PRAGMA foreign_keys = ON");
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

function todayVisitorDateKey(date = new Date()) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function safeIsoDate(value, fallback = nowIso()) {
  const fallbackDate = new Date(fallback);
  const fallbackIso = Number.isNaN(fallbackDate.getTime()) ? new Date().toISOString() : fallbackDate.toISOString();
  const date = new Date(value || fallbackIso);
  return Number.isNaN(date.getTime()) ? fallbackIso : date.toISOString();
}

function normalizeVisitorId(value) {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{16,80}$/.test(id) ? id : "";
}

function normalizeRole(value, fallback = "member") {
  const role = String(value || "").trim();
  return validRoles.has(role) ? role : fallback;
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

function basePlayerNameKey(value) {
  return normalizeNameKey(String(value || "").replace(/\s*\([^)]*\)\s*$/, ""));
}

function inferPlayerGenderFromName(name) {
  const normalizedName = normalizeNameKey(name);
  const baseName = basePlayerNameKey(name);
  return femalePlayerNameKeys.has(normalizedName) || femalePlayerNameKeys.has(baseName) ? "female" : "male";
}

function normalizePlayerGender(value, fallbackName = "") {
  const gender = String(value || "").trim().toLowerCase();
  if (validPlayerGenders.has(gender)) {
    return gender;
  }
  return inferPlayerGenderFromName(fallbackName);
}

function backfillPlayerGenders() {
  const update = db.prepare("UPDATE players SET gender = ? WHERE id = ?");
  db
    .prepare("SELECT id, name, gender FROM players")
    .all()
    .forEach((player) => {
      const inferredGender = inferPlayerGenderFromName(player.name);
      const currentGender = String(player.gender || "").trim().toLowerCase();
      if (inferredGender === "female" && currentGender !== "female") {
        update.run(inferredGender, player.id);
        return;
      }
      if (!validPlayerGenders.has(currentGender)) {
        update.run(inferredGender, player.id);
      }
    });
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

function incrementVisitorCount(dateKey) {
  db.prepare(`
    INSERT INTO visitor_counts (date_key, count)
    VALUES (?, 1)
    ON CONFLICT(date_key) DO UPDATE SET count = count + 1
  `).run(dateKey);
}

function recordVisitorVisit(req) {
  const cookies = parseCookies(req.headers.cookie);
  let visitorId = normalizeVisitorId(cookies[visitorCookieName]);
  const shouldSetCookie = !visitorId;
  if (!visitorId) {
    visitorId = uid();
  }

  const now = nowIso();
  const dateKey = todayVisitorDateKey(new Date(now));
  const existing = db.prepare("SELECT id, last_seen_date FROM visitors WHERE id = ?").get(visitorId);
  if (existing) {
    if (existing.last_seen_date !== dateKey) {
      incrementVisitorCount(dateKey);
      db.prepare("UPDATE visitors SET last_seen_at = ?, last_seen_date = ? WHERE id = ?").run(now, dateKey, visitorId);
    } else {
      db.prepare("UPDATE visitors SET last_seen_at = ? WHERE id = ?").run(now, visitorId);
    }
  } else {
    db.prepare("INSERT INTO visitors (id, first_seen_at, last_seen_at, last_seen_date) VALUES (?, ?, ?, ?)").run(
      visitorId,
      now,
      now,
      dateKey,
    );
    incrementVisitorCount(dateKey);
  }

  return shouldSetCookie ? visitorCookie(req, visitorId) : "";
}

function getVisitorStats() {
  const dateKey = todayVisitorDateKey();
  const today = Number(db.prepare("SELECT count FROM visitor_counts WHERE date_key = ?").get(dateKey)?.count || 0);
  const total = Number(db.prepare("SELECT COUNT(*) AS count FROM visitors").get()?.count || 0);
  return { today, total };
}

function userFromRow(row) {
  if (!row) {
    return null;
  }
  const user = {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: normalizeRole(row.role),
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
    accountUsername: row.account_username || "",
    accountRole: row.account_role ? normalizeRole(row.account_role) : "",
    name: row.name,
    gender: normalizePlayerGender(row.gender, row.name),
    seedRating: row.seed_rating == null ? null : Number(row.seed_rating),
    status: row.seed_rating == null ? "pending" : "active",
    createdAt: row.created_at,
  };
}

function getPlayers(options = {}) {
  const includePending = Boolean(options.includePending);
  return db
    .prepare(`
      SELECT players.id,
             players.user_id,
             users.username AS account_username,
             users.role AS account_role,
             players.name,
             players.gender,
             players.seed_rating,
             players.created_at
      FROM players
      LEFT JOIN users ON users.id = players.user_id
      ${includePending ? "" : "WHERE seed_rating IS NOT NULL"}
      ORDER BY players.created_at ASC, players.name ASC
    `)
    .all()
    .map(playerFromRow);
}

function getQueuePlayerIds() {
  return db
    .prepare(`
      SELECT queue_players.player_id
      FROM queue_players
      JOIN players ON players.id = queue_players.player_id
      WHERE players.seed_rating IS NOT NULL
      ORDER BY queue_players.added_at ASC
    `)
    .all()
    .map((row) => row.player_id);
}

function normalizeQueuePlayerIds(inputIds, activePlayerIds) {
  if (!Array.isArray(inputIds)) {
    throw new HttpError(400, "QUEUE_PLAYER_REQUIRED");
  }

  const ids = [];
  const seen = new Set();
  inputIds.forEach((rawId) => {
    const id = String(rawId || "");
    if (!id || seen.has(id)) {
      return;
    }
    if (!activePlayerIds.has(id)) {
      throw new HttpError(400, "QUEUE_UNKNOWN_PLAYER");
    }
    seen.add(id);
    ids.push(id);
  });
  return ids;
}

function saveQueuePlayerIds(input, currentUser) {
  const activePlayerIds = new Set(
    db.prepare("SELECT id FROM players WHERE seed_rating IS NOT NULL").all().map((row) => row.id),
  );
  const ids = normalizeQueuePlayerIds(input?.playerIds, activePlayerIds);
  const now = nowIso();
  const insert = db.prepare("INSERT INTO queue_players (player_id, added_by, added_at) VALUES (?, ?, ?)");

  db.prepare("DELETE FROM queue_players").run();
  ids.forEach((id) => {
    insert.run(id, currentUser.id, now);
  });
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

function mannerVoteFromRow(row) {
  return {
    matchId: row.match_id,
    voterPlayerId: row.voter_player_id,
    targetPlayerId: row.target_player_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getMannerVotes() {
  return db
    .prepare("SELECT match_id, voter_player_id, target_player_id, created_at, updated_at FROM manner_votes ORDER BY created_at ASC")
    .all()
    .map(mannerVoteFromRow);
}

function cardStickerFromRow(row, currentUser = null) {
  return {
    userId: row.user_id,
    stickerId: row.sticker_id,
    playerId: row.player_id,
    x: clampNumber(Number(row.x), 0, 100),
    y: clampNumber(Number(row.y), 0, 100),
    rotation: clampNumber(Number(row.rotation), -35, 35),
    scale: clampNumber(Number(row.scale), 0.7, 1.35),
    ownedByCurrentUser: Boolean(currentUser && row.user_id === currentUser.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getCardStickers(currentUser = null) {
  return db
    .prepare(`
      SELECT card_stickers.user_id,
             card_stickers.sticker_id,
             card_stickers.player_id,
             card_stickers.x,
             card_stickers.y,
             card_stickers.rotation,
             card_stickers.scale,
             card_stickers.created_at,
             card_stickers.updated_at
      FROM card_stickers
      JOIN users ON users.id = card_stickers.user_id
      JOIN players ON players.id = card_stickers.player_id
      WHERE players.seed_rating IS NOT NULL
      ORDER BY card_stickers.created_at ASC
    `)
    .all()
    .map((row) => cardStickerFromRow(row, currentUser));
}

function getStatePayload(currentUser) {
  const safeCurrentUser = currentUser
    ? {
        id: currentUser.id,
        username: currentUser.username,
        displayName: currentUser.displayName,
        role: normalizeRole(currentUser.role),
        createdAt: currentUser.createdAt,
      }
    : null;
  const includePendingPlayers = safeCurrentUser?.role === "admin";
  return {
    players: getPlayers({ includePending: includePendingPlayers }),
    matches: getMatches(),
    mannerVotes: getMannerVotes(),
    cardStickers: getCardStickers(safeCurrentUser),
    settings: getSettings(),
    visitorStats: getVisitorStats(),
    queuePlayerIds: getQueuePlayerIds(),
    users: safeCurrentUser?.role === "admin" ? getUsersSafe() : [],
    currentUser: safeCurrentUser,
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

function currentKoreaYear() {
  return Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric" }).format(new Date()));
}

function stripAccountSuffix(value) {
  return normalizePlayerName(value).replace(/\s*\([^)]*\)\s*$/, "");
}

function normalizeBulkPlayerName(value) {
  return normalizeNameKey(stripAccountSuffix(value));
}

function normalizeBulkText(value) {
  return String(value || "")
    .replace(/\uFEFF/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/\u00a0/g, " ");
}

function startsWithBulkMatchDate(value) {
  return /^(?:\d{4}\s*년\s*)?\d{1,2}\s*월\s*\d{1,2}\s*일\s*(?:(?:오전|오후)\s*)?\d{1,2}/.test(String(value || "").trim());
}

function splitInlineBulkMatchRecords(line) {
  const text = String(line || "").trim();
  if (!text) {
    return [];
  }

  const starts = [];
  const recordStartPattern =
    /(?:^|\s)((?:\d{4}\s*년\s*)?\d{1,2}\s*월\s*\d{1,2}\s*일\s*(?:(?:오전|오후)\s*)?\d{1,2}(?:(?:\s*:\s*|\s*시\s*)\d{1,2})?)/g;
  let match = recordStartPattern.exec(text);
  while (match) {
    starts.push(match.index + match[0].length - match[1].length);
    match = recordStartPattern.exec(text);
  }

  if (starts.length <= 1) {
    return [text];
  }

  return starts.map((start, index) => text.slice(start, starts[index + 1]).trim()).filter(Boolean);
}

function splitBulkMatchRecords(input) {
  const records = [];
  let current = null;

  normalizeBulkText(input)
    .split("\n")
    .forEach((rawLine, index) => {
      const lineNumber = index + 1;
      const line = rawLine.trim();
      if (!line) {
        return;
      }

      splitInlineBulkMatchRecords(line).forEach((piece) => {
        if (startsWithBulkMatchDate(piece)) {
          if (current) {
            records.push(current);
          }
          current = { lineNumber, text: piece };
          return;
        }

        if (current) {
          current.text = `${current.text} ${piece}`.replace(/\s+/g, " ").trim();
          return;
        }

        records.push({ lineNumber, text: piece });
      });
    });

  if (current) {
    records.push(current);
  }

  return records;
}

function buildBulkPlayerLookup(players) {
  const exact = new Map();
  const base = new Map();

  players.forEach((player) => {
    const exactKey = normalizeNameKey(player.name);
    const baseKey = normalizeBulkPlayerName(player.name);

    if (exactKey) {
      exact.set(exactKey, [...(exact.get(exactKey) || []), player]);
    }
    if (baseKey) {
      base.set(baseKey, [...(base.get(baseKey) || []), player]);
    }
  });

  return { exact, base };
}

function resolveBulkPlayer(name, lookup, lineNumber) {
  const exactKey = normalizeNameKey(name);
  const baseKey = normalizeBulkPlayerName(name);
  const exactMatches = lookup.exact.get(exactKey) || [];
  const matches = exactMatches.length ? exactMatches : lookup.base.get(baseKey) || [];

  if (!matches.length) {
    throw new HttpError(400, "BULK_MATCH_PARSE_ERROR", `${lineNumber}행: '${name}' 선수를 찾을 수 없습니다.`);
  }
  if (matches.length > 1) {
    throw new HttpError(
      400,
      "BULK_MATCH_PARSE_ERROR",
      `${lineNumber}행: '${name}' 이름과 일치하는 선수가 여러 명입니다. 선수 목록의 정확한 이름으로 입력하세요.`,
    );
  }
  return matches[0].id;
}

function parseBulkPlayedAt(parts, lineNumber) {
  const year = parts.year ? Number(parts.year) : currentKoreaYear();
  const month = Number(parts.month);
  const day = Number(parts.day);
  const minute = parts.minute == null || parts.minute === "" ? 0 : Number(parts.minute);
  let hour = Number(parts.hour);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new HttpError(400, "BULK_MATCH_PARSE_ERROR", `${lineNumber}행: 경기 일시를 읽을 수 없습니다.`);
  }

  if (parts.period) {
    if (hour < 1 || hour > 12) {
      throw new HttpError(400, "BULK_MATCH_PARSE_ERROR", `${lineNumber}행: 오전/오후 시간은 1~12로 입력하세요.`);
    }
    if (parts.period === "오전" && hour === 12) {
      hour = 0;
    } else if (parts.period === "오후" && hour !== 12) {
      hour += 12;
    }
  }

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new HttpError(400, "BULK_MATCH_PARSE_ERROR", `${lineNumber}행: 경기 일시 범위를 확인하세요.`);
  }

  const isoInput = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`;
  const date = new Date(isoInput);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, "BULK_MATCH_PARSE_ERROR", `${lineNumber}행: 경기 일시를 확인하세요.`);
  }

  const koreaParts = Object.fromEntries(
    new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  if (
    koreaParts.year !== year ||
    koreaParts.month !== month ||
    koreaParts.day !== day ||
    koreaParts.hour !== hour ||
    koreaParts.minute !== minute
  ) {
    throw new HttpError(400, "BULK_MATCH_PARSE_ERROR", `${lineNumber}행: 경기 일시를 확인하세요.`);
  }

  return date.toISOString();
}

function parseBulkTeam(teamText, lookup, lineNumber) {
  const names = String(teamText || "")
    .split(/\s*\/\s*/)
    .map((name) => normalizePlayerName(name))
    .filter(Boolean);

  if (names.length !== 2) {
    throw new HttpError(400, "BULK_MATCH_PARSE_ERROR", `${lineNumber}행: 팀은 '선수 / 선수' 형식으로 입력하세요.`);
  }

  return names.map((name) => resolveBulkPlayer(name, lookup, lineNumber));
}

function parseBulkMatchLine(line, lineNumber, lookup) {
  const normalizedLine = normalizeBulkText(line).replace(/\s+/g, " ").trim();
  const dateMatch = normalizedLine.match(
    /^(?:(?<year>\d{4})\s*년\s*)?(?<month>\d{1,2})\s*월\s*(?<day>\d{1,2})\s*일\s*(?:(?<period>오전|오후)\s*)?(?<hour>\d{1,2})(?:(?:\s*:\s*|\s*시\s*)(?<minute>\d{1,2}))?\s*(?:분)?\s+(?<rest>.+)$/,
  );
  if (!dateMatch?.groups) {
    throw new HttpError(400, "BULK_MATCH_PARSE_ERROR", `${lineNumber}행: 날짜/시간 형식을 확인하세요.`);
  }

  const scoreMatch = dateMatch.groups.rest.match(/^(?<teamA>.+?)\s+(?<scoreA>\d{1,2})\s*[:：]\s*(?<scoreB>\d{1,2})\s+(?<teamB>.+)$/);
  if (!scoreMatch?.groups) {
    throw new HttpError(400, "BULK_MATCH_PARSE_ERROR", `${lineNumber}행: 점수 형식을 확인하세요.`);
  }

  return {
    playedAt: parseBulkPlayedAt(dateMatch.groups, lineNumber),
    teamA: parseBulkTeam(scoreMatch.groups.teamA, lookup, lineNumber),
    teamB: parseBulkTeam(scoreMatch.groups.teamB, lookup, lineNumber),
    scoreA: Number(scoreMatch.groups.scoreA),
    scoreB: Number(scoreMatch.groups.scoreB),
  };
}

function parseBulkMatchText(input, players) {
  const text = normalizeBulkText(input?.text).trim();
  if (!text) {
    throw new HttpError(400, "BULK_MATCH_TEXT_REQUIRED", "경기 기록 텍스트를 입력하세요.");
  }

  const records = splitBulkMatchRecords(text);
  if (!records.length) {
    throw new HttpError(400, "BULK_MATCH_TEXT_REQUIRED", "경기 기록 텍스트를 입력하세요.");
  }
  if (records.length > 200) {
    throw new HttpError(400, "BULK_MATCH_PARSE_ERROR", "한 번에 최대 200경기까지 입력할 수 있습니다.");
  }

  const lookup = buildBulkPlayerLookup(players);
  return records.map((record) => parseBulkMatchLine(record.text, record.lineNumber, lookup));
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

function insertBulkTextMatches(input, currentUser) {
  const matches = parseBulkMatchText(input, getPlayers());
  matches.forEach((match) => insertMatch(match, currentUser));
  return matches.length;
}

function ensureCanEditMatch(match, currentUser) {
  if (currentUser?.role === "admin" || (match.createdBy && match.createdBy === currentUser?.id)) {
    return;
  }
  throw new HttpError(403, "MATCH_EDIT_FORBIDDEN", "이 경기 기록은 입력자 또는 admin만 수정할 수 있습니다.");
}

function getActivePlayerForUser(userId) {
  return db
    .prepare("SELECT * FROM players WHERE user_id = ? AND seed_rating IS NOT NULL")
    .get(userId);
}

function saveMannerVote(matchId, input, currentUser) {
  const row = db.prepare("SELECT * FROM matches WHERE id = ?").get(matchId);
  if (!row) {
    throw new HttpError(404, "MATCH_NOT_FOUND");
  }

  const match = matchFromRow(row);
  const participants = [...match.teamA, ...match.teamB];
  const voterPlayer = getActivePlayerForUser(currentUser.id);
  if (!voterPlayer) {
    throw new HttpError(403, "MANNER_VOTE_PLAYER_REQUIRED", "계정에 연결된 선수만 매너 투표를 할 수 있습니다.");
  }
  if (!participants.includes(voterPlayer.id)) {
    throw new HttpError(403, "MANNER_VOTE_FORBIDDEN", "해당 경기 참여자만 매너 투표를 할 수 있습니다.");
  }

  const targetPlayerId = String(input?.targetPlayerId || input?.target_player_id || "").trim();
  if (!targetPlayerId) {
    throw new HttpError(400, "MANNER_VOTE_TARGET_REQUIRED", "매너 투표할 선수를 선택하세요.");
  }
  if (!participants.includes(targetPlayerId) || targetPlayerId === voterPlayer.id) {
    throw new HttpError(400, "MANNER_VOTE_TARGET_INVALID", "자신을 제외한 경기 참여자에게만 투표할 수 있습니다.");
  }

  const existing = db
    .prepare("SELECT target_player_id FROM manner_votes WHERE match_id = ? AND voter_user_id = ?")
    .get(match.id, currentUser.id);
  if (existing?.target_player_id === targetPlayerId) {
    db.prepare("DELETE FROM manner_votes WHERE match_id = ? AND voter_user_id = ?").run(match.id, currentUser.id);
    return;
  }

  const now = nowIso();
  db.prepare(`
    INSERT INTO manner_votes (match_id, voter_user_id, voter_player_id, target_player_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(match_id, voter_user_id) DO UPDATE SET
      voter_player_id = excluded.voter_player_id,
      target_player_id = excluded.target_player_id,
      updated_at = excluded.updated_at
  `).run(match.id, currentUser.id, voterPlayer.id, targetPlayerId, now, now);
}

function pruneMannerVotesForMatch(matchId, participantIds) {
  const participants = new Set(participantIds);
  db.prepare("SELECT match_id, voter_user_id, voter_player_id, target_player_id FROM manner_votes WHERE match_id = ?")
    .all(matchId)
    .forEach((vote) => {
      if (
        !participants.has(vote.voter_player_id) ||
        !participants.has(vote.target_player_id) ||
        vote.voter_player_id === vote.target_player_id
      ) {
        db.prepare("DELETE FROM manner_votes WHERE match_id = ? AND voter_user_id = ?").run(vote.match_id, vote.voter_user_id);
      }
    });
}

function normalizeStickerId(value) {
  const stickerId = String(value || "").trim();
  if (!playerCardStickerIdSet.has(stickerId)) {
    throw new HttpError(400, "STICKER_INVALID", "스티커를 확인하세요.");
  }
  return stickerId;
}

function normalizeStickerPlacement(input) {
  return {
    x: round1(clampNumber(Number(input?.x), 0, 100)),
    y: round1(clampNumber(Number(input?.y), 0, 100)),
    rotation: round1(clampNumber(Number(input?.rotation ?? 0), -35, 35)),
    scale: round1(clampNumber(Number(input?.scale ?? 1), 0.7, 1.35)),
  };
}

function saveCardSticker(playerId, stickerIdValue, input, currentUser) {
  const stickerId = normalizeStickerId(stickerIdValue);
  const player = db.prepare("SELECT id FROM players WHERE id = ? AND seed_rating IS NOT NULL").get(playerId);
  if (!player) {
    throw new HttpError(404, "PLAYER_NOT_FOUND");
  }

  const existing = db
    .prepare("SELECT player_id FROM card_stickers WHERE user_id = ? AND sticker_id = ?")
    .get(currentUser.id, stickerId);
  if (existing && existing.player_id !== playerId) {
    throw new HttpError(409, "STICKER_ALREADY_USED", "이미 다른 선수 카드에 붙인 스티커입니다.");
  }

  const placement = normalizeStickerPlacement(input);
  const now = nowIso();
  db.prepare(`
    INSERT INTO card_stickers (user_id, sticker_id, player_id, x, y, rotation, scale, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, sticker_id) DO UPDATE SET
      player_id = excluded.player_id,
      x = excluded.x,
      y = excluded.y,
      rotation = excluded.rotation,
      scale = excluded.scale,
      updated_at = excluded.updated_at
  `).run(
    currentUser.id,
    stickerId,
    playerId,
    placement.x,
    placement.y,
    placement.rotation,
    placement.scale,
    now,
    now,
  );
}

function deleteCardSticker(playerId, stickerIdValue, currentUser) {
  const stickerId = normalizeStickerId(stickerIdValue);
  db.prepare("DELETE FROM card_stickers WHERE user_id = ? AND sticker_id = ? AND player_id = ?")
    .run(currentUser.id, stickerId, playerId);
}

function updateMatch(matchId, input, currentUser) {
  const existing = db.prepare("SELECT * FROM matches WHERE id = ?").get(matchId);
  if (!existing) {
    throw new HttpError(404, "MATCH_NOT_FOUND");
  }

  const current = matchFromRow(existing);
  ensureCanEditMatch(current, currentUser);
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

  pruneMannerVotesForMatch(current.id, [...teamA, ...teamB]);
  recalculateMatchesFromOrder(recalculateFrom);
}

function insertPlayer(input) {
  const name = normalizePlayerName(input?.name);
  if (!name) {
    throw new HttpError(400, "PLAYER_NAME_REQUIRED");
  }

  const gender = normalizePlayerGender(input?.gender, name);
  const seedRating = clampNumber(Number(input?.seedRating ?? input?.rating ?? getSettings().baseRating), 800, 2400);
  try {
    db.prepare(`
      INSERT INTO players (id, user_id, name, normalized_name, gender, seed_rating, created_at)
      VALUES (?, NULL, ?, ?, ?, ?, ?)
    `).run(uid(), name, normalizeNameKey(name), gender, seedRating, nowIso());
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

function linkUserToPlayer(targetUserId, input) {
  const playerId = String(input?.playerId || input?.player_id || "").trim();
  if (!playerId) {
    throw new HttpError(400, "USER_PLAYER_REQUIRED", "연결할 선수를 선택하세요.");
  }

  const targetUser = db.prepare("SELECT * FROM users WHERE id = ?").get(targetUserId);
  if (!targetUser) {
    throw new HttpError(404, "USER_NOT_FOUND");
  }

  const targetPlayer = db.prepare("SELECT * FROM players WHERE id = ?").get(playerId);
  if (!targetPlayer) {
    throw new HttpError(404, "PLAYER_NOT_FOUND");
  }
  if (targetPlayer.seed_rating == null) {
    throw new HttpError(400, "PLAYER_RATING_REQUIRED", "초기 ELO가 있는 선수만 연결할 수 있습니다.");
  }
  if (targetPlayer.user_id && targetPlayer.user_id !== targetUserId) {
    throw new HttpError(409, "PLAYER_ALREADY_LINKED", "이미 다른 계정과 연결된 선수입니다.");
  }

  const linkedPlayer = db.prepare("SELECT * FROM players WHERE user_id = ? AND id <> ?").get(targetUserId, playerId);
  if (linkedPlayer) {
    if (countPlayerGames(linkedPlayer.id) === 0) {
      db.prepare("DELETE FROM players WHERE id = ?").run(linkedPlayer.id);
    } else {
      db.prepare("UPDATE players SET user_id = NULL WHERE id = ?").run(linkedPlayer.id);
    }
  }

  db.prepare("UPDATE players SET user_id = ? WHERE id = ?").run(targetUserId, playerId);
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
  const gender = normalizePlayerGender(user.gender, name);
  db.prepare(`
    INSERT INTO players (id, user_id, name, normalized_name, gender, seed_rating, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?)
  `).run(uid(), user.id, name, normalizeNameKey(name), gender, nowIso());
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
  db.prepare("DELETE FROM manner_votes WHERE match_id = ?").run(match.id);
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

function canRegisterPlayers(user) {
  return user?.role === "admin" || user?.role === "manager";
}

function requirePlayerRegistrar(req) {
  const currentUser = requireUser(req);
  if (!canRegisterPlayers(currentUser)) {
    throw new HttpError(403, "PLAYER_REGISTER_FORBIDDEN", "manager 또는 admin 권한이 필요합니다.");
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

function visitorCookie(req, visitorId) {
  const secure = req.headers["x-forwarded-proto"] === "https";
  return [
    `${visitorCookieName}=${encodeURIComponent(visitorId)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.floor(visitorMaxAgeMs / 1000)}`,
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
  const payload = { error: code, code };
  if (error instanceof HttpError && error.message && error.message !== code) {
    payload.message = error.message;
  }
  sendJson(req, res, status, payload);
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
    gender: normalizePlayerGender(input?.gender, displayName),
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

function toggleManagerRole(targetUserId) {
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(targetUserId);
  if (!target) {
    throw new HttpError(404, "USER_NOT_FOUND");
  }
  if (target.role === "admin") {
    throw new HttpError(409, "ADMIN_ROLE_LOCKED", "admin 계정은 admin 해제 후 manager로 변경하세요.");
  }

  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(target.role === "manager" ? "member" : "manager", targetUserId);
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
      gender: normalizePlayerGender(player?.gender, name),
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

  db.prepare("DELETE FROM card_stickers").run();
  db.prepare("DELETE FROM manner_votes").run();
  db.prepare("DELETE FROM matches").run();
  db.prepare("DELETE FROM queue_players").run();
  db.prepare("DELETE FROM players").run();
  saveSettings(settings);

  const insertPlayerStatement = db.prepare(`
    INSERT INTO players (id, user_id, name, normalized_name, gender, seed_rating, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  players.forEach((player) => {
    insertPlayerStatement.run(
      player.id,
      player.userId,
      player.name,
      player.normalizedName,
      player.gender,
      player.seedRating,
      player.createdAt,
    );
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
  db.prepare("DELETE FROM card_stickers").run();
  db.prepare("DELETE FROM manner_votes").run();
  db.prepare("DELETE FROM matches").run();
  db.prepare("DELETE FROM queue_players").run();
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

function createDefaultVisitorStats() {
  return {
    total: 0,
    byDate: {},
    visitors: {},
  };
}

function normalizeVisitorStats(value) {
  const source = value && typeof value === "object" ? value : {};
  const byDate = {};
  Object.entries(source.byDate && typeof source.byDate === "object" ? source.byDate : {}).forEach(([dateKey, count]) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      byDate[dateKey] = Math.max(0, Math.floor(Number(count) || 0));
    }
  });

  const visitors = {};
  Object.entries(source.visitors && typeof source.visitors === "object" ? source.visitors : {}).forEach(([rawId, visitor]) => {
    const id = normalizeVisitorId(rawId);
    if (!id || !visitor || typeof visitor !== "object") {
      return;
    }
    const firstSeenAt = safeIsoDate(visitor.firstSeenAt ?? visitor.first_seen_at, nowIso());
    const lastSeenAt = safeIsoDate(visitor.lastSeenAt ?? visitor.last_seen_at, firstSeenAt);
    const rawLastSeenDate = visitor.lastSeenDate ?? visitor.last_seen_date ?? "";
    const lastSeenDate = /^\d{4}-\d{2}-\d{2}$/.test(String(rawLastSeenDate))
      ? String(rawLastSeenDate)
      : todayVisitorDateKey(new Date(lastSeenAt));
    visitors[id] = { firstSeenAt, lastSeenAt, lastSeenDate };
  });

  return {
    total: Math.max(Math.max(0, Math.floor(Number(source.total) || 0)), Object.keys(visitors).length),
    byDate,
    visitors,
  };
}

function publicVisitorStats(visitorStats) {
  const stats = normalizeVisitorStats(visitorStats);
  const dateKey = todayVisitorDateKey();
  return {
    today: Number(stats.byDate[dateKey] || 0),
    total: Number(stats.total || 0),
  };
}

function createDefaultPostgresState() {
  return {
    schemaVersion: 1,
    users: [],
    sessions: [],
    players: [],
    matches: [],
    mannerVotes: [],
    cardStickers: [],
    settings: cloneSettings(defaultSettings),
    visitorStats: createDefaultVisitorStats(),
    queuePlayerIds: [],
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
    role: normalizeRole(user?.role),
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
    gender: normalizePlayerGender(player?.gender, name),
    seedRating:
      player?.seedRating == null && player?.seed_rating == null
        ? null
        : clampNumber(Number(player?.seedRating ?? player?.seed_rating), 800, 2400),
    createdAt: player?.createdAt ?? player?.created_at ?? nowIso(),
  };
}

function backfillPostgresPlayerGenders(state) {
  state.players.forEach((player) => {
    const inferredGender = inferPlayerGenderFromName(player.name);
    if (inferredGender === "female" || !validPlayerGenders.has(String(player.gender || "").trim().toLowerCase())) {
      player.gender = inferredGender;
    }
  });
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

function normalizeStoredMannerVote(vote, matchMap, activeUserIds, seenKeys) {
  const matchId = String(vote?.matchId ?? vote?.match_id ?? "");
  const voterUserId = String(vote?.voterUserId ?? vote?.voter_user_id ?? "");
  const voterPlayerId = String(vote?.voterPlayerId ?? vote?.voter_player_id ?? "");
  const targetPlayerId = String(vote?.targetPlayerId ?? vote?.target_player_id ?? "");
  const match = matchMap.get(matchId);
  const participants = match ? [...match.teamA, ...match.teamB] : [];
  const key = `${matchId}:${voterUserId}`;

  if (
    !match ||
    !activeUserIds.has(voterUserId) ||
    !participants.includes(voterPlayerId) ||
    !participants.includes(targetPlayerId) ||
    voterPlayerId === targetPlayerId ||
    seenKeys.has(key)
  ) {
    return null;
  }

  seenKeys.add(key);
  const createdAt = safeIsoDate(vote?.createdAt ?? vote?.created_at, nowIso());
  return {
    matchId,
    voterUserId,
    voterPlayerId,
    targetPlayerId,
    createdAt,
    updatedAt: safeIsoDate(vote?.updatedAt ?? vote?.updated_at, createdAt),
  };
}

function normalizeStoredCardSticker(sticker, activeUserIds, activePlayerIds, seenKeys) {
  const userId = String(sticker?.userId ?? sticker?.user_id ?? "");
  const stickerId = String(sticker?.stickerId ?? sticker?.sticker_id ?? "");
  const playerId = String(sticker?.playerId ?? sticker?.player_id ?? "");
  const key = `${userId}:${stickerId}`;

  if (
    !activeUserIds.has(userId) ||
    !playerCardStickerIdSet.has(stickerId) ||
    !activePlayerIds.has(playerId) ||
    seenKeys.has(key)
  ) {
    return null;
  }

  seenKeys.add(key);
  const createdAt = safeIsoDate(sticker?.createdAt ?? sticker?.created_at, nowIso());
  return {
    userId,
    stickerId,
    playerId,
    x: round1(clampNumber(Number(sticker?.x), 0, 100)),
    y: round1(clampNumber(Number(sticker?.y), 0, 100)),
    rotation: round1(clampNumber(Number(sticker?.rotation ?? 0), -35, 35)),
    scale: round1(clampNumber(Number(sticker?.scale ?? 1), 0.7, 1.35)),
    createdAt,
    updatedAt: safeIsoDate(sticker?.updatedAt ?? sticker?.updated_at, createdAt),
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
    mannerVotes: [],
    cardStickers: [],
    settings: cloneSettings(source.settings),
    visitorStats: normalizeVisitorStats(source.visitorStats),
    queuePlayerIds: [],
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
  backfillPostgresPlayerGenders(state);

  const activePlayerIdsForQueue = new Set(state.players.filter((player) => player.seedRating != null).map((player) => player.id));
  const queueIds = Array.isArray(source.queuePlayerIds) ? source.queuePlayerIds : [];
  const seenQueueIds = new Set();
  state.queuePlayerIds = queueIds
    .map(String)
    .filter((id) => {
      if (!activePlayerIdsForQueue.has(id) || seenQueueIds.has(id)) {
        return false;
      }
      seenQueueIds.add(id);
      return true;
    });

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

  const matchMap = new Map(state.matches.map((match) => [match.id, match]));
  const voteKeys = new Set();
  state.mannerVotes = (Array.isArray(source.mannerVotes) ? source.mannerVotes : [])
    .map((vote) => normalizeStoredMannerVote(vote, matchMap, activeUserIds, voteKeys))
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  const activePlayerIdsForStickers = new Set(state.players.filter((player) => player.seedRating != null).map((player) => player.id));
  const stickerKeys = new Set();
  state.cardStickers = (Array.isArray(source.cardStickers) ? source.cardStickers : [])
    .map((sticker) => normalizeStoredCardSticker(sticker, activeUserIds, activePlayerIdsForStickers, stickerKeys))
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

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
    role: normalizeRole(user.role),
    createdAt: user.createdAt,
  };
}

function pgPlayerFromStored(player, state = null) {
  const accountUser = state && player.userId
    ? state.users.find((user) => user.id === player.userId)
    : null;
  return {
    id: player.id,
    userId: player.userId || null,
    accountUsername: accountUser?.username || "",
    accountRole: accountUser ? normalizeRole(accountUser.role) : "",
    name: player.name,
    gender: normalizePlayerGender(player.gender, player.name),
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
    .map((player) => pgPlayerFromStored(player, state));
}

function pgGetMatches(state) {
  return sortMatchesByPlayOrder(state.matches).map(pgMatchFromStored);
}

function pgMannerVoteFromStored(vote) {
  return {
    matchId: vote.matchId,
    voterPlayerId: vote.voterPlayerId,
    targetPlayerId: vote.targetPlayerId,
    createdAt: vote.createdAt,
    updatedAt: vote.updatedAt,
  };
}

function pgGetMannerVotes(state) {
  return state.mannerVotes.map(pgMannerVoteFromStored);
}

function pgCardStickerFromStored(sticker, currentUser = null) {
  return {
    userId: sticker.userId,
    stickerId: sticker.stickerId,
    playerId: sticker.playerId,
    x: clampNumber(Number(sticker.x), 0, 100),
    y: clampNumber(Number(sticker.y), 0, 100),
    rotation: clampNumber(Number(sticker.rotation), -35, 35),
    scale: clampNumber(Number(sticker.scale), 0.7, 1.35),
    ownedByCurrentUser: Boolean(currentUser && sticker.userId === currentUser.id),
    createdAt: sticker.createdAt,
    updatedAt: sticker.updatedAt,
  };
}

function pgGetCardStickers(state, currentUser = null) {
  const activePlayerIds = new Set(state.players.filter((player) => player.seedRating != null).map((player) => player.id));
  return state.cardStickers
    .filter((sticker) => activePlayerIds.has(sticker.playerId))
    .map((sticker) => pgCardStickerFromStored(sticker, currentUser));
}

function pgRecordVisitorVisit(state, req) {
  state.visitorStats = normalizeVisitorStats(state.visitorStats);
  const cookies = parseCookies(req.headers.cookie);
  let visitorId = normalizeVisitorId(cookies[visitorCookieName]);
  const shouldSetCookie = !visitorId;
  if (!visitorId) {
    visitorId = uid();
  }

  const now = nowIso();
  const dateKey = todayVisitorDateKey(new Date(now));
  const existing = state.visitorStats.visitors[visitorId];
  if (existing) {
    if (existing.lastSeenDate !== dateKey) {
      state.visitorStats.byDate[dateKey] = Number(state.visitorStats.byDate[dateKey] || 0) + 1;
      existing.lastSeenDate = dateKey;
    }
    existing.lastSeenAt = now;
  } else {
    state.visitorStats.visitors[visitorId] = {
      firstSeenAt: now,
      lastSeenAt: now,
      lastSeenDate: dateKey,
    };
    state.visitorStats.total = Number(state.visitorStats.total || 0) + 1;
    state.visitorStats.byDate[dateKey] = Number(state.visitorStats.byDate[dateKey] || 0) + 1;
  }

  return shouldSetCookie ? visitorCookie(req, visitorId) : "";
}

function pgSaveQueuePlayerIds(state, input) {
  const activePlayerIds = new Set(state.players.filter((player) => player.seedRating != null).map((player) => player.id));
  state.queuePlayerIds = normalizeQueuePlayerIds(input?.playerIds, activePlayerIds);
}

function pgGetStatePayload(state, currentUser) {
  const safeCurrentUser = pgUserFromStored(currentUser);
  const includePendingPlayers = safeCurrentUser?.role === "admin";
  return {
    players: pgGetPlayers(state, { includePending: includePendingPlayers }),
    matches: pgGetMatches(state),
    mannerVotes: pgGetMannerVotes(state),
    cardStickers: pgGetCardStickers(state, safeCurrentUser),
    settings: cloneSettings(state.settings),
    visitorStats: publicVisitorStats(state.visitorStats),
    queuePlayerIds: [...state.queuePlayerIds],
    users: safeCurrentUser?.role === "admin" ? pgGetUsersSafe(state) : [],
    currentUser: safeCurrentUser,
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

function pgRequirePlayerRegistrar(req, state) {
  const currentUser = pgRequireUser(req, state);
  if (!canRegisterPlayers(currentUser)) {
    throw new HttpError(403, "PLAYER_REGISTER_FORBIDDEN", "manager 또는 admin 권한이 필요합니다.");
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

function pgInsertBulkTextMatches(state, input, currentUser) {
  const matches = parseBulkMatchText(input, pgGetPlayers(state));
  matches.forEach((match) => pgInsertMatch(state, match, currentUser));
  return matches.length;
}

function pgUpdateMatch(state, matchId, input, currentUser) {
  const match = state.matches.find((candidate) => candidate.id === matchId);
  if (!match) {
    throw new HttpError(404, "MATCH_NOT_FOUND");
  }

  const current = { ...match };
  ensureCanEditMatch(current, currentUser);
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
  pgPruneMannerVotesForMatch(state, match.id, [...teamA, ...teamB]);
  pgRecalculateMatchesFromOrder(state, recalculateFrom);
}

function pgPruneMannerVotesForMatch(state, matchId, participantIds) {
  const participants = new Set(participantIds);
  state.mannerVotes = state.mannerVotes.filter((vote) => (
    vote.matchId !== matchId ||
    (
      participants.has(vote.voterPlayerId) &&
      participants.has(vote.targetPlayerId) &&
      vote.voterPlayerId !== vote.targetPlayerId
    )
  ));
}

function pgSaveMannerVote(state, matchId, input, currentUser) {
  const match = state.matches.find((candidate) => candidate.id === matchId);
  if (!match) {
    throw new HttpError(404, "MATCH_NOT_FOUND");
  }

  const participants = [...match.teamA, ...match.teamB];
  const voterPlayer = state.players.find((player) => player.userId === currentUser.id && player.seedRating != null);
  if (!voterPlayer) {
    throw new HttpError(403, "MANNER_VOTE_PLAYER_REQUIRED", "계정에 연결된 선수만 매너 투표를 할 수 있습니다.");
  }
  if (!participants.includes(voterPlayer.id)) {
    throw new HttpError(403, "MANNER_VOTE_FORBIDDEN", "해당 경기 참여자만 매너 투표를 할 수 있습니다.");
  }

  const targetPlayerId = String(input?.targetPlayerId || input?.target_player_id || "").trim();
  if (!targetPlayerId) {
    throw new HttpError(400, "MANNER_VOTE_TARGET_REQUIRED", "매너 투표할 선수를 선택하세요.");
  }
  if (!participants.includes(targetPlayerId) || targetPlayerId === voterPlayer.id) {
    throw new HttpError(400, "MANNER_VOTE_TARGET_INVALID", "자신을 제외한 경기 참여자에게만 투표할 수 있습니다.");
  }

  const existing = state.mannerVotes.find((vote) => vote.matchId === match.id && vote.voterUserId === currentUser.id);
  if (existing?.targetPlayerId === targetPlayerId) {
    state.mannerVotes = state.mannerVotes.filter((vote) => !(vote.matchId === match.id && vote.voterUserId === currentUser.id));
    return;
  }

  const now = nowIso();
  if (existing) {
    existing.voterPlayerId = voterPlayer.id;
    existing.targetPlayerId = targetPlayerId;
    existing.updatedAt = now;
    return;
  }

  state.mannerVotes.push({
    matchId: match.id,
    voterUserId: currentUser.id,
    voterPlayerId: voterPlayer.id,
    targetPlayerId,
    createdAt: now,
    updatedAt: now,
  });
}

function pgSaveCardSticker(state, playerId, stickerIdValue, input, currentUser) {
  const stickerId = normalizeStickerId(stickerIdValue);
  const player = state.players.find((candidate) => candidate.id === playerId && candidate.seedRating != null);
  if (!player) {
    throw new HttpError(404, "PLAYER_NOT_FOUND");
  }

  const existing = state.cardStickers.find((sticker) => sticker.userId === currentUser.id && sticker.stickerId === stickerId);
  if (existing && existing.playerId !== playerId) {
    throw new HttpError(409, "STICKER_ALREADY_USED", "이미 다른 선수 카드에 붙인 스티커입니다.");
  }

  const placement = normalizeStickerPlacement(input);
  const now = nowIso();
  if (existing) {
    existing.playerId = playerId;
    existing.x = placement.x;
    existing.y = placement.y;
    existing.rotation = placement.rotation;
    existing.scale = placement.scale;
    existing.updatedAt = now;
    return;
  }

  state.cardStickers.push({
    userId: currentUser.id,
    stickerId,
    playerId,
    x: placement.x,
    y: placement.y,
    rotation: placement.rotation,
    scale: placement.scale,
    createdAt: now,
    updatedAt: now,
  });
}

function pgDeleteCardSticker(state, playerId, stickerIdValue, currentUser) {
  const stickerId = normalizeStickerId(stickerIdValue);
  state.cardStickers = state.cardStickers.filter((sticker) => !(
    sticker.userId === currentUser.id &&
    sticker.stickerId === stickerId &&
    sticker.playerId === playerId
  ));
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
  const gender = normalizePlayerGender(input?.gender, name);
  state.players.push({
    id: uid(),
    userId: null,
    name,
    normalizedName,
    gender,
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
  state.queuePlayerIds = state.queuePlayerIds.filter((id) => id !== playerId);
  state.cardStickers = state.cardStickers.filter((sticker) => sticker.playerId !== playerId);
  if (state.players.length === originalLength) {
    throw new HttpError(404, "PLAYER_NOT_FOUND");
  }
}

function pgLinkUserToPlayer(state, targetUserId, input) {
  const playerId = String(input?.playerId || input?.player_id || "").trim();
  if (!playerId) {
    throw new HttpError(400, "USER_PLAYER_REQUIRED", "연결할 선수를 선택하세요.");
  }

  const targetUser = state.users.find((user) => user.id === targetUserId);
  if (!targetUser) {
    throw new HttpError(404, "USER_NOT_FOUND");
  }

  const targetPlayer = state.players.find((player) => player.id === playerId);
  if (!targetPlayer) {
    throw new HttpError(404, "PLAYER_NOT_FOUND");
  }
  if (targetPlayer.seedRating == null) {
    throw new HttpError(400, "PLAYER_RATING_REQUIRED", "초기 ELO가 있는 선수만 연결할 수 있습니다.");
  }
  if (targetPlayer.userId && targetPlayer.userId !== targetUserId) {
    throw new HttpError(409, "PLAYER_ALREADY_LINKED", "이미 다른 계정과 연결된 선수입니다.");
  }

  const linkedPlayer = state.players.find((player) => player.userId === targetUserId && player.id !== targetPlayer.id);
  if (linkedPlayer) {
    if (pgCountPlayerGames(state, linkedPlayer.id) === 0) {
      state.players = state.players.filter((player) => player.id !== linkedPlayer.id);
    } else {
      linkedPlayer.userId = null;
    }
  }

  targetPlayer.userId = targetUserId;
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
  const gender = normalizePlayerGender(user.gender, name);
  state.players.push({
    id: uid(),
    userId: user.id,
    name,
    normalizedName: normalizeNameKey(name),
    gender,
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
  state.mannerVotes = state.mannerVotes.filter((vote) => vote.matchId !== matchId);
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
    gender: normalizePlayerGender(input?.gender, displayName),
    passwordHash: hashPassword(password),
    role: state.users.length === 0 ? "admin" : "member",
    createdAt: nowIso(),
  };
  state.users.push(user);
  return user;
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

function pgToggleManagerRole(state, targetUserId) {
  const target = state.users.find((user) => user.id === targetUserId);
  if (!target) {
    throw new HttpError(404, "USER_NOT_FOUND");
  }
  if (target.role === "admin") {
    throw new HttpError(409, "ADMIN_ROLE_LOCKED", "admin 계정은 admin 해제 후 manager로 변경하세요.");
  }

  target.role = target.role === "manager" ? "member" : "manager";
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
      state.queuePlayerIds = state.queuePlayerIds.filter((id) => id !== linkedPlayer.id);
    } else {
      linkedPlayer.userId = null;
    }
  }

  state.sessions = state.sessions.filter((session) => session.userId !== targetUserId);
  state.users = state.users.filter((user) => user.id !== targetUserId);
  state.cardStickers = state.cardStickers.filter((sticker) => sticker.userId !== targetUserId);
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
    gender: player.gender,
    seedRating: player.seedRating,
    createdAt: player.createdAt,
  }));
  state.matches = [];
  state.mannerVotes = [];
  state.cardStickers = [];
  state.settings = cloneSettings(settings);
  state.queuePlayerIds = [];

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
  state.mannerVotes = [];
  state.cardStickers = [];
  state.settings = cloneSettings(defaultSettings);
  state.queuePlayerIds = [];
  pgEnsurePendingPlayersForUsers(state);
}

async function handleApiPostgres(req, res, url) {
  const { pathname } = url;
  const method = req.method || "GET";

  if (method === "GET" && healthPaths.has(pathname)) {
    return sendJson(req, res, 200, { ok: true, storage: "postgres" });
  }

  if (method === "GET" && pathname === "/api/state") {
    const result = await withPostgresState((state) => {
      const currentUser = pgGetCurrentUser(req, state);
      const visitCookie = pgRecordVisitorVisit(state, req);
      return {
        payload: pgGetStatePayload(state, currentUser),
        cookies: visitCookie ? [visitCookie] : [],
      };
    });
    return sendJson(req, res, 200, result.payload, result.cookies);
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
      const currentUser = pgRequirePlayerRegistrar(req, state);
      pgInsertPlayer(state, body);
      return pgGetStatePayload(state, currentUser);
    });
    return sendJson(req, res, 201, payload);
  }

  if (method === "PUT" && pathname === "/api/queue") {
    const body = await readJsonBody(req);
    const payload = await withPostgresState((state) => {
      const currentUser = pgRequireUser(req, state);
      pgSaveQueuePlayerIds(state, body);
      return pgGetStatePayload(state, currentUser);
    });
    return sendJson(req, res, 200, payload);
  }

  const playerStickerMatch = pathname.match(/^\/api\/players\/([^/]+)\/stickers\/([^/]+)$/);
  if (method === "PUT" && playerStickerMatch) {
    const body = await readJsonBody(req);
    const payload = await withPostgresState((state) => {
      const currentUser = pgRequireUser(req, state);
      pgSaveCardSticker(
        state,
        decodeURIComponent(playerStickerMatch[1]),
        decodeURIComponent(playerStickerMatch[2]),
        body,
        currentUser,
      );
      return pgGetStatePayload(state, currentUser);
    });
    return sendJson(req, res, 200, payload);
  }

  if (method === "DELETE" && playerStickerMatch) {
    const payload = await withPostgresState((state) => {
      const currentUser = pgRequireUser(req, state);
      pgDeleteCardSticker(
        state,
        decodeURIComponent(playerStickerMatch[1]),
        decodeURIComponent(playerStickerMatch[2]),
        currentUser,
      );
      return pgGetStatePayload(state, currentUser);
    });
    return sendJson(req, res, 200, payload);
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

  if (method === "POST" && pathname === "/api/matches/bulk-text") {
    const body = await readJsonBody(req);
    const result = await withPostgresState((state) => {
      const currentUser = pgRequireAdmin(req, state);
      const bulkInserted = pgInsertBulkTextMatches(state, body, currentUser);
      return { payload: pgGetStatePayload(state, currentUser), bulkInserted };
    });
    return sendJson(req, res, 201, { ...result.payload, bulkInserted: result.bulkInserted });
  }

  const matchMatch = pathname.match(/^\/api\/matches\/([^/]+)$/);
  const mannerVoteMatch = pathname.match(/^\/api\/matches\/([^/]+)\/manner-vote$/);
  if (method === "PUT" && mannerVoteMatch) {
    const body = await readJsonBody(req);
    const payload = await withPostgresState((state) => {
      const currentUser = pgRequireUser(req, state);
      pgSaveMannerVote(state, decodeURIComponent(mannerVoteMatch[1]), body, currentUser);
      return pgGetStatePayload(state, currentUser);
    });
    return sendJson(req, res, 200, payload);
  }

  if (method === "PUT" && matchMatch) {
    const body = await readJsonBody(req);
    const payload = await withPostgresState((state) => {
      const currentUser = pgRequireUser(req, state);
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

  const toggleManagerMatch = pathname.match(/^\/api\/users\/([^/]+)\/toggle-manager$/);
  if (method === "PATCH" && toggleManagerMatch) {
    const payload = await withPostgresState((state) => {
      const currentUser = pgRequireAdmin(req, state);
      pgToggleManagerRole(state, decodeURIComponent(toggleManagerMatch[1]));
      return pgGetStatePayload(state, currentUser);
    });
    return sendJson(req, res, 200, payload);
  }

  const userPlayerMatch = pathname.match(/^\/api\/users\/([^/]+)\/player$/);
  if (method === "PATCH" && userPlayerMatch) {
    const body = await readJsonBody(req);
    const payload = await withPostgresState((state) => {
      const currentUser = pgRequireAdmin(req, state);
      pgLinkUserToPlayer(state, decodeURIComponent(userPlayerMatch[1]), body);
      return pgGetStatePayload(state, currentUser);
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
    const result = runInTransaction(() => {
      const currentUser = getCurrentUser(req);
      const visitCookie = recordVisitorVisit(req);
      return {
        payload: getStatePayload(currentUser),
        cookies: visitCookie ? [visitCookie] : [],
      };
    });
    return sendJson(req, res, 200, result.payload, result.cookies);
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
    const currentUser = requirePlayerRegistrar(req);
    const body = await readJsonBody(req);
    runInTransaction(() => insertPlayer(body));
    return sendJson(req, res, 201, getStatePayload(currentUser));
  }

  if (method === "PUT" && pathname === "/api/queue") {
    const currentUser = requireUser(req);
    const body = await readJsonBody(req);
    runInTransaction(() => saveQueuePlayerIds(body, currentUser));
    return sendJson(req, res, 200, getStatePayload(currentUser));
  }

  const playerStickerMatch = pathname.match(/^\/api\/players\/([^/]+)\/stickers\/([^/]+)$/);
  if (method === "PUT" && playerStickerMatch) {
    const currentUser = requireUser(req);
    const body = await readJsonBody(req);
    runInTransaction(() => saveCardSticker(
      decodeURIComponent(playerStickerMatch[1]),
      decodeURIComponent(playerStickerMatch[2]),
      body,
      currentUser,
    ));
    return sendJson(req, res, 200, getStatePayload(currentUser));
  }

  if (method === "DELETE" && playerStickerMatch) {
    const currentUser = requireUser(req);
    runInTransaction(() => deleteCardSticker(
      decodeURIComponent(playerStickerMatch[1]),
      decodeURIComponent(playerStickerMatch[2]),
      currentUser,
    ));
    return sendJson(req, res, 200, getStatePayload(currentUser));
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

  if (method === "POST" && pathname === "/api/matches/bulk-text") {
    const currentUser = requireAdmin(req);
    const body = await readJsonBody(req);
    let bulkInserted = 0;
    runInTransaction(() => {
      bulkInserted = insertBulkTextMatches(body, currentUser);
    });
    return sendJson(req, res, 201, { ...getStatePayload(currentUser), bulkInserted });
  }

  const matchMatch = pathname.match(/^\/api\/matches\/([^/]+)$/);
  const mannerVoteMatch = pathname.match(/^\/api\/matches\/([^/]+)\/manner-vote$/);
  if (method === "PUT" && mannerVoteMatch) {
    const currentUser = requireUser(req);
    const body = await readJsonBody(req);
    runInTransaction(() => saveMannerVote(decodeURIComponent(mannerVoteMatch[1]), body, currentUser));
    return sendJson(req, res, 200, getStatePayload(currentUser));
  }

  if (method === "PUT" && matchMatch) {
    const currentUser = requireUser(req);
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

  const toggleManagerMatch = pathname.match(/^\/api\/users\/([^/]+)\/toggle-manager$/);
  if (method === "PATCH" && toggleManagerMatch) {
    const currentUser = requireAdmin(req);
    runInTransaction(() => toggleManagerRole(decodeURIComponent(toggleManagerMatch[1])));
    return sendJson(req, res, 200, getStatePayload(currentUser));
  }

  const userPlayerMatch = pathname.match(/^\/api\/users\/([^/]+)\/player$/);
  if (method === "PATCH" && userPlayerMatch) {
    const currentUser = requireAdmin(req);
    const body = await readJsonBody(req);
    runInTransaction(() => linkUserToPlayer(decodeURIComponent(userPlayerMatch[1]), body));
    return sendJson(req, res, 200, getStatePayload(currentUser));
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
  const normalizedPath = filePath.split(path.sep).join("/");
  if (normalizedPath.includes("/assets/player-cards/") || normalizedPath.includes("/assets/player-photos/")) {
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
