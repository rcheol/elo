from __future__ import annotations

import asyncio
import base64
import json
import os
import platform
import socket
import subprocess
import sys
import tempfile
import traceback
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, Optional

import httpx

from app.config import get_settings
from app.frame_extractor import find_ffmpeg
from app.models import ScoreScanRequest, SlotPlayer
from app.providers.gemma_frames import analyze_score_scan_with_gemma, detect_player_slots_with_gemma


DEFAULT_API_BASE_URL = "https://honeyserve-elo.onrender.com"
MIN_PYTHON_VERSION = (3, 10)
DEFAULT_RESULT_UPLOAD_SOFT_LIMIT_BYTES = 45 * 1024


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


def result_upload_soft_limit_bytes() -> int:
    try:
        return max(8 * 1024, int(env("WORKER_RESULT_UPLOAD_SOFT_LIMIT_BYTES", str(DEFAULT_RESULT_UPLOAD_SOFT_LIMIT_BYTES))))
    except ValueError:
        return DEFAULT_RESULT_UPLOAD_SOFT_LIMIT_BYTES


def reference_frame_max_height() -> int:
    try:
        return max(120, min(720, int(env("WORKER_REFERENCE_FRAME_MAX_HEIGHT", "480"))))
    except ValueError:
        return 480


def reference_frame_jpeg_quality() -> int:
    try:
        return max(2, min(31, int(env("WORKER_REFERENCE_FRAME_JPEG_QUALITY", "18"))))
    except ValueError:
        return 18


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
    payload = fit_result_payload_for_upload(payload)
    payload_size = json_payload_size(payload)
    print(f"Submitting job {job_id} result ({payload_size} bytes)")
    response = await client.post(f"/api/video-analysis/worker/jobs/{job_id}/result", json=payload)
    if response.status_code == 403 and "Access Upload Denied" in response.text:
        fallback_payload = fit_result_payload_for_upload(payload, drop_images=True)
        fallback_size = json_payload_size(fallback_payload)
        print(f"Upload denied; retrying job {job_id} result without frame images ({fallback_size} bytes)")
        response = await client.post(f"/api/video-analysis/worker/jobs/{job_id}/result", json=fallback_payload)

    if response.status_code >= 400:
        raise RuntimeError(
            f"Failed to submit worker result ({response.status_code}): "
            f"{response.text[:500]}"
        )


def json_payload_size(payload: Dict[str, Any]) -> int:
    return len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def fit_result_payload_for_upload(payload: Dict[str, Any], *, drop_images: bool = False) -> Dict[str, Any]:
    fitted = deepcopy(payload)
    fitted["warnings"] = trim_strings(fitted.get("warnings") or [], max_items=8, max_chars=500)

    score_result = fitted.get("scoreResult")
    if isinstance(score_result, dict):
        score_result["warnings"] = trim_strings(score_result.get("warnings") or [], max_items=8, max_chars=500)
        score_result["evidence"] = (score_result.get("evidence") or [])[:8]
        score_result["readings"] = (score_result.get("readings") or [])[:120]

    limit = result_upload_soft_limit_bytes()
    source_reference_frames = fitted.get("referenceFrames") if isinstance(fitted.get("referenceFrames"), list) else None
    if source_reference_frames is not None:
        if drop_images:
            fitted["referenceFrames"] = []
        elif json_payload_size(fitted) > limit:
            fitted["referenceFrames"] = compact_reference_frames(
                source_reference_frames,
                max_height=reference_frame_max_height(),
                jpeg_quality=reference_frame_jpeg_quality(),
            )
            for max_height, jpeg_quality in (
                (420, 20),
                (360, 22),
                (300, 24),
                (240, 26),
                (180, 28),
                (120, 30),
            ):
                if json_payload_size(fitted) <= limit:
                    break
                fitted["referenceFrames"] = compact_reference_frames(
                    source_reference_frames,
                    max_height=max_height,
                    jpeg_quality=jpeg_quality,
                )

    while json_payload_size(fitted) > limit and fitted.get("referenceFrames"):
        fitted["referenceFrames"].pop()

    if json_payload_size(fitted) > limit:
        fitted.pop("referenceFrames", None)

    return fitted


