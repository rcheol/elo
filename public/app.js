const STORAGE_KEY = "badminton-doubles-elo:v1";

const defaultSettings = {
  baseRating: 1500,
  kFactor: 32,
  marginBonus: true,
};

const selectIds = ["teamA1", "teamA2", "teamB1", "teamB2"];
let state = loadState();
let toastTimer = null;

const $ = (selector, scope = document) => scope.querySelector(selector);

function uid() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { players: [], matches: [], settings: { ...defaultSettings } };
    }
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    console.warn("Failed to load saved rankings", error);
    return { players: [], matches: [], settings: { ...defaultSettings } };
  }
}

function normalizeState(input) {
  const players = Array.isArray(input?.players)
    ? input.players
        .filter((player) => player && player.id && player.name)
        .map((player) => ({
          id: String(player.id),
          name: String(player.name).trim(),
          seedRating: clampNumber(Number(player.seedRating ?? player.rating ?? defaultSettings.baseRating), 800, 2400),
          createdAt: player.createdAt || new Date().toISOString(),
        }))
    : [];

  const playerIds = new Set(players.map((player) => player.id));
  const matches = Array.isArray(input?.matches)
    ? input.matches
        .filter((match) => {
          const ids = [...(match.teamA || []), ...(match.teamB || [])];
          return ids.length === 4 && ids.every((id) => playerIds.has(id));
        })
        .map((match) => ({
          id: String(match.id || uid()),
          teamA: match.teamA.map(String),
          teamB: match.teamB.map(String),
          scoreA: Number(match.scoreA),
          scoreB: Number(match.scoreB),
          winner: match.winner === "B" ? "B" : "A",
          expectedA: Number(match.expectedA ?? 0.5),
          expectedB: Number(match.expectedB ?? 0.5),
          teamRatingA: Number(match.teamRatingA ?? defaultSettings.baseRating),
          teamRatingB: Number(match.teamRatingB ?? defaultSettings.baseRating),
          kFactor: Number(match.kFactor ?? defaultSettings.kFactor),
          marginFactor: Number(match.marginFactor ?? 1),
          changes: Array.isArray(match.changes) ? match.changes : [],
          createdAt: match.createdAt || new Date().toISOString(),
        }))
    : [];

  return {
    players,
    matches,
    settings: {
      baseRating: clampNumber(Number(input?.settings?.baseRating ?? defaultSettings.baseRating), 800, 2400),
      kFactor: clampNumber(Number(input?.settings?.kFactor ?? defaultSettings.kFactor), 8, 64),
      marginBonus: input?.settings?.marginBonus !== false,
    },
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatSigned(value, digits = 1) {
  const rounded = Number(value).toFixed(digits);
  return value > 0 ? `+${rounded}` : rounded;
}

function formatDate(isoDate) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(isoDate));
}

function getStandings() {
  const table = new Map(
    state.players.map((player) => [
      player.id,
      {
        ...player,
        rating: player.seedRating,
        games: 0,
        wins: 0,
        losses: 0,
        pointsFor: 0,
        pointsAgainst: 0,
        streak: 0,
        lastPlayed: null,
      },
    ]),
  );

  state.matches.forEach((match) => {
    match.changes.forEach((change) => {
      const player = table.get(change.id);
      if (player) {
        player.rating = round1(player.rating + Number(change.delta || 0));
      }
    });

    applyMatchStats(table, match.teamA, match.winner === "A", match.scoreA, match.scoreB, match.createdAt);
    applyMatchStats(table, match.teamB, match.winner === "B", match.scoreB, match.scoreA, match.createdAt);
  });

  return [...table.values()]
    .map((player) => ({
      ...player,
      rating: round1(player.rating),
      winRate: player.games ? player.wins / player.games : 0,
      pointDiff: player.pointsFor - player.pointsAgainst,
      ratingDelta: round1(player.rating - player.seedRating),
    }))
    .sort((a, b) => {
      if (b.rating !== a.rating) return b.rating - a.rating;
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      if (b.games !== a.games) return b.games - a.games;
      return a.name.localeCompare(b.name, "ko-KR");
    });
}

