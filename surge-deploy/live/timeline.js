export function elapsedTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const remainder = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`;
}

const recordedTime = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export function renderTimeline(list, session, onPlay) {
  const clips = session.points.map((point) => {
    const time = Math.max(0, point.elapsedMs / 1000 + session.videoOffsetSeconds);
    return { ...point, videoId: session.videoId, time, start: Math.max(0, time - 8), end: time + 3 };
  });
  list.replaceChildren(...clips.map((point, i) => {
    const li = document.createElement("li");
    const details = document.createElement("div"); details.className = "timeline-point";
    const label = document.createElement("strong"); label.textContent = `${i + 1}. ${point.team}팀 득점 · ${point.scoreA} : ${point.scoreB}`;
    const captured = document.createElement("time"); captured.className = "point-captured";
    captured.dateTime = new Date(point.capturedAt).toISOString();
    captured.textContent = `${recordedTime.format(point.capturedAt)} KST`;
    details.append(label, captured);
    const times = document.createElement("div"); times.className = "timeline-times";
    const elapsed = document.createElement("span"); elapsed.className = "point-elapsed";
    elapsed.textContent = `경기 ${elapsedTime(point.elapsedMs / 1000)}`;
    times.append(elapsed);
    if (session.videoId) {
      if (onPlay) {
        const button = document.createElement("button"); button.disabled = true;
        button.textContent = `영상 ${elapsedTime(point.time)}`;
        button.onclick = () => onPlay(i);
        times.append(button);
      }
      const link = document.createElement("a");
      link.textContent = onPlay ? "YouTube" : `영상 ${elapsedTime(point.time)}`;
      link.target = "_blank"; link.rel = "noopener noreferrer";
      link.href = `https://www.youtube.com/watch?v=${session.videoId}&t=${Math.floor(point.time)}s`;
      times.append(link);
    }
    li.append(details, times);
    return li;
  }));
  return clips;
}
