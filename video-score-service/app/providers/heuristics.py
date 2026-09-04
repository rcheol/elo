from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse


YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtu.be",
    "www.youtu.be",
}


def extract_youtube_video_id(url: str) -> Optional[str]:
    parsed = urlparse(url.strip())
    host = parsed.netloc.lower()
    if host not in YOUTUBE_HOSTS:
        return None

    if host.endswith("youtu.be"):
        video_id = parsed.path.strip("/").split("/")[0]
        return video_id or None

    if parsed.path == "/watch":
        values = parse_qs(parsed.query).get("v", [])
        return values[0] if values else None

    if parsed.path.startswith(("/shorts/", "/embed/")):
        parts = [part for part in parsed.path.split("/") if part]
        return parts[1] if len(parts) > 1 else None

    return None


def extract_json_object(text: str) -> Dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)

    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    first = cleaned.find("{")
    last = cleaned.rfind("}")
    if first >= 0 and last > first:
        parsed = json.loads(cleaned[first : last + 1])
        if isinstance(parsed, dict):
            return parsed

    raise ValueError("No JSON object found in model response.")


def infer_winner(score_a: int, score_b: int) -> str:
    if score_a > score_b:
        return "A"
    if score_b > score_a:
        return "B"
    return "unknown"


def score_has_badminton_shape(score_a: int, score_b: int) -> bool:
    if score_a == score_b:
        return False
    high = max(score_a, score_b)
    low = min(score_a, score_b)
    if high < 21:
        return False
    if high == 30:
        return low <= 29
    return high - low >= 2


def normalize_gemini_payload(payload: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, str]], List[str]]:
    warnings: List[str] = []
    found = bool(payload.get("found"))
    if not found:
        warnings.append(str(payload.get("reason") or "영상에서 최종 스코어를 확정하지 못했습니다."))
        return None, _normalize_evidence(payload.get("evidence")), warnings

    try:
        score_a = int(payload.get("scoreA"))
        score_b = int(payload.get("scoreB"))
    except (TypeError, ValueError) as exc:
        raise ValueError("Model returned found=true without numeric scoreA/scoreB.") from exc

    if not score_has_badminton_shape(score_a, score_b):
        warnings.append("배드민턴 일반 듀스 규칙과 다른 점수 형태입니다. 사람이 한 번 확인하세요.")

    winner = payload.get("winner")
    if winner not in {"A", "B"}:
        winner = infer_winner(score_a, score_b)

    confidence = payload.get("confidence", 0)
    try:
        confidence_value = min(1.0, max(0.0, float(confidence)))
    except (TypeError, ValueError):
        confidence_value = 0.0
        warnings.append("confidence 값이 숫자가 아니어서 0으로 처리했습니다.")

    score = {
        "team_a": score_a,
        "team_b": score_b,
        "winner": winner,
        "confidence": confidence_value,
    }
    return score, _normalize_evidence(payload.get("evidence")), warnings


def _normalize_evidence(value: Any) -> List[Dict[str, str]]:
    if not isinstance(value, list):
        return []

    evidence: List[Dict[str, str]] = []
    for item in value[:8]:
        if isinstance(item, dict):
            evidence.append(
                {
                    "timestamp": str(item.get("timestamp", "")),
                    "text": str(item.get("text", "")),
                }
            )
        elif item:
            evidence.append({"timestamp": "", "text": str(item)})
    return evidence
