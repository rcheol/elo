const decisions = new Set(["A", "B", "let", "unknown"]);
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const points = (value) => Number.isInteger(value) && value >= 0 && value <= 40;

export function normalizeVideoReview(input) {
  if (!input || input.version !== 2 || !Array.isArray(input.rallies) || !input.rallies.length || input.rallies.length > 100) return null;
  if (!finite(input.startSeconds) || !finite(input.endSeconds) || input.startSeconds < 0 || input.endSeconds <= input.startSeconds) return null;
  if (!points(input.startScoreA) || !points(input.startScoreB)) return null;
  const ids = new Set();
  const rallies = [];
  for (const row of input.rallies) {
    if (!row || typeof row.id !== "string" || !/^r\d+$/.test(row.id) || ids.has(row.id)) return null;
    if (!["rally", "gap"].includes(row.kind) || !decisions.has(row.decision) || !decisions.has(row.suggested)) return null;
    if (!finite(row.start) || !finite(row.end) || row.start < input.startSeconds || row.end > input.endSeconds || row.start > row.end) return null;
    if (row.kind === "gap" && row.decision !== "unknown") return null;
    ids.add(row.id);
    rallies.push({ id: row.id, kind: row.kind, start: row.start, end: row.end,
      decision: row.decision, suggested: row.suggested,
      reason: String(row.reason || "").slice(0, 80), evidence: String(row.evidence || "").slice(0, 180) });
  }
  return { version: 2, startSeconds: input.startSeconds, endSeconds: input.endSeconds,
    startScoreA: input.startScoreA, startScoreB: input.startScoreB, rallies };
}

export function resolveVideoReview(stored, input) {
  const review = normalizeVideoReview(stored);
  if (!review || input?.coverageConfirmed !== true) throw new Error("경기 구간과 누락된 랠리 확인이 필요합니다.");
  const submitted = input.decisions;
  if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) throw new Error("랠리별 결과를 확인하세요.");
  const knownIds = new Set(review.rallies.map((row) => row.id));
  if (Object.keys(submitted).some((id) => !knownIds.has(id))) throw new Error("알 수 없는 랠리입니다.");
  let scoreA = review.startScoreA;
  let scoreB = review.startScoreB;
  const resolved = {};
  for (const row of review.rallies) {
    const choice = submitted[row.id];
    if (row.kind === "gap") {
      if (!points(choice?.scoreA) || !points(choice?.scoreB)) throw new Error("미확인 구간의 양 팀 득점을 입력하세요. 득점이 없으면 0입니다.");
      scoreA += choice.scoreA;
      scoreB += choice.scoreB;
      resolved[row.id] = { scoreA: choice.scoreA, scoreB: choice.scoreB };
    } else {
      const winner = choice?.winner ?? row.decision;
      if (!["A", "B", "let"].includes(winner)) throw new Error("미확인 랠리의 승리 팀 또는 무득점을 선택하세요.");
      scoreA += winner === "A" ? 1 : 0;
      scoreB += winner === "B" ? 1 : 0;
      resolved[row.id] = { winner };
    }
  }
  // Covers missed proposals without pretending a gap can only contain one point.
  const extras = input.extraPoints;
  if (!points(extras?.scoreA) || !points(extras?.scoreB)) throw new Error("추가 득점은 0~40 사이의 정수여야 합니다.");
  scoreA += extras.scoreA;
  scoreB += extras.scoreB;
  if (scoreA === scoreB || scoreA > 40 || scoreB > 40) throw new Error("최종 스코어를 확인하세요. 동점 또는 40점을 초과한 결과는 저장할 수 없습니다.");
  return { scoreA, scoreB, decisions: resolved, extraPoints: { scoreA: extras.scoreA, scoreB: extras.scoreB }, coverageConfirmed: true };
}
