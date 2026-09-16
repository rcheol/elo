"""Two-pass team-level observation; deterministic scoring happens after review."""
from __future__ import annotations

import asyncio
import json
import httpx

from app.models import Evidence, Score, VideoScoreResult
from app.rally_ledger import build_review, deduplicate, parse_observations, provisional_score
from app.review_frames import ReviewVideo, evidence_sheet
from app.providers.heuristics import extract_json_object, infer_winner


async def analyze_rally_review(youtube_url, *, player_mapping, hint, settings, request):
    # Import here because the legacy public provider entry point delegates here.
    from app.providers.gemma_frames import _build_chat_payload, _post_gemma_chat, _extract_chat_text, _build_match_payload

    events, gaps, warnings = [], [], []
    calls = 0
    identity = [{"slot": slot.slot_id, "team": slot.team, "appearance": slot.description,
                 "referenceTime": slot.timestamp} for slot in request.player_slots]

    async def observe(frames, reference, *, end, detailed=False):
        nonlocal calls
        if calls >= 800:
            raise ValueError("Model call budget reached; remaining intervals require review.")
        start = frames[0][0]
        prompt = (
            "Observe ONE badminton doubles game. Images are chronological and stamped in absolute VIDEO seconds. "
            "The REFERENCE panel is identity only, NOT part of this time sequence. "
            "A1/A2 belong to team A, B1/B2 to B. Track TEAM appearance, not left/right screen positions. "
            "Teams may change ends. Never identify a winner from a name or assume near court is A. "
            "Report observable events only; do NOT calculate a score or assume a 21-point ending. "
            "serve = actual racket/shuttle service contact, not waiting pose or picking up a shuttle. "
            "end = a rally visibly finishes; its team is the point winner, unknown if not demonstrable. "
            "A shuttle on the floor alone does not prove who won (out, net fault, let are possible). "
            "A next serve is supporting evidence only, not a new point by itself. "
            "let = visibly replayed rally, no point. cut = edit/replay/camera cut, uncertain = play cannot be resolved. "
            "Include uncertain events rather than silently omitting likely rallies. "
            "Never infer unseen contacts or unseen flight between frames. "
            f"Only events in [{start:.3f}, {end:.3f}] seconds. "
            "Return JSON {\"events\":[{\"seconds\":12.5,\"type\":\"serve|end|let|cut|uncertain\","
            "\"team\":\"A|B|unknown\",\"confidence\":0.0,\"evidence\":\"brief visible evidence\"}]}. "
            "Use an empty events array only when no event is visible. "
            "Write brief evidence descriptions in Korean. "
            + ("This is an independent dense second pass. Be conservative about the rally outcome. " if detailed else "")
            + "Identity reference: " + json.dumps(identity, ensure_ascii=False)
            + " User context (not evidence): " + (hint or request.hint)[:600]
        )
        payload = _build_chat_payload(model=settings.gemma_model, system="Observe badminton events. Return JSON only.",
                                      prompt=prompt, frames=[], max_tokens=1000)
        overhead = len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + 200
        # Both image data and UTF-8 text count toward the actual POST limit.
        try:
            data_url = await asyncio.to_thread(evidence_sheet, frames, reference,
                                              budget=min(40000, settings.gemma_request_max_bytes) - overhead)
        except ValueError:
            if len(frames) <= 3:
                raise
            middle = len(frames) // 2
            left = await observe(frames[:middle + 1], reference, end=frames[middle][0], detailed=detailed)
            right = await observe(frames[middle:], reference, end=end, detailed=detailed)
            return left + right
        payload["messages"][1]["content"].append({"type": "image_url", "image_url": {"url": data_url}})
        calls += 1
        try:
            raw, error = await _post_gemma_chat(settings, payload)
        except httpx.HTTPError as exc:
            raise ValueError(f"Gemma transport failure: {type(exc).__name__}") from exc
        if error:
            raise ValueError(error[:250])
        parsed = extract_json_object(_extract_chat_text(raw))
        return parse_observations(parsed, start, end)

    video = ReviewVideo(youtube_url, request.start_seconds, request.end_seconds)
    await asyncio.to_thread(video.__enter__)
    try:
        try:
            reference = await asyncio.to_thread(video.reference, request.player_slots)
        except (RuntimeError, OSError, ValueError):
            reference = None
        if reference is None:
            warnings.append("Visual identity reference is missing; verify team attribution for every rally.")
        # A fixed 2 fps first pass. A frame budget truncates coverage explicitly;
        # unlike the old code it never stretches the sampling interval silently.
        scan_end = min(video.end, video.start + (request.max_frames or 2400) / 2)
        frames = await asyncio.to_thread(video.frames, video.start, scan_end, fps=2, prefix="coarse")
        consecutive_failures = 0
        for index in range(0, len(frames), 4):
            batch = frames[max(0, index - 2):index + 4]
            end = min(scan_end, batch[-1][0] + 0.5)
            if index % 80 == 0:
                print(f"Rally review scan: {batch[0][0]:.1f}/{video.end:.1f}s, model requests: {calls}")
            try:
                observations = await observe(batch, reference, end=end)
                events.extend(observations)
                consecutive_failures = 0
            except (ValueError, RuntimeError) as exc:
                gaps.append({"start": batch[0][0], "end": end, "reason": "unobserved_interval"})
                if len(warnings) < 8:
                    warnings.append(f"{batch[0][0]:.1f}s: {exc}")
                consecutive_failures += 1
                if consecutive_failures >= 3:
                    gaps.append({"start": batch[0][0], "end": video.end, "reason": "unobserved_interval"})
                    warnings.append("Stopped after three consecutive failed windows; remaining footage needs review.")
                    break
        if scan_end < video.end:
            gaps.append({"start": scan_end, "end": video.end, "reason": "frame_budget_exhausted"})

        events = deduplicate(events)
        candidates = [event for event in events if event["type"] in {"end", "let"}]
        for index, candidate in enumerate(candidates):
            center = candidate["seconds"]
            try:
                # Re-extract ORIGINAL cached pixels at 8 fps, not enlargement
                # or interpolation of the first pass's tiny contact sheet.
                dense = await asyncio.to_thread(video.frames, center - 0.5, center + 0.5,
                                                fps=8, prefix=f"detail-{index}")
                checked = []
                for offset in range(0, len(dense), 4):
                    batch = dense[max(0, offset - 2):offset + 4]
                    checked.extend(await observe(batch, reference, end=min(video.end, batch[-1][0] + 0.125), detailed=True))
                endings = [event for event in checked if event["type"] == candidate["type"]]
                conflicts = any(event["type"] in {"cut", "uncertain"} for event in checked)
                candidate["verified"] = bool(reference is not None and endings and not conflicts and all(
                    event["team"] == candidate["team"] and event["confidence"] >= 0.8 for event in endings))
            except (ValueError, RuntimeError):
                candidate["verified"] = False

        review = build_review(events, gaps, start=video.start, end=video.end,
                              start_score_a=request.start_score_a, start_score_b=request.start_score_b)
        if len(review["rallies"]) > 100:
            # Never truncate a ledger and pretend it covers the whole game.
            review = build_review([], [{"start": video.start, "end": video.end, "reason": "too_many_events"}],
                                  start=video.start, end=video.end,
                                  start_score_a=request.start_score_a, start_score_b=request.start_score_b)
        a, b = provisional_score(review)
        score = Score(team_a=a, team_b=b, winner=infer_winner(a, b), confidence=0) if max(a, b) <= 40 else None
        warnings.append("Experimental rally candidates, not a validated final score. Review gaps, missed rallies, and game boundaries.")
        return VideoScoreResult(
            analysis_version=2, review=review, score=score, needs_confirmation=True,
            warnings=warnings, evidence=[Evidence(text=f"Two-pass review: {calls} model requests, {len(review['rallies'])} review intervals.")],
            match_payload=_build_match_payload(player_mapping, score),
        )
    finally:
        await asyncio.to_thread(video.__exit__)
