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

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

const errorMessages = {
  BULK_MATCH_PARSE_ERROR: "텍스트 경기 기록을 확인하세요.",
  BULK_MATCH_TEXT_REQUIRED: "경기 기록 텍스트를 입력하세요.",
  MATCH_INVALID_DATE: "경기 일시를 확인하세요.",
  API_UNAVAILABLE: "서버 API가 연결되지 않았습니다. Render 서비스를 Static Site가 아니라 Web Service로 배포해야 합니다.",
  CANNOT_DELETE_SELF: "현재 로그인한 계정은 삭제할 수 없습니다.",
  DISPLAY_NAME_REQUIRED: "이름을 입력하세요.",
  FORBIDDEN: "admin 권한이 필요합니다.",
  IMPORT_INVALID_MATCH: "가져올 경기 기록 중 잘못된 항목이 있습니다.",
  IMPORT_NEEDS_PLAYERS: "가져올 선수 데이터가 없습니다.",
  INVALID_CREDENTIALS: "아이디 또는 비밀번호를 확인하세요.",
  INVALID_JSON: "JSON 파일을 확인하세요.",
  LAST_ADMIN: "admin 계정은 최소 1개가 필요합니다.",
  MATCH_DUPLICATE_PLAYER: "한 선수는 한 경기에서 한 번만 선택할 수 있습니다.",
  MATCH_INVALID_SCORE: "점수를 확인하세요.",
  MATCH_NEEDS_PLAYERS: "선수 4명을 선택하세요.",
  MATCH_NOT_FOUND: "경기 기록을 찾을 수 없습니다.",
  MATCH_TIE_SCORE: "동점 경기는 ELO에 반영할 수 없습니다.",
  MATCH_UNKNOWN_PLAYER: "등록되지 않은 선수가 포함되어 있습니다.",
  NOT_FOUND: "요청한 데이터를 찾을 수 없습니다.",
  PASSWORD_TOO_SHORT: "비밀번호는 4자 이상 입력하세요.",
  PLAYER_HAS_MATCHES: "경기 기록이 있는 선수는 삭제할 수 없습니다.",
  PLAYER_NAME_REQUIRED: "선수 이름을 입력하세요.",
  PLAYER_NAME_TAKEN: "이미 등록된 선수 이름입니다.",
  PLAYER_NOT_FOUND: "선수를 찾을 수 없습니다.",
  PLAYER_RATING_REQUIRED: "초기 ELO를 입력하세요.",
  REQUEST_TOO_LARGE: "파일이 너무 큽니다.",
  SERVER_ERROR: "서버 처리 중 문제가 생겼습니다.",
  UNAUTHORIZED: "로그인이 필요합니다.",
  USER_NOT_FOUND: "계정을 찾을 수 없습니다.",
  USERNAME_TAKEN: "이미 등록된 아이디입니다.",
  USERNAME_TOO_SHORT: "아이디는 3자 이상 입력하세요.",
};

function createDefaultState() {
  return {
    players: [],
    matches: [],
    users: [],
    currentUser: null,
    settings: { ...defaultSettings },
  };
}

function uid() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

function safeIsoDate(value, fallback = new Date().toISOString()) {
  const fallbackDate = new Date(fallback);
  const fallbackIso = Number.isNaN(fallbackDate.getTime()) ? new Date().toISOString() : fallbackDate.toISOString();
  const date = new Date(value || fallbackIso);
  return Number.isNaN(date.getTime()) ? fallbackIso : date.toISOString();
}

function matchPlayedAt(match) {
  return match?.playedAt || match?.createdAt || new Date().toISOString();
}

function matchOrderTime(match) {
  const date = new Date(matchPlayedAt(match));
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

function sortedMatches(matches = state.matches) {
  return [...matches].sort(compareMatchOrder);
}

function formatDateTimeLocal(isoDate = new Date().toISOString()) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) {
    return formatDateTimeLocal(new Date().toISOString());
  }
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 16);
}

