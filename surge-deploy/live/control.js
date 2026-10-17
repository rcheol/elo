import { renderTimeline } from "./timeline.js";

export async function mountControl(root = document, embedded = false) {
  const $ = (selector) => root.querySelector(selector);
  let current = null;
  let user = null;
  let channelToken = "";
  let busy = false;
  let loading = false;
  let authReloadPending = false;
  let announcedMatch = "";
  const icons = () => window.lucide?.createIcons({ root });
  const status = (message, error = false) => { $("#status").textContent = message; $("#status").classList.toggle("error", error); };
  async function request(path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(path, { signal: controller.signal, credentials: "same-origin", cache: "no-store", ...(body ? {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      } : {}) });
      const data = await response.json();
      if (!response.ok) { const error = new Error(data.message || data.error || `서버 오류 (${response.status})`); error.status = response.status; throw error; }
      return data;
    } catch (error) {
      if (!error.status) throw new Error("서버 응답을 확인하지 못했습니다. 연결 확인 후 다시 누르면 같은 요청으로 재확인합니다.");
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function endStatus(message, error = false) {
    $("#endStatus").textContent = message;
    $("#endStatus").classList.toggle("error", error);
  }
  function syncFinishControls() {
    $("#endConfirm").disabled = busy || !$("#matchEnded").checked || current?.status !== "live";
    $("#endConfirm").textContent = busy ? "저장 중…" : "최종 기록 저장";
    $("#endCancel").disabled = busy;
    $("#matchEnded").disabled = busy;
  }
  function announceSavedMatch() {
    if (current?.status !== "finished" || !current.matchId) return false;
    status(`경기 기록 저장 완료 · A ${current.scoreA} : ${current.scoreB} B · 득점 시각 ${current.points.length}건 저장됨`);
    if (announcedMatch === current.matchId) return true;
    announcedMatch = current.matchId;
    localStorage.setItem("honey-live-match-saved", JSON.stringify({ matchId: current.matchId, at: Date.now() }));
    window.dispatchEvent(new Event("honey-live-match-saved"));
    return true;
  }
  function render() {
    $("#overlayLink").hidden = !channelToken;
    $("#overlayUrl").value = channelToken ? `${location.origin}/live/overlay.html#channel/${channelToken}` : "";
    $("#setup").hidden = !user || Boolean(current);
    $("#session").hidden = !user || !current;
    $("#setup button[type=submit]").disabled = busy;
    if (!current) return;
    $("#start").disabled = busy;
    $("#cancel").disabled = busy;
    $("#new").disabled = busy;
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
    const order = [...current.positions[far]].reverse().concat(current.positions[near]);
    $("#court").replaceChildren(...order.map((id, index) => {
      const cell = document.createElement("div");
      const label = document.createElement("small");
      label.textContent = `${index < 2 ? far : near}팀${id === current.serverId ? " · 서브" : id === current.receiverId ? " · 리시브" : ""}`;
      cell.append(label, document.createTextNode(name(id)));
      cell.classList.toggle("server", id === current.serverId);
      return cell;
    }));
    $("#replay").hidden = !current.matchId;
    if (current.matchId) $("#replay").href = `/live/replay.html?match=${encodeURIComponent(current.matchId)}`;
    $("#savedMatch").hidden = current.status !== "finished" || !current.matchId;
    if (current.matchId) $("#savedMatch").href = `/?match=${encodeURIComponent(current.matchId)}#historyTitle`;
    $("#savedTimeline").hidden = current.status !== "finished" || !current.matchId;
    if (!$("#savedTimeline").hidden) renderTimeline($("#pointTimeline"), current);
    localStorage.setItem(`honey-live-last:${user.id}`, current.id);
    syncFinishControls();
    icons();
  }
  async function load() {
    if (loading) { authReloadPending = true; return; }
    loading = true;
    authReloadPending = false;
    try {
      const data = await request("/api/live/bootstrap");
      user = data.user;
      channelToken = data.channelToken;
      $("#identity").textContent = user.displayName;
      $("#login").hidden = true;
      for (const select of $("#setup").querySelectorAll("select[name$='Left'],select[name$='Right']")) {
        select.replaceChildren(new Option("선수 선택", ""), ...data.players.sort((a, b) => a.name.localeCompare(b.name, "ko")).map((p) => new Option(p.name, p.id)));
      }
      const selected = embedded ? null : new URLSearchParams(location.search).get("session");
      current = selected ? await request(`/api/live/sessions/${encodeURIComponent(selected)}`) : (await request("/api/live/current")).session;
      if (current) localStorage.removeItem(`honey-live-create:${user.id}`);
      const last = localStorage.getItem(`honey-live-last:${user.id}`);
      if (!current && last) {
        try { current = await request(`/api/live/sessions/${encodeURIComponent(last)}`); } catch { localStorage.removeItem(`honey-live-last:${user.id}`); }
      }
      render();
      if (current?.videoId) $("#video").youtubeUrl.value = `https://www.youtube.com/watch?v=${current.videoId}`;
      $("#video").videoOffsetSeconds.value = current?.videoOffsetSeconds || 0;
      if (!announceSavedMatch()) status(current?.status === "live" ? "경기 진행 중 · 최종 기록 미저장" : "연결됨");
    } catch (error) {
      if (error.status === 401) { user = null; current = null; channelToken = ""; render(); $("#login").hidden = embedded; }
      status(error.status === 401 ? "허니서브 계정으로 로그인하세요." : error.message, error.status !== 401);
    } finally {
      loading = false;
      if (authReloadPending && !busy) await load();
    }
  }
  async function command(type, extra = {}) {
    if (busy || !current) return false;
    const key = `honey-live-pending:${user.id}:${current.id}`;
    busy = true;
    try {
      render();
      const pending = JSON.parse(localStorage.getItem(key) || "null");
      if (pending && (pending.type !== type || pending.team !== extra.team)) throw new Error("다른 미확인 조작이 있습니다. 페이지를 새로고침하여 먼저 복구하세요.");
      // An uncertain response must reuse its operation ID, even when the user retries without reloading.
      const body = pending || { operationId: crypto.randomUUID(), expectedRevision: current.revision, type,
        capturedAt: Date.now(), ...extra };
      localStorage.setItem(key, JSON.stringify(body));
      current = await request(`/api/live/sessions/${current.id}/commands`, body);
      localStorage.removeItem(key);
      if (type === "finish" && !announceSavedMatch()) throw new Error("경기 저장 결과를 확인하지 못했습니다. 새로고침 후 기록을 확인하세요.");
      if (type !== "finish") status("반영됨 · 최종 기록은 종료 후 저장됩니다.");
      return true;
    } catch (error) {
      if (error.status >= 400 && error.status < 500) localStorage.removeItem(key);
      status(error.message, true);
      if (type === "finish") endStatus(error.message, true);
      if (error.status === 409) {
        try { current = await request(`/api/live/sessions/${current.id}`); }
        catch (refreshError) { status(refreshError.message, true); }
      }
      return false;
    } finally { busy = false; render(); if (authReloadPending) await load(); }
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
    render();
    const data = Object.fromEntries(new FormData(event.target));
    const key = `honey-live-create:${user.id}`;
    try {
      const body = JSON.parse(localStorage.getItem(key) || "null") || { id: crypto.randomUUID(), teamA: [data.aLeft, data.aRight], teamB: [data.bLeft, data.bRight], servingTeam: data.servingTeam, nearTeam: data.nearTeam };
      localStorage.setItem(key, JSON.stringify(body));
      current = await request("/api/live/sessions", body);
      localStorage.removeItem(key);
      render(); status("중계 준비 완료");
    } catch (error) {
      if (error.status >= 400 && error.status < 500) localStorage.removeItem(key);
      if (error.status === 409) await load();
      status(error.message, true);
    } finally { busy = false; render(); if (authReloadPending) await load(); }
  });
  $("#start").onclick = () => command("start");
  $("#pointA").onclick = () => command("point", { team: "A" });
  $("#pointB").onclick = () => command("point", { team: "B" });
  $("#undo").onclick = () => command("undo");
  $("#switch").onclick = () => command("switchEnds");
  $("#cancel").onclick = () => { if (confirm("랭킹에 저장하지 않고 이 중계를 취소할까요? 방송은 PRISM에서 별도로 종료하세요.")) command("cancel"); };
  $("#finish").onclick = () => {
    $("#finalScore").textContent = `A팀 ${current.scoreA} : ${current.scoreB} B팀`;
    $("#matchEnded").checked = false;
    endStatus("최종 점수를 확인한 뒤 경기 기록을 저장하세요.");
    syncFinishControls(); $("#endDialog").showModal();
  };
  $("#matchEnded").onchange = () => { endStatus($("#matchEnded").checked ? "" : "최종 점수를 확인해 주세요."); syncFinishControls(); };
  $("#endDialog").addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  $("#endCancel").onclick = () => $("#endDialog").close();
  $("#endConfirm").onclick = async () => {
    if (busy) return;
    if (!$("#matchEnded").checked) { endStatus("이 경기의 최종 점수를 확인해 주세요.", true); return; }
    endStatus("서버에 경기 기록을 저장하는 중입니다.");
    await command("finish", { matchEndedConfirmed: true });
    if (current?.status === "finished" && current.matchId) { $("#endDialog").close(); announceSavedMatch(); }
  };
  $("#new").onclick = () => { localStorage.removeItem(`honey-live-last:${user.id}`); current = null; $("#video").reset(); render(); status("새 경기"); };
  $("#copy").onclick = async () => {
    try { await navigator.clipboard.writeText($("#overlayUrl").value); status("점수판 주소 복사됨"); }
    catch { $("#overlayUrl").select(); status("점수판 주소를 선택했습니다."); }
  };
  $("#video").onsubmit = (event) => { event.preventDefault(); command("video", Object.fromEntries(new FormData(event.target))); };
  await load();
  icons();
  window.addEventListener("load", icons, { once: true });
  if (current?.status === "live" && new URLSearchParams(location.search).has("end")) $("#finish").click();
  if (current && user) {
    const key = `honey-live-pending:${user.id}:${current.id}`;
    const pending = localStorage.getItem(key);
    if (pending) {
      try { current = await request(`/api/live/sessions/${current.id}/commands`, JSON.parse(pending)); localStorage.removeItem(key); render(); if (!announceSavedMatch()) status("미확인 조작 복구 완료"); }
      catch (error) { if (error.status >= 400 && error.status < 500) localStorage.removeItem(key); status(`이전 조작 확인 필요: ${error.message}`, true); }
    }
  }
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden || !current || busy || !user) return;
    try { current = await request(`/api/live/sessions/${current.id}`); render(); } catch (error) { status(error.message, true); }
  });
  window.addEventListener("honey-auth-change", async (event) => {
    if ((event.detail || null) === (user?.id || null)) return;
    if (busy || loading) authReloadPending = true;
    else await load();
  });
}

if (!document.querySelector("honey-live")) await mountControl();
