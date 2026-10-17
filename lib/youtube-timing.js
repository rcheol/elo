import { LiveError } from "../surge-deploy/live/engine.js";

// Never include the key or upstream errors/URLs in client responses.
export function createYouTubeTiming({ apiKey = "", fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();
  return async (videoId) => {
    if (!/^[\w-]{11}$/.test(videoId)) throw new LiveError(400, "LIVE_VIDEO", "YouTube 링크를 확인하세요.");
    if (!apiKey) return { actualStartTime: null, timingNotice: "자동 시간 조회 미설정 · 수동 보정 가능" };
    const old = cache.get(videoId);
    if (old && old.expires > now()) return old.value;
    if (pending.has(videoId)) return pending.get(videoId);
    const task = (async () => {
      let value;
      try {
        const url = new URL("https://www.googleapis.com/youtube/v3/videos");
        url.search = new URLSearchParams({ part: "liveStreamingDetails", id: videoId, fields: "items(id,liveStreamingDetails(actualStartTime))" });
        const response = await fetchImpl(url, { headers: { "X-Goog-Api-Key": apiKey }, signal: AbortSignal.timeout(10000), redirect: "error" });
        if (!response.ok) throw new Error("YouTube request failed");
        const data = await response.json();
        const timestamp = data.items?.find((entry) => entry.id === videoId)?.liveStreamingDetails?.actualStartTime;
        const start = timestamp ? Date.parse(timestamp) : NaN;
        value = Number.isFinite(start) && start > 0 && start <= now() + 5000
          ? { actualStartTime: start, timingNotice: "" }
          : { actualStartTime: null, timingNotice: "방송 시작 시각 없음 · 일반 영상, 방송 전 또는 비공개 영상은 수동 보정 필요" };
      } catch {
        value = { actualStartTime: null, timingNotice: "YouTube 시작 시각 조회 실패 · 다시 저장하거나 수동 보정 가능" };
      }
      if (cache.size >= 200) cache.delete(cache.keys().next().value);
      cache.set(videoId, { value, expires: now() + (value.actualStartTime ? 3600000 : 30000) });
      return value;
    })();
    pending.set(videoId, task);
    try { return await task; } finally { pending.delete(videoId); }
  };
}
