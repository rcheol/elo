import { renderTimeline } from "./timeline.js";

const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get("match");
let player;
let clips = [];
let index = -1;
let sequential = false;
let clipStarted = false;
let timer;
function play(i, leadIn = true) {
  index = i;
  clipStarted = false;
  document.querySelectorAll(".timeline li").forEach((li, n) => li.classList.toggle("active", n === i));
  player.loadVideoById({ videoId: clips[i].videoId, startSeconds: leadIn ? clips[i].start : clips[i].time, endSeconds: clips[i].end });
}
try {
  const response = await fetch(`/api/live/replay/${encodeURIComponent(id || "")}`);
  if (!response.ok) throw new Error("중계 기록을 찾을 수 없습니다.");
  const s = await response.json();
  const edit = document.createElement("a");
  edit.textContent = "중계 조작자 · 영상 설정";
  edit.href = `/live/control.html?session=${encodeURIComponent(s.id)}`;
  document.querySelector(".toolbar").append(edit);
  $("status").textContent = `A팀 ${s.scoreA} : ${s.scoreB} B팀 · 득점 시각 ${s.points.length}건 저장됨`;
  // Timestamps are a saved ledger, independent of video availability or the YouTube player.
  clips = renderTimeline($("timeline"), s, (i) => { sequential = false; play(i, false); });
  $("player").hidden = !s.videoId;
  $("playAll").hidden = !s.videoId;
  $("stop").hidden = !s.videoId;
  if (!s.videoId) $("status").textContent += " · 영상 미연결";
  else initializeVideo(s);
} catch (error) { $("status").textContent = error.message; $("status").className = "error"; }

function initializeVideo(s) {
  $("youtube").href = `https://www.youtube.com/watch?v=${s.videoId}`;
  $("youtube").hidden = false;
  window.onYouTubeIframeAPIReady = () => {
    player = new window.YT.Player("player", { videoId: s.videoId, playerVars: { playsinline: 1, origin: location.origin }, events: {
      onReady: () => {
        $("playAll").disabled = !clips.length; $("stop").disabled = false;
        document.querySelectorAll(".timeline button").forEach((button) => { button.disabled = false; });
      },
      onStateChange: (event) => { if (event.data === 1) clipStarted = true; },
      onError: () => { $("status").textContent = `득점 시각 ${clips.length}건 저장됨 · 영상 재생 불가 (준비 중 또는 접근 제한)`; sequential = false; },
    } });
  };
  const script = document.createElement("script"); script.src = "https://www.youtube.com/iframe_api"; document.head.append(script);
  $("playAll").onclick = () => { sequential = true; play(0); };
  $("stop").onclick = () => { sequential = false; player.pauseVideo(); };
  timer = setInterval(() => {
    if (!sequential || !clipStarted || !player?.getCurrentTime || index < 0) return;
    if (player.getCurrentTime() >= clips[index].end - .15 || player.getPlayerState() === 0) {
      if (index + 1 < clips.length) play(index + 1);
      else { sequential = false; player.pauseVideo(); }
    }
  }, 300);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
}
