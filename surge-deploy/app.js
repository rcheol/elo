const STORAGE_KEY = "badminton-doubles-elo:v2";
const LEGACY_STORAGE_KEY = "badminton-doubles-elo:v1";
const DB_NAME = "badminton-doubles-elo-db";
const DB_VERSION = 1;
const DB_STORE = "records";
const DB_STATE_KEY = "state";

const defaultSettings = {
  baseRating: 1500,
  kFactor: 32,
  marginBonus: true,
};

const selectIds = ["teamA1", "teamA2", "teamB1", "teamB2"];
const editSelectIds = ["editTeamA1", "editTeamA2", "editTeamB1", "editTeamB2"];
let state = createDefaultState();
let toastTimer = null;
let editingMatchId = null;
let dbWriteQueue = Promise.resolve();

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

function createDefaultState() {
  return {
    schemaVersion: 2,
    players: [],
    matches: [],
    users: [],
    session: { userId: null },
    settings: { ...defaultSettings },
  };
}

function uid() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function openLocalDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB is not available"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readLocalDbState() {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, "readonly");
    const request = transaction.objectStore(DB_STORE).get(DB_STATE_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

async function writeLocalDbState(nextState) {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, "readwrite");
    transaction.objectStore(DB_STORE).put(nextState, DB_STATE_KEY);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

async function loadState() {
  try {
    const saved = await readLocalDbState();
    if (saved) {
      return normalizeState(saved);
    }
  } catch (error) {
    console.warn("Failed to read IndexedDB state", error);
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) {
      return createDefaultState();
    }
    const nextState = normalizeState(JSON.parse(raw));
    saveState(nextState);
    return nextState;
  } catch (error) {
    console.warn("Failed to load saved rankings", error);
    return createDefaultState();
  }
}

function normalizeState(input) {
  const fallback = createDefaultState();
  const players = Array.isArray(input?.players)
    ? input.players
        .filter((player) => player && player.id && player.name)
        .map((player) => ({
          id: String(player.id),
          name: String(player.name).trim(),
          seedRating: clampNumber(Number(player.seedRating ?? player.rating ?? defaultSettings.baseRating), 800, 2400),
          createdAt: player.createdAt || new Date().toISOString(),
        }))
    : [];

  const playerIds = new Set(players.map((player) => player.id));
  const matches = Array.isArray(input?.matches)
    ? input.matches
        .filter((match) => {
          const ids = [...(match.teamA || []), ...(match.teamB || [])];
          return ids.length === 4 && ids.every((id) => playerIds.has(String(id)));
        })
        .map((match) => ({
          id: String(match.id || uid()),
          teamA: match.teamA.map(String),
          teamB: match.teamB.map(String),
          scoreA: Number(match.scoreA),
          scoreB: Number(match.scoreB),
          winner: match.winner === "B" ? "B" : "A",
          expectedA: Number(match.expectedA ?? 0.5),
          expectedB: Number(match.expectedB ?? 0.5),
          teamRatingA: Number(match.teamRatingA ?? defaultSettings.baseRating),
          teamRatingB: Number(match.teamRatingB ?? defaultSettings.baseRating),
          kFactor: clampNumber(Number(match.kFactor ?? defaultSettings.kFactor), 8, 64),
          marginBonus: match.marginBonus ?? Number(match.marginFactor ?? 1) !== 1,
          marginFactor: Number(match.marginFactor ?? 1),
          changes: Array.isArray(match.changes) ? match.changes.map((change) => ({ id: String(change.id), delta: Number(change.delta || 0) })) : [],
          createdBy: match.createdBy ? String(match.createdBy) : null,
          createdByName: match.createdByName ? String(match.createdByName) : "알 수 없음",
          updatedBy: match.updatedBy ? String(match.updatedBy) : null,
          updatedByName: match.updatedByName ? String(match.updatedByName) : "",
          createdAt: match.createdAt || new Date().toISOString(),
          updatedAt: match.updatedAt || null,
        }))
    : [];

  const users = Array.isArray(input?.users)
    ? input.users
        .filter((user) => user && user.id && user.username && user.passwordHash)
        .map((user) => ({
          id: String(user.id),
          username: normalizeUsername(user.username),
          displayName: String(user.displayName || user.username).trim(),
          passwordHash: String(user.passwordHash),
          role: user.role === "admin" ? "admin" : "member",
          createdAt: user.createdAt || new Date().toISOString(),
        }))
    : [];

  const userIds = new Set(users.map((user) => user.id));
  const sessionUserId = input?.session?.userId && userIds.has(String(input.session.userId))
    ? String(input.session.userId)
    : null;

  const nextState = {
    schemaVersion: 2,
    players,
    matches,
    users,
    session: { userId: sessionUserId },
    settings: {
      baseRating: clampNumber(Number(input?.settings?.baseRating ?? defaultSettings.baseRating), 800, 2400),
      kFactor: clampNumber(Number(input?.settings?.kFactor ?? defaultSettings.kFactor), 8, 64),
      marginBonus: input?.settings?.marginBonus !== false,
    },
  };

  if (!nextState.settings) {
    nextState.settings = fallback.settings;
  }

  recalculateMatchesFrom(0, nextState);
  return nextState;
}

