const defaultSettings = {
  baseRating: 1500,
  kFactor: 32,
  marginBonus: true,
};

const selectIds = ["teamA1", "teamA2", "teamB1", "teamB2"];
const editSelectIds = ["editTeamA1", "editTeamA2", "editTeamB1", "editTeamB2"];
const paginationPageSize = 20;
const paginationPagerIds = {
  myHistory: "myHistoryPager",
  partnerStats: "partnerStatsPager",
  opponentStats: "opponentStatsPager",
  history: "historyPager",
  users: "userPager",
};
const playerStickerCatalog = [
  { id: "shuttle", emoji: "🏸", label: "셔틀콕" },
  { id: "racket", emoji: "💥", label: "스매시" },
  { id: "sparkle", emoji: "✨", label: "반짝" },
  { id: "star", emoji: "🌟", label: "스타" },
  { id: "fire", emoji: "🔥", label: "불꽃" },
  { id: "crown", emoji: "👑", label: "왕관" },
  { id: "trophy", emoji: "🏆", label: "트로피" },
  { id: "medal", emoji: "🥇", label: "금메달" },
  { id: "diamond", emoji: "💎", label: "다이아" },
  { id: "heart-gold", emoji: "💛", label: "골드 하트" },
  { id: "heart-green", emoji: "💚", label: "그린 하트" },
  { id: "bolt", emoji: "⚡", label: "번개" },
  { id: "target", emoji: "🎯", label: "타깃" },
  { id: "hundred", emoji: "💯", label: "백점" },
  { id: "ribbon", emoji: "🎀", label: "리본" },
  { id: "rainbow", emoji: "🌈", label: "무지개" },
  { id: "honey", emoji: "🍯", label: "허니" },
  { id: "clover", emoji: "🍀", label: "행운" },
  { id: "sun", emoji: "☀️", label: "태양" },
  { id: "moon", emoji: "🌙", label: "달" },
];
const playerStickerById = new Map(playerStickerCatalog.map((sticker) => [sticker.id, sticker]));
const scrollSnapshotSelectors = [
  ".rankings-board .table-wrap",
  "#queueList",
  "#myHistoryList",
  "#partnerStatsList",
  "#opponentStatsList",
  "#historyList",
  "#userList",
  "#playerStickerPanel",
];

let state = createDefaultState();
let toastTimer = null;
let editingMatchId = null;
let openCardPlayerId = "";
let stickerDrag = null;
let paginationState = {
  myHistory: 1,
  partnerStats: 1,
  opponentStats: 1,
  history: 1,
  users: 1,
};

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
  MANNER_VOTE_FORBIDDEN: "해당 경기 참여자만 매너 투표를 할 수 있습니다.",
  MANNER_VOTE_PLAYER_REQUIRED: "계정에 연결된 선수만 매너 투표를 할 수 있습니다.",
  MANNER_VOTE_TARGET_INVALID: "자신을 제외한 경기 참여자에게만 투표할 수 있습니다.",
  MANNER_VOTE_TARGET_REQUIRED: "매너 투표할 선수를 선택하세요.",
  QUEUE_PLAYER_REQUIRED: "대기열에 추가할 선수를 선택하세요.",
  QUEUE_UNKNOWN_PLAYER: "등록된 선수를 선택하세요.",
  REQUEST_TOO_LARGE: "파일이 너무 큽니다.",
  SERVER_ERROR: "서버 처리 중 문제가 생겼습니다.",
  STICKER_ALREADY_USED: "이미 다른 선수 카드에 붙인 스티커입니다.",
  STICKER_INVALID: "스티커를 확인하세요.",
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
    mannerVotes: [],
    cardStickers: [],
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

function paginationFor(section, totalItems) {
  const pageCount = Math.max(1, Math.ceil(totalItems / paginationPageSize));
  const page = Math.min(
    pageCount,
    Math.max(1, Math.floor(Number(paginationState[section]) || 1)),
  );
  paginationState[section] = page;
  return {
    page,
    pageCount,
    start: (page - 1) * paginationPageSize,
    end: page * paginationPageSize,
  };
}

function paginatedItems(section, items) {
  const pagination = paginationFor(section, items.length);
  return {
    ...pagination,
    items: items.slice(pagination.start, pagination.end),
  };
}

