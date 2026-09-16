import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeVideoReview, resolveVideoReview } from "../lib/video-review.js";

function fixture() {
  return { version: 2, startSeconds: 10, endSeconds: 200, startScoreA: 18, startScoreB: 19, rallies: [
    { id: "r1", kind: "rally", start: 10, end: 25, decision: "A", suggested: "A" },
    { id: "r2", kind: "rally", start: 30, end: 50, decision: "unknown", suggested: "B" },
    { id: "r3", kind: "gap", start: 60, end: 120, decision: "unknown", suggested: "unknown" },
  ] };
}
function input() {
  return { coverageConfirmed: true, decisions: { r2: { winner: "A" }, r3: { scoreA: 1, scoreB: 0 } }, extraPoints: { scoreA: 0, scoreB: 0 } };
}
test("score is recomputed from reviewed rallies, not the model's total or browser total", () => {
  const resolved = resolveVideoReview(fixture(), { ...input(), scoreA: 99, scoreB: 0 });
  assert.equal(resolved.scoreA, 21);
  assert.equal(resolved.scoreB, 19);
  assert.deepEqual(resolved.decisions.r1, { winner: "A" });
});
test("gaps can contain several points, replay/duplicate rows no points, corrections replace proposals", () => {
  const result = resolveVideoReview(fixture(), { ...input(), decisions: {
    r1: { winner: "let" }, r2: { winner: "B" }, r3: { scoreA: 5, scoreB: 1 },
  } });
  assert.equal(result.scoreA, 23);
  assert.equal(result.scoreB, 21);
});
test("unresolved entries and missing coverage acknowledgement cannot be confirmed", () => {
  assert.throws(() => resolveVideoReview(fixture(), { ...input(), coverageConfirmed: false }));
  assert.throws(() => resolveVideoReview(fixture(), { ...input(), decisions: {} }));
  assert.throws(() => resolveVideoReview(fixture(), { ...input(), decisions: { r2: { winner: "A" } } }));
});
test("reject invalid ledgers, duplicate IDs, outside timestamps, coerced/negative scores and unknown choices", () => {
  for (const score of [null, "0", -1, 0.5, Infinity, 41, true]) {
    const submitted = input();
    submitted.decisions.r3.scoreA = score;
    assert.throws(() => resolveVideoReview(fixture(), submitted));
  }
  assert.throws(() => resolveVideoReview(fixture(), { ...input(), decisions: { ...input().decisions, evil: { winner: "A" } } }));
  const review = fixture();
  review.rallies.push(review.rallies[0]);
  assert.equal(normalizeVideoReview(review), null);
  review.rallies.pop();
  review.rallies[0].end = 201;
  assert.equal(normalizeVideoReview(review), null);
});
