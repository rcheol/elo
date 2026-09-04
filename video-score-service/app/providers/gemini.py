from __future__ import annotations

import httpx
from typing import Dict, List

from app.config import Settings
from app.models import AnalyzeRequest, AnalyzeResponse, Evidence, Score
from app.providers.heuristics import extract_json_object, normalize_gemini_payload


GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"

SCORE_SCHEMA = {
    "type": "object",
    "properties": {
        "found": {"type": "boolean"},
        "scoreA": {"type": "integer", "minimum": 0, "maximum": 40},
        "scoreB": {"type": "integer", "minimum": 0, "maximum": 40},
        "winner": {"type": "string", "enum": ["A", "B", "unknown"]},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "evidence": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "timestamp": {"type": "string"},
                    "text": {"type": "string"},
                },
                "required": ["timestamp", "text"],
            },
        },
        "reason": {"type": "string"},
    },
    "required": ["found", "scoreA", "scoreB", "winner", "confidence", "evidence", "reason"],
}


async def analyze_with_gemini(request: AnalyzeRequest, settings: Settings) -> AnalyzeResponse:
    payload = _build_payload(request, settings)
    headers = {
        "x-goog-api-key": settings.gemini_api_key,
        "Content-Type": "application/json",
    }
    timeout = httpx.Timeout(settings.request_timeout_seconds)

    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(GEMINI_INTERACTIONS_URL, headers=headers, json=payload)

    if response.status_code >= 400:
        return AnalyzeResponse(
            status="failed",
            provider="gemini",
            model=settings.gemini_video_model,
            warnings=[f"Gemini API error {response.status_code}: {response.text[:1000]}"],
            raw=response.json() if _looks_like_json(response.text) else None,
        )

    raw = response.json()
    try:
        output_text = _extract_output_text(raw)
        parsed = extract_json_object(output_text)
        score_payload, evidence_payload, warnings = normalize_gemini_payload(parsed)
    except ValueError as exc:
        return AnalyzeResponse(
            status="failed",
            provider="gemini",
            model=settings.gemini_video_model,
            warnings=[str(exc)],
            raw=raw if request.save_raw else None,
        )

    return AnalyzeResponse(
        status="succeeded" if score_payload else "failed",
        provider="gemini",
        model=settings.gemini_video_model,
        score=Score(**score_payload) if score_payload else None,
        evidence=[Evidence(**item) for item in evidence_payload],
        warnings=warnings,
        raw=raw if request.save_raw else None,
    )


def _build_payload(request: AnalyzeRequest, settings: Settings) -> Dict:
    processing_mode = settings.gemini_video_processing or "agentic"
    video_input: Dict[str, object] = {
        "type": "video",
        "uri": request.youtube_url,
    }
    if processing_mode == "static":
        video_input["processing"] = {"type": "static"}
    else:
        video_input["processing"] = processing_mode

    if settings.gemini_video_media_resolution:
        video_input["media_resolution"] = settings.gemini_video_media_resolution

    return {
        "model": settings.gemini_video_model,
        "input": [
            video_input,
            {"type": "text", "text": _build_prompt(request)},
        ],
        "response_format": {
            "type": "text",
            "mime_type": "application/json",
            "schema": SCORE_SCHEMA,
        },
    }


def _build_prompt(request: AnalyzeRequest) -> str:
    players = ", ".join(request.expected_players) if request.expected_players else "알 수 없음"
    hint = request.hint.strip() or "점수판, 자막, 마지막 랠리 직후 화면, 경기 종료 멘트를 모두 참고하세요."

    return f"""
You are analyzing one badminton doubles match video.

Goal:
- Extract the final match score only.
- Team A means the left/top/first-listed team.
- Team B means the right/bottom/second-listed team.
- If the video contains warmups, rallies from multiple games, highlights, or unclear scoreboard shots, use the final completed game in the video.
- Badminton games usually end at 21 with a 2-point lead, or at 30-29. If the observed score violates that shape, still return the observed score but keep confidence low and explain it in reason.
- Do not invent a score. If the final score is not visible or confidently inferable, set found=false and scoreA=0, scoreB=0, winner=unknown.

Expected players, if visible:
{players}

Extra hint:
{hint}

Return only JSON matching the schema.
Evidence should include 1-5 timestamps where the score was visible or inferable.
""".strip()


def _extract_output_text(raw: Dict) -> str:
    direct = raw.get("output_text")
    if isinstance(direct, str) and direct.strip():
        return direct

    texts: List[str] = []
    for step in raw.get("steps", []):
        for content in step.get("content", []):
            text = content.get("text")
            if isinstance(text, str):
                texts.append(text)

    for candidate in ("text", "response", "output"):
        value = raw.get(candidate)
        if isinstance(value, str):
            texts.append(value)

    if texts:
        return "\n".join(texts)

    raise ValueError("Gemini response did not include output text.")


def _looks_like_json(text: str) -> bool:
    stripped = text.strip()
    return stripped.startswith("{") and stripped.endswith("}")
