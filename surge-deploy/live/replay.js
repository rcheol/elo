const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get("match");
let player;
let clips = [];
let index = -1;
let sequential = false;
let clipStarted = false;
let timer;
function play(i) {
  index = i;
  clipStarted = false;
  document.querySelectorAll(".timeline li").forEach((li, n) => li.classList.toggle("active", n === i));
  player.loadVideoById({ videoId: clips[i].videoId, startSeconds: clips[i].start, endSeconds: clips[i].end });
}
try {
  const response = await fetch(`/api/live/replay/${encodeURIComponent(id || "")}`);
  if (!response.ok) throw new Error("중계 기록을 찾을 수 없습니다.");
  const s = await response.json();
  const edit = document.createElement("a");
  edit.textContent = "중계 조작자 · 영상 설정";
  edit.href = `/live/control.html?session=${encodeURIComponent(s.id)}`;
  document.querySelector(".toolbar").append(edit);
  $("status").textContent = `A팀 ${s.scoreA} : ${s.scoreB} B팀 · ${s.points.length}번 득점`;
  if (!s.videoId) throw new Error("아직 YouTube 링크가 연결되지 않았습니다. 중계 조작자가 영상 링크를 연결해 주세요.");
  $("youtube").href = `https://www.youtube.com/watch?v=${s.videoId}`;
  $("youtube").hidden = false;
  clips = s.points.map((point) => {
    const time = Math.max(0, point.elapsedMs / 1000 + s.videoOffsetSeconds);
    return { ...point, videoId: s.videoId, time, start: Math.max(0, time - 8), end: time + 3 };
  });
  clips.forEach((point, i) => {
    const li = document.createElement("li");
    const label = document.createElement("span"); label.textContent = `${i + 1}. ${point.team}팀 득점 · ${point.scoreA} : ${point.scoreB}`;
    const button = document.createElement("button"); button.disabled = true;
    button.textContent = `${Math.floor(point.time / 60)}:${String(Math.floor(point.time % 60)).padStart(2, "0")}`;
    button.onclick = () => { sequential = false; play(i); };
    const link = document.createElement("a"); link.textContent = "영상"; link.target = "_blank"; link.rel = "noopener noreferrer";
    link.href = `https://www.youtube.com/watch?v=${s.videoId}&t=${Math.floor(point.start)}s`;
    li.append(label, button, link); $("timeline").append(li);
  });
  window.onYouTubeIframeAPIReady = () => {
    player = new window.YT.Player("player", { videoId: s.videoId, playerVars: { playsinline: 1, origin: location.origin }, events: {
      onReady: () => {
        $("playAll").disabled = !clips.length; $("stop").disabled = false;
        document.querySelectorAll(".timeline button").forEach((button) => { button.disabled = false; });
      },
      onStateChange: (event) => { if (event.data === 1) clipStarted = true; },
      onError: () => { $("status").textContent = "방송 보관 영상 준비 중이거나 삽입 재생이 제한되었습니다. YouTube 링크로 확인하세요."; sequential = false; },
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
} catch (error) { $("status").textContent = error.message; $("status").className = "error"; }
