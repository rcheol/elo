from __future__ import annotations

import httpx
import json
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple

from app.config import Settings
from app.frame_extractor import (
    ExtractedFrame,
    ExtractedFrameWindow,
    extract_evenly_spaced_frames_from_youtube,
    extract_tail_frames_from_youtube,
    extract_timeline_frame_windows_from_youtube,
)
from app.models import (
    AnalyzeRequest,
    AnalyzeResponse,
    Evidence,
    PlayerSlot,
    ReferenceFrame,
    Score,
    ScoreReading,
    ScoreScanRequest,
    SlotPlayer,
    VideoScoreResult,
)
from app.providers.heuristics import extract_json_object, infer_winner, normalize_gemini_payload, score_has_badminton_shape


@dataclass(frozen=True)
class RallyEvent:
    timestamp: str
    event_type: str
    rally_winner: str
    serving_team: str
    confidence: float
    note: str


async def analyze_with_gemma_frames(request: AnalyzeRequest, settings: Settings) -> AnalyzeResponse:
    try:
        frames = _build_frame_inputs(request, settings)
    except RuntimeError as exc:
        return AnalyzeResponse(
            status="failed",
            provider="gemma_frames",
            model=settings.gemma_model,
            warnings=[str(exc)],
        )

    prompt = _build_prompt(request, frames)
    payload = _build_chat_payload(
        model=settings.gemma_model,
        system="You extract final badminton doubles scores from scoreboard frames. Return JSON only.",
        prompt=prompt,
        frames=frames,
        max_tokens=800,
    )
    raw, error = await _post_gemma_chat(settings, payload)
    if error:
        return AnalyzeResponse(
            status="failed",
            provider="gemma_frames",
            model=settings.gemma_model,
            warnings=[error],
            raw=raw if request.save_raw else None,
        )

    try:
        parsed = extract_json_object(_extract_chat_text(raw))
        score_payload, evidence_payload, warnings = normalize_gemini_payload(parsed)
    except ValueError as exc:
        return AnalyzeResponse(
            status="failed",
            provider="gemma_frames",
            model=settings.gemma_model,
            warnings=[str(exc)],
            raw=raw if request.save_raw else None,
        )

    warnings.append(f"Gemma checked {len(frames)} sampled frame(s).")
    return AnalyzeResponse(
        status="succeeded" if score_payload else "failed",
        provider="gemma_frames",
        model=settings.gemma_model,
        score=Score(**score_payload) if score_payload else None,
        evidence=[Evidence(**item) for item in evidence_payload],
        warnings=warnings,
        raw=raw if request.save_raw else None,
    )


async def detect_player_slots_with_gemma(
    youtube_url: str,
    *,
    hint: str,
    settings: Settings,
    max_frames: int,
    save_raw: bool,
) -> Tuple[List[ReferenceFrame], List[PlayerSlot], List[str], Optional[Dict]]:
    frames = extract_evenly_spaced_frames_from_youtube(
        youtube_url,
        max_frames=max_frames,
        max_height=settings.gemma_player_frame_max_height,
        jpeg_quality=settings.gemma_player_frame_jpeg_quality,
        start_ratio=0.04,
        end_ratio=0.88,
    )

    warnings: List[str] = []
    best_candidate: Optional[Tuple[ExtractedFrame, List[PlayerSlot], List[str], Optional[Dict], float, bool]] = None

    for index, frame in enumerate(frames, start=1):
        payload = _build_chat_payload(
            model=settings.gemma_model,
            system="You label four anonymous badminton doubles players from one reference frame. Return JSON only.",
            prompt=_build_single_frame_player_slot_prompt(hint, frame, index=index, total=len(frames)),
            frames=[frame],
            max_tokens=1000,
        )
        raw, error = await _post_gemma_chat(settings, payload)
        if error:
            warnings.append(f"{frame.timestamp_label}: {error}")
            continue

        try:
            parsed = extract_json_object(_extract_chat_text(raw))
            slots, slot_warnings = _parse_player_slots(parsed)
            candidate_score = _player_slot_candidate_score(parsed, slots)
            candidate_found = _player_slot_candidate_is_found(parsed, slots)
        except ValueError as exc:
            warnings.append(f"{frame.timestamp_label}: {exc}")
            continue

        candidate = (frame, slots, slot_warnings, raw if save_raw else None, candidate_score, candidate_found)
        if not best_candidate or candidate_score > best_candidate[4]:
            best_candidate = candidate

    if best_candidate:
        frame, slots, slot_warnings, raw, _score, candidate_found = best_candidate
        message = (
            f"Selected the clearest player-mapping frame at {frame.timestamp_label} after checking {len(frames)} candidate frames."
            if candidate_found else
            f"Using the best available player-mapping frame at {frame.timestamp_label} after checking {len(frames)} candidate frames."
        )
        return _reference_frames([frame]), slots, warnings + slot_warnings + [message], raw

    raise RuntimeError("Could not find a usable reference frame for player mapping. " + " ".join(warnings[-3:]))