function saveState(nextState = state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
  const snapshot = JSON.parse(JSON.stringify(nextState));
  dbWriteQueue = dbWriteQueue
    .then(() => writeLocalDbState(snapshot))
    .catch((error) => {
      console.warn("Failed to write IndexedDB state", error);
    });
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeUsername(value) {
  return String(value || "").trim().toLocaleLowerCase().replace(/\s+/g, "");
}

async function hashPassword(username, password) {
  const payload = `${normalizeUsername(username)}:${password}`;
  if (window.crypto?.subtle) {
    const data = new TextEncoder().encode(payload);
    const digest = await window.crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return btoa(unescape(encodeURIComponent(payload)));
}

function formatSigned(value, digits = 1) {
  const rounded = Number(value).toFixed(digits);
  return value > 0 ? `+${rounded}` : rounded;
}

function formatDate(isoDate) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(isoDate));
}

function getCurrentUser() {
  return state.users.find((user) => user.id === state.session.userId) || null;
}

function isAdmin() {
  return getCurrentUser()?.role === "admin";
}

function requireLogin() {
  if (!getCurrentUser()) {
    showToast("로그인 후 사용할 수 있습니다.");
    return false;
  }
  return true;
}

function requireAdmin() {
  if (!isAdmin()) {
    showToast("admin 권한이 필요합니다.");
    return false;
  }
  return true;
}

async function createAccount(username, displayName, password) {
  const normalizedUsername = normalizeUsername(username);
  const cleanDisplayName = String(displayName || username).trim().replace(/\s+/g, " ");
  if (normalizedUsername.length < 3) {
    showToast("아이디는 3자 이상 입력하세요.");
    return false;
  }
  if (!cleanDisplayName) {
    showToast("이름을 입력하세요.");
    return false;
  }
  if (String(password).length < 4) {
    showToast("비밀번호는 4자 이상 입력하세요.");
    return false;
  }
  if (state.users.some((user) => user.username === normalizedUsername)) {
    showToast("이미 등록된 아이디입니다.");
    return false;
  }

  const user = {
    id: uid(),
    username: normalizedUsername,
    displayName: cleanDisplayName,
    passwordHash: await hashPassword(normalizedUsername, password),
    role: state.users.length === 0 ? "admin" : "member",
    createdAt: new Date().toISOString(),
  };

  state.users.push(user);
  state.session.userId = user.id;
  saveState();
  render();
  showToast(user.role === "admin" ? "admin 계정을 만들고 로그인했습니다." : "계정을 만들고 로그인했습니다.");
  return true;
}

async function login(username, password) {
  const normalizedUsername = normalizeUsername(username);
  const user = state.users.find((entry) => entry.username === normalizedUsername);
  if (!user) {
    showToast("계정을 찾을 수 없습니다.");
    return false;
  }
  const passwordHash = await hashPassword(normalizedUsername, password);
  if (user.passwordHash !== passwordHash) {
    showToast("비밀번호를 확인하세요.");
    return false;
  }
  state.session.userId = user.id;
  saveState();
  render();
  showToast(`${user.displayName}님으로 로그인했습니다.`);
  return true;
}

function logout() {
  state.session.userId = null;
  saveState();
  render();
  showToast("로그아웃했습니다.");
}