function renderPagination(section, totalItems) {
  const pager = $(`#${paginationPagerIds[section]}`);
  if (!pager) {
    return;
  }

  const { page, pageCount } = paginationFor(section, totalItems);
  const shouldShow = totalItems > paginationPageSize;
  pager.hidden = !shouldShow;
  if (!shouldShow) {
    pager.innerHTML = "";
    return;
  }

  pager.innerHTML = Array.from({ length: pageCount }, (_, index) => {
    const pageNumber = index + 1;
    const active = pageNumber === page;
    return `
      <button
        class="pagination-button ${active ? "is-active" : ""}"
        type="button"
        data-pagination-section="${escapeHtml(section)}"
        data-pagination-page="${pageNumber}"
        ${active ? 'aria-current="page"' : ""}
        aria-label="Page ${pageNumber}"
      >${pageNumber}</button>
    `;
  }).join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const matchById = new Map(matches.map((match) => [match.id, match]));
  const mannerVoteKeys = new Set();
  const mannerVotes = Array.isArray(input?.mannerVotes)
    ? input.mannerVotes
        .map((vote) => ({
          matchId: String(vote?.matchId ?? vote?.match_id ?? ""),
          voterPlayerId: String(vote?.voterPlayerId ?? vote?.voter_player_id ?? ""),
          targetPlayerId: String(vote?.targetPlayerId ?? vote?.target_player_id ?? ""),
          createdAt: safeIsoDate(vote?.createdAt ?? vote?.created_at),
          updatedAt: safeIsoDate(vote?.updatedAt ?? vote?.updated_at ?? vote?.createdAt ?? vote?.created_at),
        }))
        .filter((vote) => {
          const match = matchById.get(vote.matchId);
          const participants = match ? [...match.teamA, ...match.teamB] : [];
          const key = `${vote.matchId}:${vote.voterPlayerId}`;
          if (
            !match ||
            !participants.includes(vote.voterPlayerId) ||
            !participants.includes(vote.targetPlayerId) ||
            vote.voterPlayerId === vote.targetPlayerId ||
            mannerVoteKeys.has(key)
          ) {
            return false;
          }
          mannerVoteKeys.add(key);
          return true;
        })
    : [];
  const stickerKeys = new Set();
  const cardStickers = Array.isArray(input?.cardStickers)
    ? input.cardStickers
        .map((sticker) => ({
          userId: String(sticker?.userId ?? sticker?.user_id ?? ""),
          stickerId: String(sticker?.stickerId ?? sticker?.sticker_id ?? ""),
          playerId: String(sticker?.playerId ?? sticker?.player_id ?? ""),
          x: round1(clampNumber(Number(sticker?.x), 0, 100)),
          y: round1(clampNumber(Number(sticker?.y), 0, 100)),
          rotation: round1(clampNumber(Number(sticker?.rotation ?? 0), -35, 35)),
          scale: round1(clampNumber(Number(sticker?.scale ?? 1), 0.7, 1.35)),
          ownedByCurrentUser: Boolean(sticker?.ownedByCurrentUser),
          createdAt: safeIsoDate(sticker?.createdAt ?? sticker?.created_at),
          updatedAt: safeIsoDate(sticker?.updatedAt ?? sticker?.updated_at ?? sticker?.createdAt ?? sticker?.created_at),
        }))
        .filter((sticker) => {
          const key = `${sticker.userId}:${sticker.stickerId}`;
          if (
            !sticker.userId ||
            !playerStickerById.has(sticker.stickerId) ||
            !activePlayerIds.has(sticker.playerId) ||
            stickerKeys.has(key)
          ) {
            return false;
          }
          stickerKeys.add(key);
          return true;
        })
    : [];

  return {
    players,
    matches,
    mannerVotes,
    cardStickers,
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

function shouldPreserveScroll(options = {}) {
  return Boolean(options.preserveScroll || options.preserveRankingScroll);
}

function captureAppScroll() {
  return {
    pageX: window.scrollX,
    pageY: window.scrollY,
    elements: scrollSnapshotSelectors.map((selector) => {
      const element = $(selector);
      return {
        selector,
        scrollLeft: element ? element.scrollLeft : null,
        scrollTop: element ? element.scrollTop : null,
      };
    }),
  };
}

function restoreAppScroll(snapshot) {
  if (!snapshot) {
    return;
  }

  const restore = () => {
    (snapshot.elements || []).forEach((entry) => {
      const element = $(entry.selector);
      if (!element) {
        return;
      }
      if (Number.isFinite(entry.scrollTop)) {
        element.scrollTop = entry.scrollTop;
      }
      if (Number.isFinite(entry.scrollLeft)) {
        element.scrollLeft = entry.scrollLeft;
      }
    });
    window.scrollTo(snapshot.pageX, snapshot.pageY);
  };

  window.requestAnimationFrame(() => {
    restore();
    window.requestAnimationFrame(restore);
    window.setTimeout(restore, 60);
  });
}

function applyServerState(payload, options = {}) {
  const dialogPlayerId = openCardPlayerId;
  const scrollSnapshot = shouldPreserveScroll(options) ? captureAppScroll() : null;
  state = normalizeState(payload);
  render(options);
  restoreAppScroll(scrollSnapshot);
  if (dialogPlayerId && $("#playerCardDialog")?.open) {
    openCardPlayerId = dialogPlayerId;
    renderPlayerCardStickerUi(currentOpenCardPlayer());
  }
}

function applyStickerServerState(payload, scrollSnapshot = captureAppScroll()) {
  const dialogPlayerId = openCardPlayerId;
  state = normalizeState(payload);
  if (dialogPlayerId && $("#playerCardDialog")?.open) {
    openCardPlayerId = dialogPlayerId;
    renderPlayerCardStickerUi(currentOpenCardPlayer());
  }
  restoreAppScroll(scrollSnapshot);
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

function formatDateOnly(isoDate) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  const year = String(date.getFullYear()).slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function localDateKey(isoDate) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

async function offerBrowserCredentialSave(username, password, displayName = "") {
  const cleanUsername = normalizeUsername(username);
  if (!cleanUsername || !password || !window.isSecureContext || !window.PasswordCredential || !navigator.credentials?.store) {
    return;
  }

  try {
    const credential = new window.PasswordCredential({
      id: cleanUsername,
      name: String(displayName || cleanUsername).trim(),
      password: String(password),
    });
    await navigator.credentials.store(credential);
  } catch {
    // Password managers are browser/user controlled; login should continue even if saving is unavailable or declined.
  }
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
    await offerBrowserCredentialSave(normalizedUsername, password, payload.currentUser?.displayName || cleanDisplayName);
    applyServerState(payload);
    showToast(payload.currentUser?.role === "admin" ? "admin 계정을 만들고 로그인했습니다." : "계정을 만들고 로그인했습니다.");
    return true;
  } catch (error) {
    showApiError(error);
    return false;
  }
}

async function login(username, password) {
  const normalizedUsername = normalizeUsername(username);
  try {
    const payload = await apiFetch("/api/login", {
      method: "POST",
      body: { username: normalizedUsername, password },
    });
    await offerBrowserCredentialSave(normalizedUsername, password, payload.currentUser?.displayName || normalizedUsername);
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
    applyServerState(await apiFetch(`/api/users/${encodeURIComponent(userId)}/toggle-admin`, { method: "PATCH" }), { preserveScroll: true });
    showToast("계정 권한을 변경했습니다.");
  } catch (error) {
    showApiError(error);
  }
}

async function toggleManagerRole(userId) {
  if (!requireAdmin()) return;
  try {
    applyServerState(await apiFetch(`/api/users/${encodeURIComponent(userId)}/toggle-manager`, { method: "PATCH" }), { preserveScroll: true });
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
    applyServerState(await apiFetch(`/api/users/${encodeURIComponent(userId)}`, { method: "DELETE" }), { preserveScroll: true });
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
      { preserveScroll: true },
    );
    showToast("계정과 선수를 연결했습니다.");
  } catch (error) {
    showApiError(error);
  }
}

function getMannerVoteCountsByPlayer(sourceState = state) {
  const counts = new Map();
  (sourceState.mannerVotes || []).forEach((vote) => {
    counts.set(vote.targetPlayerId, (counts.get(vote.targetPlayerId) || 0) + 1);
  });
  return counts;
}

function getStandings(sourceState = state) {
  const mannerVoteCounts = getMannerVoteCountsByPlayer(sourceState);
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
        peakRating: null,
        peakRatingAt: null,
        honors: [],
        attendanceDays: new Set(),
        maxWinStreak: 0,
        mannerVotes: mannerVoteCounts.get(player.id) || 0,
      },
    ]),
  );

  sortedMatches(sourceState.matches).forEach((match) => {
    const changeMap = new Map(match.changes.map((change) => [change.id, Number(change.delta || 0)]));

    match.changes.forEach((change) => {
      const player = table.get(change.id);
      if (player) {
        const delta = Number(change.delta || 0);
        player.rating = round1(player.rating + delta);
        if (player.peakRating == null || player.rating > Number(player.peakRating)) {
          player.peakRating = player.rating;
          player.peakRatingAt = matchPlayedAt(match);
        }
      }
    });

    applyMatchStats(table, match.teamA, match.winner === "A", matchPlayedAt(match), changeMap);
    applyMatchStats(table, match.teamB, match.winner === "B", matchPlayedAt(match), changeMap);
  });

  const standings = [...table.values()]
    .map((player) => ({
      ...player,
      rating: round1(player.rating),
      ratingGainFromSeed: round1(Number(player.rating || 0) - Number(player.seedRating || 0)),
      recordMargin: Number(player.wins || 0) - Number(player.losses || 0),
      peakRating: player.peakRating == null ? null : round1(player.peakRating),
      attendanceDays: player.attendanceDays.size,
      streakDelta: round1(player.streakDelta),
      winRate: player.games ? player.wins / player.games : 0,
    }))
    .sort((a, b) => {
      if (b.rating !== a.rating) return b.rating - a.rating;
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      if (b.games !== a.games) return b.games - a.games;
      return a.name.localeCompare(b.name, "ko-KR");
    });

  return applyPlayerHonors(standings);
}

function playersWithBestRatio(standings, predicate, ratioValue) {
  const candidates = standings
    .map((player) => ({ player, ratio: ratioValue(player) }))
    .filter((entry) => predicate(entry.player) && Number.isFinite(entry.ratio) && entry.ratio > 0);
  const bestRatio = Math.max(0, ...candidates.map((entry) => entry.ratio));
  if (bestRatio <= 0) {
    return [];
  }
  return candidates
    .filter((entry) => Math.abs(entry.ratio - bestRatio) < 0.000001)
    .map((entry) => entry.player);
}

