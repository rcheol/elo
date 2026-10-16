const token = location.hash.slice(1);
const $ = (id) => document.getElementById(id);
let etag = "";
let failures = 0;
let done = false;
let last = "점수판 연결 중";
async function poll() {
  try {
    if (!/^[a-f0-9]{48}$/.test(token)) throw new Error("점수판 주소를 확인하세요");
    const response = await fetch(`/api/live/overlay/${token}`, { headers: etag ? { "If-None-Match": etag } : {}, cache: "no-cache", signal: AbortSignal.timeout(15000) });
    if (response.status !== 304) {
      if (!response.ok) throw new Error("점수판 연결을 확인하세요");
      const s = await response.json();
      etag = response.headers.get("etag") || "";
      const name = (id) => s.players.find((p) => p.id === id)?.name || "";
      for (const team of ["A", "B"]) {
        $("names" + team).textContent = s["team" + team].map(name).join(" / ");
        $("score" + team).textContent = s["score" + team];
        $("serve" + team).textContent = s.servingTeam === team && s.status === "live" ? "●" : "";
      }
      done = ["finished", "cancelled"].includes(s.status);
      last = done ? s.status === "finished" ? "경기 종료" : "기록 취소" : s.status === "ready" ? "경기 준비" : `서브 ${name(s.serverId)} · ${s.serviceSide === "right" ? "오른쪽" : "왼쪽"}`;
    }
    failures = 0; $("status").textContent = last; $("status").classList.remove("stale");
  } catch (error) { failures++; $("status").textContent = `연결 지연 · 마지막 확인 점수 유지 (${error.message})`; $("status").classList.add("stale"); }
  if (!done) setTimeout(poll, Math.min(30000, 2000 * 2 ** Math.min(failures, 4)));
}
poll();
