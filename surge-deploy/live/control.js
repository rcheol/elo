const $ = (selector) => document.querySelector(selector);
let current = null;
let user = null;
let busy = false;
const icons = () => window.lucide?.createIcons();
const status = (message, error = false) => { $("#status").textContent = message; $("#status").classList.toggle("error", error); };
async function request(path, body) {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...(body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  } : {}) });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.message || data.error); error.status = response.status; throw error; }
  return data;
}
function render() {
  $("#setup").hidden = Boolean(current);
  $("#session").hidden = !current;
  if (!current) return;
  $("#scoreA").textContent = current.scoreA;
  $("#scoreB").textContent = current.scoreB;
  const active = current.status === "live";
  $("#start").hidden = current.status !== "ready";
  for (const id of ["pointA", "pointB", "undo", "switch", "finish"]) $("#" + id).disabled = !active || busy;
  $("#cancel").hidden = !["ready", "live"].includes(current.status);
  $("#new").hidden = !["finished", "cancelled"].includes(current.status);
  const name = (id) => current.players.find((p) => p.id === id)?.name || "";
  $("#serve").textContent = `${name(current.serverId)} 서브 · ${current.serviceSide === "right" ? "오른쪽" : "왼쪽"} → ${name(current.receiverId)}`;
  const near = current.nearTeam;
  const far = near === "A" ? "B" : "A";
  const order = [...current.positions[far].toReversed(), ...current.positions[near]];
  $("#court").replaceChildren(...order.map((id, index) => {
    const cell = document.createElement("div");
    const label = document.createElement("small");
    label.textContent = `${index < 2 ? far : near}팀${id === current.serverId ? " · 서브" : id === current.receiverId ? " · 리시브" : ""}`;
    cell.append(label, document.createTextNode(name(id)));
    cell.classList.toggle("server", id === current.serverId);
    return cell;
  }));
  $("#overlayUrl").value = `${location.origin}/live/overlay.html#${current.overlayToken}`;
  $("#replay").hidden = !current.matchId;
  if (current.matchId) $("#replay").href = `/live/replay.html?match=${encodeURIComponent(current.matchId)}`;
  localStorage.setItem(`honey-live-last:${user.id}`, current.id);
  icons();
}
async function load() {
  try {
    const data = await request("/api/live/bootstrap");
    user = data.user;
    $("#identity").textContent = user.displayName;
    $("#login").hidden = true;
    for (const select of $("#setup").querySelectorAll("select[name$='Left'],select[name$='Right']")) {
      select.replaceChildren(new Option("선수 선택", ""), ...data.players.sort((a, b) => a.name.localeCompare(b.name, "ko")).map((p) => new Option(p.name, p.id)));
    }
    const selected = new URLSearchParams(location.search).get("session");
    current = selected ? await request(`/api/live/sessions/${encodeURIComponent(selected)}`) : (await request("/api/live/current")).session;
    const last = localStorage.getItem(`honey-live-last:${user.id}`);
    if (!current && last) {
      try { current = await request(`/api/live/sessions/${encodeURIComponent(last)}`); } catch { localStorage.removeItem(`honey-live-last:${user.id}`); }
    }
    render();
    if (current?.videoId) $("#video").youtubeUrl.value = `https://www.youtube.com/watch?v=${current.videoId}`;
    $("#video").videoOffsetSeconds.value = current?.videoOffsetSeconds || 0;
    status(current?.status === "finished" ? "경기 기록 저장 완료" : "연결됨");
  } catch (error) {
    if (error.status === 401) $("#login").hidden = false;
    status(error.status === 401 ? "허니서브 계정으로 로그인하세요." : error.message, error.status !== 401);
  }
}
async function command(type, extra = {}) {
  if (busy || !current) return;
  const body = { operationId: crypto.randomUUID(), expectedRevision: current.revision, type,
    capturedAt: Date.now(), ...extra };
  busy = true; render();
  const key = `honey-live-pending:${user.id}:${current.id}`;
  try {
    const pending = localStorage.getItem(key);
    if (pending) throw new Error("미확인 조작이 있습니다. 페이지를 새로고침하여 재전송하세요.");
    localStorage.setItem(key, JSON.stringify(body));
    current = await request(`/api/live/sessions/${current.id}/commands`, body);
    localStorage.removeItem(key);
    status(type === "finish" ? "경기 기록 저장 완료" : "반영됨");
  } catch (error) {
    if (error.status) localStorage.removeItem(key);
    status(error.message, true);
    if (error.status === 409) current = await request(`/api/live/sessions/${current.id}`);
  } finally { busy = false; render(); }
}
$("#login").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { await request("/api/login", Object.fromEntries(new FormData(event.target))); event.target.password.value = ""; await load(); }
  catch (error) { status(error.message, true); }
});
$("#setup").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  const data = Object.fromEntries(new FormData(event.target));
  try {
    current = await request("/api/live/sessions", { id: crypto.randomUUID(), teamA: [data.aLeft, data.aRight], teamB: [data.bLeft, data.bRight], servingTeam: data.servingTeam, nearTeam: data.nearTeam });
    render(); status("중계 준비 완료");
  } catch (error) { status(error.message, true); } finally { busy = false; }
});
$("#start").onclick = () => command("start");
$("#pointA").onclick = () => command("point", { team: "A" });
$("#pointB").onclick = () => command("point", { team: "B" });
$("#undo").onclick = () => command("undo");
$("#switch").onclick = () => command("switchEnds");
$("#cancel").onclick = () => { if (confirm("랭킹에 저장하지 않고 이 중계를 취소할까요? 방송은 PRISM에서 별도로 종료하세요.")) command("cancel"); };
$("#finish").onclick = () => {
  $("#finalScore").textContent = `A팀 ${current.scoreA} : ${current.scoreB} B팀`;
  $("#streamStopped").checked = false; $("#endDialog").showModal();
};
$("#endCancel").onclick = () => $("#endDialog").close();
$("#endConfirm").onclick = async () => {
  if (!$("#streamStopped").checked) return;
  await command("finish", { streamEndedConfirmed: true });
  if (current.status === "finished") $("#endDialog").close();
  else $("#finalScore").textContent = $("#status").textContent;
};
$("#new").onclick = () => { localStorage.removeItem(`honey-live-last:${user.id}`); current = null; render(); status("새 경기"); };
$("#copy").onclick = async () => {
  try { await navigator.clipboard.writeText($("#overlayUrl").value); status("점수판 주소 복사됨"); }
  catch { $("#overlayUrl").select(); status("점수판 주소를 선택했습니다."); }
};
$("#video").onsubmit = (event) => { event.preventDefault(); command("video", Object.fromEntries(new FormData(event.target))); };
await load();
if (current?.status === "live" && new URLSearchParams(location.search).has("end")) $("#finish").click();
if (current && user) {
  const key = `honey-live-pending:${user.id}:${current.id}`;
  const pending = localStorage.getItem(key);
  if (pending) {
    try { current = await request(`/api/live/sessions/${current.id}/commands`, JSON.parse(pending)); localStorage.removeItem(key); render(); status("미확인 조작 복구 완료"); }
    catch (error) { if (error.status) localStorage.removeItem(key); status(`이전 조작 확인 필요: ${error.message}`, true); }
  }
}
document.addEventListener("visibilitychange", async () => {
  if (document.hidden || !current || busy || !user) return;
  try { current = await request(`/api/live/sessions/${current.id}`); render(); } catch (error) { status(error.message, true); }
});
