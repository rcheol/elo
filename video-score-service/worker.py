from __future__ import annotations

import asyncio
import os
import platform
import socket
import sys
import traceback
from typing import Any, Dict, Optional

import httpx

from app.config import get_settings
from app.models import ScoreScanRequest, SlotPlayer
from app.providers.gemma_frames import analyze_score_scan_with_gemma, detect_player_slots_with_gemma


DEFAULT_API_BASE_URL = "https://honeyserve-elo.onrender.com"
MIN_PYTHON_VERSION = (3, 10)


def env(name: str, default: str = "") -> str:
    value = os.getenv(name)
    if value is None:
        return default
    value = value.strip()
    return value if value else default


def env_bool(name: str, default: bool = True) -> bool:
    value = env(name)
    if not value:
        return default
    return value.lower() not in {"0", "false", "no", "off"}


def worker_id() -> str:
    return env(
        "VIDEO_WORKER_ID",
        f"{platform.node() or socket.gethostname() or 'local'}-gemma-worker",
    )


def api_base_url() -> str:
    return env("WORKER_API_BASE_URL", DEFAULT_API_BASE_URL).rstrip("/")


def poll_seconds() -> float:
    try:
        return max(2.0, float(env("WORKER_POLL_SECONDS", "10")))
    except ValueError:
        return 10.0


def worker_verify_tls() -> bool:
    return env_bool("WORKER_VERIFY_TLS", True)


def auth_headers() -> Dict[str, str]:
    token = env("VIDEO_WORKER_TOKEN")
    if not token:
        raise RuntimeError("VIDEO_WORKER_TOKEN is required for the queue worker.")
    return {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
        "X-Video-Worker-Id": worker_id(),
    }


def validate_worker_settings() -> None:
    if sys.version_info < MIN_PYTHON_VERSION:
        required = ".".join(map(str, MIN_PYTHON_VERSION))
        current = ".".join(map(str, sys.version_info[:3]))
        raise RuntimeError(
            f"Python {required}+ is required for the current yt-dlp YouTube extractor. "
            f"Current Python is {current}. Start the worker with tmp\\video-score-venv310 instead. "
            "No video job was claimed."
        )

    settings = get_settings()
    missing = []
    if not settings.gemma_api_key:
        missing.append("GEMMA_API_KEY")
    if not settings.gemma_chat_completions_url:
        missing.append("GEMMA_CHAT_COMPLETIONS_URL")
    if missing:
        raise RuntimeError(
            "Missing required Gemma worker setting(s): "
            + ", ".join(missing)
            + ". Put them in video-score-service\\.env before starting worker. No video job was claimed."
        )


async def fetch_next_job(client: httpx.AsyncClient) -> Optional[Dict[str, Any]]:
    response = await client.get("/api/video-analysis/worker/jobs/next")
    response.raise_for_status()
    payload = response.json()
    return payload.get("job")


async def submit_result(client: httpx.AsyncClient, job_id: str, payload: Dict[str, Any]) -> None:
    response = await client.post(f"/api/video-analysis/worker/jobs/{job_id}/result", json=payload)
    response.raise_for_status()


async def run_player_detection(job: Dict[str, Any]) -> Dict[str, Any]:
    settings = get_settings()
    if not settings.gemma_enabled:
        raise RuntimeError("GEMMA_API_KEY and GEMMA_CHAT_COMPLETIONS_URL are required.")

    frames, slots, warnings, _raw = await detect_player_slots_with_gemma(
        str(job["youtubeUrl"]),
        hint=str(job.get("hint") or ""),
        settings=settings,
        max_frames=int(job.get("calibrationMaxFrames") or 4),
        save_raw=False,
    )
    return {
        "stage": "player_detection",
        "status": "succeeded",
        "referenceFrames": [
            {
                "timestamp": frame.timestamp,
                "imageDataUrl": frame.image_data_url,
            }
            for frame in frames
        ],
        "playerSlots": [
            {
                "slotId": slot.slot_id,
                "team": slot.team,
                "label": slot.label,
                "description": slot.description,
                "timestamp": slot.timestamp,
                "confidence": slot.confidence,
            }
            for slot in slots
        ],
        "warnings": warnings,
    }