async def analyze_score_scan_with_gemma(
    youtube_url: str,
    *,
    player_mapping: Dict[str, SlotPlayer],
    hint: str,
    settings: Settings,
    request: ScoreScanRequest,
) -> VideoScoreResult:
    windows = extract_timeline_frame_windows_from_youtube(
        youtube_url,
        interval_seconds=request.scan_interval_seconds or settings.gemma_score_scan_interval_seconds,
        max_sampled_frames=request.max_frames or settings.gemma_score_scan_max_frames,
        max_height=settings.gemma_rally_frame_max_height,
        jpeg_quality=settings.gemma_rally_frame_jpeg_quality,
        frames_per_window=settings.gemma_rally_window_frames,
    )
    warnings: List[str] = [
        f"Gemma analyzed {len(windows)} timeline window(s) with rally-flow scoring."
    ]
    readings: List[ScoreReading] = []
    scoreboard_readings: List[ScoreReading] = []
    evidence: List[Evidence] = []
    raw_batches: List[Dict] = []
    recent_events: List[str] = []
    score_a = 0
    score_b = 0
    accepted_rallies = 0
    ignored_rallies = 0
    min_confidence = max(0.0, min(1.0, settings.gemma_rally_min_confidence))

    for window_index, window in enumerate(windows, start=1):
        payload = _build_chat_payload(
            model=settings.gemma_model,
            system="You analyze badminton doubles rally flow from short timeline image strips. Return structured JSON only.",
            prompt=_build_rally_scan_prompt(
                window,
                player_mapping=player_mapping,
                hint=hint or request.hint,
                window_index=window_index,
                current_score_a=score_a,
                current_score_b=score_b,
                recent_events=recent_events,
            ),
            frames=[window],
            max_tokens=1100,
        )
        raw, error = await _post_gemma_chat(settings, payload)
        if error:
            warnings.append(f"{window.time_range_label}: {error}")
            if raw:
                raw_batches.append(raw)
            continue

        if request.save_raw:
            raw_batches.append(raw)
        try:
            parsed = extract_json_object(_extract_chat_text(raw))
            events, batch_scoreboards, batch_evidence, batch_warnings = _parse_rally_window_analysis(parsed)
            for reading in batch_scoreboards:
                if not reading.timestamp:
                    reading.timestamp = window.timestamp_label
            scoreboard_readings.extend(batch_scoreboards)
            evidence.extend(batch_evidence)
            warnings.extend(f"{window.time_range_label}: {item}" for item in batch_warnings)
        except ValueError as exc:
            warnings.append(f"{window.time_range_label}: {exc}")
            continue

        for event in sorted(events, key=lambda item: _event_timestamp_seconds(item, fallback=window.timestamp_seconds)):
            if event.event_type in {"serve", "service", "rally_start"}:
                recent_events = _append_recent_event(
                    recent_events,
                    f"{event.timestamp or window.timestamp_label} serve {event.serving_team}: {event.note}",
                )
                continue

            if event.event_type not in {"rally_end", "point", "dead_shuttle", "fault"}:
                continue

            if event.rally_winner not in {"A", "B"} or event.confidence < min_confidence:
                ignored_rallies += 1
                recent_events = _append_recent_event(
                    recent_events,
                    f"{event.timestamp or window.timestamp_label} ignored {event.rally_winner}: {event.note}",
                )
                continue

            event_seconds = _event_timestamp_seconds(event, fallback=window.timestamp_seconds)
            if event.rally_winner == "A":
                score_a += 1
            else:
                score_b += 1
            accepted_rallies += 1

            reading = ScoreReading(
                timestamp=_format_seconds(event_seconds),
                score_a=score_a,
                score_b=score_b,
                confidence=event.confidence,
                note=f"{event.rally_winner} rally win. {event.note}".strip(),
            )
            readings.append(reading)
            evidence.append(Evidence(timestamp=reading.timestamp, text=reading.note))
            recent_events = _append_recent_event(
                recent_events,
                f"{reading.timestamp} {event.rally_winner}+1 => {score_a}:{score_b}",
            )

            if score_has_badminton_shape(score_a, score_b):
                warnings.append(f"Stopped after a valid badminton final score at {reading.timestamp}.")
                break

        if readings and score_has_badminton_shape(score_a, score_b):
            break

        checkpoint = _select_scoreboard_checkpoint(batch_scoreboards, score_a, score_b, accepted_rallies)
        if checkpoint:
            score_a = checkpoint.score_a
            score_b = checkpoint.score_b
            readings.append(
                ScoreReading(
                    timestamp=checkpoint.timestamp,
                    score_a=score_a,
                    score_b=score_b,
                    confidence=checkpoint.confidence,
                    note=f"Visible scoreboard checkpoint. {checkpoint.note}".strip(),
                )
            )
            evidence.append(Evidence(timestamp=checkpoint.timestamp, text=readings[-1].note))
            recent_events = _append_recent_event(
                recent_events,
                f"{checkpoint.timestamp} scoreboard checkpoint => {score_a}:{score_b}",
            )

    if readings:
        score = Score(
            team_a=score_a,
            team_b=score_b,
            winner=infer_winner(score_a, score_b),
            confidence=_score_confidence_from_readings(readings, score_a, score_b),
        )
        warnings.append(f"Accepted {accepted_rallies} rally-ending event(s); ignored {ignored_rallies} unclear event(s).")
        if not score_has_badminton_shape(score_a, score_b):
            warnings.append("Rally-flow score does not yet look like a complete badminton game; please verify before registering.")
    else:
        score, score_warning = _select_final_score(scoreboard_readings)
        if score_warning:
            warnings.append(score_warning)
        if score:
            warnings.append("No confident rally endings were found; fell back to visible scoreboard checkpoints.")

    return VideoScoreResult(
        score=score,
        readings=readings,
        evidence=evidence[:12],
        warnings=warnings,
        needs_confirmation=True,
        match_payload=_build_match_payload(player_mapping, score),
    )


