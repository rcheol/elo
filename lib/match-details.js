import { LiveError, isUuid, publicLiveSession, youtubeId } from "../surge-deploy/live/engine.js";

export function createMatchDetails({ store, getMatch, players, authenticate, readBody, sendJson, youtubeTiming }) {
  return async (req, res, route) => {
    const matchRoute = route.match(/^\/matches\/([^/]+)(\/video)?$/);
    if (!matchRoute) return false;
    let id;
    try { id = decodeURIComponent(matchRoute[1]); } catch { throw new LiveError(400, "MATCH_ID", "경기 식별자를 확인하세요."); }
    const match = await getMatch(id);
    if (!match) throw new LiveError(404, "MATCH_NOT_FOUND", "경기 기록을 찾을 수 없습니다.");
    const user = await authenticate(req);
    const canEdit = Boolean(user && (user.role === "admin" || match.createdBy === user.id));
    const live = await store.find("match_id", id);
    const snapshot = live?.status === "finished" ? publicLiveSession(live) : null;
    let media = await store.getMedia(id);
    if (req.method === "POST" && matchRoute[2]) {
      if (!user) throw new LiveError(401, "UNAUTHORIZED", "로그인이 필요합니다.");
      if (!canEdit) throw new LiveError(403, "MATCH_FORBIDDEN", "기록 작성자와 관리자만 영상을 연결할 수 있습니다.");
      const input = await readBody(req);
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new LiveError(400, "LIVE_VIDEO", "영상 설정을 확인하세요.");
      const videoId = youtubeId(input.youtubeUrl);
      if (!videoId || !isUuid(input.operationId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !["auto", "manual"].includes(input.timingMode)) {
        throw new LiveError(400, "LIVE_VIDEO", "YouTube 링크와 시간 설정을 확인하세요.");
      }
      if (input.timingMode === "manual" && (typeof input.videoOffsetSeconds !== "number" || !Number.isFinite(input.videoOffsetSeconds) || Math.abs(input.videoOffsetSeconds) > 86400)) {
        throw new LiveError(400, "LIVE_VIDEO", "경기 시작 장면의 영상 시간을 입력하세요.");
      }
      const signature = JSON.stringify([videoId, input.timingMode, input.timingMode === "manual" ? input.videoOffsetSeconds : null]);
      if (media?.operationId === input.operationId) {
        if (media.signature !== signature) throw new LiveError(409, "LIVE_OPERATION_REUSED", "같은 요청에 다른 영상 설정을 사용할 수 없습니다.");
      } else {
        if ((media?.revision || 0) !== input.expectedRevision) throw new LiveError(409, "LIVE_CONFLICT", "영상 설정이 변경되었습니다. 새로고침 후 확인하세요.");
        const timing = input.timingMode === "auto" && snapshot?.points.length
          ? { ...await youtubeTiming(videoId) } : { actualStartTime: null, timingNotice: "" };
        let offset = timing.actualStartTime && snapshot?.startedAt ? (snapshot.startedAt - timing.actualStartTime) / 1000 : null;
        if (offset !== null && Math.abs(offset) > 86400) {
          offset = null;
          timing.timingNotice = "방송과 경기 날짜가 일치하지 않습니다. 영상과 수동 보정값을 확인하세요.";
        }
        media = await store.saveMedia(id, input.expectedRevision, {
          videoId, timingMode: input.timingMode, actualStartTime: timing.actualStartTime,
          videoOffsetSeconds: input.timingMode === "manual" ? input.videoOffsetSeconds : offset,
          timingNotice: timing.timingNotice, operationId: input.operationId, signature,
          updatedBy: user.id, updatedAt: Date.now(), revision: input.expectedRevision + 1,
        });
      }
    } else if (req.method !== "GET" || matchRoute[2]) {
      throw new LiveError(405, "METHOD_NOT_ALLOWED", "지원하지 않는 요청입니다.");
    }
    const roster = await players();
    const ids = [...match.teamA, ...match.teamB];
    // Keep the original scoring ledger even if the final result was later edited.
    const timelineMismatch = Boolean(snapshot && (snapshot.scoreA !== match.scoreA || snapshot.scoreB !== match.scoreB ||
      JSON.stringify(snapshot.teamA) !== JSON.stringify(match.teamA) || JSON.stringify(snapshot.teamB) !== JSON.stringify(match.teamB)));
    sendJson(req, res, 200, {
      matchId: id, scoreA: match.scoreA, scoreB: match.scoreB, teamA: match.teamA, teamB: match.teamB,
      playedAt: match.playedAt || match.createdAt, createdByName: match.createdByName || "", canEdit,
      players: ids.map((id) => roster.find((p) => p.id === id) || snapshot?.players.find((p) => p.id === id) || { id, name: "삭제된 선수" }),
      points: snapshot?.points || [], startedAt: snapshot?.startedAt || null, timelineMismatch,
      videoId: media?.videoId || snapshot?.videoId || "",
      videoOffsetSeconds: media ? media.videoOffsetSeconds : snapshot?.videoId ? snapshot.videoOffsetSeconds : null,
      timingMode: media?.timingMode || (snapshot?.videoId ? "manual" : "auto"), timingNotice: media?.timingNotice || "",
      actualStartTime: media?.actualStartTime || null, mediaRevision: media?.revision || 0,
    });
    return true;
  };
}