function toggleUserRole(userId) {
  if (!requireAdmin()) return;
  const target = state.users.find((user) => user.id === userId);
  if (!target) return;

  const adminCount = state.users.filter((user) => user.role === "admin").length;
  if (target.role === "admin" && adminCount <= 1) {
    showToast("admin 계정은 최소 1개가 필요합니다.");
    return;
  }

  target.role = target.role === "admin" ? "member" : "admin";
  saveState();
  render();
  showToast(`${target.displayName} 권한을 변경했습니다.`);
}

function deleteUser(userId) {
  if (!requireAdmin()) return;
  const target = state.users.find((user) => user.id === userId);
  if (!target) return;
  if (target.id === getCurrentUser()?.id) {
    showToast("현재 로그인한 계정은 삭제할 수 없습니다.");
    return;
  }
  if (!window.confirm(`${target.displayName} 계정을 삭제할까요?`)) {
    return;
  }
  state.users = state.users.filter((user) => user.id !== userId);
  saveState();
  render();
  showToast("계정을 삭제했습니다.");
}

function getStandings(sourceState = state) {
  const table = new Map(
    sourceState.players.map((player) => [
      player.id,
      {
        ...player,
        rating: player.seedRating,
        games: 0,
        wins: 0,
        losses: 0,
        pointsFor: 0,
        pointsAgainst: 0,
        streak: 0,
        lastPlayed: null,
      },
    ]),
  );

  sourceState.matches.forEach((match) => {
    match.changes.forEach((change) => {
      const player = table.get(change.id);
      if (player) {
        player.rating = round1(player.rating + Number(change.delta || 0));
      }
    });

    applyMatchStats(table, match.teamA, match.winner === "A", match.scoreA, match.scoreB, match.createdAt);
    applyMatchStats(table, match.teamB, match.winner === "B", match.scoreB, match.scoreA, match.createdAt);
  });

  return [...table.values()]
    .map((player) => ({
      ...player,
      rating: round1(player.rating),
      winRate: player.games ? player.wins / player.games : 0,
      pointDiff: player.pointsFor - player.pointsAgainst,
      ratingDelta: round1(player.rating - player.seedRating),
    }))
    .sort((a, b) => {
      if (b.rating !== a.rating) return b.rating - a.rating;
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      if (b.games !== a.games) return b.games - a.games;
      return a.name.localeCompare(b.name, "ko-KR");
    });
}

function applyMatchStats(table, ids, won, pointsFor, pointsAgainst, createdAt) {
  ids.forEach((id) => {
    const player = table.get(id);
    if (!player) return;
    player.games += 1;
    player.wins += won ? 1 : 0;
    player.losses += won ? 0 : 1;
    player.pointsFor += pointsFor;
    player.pointsAgainst += pointsAgainst;
    player.lastPlayed = createdAt;
    player.streak = won
      ? player.streak > 0 ? player.streak + 1 : 1
      : player.streak < 0 ? player.streak - 1 : -1;
  });
}

function playerName(id) {
  return state.players.find((player) => player.id === id)?.name || "알 수 없음";
}

function addPlayer(name, rating) {
  if (!requireAdmin()) return false;

  const normalizedName = name.trim().replace(/\s+/g, " ");
  if (!normalizedName) {
    showToast("선수 이름을 입력하세요.");
    return false;
  }

  const duplicate = state.players.some((player) => player.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase());
  if (duplicate) {
    showToast("이미 등록된 이름입니다.");
    return false;
  }

  state.players.push({
    id: uid(),
    name: normalizedName,
    seedRating: clampNumber(Number(rating || state.settings.baseRating), 800, 2400),
    createdAt: new Date().toISOString(),
  });
  saveState();
  render();
  showToast(`${normalizedName} 선수를 추가했습니다.`);
  return true;
}

function deletePlayer(playerId) {
  if (!requireAdmin()) return;

  const standings = getStandings();
  const player = standings.find((entry) => entry.id === playerId);
  if (!player || player.games > 0) {
    showToast("경기 기록이 있는 선수는 삭제할 수 없습니다.");
    return;
  }

  state.players = state.players.filter((entry) => entry.id !== playerId);
  saveState();
  render();
  showToast("선수를 삭제했습니다.");
}

function getCurrentRatingMap(sourceState = state) {
  const ratings = new Map(sourceState.players.map((player) => [player.id, player.seedRating]));
  sourceState.matches.forEach((match) => {
    applyRatingChanges(ratings, match);
  });
  return ratings;
}