def _build_chat_payload(
    *,
    model: str,
    system: str,
    prompt: str,
    frames: List[Any],
    max_tokens: int,
) -> Dict:
    return {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": system,
            },
            {
                "role": "user",
                "content": [{"type": "text", "text": prompt}]
                + [{"type": "image_url", "image_url": {"url": frame.data_url}} for frame in frames],
            },
        ],
        "temperature": 0,
        "max_tokens": max_tokens,
    }


async def _post_gemma_chat(settings: Settings, payload: Dict) -> Tuple[Dict, Optional[str]]:
    payload_size = _json_payload_size(payload)
    if payload_size > settings.gemma_request_max_bytes:
        return {}, (
            f"Gemma request payload is {payload_size} bytes, above "
            f"GEMMA_REQUEST_MAX_BYTES={settings.gemma_request_max_bytes}. "
            "Lower GEMMA_FRAME_MAX_HEIGHT, raise GEMMA_FRAME_JPEG_QUALITY, or reduce batch size."
        )

    headers = {
        "Authorization": f"Bearer {settings.gemma_api_key}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(settings.request_timeout_seconds),
        verify=settings.gemma_verify_tls,
    ) as client:
        response = await client.post(settings.gemma_chat_completions_url, headers=headers, json=payload)

    if response.status_code >= 400:
        if response.status_code == 403 and "Access Upload Denied" in response.text:
            return _try_json(response) or {}, (
                "Gemma API upload was blocked by company policy. "
                "The worker will need smaller frames or fewer frames per request."
            )
        return _try_json(response) or {}, f"Gemma API error {response.status_code}: {response.text[:500]}"

    return response.json(), None


def _json_payload_size(payload: Dict) -> int:
    return len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _build_frame_inputs(request: AnalyzeRequest, settings: Settings) -> List[ExtractedFrame]:
    if request.frame_image_urls:
        return [
            ExtractedFrame(timestamp_seconds=0, data_url=url)
            for url in request.frame_image_urls
        ]

    return extract_tail_frames_from_youtube(
        request.youtube_url,
        tail_seconds=request.frame_tail_seconds or settings.gemma_frame_tail_seconds,
        max_frames=request.frame_max_frames or settings.gemma_frame_max_frames,
        max_height=settings.gemma_frame_max_height,
        jpeg_quality=settings.gemma_frame_jpeg_quality,
    )