const playerHonorRules = [
  {
    key: "wins",
    label: "다승왕",
    className: "player-honor--wins",
    winners(standings) {
      const maxWins = Math.max(0, ...standings.map((player) => Number(player.wins || 0)));
      if (maxWins <= 0) {
        return [];
      }
      return standings.filter((player) => Number(player.wins || 0) === maxWins);
    },
  },
  {
    key: "winRate",
    label: "승률왕",
    className: "player-honor--win-rate",
    winners(standings) {
      const candidates = standings.filter((player) => Number(player.games || 0) >= 5);
      const maxWinRate = Math.max(0, ...candidates.map((player) => Number(player.winRate || 0)));
      if (maxWinRate <= 0) {
        return [];
      }
      return candidates.filter((player) => Number(player.winRate || 0) === maxWinRate);
    },
  },
  {
    key: "attendance",
    label: "출석왕",
    className: "player-honor--attendance",
    winners(standings) {
      const maxAttendance = Math.max(0, ...standings.map((player) => Number(player.attendanceDays || 0)));
      if (maxAttendance <= 0) {
        return [];
      }
      return standings.filter((player) => Number(player.attendanceDays || 0) === maxAttendance);
    },
  },
  {
    key: "manner",
    label: "매너왕",
    className: "player-honor--manner",
    winners(standings) {
      const maxMannerVotes = Math.max(0, ...standings.map((player) => Number(player.mannerVotes || 0)));
      if (maxMannerVotes <= 0) {
        return [];
      }
      return standings.filter((player) => Number(player.mannerVotes || 0) === maxMannerVotes);
    },
  },
  {
    key: "winStreak",
    label: "연승왕",
    className: "player-honor--win-streak",
    winners(standings) {
      const maxWinStreak = Math.max(0, ...standings.map((player) => Number(player.maxWinStreak || 0)));
      if (maxWinStreak <= 0) {
        return [];
      }
      return standings.filter((player) => Number(player.maxWinStreak || 0) === maxWinStreak);
    },
  },
  {
    key: "giantKiller",
    label: "자이언트킬러",
    className: "player-honor--giant-killer",
    winners(standings) {
      return playersWithBestRatio(
        standings,
        (player) => Number(player.recordMargin || 0) < 0 && Number(player.ratingGainFromSeed || 0) > 0,
        (player) => round1(Number(player.ratingGainFromSeed || 0)) / Math.abs(Number(player.recordMargin || 0)),
      );
    },
  },
  {
    key: "weakKiller",
    label: "약팀킬러",
    className: "player-honor--weak-killer",
    winners(standings) {
      return playersWithBestRatio(
        standings,
        (player) => Number(player.recordMargin || 0) > 0 && Number(player.ratingGainFromSeed || 0) < 0,
        (player) => Math.abs(round1(Number(player.ratingGainFromSeed || 0))) / Math.abs(Number(player.recordMargin || 0)),
      );
    },
  },
  {
    key: "effort",
    label: "노력왕",
    className: "player-honor--effort",
    winners(standings) {
      const maxGainFromSeed = Math.max(
        0,
        ...standings.map((player) => round1(Number(player.rating || 0) - Number(player.seedRating || 0))),
      );
      if (maxGainFromSeed <= 0) {
        return [];
      }
      return standings.filter((player) => (
        round1(Number(player.rating || 0) - Number(player.seedRating || 0)) === maxGainFromSeed
      ));
    },
  },
];

function applyPlayerHonors(standings) {
  const honorMap = new Map(standings.map((player) => [player.id, []]));

  playerHonorRules.forEach((rule) => {
    rule.winners(standings).forEach((player) => {
      honorMap.get(player.id)?.push({
        key: rule.key,
        label: rule.label,
        className: rule.className,
      });
    });
  });

  return standings.map((player) => ({
    ...player,
    honors: honorMap.get(player.id) || [],
  }));
}