function calculateMatchFields(match, ratingById) {
  const teamRatingA = average(match.teamA.map((id) => ratingById.get(id) ?? state.settings.baseRating));
  const teamRatingB = average(match.teamB.map((id) => ratingById.get(id) ?? state.settings.baseRating));
  const expectedA = 1 / (1 + 10 ** ((teamRatingB - teamRatingA) / 400));
  const expectedB = 1 - expectedA;
  const resultA = match.scoreA > match.scoreB ? 1 : 0;
  const resultB = 1 - resultA;
  const useMarginBonus = match.marginBonus !== false;
  const marginFactor = useMarginBonus ? getMarginFactor(match.scoreA, match.scoreB) : 1;
  const kFactor = clampNumber(Number(match.kFactor ?? state.settings.kFactor), 8, 64);
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

function recalculateMatchesFrom(startIndex = 0, sourceState = state) {
  const ratings = new Map(sourceState.players.map((player) => [player.id, player.seedRating]));
  const firstIndex = Math.max(0, Number(startIndex) || 0);

  sourceState.matches.forEach((match, index) => {
    if (index >= firstIndex) {
      Object.assign(match, calculateMatchFields(match, ratings));
    }
    applyRatingChanges(ratings, match);
  });
}

function buildMatch(teamA, teamB, scoreA, scoreB) {
  const user = getCurrentUser();
  const match = {
    id: uid(),
    teamA,
    teamB,
    scoreA,
    scoreB,
    kFactor: state.settings.kFactor,
    marginBonus: state.settings.marginBonus,
    createdBy: user?.id || null,
    createdByName: user?.displayName || "알 수 없음",
    updatedBy: null,
    updatedByName: "",
    createdAt: new Date().toISOString(),
    updatedAt: null,
  };
  return {
    ...match,
    ...calculateMatchFields(match, getCurrentRatingMap()),
  };
}

function getMarginFactor(scoreA, scoreB) {
  const maxScore = Math.max(scoreA, scoreB, 21);
  const gap = Math.abs(scoreA - scoreB);
  return Math.min(1.35, 1 + gap / (maxScore * 3));
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function validateMatch(teamA, teamB, scoreA, scoreB) {
  const ids = [...teamA, ...teamB];
  if (state.players.length < 4) {
    return "선수 4명 이상이 필요합니다.";
  }
  if (ids.some((id) => !id)) {
    return "선수 4명을 선택하세요.";
  }
  if (new Set(ids).size !== 4) {
    return "한 선수는 한 경기에서 한 번만 선택할 수 있습니다.";
  }
  if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0) {
    return "점수를 확인하세요.";
  }
  if (scoreA === scoreB) {
    return "동점 경기는 ELO에 반영할 수 없습니다.";
  }
  return "";
}

function recordMatch() {
  if (!requireLogin()) return;

  const teamA = [$("#teamA1").value, $("#teamA2").value];
  const teamB = [$("#teamB1").value, $("#teamB2").value];
  const scoreA = Number($("#scoreA").value);
  const scoreB = Number($("#scoreB").value);
  const error = validateMatch(teamA, teamB, scoreA, scoreB);

  if (error) {
    showToast(error);
    return;
  }

  state.matches.push(buildMatch(teamA, teamB, scoreA, scoreB));
  saveState();
  render();
  showToast("경기 결과를 저장했습니다.");
}

function openEditMatch(matchId) {
  if (!requireAdmin()) return;
  const match = state.matches.find((entry) => entry.id === matchId);
  if (!match) return;

  editingMatchId = match.id;
  renderEditSelects(match);
  $("#editScoreA").value = match.scoreA;
  $("#editScoreB").value = match.scoreB;
  $("#matchEditDialog").showModal();
}

function closeEditMatch() {
  editingMatchId = null;
  $("#matchEditDialog").close();
}

function saveEditedMatch() {
  if (!requireAdmin()) return;
  const matchIndex = state.matches.findIndex((entry) => entry.id === editingMatchId);
  if (matchIndex < 0) return;

  const teamA = [$("#editTeamA1").value, $("#editTeamA2").value];
  const teamB = [$("#editTeamB1").value, $("#editTeamB2").value];
  const scoreA = Number($("#editScoreA").value);
  const scoreB = Number($("#editScoreB").value);
  const error = validateMatch(teamA, teamB, scoreA, scoreB);

  if (error) {
    showToast(error);
    return;
  }

  const user = getCurrentUser();
  Object.assign(state.matches[matchIndex], {
    teamA,
    teamB,
    scoreA,
    scoreB,
    updatedBy: user.id,
    updatedByName: user.displayName,
    updatedAt: new Date().toISOString(),
  });
  recalculateMatchesFrom(matchIndex);
  saveState();
  closeEditMatch();
  render();
  showToast("경기 기록을 수정하고 이후 ELO를 다시 계산했습니다.");
}

function render() {
  const standings = getStandings();
  renderAuth();
  renderSummary(standings);
  renderSelects(standings);
  renderSettings();
  renderRankings(standings);
  renderHistory();
  renderPreview();
  renderAccess();
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function renderAuth() {
  const user = getCurrentUser();
  $("#authSignedOut").hidden = Boolean(user);
  $("#authSignedIn").hidden = !user;
  $("#adminUsers").hidden = !isAdmin();

  if (user) {
    $("#currentUserName").textContent = user.displayName;
    $("#currentRoleBadge").textContent = user.role === "admin" ? "admin" : "member";
    $("#currentUserAvatar").textContent = user.displayName.slice(0, 1).toLocaleUpperCase();
  }

  const userList = $("#userList");
  userList.innerHTML = state.users
    .map((entry) => {
      const isCurrent = entry.id === user?.id;
      const canDelete = isAdmin() && !isCurrent;
      const adminCount = state.users.filter((candidate) => candidate.role === "admin").length;
      const canToggle = isAdmin() && !(entry.role === "admin" && adminCount <= 1);
      return `
        <li class="user-row">
          <div>
            <strong>${escapeHtml(entry.displayName)}</strong>
            <span>${escapeHtml(entry.username)} · ${entry.role === "admin" ? "admin" : "member"}${isCurrent ? " · 현재" : ""}</span>
          </div>
          <div class="row-actions">
            <button class="icon-text-button" type="button" data-toggle-admin="${escapeHtml(entry.id)}" ${canToggle ? "" : "disabled"}>
              <i data-lucide="shield"></i>
              <span>${entry.role === "admin" ? "해제" : "admin"}</span>
            </button>
            <button class="icon-button" type="button" data-delete-user="${escapeHtml(entry.id)}" ${canDelete ? "" : "disabled"} aria-label="${escapeHtml(entry.displayName)} 삭제" title="삭제">
              <i data-lucide="x"></i>
              <span class="visually-hidden">삭제</span>
            </button>
          </div>
        </li>
      `;
    })
    .join("");
}

function renderSummary(standings) {
  $("#playerCount").textContent = state.players.length;
  $("#matchCount").textContent = state.matches.length;
  $("#averageRating").textContent = standings.length ? Math.round(average(standings.map((player) => player.rating))) : 0;
}

function renderSelects(standings) {
  const options = standings
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "ko-KR"))
    .map((player) => `<option value="${escapeHtml(player.id)}">${escapeHtml(player.name)} (${Math.round(player.rating)})</option>`)
    .join("");

  const ids = standings.map((player) => player.id);
  const previousValues = selectIds.map((id) => $(`#${id}`).value);
  const selectedValues = [];

  selectIds.forEach((selectId, index) => {
    let value = previousValues[index];
    if (!ids.includes(value) || selectedValues.includes(value)) {
      value = ids.find((id) => !selectedValues.includes(id)) || "";
    }
    selectedValues.push(value);

    const select = $(`#${selectId}`);
    select.innerHTML = `<option value="">선택</option>${options}`;
    select.value = value;
  });
}