def _build_prompt(request: AnalyzeRequest, frames: List[ExtractedFrame]) -> str:
    players = ", ".join(request.expected_players) if request.expected_players else "unknown"
    timestamps = ", ".join(_format_seconds(frame.timestamp_seconds) for frame in frames)
    hint = request.hint.strip() or "Read the visible scoreboard digits in the latest frame where the match appears finished."

    return f"""
Analyze these sampled frames from the tail of one badminton doubles video.

Return only this JSON object:
{{
  "found": true or false,
  "scoreA": integer,
  "scoreB": integer,
  "winner": "A" or "B" or "unknown",
  "confidence": number between 0 and 1,
  "evidence": [{{"timestamp": "MM:SS", "text": "short reason"}}],
  "reason": "short explanation"
}}

Rules:
- Team A is the left/top/first-listed team. Team B is the right/bottom/second-listed team.
- Extract the final completed game score, not an intermediate rally score.
- Badminton usually ends at 21 with a 2-point lead or 30-29.
- If the scoreboard is unclear, set found=false and scoreA=0, scoreB=0.
- Expected players: {players}
- Frame timestamps: {timestamps}
- Extra hint: {hint}
""".strip()


def _build_player_slot_prompt(hint: str, frames: List[ExtractedFrame]) -> str:
    timestamps = ", ".join(frame.timestamp_label for frame in frames)
    user_hint = hint.strip() or "Use the clearest frame where all four players are visible."
    return f"""
Analyze these badminton doubles reference frames and define four anonymous player slots for user confirmation.

Return only this JSON object:
{{
  "slots": [
    {{"slotId": "A1", "team": "A", "label": "A팀 앞/왼쪽", "description": "visual description", "timestamp": "MM:SS", "confidence": 0.0}},
    {{"slotId": "A2", "team": "A", "label": "A팀 뒤/오른쪽", "description": "visual description", "timestamp": "MM:SS", "confidence": 0.0}},
    {{"slotId": "B1", "team": "B", "label": "B팀 앞/왼쪽", "description": "visual description", "timestamp": "MM:SS", "confidence": 0.0}},
    {{"slotId": "B2", "team": "B", "label": "B팀 뒤/오른쪽", "description": "visual description", "timestamp": "MM:SS", "confidence": 0.0}}
  ],
  "warnings": ["optional warning"]
}}

Rules:
- Do not identify real names. The user will map these slots to real players.
- Team A means the left/top/first-visible team from the camera perspective.
- Team B means the right/bottom/opposite team from the camera perspective.
- Keep descriptions short but useful: clothes color, side of court, near/far position, dominant visual cue.
- Frame timestamps: {timestamps}
- User hint: {user_hint}
""".strip()


def _build_single_frame_player_slot_prompt(hint: str, frame: ExtractedFrame, *, index: int, total: int) -> str:
    user_hint = hint.strip() or "Find the clearest single frame for a human to map all four doubles players."
    return f"""
Analyze this single badminton doubles frame as a candidate for human player mapping.

Return only this JSON object:
{{
  "found": true or false,
  "visiblePlayers": 0,
  "distinguishablePlayers": 0,
  "qualityScore": 0,
  "identificationQuality": "excellent" or "good" or "fair" or "poor",
  "reason": "short explanation",
  "slots": [
    {{"slotId": "A1", "team": "A", "label": "near-left", "description": "short visual cue", "timestamp": "{frame.timestamp_label}", "confidence": 0.0}},
    {{"slotId": "A2", "team": "A", "label": "near-right", "description": "short visual cue", "timestamp": "{frame.timestamp_label}", "confidence": 0.0}},
    {{"slotId": "B1", "team": "B", "label": "far-left", "description": "short visual cue", "timestamp": "{frame.timestamp_label}", "confidence": 0.0}},
    {{"slotId": "B2", "team": "B", "label": "far-right", "description": "short visual cue", "timestamp": "{frame.timestamp_label}", "confidence": 0.0}}
  ],
  "warnings": ["optional warning"]
}}

Rules:
- Analyze only this one frame. Do not use other timestamps.
- Set found=true only when four actual badminton players are simultaneously visible and distinguishable by a human.
- Do not identify real names. The user will map these anonymous slots to real players.
- Team A is the near/bottom/first-side team from the camera perspective. Team B is the far/top/opposite-side team.
- Within each team, left/right is from the camera perspective.
- Prefer frames where all four players are separated, not hidden behind each other, not motion-blurred, and large enough to inspect clothing/body cues.
- Penalize frames where far-side players are tiny, cropped, blocked, blurred, or all wearing similar clothing with no useful distinguishing cue.
- qualityScore is 0-100 for user mapping usefulness, not for match action quality.
- distinguishablePlayers is how many of the four can be told apart from the others in this frame.
- Slot confidence should reflect whether that exact slot can be mapped visually, not whether a player exists somewhere in the frame.
- Keep descriptions short and useful: clothing color, court side, near/far, left/right, stance, racket hand, shorts/skirt color, shoe color, or pose.
- Candidate frame {index} of {total}, timestamp: {frame.timestamp_label}
- User hint: {user_hint}
""".strip()


