export class LiveError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const fail = (code, message, status = 400) => { throw new LiveError(status, code, message); };
export const otherTeam = (team) => team === "A" ? "B" : "A";
export const isUuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function youtubeId(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "";
    const host = url.hostname.replace(/^www\./, "");
    const id = host === "youtu.be" ? url.pathname.slice(1) :
      ["youtube.com", "m.youtube.com"].includes(host) ?
        url.searchParams.get("v") || url.pathname.match(/^\/(?:live|watch|shorts)\/([^/]+)$/)?.[1] : "";
    return /^[\w-]{11}$/.test(id || "") ? id : "";
  } catch { return ""; }
}

export function createLiveSession(input, ownerId, players, id, token, now = Date.now()) {
  const teamA = input.teamA;
  const teamB = input.teamB;
  const ids = [...(Array.isArray(teamA) ? teamA : []), ...(Array.isArray(teamB) ? teamB : [])];
  if (teamA?.length !== 2 || teamB?.length !== 2 || new Set(ids).size !== 4 ||
      ids.some((id) => !players.some((p) => p.id === id))) {
    fail("LIVE_PLAYERS", "서로 다른 등록 선수 4명을 선택하세요.");
  }
  if (!["A", "B"].includes(input.servingTeam) || !["A", "B"].includes(input.nearTeam)) {
    fail("LIVE_POSITION", "첫 서브 팀과 가까운 코트 팀을 선택하세요.");
  }
  return {
    id, ownerId, token, revision: 0, status: "ready", createdAt: now,
    teamA, teamB, initialServingTeam: input.servingTeam, initialNearTeam: input.nearTeam,
    players: ids.map((id) => { const p = players.find((p) => p.id === id); return { id, name: p.name }; }),
    startedAt: null, endedAt: null, matchId: null, videoId: "", videoOffsetSeconds: 0,
    events: [], receipts: [],
  };
}

export function liveSnapshot(session) {
  // Each pair is [left, right] from that team's perspective facing the net.
  const positions = { A: [...session.teamA], B: [...session.teamB] };
  const score = { A: 0, B: 0 };
  let servingTeam = session.initialServingTeam;
  let nearTeam = session.initialNearTeam;
  const points = [];
  for (const event of session.events) {
    if (event.undone) continue;
    if (event.type === "switchEnds") { nearTeam = otherTeam(nearTeam); continue; }
    if (event.type !== "point") continue;
    score[event.team] += 1;
    if (servingTeam === event.team) positions[event.team].reverse();
    servingTeam = event.team;
    points.push({ ...event, scoreA: score.A, scoreB: score.B });
  }
  const side = score[servingTeam] % 2 === 0 ? 1 : 0;
  return {
    scoreA: score.A, scoreB: score.B, servingTeam, nearTeam, positions,
    serverId: positions[servingTeam][side], receiverId: positions[otherTeam(servingTeam)][side],
    serviceSide: side === 1 ? "right" : "left", points,
  };
}