function renderEditSelects(match) {
  const options = state.players
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "ko-KR"))
    .map((player) => `<option value="${escapeHtml(player.id)}">${escapeHtml(player.name)}</option>`)
    .join("");
  const values = [...match.teamA, ...match.teamB];

  editSelectIds.forEach((id, index) => {
    const select = $(`#${id}`);
    select.innerHTML = `<option value="">선택</option>${options}`;
    select.value = values[index] || "";
  });
}

function renderSettings() {
  $("#baseRating").value = state.settings.baseRating;
  $("#kFactor").value = state.settings.kFactor;
  $("#marginBonus").checked = state.settings.marginBonus;
  $("#playerRating").placeholder = String(state.settings.baseRating);
}

function renderAccess() {
  const loggedIn = Boolean(getCurrentUser());
  const admin = isAdmin();
  const canRecordMatch = loggedIn && state.players.length >= 4;

  $("#matchAuthNote").textContent = loggedIn ? `${getCurrentUser().displayName}님으로 경기 입력 중` : "로그인 후 경기 결과를 입력할 수 있습니다.";
  $("#rosterAuthNote").textContent = admin ? "admin 권한으로 선수와 설정을 관리 중" : "선수 등록과 설정 변경은 admin만 가능합니다.";

  selectIds.forEach((id) => {
    $(`#${id}`).disabled = !canRecordMatch;
  });
  $("#scoreA").disabled = !loggedIn;
  $("#scoreB").disabled = !loggedIn;
  $("#matchSubmitBtn").disabled = !canRecordMatch;
  $("#shuffleBtn").hidden = state.players.length < 4;
  $("#shuffleBtn").disabled = !canRecordMatch;

  $$("#playerForm input, #playerForm button, #baseRating, #kFactor, #marginBonus").forEach((element) => {
    element.disabled = !admin;
  });
  $("#loadDemoBtn").disabled = !admin;
  $("#emptyDemoBtn").disabled = !admin;
  $("#importBtn").disabled = !admin;
  $("#resetBtn").disabled = !admin;
}