def _build_score_scan_prompt(
    frames: List[ExtractedFrame],
    *,
    player_mapping: Dict[str, SlotPlayer],
    hint: str,
    batch_index: int,
) -> str:
    mapping_text = ", ".join(
        f"{slot}={player.player_name}" for slot, player in sorted(player_mapping.items())
    ) or "not mapped"
    timestamps = ", ".join(frame.timestamp_label for frame in frames)
    user_hint = hint.strip() or "Read visible scoreboard digits. If no scoreboard is visible, omit that frame."
    return f"""
Analyze scoreboard information in this batch of badminton doubles frames.

Return only this JSON object:
{{
  "readings": [
    {{"timestamp": "MM:SS", "scoreA": 0, "scoreB": 0, "confidence": 0.0, "note": "short reason"}}
  ],
  "evidence": [
    {{"timestamp": "MM:SS", "text": "short visual evidence"}}
  ],
  "warnings": ["optional warning"]
}}

Rules:
- Batch number: {batch_index}
- Team mapping: {mapping_text}
- Team A score is the score for A1/A2. Team B score is the score for B1/B2.
- Only include a reading when scoreboard digits or an on-screen final score are visible enough.
- If the frame shows a scoreboard but the team order is ambiguous, use the established A/B side mapping and reduce confidence.
- Ignore dates, timestamps, court numbers, player jersey numbers, and YouTube UI numbers.
- Frame timestamps in order: {timestamps}
- User hint: {user_hint}
""".strip()


def _build_rally_scan_prompt(
    window: ExtractedFrameWindow,
    *,
    player_mapping: Dict[str, SlotPlayer],
    hint: str,
    window_index: int,
    current_score_a: int,
    current_score_b: int,
    recent_events: List[str],
) -> str:
    mapping_text = ", ".join(
        f"{slot}={player.player_name}" for slot, player in sorted(player_mapping.items())
    ) or "not mapped"
    labels = window.panel_timestamp_labels
    panel_text = ", ".join(
        f"panel {index + 1}={label}" for index, label in enumerate(labels)
    )
    user_hint = hint.strip() or "Infer rally flow from serve, shuttle landing/dead-ball moments, player reactions, and court position."
    recent_text = "; ".join(recent_events[-6:]) if recent_events else "none"
    return f"""
Analyze this badminton doubles timeline image strip.

The image is one horizontal contact sheet, ordered left to right:
{panel_text}

Return only this JSON object:
{{
  "events": [
    {{
      "timestamp": "MM:SS",
      "type": "serve" or "rally_end" or "rally_in_progress" or "let" or "unclear",
      "servingTeam": "A" or "B" or "unknown",
      "rallyWinner": "A" or "B" or "unknown",
      "confidence": 0.0,
      "note": "short visual reason"
    }}
  ],
  "scoreboard": {{
    "visible": true or false,
    "scoreA": 0,
    "scoreB": 0,
    "confidence": 0.0,
    "note": "short reason"
  }},
  "evidence": [
    {{"timestamp": "MM:SS", "text": "short visual evidence"}}
  ],
  "warnings": ["optional warning"]
}}

Rules:
- Window number: {window_index}
- Team mapping: {mapping_text}
- Current accepted score before this window: A {current_score_a} : B {current_score_b}
- Team A is A1/A2. Team B is B1/B2. Use the established side mapping from the user confirmation.
- This is rally-point badminton: the winner of every completed rally receives exactly one point.
- A rally starts when the serve is struck and ends when the shuttle touches the court, lands out, hits the net and is not returned, a fault is clear, or all players stop and prepare for the next serve.
- Detect serve moments and rally-ending/dead-shuttle moments. Use player posture, shuttle direction, retrieval, celebration, reset behavior, and court side.
- Add a rally_end only when this strip shows enough evidence that one completed rally ended in this time range.
- If two panels show the same rally already ending, report only one rally_end.
- If the shuttle is too small or the winner is uncertain, use type="unclear" or rallyWinner="unknown"; do not guess.
- Do not output cumulative scores in events. The application will add one point for each accepted rally_end.
- The scoreboard object is only a checkpoint when on-screen digits are clearly visible; do not invent scoreboard digits.
- Recent accepted context: {recent_text}
- Extra hint: {user_hint}
""".strip()