def parse_player_mapping(job: Dict[str, Any]) -> Dict[str, SlotPlayer]:
    mapping: Dict[str, SlotPlayer] = {}
    raw_mapping = job.get("playerMapping") or {}
    for slot_id in ("A1", "A2", "B1", "B2"):
        slot = raw_mapping.get(slot_id) or {}
        mapping[slot_id] = SlotPlayer(
            player_id=str(slot["playerId"]),
            player_name=str(slot["playerName"]),
        )
    return mapping


def parse_score_request(job: Dict[str, Any]) -> ScoreScanRequest:
    raw = job.get("scoreRequest") or {}
    return ScoreScanRequest(
        scan_interval_seconds=int(raw.get("scanIntervalSeconds") or 20),
        max_frames=int(raw.get("maxFrames") or 96),
        batch_size=int(raw.get("batchSize") or 8),
        hint=str(raw.get("hint") or job.get("hint") or ""),
        save_raw=bool(raw.get("saveRaw") or False),
    )


async def run_score_analysis(job: Dict[str, Any]) -> Dict[str, Any]:
    settings = get_settings()
    if not settings.gemma_enabled:
        raise RuntimeError("GEMMA_API_KEY and GEMMA_CHAT_COMPLETIONS_URL are required.")

    result = await analyze_score_scan_with_gemma(
        str(job["youtubeUrl"]),
        player_mapping=parse_player_mapping(job),
        hint=str(job.get("hint") or ""),
        settings=settings,
        request=parse_score_request(job),
    )
    score = result.score
    return {
        "stage": "score_analysis",
        "status": "succeeded",
        "scoreResult": {
            "score": {
                "teamA": score.team_a,
                "teamB": score.team_b,
                "winner": score.winner,
                "confidence": score.confidence,
            } if score else None,
            "readings": [
                {
                    "timestamp": reading.timestamp,
                    "scoreA": reading.score_a,
                    "scoreB": reading.score_b,
                    "confidence": reading.confidence,
                    "note": reading.note,
                }
                for reading in result.readings
            ],
            "evidence": [
                {
                    "timestamp": item.timestamp,
                    "text": item.text,
                }
                for item in result.evidence
            ],
            "warnings": result.warnings,
            "needsConfirmation": result.needs_confirmation,
            "matchPayload": result.match_payload,
        },
        "warnings": result.warnings,
    }


async def run_job(client: httpx.AsyncClient, job: Dict[str, Any]) -> None:
    job_id = str(job["id"])
    stage = str(job.get("stage") or "")
    try:
        if stage == "player_detection":
            payload = await run_player_detection(job)
        elif stage == "score_analysis":
            payload = await run_score_analysis(job)
        else:
            raise RuntimeError(f"Unsupported job stage: {stage}")
    except Exception as exc:
        payload = {
            "stage": stage or "unknown",
            "status": "failed",
            "error": str(exc),
            "warnings": [traceback.format_exc(limit=3)],
        }

    await submit_result(client, job_id, payload)


async def main() -> None:
    validate_worker_settings()
    headers = auth_headers()
    base_url = api_base_url()
    interval = poll_seconds()
    verify_tls = worker_verify_tls()
    print(f"HoneyServe video worker started: {worker_id()} -> {base_url}")
    if not verify_tls:
        print("Worker queue TLS verification is disabled (WORKER_VERIFY_TLS=false).")

    async with httpx.AsyncClient(
        base_url=base_url,
        headers=headers,
        timeout=httpx.Timeout(30.0),
        verify=verify_tls,
    ) as client:
        while True:
            try:
                job = await fetch_next_job(client)
                if job:
                    print(f"Claimed job {job['id']} ({job.get('stage')})")
                    await run_job(client, job)
                    print(f"Finished job {job['id']}")
                else:
                    await asyncio.sleep(interval)
            except KeyboardInterrupt:
                raise
            except Exception as exc:
                print(f"Worker loop error: {exc}")
                await asyncio.sleep(interval)


if __name__ == "__main__":
    asyncio.run(main())