function renderRankings(standings) {
  const body = $("#rankingBody");
  const empty = $("#rankingEmpty");
  body.innerHTML = standings
    .map((player, index) => {
      const rank = index + 1;
      const rankClass = rank <= 3 ? "rank-pill rank-pill--podium" : "rank-pill";
      const ratingClass = player.ratingDelta < 0 ? "delta delta--down" : "delta";
      const winRate = player.games ? `${Math.round(player.winRate * 100)}%` : "-";
      const pointDiff = player.pointDiff > 0 ? `+${player.pointDiff}` : String(player.pointDiff);
      const streak = formatStreak(player.streak);
      const lastPlayed = player.lastPlayed ? `최근 ${formatDate(player.lastPlayed)}` : "경기 없음";
      const deleteButton = isAdmin() && player.games === 0
        ? `<button class="icon-button" type="button" data-delete-player="${escapeHtml(player.id)}" aria-label="${escapeHtml(player.name)} 삭제" title="삭제"><i data-lucide="x"></i><span class="visually-hidden">삭제</span></button>`
        : `<span class="muted">-</span>`;

      return `
        <tr>
          <td><span class="${rankClass}">${rank}</span></td>
          <td>
            <div class="player-cell">
              <span class="avatar">${escapeHtml(player.name.slice(0, 1))}</span>
              <div class="player-meta">
                <span class="player-name">${escapeHtml(player.name)}</span>
                <span class="player-sub">${lastPlayed}</span>
              </div>
            </div>
          </td>
          <td><span class="rating-number">${player.rating.toFixed(1)}</span> <span class="${ratingClass}">${formatSigned(player.ratingDelta)}</span></td>
          <td class="record">${player.wins}승 ${player.losses}패</td>
          <td class="win-rate">${winRate}</td>
          <td class="point-diff">${pointDiff}</td>
          <td>${streak}</td>
          <td>${deleteButton}</td>
        </tr>
      `;
    })
    .join("");

  empty.classList.toggle("is-visible", standings.length === 0);
}

function formatStreak(streak) {
  if (streak > 0) {
    return `<span class="streak streak--win">${streak}연승</span>`;
  }
  if (streak < 0) {
    return `<span class="streak streak--loss">${Math.abs(streak)}연패</span>`;
  }
  return `<span class="muted">-</span>`;
}