def _parse_rally_window_analysis(payload: Dict[str, Any]) -> Tuple[List[RallyEvent], List[ScoreReading], List[Evidence], List[str]]:
    warnings = [str(item) for item in payload.get("warnings", []) if item]
    events: List[RallyEvent] = []
    for item in payload.get("events", []):
        if not isinstance(item, dict):
            continue
        event_type = str(item.get("type") or item.get("eventType") or item.get("event_type") or "").strip().lower()
        if not event_type:
            event_type = "unclear"
        rally_winner = str(item.get("rallyWinner") or item.get("rally_winner") or item.get("winner") or "unknown").strip().upper()
        serving_team = str(item.get("servingTeam") or item.get("serving_team") or "unknown").strip().upper()
        events.append(
            RallyEvent(
                timestamp=str(item.get("timestamp") or ""),
                event_type=event_type,
                rally_winner=rally_winner if rally_winner in {"A", "B"} else "unknown",
                serving_team=serving_team if serving_team in {"A", "B"} else "unknown",
                confidence=max(0.0, min(1.0, _safe_float(item.get("confidence"), default=0.0))),
                note=str(item.get("note") or item.get("reason") or ""),
            )
        )

    scoreboards: List[ScoreReading] = []
    board = payload.get("scoreboard")
    if isinstance(board, dict) and _truthy(board.get("visible")):
        try:
            score_a = int(board.get("scoreA", board.get("score_a")))
            score_b = int(board.get("scoreB", board.get("score_b")))
        except (TypeError, ValueError):
            warnings.append("Scoreboard was marked visible but scoreA/scoreB were not numeric.")
        else:
            if 0 <= score_a <= 40 and 0 <= score_b <= 40:
                scoreboards.append(
                    ScoreReading(
                        timestamp=str(board.get("timestamp") or ""),
                        score_a=score_a,
                        score_b=score_b,
                        confidence=max(0.0, min(1.0, _safe_float(board.get("confidence"), default=0.0))),
                        note=str(board.get("note") or ""),
                    )
                )

    evidence: List[Evidence] = []
    for item in payload.get("evidence", []):
        if isinstance(item, dict):
            evidence.append(Evidence(timestamp=str(item.get("timestamp") or ""), text=str(item.get("text") or "")))
        elif item:
            evidence.append(Evidence(text=str(item)))

    return events, scoreboards, evidence, warnings


def _select_scoreboard_checkpoint(
    readings: List[ScoreReading],
    score_a: int,
    score_b: int,
    accepted_rallies: int,
) -> Optional[ScoreReading]:
    valid = [
        reading for reading in readings
        if reading.confidence >= 0.75
        and reading.score_a >= score_a
        and reading.score_b >= score_b
    ]
    if not valid:
        return None

    selected = max(valid, key=lambda item: (_timestamp_to_seconds(item.timestamp), item.confidence))
    jump = (selected.score_a - score_a) + (selected.score_b - score_b)
    if jump <= 0:
        return None
    if accepted_rallies == 0 and jump <= 4:
        return selected
    if jump <= 2:
        return selected
    return None


def _event_timestamp_seconds(event: RallyEvent, *, fallback: float) -> int:
    value = _timestamp_to_seconds(event.timestamp)
    return value if value > 0 else int(fallback)


def _append_recent_event(items: List[str], item: str) -> List[str]:
    return (items + [item])[-8:]


def _score_confidence_from_readings(readings: List[ScoreReading], score_a: int, score_b: int) -> float:
    if not readings:
        return 0.0
    recent = readings[-12:]
    average = sum(item.confidence for item in recent) / len(recent)
    if score_has_badminton_shape(score_a, score_b):
        return max(0.55, min(0.92, average))
    return max(0.25, min(0.5, average))