function applyMatchStats(table, ids, won, pointsFor, pointsAgainst, createdAt) {
  ids.forEach((id) => {
    const player = table.get(id);
    if (!player) return;
    player.games += 1;
    player.wins += won ? 1 : 0;
    player.losses += won ? 0 : 1;
    player.pointsFor += pointsFor;
    player.pointsAgainst += pointsAgainst;
    player.lastPlayed = createdAt;
    player.streak = won
      ? player.streak > 0 ? player.streak + 1 : 1
      : player.streak < 0 ? player.streak - 1 : -1;
  });
}

function playerName(id) {
  return state.players.find((player) => player.id === id)?.name || "알 수 없음";
}

function addPlayer(name, rating) {
  const normalizedName = name.trim().replace(/\s+/g, " ");
  if (!normalizedName) {
    showToast("선수 이름을 입력하세요.");
    return false;
  }

  const duplicate = state.players.some((player) => player.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase());
  if (duplicate) {
    showToast("이미 등록된 이름입니다.");
    return false;
  }

  state.players.push({
    id: uid(),
    name: normalizedName,
    seedRating: clampNumber(Number(rating || state.settings.baseRating), 800, 2400),
    createdAt: new Date().toISOString(),
  });
  saveState();
  render();
  showToast(`${normalizedName} 선수를 추가했습니다.`);
  return true;
}

function deletePlayer(playerId) {
  const standings = getStandings();
  const player = standings.find((entry) => entry.id === playerId);
  if (!player || player.games > 0) {
    showToast("경기 기록이 있는 선수는 삭제할 수 없습니다.");
    return;
  }

  state.players = state.players.filter((entry) => entry.id !== playerId);
  saveState();
  render();
  showToast("선수를 삭제했습니다.");
}

function buildMatch(teamA, teamB, scoreA, scoreB) {
  const standings = getStandings();
  const ratingById = new Map(standings.map((player) => [player.id, player.rating]));
  const teamRatingA = average(teamA.map((id) => ratingById.get(id) ?? state.settings.baseRating));
  const teamRatingB = average(teamB.map((id) => ratingById.get(id) ?? state.settings.baseRating));
  const expectedA = 1 / (1 + 10 ** ((teamRatingB - teamRatingA) / 400));
  const expectedB = 1 - expectedA;
  const resultA = scoreA > scoreB ? 1 : 0;
  const resultB = 1 - resultA;
  const marginFactor = state.settings.marginBonus ? getMarginFactor(scoreA, scoreB) : 1;
  const kFactor = state.settings.kFactor;
  const deltaA = round1(kFactor * marginFactor * (resultA - expectedA));
  const deltaB = round1(kFactor * marginFactor * (resultB - expectedB));

  return {
    id: uid(),
    teamA,
    teamB,
    scoreA,
    scoreB,
    winner: resultA === 1 ? "A" : "B",
    expectedA: round3(expectedA),
    expectedB: round3(expectedB),
    teamRatingA: round1(teamRatingA),
    teamRatingB: round1(teamRatingB),
    kFactor,
    marginFactor: round3(marginFactor),
    changes: [
      ...teamA.map((id) => ({ id, delta: deltaA })),
      ...teamB.map((id) => ({ id, delta: deltaB })),
    ],
    createdAt: new Date().toISOString(),
  };
}

function getMarginFactor(scoreA, scoreB) {
  const maxScore = Math.max(scoreA, scoreB, 21);
  const gap = Math.abs(scoreA - scoreB);
  return Math.min(1.35, 1 + gap / (maxScore * 3));
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function validateMatch(teamA, teamB, scoreA, scoreB) {
  const ids = [...teamA, ...teamB];
  if (state.players.length < 4) {
    return "선수 4명 이상이 필요합니다.";
  }
  if (ids.some((id) => !id)) {
    return "선수 4명을 선택하세요.";
  }
  if (new Set(ids).size !== 4) {
    return "한 선수는 한 경기에서 한 번만 선택할 수 있습니다.";
  }
  if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0) {
    return "점수를 확인하세요.";
  }
  if (scoreA === scoreB) {
    return "동점 경기는 ELO에 반영할 수 없습니다.";
  }
  return "";
}