function renderHistory() {
  const list = $("#historyList");
  const empty = $("#historyEmpty");

  list.innerHTML = state.matches
    .slice()
    .reverse()
    .map((match) => {
      const teamA = match.teamA.map(playerName).join(" / ");
      const teamB = match.teamB.map(playerName).join(" / ");
      const deltaA = match.changes.find((change) => match.teamA.includes(change.id))?.delta || 0;
      const deltaB = match.changes.find((change) => match.teamB.includes(change.id))?.delta || 0;
      const editedText = match.updatedAt ? ` · 수정 ${escapeHtml(match.updatedByName || "알 수 없음")} ${formatDate(match.updatedAt)}` : "";

      return `
        <li class="history-item">
          <time class="history-date" datetime="${escapeHtml(match.createdAt)}">${formatDate(match.createdAt)}</time>
          <div class="history-main">
            <div class="teams-line">
              <span class="team-name ${match.winner === "A" ? "team-name--winner" : ""}">${escapeHtml(teamA)}</span>
              <span class="score-badge">${match.scoreA} : ${match.scoreB}</span>
              <span class="team-name ${match.winner === "B" ? "team-name--winner" : ""}">${escapeHtml(teamB)}</span>
            </div>
            <p class="history-sub">A ${formatSigned(deltaA)} / B ${formatSigned(deltaB)} · 기대승률 ${Math.round(match.expectedA * 100)}% : ${Math.round(match.expectedB * 100)}% · 입력 ${escapeHtml(match.createdByName || "알 수 없음")}${editedText}</p>
          </div>
          ${
            isAdmin()
              ? `<button class="icon-button" type="button" data-edit-match="${escapeHtml(match.id)}" aria-label="경기 수정" title="경기 수정"><i data-lucide="pencil"></i><span class="visually-hidden">수정</span></button>`
              : `<span class="muted">-</span>`
          }
        </li>
      `;
    })
    .join("");

  empty.classList.toggle("is-visible", state.matches.length === 0);
}

function renderPreview() {
  const preview = $("#matchPreview");
  const teamA = [$("#teamA1").value, $("#teamA2").value];
  const teamB = [$("#teamB1").value, $("#teamB2").value];
  const ids = [...teamA, ...teamB];

  if (!getCurrentUser()) {
    preview.textContent = "로그인 후 경기 결과를 입력할 수 있습니다.";
    return;
  }

  if (state.players.length < 4) {
    preview.textContent = "선수 4명 이상이 필요합니다.";
    return;
  }

  if (ids.some((id) => !id) || new Set(ids).size !== 4) {
    preview.textContent = "선수 4명을 선택하세요.";
    return;
  }

  const standings = getStandings();
  const ratingById = new Map(standings.map((player) => [player.id, player.rating]));
  const ratingA = average(teamA.map((id) => ratingById.get(id)));
  const ratingB = average(teamB.map((id) => ratingById.get(id)));
  const expectedA = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
  preview.textContent = `팀 평균 ${Math.round(ratingA)} : ${Math.round(ratingB)} · A팀 기대승률 ${Math.round(expectedA * 100)}%`;
}

function shuffleTeams() {
  if (!requireLogin()) return;
  if (state.players.length < 4) {
    showToast("선수 4명 이상이 필요합니다.");
    return;
  }

  const shuffled = getStandings()
    .map((player) => player.id)
    .sort(() => Math.random() - 0.5)
    .slice(0, 4);

  selectIds.forEach((selectId, index) => {
    $(`#${selectId}`).value = shuffled[index];
  });
  renderPreview();
}

function loadDemoData() {
  if (!requireAdmin()) return;
  if ((state.players.length || state.matches.length) && !window.confirm("현재 데이터를 샘플 데이터로 바꿀까요?")) {
    return;
  }

  const players = [
    ["김서준", 1540],
    ["이도윤", 1510],
    ["박민재", 1490],
    ["최유나", 1500],
    ["정하린", 1470],
    ["한지우", 1525],
  ].map(([name, seedRating]) => ({
    id: uid(),
    name,
    seedRating,
    createdAt: new Date().toISOString(),
  }));

  state.players = players;
  state.matches = [];
  state.settings = { ...defaultSettings };

  const byName = Object.fromEntries(players.map((player) => [player.name, player.id]));
  [
    [["김서준", "이도윤"], ["박민재", "최유나"], 21, 17],
    [["정하린", "한지우"], ["김서준", "최유나"], 18, 21],
    [["이도윤", "박민재"], ["정하린", "한지우"], 22, 20],
    [["김서준", "한지우"], ["이도윤", "최유나"], 16, 21],
    [["박민재", "최유나"], ["정하린", "김서준"], 21, 14],
  ].forEach(([teamA, teamB, scoreA, scoreB]) => {
    state.matches.push(buildMatch(teamA.map((name) => byName[name]), teamB.map((name) => byName[name]), scoreA, scoreB));
  });

  saveState();
  render();
  showToast("샘플 데이터를 불러왔습니다.");
}

