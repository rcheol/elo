import { renderTimeline } from "./timeline.js";

const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get("match") || "";
const form = $("videoForm");
const date = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "medium" });
let session;
let player;
let ready = false;
let clips = [];
let team = "";
let index = -1;
let sequential = false;
let clipStarted = false;
let saving = false;
let pendingSave;
let timer;

async function request(body) {
  const response = await fetch(`/api/live/matches/${encodeURIComponent(id)}${body ? "/video" : ""}`, {
    credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(20000),
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.message || data.error || "기록을 불러오지 못했습니다."); error.status = response.status; throw error; }
  return data;
}

function stop() {
  sequential = false;
  if (ready) player.pauseVideo();
}

function play(i, leadIn = true) {
  if (!ready || !clips[i]?.playable) return;
  index = i;
  clipStarted = false;
  $("timeline").querySelectorAll("li").forEach((li, n) => li.classList.toggle("active", n === i));
  player.loadVideoById({ videoId: clips[i].videoId, startSeconds: leadIn ? clips[i].start : clips[i].time, endSeconds: clips[i].end });
}

function drawTimeline() {
  const points = session.points.filter((point) => !team || point.team === team);
  clips = renderTimeline($("timeline"), { ...session, points }, (i) => { sequential = false; play(i, false); });
  $("emptyTimeline").hidden = Boolean(points.length);
  $("emptyTimeline").textContent = session.points.length ? `${team}팀 득점 기록이 없습니다.` : "이 경기에는 저장된 득점 시각이 없습니다.";
  $("teamFilter").hidden = !session.points.length;
  $("playAll").disabled = !ready || !clips.some((point) => point.playable);
  $("stop").disabled = !ready;
  $("timeline").querySelectorAll("button").forEach((button) => { button.disabled = !ready; });
}

function initializeVideo() {
  if (player) { player.cueVideoById?.(session.videoId); return; }
  const initialize = () => {
    player = new window.YT.Player("player", { videoId: session.videoId, playerVars: { playsinline: 1, origin: location.origin }, events: {
      onReady: () => { ready = true; drawTimeline(); },
      onStateChange: (event) => { if (event.data === 1) clipStarted = true; },
      onError: () => { $("status").textContent = `득점 시각 ${session.points.length}건 저장됨 · 영상 재생 불가 (준비 중 또는 접근 제한)`; sequential = false; },
    } });
  };
  if (window.YT?.Player) initialize();
  else if (!document.getElementById("youtubeApi")) {
    window.onYouTubeIframeAPIReady = initialize;
    const script = document.createElement("script");
    script.id = "youtubeApi"; script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => { $("videoNotice").textContent = "동영상 플레이어를 불러오지 못했습니다. YouTube 링크로 시청할 수 있습니다."; };
    document.head.append(script);
  }
}

function render() {
  stop();
  $("matchSummary").hidden = false;
  const names = (ids) => ids.map((id) => session.players.find((p) => p.id === id)?.name || "삭제된 선수").join(" / ");
  $("namesA").textContent = names(session.teamA);
  $("namesB").textContent = names(session.teamB);
  $("scoreA").textContent = session.scoreA;
  $("scoreB").textContent = session.scoreB;
  $("matchDate").textContent = `${date.format(new Date(session.playedAt))}${session.createdByName ? ` · 기록 ${session.createdByName}` : ""}`;
  $("ledgerWarning").hidden = !session.timelineMismatch;
  $("status").textContent = `득점 시각 ${session.points.length}건 저장됨${session.videoId ? "" : " · 영상 미연결"}`;
  $("back").href = `/?match=${encodeURIComponent(id)}#historyTitle`;
  form.hidden = !session.canEdit;
  form.elements.youtubeUrl.value = session.videoId ? `https://www.youtube.com/watch?v=${session.videoId}` : "";
  form.elements.timingMode.value = session.timingMode;
  form.elements.videoOffsetSeconds.value = session.videoOffsetSeconds ?? 0;
  $("timingFields").hidden = !session.points.length;
  $("manualOffset").hidden = session.timingMode !== "manual";
  $("videoNotice").textContent = session.timingNotice || (session.actualStartTime && session.timingMode === "auto"
    ? `방송 시작 ${date.format(session.actualStartTime)} KST · 자동 연결`
    : session.videoId && session.points.length ? "영상 시간 직접 지정" : session.canEdit ? "" : "영상 연결은 기록 작성자와 관리자가 할 수 있습니다.");
  $("player").hidden = !session.videoId;
  $("youtube").hidden = !session.videoId;
  $("playAll").hidden = !session.videoId || !session.points.length;
  $("stop").hidden = !session.videoId;
  if (session.videoId) {
    $("youtube").href = `https://www.youtube.com/watch?v=${session.videoId}`;
    initializeVideo();
  }
  drawTimeline();
}

$("teamFilter").onclick = (event) => {
  const button = event.target.closest("button[data-team]");
  if (!button || !session) return;
  stop(); team = button.dataset.team;
  $("teamFilter").querySelectorAll("button").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
  drawTimeline();
};
form.elements.timingMode.onchange = () => { $("manualOffset").hidden = form.elements.timingMode.value !== "manual"; };
form.onsubmit = async (event) => {
  event.preventDefault();
  if (saving || !session?.canEdit) return;
  const settings = { youtubeUrl: form.elements.youtubeUrl.value.trim(), timingMode: form.elements.timingMode.value, videoOffsetSeconds: Number(form.elements.videoOffsetSeconds.value) };
  if (pendingSave && JSON.stringify(settings) !== pendingSave.signature) {
    $("saveStatus").textContent = "이전 저장 응답이 확인되지 않았습니다. 새로고침 후 영상 설정을 확인하세요.";
    return;
  }
  pendingSave ||= { signature: JSON.stringify(settings), body: { ...settings, operationId: crypto.randomUUID(), expectedRevision: session.mediaRevision } };
  saving = true; $("saveVideo").disabled = true; $("saveStatus").textContent = "영상 정보를 저장하는 중입니다.";
  try {
    session = await request(pendingSave.body);
    pendingSave = null; render();
    $("saveStatus").textContent = "영상 정보가 저장되었습니다.";
  } catch (error) {
    if (error.status >= 400 && error.status < 500) pendingSave = null;
    $("saveStatus").textContent = error.status ? error.message : "서버 응답을 확인하지 못했습니다. 다시 저장하면 같은 요청으로 확인합니다.";
    if (error.status === 409) { try { session = await request(); render(); } catch { /* Keep the loaded ledger available. */ } }
  } finally { saving = false; $("saveVideo").disabled = false; }
};
$("playAll").onclick = () => { const first = clips.findIndex((point) => point.playable); if (first >= 0) { sequential = true; play(first); } };
$("stop").onclick = stop;
function startTimer() {
  clearInterval(timer);
  timer = setInterval(() => {
    if (!sequential || !clipStarted || !ready || index < 0) return;
    if (player.getCurrentTime() >= clips[index].end - .15 || player.getPlayerState() === 0) {
      const next = clips.findIndex((point, i) => i > index && point.playable);
      if (next >= 0) play(next); else stop();
    }
  }, 300);
}
window.addEventListener("pagehide", () => clearInterval(timer));
window.addEventListener("pageshow", startTimer);
startTimer();
try { session = await request(); render(); }
catch (error) { $("status").textContent = error.status ? error.message : "기록을 불러오지 못했습니다. 연결을 확인하고 새로고침하세요."; $("status").className = "error"; }