function dateTimeLocalToIso(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function setDefaultMatchPlayedAt(force = false) {
  const input = $("#matchPlayedAt");
  if (input && (force || !input.value)) {
    input.value = formatDateTimeLocal();
  }
}

function normalizeUser(user) {
  if (!user || !user.id || !user.username) {
    return null;
  }
  return {
    id: String(user.id),
    username: normalizeUsername(user.username),
    displayName: String(user.displayName || user.username).trim(),
    role: user.role === "admin" ? "admin" : "member",
    playerId: user.playerId ? String(user.playerId) : null,
    playerSeedRating: user.playerSeedRating == null ? null : Number(user.playerSeedRating),
    playerStatus: user.playerStatus || "none",
    createdAt: user.createdAt || new Date().toISOString(),
  };
}

function normalizeState(input) {
  const fallback = createDefaultState();
  const players = Array.isArray(input?.players)
    ? input.players
        .filter((player) => player && player.id && player.name)
        .map((player) => ({
          id: String(player.id),
          userId: player.userId ? String(player.userId) : null,
          name: String(player.name).trim(),
          seedRating:
            player.seedRating == null && player.rating == null
              ? null
              : clampNumber(Number(player.seedRating ?? player.rating), 800, 2400),
          status: player.status === "pending" || player.seedRating == null ? "pending" : "active",
          createdAt: player.createdAt || new Date().toISOString(),
        }))
    : [];

  const activePlayerIds = new Set(players.filter((player) => player.seedRating != null).map((player) => player.id));
  const matches = Array.isArray(input?.matches)
    ? input.matches
        .filter((match) => {
          const ids = [...(match.teamA || []), ...(match.teamB || [])];
          return ids.length === 4 && ids.every((id) => activePlayerIds.has(String(id)));
        })
        .map((match) => ({
          id: String(match.id || uid()),
          sequence: Number(match.sequence || 0),
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
          marginBonus: match.marginBonus !== false,
          marginFactor: Number(match.marginFactor ?? 1),
          changes: Array.isArray(match.changes)
            ? match.changes.map((change) => ({ id: String(change.id), delta: Number(change.delta || 0) }))
            : [],
          createdBy: match.createdBy ? String(match.createdBy) : null,
          createdByName: match.createdByName ? String(match.createdByName) : "알 수 없음",
          updatedBy: match.updatedBy ? String(match.updatedBy) : null,
          updatedByName: match.updatedByName ? String(match.updatedByName) : "",
          createdAt: safeIsoDate(match.createdAt),
          playedAt: safeIsoDate(match.playedAt ?? match.played_at ?? match.matchAt ?? match.createdAt),
          updatedAt: match.updatedAt || null,
        }))
        .sort(compareMatchOrder)
    : [];

  return {
    players,
    matches,
    users: Array.isArray(input?.users) ? input.users.map(normalizeUser).filter(Boolean) : [],
    currentUser: normalizeUser(input?.currentUser),
    settings: {
      baseRating: clampNumber(Number(input?.settings?.baseRating ?? fallback.settings.baseRating), 800, 2400),
      kFactor: clampNumber(Number(input?.settings?.kFactor ?? fallback.settings.kFactor), 8, 64),
      marginBonus: input?.settings?.marginBonus !== false,
    },
  };
}

function apiMessage(error) {
  return error?.message || errorMessages[error?.code] || "요청 처리 중 문제가 생겼습니다.";
}

async function apiFetch(path, options = {}) {
  const headers = { Accept: "application/json" };
  const fetchOptions = {
    method: options.method || "GET",
    credentials: "same-origin",
    headers,
  };

  if (Object.prototype.hasOwnProperty.call(options, "body")) {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(path, fetchOptions);
  } catch {
    const error = new Error("서버에 연결할 수 없습니다.");
    error.code = "NETWORK_ERROR";
    throw error;
  }

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      const error = new Error(errorMessages.API_UNAVAILABLE);
      error.code = "API_UNAVAILABLE";
      error.status = response.status;
      throw error;
    }
  }

  if (!contentType.includes("application/json")) {
    const error = new Error(errorMessages.API_UNAVAILABLE);
    error.code = "API_UNAVAILABLE";
    error.status = response.status;
    throw error;
  }

  if (!response.ok) {
    const error = new Error(data.message || errorMessages[data.code] || "요청 처리 중 문제가 생겼습니다.");
    error.code = data.code || data.error || "REQUEST_FAILED";
    throw error;
  }

  return data;
}