def _parse_player_slots(payload: Dict) -> Tuple[List[PlayerSlot], List[str]]:
    warnings = [str(item) for item in payload.get("warnings", []) if item]
    slots_by_id: Dict[str, PlayerSlot] = {}
    for item in payload.get("slots", []):
        if not isinstance(item, dict):
            continue
        slot_id = str(item.get("slotId") or item.get("slot_id") or "").upper()
        if slot_id not in {"A1", "A2", "B1", "B2"}:
            continue
        team = "A" if slot_id.startswith("A") else "B"
        confidence = _safe_float(item.get("confidence"), default=0.0)
        slots_by_id[slot_id] = PlayerSlot(
            slot_id=slot_id,
            team=team,
            label=str(item.get("label") or _default_slot_label(slot_id)),
            description=str(item.get("description") or ""),
            timestamp=str(item.get("timestamp") or ""),
            confidence=max(0.0, min(1.0, confidence)),
        )

    slots = []
    for slot_id in ("A1", "A2", "B1", "B2"):
        slots.append(slots_by_id.get(slot_id) or PlayerSlot(
            slot_id=slot_id,
            team="A" if slot_id.startswith("A") else "B",
            label=_default_slot_label(slot_id),
            confidence=0.0,
        ))

    if len(slots_by_id) < 4:
        warnings.append("Gemma did not confidently label all four player slots; default slots were filled in.")
    return slots, warnings


def _player_slot_candidate_is_found(payload: Dict, slots: List[PlayerSlot]) -> bool:
    found = _truthy(payload.get("found") or payload.get("allPlayersVisible") or payload.get("all_players_visible"))
    visible_players = _safe_int(payload.get("visiblePlayers", payload.get("visible_players")), default=0)
    distinguishable_players = _safe_int(
        payload.get("distinguishablePlayers", payload.get("distinguishable_players")),
        default=0,
    )
    quality_score = _safe_float(payload.get("qualityScore", payload.get("quality_score")), default=0.0)
    identification_quality = str(payload.get("identificationQuality") or payload.get("identification_quality") or "").lower()
    described_slots = sum(1 for slot in slots if slot.description.strip())
    confident_slots = sum(1 for slot in slots if slot.confidence >= 0.45)
    average_confidence = sum(slot.confidence for slot in slots) / max(1, len(slots))
    return (
        found
        and visible_players >= 4
        and distinguishable_players >= 4
        and described_slots >= 4
        and confident_slots >= 3
        and average_confidence >= 0.5
        and quality_score >= 60
        and identification_quality != "poor"
    )


def _player_slot_candidate_score(payload: Dict, slots: List[PlayerSlot]) -> float:
    visible_players = _safe_int(payload.get("visiblePlayers", payload.get("visible_players")), default=0)
    distinguishable_players = _safe_int(
        payload.get("distinguishablePlayers", payload.get("distinguishable_players")),
        default=0,
    )
    quality_score = _safe_float(payload.get("qualityScore", payload.get("quality_score")), default=0.0)
    identification_quality = str(payload.get("identificationQuality") or payload.get("identification_quality") or "").lower()
    described_slots = sum(1 for slot in slots if slot.description.strip())
    confidence_total = sum(slot.confidence for slot in slots)
    found_bonus = 8.0 if _truthy(payload.get("found") or payload.get("allPlayersVisible") or payload.get("all_players_visible")) else 0.0
    quality_bonus = {
        "excellent": 8.0,
        "good": 5.0,
        "fair": 2.0,
        "poor": -6.0,
    }.get(identification_quality, 0.0)
    text = " ".join(
        [
            str(payload.get("reason") or ""),
            " ".join(str(item) for item in payload.get("warnings", []) if item),
            " ".join(slot.description for slot in slots),
        ]
    ).lower()
    penalty = 0.0
    for keyword in ("tiny", "small", "far-side players are small", "blur", "motion", "occluded", "blocked", "cropped", "unclear"):
        if keyword in text:
            penalty += 2.0
    return (
        found_bonus
        + min(4, visible_players) * 1.5
        + min(4, distinguishable_players) * 3.0
        + described_slots
        + confidence_total * 3.0
        + quality_score / 5.0
        + quality_bonus
        - penalty
    )


