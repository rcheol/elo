from __future__ import annotations

import httpx
from typing import Dict, List, Optional

from app.config import Settings
from app.frame_extractor import ExtractedFrame, extract_tail_frames_from_youtube
from app.models import AnalyzeRequest, AnalyzeResponse, Evidence, Score
from app.providers.heuristics import extract_json_object, normalize_gemini_payload


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
    payload = {
        "model": settings.gemma_model,
        "messages": [
            {
                "role": "system",
                "content": "You extract final badminton doubles scores from scoreboard frames. Return JSON only.",
            },
            {
                "role": "user",
                "content": [{"type": "text", "text": prompt}]
                + [{"type": "image_url", "image_url": {"url": frame.data_url}} for frame in frames],
            },
        ],
        "temperature": 0,
        "max_tokens": 800,
    }
    headers = {
        "Authorization": f"Bearer {settings.gemma_api_key}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=httpx.Timeout(settings.request_timeout_seconds)) as client:
        response = await client.post(settings.gemma_chat_completions_url, headers=headers, json=payload)

    if response.status_code >= 400:
        return AnalyzeResponse(
            status="failed",
            provider="gemma_frames",
            model=settings.gemma_model,
            warnings=[f"Gemma API error {response.status_code}: {response.text[:1000]}"],
            raw=_try_json(response) if request.save_raw else None,
        )

    raw = response.json()
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