function exportData() {
  const payload = JSON.stringify(
    {
      players: state.players,
      matches: state.matches,
      settings: state.settings,
    },
    null,
    2,
  );
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `badminton-elo-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  showToast("랭킹 데이터를 내보냈습니다.");
}

function importData(file) {
  if (!requireAdmin() || !file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = normalizeState(JSON.parse(reader.result));
      if (!imported.players.length) {
        showToast("가져올 선수가 없습니다.");
        return;
      }
      state.players = imported.players;
      state.matches = imported.matches;
      state.settings = imported.settings;
      recalculateMatchesFrom(0);
      saveState();
      render();
      showToast("랭킹 데이터를 가져왔습니다.");
    } catch (error) {
      console.error(error);
      showToast("JSON 파일을 확인하세요.");
    }
  };
  reader.readAsText(file);
}

function resetData() {
  if (!requireAdmin()) return;
  if (!state.players.length && !state.matches.length) {
    showToast("초기화할 데이터가 없습니다.");
    return;
  }
  if (!window.confirm("모든 선수와 경기 기록을 삭제할까요?")) {
    return;
  }
  state.players = [];
  state.matches = [];
  state.settings = { ...defaultSettings };
  saveState();
  render();
  showToast("데이터를 초기화했습니다.");
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.classList.remove("is-visible");
  }, 2600);
}

function bindEvents() {
  $("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const loggedIn = await login($("#loginUsername").value, $("#loginPassword").value);
    if (loggedIn) {
      form.reset();
    }
  });

  $("#signupForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const created = await createAccount($("#signupUsername").value, $("#signupDisplayName").value, $("#signupPassword").value);
    if (created) {
      form.reset();
    }
  });

  $("#logoutBtn").addEventListener("click", logout);

  $("#playerForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const nameInput = $("#playerName");
    const ratingInput = $("#playerRating");
    const added = addPlayer(nameInput.value, ratingInput.value);
    if (added) {
      nameInput.value = "";
      ratingInput.value = "";
      nameInput.focus();
    }
  });

  $("#matchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    recordMatch();
  });

  $("#matchEditForm").addEventListener("submit", (event) => {
    event.preventDefault();
    saveEditedMatch();
  });

  $("[data-close-edit]").addEventListener("click", closeEditMatch);

  selectIds.forEach((id) => {
    $(`#${id}`).addEventListener("change", renderPreview);
  });

  $("#scoreA").addEventListener("input", renderPreview);
  $("#scoreB").addEventListener("input", renderPreview);
  $("#shuffleBtn").addEventListener("click", shuffleTeams);
  $("#loadDemoBtn").addEventListener("click", loadDemoData);
  $("#emptyDemoBtn").addEventListener("click", loadDemoData);
  $("#exportBtn").addEventListener("click", exportData);
  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", (event) => {
    importData(event.target.files[0]);
    event.target.value = "";
  });
  $("#resetBtn").addEventListener("click", resetData);

  $("#baseRating").addEventListener("change", (event) => {
    if (!requireAdmin()) {
      renderSettings();
      return;
    }
    state.settings.baseRating = clampNumber(Number(event.target.value), 800, 2400);
    saveState();
    render();
  });

  $("#kFactor").addEventListener("change", (event) => {
    if (!requireAdmin()) {
      renderSettings();
      return;
    }
    state.settings.kFactor = clampNumber(Number(event.target.value), 8, 64);
    saveState();
    render();
  });

  $("#marginBonus").addEventListener("change", (event) => {
    if (!requireAdmin()) {
      renderSettings();
      return;
    }
    state.settings.marginBonus = event.target.checked;
    saveState();
    render();
  });

  document.addEventListener("click", (event) => {
    const deleteButton = event.target.closest("[data-delete-player]");
    if (deleteButton) {
      deletePlayer(deleteButton.dataset.deletePlayer);
      return;
    }

    const editButton = event.target.closest("[data-edit-match]");
    if (editButton) {
      openEditMatch(editButton.dataset.editMatch);
      return;
    }

    const toggleButton = event.target.closest("[data-toggle-admin]");
    if (toggleButton) {
      toggleUserRole(toggleButton.dataset.toggleAdmin);
      return;
    }

    const deleteUserButton = event.target.closest("[data-delete-user]");
    if (deleteUserButton) {
      deleteUser(deleteUserButton.dataset.deleteUser);
    }
  });
}

async function init() {
  state = await loadState();
  bindEvents();
  render();
  window.badmintonEloAppReady = true;
}

init();
