"""Turn observations into reviewable rallies, never into an invented final score."""
from __future__ import annotations

import math
from typing import Any


def parse_observations(payload: dict, start: float, end: float) -> list[dict]:
    if not isinstance(payload, dict) or not isinstance(payload.get("events"), list):
        raise ValueError("Missing events array; this interval must be reviewed.")
    observations = []
    for event in payload["events"]:
        if not isinstance(event, dict):
            raise ValueError("Invalid event.")
        kind = event.get("type")
        if kind not in {"serve", "end", "let", "cut", "uncertain"}:
            raise ValueError("Unknown event type.")
        try:
            seconds = float(event.get("seconds", -1))
            confidence = float(event.get("confidence", 0))
        except (TypeError, ValueError) as exc:
            raise ValueError("Invalid numeric observation.") from exc
        if not math.isfinite(seconds) or not start <= seconds <= end:
            raise ValueError("Event timestamp is outside the observed interval.")
        if not math.isfinite(confidence) or not 0 <= confidence <= 1:
            raise ValueError("Invalid observation confidence.")
        observations.append({
            "seconds": seconds, "type": kind,
            "team": event.get("team") if event.get("team") in {"A", "B"} else "unknown",
            "confidence": confidence, "evidence": str(event.get("evidence", ""))[:180],
            "verified": False,
        })
    return observations


def deduplicate(events: list[dict]) -> list[dict]:
    result: list[dict] = []
    for event in sorted(events, key=lambda item: (item["seconds"], item["type"] != "serve")):
        previous = result[-1] if result else None
        # Do not merge across a serve: two genuine, short rallies are distinct.
        if previous and event["type"] == previous["type"] and event["seconds"] - previous["seconds"] <= 1.25:
            previous["verified"] = bool(previous.get("verified") or event.get("verified"))
            if previous["team"] != event["team"]:
                previous.update(team="unknown", confidence=0, verified=False)
            else:
                previous["confidence"] = min(previous["confidence"], event["confidence"])
            continue
        result.append(dict(event))
    return result


def build_review(events: list[dict], gaps: list[dict], *, start: float, end: float,
                 start_score_a: int = 0, start_score_b: int = 0) -> dict[str, Any]:
    gaps = [dict(gap) for gap in gaps]
    rows: list[dict] = []
    pending = None
    last_end = start
    for event in deduplicate(events):
        seconds, kind = event["seconds"], event["type"]
        if kind == "serve":
            if pending:
                gaps.append({"start": pending["seconds"], "end": seconds,
                             "reason": "missing_rally_end"})
            pending = event
            continue
        if kind in {"cut", "uncertain"}:
            gaps.append({"start": pending["seconds"] if pending else last_end,
                         "end": seconds, "reason": "cut_or_ambiguous_play"})
            pending = None
            last_end = seconds
            continue
        if kind not in {"end", "let"}:
            continue
        paired = pending is not None
        suggested = "let" if kind == "let" else event["team"]
        accepted = (paired and pending["confidence"] >= 0.8 and pending["team"] in {"A", "B"}
                    and event.get("verified") and event["confidence"] >= 0.8)
        rows.append({
            "start": max(start, round(pending["seconds"] if paired else last_end, 2)),
            "end": min(end, round(seconds, 2)), "kind": "rally",
            "suggested": suggested,
            "decision": suggested if accepted else "unknown",
            "reason": "two_pass_agreement" if accepted else "unverified_outcome" if paired else "missing_serve",
            "evidence": event["evidence"],
        })
        pending, last_end = None, seconds
    if pending:
        gaps.append({"start": pending["seconds"], "end": end, "reason": "unfinished_rally"})

    # Expand missing-coverage ranges to whole overlapping rallies so manual gap
    # counts cannot double-count partially observed points on either boundary.
    merged: list[dict] = []
    for gap in sorted(gaps, key=lambda item: item["start"]):
        left, right = max(start, gap["start"]), min(end, gap["end"])
        if right < left:
            continue
        overlapping = [row for row in rows if (row["start"] < right and row["end"] > left)
                       or (left == right and row["start"] <= left < row["end"])]
        if overlapping:
            left = min(left, *(row["start"] for row in overlapping))
            right = max(right, *(row["end"] for row in overlapping))
            rows = [row for row in rows if row not in overlapping]
        if merged and left <= merged[-1]["end"]:
            merged[-1]["end"] = max(right, merged[-1]["end"])
        else:
            merged.append({"start": max(start, round(left, 2)), "end": min(end, round(right, 2)), "kind": "gap",
                           "decision": "unknown", "suggested": "unknown",
                           "reason": gap["reason"], "evidence": ""})
    rows.extend(merged)
    if not rows:
        rows = [{"start": start, "end": end, "kind": "gap", "decision": "unknown",
                 "suggested": "unknown", "reason": "no_rallies_detected", "evidence": ""}]
    rows.sort(key=lambda item: (item["start"], item["end"]))
    for index, row in enumerate(rows):
        row["id"] = f"r{index + 1}"
    return {"version": 2, "startSeconds": start, "endSeconds": end,
            "startScoreA": start_score_a, "startScoreB": start_score_b, "rallies": rows}


def provisional_score(review: dict) -> tuple[int, int]:
    return (review["startScoreA"] + sum(row["decision"] == "A" for row in review["rallies"]),
            review["startScoreB"] + sum(row["decision"] == "B" for row in review["rallies"]))


def resolve_review(review: dict, submitted: dict | None) -> tuple[int, int]:
    if not submitted or submitted.get("coverageConfirmed") is not True:
        raise ValueError("Game boundaries and missed rallies must be reviewed.")
    decisions = submitted.get("decisions", {})
    if not isinstance(decisions, dict) or set(decisions) - {row["id"] for row in review["rallies"]}:
        raise ValueError("Invalid review decisions.")
    a, b = review["startScoreA"], review["startScoreB"]

    def points(choice):
        values = choice.get("scoreA"), choice.get("scoreB")
        if any(type(value) is not int or not 0 <= value <= 40 for value in values):
            raise ValueError("Both gap scores must be integers from 0 to 40.")
        return values

    for row in review["rallies"]:
        choice = decisions.get(row["id"], {})
        if row["kind"] == "gap":
            da, db = points(choice)
            a, b = a + da, b + db
        else:
            winner = choice.get("winner", row["decision"])
            if winner not in {"A", "B", "let"}:
                raise ValueError("Unresolved rally outcome.")
            a, b = a + (winner == "A"), b + (winner == "B")
    da, db = points(submitted.get("extraPoints", {}))
    a, b = a + da, b + db
    if a == b or max(a, b) > 40:
        raise ValueError("Invalid final score.")
    return a, b
