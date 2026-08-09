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
let activePlayerPickerSelect = null;

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

const errorMessages = {
  BULK_MATCH_PARSE_ERROR: "텍스트 경기 기록을 확인하세요.",
  BULK_MATCH_TEXT_REQUIRED: "경기 기록 텍스트를 입력하세요.",
  MATCH_INVALID_DATE: "경기 일시를 확인하세요.",
  API_UNAVAILABLE: "서버 API가 연결되지 않았습니다. Render 서비스를 Static Site가 아니라 Web Service로 배포해야 합니다.",
  ADMIN_ROLE_LOCKED: "admin 계정은 admin 해제 후 manager로 변경하세요.",
  CANNOT_DELETE_SELF: "현재 로그인한 계정은 삭제할 수 없습니다.",
  DISPLAY_NAME_REQUIRED: "이름을 입력하세요.",
  FORBIDDEN: "admin 권한이 필요합니다.",
  IMPORT_INVALID_MATCH: "가져올 경기 기록 중 잘못된 항목이 있습니다.",
  IMPORT_NEEDS_PLAYERS: "가져올 선수 데이터가 없습니다.",
  INVALID_CREDENTIALS: "아이디 또는 비밀번호를 확인하세요.",
  INVALID_JSON: "JSON 파일을 확인하세요.",
  LAST_ADMIN: "admin 계정은 최소 1개가 필요합니다.",
  MATCH_DUPLICATE_PLAYER: "한 선수는 한 경기에서 한 번만 선택할 수 있습니다.",
  MATCH_EDIT_FORBIDDEN: "이 경기 기록은 입력자 또는 admin만 수정할 수 있습니다.",
  MATCH_INVALID_SCORE: "점수를 확인하세요.",
  MATCH_NEEDS_PLAYERS: "선수 4명을 선택하세요.",
  MATCH_NOT_FOUND: "경기 기록을 찾을 수 없습니다.",
  MATCH_TIE_SCORE: "동점 경기는 ELO에 반영할 수 없습니다.",
  MATCH_UNKNOWN_PLAYER: "등록되지 않은 선수가 포함되어 있습니다.",
  NOT_FOUND: "요청한 데이터를 찾을 수 없습니다.",
  PASSWORD_TOO_SHORT: "비밀번호는 4자 이상 입력하세요.",
  PLAYER_ALREADY_LINKED: "이미 다른 계정과 연결된 선수입니다.",
  PLAYER_HAS_MATCHES: "경기 기록이 있는 선수는 삭제할 수 없습니다.",
  PLAYER_NAME_REQUIRED: "선수 이름을 입력하세요.",
  PLAYER_NAME_TAKEN: "이미 등록된 선수 이름입니다.",
  PLAYER_NOT_FOUND: "선수를 찾을 수 없습니다.",
  PLAYER_REGISTER_FORBIDDEN: "manager 또는 admin 권한이 필요합니다.",
  PLAYER_RATING_REQUIRED: "초기 ELO를 입력하세요.",
  QUEUE_PLAYER_REQUIRED: "대기열에 추가할 선수를 선택하세요.",
  QUEUE_UNKNOWN_PLAYER: "등록된 선수를 선택하세요.",
  REQUEST_TOO_LARGE: "파일이 너무 큽니다.",
  SERVER_ERROR: "서버 처리 중 문제가 생겼습니다.",
  UNAUTHORIZED: "로그인이 필요합니다.",
  USER_NOT_FOUND: "계정을 찾을 수 없습니다.",
  USER_PLAYER_REQUIRED: "연결할 선수를 선택하세요.",
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
    visitorStats: { today: 0, total: 0 },
    queuePlayerIds: [],
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

function normalizeRole(value) {
  return ["admin", "manager", "member"].includes(value) ? value : "member";
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
    role: normalizeRole(user.role),
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
          accountUsername: normalizeUsername(player.accountUsername || player.account_username || ""),
          accountRole: player.accountRole || player.account_role ? normalizeRole(player.accountRole || player.account_role) : "",
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
    visitorStats: {
      today: Math.max(0, Math.floor(Number(input?.visitorStats?.today) || 0)),
      total: Math.max(0, Math.floor(Number(input?.visitorStats?.total) || 0)),
    },
    queuePlayerIds: Array.isArray(input?.queuePlayerIds)
      ? [...new Set(input.queuePlayerIds.map(String))].filter((id) => activePlayerIds.has(id))
      : [],
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

function isManager() {
  return getCurrentUser()?.role === "manager";
}

function canRegisterPlayers() {
  const role = getCurrentUser()?.role;
  return role === "admin" || role === "manager";
}

function currentUserPlayer(players = state.players) {
  const currentUser = getCurrentUser();
  if (!currentUser) {
    return null;
  }
  return players.find((player) => player.id === currentUser.playerId || player.userId === currentUser.id) || null;
}

function roleLabel(role) {
  return role === "admin" ? "admin" : role === "manager" ? "manager" : "member";
}

function getActivePlayers(sourceState = state) {
  return sourceState.players.filter((player) => player.seedRating != null && player.status !== "pending");
}

function queuedPlayerIdSet() {
  return new Set(state.queuePlayerIds);
}

function queuePlayers() {
  const queueIds = queuedPlayerIdSet();
  return getActivePlayers()
    .filter((player) => queueIds.has(player.id))
    .sort((a, b) => playerDisplayName(a).localeCompare(playerDisplayName(b), "ko-KR"));
}

function availableQueuePlayers() {
  const queueIds = queuedPlayerIdSet();
  return getActivePlayers()
    .filter((player) => !queueIds.has(player.id))
    .sort((a, b) => playerDisplayName(a).localeCompare(playerDisplayName(b), "ko-KR"));
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

function requirePlayerRegistrar() {
  if (!canRegisterPlayers()) {
    showToast("manager 또는 admin 권한이 필요합니다.");
    return false;
  }
  return true;
}

function canEditMatch(match) {
  const currentUser = getCurrentUser();
  return Boolean(currentUser && match && (isAdmin() || match.createdBy === currentUser.id));
}

function requireMatchEditor(match) {
  if (!getCurrentUser()) {
    showToast("로그인이 필요합니다.");
    return false;
  }
  if (!canEditMatch(match)) {
    showToast("이 경기 기록은 입력자 또는 admin만 수정할 수 있습니다.");
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

async function toggleManagerRole(userId) {
  if (!requireAdmin()) return;
  try {
    applyServerState(await apiFetch(`/api/users/${encodeURIComponent(userId)}/toggle-manager`, { method: "PATCH" }));
    showToast("manager 권한을 변경했습니다.");
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

function linkablePlayersForUser(user) {
  return state.players
    .filter((player) => player.seedRating != null && player.status !== "pending" && (!player.userId || player.userId === user.id))
    .sort((a, b) => playerDisplayName(a).localeCompare(playerDisplayName(b), "ko-KR"));
}

function renderUserPlayerLink(entry) {
  const options = linkablePlayersForUser(entry);
  const selectedPlayerId = entry.playerStatus === "active" ? entry.playerId : "";
  const hasOptions = options.length > 0;
  const optionHtml = hasOptions
    ? [
        `<option value="">기존 선수 선택</option>`,
        ...options.map((player) => (
          `<option value="${escapeHtml(player.id)}" ${player.id === selectedPlayerId ? "selected" : ""}>${escapeHtml(playerDisplayName(player))}</option>`
        )),
      ].join("")
    : `<option value="">연결 가능한 선수 없음</option>`;

  return `
    <div class="user-player-link">
      <select class="user-player-select" data-user-player="${escapeHtml(entry.id)}" ${hasOptions ? "" : "disabled"}>
        ${optionHtml}
      </select>
      <button class="icon-button" type="button" data-link-user-player="${escapeHtml(entry.id)}" ${hasOptions ? "" : "disabled"} aria-label="${escapeHtml(entry.displayName)} 선수 연결" title="선수 연결">
        <i data-lucide="link"></i>
        <span class="visually-hidden">연결</span>
      </button>
    </div>
  `;
}

async function linkUserPlayer(userId) {
  if (!requireAdmin()) return;

  const select = $(`[data-user-player="${CSS.escape(userId)}"]`);
  const playerId = select?.value || "";
  if (!playerId) {
    showToast("연결할 선수를 선택하세요.");
    select?.focus();
    return;
  }

  try {
    applyServerState(
      await apiFetch(`/api/users/${encodeURIComponent(userId)}/player`, {
        method: "PATCH",
        body: { playerId },
      }),
    );
    showToast("계정과 선수를 연결했습니다.");
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
  if (player?.accountUsername) {
    return player.accountUsername;
  }
  const linkedUser = state.users.find((user) => user.playerId === player.id || user.id === player.userId);
  return linkedUser?.username || "";
}

function playerAccountRole(player) {
  if (player?.accountRole) {
    return player.accountRole;
  }
  const linkedUser = state.users.find((user) => user.playerId === player.id || user.id === player.userId);
  return linkedUser?.role || "";
}

function playerDisplayName(player, options = {}) {
  if (!player) {
    return "알 수 없음";
  }
  const accountId = playerAccountId(player);
  if (!accountId) {
    return player.name;
  }

  const accountSuffix = `(${accountId})`;
  const displayName = player.name.toLocaleLowerCase().includes(accountSuffix.toLocaleLowerCase())
    ? player.name
    : `${player.name} ${accountSuffix}`;
  return options.managerBadge && playerAccountRole(player) === "manager" ? `${displayName} ⭐` : displayName;
}

const playerAssetProfiles = [
  {
    identity: "cheol-ryu",
    accountIds: ["rcheol", "cheol.ryu"],
    nameIncludes: ["류철"],
    photo: "./assets/player-photos/cheol-ryu.png",
    cardTiers: ["s", "a", "b", "c"],
  },
  {
    identity: "jiyeong-baek",
    accountIds: ["ji0.baek", "jiyeong.baek"],
    nameIncludes: ["백지영"],
    photo: "./assets/player-photos/jiyeong-baek.jpg",
    cardTiers: ["s", "a", "b", "c"],
  },
  {
    identity: "sangjun-park",
    accountIds: ["sj-_-.park", "sangjun.park"],
    nameIncludes: ["박상준"],
    photo: "./assets/player-photos/sangjun-park.jpg",
    cardTiers: ["s", "a", "b", "c"],
  },
  {
    identity: "hoseok-jung",
    accountIds: ["hoseok5.jung", "hoseok.jung"],
    nameIncludes: ["정호석"],
    photo: "./assets/player-photos/hoseok-jung.jpg",
    cardTiers: ["s", "a", "b", "c"],
  },
  {
    identity: "eungi-hong",
    accountIds: ["eungi89.hong", "eungi.hong"],
    nameIncludes: ["홍은기"],
    photo: "./assets/player-photos/eungi-hong.jpg",
    cardTiers: ["s", "a", "b", "c"],
  },
  {
    identity: "yeongseon-byun",
    accountIds: ["yes.byun", "yeongseon.byun"],
    nameIncludes: ["변영선"],
    photo: "./assets/player-photos/yeongseon-byun.jpg",
    cardTiers: ["a", "b", "c"],
  },
  {
    identity: "h-hyun",
    accountIds: ["h.hyun"],
    nameIncludes: ["현현영"],
    photo: "./assets/player-photos/h-hyun.jpg",
    cardTiers: ["c"],
  },
  {
    identity: "hyungjin-son",
    accountIds: ["hyungjin.son"],
    nameIncludes: ["손형진"],
    photo: "./assets/player-photos/hyungjin-son.jpg",
    cardTiers: ["a", "b"],
  },
  {
    identity: "jh723-paek",
    accountIds: ["jh723.paek"],
    nameIncludes: ["박정훈"],
    photo: "./assets/player-photos/jh723-paek.jpg",
    cardTiers: ["a", "b"],
  },
  {
    identity: "kkook-kang",
    accountIds: ["kkook.kang"],
    nameIncludes: ["강경국"],
    photo: "./assets/player-photos/kkook-kang.jpg",
    cardTiers: ["s"],
  },
  {
    identity: "seokki-hong",
    accountIds: ["seokki.hong"],
    nameIncludes: ["홍석기"],
    photo: "./assets/player-photos/seokki-hong.jpg",
    cardTiers: ["a", "b"],
  },
  {
    identity: "sooyeon-jin",
    accountIds: ["sooyeon.jin"],
    nameIncludes: ["진수연"],
    photo: "./assets/player-photos/sooyeon-jin.jpg",
    cardTiers: ["b", "c"],
  },
  {
    identity: "suyeon-lee",
    accountIds: ["suyeon.lee", "suyeon6.lee"],
    nameIncludes: ["이수연"],
    photo: "./assets/player-photos/suyeon-lee.jpg",
    cardTiers: ["b", "c"],
  },
  {
    identity: "yh5626-lee",
    accountIds: ["yh5626.lee"],
    nameIncludes: ["이영현"],
    photo: "./assets/player-photos/yh5626-lee.jpg",
    cardTiers: ["a", "b"],
  },
];

function playerCardProfile(player) {
  const accountId = playerAccountId(player);
  if (!player || !accountId) {
    return null;
  }

  const normalizedAccountId = normalizeUsername(accountId);
  const normalizedName = String(player.name || "").toLocaleLowerCase();
  return playerAssetProfiles.find((profile) => (
    profile.accountIds.includes(normalizedAccountId)
    || profile.nameIncludes.some((name) => normalizedName.includes(name.toLocaleLowerCase()))
  )) || null;
}

function playerCardIdentity(player) {
  return playerCardProfile(player)?.identity || "";
}

function playerPhotoUrl(player) {
  return playerCardProfile(player)?.photo || "";
}

function playerCardTier(player) {
  const rating = Number(player?.rating ?? player?.seedRating);
  if (!Number.isFinite(rating)) {
    return {
      key: "unranked",
      label: "등록 대기",
      art: "./assets/player-cards/c-bronze.jpg",
    };
  }
  if (rating >= 1700) {
    return { key: "s", label: "S CLASS", art: "./assets/player-cards/s-hologram.jpg" };
  }
  if (rating >= 1500) {
    return { key: "a", label: "A CLASS", art: "./assets/player-cards/a-gold.jpg" };
  }
  if (rating >= 1300) {
    return { key: "b", label: "B CLASS", art: "./assets/player-cards/b-silver.jpg" };
  }
  return { key: "c", label: "C CLASS", art: "./assets/player-cards/c-bronze.jpg" };
}

function playerCardArtUrl(player, tier) {
  const profile = playerCardProfile(player);
  if (!profile) {
    return tier.art;
  }

  const cardTier = tier.key === "unranked" ? "c" : tier.key;
  if (!profile.cardTiers.includes(cardTier)) {
    return tier.art;
  }

  const cardFinish = {
    s: "hologram",
    a: "gold",
    b: "silver",
    c: "bronze",
  }[cardTier];
  return `./assets/player-cards/${profile.identity}-${cardTier}-${cardFinish}.jpg`;
}

function playerName(id) {
  return playerDisplayName(state.players.find((player) => player.id === id));
}

function focusedRankingPlayerId(standings) {
  const ownPlayer = currentUserPlayer(standings);
  return ownPlayer?.id || standings[0]?.id || "";
}

function scrollRankingToFocus(playerId) {
  const wrap = $(".rankings-board .table-wrap");
  if (!wrap) {
    return;
  }
  if (!playerId) {
    wrap.scrollTop = 0;
    return;
  }

  window.requestAnimationFrame(() => {
    const row = $(`[data-ranking-player="${CSS.escape(playerId)}"]`, wrap);
    if (!row) {
      wrap.scrollTop = 0;
      return;
    }

    const targetTop = row.offsetTop - wrap.clientHeight / 2 + row.clientHeight / 2;
    wrap.scrollTo({ top: Math.max(0, targetTop), behavior: "auto" });
  });
}

function renderPlayerName(player, options = {}) {
  return `<span class="player-name">${escapeHtml(playerDisplayName(player, options))}</span>`;
}

function renderPlayerAvatar(player) {
  const photoUrl = playerPhotoUrl(player);
  if (photoUrl) {
    return `<img class="avatar avatar--photo" src="${escapeHtml(photoUrl)}" alt="${escapeHtml(playerDisplayName(player))} 사진" loading="lazy" decoding="async">`;
  }
  return `<span class="avatar">${escapeHtml(player?.name?.slice(0, 1) || "?")}</span>`;
}

async function addPlayer(name, rating) {
  if (!requirePlayerRegistrar()) return false;

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

async function saveQueue(playerIds) {
  if (!requireLogin()) return false;

  try {
    applyServerState(
      await apiFetch("/api/queue", {
        method: "PUT",
        body: { playerIds },
      }),
    );
    return true;
  } catch (error) {
    showApiError(error);
    return false;
  }
}

async function addQueuePlayer(playerId) {
  if (!playerId) {
    showToast("대기열에 추가할 선수를 선택하세요.");
    return;
  }
  const nextIds = [...state.queuePlayerIds, playerId];
  const saved = await saveQueue(nextIds);
  if (saved) {
    showToast("대기열에 추가했습니다.");
  }
}

async function removeQueuePlayer(playerId) {
  const saved = await saveQueue(state.queuePlayerIds.filter((id) => id !== playerId));
  if (saved) {
    showToast("대기열에서 제거했습니다.");
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
  const match = state.matches.find((entry) => entry.id === matchId);
  if (!match) return;
  if (!requireMatchEditor(match)) return;

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
  const match = state.matches.find((entry) => entry.id === editingMatchId);
  if (!match) return;
  if (!requireMatchEditor(match)) return;

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
  renderAuth(standings);
  renderSummary(standings);
  renderSelects(standings);
  renderSettings();
  renderQueue();
  renderRankings(standings);
  renderMyHistory();
  renderPartnerStats();
  renderHistory();
  renderPreview();
  renderAccess();
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function renderAuth(standings) {
  const user = getCurrentUser();
  $("#authSignedOut").hidden = Boolean(user);
  $("#authSignedIn").hidden = !user;
  $("#adminUsers").hidden = !isAdmin();

  if (user) {
    const player = currentUserPlayer(standings) || currentUserPlayer();
    const tier = playerCardTier(player);
    const rank = player ? standings.findIndex((entry) => entry.id === player.id) + 1 : 0;
    const card = $("#currentPlayerCard");
    const cardArt = $("#currentPlayerCardArt");

    card.className = `player-card player-card--${tier.key}`;
    cardArt.src = playerCardArtUrl(player, tier);
    cardArt.alt = `${tier.label} 배드민턴 선수 카드 아트`;
    $("#currentPlayerCardTier").textContent = tier.label;
    $("#currentUserName").textContent = player?.name || user.displayName;
    $("#currentUserHandle").textContent = `@${user.username}`;
    $("#currentRoleBadge").textContent = roleLabel(user.role);
    $("#currentPlayerCardRating").textContent = player ? Math.round(player.rating).toLocaleString("ko-KR") : "--";
    $("#currentPlayerCardRank").textContent = rank ? `#${rank}` : "--";
  }

  const userList = $("#userList");
  userList.innerHTML = state.users
    .map((entry) => {
      const isCurrent = entry.id === user?.id;
      const canDelete = isAdmin() && !isCurrent;
      const adminCount = state.users.filter((candidate) => candidate.role === "admin").length;
      const canToggle = isAdmin() && !(entry.role === "admin" && adminCount <= 1);
      const canToggleManager = isAdmin() && entry.role !== "admin";
      const playerInfo = entry.playerStatus === "active"
        ? `선수 ELO ${Math.round(entry.playerSeedRating)}`
        : entry.playerStatus === "pending"
          ? "선수 승인 대기"
          : "선수 없음";
      return `
        <li class="user-row">
          <div class="user-row-main">
            <strong>${escapeHtml(entry.displayName)}</strong>
            <span>${escapeHtml(entry.username)} · ${roleLabel(entry.role)} · ${playerInfo}${isCurrent ? " · 현재" : ""}</span>
          </div>
          ${renderUserPlayerLink(entry)}
          <div class="row-actions">
            <button class="icon-text-button" type="button" data-toggle-admin="${escapeHtml(entry.id)}" ${canToggle ? "" : "disabled"}>
              <i data-lucide="shield"></i>
              <span>${entry.role === "admin" ? "해제" : "admin"}</span>
            </button>
            <button class="icon-text-button" type="button" data-toggle-manager="${escapeHtml(entry.id)}" ${canToggleManager ? "" : "disabled"}>
              <i data-lucide="compass"></i>
              <span>${entry.role === "manager" ? "member" : "manager"}</span>
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
  $("#todayVisitorCount").textContent = state.visitorStats.today.toLocaleString("ko-KR");
  $("#totalVisitorCount").textContent = state.visitorStats.total.toLocaleString("ko-KR");
}

function renderSelects(standings) {
  closePlayerPicker();

  const queueIds = queuedPlayerIdSet();
  const queuedPlayers = standings
    .filter((player) => queueIds.has(player.id))
    .sort((a, b) => playerDisplayName(a).localeCompare(playerDisplayName(b), "ko-KR"));
  const regularPlayers = standings
    .filter((player) => !queueIds.has(player.id))
    .sort((a, b) => playerDisplayName(a).localeCompare(playerDisplayName(b), "ko-KR"));
  const orderedPlayers = [...queuedPlayers, ...regularPlayers];
  const optionForPlayer = (player) =>
    `<option value="${escapeHtml(player.id)}">${escapeHtml(playerDisplayName(player))} · ${Math.round(player.rating)}</option>`;
  const queueOptions = queuedPlayers.map(optionForPlayer).join("");
  const regularOptions = regularPlayers.map(optionForPlayer).join("");
  const groupedOptions = [
    queueOptions ? `<optgroup label="대기열">${queueOptions}</optgroup>` : "",
    queueOptions && regularOptions ? `<option value="" disabled>────────── 선수명단 ──────────</option>` : "",
    regularOptions ? `<optgroup label="선수명단">${regularOptions}</optgroup>` : "",
  ].join("");

  const options = groupedOptions || orderedPlayers
    .map((player) => `<option value="${escapeHtml(player.id)}">${escapeHtml(playerDisplayName(player))} · ${Math.round(player.rating)}</option>`)
    .join("");

  const ids = orderedPlayers.map((player) => player.id);
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

function playerPickerMenu() {
  let menu = $("#playerPickerMenu");
  if (!menu) {
    menu = document.createElement("div");
    menu.id = "playerPickerMenu";
    menu.className = "player-picker-menu";
    menu.hidden = true;
    document.body.append(menu);
  }
  return menu;
}

function selectedPlayerPickerButton(menu) {
  return $(".player-picker-menu__option.is-selected", menu);
}

function focusPlayerPickerButton(button) {
  if (!button) return;
  $$(".player-picker-menu__option.is-active").forEach((item) => item.classList.remove("is-active"));
  button.classList.add("is-active");
  button.focus({ preventScroll: true });
  button.scrollIntoView({ block: "nearest" });
}

function closePlayerPicker() {
  const menu = $("#playerPickerMenu");
  if (activePlayerPickerSelect) {
    activePlayerPickerSelect.classList.remove("is-player-picker-open");
  }
  activePlayerPickerSelect = null;
  if (menu) {
    menu.hidden = true;
    menu.innerHTML = "";
  }
}

function positionPlayerPicker(menu, select) {
  const rect = select.getBoundingClientRect();
  const gap = 6;
  const edge = 8;
  const below = window.innerHeight - rect.bottom - gap - edge;
  const above = rect.top - gap - edge;
  const openAbove = below < 220 && above > below;
  const maxHeight = Math.max(180, Math.min(330, openAbove ? above : below));
  const width = Math.max(240, rect.width);
  const left = Math.max(edge, Math.min(rect.left, window.innerWidth - width - edge));

  menu.style.left = `${left}px`;
  menu.style.width = `${width}px`;
  menu.style.maxHeight = `${maxHeight}px`;
  if (openAbove) {
    menu.style.top = "auto";
    menu.style.bottom = `${window.innerHeight - rect.top + gap}px`;
  } else {
    menu.style.top = `${rect.bottom + gap}px`;
    menu.style.bottom = "auto";
  }
}

function appendPlayerPickerOption(menu, option) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "player-picker-menu__option";
  button.dataset.value = option.value;
  button.textContent = option.textContent;
  if (option.selected) {
    button.classList.add("is-selected");
    button.setAttribute("aria-current", "true");
  }
  button.addEventListener("click", () => {
    if (!activePlayerPickerSelect) return;
    activePlayerPickerSelect.value = option.value;
    activePlayerPickerSelect.dispatchEvent(new Event("change", { bubbles: true }));
    activePlayerPickerSelect.focus({ preventScroll: true });
    closePlayerPicker();
  });
  menu.append(button);
}

function appendPlayerPickerChildren(menu, children) {
  [...children].forEach((child) => {
    if (child.tagName === "OPTGROUP") {
      const label = document.createElement("div");
      label.className = "player-picker-menu__group";
      label.textContent = child.label;
      menu.append(label);
      appendPlayerPickerChildren(menu, child.children);
      return;
    }

    if (child.tagName !== "OPTION") {
      return;
    }

    if (child.disabled) {
      const divider = document.createElement("div");
      divider.className = "player-picker-menu__divider";
      divider.textContent = child.textContent.replace(/[─\s]/g, "") || "선수명단";
      menu.append(divider);
      return;
    }

    appendPlayerPickerOption(menu, child);
  });
}

function openPlayerPicker(select) {
  if (!select || select.disabled) return;
  const menu = playerPickerMenu();
  if (activePlayerPickerSelect === select && !menu.hidden) {
    closePlayerPicker();
    return;
  }

  closePlayerPicker();
  activePlayerPickerSelect = select;
  select.classList.add("is-player-picker-open");
  menu.innerHTML = "";
  appendPlayerPickerChildren(menu, select.children);
  positionPlayerPicker(menu, select);
  menu.hidden = false;

  requestAnimationFrame(() => {
    const selectedButton = selectedPlayerPickerButton(menu) || $(".player-picker-menu__option", menu);
    if (selectedButton) {
      selectedButton.scrollIntoView({ block: "center" });
      focusPlayerPickerButton(selectedButton);
    }
  });
}

function handlePlayerSelectPointer(event) {
  const select = event.currentTarget;
  if (select.disabled) return;
  event.preventDefault();
  select.focus({ preventScroll: true });
  openPlayerPicker(select);
}

function handlePlayerSelectKeydown(event) {
  if (!["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
    return;
  }
  event.preventDefault();
  openPlayerPicker(event.currentTarget);
}

function handlePlayerPickerKeydown(event) {
  const menu = $("#playerPickerMenu");
  if (!activePlayerPickerSelect || !menu || menu.hidden) return;

  if (event.key === "Escape") {
    event.preventDefault();
    activePlayerPickerSelect.focus({ preventScroll: true });
    closePlayerPicker();
    return;
  }

  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    return;
  }

  event.preventDefault();
  const options = $$(".player-picker-menu__option", menu);
  if (!options.length) return;
  const activeIndex = Math.max(0, options.findIndex((option) => option.classList.contains("is-active")));
  const nextIndex = {
    ArrowDown: Math.min(options.length - 1, activeIndex + 1),
    ArrowUp: Math.max(0, activeIndex - 1),
    Home: 0,
    End: options.length - 1,
  }[event.key];
  focusPlayerPickerButton(options[nextIndex]);
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

function renderQueue() {
  const select = $("#queuePlayerSelect");
  const list = $("#queueList");
  const empty = $("#queueEmpty");
  const emptyText = $("#queueEmptyText");
  const canEditQueue = Boolean(getCurrentUser());
  const queuedPlayers = queuePlayers();
  const availablePlayers = availableQueuePlayers();

  select.innerHTML = [
    `<option value="">선수 선택</option>`,
    ...availablePlayers.map((player) => `<option value="${escapeHtml(player.id)}">${escapeHtml(playerDisplayName(player))}</option>`),
  ].join("");

  list.innerHTML = queuedPlayers
    .map((player) => `
      <li class="queue-item">
        ${renderPlayerAvatar(player)}
        <strong>${escapeHtml(playerDisplayName(player))}</strong>
        <button class="icon-button" type="button" data-remove-queue-player="${escapeHtml(player.id)}" ${canEditQueue ? "" : "disabled"} aria-label="${escapeHtml(player.name)} 대기열 제거" title="대기열 제거">
          <i data-lucide="x"></i>
          <span class="visually-hidden">제거</span>
        </button>
      </li>
    `)
    .join("");

  if (!getCurrentUser()) {
    emptyText.textContent = "로그인하면 대기열을 관리할 수 있습니다.";
  } else {
    emptyText.textContent = "대기열이 비어 있습니다.";
  }

  empty.classList.toggle("is-visible", queuedPlayers.length === 0);
}

function renderAccess() {
  const user = getCurrentUser();
  const loggedIn = Boolean(user);
  const admin = isAdmin();
  const canAddPlayers = canRegisterPlayers();
  const activePlayerCount = getActivePlayers().length;
  const canRecordMatch = loggedIn && activePlayerCount >= 4;
  const availableQueueCount = availableQueuePlayers().length;

  $("#matchAuthNote").textContent = loggedIn ? `${user.displayName}님으로 경기 입력 중` : "로그인하면 경기 결과를 입력할 수 있습니다.";
  $("#rosterAuthNote").textContent = canAddPlayers
    ? admin ? "admin 권한으로 선수와 설정을 관리 중" : "manager 권한으로 선수 등록 가능"
    : "선수 등록은 manager 또는 admin만 가능합니다.";
  $("#playerTitle").textContent = canAddPlayers ? "선수 등록" : "대기열";
  $("#playerForm").hidden = !canAddPlayers;
  $("#queueAuthNote").textContent = loggedIn ? "공용 대기열" : "로그인하면 대기열을 관리할 수 있습니다.";

  selectIds.forEach((id) => {
    $(`#${id}`).disabled = !canRecordMatch;
  });
  $("#scoreA").disabled = !loggedIn;
  $("#scoreB").disabled = !loggedIn;
  $("#matchPlayedAt").disabled = !loggedIn;
  $("#matchSubmitBtn").disabled = !canRecordMatch;
  $("#shuffleBtn").hidden = activePlayerCount < 4;
  $("#shuffleBtn").disabled = !canRecordMatch;

  $("#playerName").disabled = !canAddPlayers;
  $("#playerRating").disabled = !canAddPlayers;
  $("#playerForm button").disabled = !canAddPlayers;
  $("#queuePlayerSelect").disabled = !loggedIn || availableQueueCount === 0;
  $("#queueAddBtn").disabled = !loggedIn || availableQueueCount === 0;
  $$("#baseRating, #kFactor, #marginBonus").forEach((element) => {
    element.disabled = !admin;
  });
  $("#bulkMatchPanel").hidden = !admin;
  $("#bulkMatchText").disabled = !admin;
  $("#bulkMatchSubmitBtn").disabled = !admin;
}

function renderRankings(standings) {
  const body = $("#rankingBody");
  const empty = $("#rankingEmpty");
  const focusPlayerId = focusedRankingPlayerId(standings);
  const activeRows = standings.map((player, index) => {
      const rank = index + 1;
      const rankClass = rank <= 3 ? "rank-pill rank-pill--podium" : "rank-pill";
      const focusClass = player.id === focusPlayerId ? "is-ranking-focus" : "";
      const ariaCurrent = player.id === focusPlayerId ? ` aria-current="true"` : "";
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
        <tr class="${focusClass}" data-ranking-player="${escapeHtml(player.id)}"${ariaCurrent}>
          <td><span class="${rankClass}">${rank}</span></td>
          <td>
            <div class="player-cell">
              ${renderPlayerAvatar(player)}
              <div class="player-meta">
                ${renderPlayerName(player, { managerBadge: true })}
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
                ${renderPlayerAvatar(player)}
                <div class="player-meta">
                  ${renderPlayerName(player, { managerBadge: true })}
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
  scrollRankingToFocus(focusPlayerId);
}

function formatStreak(streak, streakDelta = 0) {
  const delta = `<span class="streak-delta">${formatSigned(streakDelta)}</span>`;
  if (streak > 0) {
    return `<span class="streak streak--win">${delta} ${streak}연승</span>`;
  }
  if (streak < 0) {
    return `<span class="streak streak--loss">${delta} ${Math.abs(streak)}연패</span>`;
  }
  return `<span class="muted">-</span>`;
}

function partnerStatsForPlayer(ownPlayer) {
  const statsByPartner = new Map();

  sortedMatches().forEach((match) => {
    const ownSide = match.teamA.includes(ownPlayer.id) ? "A" : match.teamB.includes(ownPlayer.id) ? "B" : "";
    if (!ownSide) {
      return;
    }

    const teamIds = ownSide === "A" ? match.teamA : match.teamB;
    const partnerId = teamIds.find((id) => id !== ownPlayer.id);
    const partner = state.players.find((player) => player.id === partnerId);
    if (!partner) {
      return;
    }

    const current = statsByPartner.get(partnerId) || {
      partner,
      wins: 0,
      losses: 0,
      totalDelta: 0,
      lastPlayed: null,
    };
    const ownDelta = Number(match.changes.find((change) => change.id === ownPlayer.id)?.delta || 0);
    current.wins += match.winner === ownSide ? 1 : 0;
    current.losses += match.winner === ownSide ? 0 : 1;
    current.totalDelta = round1(current.totalDelta + ownDelta);
    current.lastPlayed = !current.lastPlayed || matchOrderTime(match) > new Date(current.lastPlayed).getTime()
      ? matchPlayedAt(match)
      : current.lastPlayed;
    statsByPartner.set(partnerId, current);
  });

  return [...statsByPartner.values()]
    .map((stat) => ({
      ...stat,
      games: stat.wins + stat.losses,
      winRate: stat.wins + stat.losses ? stat.wins / (stat.wins + stat.losses) : 0,
    }))
    .sort((a, b) => {
      if (b.totalDelta !== a.totalDelta) return b.totalDelta - a.totalDelta;
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.games !== a.games) return b.games - a.games;
      return a.partner.name.localeCompare(b.partner.name, "ko-KR");
    });
}

function renderPartnerStats() {
  const list = $("#partnerStatsList");
  const empty = $("#partnerStatsEmpty");
  const emptyText = $("#partnerStatsEmptyText");
  const ownPlayer = currentUserPlayer();
  const stats = ownPlayer ? partnerStatsForPlayer(ownPlayer) : [];
  const ownName = ownPlayer ? playerDisplayName(ownPlayer) : "";

  list.innerHTML = stats
    .map((stat, index) => {
      const deltaClass = stat.totalDelta > 0 ? "partner-delta--win" : stat.totalDelta < 0 ? "partner-delta--loss" : "";
      return `
        <li class="partner-stat-item">
          <span class="rank-pill">${index + 1}</span>
          <div class="partner-stat-main">
            <span class="partner-stat-line"><strong>${escapeHtml(ownName)} / ${escapeHtml(playerDisplayName(stat.partner))}</strong> ${stat.wins}승 ${stat.losses}패 <span class="partner-delta ${deltaClass}">(${formatSigned(stat.totalDelta)})</span></span>
          </div>
        </li>
      `;
    })
    .join("");
  list.scrollTop = 0;

  if (!getCurrentUser()) {
    emptyText.textContent = "로그인하면 파트너별 기록을 볼 수 있습니다.";
  } else if (!ownPlayer) {
    emptyText.textContent = "계정에 연결된 선수가 없습니다.";
  } else {
    emptyText.textContent = "아직 파트너별 기록이 없습니다.";
  }

  empty.classList.toggle("is-visible", stats.length === 0);
}

function renderHistoryItem(match) {
  const teamA = match.teamA.map(playerName).join(" / ");
  const teamB = match.teamB.map(playerName).join(" / ");
  const deltaA = match.changes.find((change) => match.teamA.includes(change.id))?.delta || 0;
  const deltaB = match.changes.find((change) => match.teamB.includes(change.id))?.delta || 0;
  const editedText = match.updatedAt ? ` · 수정 ${escapeHtml(match.updatedByName || "알 수 없음")} ${formatDate(match.updatedAt)}` : "";
  const editButton = canEditMatch(match)
    ? `<button class="icon-button" type="button" data-edit-match="${escapeHtml(match.id)}" aria-label="경기 수정" title="경기 수정"><i data-lucide="pencil"></i><span class="visually-hidden">수정</span></button>`
    : "";
  const deleteButton = isAdmin()
    ? `<button class="icon-button" type="button" data-delete-match="${escapeHtml(match.id)}" aria-label="경기 삭제" title="경기 삭제"><i data-lucide="trash-2"></i><span class="visually-hidden">삭제</span></button>`
    : "";
  const actions = editButton || deleteButton
    ? `<div class="row-actions">${editButton}${deleteButton}</div>`
    : `<span class="muted">-</span>`;

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
      ${actions}
    </li>
  `;
}

function renderMyHistory() {
  const list = $("#myHistoryList");
  const empty = $("#myHistoryEmpty");
  const emptyText = $("#myHistoryEmptyText");
  const ownPlayer = currentUserPlayer();
  const myMatches = ownPlayer
    ? sortedMatches().filter((match) => [...match.teamA, ...match.teamB].includes(ownPlayer.id)).reverse()
    : [];

  list.innerHTML = myMatches.map(renderHistoryItem).join("");
  list.scrollTop = 0;

  if (!getCurrentUser()) {
    emptyText.textContent = "로그인하면 나의 경기 기록을 볼 수 있습니다.";
  } else if (!ownPlayer) {
    emptyText.textContent = "계정에 연결된 선수가 없습니다.";
  } else {
    emptyText.textContent = "아직 내 경기 기록이 없습니다.";
  }

  empty.classList.toggle("is-visible", myMatches.length === 0);
}

function renderHistory() {
  const list = $("#historyList");
  const empty = $("#historyEmpty");

  list.innerHTML = sortedMatches().reverse().map(renderHistoryItem).join("");
  list.scrollTop = 0;

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
  const queueIds = queuedPlayerIdSet();
  const queuedPlayerIds = getStandings()
    .filter((player) => queueIds.has(player.id))
    .map((player) => player.id);

  if (queuedPlayerIds.length < 4) {
    showToast("대기열 선수 4명 이상이 필요합니다.");
    return;
  }

  const shuffled = queuedPlayerIds
    .sort(() => Math.random() - 0.5)
    .slice(0, 4);

  selectIds.forEach((selectId, index) => {
    $(`#${selectId}`).value = shuffled[index];
  });
  renderPreview();
}

function formatStreakText(streak, streakDelta = 0) {
  if (streak > 0) {
    return `${formatSigned(streakDelta)} ${streak}연승`;
  }
  if (streak < 0) {
    return `${formatSigned(streakDelta)} ${Math.abs(streak)}연패`;
  }
  return "-";
}

function buildRankingExportLines() {
  const standings = getStandings();
  const lines = standings.map((player, index) => {
    const winRate = player.games ? `${Math.round(player.winRate * 100)}%` : "-";
    const lastPlayed = player.lastPlayed ? `최근 ${formatDate(player.lastPlayed)}` : "경기 없음";
    const seedRating = isAdmin() ? ` | 초기 ${Math.round(player.seedRating)}` : "";
    return [
      `${index + 1}. ${playerDisplayName(player, { managerBadge: true })}`,
      `레이팅 ${player.rating.toFixed(1)}`,
      formatStreakText(player.streak, player.streakDelta),
      `전적 ${player.wins}승 ${player.losses}패`,
      `승률 ${winRate}`,
      lastPlayed,
    ].join(" | ") + seedRating;
  });

  if (isAdmin()) {
    state.players
      .filter((player) => player.seedRating == null || player.status === "pending")
      .forEach((player) => {
        lines.push(`-. ${playerDisplayName(player, { managerBadge: true })} | 초기 ELO 필요 | 전적 - | 승률 -`);
      });
  }

  return lines.length ? lines : ["등록된 선수가 없습니다."];
}

function buildHistoryExportLines() {
  const matches = sortedMatches().reverse();
  if (!matches.length) {
    return ["아직 저장된 경기가 없습니다."];
  }

  return matches.map((match, index) => {
    const teamA = match.teamA.map(playerName).join(" / ");
    const teamB = match.teamB.map(playerName).join(" / ");
    const deltaA = match.changes.find((change) => match.teamA.includes(change.id))?.delta || 0;
    const deltaB = match.changes.find((change) => match.teamB.includes(change.id))?.delta || 0;
    const editedText = match.updatedAt ? ` | 수정 ${match.updatedByName || "알 수 없음"} ${formatDate(match.updatedAt)}` : "";
    return [
      `${index + 1}. ${formatDate(matchPlayedAt(match))}`,
      `${teamA} ${match.scoreA} : ${match.scoreB} ${teamB}`,
      `A ${formatSigned(deltaA)} / B ${formatSigned(deltaB)}`,
      `기대승률 ${Math.round(match.expectedA * 100)}% : ${Math.round(match.expectedB * 100)}%`,
      `입력 ${match.createdByName || "알 수 없음"}`,
    ].join(" | ") + editedText;
  });
}

function buildTextExport() {
  return [
    "허니서브 동호회 랭킹",
    `내보낸 시각: ${new Date().toLocaleString("ko-KR")}`,
    "",
    "[랭킹]",
    ...buildRankingExportLines(),
    "",
    "[경기 기록]",
    ...buildHistoryExportLines(),
    "",
  ].join("\n");
}

function exportData() {
  const text = buildTextExport();
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `honeyserve-ranking-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  showToast("랭킹과 경기 기록을 텍스트로 내보냈습니다.");
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

  $("#queueForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const select = $("#queuePlayerSelect");
    await addQueuePlayer(select.value);
    select.value = "";
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
    const select = $(`#${id}`);
    select.classList.add("player-picker-native");
    select.addEventListener("change", renderPreview);
    select.addEventListener("pointerdown", handlePlayerSelectPointer);
    select.addEventListener("keydown", handlePlayerSelectKeydown);
  });

  $("#scoreA").addEventListener("input", renderPreview);
  $("#scoreB").addEventListener("input", renderPreview);
  $("#shuffleBtn").addEventListener("click", shuffleTeams);
  $("#exportBtn").addEventListener("click", exportData);

  $("#baseRating").addEventListener("change", (event) => {
    updateSettings({ baseRating: clampNumber(Number(event.target.value), 800, 2400) });
  });

  $("#kFactor").addEventListener("change", (event) => {
    updateSettings({ kFactor: clampNumber(Number(event.target.value), 8, 64) });
  });

  $("#marginBonus").addEventListener("change", (event) => {
    updateSettings({ marginBonus: event.target.checked });
  });

  document.addEventListener("keydown", handlePlayerPickerKeydown);
  window.addEventListener("resize", closePlayerPicker);

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    if (activePlayerPickerSelect && !target.closest(".player-picker-menu") && target !== activePlayerPickerSelect) {
      closePlayerPicker();
    }


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

    const removeQueueButton = target.closest("[data-remove-queue-player]");
    if (removeQueueButton) {
      removeQueuePlayer(removeQueueButton.dataset.removeQueuePlayer);
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

    const toggleManagerButton = target.closest("[data-toggle-manager]");
    if (toggleManagerButton) {
      toggleManagerRole(toggleManagerButton.dataset.toggleManager);
      return;
    }

    const deleteUserButton = target.closest("[data-delete-user]");
    if (deleteUserButton) {
      deleteUser(deleteUserButton.dataset.deleteUser);
      return;
    }

    const linkUserPlayerButton = target.closest("[data-link-user-player]");
    if (linkUserPlayerButton) {
      linkUserPlayer(linkUserPlayerButton.dataset.linkUserPlayer);
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