function applyMatchStats(table, ids, won, createdAt, changeMap) {
  ids.forEach((id) => {
    const player = table.get(id);
    if (!player) return;
    const previousStreak = player.streak;
    const delta = Number(changeMap.get(id) || 0);
    const dateKey = localDateKey(createdAt);
    player.games += 1;
    player.wins += won ? 1 : 0;
    player.losses += won ? 0 : 1;
    player.lastPlayed = createdAt;
    if (dateKey) {
      player.attendanceDays.add(dateKey);
    }
    player.streak = won
      ? player.streak > 0 ? player.streak + 1 : 1
      : player.streak < 0 ? player.streak - 1 : -1;
    if (won) {
      player.maxWinStreak = Math.max(Number(player.maxWinStreak || 0), player.streak);
    }
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

function playerDisplayName(player) {
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
  const specialStarAccounts = ["ji0.baek", "jiyeong.baek"];
  return specialStarAccounts.includes(normalizeUsername(accountId)) ? `${displayName} ⭐` : displayName;
}

function playerCardDisplayName(player) {
  const name = String(player?.name || "").trim();
  const accountId = playerAccountId(player);
  if (!name || !accountId) {
    return name;
  }
  return name.replace(new RegExp(`\\s*\\(${escapeRegExp(accountId)}\\)\\s*$`, "i"), "").trim() || name;
}

const playerAssetProfiles = [
  {
    identity: "cheol-ryu",
    accountIds: ["rcheol"],
    workdaySearchIds: ["cheol.ryu"],
    nameIncludes: ["류철"],
    photo: "./assets/player-photos/cheol-ryu.png",
    cardTiers: ["s", "a", "b", "c"],
    figureCardTiers: ["s"],
  },
  {
    identity: "taehoon-kim",
    accountIds: ["taehoon1310", "th.amel.kim"],
    workdaySearchIds: ["th.amel.kim"],
    nameIncludes: ["김태훈"],
    photo: "./assets/player-photos/taehoon-kim.jpg",
    cardTiers: ["s"],
    figureCardTiers: ["s"],
  },
  {
    identity: "jinuk-kim",
    accountIds: ["kjy9631", "jinuk03.kim"],
    workdaySearchIds: ["jinuk03.kim"],
    nameIncludes: ["김진욱 (kjy9631)"],
    photo: "./assets/player-photos/jinuk-kim.jpg",
    cardTiers: ["a"],
    figureCardTiers: ["a"],
  },
  {
    identity: "jinwook-kim-left",
    accountIds: ["kjo5744", "jinw00k2.kim"],
    workdaySearchIds: ["jinw00k2.kim"],
    nameIncludes: ["김진욱(왼)"],
    photo: "./assets/player-photos/jinwook-kim-left.jpg",
    cardTiers: ["a"],
    figureCardTiers: ["a"],
  },
  {
    identity: "jiyeong-baek",
    gender: "female",
    accountIds: ["ji0.baek", "jiyeong.baek"],
    workdaySearchIds: ["ji0.baek"],
    nameIncludes: ["백지영"],
    photo: "./assets/player-photos/jiyeong-baek.jpg",
    cardTiers: ["s", "a", "b", "c"],
    figureCardTiers: ["b"],
  },
  {
    identity: "sangjun-park",
    accountIds: ["sj-_-.park", "sangjun.park"],
    workdaySearchIds: ["sj-_-.park"],
    nameIncludes: ["박상준"],
    photo: "./assets/player-photos/sangjun-park.jpg",
    cardTiers: ["s", "a", "b", "c"],
    figureCardTiers: ["a"],
  },
  {
    identity: "jonghyun-park",
    accountIds: ["johpark97", "jjong97.park"],
    workdaySearchIds: ["jjong97.park"],
    nameIncludes: ["박종현"],
    photo: "./assets/player-photos/jonghyun-park.jpg",
    cardTiers: ["a"],
    figureCardTiers: ["a"],
  },
  {
    identity: "hoseok-jung",
    accountIds: ["hoseok5.jung", "hoseok.jung"],
    workdaySearchIds: ["hoseok5.jung"],
    nameIncludes: ["정호석"],
    photo: "./assets/player-photos/hoseok-jung.jpg",
    cardTiers: ["s", "a", "b", "c"],
    figureCardTiers: ["b"],
  },
  {
    identity: "eungi-hong",
    accountIds: ["eungi89.hong", "eungi.hong"],
    workdaySearchIds: ["eungi89.hong"],
    nameIncludes: ["홍은기"],
    photo: "./assets/player-photos/eungi-hong.jpg",
    cardTiers: ["s", "a", "b", "c"],
    figureCardTiers: ["c"],
  },
  {
    identity: "yeongseon-byun",
    gender: "female",
    accountIds: ["yes.byun", "yeongseon.byun"],
    workdaySearchIds: ["yes.byun"],
    nameIncludes: ["변영선"],
    photo: "./assets/player-photos/yeongseon-byun.jpg",
    cardTiers: ["a", "b", "c"],
    figureCardTiers: ["a"],
  },
  {
    identity: "h-hyun",
    gender: "female",
    accountIds: ["h.hyun"],
    workdaySearchIds: ["h.hyun"],
    nameIncludes: ["현현영"],
    photo: "./assets/player-photos/h-hyun.jpg",
    cardTiers: ["c"],
    figureCardTiers: ["c"],
  },
  {
    identity: "hwasun-lee",
    gender: "female",
    accountIds: ["hwasun.lee"],
    workdaySearchIds: ["hwasun.lee"],
    nameIncludes: ["이화선"],
    photo: "./assets/player-photos/hwasun-lee.jpg",
    cardTiers: ["c"],
    figureCardTiers: ["c"],
  },
  {
    identity: "hyungjin-son",
    accountIds: ["hyungjin.son"],
    workdaySearchIds: ["hyungjin.son"],
    nameIncludes: ["손형진"],
    photo: "./assets/player-photos/hyungjin-son.jpg",
    cardTiers: ["a", "b"],
    figureCardTiers: ["a"],
  },
  {
    identity: "jh723-paek",
    accountIds: ["jh723.paek"],
    workdaySearchIds: ["jh723.paek"],
    nameIncludes: ["박정훈"],
    photo: "./assets/player-photos/jh723-paek.jpg",
    cardTiers: ["a", "b"],
    figureCardTiers: ["a"],
  },
  {
    identity: "kkook-kang",
    accountIds: ["kkook.kang"],
    workdaySearchIds: ["kkook.kang"],
    nameIncludes: ["강경국"],
    photo: "./assets/player-photos/kkook-kang.jpg",
    cardTiers: ["s"],
    figureCardTiers: ["s"],
  },
  {
    identity: "eunjun-ko",
    accountIds: ["yheejjko", "yheejj.ko"],
    workdaySearchIds: ["yheejj.ko"],
    nameIncludes: ["고은준"],
    photo: "./assets/player-photos/eunjun-ko.jpg",
    cardTiers: ["b"],
    figureCardTiers: ["b"],
  },
  {
    identity: "seokki-hong",
    accountIds: ["seokki.hong"],
    workdaySearchIds: ["seokki.hong"],
    nameIncludes: ["홍석기"],
    photo: "./assets/player-photos/seokki-hong.jpg",
    cardTiers: ["a", "b"],
    figureCardTiers: ["a"],
  },
  {
    identity: "sooyeon-jin",
    gender: "female",
    accountIds: ["sooyeon.jin"],
    workdaySearchIds: ["sooyeon.jin"],
    nameIncludes: ["진수연"],
    photo: "./assets/player-photos/sooyeon-jin.jpg",
    cardTiers: ["b", "c"],
    figureCardTiers: ["b"],
  },
  {
    identity: "dohun-lee",
    accountIds: ["dokun.lee"],
    workdaySearchIds: ["dokun.lee"],
    nameIncludes: ["이도훈"],
    photo: "./assets/player-photos/dohun-lee.jpg",
    cardTiers: ["c"],
    figureCardTiers: ["c"],
  },
  {
    identity: "yehyang-jang",
    gender: "female",
    accountIds: ["sjg036813", "yhj.jang"],
    workdaySearchIds: ["yhj.jang"],
    nameIncludes: ["장예향"],
    photo: "./assets/player-photos/yehyang-jang.jpg",
    cardTiers: ["b"],
    figureCardTiers: ["b"],
  },
  {
    identity: "suyeon-lee",
    gender: "female",
    accountIds: ["suyeon.lee"],
    workdaySearchIds: ["suyeon6.lee"],
    nameIncludes: ["이수연"],
    photo: "./assets/player-photos/suyeon-lee.jpg",
    cardTiers: ["b", "c"],
    figureCardTiers: ["b"],
  },
  {
    identity: "yh5626-lee",
    accountIds: ["yh5626.lee"],
    workdaySearchIds: ["yh5626.lee"],
    nameIncludes: ["이영현"],
    photo: "./assets/player-photos/yh5626-lee.jpg",
    cardTiers: ["a", "b"],
    figureCardTiers: ["a"],
  },
  {
    identity: "youngseo-lee",
    accountIds: ["youngs2o.lee"],
    workdaySearchIds: ["youngs2o.lee"],
    nameIncludes: ["이영서"],
    photo: "./assets/player-photos/youngseo-lee.jpg",
    cardTiers: ["b"],
    figureCardTiers: ["b"],
  },
  {
    identity: "haeseul-jeong",
    gender: "female",
    accountIds: ["hae3.jeong"],
    workdaySearchIds: [],
    nameIncludes: ["정해슬"],
    photo: "./assets/player-photos/haeseul-jeong.jpg",
    cardTiers: ["b"],
    figureCardTiers: ["b"],
  },
  {
    identity: "yeseul-lee",
    gender: "female",
    accountIds: ["yeseull.lee"],
    workdaySearchIds: ["yeseull.lee"],
    nameIncludes: ["이예슬"],
    photo: "./assets/player-photos/yeseul-lee.jpg",
    cardTiers: ["c"],
    figureCardTiers: ["c"],
  },
  {
    identity: "kyungtae-kim",
    accountIds: ["akpk.kim"],
    workdaySearchIds: ["akpk.kim"],
    nameIncludes: ["김경태"],
    photo: "./assets/player-photos/kyungtae-kim.jpg",
    cardTiers: ["b"],
    figureCardTiers: ["b"],
  },
  {
    identity: "sehwan-ki",
    accountIds: ["sehwan"],
    workdaySearchIds: ["sehwan"],
    nameIncludes: [],
    photo: "./assets/player-photos/sehwan-ki.jpg",
    cardTiers: ["s"],
    figureCardTiers: ["s"],
  },
  {
    identity: "hanseul-jeon",
    gender: "female",
    accountIds: ["hanseul.jeon"],
    workdaySearchIds: ["hanseul.jeon"],
    nameIncludes: ["전한슬"],
    photo: "./assets/player-photos/hanseul-jeon.jpg",
    cardTiers: ["c"],
    figureCardTiers: ["c"],
  },
  {
    identity: "wonjoon-cho",
    accountIds: ["june", "wonjoons.cho"],
    workdaySearchIds: ["wonjoons.cho"],
    nameIncludes: ["조원준"],
    photo: "./assets/player-photos/wonjoon-cho.jpg",
    cardTiers: ["b"],
    figureCardTiers: ["b"],
  },
];

const cardFinishByTier = {
  s: "hologram",
  a: "gold",
  b: "silver",
  c: "bronze",
};

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

function playerCardGender(player) {
  return playerCardProfile(player)?.gender || "male";
}

function defaultPlayerCardArtUrl(player, tierKey) {
  const normalizedTier = tierKey === "unranked" ? "c" : tierKey;
  if (playerCardGender(player) === "female") {
    return `./assets/player-cards/female-${normalizedTier}-figure.jpg`;
  }
  return `./assets/player-cards/male-${normalizedTier}-figure.jpg`;
}

function playerCardTier(player) {
  const rating = Number(player?.rating ?? player?.seedRating);
  if (!Number.isFinite(rating)) {
    return {
      key: "unranked",
      label: "등록 대기",
      art: defaultPlayerCardArtUrl(player, "c"),
    };
  }
  if (rating >= 1700) {
    return { key: "s", label: "S CLASS", art: defaultPlayerCardArtUrl(player, "s") };
  }
  if (rating >= 1500) {
    return { key: "a", label: "A CLASS", art: defaultPlayerCardArtUrl(player, "a") };
  }
  if (rating >= 1300) {
    return { key: "b", label: "B CLASS", art: defaultPlayerCardArtUrl(player, "b") };
  }
  return { key: "c", label: "C CLASS", art: defaultPlayerCardArtUrl(player, "c") };
}

function playerCardArtUrl(player, tier) {
  const profile = playerCardProfile(player);
  if (!profile) {
    return tier.art;
  }

  const cardTier = tier.key === "unranked" ? "c" : tier.key;
  if (profile.figureCardTiers?.includes(cardTier)) {
    return `./assets/player-cards/${profile.identity}-${cardTier}-figure.jpg`;
  }

  if (!profile.cardTiers.includes(cardTier)) {
    return tier.art;
  }

  const cardFinish = cardFinishByTier[cardTier];
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

function renderPlayerHonorBadgeItems(honors = []) {
  return honors.map((honor) => `
    <span class="player-honor ${escapeHtml(honor.className || "")}">${escapeHtml(honor.label)}</span>
  `).join("");
}

function renderPlayerHonorBadges(honors = []) {
  if (!honors.length) {
    return "";
  }

  return `
    <span class="player-honor-list" aria-label="선수 칭호">
      ${renderPlayerHonorBadgeItems(honors)}
    </span>
  `;
}

function setPlayerCardHonors(element, honors = []) {
  if (!element) {
    return;
  }
  element.innerHTML = renderPlayerHonorBadgeItems(honors);
  element.hidden = !honors.length;
}

function renderRankingPlayerName(player, options = {}) {
  const displayName = playerDisplayName(player, options);
  const nameMarkup = playerAccountId(player)
    ? `
      <button class="player-name-button" type="button" data-show-player-card="${escapeHtml(player.id)}" aria-label="${escapeHtml(`${displayName} 선수 카드 보기`)}">
        ${escapeHtml(displayName)}
      </button>
    `
    : `<span class="player-name">${escapeHtml(displayName)}</span>`;
  const honorMarkup = renderPlayerHonorBadges(player.honors);
  const combinedMarkup = `${nameMarkup}${honorMarkup}`;

  if (!playerAccountId(player)) {
    return `<span class="player-name-with-honors">${combinedMarkup}</span>`;
  }

  return `
    <span class="player-name-with-honors">
      ${combinedMarkup}
    </span>
  `;
}

function renderRankingPlayerAvatar(player) {
  const displayName = playerDisplayName(player);
  if (!playerAccountId(player)) {
    return renderPlayerAvatar(player);
  }

  return `
    <button class="avatar-button" type="button" data-show-player-card="${escapeHtml(player.id)}" aria-label="${escapeHtml(`${displayName} 선수 카드 보기`)}">
      ${renderPlayerAvatar(player)}
    </button>
  `;
}

function renderPlayerAvatar(player) {
  const photoUrl = playerPhotoUrl(player);
  if (photoUrl) {
    return `<img class="avatar avatar--photo" src="${escapeHtml(photoUrl)}" alt="${escapeHtml(playerDisplayName(player))} 사진" loading="lazy" decoding="async">`;
  }
  return `<span class="avatar">${escapeHtml(player?.name?.slice(0, 1) || "?")}</span>`;
}

function cardStickersForPlayer(playerId) {
  return state.cardStickers.filter((sticker) => sticker.playerId === playerId);
}

function ownCardStickers() {
  return state.cardStickers.filter((sticker) => sticker.ownedByCurrentUser);
}

function ownStickerPlacement(stickerId) {
  return ownCardStickers().find((sticker) => sticker.stickerId === stickerId) || null;
}

function defaultStickerRotation(stickerId) {
  const index = playerStickerCatalog.findIndex((sticker) => sticker.id === stickerId);
  const rotations = [-12, 9, -5, 14, -16, 7, -9, 12, -4, 10];
  return rotations[Math.max(0, index) % rotations.length];
}

function renderPlayerCardStickers(playerId) {
  const layer = $("#rankingPlayerStickerLayer");
  if (!layer) {
    return;
  }

  layer.innerHTML = cardStickersForPlayer(playerId).map((placement) => {
    const sticker = playerStickerById.get(placement.stickerId);
    if (!sticker) {
      return "";
    }
    const ownClass = placement.ownedByCurrentUser ? " is-own" : "";
    const removeButton = placement.ownedByCurrentUser
      ? `
        <button
          class="card-sticker__remove"
          type="button"
          data-remove-card-sticker="${escapeHtml(placement.stickerId)}"
          aria-label="${escapeHtml(sticker.label)} 스티커 떼기"
          title="떼기"
        >×</button>
      `
      : "";

    return `
      <div
        class="card-sticker${ownClass}"
        data-card-sticker-id="${escapeHtml(placement.stickerId)}"
        style="left: ${placement.x}%; top: ${placement.y}%; --sticker-rotation: ${placement.rotation}deg; --sticker-scale: ${placement.scale};"
        title="${escapeHtml(sticker.label)}"
      >
        <span class="card-sticker__emoji">${escapeHtml(sticker.emoji)}</span>
        ${removeButton}
      </div>
    `;
  }).join("");
}

function renderStickerPanel(player) {
  const panel = $("#playerStickerPanel");
  if (!panel) {
    return;
  }

  const user = getCurrentUser();
  panel.hidden = !player || !user;
  if (!player || !user) {
    panel.innerHTML = "";
    return;
  }

  const usedCount = ownCardStickers().length;
  panel.innerHTML = `
    <div class="player-sticker-panel__head">
      <strong>내 스티커</strong>
      <span>${playerStickerCatalog.length - usedCount}/${playerStickerCatalog.length}</span>
    </div>
    <div class="player-sticker-grid">
      ${playerStickerCatalog.map((sticker) => {
        const placement = ownStickerPlacement(sticker.id);
        const usedOnThisCard = placement?.playerId === player.id;
        const unavailable = placement && !usedOnThisCard;
        const stateText = usedOnThisCard ? "붙임" : unavailable ? "사용중" : "";
        return `
          <button
            class="sticker-tile${placement ? " is-used" : ""}${usedOnThisCard ? " is-on-current-card" : ""}"
            type="button"
            data-sticker-drag="${escapeHtml(sticker.id)}"
            ${unavailable || usedOnThisCard ? "disabled" : ""}
            aria-label="${escapeHtml(sticker.label)} 스티커"
            title="${escapeHtml(stateText || `${player.name} 카드에 드래그`)}"
          >
            <span>${escapeHtml(sticker.emoji)}</span>
            ${stateText ? `<small>${escapeHtml(stateText)}</small>` : ""}
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function renderPlayerCardStickerUi(player) {
  renderPlayerCardStickers(player?.id || "");
  renderStickerPanel(player);
}

function currentOpenCardPlayer() {
  if (!openCardPlayerId) {
    return null;
  }
  const standings = getStandings();
  return standings.find((player) => player.id === openCardPlayerId)
    || state.players.find((player) => player.id === openCardPlayerId)
    || null;
}

function cardStickerDropPosition(event) {
  const card = $("#rankingPlayerCard");
  if (!card) {
    return null;
  }
  const rect = card.getBoundingClientRect();
  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  ) {
    return null;
  }
  return {
    x: round1(clampNumber(((event.clientX - rect.left) / rect.width) * 100, 0, 100)),
    y: round1(clampNumber(((event.clientY - rect.top) / rect.height) * 100, 0, 100)),
  };
}

function createStickerGhost(stickerId, event) {
  const sticker = playerStickerById.get(stickerId);
  if (!sticker) {
    return null;
  }
  const ghost = document.createElement("div");
  ghost.className = "sticker-drag-ghost";
  if (event.pointerType === "touch") {
    ghost.classList.add("is-touch");
  }
  ghost.textContent = sticker.emoji;
  ($("#playerCardDialog") || document.body).appendChild(ghost);
  moveStickerGhost(ghost, event);
  return ghost;
}

function moveStickerGhost(ghost, event) {
  ghost.style.left = `${event.clientX}px`;
  ghost.style.top = `${event.clientY}px`;
}

function cancelStickerDrag() {
  if (stickerDrag?.ghost) {
    stickerDrag.ghost.remove();
  }
  stickerDrag = null;
  document.removeEventListener("pointermove", moveStickerDrag);
  document.removeEventListener("pointerup", finishStickerDrag);
  document.removeEventListener("pointercancel", cancelStickerDrag);
}

function moveStickerDrag(event) {
  if (!stickerDrag || event.pointerId !== stickerDrag.pointerId) {
    return;
  }
  moveStickerGhost(stickerDrag.ghost, event);
}

function finishStickerDrag(event) {
  if (!stickerDrag || event.pointerId !== stickerDrag.pointerId) {
    return;
  }

  const drag = stickerDrag;
  const position = cardStickerDropPosition(event);
  cancelStickerDrag();
  if (!position || !openCardPlayerId) {
    return;
  }

  const existing = ownStickerPlacement(drag.stickerId);
  savePlayerCardSticker(openCardPlayerId, drag.stickerId, {
    ...position,
    rotation: existing?.rotation ?? defaultStickerRotation(drag.stickerId),
    scale: existing?.scale ?? 1,
  }).catch(showApiError);
}

function startStickerDrag(stickerId, event) {
  if (!getCurrentUser() || !openCardPlayerId || !playerStickerById.has(stickerId)) {
    return;
  }
  if (event.pointerType === "mouse" && event.button !== 0) {
    return;
  }

  const existing = ownStickerPlacement(stickerId);
  if (existing && existing.playerId !== openCardPlayerId) {
    showToast("이미 다른 선수 카드에 붙인 스티커입니다.");
    return;
  }

  event.preventDefault();
  cancelStickerDrag();
  stickerDrag = {
    stickerId,
    pointerId: event.pointerId,
    ghost: createStickerGhost(stickerId, event),
  };
  document.addEventListener("pointermove", moveStickerDrag);
  document.addEventListener("pointerup", finishStickerDrag);
  document.addEventListener("pointercancel", cancelStickerDrag);
}

async function savePlayerCardSticker(playerId, stickerId, placement) {
  if (!requireLogin()) {
    return;
  }
  const scrollSnapshot = captureAppScroll();
  try {
    applyStickerServerState(
      await apiFetch(`/api/players/${encodeURIComponent(playerId)}/stickers/${encodeURIComponent(stickerId)}`, {
        method: "PUT",
        body: placement,
      }),
      scrollSnapshot,
    );
    showToast("스티커를 붙였습니다.");
  } catch (error) {
    showApiError(error);
  }
}

async function deletePlayerCardSticker(playerId, stickerId) {
  if (!requireLogin()) {
    return;
  }
  const scrollSnapshot = captureAppScroll();
  try {
    applyStickerServerState(
      await apiFetch(`/api/players/${encodeURIComponent(playerId)}/stickers/${encodeURIComponent(stickerId)}`, {
        method: "DELETE",
      }),
      scrollSnapshot,
    );
    showToast("스티커를 뗐습니다.");
  } catch (error) {
    showApiError(error);
  }
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
      { preserveScroll: true },
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
      { preserveScroll: true },
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
    applyServerState(await apiFetch(`/api/players/${encodeURIComponent(playerId)}`, { method: "DELETE" }), { preserveScroll: true });
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
      { preserveScroll: true },
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
    applyServerState(await apiFetch(`/api/matches/${encodeURIComponent(matchId)}`, { method: "DELETE" }), { preserveScroll: true });
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

function stepScore(inputId, delta) {
  const input = $(`#${inputId}`);
  if (!input || input.disabled) return;

  const min = Number.isFinite(Number(input.min)) ? Number(input.min) : 0;
  const max = Number.isFinite(Number(input.max)) ? Number(input.max) : 99;
  const current = Number(input.value);
  const next = clampNumber((Number.isFinite(current) ? current : min) + delta, min, max);
  input.value = String(next);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function resetMatchEntryDefaults() {
  setDefaultMatchPlayedAt(true);
  ["#scoreA", "#scoreB"].forEach((selector) => {
    const input = $(selector);
    if (input) {
      input.value = "21";
    }
  });
  renderPreview();
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
    resetMatchEntryDefaults();
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
      { preserveScroll: true },
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

function render(options = {}) {
  const standings = getStandings();
  renderAuth(standings);
  renderSummary(standings);
  renderSelects(standings);
  renderSettings();
  renderQueue(options);
  renderRankings(standings, options);
  renderMyHistory(options);
  renderPartnerStats(options);
  renderOpponentStats(options);
  renderHistory(options);
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
    setPlayerCardHonors($("#currentHonorBadges"), player?.honors || []);
    $("#currentPlayerCardRating").textContent = player ? Math.round(player.rating).toLocaleString("ko-KR") : "--";
    $("#currentPlayerCardRank").textContent = rank ? `#${rank}` : "--";
    $("#currentPlayerCardManner").textContent = player ? Number(player.mannerVotes || 0).toLocaleString("ko-KR") : "0";
  }

  const userList = $("#userList");
  const userPage = paginatedItems("users", state.users);
  userList.innerHTML = userPage.items
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
          <div class="user-row-line user-row-line--primary">
            <strong class="user-row-name">${escapeHtml(entry.displayName)}</strong>
            ${renderUserPlayerLink(entry)}
          </div>
          <div class="user-row-line user-row-line--secondary">
            <span class="user-row-meta">${escapeHtml(entry.username)} · ${roleLabel(entry.role)} · ${playerInfo}${isCurrent ? " · 현재" : ""}</span>
            <div class="row-actions user-row-actions">
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
          </div>
        </li>
      `;
    })
    .join("");
  renderPagination("users", isAdmin() ? state.users.length : 0);
}

function renderSummary(standings) {
  $("#playerCount").textContent = getActivePlayers().length;
  $("#matchCount").textContent = state.matches.length;
  $("#averageRating").textContent = standings.length ? Math.round(average(standings.map((player) => player.rating))) : 0;
  $("#todayVisitorCount").textContent = state.visitorStats.today.toLocaleString("ko-KR");
  $("#totalVisitorCount").textContent = state.visitorStats.total.toLocaleString("ko-KR");
}

function renderSelects(standings) {
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
  $$("[data-score-step]").forEach((button) => {
    button.disabled = !loggedIn;
  });
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

function renderRankings(standings, options = {}) {
  const body = $("#rankingBody");
  const empty = $("#rankingEmpty");
  const focusPlayerId = focusedRankingPlayerId(standings);
  const activeRows = standings.map((player, index) => {
      const rank = index + 1;
      const tier = playerCardTier(player);
      const rankClass = `rank-pill rank-pill--${tier.key}`;
      const focusClass = player.id === focusPlayerId ? "is-ranking-focus" : "";
      const ariaCurrent = player.id === focusPlayerId ? ` aria-current="true"` : "";
      const winRate = player.games ? `${Math.round(player.winRate * 100)}%` : "-";
      const hasPeakRating = player.peakRating != null && Number.isFinite(Number(player.peakRating));
      const peakRating = hasPeakRating ? Number(player.peakRating).toFixed(1) : "";
      const peakDate = hasPeakRating && player.peakRatingAt ? formatDateOnly(player.peakRatingAt) : "";
      const peakDelta = hasPeakRating ? round1(player.rating - Number(player.peakRating)) : null;
      const peakDeltaClass = peakDelta >= 0 ? "peak-delta--up" : "peak-delta--down";
      const peakMarkup = hasPeakRating
        ? `
            <div class="peak-rating-line">
              <strong>${peakRating}</strong>
              <span class="peak-delta ${peakDeltaClass}">${formatSigned(peakDelta)}</span>
            </div>
            <span class="peak-date">${peakDate}</span>
          `
        : "";
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
              ${renderRankingPlayerAvatar(player)}
              <div class="player-meta">
                ${renderRankingPlayerName(player, { managerBadge: true })}
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
          <td class="peak-rating">
            ${peakMarkup}
          </td>
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
                ${renderRankingPlayerAvatar(player)}
                <div class="player-meta">
                  ${renderRankingPlayerName(player, { managerBadge: true })}
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
            <td class="peak-rating">-</td>
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
  if (!shouldPreserveScroll(options)) {
    scrollRankingToFocus(focusPlayerId);
  }
}

function openPlayerCardDialog(playerId) {
  const standings = getStandings();
  const player = standings.find((entry) => entry.id === playerId)
    || state.players.find((entry) => entry.id === playerId);
  const dialog = $("#playerCardDialog");
  if (!player || !dialog) {
    return;
  }

  const accountId = playerAccountId(player);
  if (!accountId) {
    return;
  }

  const tier = playerCardTier(player);
  const rank = standings.findIndex((entry) => entry.id === player.id) + 1;
  const role = playerAccountRole(player);
  const rating = Number(player.rating ?? player.seedRating);
  const card = $("#rankingPlayerCard");
  const cardArt = $("#rankingPlayerCardArt");
  const roleBadge = $("#rankingPlayerCardRoleBadge");

  card.className = `player-card player-card--${tier.key}`;
  cardArt.src = playerCardArtUrl(player, tier);
  cardArt.alt = `${tier.label} 배드민턴 선수 카드 아트`;
  $("#rankingPlayerCardTier").textContent = tier.label;
  $("#rankingPlayerCardName").textContent = playerCardDisplayName(player);
  $("#rankingPlayerCardHandle").textContent = accountId ? `@${accountId}` : "";
  roleBadge.textContent = role ? roleLabel(role) : "";
  roleBadge.hidden = !role;
  setPlayerCardHonors($("#rankingPlayerCardHonorBadges"), player.honors || []);
  $("#rankingPlayerCardRating").textContent = Number.isFinite(rating) ? Math.round(rating).toLocaleString("ko-KR") : "--";
  $("#rankingPlayerCardRank").textContent = rank > 0 ? `#${rank}` : "--";
  $("#rankingPlayerCardManner").textContent = Number(player.mannerVotes || 0).toLocaleString("ko-KR");
  openCardPlayerId = player.id;
  renderPlayerCardStickerUi(player);

  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function closePlayerCardDialog() {
  const dialog = $("#playerCardDialog");
  if (!dialog?.open) {
    return;
  }
  if (typeof dialog.close === "function") {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
  openCardPlayerId = "";
  cancelStickerDrag();
  renderPlayerCardStickerUi(null);
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

function opponentStatsForPlayer(ownPlayer) {
  const statsByOpponent = new Map();

  sortedMatches().forEach((match) => {
    const ownSide = match.teamA.includes(ownPlayer.id) ? "A" : match.teamB.includes(ownPlayer.id) ? "B" : "";
    if (!ownSide) {
      return;
    }

    const opponentIds = ownSide === "A" ? match.teamB : match.teamA;
    const ownDelta = Number(match.changes.find((change) => change.id === ownPlayer.id)?.delta || 0);

    opponentIds.forEach((opponentId) => {
      const opponent = state.players.find((player) => player.id === opponentId);
      if (!opponent) {
        return;
      }

      const current = statsByOpponent.get(opponentId) || {
        opponent,
        wins: 0,
        losses: 0,
        totalDelta: 0,
        lastPlayed: null,
      };
      current.wins += match.winner === ownSide ? 1 : 0;
      current.losses += match.winner === ownSide ? 0 : 1;
      current.totalDelta = round1(current.totalDelta + ownDelta);
      current.lastPlayed = !current.lastPlayed || matchOrderTime(match) > new Date(current.lastPlayed).getTime()
        ? matchPlayedAt(match)
        : current.lastPlayed;
      statsByOpponent.set(opponentId, current);
    });
  });

  return [...statsByOpponent.values()]
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
      return a.opponent.name.localeCompare(b.opponent.name, "ko-KR");
    });
}

function renderPartnerStats(options = {}) {
  const list = $("#partnerStatsList");
  const empty = $("#partnerStatsEmpty");
  const emptyText = $("#partnerStatsEmptyText");
  const ownPlayer = currentUserPlayer();
  const stats = ownPlayer ? partnerStatsForPlayer(ownPlayer) : [];
  const ownName = ownPlayer ? playerDisplayName(ownPlayer) : "";
  const statPage = paginatedItems("partnerStats", stats);

  list.innerHTML = statPage.items
    .map((stat, index) => {
      const deltaClass = stat.totalDelta > 0 ? "partner-delta--win" : stat.totalDelta < 0 ? "partner-delta--loss" : "";
      return `
        <li class="partner-stat-item">
          <span class="rank-pill">${statPage.start + index + 1}</span>
          <div class="partner-stat-main">
            <span class="partner-stat-line"><strong>${escapeHtml(ownName)} / ${escapeHtml(playerDisplayName(stat.partner))}</strong> ${stat.wins}승 ${stat.losses}패 <span class="partner-delta ${deltaClass}">(${formatSigned(stat.totalDelta)})</span></span>
          </div>
        </li>
      `;
    })
    .join("");
  if (!shouldPreserveScroll(options)) {
    list.scrollTop = 0;
  }
  renderPagination("partnerStats", stats.length);

  if (!getCurrentUser()) {
    emptyText.textContent = "로그인하면 파트너별 기록을 볼 수 있습니다.";
  } else if (!ownPlayer) {
    emptyText.textContent = "계정에 연결된 선수가 없습니다.";
  } else {
    emptyText.textContent = "아직 파트너별 기록이 없습니다.";
  }

  empty.classList.toggle("is-visible", stats.length === 0);
}

function renderOpponentStats(options = {}) {
  const list = $("#opponentStatsList");
  const empty = $("#opponentStatsEmpty");
  const emptyText = $("#opponentStatsEmptyText");
  const ownPlayer = currentUserPlayer();
  const stats = ownPlayer ? opponentStatsForPlayer(ownPlayer) : [];
  const ownName = ownPlayer ? playerDisplayName(ownPlayer) : "";
  const statPage = paginatedItems("opponentStats", stats);

  list.innerHTML = statPage.items
    .map((stat, index) => {
      const deltaClass = stat.totalDelta > 0 ? "partner-delta--win" : stat.totalDelta < 0 ? "partner-delta--loss" : "";
      return `
        <li class="partner-stat-item">
          <span class="rank-pill">${statPage.start + index + 1}</span>
          <div class="partner-stat-main">
            <span class="partner-stat-line"><strong>${escapeHtml(ownName)} vs ${escapeHtml(playerDisplayName(stat.opponent))}</strong> ${stat.wins}승 ${stat.losses}패 <span class="partner-delta ${deltaClass}">(${formatSigned(stat.totalDelta)})</span></span>
          </div>
        </li>
      `;
    })
    .join("");
  if (!shouldPreserveScroll(options)) {
    list.scrollTop = 0;
  }
  renderPagination("opponentStats", stats.length);

  if (!getCurrentUser()) {
    emptyText.textContent = "로그인하면 상대별 기록을 볼 수 있습니다.";
  } else if (!ownPlayer) {
    emptyText.textContent = "계정에 연결된 선수가 없습니다.";
  } else {
    emptyText.textContent = "아직 상대별 기록이 없습니다.";
  }

  empty.classList.toggle("is-visible", stats.length === 0);
}

function matchParticipantIds(match) {
  return [...(match.teamA || []), ...(match.teamB || [])];
}

function mannerVotesForMatch(matchId) {
  return state.mannerVotes.filter((vote) => vote.matchId === matchId);
}

function mannerVoteCountForPlayer(matchId, playerId) {
  return mannerVotesForMatch(matchId).filter((vote) => vote.targetPlayerId === playerId).length;
}

function currentMannerVoteForMatch(match) {
  const ownPlayer = currentUserPlayer();
  if (!ownPlayer) {
    return null;
  }
  return mannerVotesForMatch(match.id).find((vote) => vote.voterPlayerId === ownPlayer.id) || null;
}

function canVoteForMannerTarget(match, playerId) {
  const ownPlayer = currentUserPlayer();
  const participants = matchParticipantIds(match);
  return Boolean(
    getCurrentUser()
    && ownPlayer
    && participants.includes(ownPlayer.id)
    && participants.includes(playerId)
    && ownPlayer.id !== playerId,
  );
}

function renderMannerThumbs(count, selected = false) {
  if (!count) {
    return "";
  }

  const visibleCount = Math.min(3, count);
  const thumbs = Array.from({ length: visibleCount }, (_, index) => (
    `<span class="manner-thumb" aria-hidden="true" style="--thumb-index: ${index}">👍</span>`
  )).join("");
  return `
    <span class="manner-thumbs ${selected ? "is-selected" : ""}" aria-label="매너 투표 ${count}개">
      ${thumbs}
    </span>
  `;
}

function renderHistoryPlayer(match, playerId) {
  const player = state.players.find((entry) => entry.id === playerId);
  const name = playerDisplayName(player);
  const voteCount = mannerVoteCountForPlayer(match.id, playerId);
  const currentVote = currentMannerVoteForMatch(match);
  const selected = currentVote?.targetPlayerId === playerId;
  const thumbs = renderMannerThumbs(voteCount, selected);

  if (!canVoteForMannerTarget(match, playerId)) {
    return `<span class="history-player-name">${escapeHtml(name)}${thumbs}</span>`;
  }

  return `
    <button
      class="history-player-name manner-vote-button ${selected ? "is-selected" : ""}"
      type="button"
      data-manner-vote-match="${escapeHtml(match.id)}"
      data-manner-vote-target="${escapeHtml(playerId)}"
      aria-label="${escapeHtml(`${name}에게 매너 투표`)}"
    >${escapeHtml(name)}${thumbs}</button>
  `;
}

function renderHistoryTeam(match, playerIds) {
  return playerIds.map((playerId) => renderHistoryPlayer(match, playerId)).join("");
}

async function toggleMannerVote(matchId, targetPlayerId) {
  if (!requireLogin()) return;
  const match = state.matches.find((entry) => entry.id === matchId);
  const currentVote = match ? currentMannerVoteForMatch(match) : null;
  try {
    applyServerState(
      await apiFetch(`/api/matches/${encodeURIComponent(matchId)}/manner-vote`, {
        method: "PUT",
        body: { targetPlayerId },
      }),
      { preserveScroll: true },
    );
    showToast(currentVote?.targetPlayerId === targetPlayerId ? "매너 투표를 취소했습니다." : "매너 투표를 반영했습니다.");
  } catch (error) {
    showApiError(error);
  }
}

function renderHistoryItem(match) {
  const teamA = renderHistoryTeam(match, match.teamA);
  const teamB = renderHistoryTeam(match, match.teamB);
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
    : "";

  return `
    <li class="history-item">
      <div class="history-date-group">
        <time class="history-date" datetime="${escapeHtml(matchPlayedAt(match))}">${formatDate(matchPlayedAt(match))}</time>
        ${actions ? `<div class="history-date-actions">${actions}</div>` : ""}
      </div>
      <div class="history-main">
        <div class="teams-line">
          <span class="team-name ${match.winner === "A" ? "team-name--winner" : ""}">${teamA}</span>
          <span class="score-badge">${match.scoreA}</span>
          <span class="team-name ${match.winner === "B" ? "team-name--winner" : ""}">${teamB}</span>
          <span class="score-badge">${match.scoreB}</span>
        </div>
        <p class="history-sub">A ${formatSigned(deltaA)} / B ${formatSigned(deltaB)} · 기대승률 ${Math.round(match.expectedA * 100)}% : ${Math.round(match.expectedB * 100)}% · 입력 ${escapeHtml(match.createdByName || "알 수 없음")}${editedText}</p>
      </div>
    </li>
  `;
}

function renderMyHistory(options = {}) {
  const list = $("#myHistoryList");
  const empty = $("#myHistoryEmpty");
  const emptyText = $("#myHistoryEmptyText");
  const ownPlayer = currentUserPlayer();
  const myMatches = ownPlayer
    ? sortedMatches().filter((match) => [...match.teamA, ...match.teamB].includes(ownPlayer.id)).reverse()
    : [];
  const matchPage = paginatedItems("myHistory", myMatches);

  list.innerHTML = matchPage.items.map(renderHistoryItem).join("");
  if (!shouldPreserveScroll(options)) {
    list.scrollTop = 0;
  }
  renderPagination("myHistory", myMatches.length);

  if (!getCurrentUser()) {
    emptyText.textContent = "로그인하면 나의 경기 기록을 볼 수 있습니다.";
  } else if (!ownPlayer) {
    emptyText.textContent = "계정에 연결된 선수가 없습니다.";
  } else {
    emptyText.textContent = "아직 내 경기 기록이 없습니다.";
  }

  empty.classList.toggle("is-visible", myMatches.length === 0);
}

function renderHistory(options = {}) {
  const list = $("#historyList");
  const empty = $("#historyEmpty");
  const matches = sortedMatches().reverse();
  const matchPage = paginatedItems("history", matches);

  list.innerHTML = matchPage.items.map(renderHistoryItem).join("");
  if (!shouldPreserveScroll(options)) {
    list.scrollTop = 0;
  }
  renderPagination("history", matches.length);

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
    const hasPeakRating = player.peakRating != null && Number.isFinite(Number(player.peakRating));
    const peakText = hasPeakRating && player.peakRatingAt
      ? `최고 ${Number(player.peakRating).toFixed(1)} (${formatDateOnly(player.peakRatingAt)})`
      : "최고 -";
    const honorText = player.honors?.length ? ` ${player.honors.map((honor) => honor.label).join(" ")}` : "";
    const seedRating = isAdmin() ? ` | 초기 ${Math.round(player.seedRating)}` : "";
    return [
      `${index + 1}. ${playerDisplayName(player, { managerBadge: true })}${honorText}`,
      `레이팅 ${player.rating.toFixed(1)}`,
      formatStreakText(player.streak, player.streakDelta),
      `전적 ${player.wins}승 ${player.losses}패`,
      `승률 ${winRate}`,
      `매너 ${Number(player.mannerVotes || 0)}`,
      peakText,
      lastPlayed,
    ].join(" | ") + seedRating;
  });

  if (isAdmin()) {
    state.players
      .filter((player) => player.seedRating == null || player.status === "pending")
      .forEach((player) => {
        lines.push(`-. ${playerDisplayName(player, { managerBadge: true })} | 초기 ELO 필요 | 전적 - | 승률 - | 최고 -`);
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
      { preserveScroll: true },
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
    select.addEventListener("change", renderPreview);
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

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const paginationButton = target.closest("[data-pagination-section][data-pagination-page]");
    if (paginationButton) {
      const section = paginationButton.dataset.paginationSection;
      if (Object.hasOwn(paginationState, section)) {
        paginationState[section] = Number(paginationButton.dataset.paginationPage);
        render();
      }
      return;
    }

    const scoreStepButton = target.closest("[data-score-step]");
    if (scoreStepButton) {
      stepScore(scoreStepButton.dataset.scoreStep, Number(scoreStepButton.dataset.scoreDelta));
      return;
    }

    const playerCardButton = target.closest("[data-show-player-card]");
    if (playerCardButton) {
      openPlayerCardDialog(playerCardButton.dataset.showPlayerCard);
      return;
    }

    const removeCardStickerButton = target.closest("[data-remove-card-sticker]");
    if (removeCardStickerButton) {
      if (openCardPlayerId) {
        deletePlayerCardSticker(openCardPlayerId, removeCardStickerButton.dataset.removeCardSticker);
      }
      return;
    }

    if (target.closest("[data-close-player-card]") || target === $("#playerCardDialog")) {
      closePlayerCardDialog();
      return;
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

    const mannerVoteButton = target.closest("[data-manner-vote-match][data-manner-vote-target]");
    if (mannerVoteButton) {
      toggleMannerVote(mannerVoteButton.dataset.mannerVoteMatch, mannerVoteButton.dataset.mannerVoteTarget);
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

  document.addEventListener("pointerdown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest("[data-remove-card-sticker]")) {
      return;
    }

    const paletteSticker = target.closest("[data-sticker-drag]");
    if (paletteSticker && !paletteSticker.disabled) {
      startStickerDrag(paletteSticker.dataset.stickerDrag, event);
      return;
    }

    const placedSticker = target.closest("[data-card-sticker-id].is-own");
    if (placedSticker) {
      startStickerDrag(placedSticker.dataset.cardStickerId, event);
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