function applyServerState(payload) {
  state = normalizeState(payload);
  render();
}

async function refreshState() {
  applyServerState(await apiFetch("/api/state"));
}

function showApiError(error) {
  console.error(error);
  showToast(apiMessage(error));
}

function formatSigned(value, digits = 1) {
  const rounded = Number(value).toFixed(digits);
  return value > 0 ? `+${rounded}` : rounded;
}

function formatDate(isoDate) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function getCurrentUser() {
  return state.currentUser;
}

function isAdmin() {
  return getCurrentUser()?.role === "admin";
}

function getActivePlayers(sourceState = state) {
  return sourceState.players.filter((player) => player.seedRating != null && player.status !== "pending");
}

function requireLogin() {
  if (!getCurrentUser()) {
    showToast("로그인이 필요합니다.");
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

  try {
    const payload = await apiFetch("/api/signup", {
      method: "POST",
      body: { username: normalizedUsername, displayName: cleanDisplayName, password },
    });
    applyServerState(payload);
    showToast(payload.currentUser?.role === "admin" ? "admin 계정을 만들고 로그인했습니다." : "계정을 만들고 로그인했습니다.");
    return true;
  } catch (error) {
    showApiError(error);
    return false;
  }
}

async function login(username, password) {
  try {
    const payload = await apiFetch("/api/login", {
      method: "POST",
      body: { username: normalizeUsername(username), password },
    });
    applyServerState(payload);
    showToast(`${payload.currentUser?.displayName || "사용자"}님으로 로그인했습니다.`);
    return true;
  } catch (error) {
    showApiError(error);
    return false;
  }
}

async function logout() {
  try {
    applyServerState(await apiFetch("/api/logout", { method: "POST" }));
    showToast("로그아웃했습니다.");
  } catch (error) {
    showApiError(error);
  }
}

async function toggleUserRole(userId) {
  if (!requireAdmin()) return;
  try {
    applyServerState(await apiFetch(`/api/users/${encodeURIComponent(userId)}/toggle-admin`, { method: "PATCH" }));
    showToast("계정 권한을 변경했습니다.");
  } catch (error) {
    showApiError(error);
  }
}

async function deleteUser(userId) {
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

  try {
    applyServerState(await apiFetch(`/api/users/${encodeURIComponent(userId)}`, { method: "DELETE" }));
    showToast("계정을 삭제했습니다.");
  } catch (error) {
    showApiError(error);
  }
}

function getStandings(sourceState = state) {
  const table = new Map(
    getActivePlayers(sourceState).map((player) => [
      player.id,
      {
        ...player,
        rating: player.seedRating,
        games: 0,
        wins: 0,
        losses: 0,
        streak: 0,
        streakDelta: 0,
        lastPlayed: null,
      },
    ]),
  );

  sortedMatches(sourceState.matches).forEach((match) => {
    const changeMap = new Map(match.changes.map((change) => [change.id, Number(change.delta || 0)]));

    match.changes.forEach((change) => {
      const player = table.get(change.id);
      if (player) {
        player.rating = round1(player.rating + Number(change.delta || 0));
      }
    });

    applyMatchStats(table, match.teamA, match.winner === "A", matchPlayedAt(match), changeMap);
    applyMatchStats(table, match.teamB, match.winner === "B", matchPlayedAt(match), changeMap);
  });

  return [...table.values()]
    .map((player) => ({
      ...player,
      rating: round1(player.rating),
      streakDelta: round1(player.streakDelta),
      winRate: player.games ? player.wins / player.games : 0,
    }))
    .sort((a, b) => {
      if (b.rating !== a.rating) return b.rating - a.rating;
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      if (b.games !== a.games) return b.games - a.games;
      return a.name.localeCompare(b.name, "ko-KR");
    });
}

function applyMatchStats(table, ids, won, createdAt, changeMap) {
  ids.forEach((id) => {
    const player = table.get(id);
    if (!player) return;
    const previousStreak = player.streak;
    const delta = Number(changeMap.get(id) || 0);
    player.games += 1;
    player.wins += won ? 1 : 0;
    player.losses += won ? 0 : 1;
    player.lastPlayed = createdAt;
    player.streak = won
      ? player.streak > 0 ? player.streak + 1 : 1
      : player.streak < 0 ? player.streak - 1 : -1;
    player.streakDelta = (won && previousStreak > 0) || (!won && previousStreak < 0)
      ? round1(player.streakDelta + delta)
      : round1(delta);
  });
}

function playerAccountId(player) {
  if (!isAdmin()) {
    return "";
  }

  const linkedUser = state.users.find((user) => user.playerId === player.id || user.id === player.userId);
  return linkedUser?.username || "";
}

function playerDisplayName(player) {
  if (!player) {
    return "알 수 없음";
  }
  const accountId = playerAccountId(player);
  if (!accountId) {
    return player.name;
  }

  const accountSuffix = `(${accountId})`;
  return player.name.toLocaleLowerCase().includes(accountSuffix.toLocaleLowerCase())
    ? player.name
    : `${player.name} ${accountSuffix}`;
}

function playerName(id) {
  return playerDisplayName(state.players.find((player) => player.id === id));
}

function renderPlayerName(player) {
  return `<span class="player-name">${escapeHtml(playerDisplayName(player))}</span>`;
}

async function addPlayer(name, rating) {
  if (!requireAdmin()) return false;

  const normalizedName = name.trim().replace(/\s+/g, " ");
  if (!normalizedName) {
    showToast("선수 이름을 입력하세요.");
    return false;
  }

  try {
    applyServerState(
      await apiFetch("/api/players", {
        method: "POST",
        body: { name: normalizedName, seedRating: Number(rating || state.settings.baseRating) },
      }),
    );
    showToast(`${normalizedName} 선수를 추가했습니다.`);
    return true;
  } catch (error) {
    showApiError(error);
    return false;
  }
}

async function deletePlayer(playerId) {
  if (!requireAdmin()) return;

  const standings = getStandings();
  const player = standings.find((entry) => entry.id === playerId);
  if (!player || player.games > 0) {
    showToast("경기 기록이 있는 선수는 삭제할 수 없습니다.");
    return;
  }

  try {
    applyServerState(await apiFetch(`/api/players/${encodeURIComponent(playerId)}`, { method: "DELETE" }));
    showToast("선수를 삭제했습니다.");
  } catch (error) {
    showApiError(error);
  }
}

async function updatePlayerSeedRating(playerId) {
  if (!requireAdmin()) return;

  const input = $(`[data-player-rating="${CSS.escape(playerId)}"]`);
  const seedRating = Number(input?.value);
  if (!Number.isFinite(seedRating)) {
    showToast("초기 ELO를 입력하세요.");
    return;
  }

  try {
    applyServerState(
      await apiFetch(`/api/players/${encodeURIComponent(playerId)}`, {
        method: "PATCH",
        body: { seedRating },
      }),
    );
    showToast("초기 ELO를 저장했습니다.");
  } catch (error) {
    showApiError(error);
  }
}

async function deleteMatch(matchId) {
  if (!requireAdmin()) return;
  const match = state.matches.find((entry) => entry.id === matchId);
  if (!match) return;
  if (!window.confirm("이 경기 기록을 삭제할까요? 삭제 후 이후 ELO가 다시 계산됩니다.")) {
    return;
  }

  try {
    applyServerState(await apiFetch(`/api/matches/${encodeURIComponent(matchId)}`, { method: "DELETE" }));
    showToast("경기 기록을 삭제하고 이후 ELO를 다시 계산했습니다.");
  } catch (error) {
    showApiError(error);
  }
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
  if (getActivePlayers().length < 4) {
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

async function recordMatch() {
  if (!requireLogin()) return;

  const teamA = [$("#teamA1").value, $("#teamA2").value];
  const teamB = [$("#teamB1").value, $("#teamB2").value];
  const scoreA = Number($("#scoreA").value);
  const scoreB = Number($("#scoreB").value);
  const playedAt = dateTimeLocalToIso($("#matchPlayedAt").value);
  const error = validateMatch(teamA, teamB, scoreA, scoreB);

  if (!playedAt) {
    showToast("경기 일시를 확인하세요.");
    return;
  }

  if (error) {
    showToast(error);
    return;
  }

  try {
    applyServerState(
      await apiFetch("/api/matches", {
        method: "POST",
        body: { teamA, teamB, scoreA, scoreB, playedAt },
      }),
    );
    setDefaultMatchPlayedAt(true);
    showToast("경기 결과를 저장했습니다.");
  } catch (apiError) {
    showApiError(apiError);
  }
}

function openEditMatch(matchId) {
  if (!requireAdmin()) return;
  const match = state.matches.find((entry) => entry.id === matchId);
  if (!match) return;

  editingMatchId = match.id;
  renderEditSelects(match);
  $("#editScoreA").value = match.scoreA;
  $("#editScoreB").value = match.scoreB;
  $("#editPlayedAt").value = formatDateTimeLocal(matchPlayedAt(match));
  $("#matchEditDialog").showModal();
}

function closeEditMatch() {
  editingMatchId = null;
  $("#matchEditDialog").close();
}

async function saveEditedMatch() {
  if (!requireAdmin()) return;
  const match = state.matches.find((entry) => entry.id === editingMatchId);
  if (!match) return;

  const teamA = [$("#editTeamA1").value, $("#editTeamA2").value];
  const teamB = [$("#editTeamB1").value, $("#editTeamB2").value];
  const scoreA = Number($("#editScoreA").value);
  const scoreB = Number($("#editScoreB").value);
  const playedAt = dateTimeLocalToIso($("#editPlayedAt").value);
  const error = validateMatch(teamA, teamB, scoreA, scoreB);

  if (!playedAt) {
    showToast("경기 일시를 확인하세요.");
    return;
  }

  if (error) {
    showToast(error);
    return;
  }

  try {
    closeEditMatch();
    applyServerState(
      await apiFetch(`/api/matches/${encodeURIComponent(match.id)}`, {
        method: "PUT",
        body: { teamA, teamB, scoreA, scoreB, playedAt },
      }),
    );
    showToast("경기 기록을 수정했고 이후 ELO를 다시 계산했습니다.");
  } catch (apiError) {
    showApiError(apiError);
  }
}

async function importBulkMatchesFromText() {
  if (!requireAdmin()) return;

  const textarea = $("#bulkMatchText");
  const text = textarea.value.trim();
  if (!text) {
    showToast("경기 기록 텍스트를 입력하세요.");
    textarea.focus();
    return;
  }

  try {
    const payload = await apiFetch("/api/matches/bulk-text", {
      method: "POST",
      body: { text },
    });
    const count = Number(payload.bulkInserted || 0);
    applyServerState(payload);
    textarea.value = "";
    showToast(`${count}개 경기 기록을 저장했습니다.`);
  } catch (error) {
    showApiError(error);
  }
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
      const playerInfo = entry.playerStatus === "active"
        ? `선수 ELO ${Math.round(entry.playerSeedRating)}`
        : entry.playerStatus === "pending"
          ? "선수 승인 대기"
          : "선수 없음";
      return `
        <li class="user-row">
          <div>
            <strong>${escapeHtml(entry.displayName)}</strong>
            <span>${escapeHtml(entry.username)} · ${entry.role === "admin" ? "admin" : "member"} · ${playerInfo}${isCurrent ? " · 현재" : ""}</span>
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
  $("#playerCount").textContent = getActivePlayers().length;
  $("#matchCount").textContent = state.matches.length;
  $("#averageRating").textContent = standings.length ? Math.round(average(standings.map((player) => player.rating))) : 0;
}

function renderSelects(standings) {
  const options = standings
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "ko-KR"))
    .map((player) => `<option value="${escapeHtml(player.id)}">${escapeHtml(playerDisplayName(player))} · ${Math.round(player.rating)}</option>`)
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
    .map((player) => `<option value="${escapeHtml(player.id)}">${escapeHtml(playerDisplayName(player))}</option>`)
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
  const user = getCurrentUser();
  const loggedIn = Boolean(user);
  const admin = isAdmin();
  const activePlayerCount = getActivePlayers().length;
  const canRecordMatch = loggedIn && activePlayerCount >= 4;

  $("#matchAuthNote").textContent = loggedIn ? `${user.displayName}님으로 경기 입력 중` : "로그인하면 경기 결과를 입력할 수 있습니다.";
  $("#rosterAuthNote").textContent = admin ? "admin 권한으로 선수와 설정을 관리 중" : "선수 등록과 설정 변경은 admin만 가능합니다.";

  selectIds.forEach((id) => {
    $(`#${id}`).disabled = !canRecordMatch;
  });
  $("#scoreA").disabled = !loggedIn;
  $("#scoreB").disabled = !loggedIn;
  $("#matchPlayedAt").disabled = !loggedIn;
  $("#matchSubmitBtn").disabled = !canRecordMatch;
  $("#shuffleBtn").hidden = activePlayerCount < 4;
  $("#shuffleBtn").disabled = !canRecordMatch;

  $("#playerName").disabled = false;
  $("#playerRating").disabled = false;
  $("#playerForm button").disabled = !admin;
  $$("#baseRating, #kFactor, #marginBonus").forEach((element) => {
    element.disabled = !admin;
  });
  $("#loadDemoBtn").disabled = !admin;
  $("#emptyDemoBtn").disabled = !admin;
  $("#importBtn").disabled = !admin;
  $("#resetBtn").disabled = !admin;
  $("#bulkMatchPanel").hidden = !admin;
  $("#bulkMatchText").disabled = !admin;
  $("#bulkMatchSubmitBtn").disabled = !admin;
}

function renderRankings(standings) {
  const body = $("#rankingBody");
  const empty = $("#rankingEmpty");
  const activeRows = standings.map((player, index) => {
      const rank = index + 1;
      const rankClass = rank <= 3 ? "rank-pill rank-pill--podium" : "rank-pill";
      const winRate = player.games ? `${Math.round(player.winRate * 100)}%` : "-";
      const streak = formatStreak(player.streak, player.streakDelta);
      const lastPlayed = player.lastPlayed ? `최근 ${formatDate(player.lastPlayed)}` : "경기 없음";
      const seedRating = isAdmin()
        ? `<span class="seed-rating-note">초기 ${Math.round(player.seedRating)}</span>`
        : "";
      const actions = isAdmin() && player.games === 0
        ? `
          <div class="row-actions roster-actions">
            <input class="inline-rating-input" data-player-rating="${escapeHtml(player.id)}" inputmode="numeric" min="800" max="2400" type="number" value="${Math.round(player.seedRating)}" aria-label="${escapeHtml(player.name)} 초기 ELO">
            <button class="icon-button" type="button" data-update-rating="${escapeHtml(player.id)}" aria-label="${escapeHtml(player.name)} 초기 ELO 저장" title="초기 ELO 저장"><i data-lucide="save"></i><span class="visually-hidden">저장</span></button>
            <button class="icon-button" type="button" data-delete-player="${escapeHtml(player.id)}" aria-label="${escapeHtml(player.name)} 삭제" title="삭제"><i data-lucide="x"></i><span class="visually-hidden">삭제</span></button>
          </div>
        `
        : `<span class="muted">-</span>`;

      return `
        <tr>
          <td><span class="${rankClass}">${rank}</span></td>
          <td>
            <div class="player-cell">
              <span class="avatar">${escapeHtml(player.name.slice(0, 1))}</span>
              <div class="player-meta">
                ${renderPlayerName(player)}
                <span class="player-sub">${lastPlayed}</span>
              </div>
            </div>
          </td>
          <td>
            <div class="rating-cell">
              <span class="rating-line"><span class="rating-number">${player.rating.toFixed(1)}</span> ${streak}</span>
              ${seedRating}
            </div>
          </td>
          <td class="record">${player.wins}승 ${player.losses}패</td>
          <td class="win-rate">${winRate}</td>
          <td>${actions}</td>
        </tr>
      `;
    });

  const pendingRows = isAdmin()
    ? state.players
        .filter((player) => player.seedRating == null || player.status === "pending")
        .map((player) => `
          <tr class="pending-player-row">
            <td><span class="rank-pill">-</span></td>
            <td>
              <div class="player-cell">
                <span class="avatar">${escapeHtml(player.name.slice(0, 1))}</span>
                <div class="player-meta">
                  ${renderPlayerName(player)}
                  <span class="player-sub">승인 대기</span>
                </div>
              </div>
            </td>
            <td>
              <div class="rating-cell">
                <span class="muted">초기 ELO 필요</span>
              </div>
            </td>
            <td class="record">-</td>
            <td class="win-rate">-</td>
            <td>
              <div class="row-actions roster-actions">
                <input class="inline-rating-input" data-player-rating="${escapeHtml(player.id)}" inputmode="numeric" min="800" max="2400" placeholder="${state.settings.baseRating}" type="number" aria-label="${escapeHtml(player.name)} 초기 ELO">
                <button class="icon-button" type="button" data-update-rating="${escapeHtml(player.id)}" aria-label="${escapeHtml(player.name)} 초기 ELO 저장" title="초기 ELO 저장"><i data-lucide="save"></i><span class="visually-hidden">저장</span></button>
                <button class="icon-button" type="button" data-delete-player="${escapeHtml(player.id)}" aria-label="${escapeHtml(player.name)} 삭제" title="삭제"><i data-lucide="x"></i><span class="visually-hidden">삭제</span></button>
              </div>
            </td>
          </tr>
        `)
    : [];

  body.innerHTML = [...activeRows, ...pendingRows].join("");

  empty.classList.toggle("is-visible", standings.length + pendingRows.length === 0);
}

function formatStreak(streak, streakDelta = 0) {
  const delta = `<span class="streak-delta">${formatSigned(streakDelta)} ELO</span>`;
  if (streak > 0) {
    return `<span class="streak streak--win">${streak}연승 ${delta}</span>`;
  }
  if (streak < 0) {
    return `<span class="streak streak--loss">${Math.abs(streak)}연패 ${delta}</span>`;
  }
  return `<span class="muted">-</span>`;
}

function renderHistory() {
  const list = $("#historyList");
  const empty = $("#historyEmpty");

  list.innerHTML = sortedMatches()
    .reverse()
    .map((match) => {
      const teamA = match.teamA.map(playerName).join(" / ");
      const teamB = match.teamB.map(playerName).join(" / ");
      const deltaA = match.changes.find((change) => match.teamA.includes(change.id))?.delta || 0;
      const deltaB = match.changes.find((change) => match.teamB.includes(change.id))?.delta || 0;
      const editedText = match.updatedAt ? ` · 수정 ${escapeHtml(match.updatedByName || "알 수 없음")} ${formatDate(match.updatedAt)}` : "";

      return `
        <li class="history-item">
          <time class="history-date" datetime="${escapeHtml(matchPlayedAt(match))}">${formatDate(matchPlayedAt(match))}</time>
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
              ? `
                <div class="row-actions">
                  <button class="icon-button" type="button" data-edit-match="${escapeHtml(match.id)}" aria-label="경기 수정" title="경기 수정"><i data-lucide="pencil"></i><span class="visually-hidden">수정</span></button>
                  <button class="icon-button" type="button" data-delete-match="${escapeHtml(match.id)}" aria-label="경기 삭제" title="경기 삭제"><i data-lucide="trash-2"></i><span class="visually-hidden">삭제</span></button>
                </div>
              `
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
    preview.textContent = "로그인하면 경기 결과를 입력할 수 있습니다.";
    return;
  }

  if (getActivePlayers().length < 4) {
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
  preview.textContent = `A팀 평균 ${Math.round(ratingA)} : ${Math.round(ratingB)} · A팀 기대승률 ${Math.round(expectedA * 100)}%`;
}

function shuffleTeams() {
  if (!requireLogin()) return;
  if (getActivePlayers().length < 4) {
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

async function importSnapshot(snapshot, successMessage) {
  try {
    applyServerState(
      await apiFetch("/api/import", {
        method: "POST",
        body: snapshot,
      }),
    );
    showToast(successMessage);
    return true;
  } catch (error) {
    showApiError(error);
    return false;
  }
}

async function loadDemoData() {
  if (!requireAdmin()) return;
  if ((state.players.length || state.matches.length) && !window.confirm("현재 데이터를 샘플 데이터로 바꿀까요?")) {
    return;
  }

  const createdAt = new Date().toISOString();
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
    createdAt,
  }));

  const byName = Object.fromEntries(players.map((player) => [player.name, player.id]));
  const matches = [
    [["김서준", "이도윤"], ["박민재", "최유나"], 21, 17],
    [["정하린", "한지우"], ["김서준", "최유나"], 18, 21],
    [["이도윤", "박민재"], ["정하린", "한지우"], 22, 20],
    [["김서준", "한지우"], ["이도윤", "최유나"], 16, 21],
    [["박민재", "최유나"], ["정하린", "김서준"], 21, 14],
  ].map(([teamA, teamB, scoreA, scoreB], index) => ({
    id: uid(),
    teamA: teamA.map((name) => byName[name]),
    teamB: teamB.map((name) => byName[name]),
    scoreA,
    scoreB,
    createdBy: getCurrentUser().id,
    createdByName: getCurrentUser().displayName,
    playedAt: new Date(Date.now() - (5 - index) * 3600 * 1000).toISOString(),
    createdAt: new Date(Date.now() - (5 - index) * 3600 * 1000).toISOString(),
  }));

  await importSnapshot({ players, matches, settings: defaultSettings }, "샘플 데이터를 불러왔습니다.");
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
  reader.onload = async () => {
    try {
      const imported = JSON.parse(reader.result);
      await importSnapshot(imported, "랭킹 데이터를 가져왔습니다.");
    } catch (error) {
      console.error(error);
      showToast("JSON 파일을 확인하세요.");
    }
  };
  reader.readAsText(file);
}

async function resetData() {
  if (!requireAdmin()) return;
  if (!state.players.length && !state.matches.length) {
    showToast("초기화할 데이터가 없습니다.");
    return;
  }
  if (!window.confirm("모든 선수와 경기 기록을 삭제할까요?")) {
    return;
  }

  try {
    applyServerState(await apiFetch("/api/reset", { method: "POST" }));
    showToast("데이터를 초기화했습니다.");
  } catch (error) {
    showApiError(error);
  }
}

async function updateSettings(patch) {
  if (!requireAdmin()) {
    renderSettings();
    return;
  }

  try {
    applyServerState(
      await apiFetch("/api/settings", {
        method: "PATCH",
        body: patch,
      }),
    );
    showToast("설정을 저장했습니다.");
  } catch (error) {
    showApiError(error);
    refreshState().catch(showApiError);
  }
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

  $("#playerForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const nameInput = $("#playerName");
    const ratingInput = $("#playerRating");
    const added = await addPlayer(nameInput.value, ratingInput.value);
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

  $("#bulkMatchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    importBulkMatchesFromText();
  });

  $$("[data-close-edit]").forEach((button) => {
    button.addEventListener("click", closeEditMatch);
  });

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
    updateSettings({ baseRating: clampNumber(Number(event.target.value), 800, 2400) });
  });

  $("#kFactor").addEventListener("change", (event) => {
    updateSettings({ kFactor: clampNumber(Number(event.target.value), 8, 64) });
  });

  $("#marginBonus").addEventListener("change", (event) => {
    updateSettings({ marginBonus: event.target.checked });
  });

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const deleteButton = target.closest("[data-delete-player]");
    if (deleteButton) {
      deletePlayer(deleteButton.dataset.deletePlayer);
      return;
    }

    const updateRatingButton = target.closest("[data-update-rating]");
    if (updateRatingButton) {
      updatePlayerSeedRating(updateRatingButton.dataset.updateRating);
      return;
    }

    const editButton = target.closest("[data-edit-match]");
    if (editButton) {
      openEditMatch(editButton.dataset.editMatch);
      return;
    }

    const deleteMatchButton = target.closest("[data-delete-match]");
    if (deleteMatchButton) {
      deleteMatch(deleteMatchButton.dataset.deleteMatch);
      return;
    }

    const toggleButton = target.closest("[data-toggle-admin]");
    if (toggleButton) {
      toggleUserRole(toggleButton.dataset.toggleAdmin);
      return;
    }

    const deleteUserButton = target.closest("[data-delete-user]");
    if (deleteUserButton) {
      deleteUser(deleteUserButton.dataset.deleteUser);
    }
  });
}

async function init() {
  bindEvents();
  setDefaultMatchPlayedAt(true);
  render();
  try {
    await refreshState();
  } catch (error) {
    showApiError(error);
  } finally {
    window.badmintonEloAppReady = true;
  }
}

init();