function recordMatch() {
  const teamA = [$("#teamA1").value, $("#teamA2").value];
  const teamB = [$("#teamB1").value, $("#teamB2").value];
  const scoreA = Number($("#scoreA").value);
  const scoreB = Number($("#scoreB").value);
  const error = validateMatch(teamA, teamB, scoreA, scoreB);

  if (error) {
    showToast(error);
    return;
  }

  state.matches.push(buildMatch(teamA, teamB, scoreA, scoreB));
  saveState();
  render();
  showToast("경기 결과를 저장했습니다.");
}

function undoLastMatch() {
  if (!state.matches.length) {
    showToast("되돌릴 경기가 없습니다.");
    return;
  }
  state.matches.pop();
  saveState();
  render();
  showToast("마지막 경기를 되돌렸습니다.");
}

function render() {
  const standings = getStandings();
  renderSummary(standings);
  renderSelects(standings);
  renderSettings();
  renderRankings(standings);
  renderHistory();
  renderPreview();
  $("#undoBtn").disabled = state.matches.length === 0;
  $("#shuffleBtn").hidden = state.players.length < 4;
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function renderSummary(standings) {
  $("#playerCount").textContent = state.players.length;
  $("#matchCount").textContent = state.matches.length;
  $("#averageRating").textContent = standings.length ? Math.round(average(standings.map((player) => player.rating))) : 0;
}

function renderSelects(standings) {
  const options = standings
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "ko-KR"))
    .map((player) => `<option value="${escapeHtml(player.id)}">${escapeHtml(player.name)} (${Math.round(player.rating)})</option>`)
    .join("");

  const ids = standings.map((player) => player.id);
  const previousValues = selectIds.map((id) => $(`#${id}`).value);
  const selectedValues = [];

  selectIds.forEach((selectId, index) => {
    let value = previousValues[index];
    if (!ids.includes(value) || selectedValues.includes(value)) {
      value = ids.find((id) => !selectedValues.includes(id)) || "";
    }
    selectedValues.push(value);

    const select = $(`#${selectId}`);
    select.innerHTML = `<option value="">선택</option>${options}`;
    select.value = value;
    select.disabled = standings.length < 4;
  });
}

function renderSettings() {
  $("#baseRating").value = state.settings.baseRating;
  $("#kFactor").value = state.settings.kFactor;
  $("#marginBonus").checked = state.settings.marginBonus;
  $("#playerRating").placeholder = String(state.settings.baseRating);
}

function renderRankings(standings) {
  const body = $("#rankingBody");
  const empty = $("#rankingEmpty");
  body.innerHTML = standings
    .map((player, index) => {
      const rank = index + 1;
      const rankClass = rank <= 3 ? "rank-pill rank-pill--podium" : "rank-pill";
      const ratingClass = player.ratingDelta < 0 ? "delta delta--down" : "delta";
      const winRate = player.games ? `${Math.round(player.winRate * 100)}%` : "-";
      const pointDiff = player.pointDiff > 0 ? `+${player.pointDiff}` : String(player.pointDiff);
      const streak = formatStreak(player.streak);
      const lastPlayed = player.lastPlayed ? `최근 ${formatDate(player.lastPlayed)}` : "경기 없음";
      const deleteButton = player.games === 0
        ? `<button class="icon-button" type="button" data-delete-player="${escapeHtml(player.id)}" aria-label="${escapeHtml(player.name)} 삭제" title="삭제"><i data-lucide="x"></i><span class="visually-hidden">삭제</span></button>`
        : `<span class="muted">-</span>`;

      return `
        <tr>
          <td><span class="${rankClass}">${rank}</span></td>
          <td>
            <div class="player-cell">
              <span class="avatar">${escapeHtml(player.name.slice(0, 1))}</span>
              <div class="player-meta">
                <span class="player-name">${escapeHtml(player.name)}</span>
                <span class="player-sub">${lastPlayed}</span>
              </div>
            </div>
          </td>
          <td><span class="rating-number">${player.rating.toFixed(1)}</span> <span class="${ratingClass}">${formatSigned(player.ratingDelta)}</span></td>
          <td class="record">${player.wins}승 ${player.losses}패</td>
          <td class="win-rate">${winRate}</td>
          <td class="point-diff">${pointDiff}</td>
          <td>${streak}</td>
          <td>${deleteButton}</td>
        </tr>
      `;
    })
    .join("");

  empty.classList.toggle("is-visible", standings.length === 0);
}