export function applyLiveCommand(session, command, now = Date.now()) {
  if (!isUuid(command.operationId)) fail("LIVE_OPERATION_ID", "요청 식별자가 올바르지 않습니다.");
  const signature = JSON.stringify([command.type, command.team ?? null, command.capturedAt ?? null,
    command.youtubeUrl ?? null, command.videoOffsetSeconds ?? null, command.matchEndedConfirmed ?? command.streamEndedConfirmed ?? null]);
  const previous = session.receipts.find((r) => r.id === command.operationId);
  if (previous) {
    if (previous.signature !== signature) fail("LIVE_OPERATION_REUSED", "요청 식별자가 중복되었습니다.", 409);
    return false;
  }
  if (command.expectedRevision !== session.revision) fail("LIVE_CONFLICT", "다른 화면에서 점수가 변경되었습니다. 최신 점수를 확인하세요.", 409);
  if (session.receipts.length >= 1000) fail("LIVE_LIMIT", "이 경기의 조작 횟수 한도를 초과했습니다.");
  const active = session.status === "live";
  if (command.type === "start") {
    if (session.status !== "ready") fail("LIVE_STARTED", "이미 시작한 경기입니다.", 409);
    const capturedAt = command.capturedAt === undefined ? now : command.capturedAt;
    if (!Number.isSafeInteger(capturedAt) || capturedAt < session.createdAt - 5000 || capturedAt > now + 5000) {
      fail("LIVE_TIME", "휴대폰 시간을 확인하세요. 경기 시작 시간이 올바르지 않습니다.");
    }
    session.status = "live";
    // Start and points must use the same tap clock, not server receipt latency.
    session.startedAt = capturedAt;
    session.startReceivedAt = now;
  } else if (["point", "undo", "switchEnds"].includes(command.type)) {
    if (!active) fail("LIVE_NOT_ACTIVE", "진행 중인 경기에서만 점수를 변경할 수 있습니다.", 409);
    if (command.type === "undo") {
      const last = session.events.findLast((e) => !e.undone);
      if (!last) fail("LIVE_EMPTY", "되돌릴 기록이 없습니다.");
      last.undone = true;
    } else {
      if (command.type === "point" && !["A", "B"].includes(command.team)) fail("LIVE_TEAM", "득점 팀을 선택하세요.");
      const capturedAt = command.capturedAt;
      if (!Number.isSafeInteger(capturedAt) || capturedAt < session.startedAt - 5000 || capturedAt > now + 5000) {
        fail("LIVE_TIME", "휴대폰 시간을 확인하세요. 득점 시간이 올바르지 않습니다.");
      }
      const lastTime = session.events.at(-1)?.capturedAt || session.startedAt;
      if (capturedAt < lastTime - 1000) fail("LIVE_EVENT_ORDER", "득점 시간의 순서가 올바르지 않습니다.", 409);
      session.events.push({ id: command.operationId, type: command.type,
        team: command.type === "point" ? command.team : null,
        capturedAt, receivedAt: now, elapsedMs: Math.max(0, capturedAt - session.startedAt), undone: false });
    }
  } else if (command.type === "video") {
    const id = youtubeId(command.youtubeUrl);
    const offset = Number(command.videoOffsetSeconds);
    if (!id || !Number.isFinite(offset) || Math.abs(offset) > 86400) fail("LIVE_VIDEO", "YouTube 링크와 영상 시간 보정값을 확인하세요.");
    session.videoId = id;
    session.videoOffsetSeconds = offset;
  } else if (command.type === "finish") {
    if (!active) fail("LIVE_NOT_ACTIVE", "진행 중인 경기가 아닙니다.", 409);
    if ((command.matchEndedConfirmed ?? command.streamEndedConfirmed) !== true) fail("LIVE_MATCH_CONFIRM", "이 경기의 최종 점수를 확인하세요.");
    const score = liveSnapshot(session);
    if (score.scoreA === score.scoreB) fail("LIVE_TIE", "동점 경기는 랭킹에 등록할 수 없습니다. 계속 진행하거나 기록 없이 취소하세요.");
    session.status = "finished";
    session.endedAt = now;
    session.streamEndMode = command.matchEndedConfirmed === true ? "match-only" : "user-confirmed";
  } else if (command.type === "cancel") {
    if (!["ready", "live"].includes(session.status)) fail("LIVE_ENDED", "이미 종료된 경기입니다.", 409);
    session.status = "cancelled";
    session.endedAt = now;
  } else fail("LIVE_COMMAND", "지원하지 않는 조작입니다.");
  session.revision += 1;
  session.receipts.push({ id: command.operationId, signature });
  return true;
}

export function publicLiveSession(session, owner = false, compact = false) {
  const { points, ...snapshot } = liveSnapshot(session);
  const value = {
    id: session.id, revision: session.revision, status: session.status,
    players: session.players, teamA: session.teamA, teamB: session.teamB,
    startedAt: session.startedAt, endedAt: session.endedAt, matchId: session.matchId,
    videoId: session.videoId, videoOffsetSeconds: session.videoOffsetSeconds, ...snapshot,
  };
  if (!compact) value.points = points;
  if (owner) value.overlayToken = session.token;
  return value;
}