def trim_strings(items: Any, *, max_items: int, max_chars: int) -> list[str]:
    if not isinstance(items, list):
        return []
    return [str(item)[:max_chars] for item in items[:max_items]]


def compact_reference_frames(
    frames: list[Dict[str, Any]],
    *,
    max_height: Optional[int] = None,
    jpeg_quality: Optional[int] = None,
) -> list[Dict[str, Any]]:
    compacted = []
    for frame in frames:
        compacted.append(
            {
                "timestamp": str(frame.get("timestamp") or ""),
                "imageDataUrl": compact_image_data_url(
                    str(frame.get("imageDataUrl") or ""),
                    max_height=max_height or reference_frame_max_height(),
                    jpeg_quality=jpeg_quality or reference_frame_jpeg_quality(),
                ),
            }
        )
    return compacted


def compact_image_data_url(data_url: str, *, max_height: int, jpeg_quality: int) -> str:
    if not data_url.startswith("data:image/") or "," not in data_url:
        return data_url

    ffmpeg_path = find_ffmpeg()
    if not ffmpeg_path:
        return data_url

    _header, encoded = data_url.split(",", 1)
    try:
        image_bytes = base64.b64decode(encoded)
    except ValueError:
        return data_url

    with tempfile.TemporaryDirectory(prefix="honeyserve-thumb-") as temp_dir:
        input_path = Path(temp_dir) / "input.jpg"
        output_path = Path(temp_dir) / "thumb.jpg"
        input_path.write_bytes(image_bytes)

        command = [
            ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(input_path),
            "-threads",
            "1",
            "-vf",
            f"{jpeg_scale_filter(max_height)},format=yuvj420p",
            "-frames:v",
            "1",
            "-q:v",
            str(max(2, min(31, int(jpeg_quality)))),
            "-pix_fmt",
            "yuvj420p",
            "-strict",
            "unofficial",
            str(output_path),
        ]
        try:
            subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (subprocess.CalledProcessError, FileNotFoundError):
            return data_url

        if not output_path.exists():
            return data_url

        thumb = base64.b64encode(output_path.read_bytes()).decode("ascii")
        return f"data:image/jpeg;base64,{thumb}"


def jpeg_scale_filter(max_height: int) -> str:
    safe_height = max(2, int(max_height))
    return (
        "scale="
        f"w=trunc(iw*min(1\\,{safe_height}/ih)/2)*2:"
        f"h=trunc(ih*min(1\\,{safe_height}/ih)/2)*2,"
        "setsar=1"
    )


async def run_player_detection(job: Dict[str, Any]) -> Dict[str, Any]:
    settings = get_settings()
    if not settings.gemma_enabled:
        raise RuntimeError("GEMMA_API_KEY and GEMMA_CHAT_COMPLETIONS_URL are required.")

    frames, slots, warnings, _raw = await detect_player_slots_with_gemma(
        str(job["youtubeUrl"]),
        hint=str(job.get("hint") or ""),
        settings=settings,
        max_frames=max(4, min(12, int(job.get("calibrationMaxFrames") or 10))),
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
                "boxPercent": slot.box_percent,
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
    settings = get_settings()
    raw = job.get("scoreRequest") or {}
    configured_batch_size = max(1, int(settings.gemma_score_scan_batch_size or 1))
    requested_batch_size = int(raw.get("batchSize") or configured_batch_size)
    return ScoreScanRequest(
        scan_interval_seconds=int(raw.get("scanIntervalSeconds") or settings.gemma_score_scan_interval_seconds),
        max_frames=int(raw.get("maxFrames") or settings.gemma_score_scan_max_frames),
        batch_size=min(requested_batch_size, configured_batch_size),
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