function formatStreak(streak) {
  if (streak > 0) {
    return `<span class="streak streak--win">${streak}연승</span>`;
  }
  if (streak < 0) {
    return `<span class="streak streak--loss">${Math.abs(streak)}연패</span>`;
  }
  return `<span class="muted">-</span>`;
}

function renderHistory() {
  const list = $("#historyList");
  const empty = $("#historyEmpty");
  const latestMatchId = state.matches.at(-1)?.id;

  list.innerHTML = state.matches
    .slice()
    .reverse()
    .map((match) => {
      const teamA = match.teamA.map(playerName).join(" / ");
      const teamB = match.teamB.map(playerName).join(" / ");
      const deltaA = match.changes.find((change) => match.teamA.includes(change.id))?.delta || 0;
      const deltaB = match.changes.find((change) => match.teamB.includes(change.id))?.delta || 0;
      const canUndo = match.id === latestMatchId;

      return `
        <li class="history-item">
          <time class="history-date" datetime="${escapeHtml(match.createdAt)}">${formatDate(match.createdAt)}</time>
          <div class="history-main">
            <div class="teams-line">
              <span class="team-name ${match.winner === "A" ? "team-name--winner" : ""}">${escapeHtml(teamA)}</span>
              <span class="score-badge">${match.scoreA} : ${match.scoreB}</span>
              <span class="team-name ${match.winner === "B" ? "team-name--winner" : ""}">${escapeHtml(teamB)}</span>
            </div>
            <p class="history-sub">A ${formatSigned(deltaA)} / B ${formatSigned(deltaB)} · 기대승률 ${Math.round(match.expectedA * 100)}% : ${Math.round(match.expectedB * 100)}%</p>
          </div>
          ${
            canUndo
              ? `<button class="icon-button" type="button" data-undo-match aria-label="마지막 경기 되돌리기" title="되돌리기"><i data-lucide="undo-2"></i><span class="visually-hidden">되돌리기</span></button>`
              : `<span class="muted">-</span>`
          }
        </li>
      `;
    })
    .join("");

  empty.classList.toggle("is-visible", state.matches.length === 0);
}

function renderPreview() {
  const preview = $("#matchPreview");
  const teamA = [$("#teamA1").value, $("#teamA2").value];
  const teamB = [$("#teamB1").value, $("#teamB2").value];
  const ids = [...teamA, ...teamB];

  if (state.players.length < 4) {
    preview.textContent = "선수 4명 이상이 필요합니다.";
    return;
  }

  if (ids.some((id) => !id) || new Set(ids).size !== 4) {
    preview.textContent = "선수 4명을 선택하세요.";
    return;
  }

  const standings = getStandings();
  const ratingById = new Map(standings.map((player) => [player.id, player.rating]));
  const ratingA = average(teamA.map((id) => ratingById.get(id)));
  const ratingB = average(teamB.map((id) => ratingById.get(id)));
  const expectedA = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
  preview.textContent = `팀 평균 ${Math.round(ratingA)} : ${Math.round(ratingB)} · A팀 기대승률 ${Math.round(expectedA * 100)}%`;
}

function shuffleTeams() {
  if (state.players.length < 4) {
    showToast("선수 4명 이상이 필요합니다.");
    return;
  }

  const shuffled = getStandings()
    .map((player) => player.id)
    .sort(() => Math.random() - 0.5)
    .slice(0, 4);

  selectIds.forEach((selectId, index) => {
    $(`#${selectId}`).value = shuffled[index];
  });
  renderPreview();
}