def _parse_score_readings(payload: Dict) -> Tuple[List[ScoreReading], List[Evidence], List[str]]:
    warnings = [str(item) for item in payload.get("warnings", []) if item]
    readings: List[ScoreReading] = []
    for item in payload.get("readings", []):
        if not isinstance(item, dict):
            continue
        try:
            score_a = int(item.get("scoreA", item.get("score_a")))
            score_b = int(item.get("scoreB", item.get("score_b")))
        except (TypeError, ValueError):
            continue
        readings.append(
            ScoreReading(
                timestamp=str(item.get("timestamp") or ""),
                score_a=score_a,
                score_b=score_b,
                confidence=max(0.0, min(1.0, _safe_float(item.get("confidence"), default=0.0))),
                note=str(item.get("note") or ""),
            )
        )

    evidence: List[Evidence] = []
    for item in payload.get("evidence", []):
        if isinstance(item, dict):
            evidence.append(Evidence(timestamp=str(item.get("timestamp") or ""), text=str(item.get("text") or "")))
        elif item:
            evidence.append(Evidence(text=str(item)))
    return readings, evidence, warnings


def _select_final_score(readings: List[ScoreReading]) -> Tuple[Optional[Score], Optional[str]]:
    if not readings:
        return None, "No visible scoreboard readings were found."

    final_shaped = [reading for reading in readings if score_has_badminton_shape(reading.score_a, reading.score_b)]
    if final_shaped:
        selected = max(final_shaped, key=lambda reading: (_timestamp_to_seconds(reading.timestamp), reading.confidence))
        return Score(
            team_a=selected.score_a,
            team_b=selected.score_b,
            winner=infer_winner(selected.score_a, selected.score_b),
            confidence=selected.confidence,
        ), None

    selected = max(readings, key=lambda reading: (_timestamp_to_seconds(reading.timestamp), max(reading.score_a, reading.score_b), reading.confidence))
    return Score(
        team_a=selected.score_a,
        team_b=selected.score_b,
        winner=infer_winner(selected.score_a, selected.score_b),
        confidence=min(selected.confidence, 0.45),
    ), "No badminton-shaped final score was found; returning the latest visible scoreboard with low confidence."


def _build_match_payload(player_mapping: Dict[str, SlotPlayer], score: Optional[Score]) -> Optional[Dict]:
    if not score:
        return None
    if set(player_mapping.keys()) != {"A1", "A2", "B1", "B2"}:
        return None

    return {
        "teamA": [player_mapping["A1"].player_id, player_mapping["A2"].player_id],
        "teamB": [player_mapping["B1"].player_id, player_mapping["B2"].player_id],
        "scoreA": score.team_a,
        "scoreB": score.team_b,
    }


def _reference_frames(frames: List[ExtractedFrame]) -> List[ReferenceFrame]:
    return [
        ReferenceFrame(timestamp=frame.timestamp_label, image_data_url=frame.data_url)
        for frame in frames
    ]


def _chunks(items: List[ExtractedFrame], size: int) -> Iterable[List[ExtractedFrame]]:
    for index in range(0, len(items), size):
        yield items[index : index + size]


def _default_slot_label(slot_id: str) -> str:
    return {
        "A1": "A팀 선수 1",
        "A2": "A팀 선수 2",
        "B1": "B팀 선수 1",
        "B2": "B팀 선수 2",
    }.get(slot_id, slot_id)


def _timestamp_to_seconds(value: str) -> int:
    parts = [part for part in str(value).split(":") if part.isdigit()]
    total = 0
    for part in parts:
        total = total * 60 + int(part)
    return total


def _safe_float(value: object, *, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _safe_int(value: object, *, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _truthy(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "found"}
    return bool(value)


def _extract_chat_text(raw: Dict) -> str:
    choices = raw.get("choices")
    if isinstance(choices, list) and choices:
        message = choices[0].get("message", {})
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            texts = [item.get("text", "") for item in content if isinstance(item, dict)]
            joined = "\n".join(text for text in texts if text)
            if joined:
                return joined

    for key in ("output_text", "text", "response"):
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            return value

    raise ValueError("Gemma response did not include chat text.")


def _try_json(response: httpx.Response) -> Optional[Dict]:
    try:
        return response.json()
    except ValueError:
        return None


def _format_seconds(value: float) -> str:
    total = max(0, int(value))
    minutes, seconds = divmod(total, 60)
    return f"{minutes:02d}:{seconds:02d}"