function loadDemoData() {
  if ((state.players.length || state.matches.length) && !window.confirm("현재 데이터를 샘플 데이터로 바꿀까요?")) {
    return;
  }

  const players = [
    ["김하준", 1540],
    ["이서연", 1510],
    ["박민재", 1490],
    ["최유나", 1500],
    ["정도현", 1470],
    ["한지민", 1525],
  ].map(([name, seedRating]) => ({
    id: uid(),
    name,
    seedRating,
    createdAt: new Date().toISOString(),
  }));

  state = {
    players,
    matches: [],
    settings: { ...defaultSettings },
  };

  const byName = Object.fromEntries(players.map((player) => [player.name, player.id]));
  [
    [["김하준", "이서연"], ["박민재", "최유나"], 21, 17],
    [["정도현", "한지민"], ["김하준", "최유나"], 18, 21],
    [["이서연", "박민재"], ["정도현", "한지민"], 22, 20],
    [["김하준", "한지민"], ["이서연", "최유나"], 16, 21],
    [["박민재", "최유나"], ["정도현", "김하준"], 21, 14],
  ].forEach(([teamA, teamB, scoreA, scoreB]) => {
    state.matches.push(buildMatch(teamA.map((name) => byName[name]), teamB.map((name) => byName[name]), scoreA, scoreB));
  });

  saveState();
  render();
  showToast("샘플 데이터를 불러왔습니다.");
}

function exportData() {
  const payload = JSON.stringify(state, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `badminton-elo-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  showToast("랭킹 데이터를 내보냈습니다.");
}

function importData(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const nextState = normalizeState(JSON.parse(reader.result));
      if (!nextState.players.length) {
        showToast("가져올 선수가 없습니다.");
        return;
      }
      state = nextState;
      saveState();
      render();
      showToast("랭킹 데이터를 가져왔습니다.");
    } catch (error) {
      console.error(error);
      showToast("JSON 파일을 확인하세요.");
    }
  };
  reader.readAsText(file);
}

function resetData() {
  if (!state.players.length && !state.matches.length) {
    showToast("초기화할 데이터가 없습니다.");
    return;
  }
  if (!window.confirm("모든 선수와 경기 기록을 삭제할까요?")) {
    return;
  }
  state = { players: [], matches: [], settings: { ...defaultSettings } };
  saveState();
  render();
  showToast("데이터를 초기화했습니다.");
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.classList.remove("is-visible");
  }, 2600);
}

function bindEvents() {
  $("#playerForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const nameInput = $("#playerName");
    const ratingInput = $("#playerRating");
    const added = addPlayer(nameInput.value, ratingInput.value);
    if (added) {
      nameInput.value = "";
      ratingInput.value = "";
      nameInput.focus();
    }
  });

  $("#matchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    recordMatch();
  });

  selectIds.forEach((id) => {
    $(`#${id}`).addEventListener("change", renderPreview);
  });

  $("#scoreA").addEventListener("input", renderPreview);
  $("#scoreB").addEventListener("input", renderPreview);
  $("#shuffleBtn").addEventListener("click", shuffleTeams);
  $("#loadDemoBtn").addEventListener("click", loadDemoData);
  $("#emptyDemoBtn").addEventListener("click", loadDemoData);
  $("#undoBtn").addEventListener("click", undoLastMatch);
  $("#exportBtn").addEventListener("click", exportData);
  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", (event) => {
    importData(event.target.files[0]);
    event.target.value = "";
  });
  $("#resetBtn").addEventListener("click", resetData);

  $("#baseRating").addEventListener("change", (event) => {
    state.settings.baseRating = clampNumber(Number(event.target.value), 800, 2400);
    saveState();
    render();
  });

  $("#kFactor").addEventListener("change", (event) => {
    state.settings.kFactor = clampNumber(Number(event.target.value), 8, 64);
    saveState();
    render();
  });

  $("#marginBonus").addEventListener("change", (event) => {
    state.settings.marginBonus = event.target.checked;
    saveState();
    render();
  });

  document.addEventListener("click", (event) => {
    const deleteButton = event.target.closest("[data-delete-player]");
    if (deleteButton) {
      deletePlayer(deleteButton.dataset.deletePlayer);
      return;
    }

    if (event.target.closest("[data-undo-match]")) {
      undoLastMatch();
    }
  });
}

bindEvents();
render();
