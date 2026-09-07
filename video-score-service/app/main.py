from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, List, Optional
from uuid import uuid4

from fastapi import BackgroundTasks, FastAPI, HTTPException

from app.config import get_settings
from app.models import (
    AnalyzeRequest,
    AnalyzeResponse,
    ConfirmMatchRequest,
    ConfirmMatchResponse,
    JobCreated,
    JobRecord,
    JobStatus,
    PlayerMappingRequest,
    ProviderInfo,
    ScoreScanRequest,
    VideoScoreResult,
    VideoSessionCreateRequest,
    VideoSessionRecord,
)
from app.providers.gemma_frames import analyze_score_scan_with_gemma, analyze_with_gemma_frames, detect_player_slots_with_gemma
from app.providers.gemini import analyze_with_gemini
from app.providers.heuristics import extract_youtube_video_id


app = FastAPI(
    title="HoneyServe Video Score Service",
    version="0.1.0",
    description="Extract final badminton doubles scores from YouTube match videos.",
)

JOBS: Dict[str, JobRecord] = {}
VIDEO_SESSIONS: Dict[str, VideoSessionRecord] = {}


@app.get("/healthz")
def healthz() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/models", response_model=List[ProviderInfo])
def models() -> List[ProviderInfo]:
    settings = get_settings()
    return [
        ProviderInfo(
            provider="gemma_frames",
            enabled=settings.gemma_enabled,
            model=settings.gemma_model,
            role="primary for video sessions",
            note="Extract frames from YouTube and send them to base/gemma-4-31b-it through an OpenAI-compatible API.",
        ),
        ProviderInfo(
            provider="gemini",
            enabled=settings.gemini_enabled,
            model=settings.gemini_video_model,
            role="optional legacy fallback",
            note="Direct public YouTube URL video understanding, if a Gemini key is available.",
        ),
        ProviderInfo(
            provider="twelvelabs",
            enabled=settings.twelvelabs_enabled,
            model="pegasus-1.5",
            role="future fallback",
            note="Video intelligence API with structured responses. Adapter not wired yet.",
        ),
        ProviderInfo(
            provider="openai_frames",
            enabled=settings.openai_frames_enabled,
            model="vision frame sampler",
            role="future fallback",
            note="Extract frames with ffmpeg/OpenCV and send sampled images to a vision model.",
        ),
        ProviderInfo(
            provider="local_ocr",
            enabled=False,
            model="PaddleOCR PP-OCRv6",
            role="future verifier",
            note="OCR final-score candidates from sampled scoreboard frames.",
        ),
    ]


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(request: AnalyzeRequest) -> AnalyzeResponse:
    return await _analyze_request(request)


@app.post("/jobs", response_model=JobCreated)
async def create_job(request: AnalyzeRequest, background_tasks: BackgroundTasks) -> JobCreated:
    job_id = str(uuid4())
    now = _utc_now()
    JOBS[job_id] = JobRecord(
        job_id=job_id,
        status="queued",
        created_at=now,
        updated_at=now,
    )
    background_tasks.add_task(_run_job, job_id, request)
    return JobCreated(job_id=job_id, status="queued", poll_url=f"/jobs/{job_id}")


@app.get("/jobs/{job_id}", response_model=JobRecord)
def get_job(job_id: str) -> JobRecord:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return job


@app.post("/video-sessions", response_model=VideoSessionRecord)
async def create_video_session(request: VideoSessionCreateRequest, background_tasks: BackgroundTasks) -> VideoSessionRecord:
    video_id = extract_youtube_video_id(request.youtube_url)
    if not video_id:
        raise HTTPException(status_code=400, detail="youtube_url must be a YouTube watch, shorts, embed, or youtu.be URL.")

    settings = get_settings()
    if not settings.gemma_enabled:
        raise HTTPException(status_code=503, detail="GEMMA_API_KEY and GEMMA_CHAT_COMPLETIONS_URL are required for video sessions.")

    session_id = str(uuid4())
    now = _utc_now()
    record = VideoSessionRecord(
        session_id=session_id,
        status="queued",
        stage="detecting_players",
        youtube_url=request.youtube_url,
        created_at=now,
        updated_at=now,
    )
    VIDEO_SESSIONS[session_id] = record
    background_tasks.add_task(_detect_session_players, session_id, request)
    return record


@app.get("/video-sessions/{session_id}", response_model=VideoSessionRecord)
def get_video_session(session_id: str) -> VideoSessionRecord:
    return _require_video_session(session_id)


@app.put("/video-sessions/{session_id}/players", response_model=VideoSessionRecord)
def set_video_session_players(session_id: str, request: PlayerMappingRequest) -> VideoSessionRecord:
    session = _require_video_session(session_id)
    updated = session.model_copy(
        update={
            "status": "succeeded",
            "stage": "players_mapped",
            "player_mapping": request.slots,
            "updated_at": _utc_now(),
            "error": None,
        }
    )
    VIDEO_SESSIONS[session_id] = updated
    return updated


@app.post("/video-sessions/{session_id}/score-jobs", response_model=VideoSessionRecord)
async def create_video_score_job(
    session_id: str,
    request: ScoreScanRequest,
    background_tasks: BackgroundTasks,
) -> VideoSessionRecord:
    session = _require_video_session(session_id)
    if set(session.player_mapping.keys()) != {"A1", "A2", "B1", "B2"}:
        raise HTTPException(status_code=409, detail="Player mapping is required before score analysis.")

    settings = get_settings()
    if not settings.gemma_enabled:
        raise HTTPException(status_code=503, detail="GEMMA_API_KEY and GEMMA_CHAT_COMPLETIONS_URL are required for score analysis.")

    _update_video_session(session_id, status="queued", stage="scoring_video", error=None)
    background_tasks.add_task(_run_video_score_scan, session_id, request)
    return _require_video_session(session_id)


@app.post("/video-sessions/{session_id}/confirm", response_model=ConfirmMatchResponse)
def confirm_video_score(session_id: str, request: ConfirmMatchRequest) -> ConfirmMatchResponse:
    session = _require_video_session(session_id)
    result = session.score_result
    if not request.confirmed:
        raise HTTPException(status_code=409, detail="Score was not confirmed.")
    if not result or not result.match_payload:
        raise HTTPException(status_code=409, detail="No score result is ready to confirm.")

    match_payload = dict(result.match_payload)
    if request.played_at:
        match_payload["playedAt"] = request.played_at
    return ConfirmMatchResponse(confirmed=True, match_payload=match_payload)


async def _run_job(job_id: str, request: AnalyzeRequest) -> None:
    _update_job(job_id, status="running")
    try:
        result = await _analyze_request(request)
        _update_job(job_id, status=result.status, result=result)
    except HTTPException as exc:
        _update_job(job_id, status="failed", error=str(exc.detail))
    except Exception as exc:  # pragma: no cover - defensive safety net for background work
        _update_job(job_id, status="failed", error=str(exc))


def _update_job(
    job_id: str,
    *,
    status: JobStatus,
    result: Optional[AnalyzeResponse] = None,
    error: Optional[str] = None,
) -> None:
    job = JOBS[job_id]
    JOBS[job_id] = job.model_copy(
        update={
            "status": status,
            "updated_at": _utc_now(),
            "result": result if result is not None else job.result,
            "error": error if error is not None else job.error,
        }
    )


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _detect_session_players(session_id: str, request: VideoSessionCreateRequest) -> None:
    settings = get_settings()
    _update_video_session(session_id, status="running", stage="detecting_players")
    try:
        reference_frames, player_slots, warnings, raw = await detect_player_slots_with_gemma(
            request.youtube_url,
            hint=request.hint,
            settings=settings,
            max_frames=request.calibration_max_frames,
            save_raw=request.save_raw,
        )
        _update_video_session(
            session_id,
            status="succeeded",
            stage="players_ready",
            reference_frames=reference_frames,
            player_slots=player_slots,
            warnings=warnings,
            raw=raw,
            error=None,
        )
    except Exception as exc:  # pragma: no cover - defensive safety net for background work
        _update_video_session(session_id, status="failed", stage="player_detection_failed", error=str(exc))


async def _run_video_score_scan(session_id: str, request: ScoreScanRequest) -> None:
    settings = get_settings()
    session = _require_video_session(session_id)
    _update_video_session(session_id, status="running", stage="scoring_video")
    try:
        score_result = await analyze_score_scan_with_gemma(
            session.youtube_url,
            player_mapping=session.player_mapping,
            hint=request.hint,
            settings=settings,
            request=request,
        )
        _update_video_session(
            session_id,
            status="succeeded" if score_result.score else "failed",
            stage="score_ready" if score_result.score else "score_not_found",
            score_result=score_result,
            error=None if score_result.score else "No final score was found.",
        )
    except Exception as exc:  # pragma: no cover - defensive safety net for background work
        _update_video_session(session_id, status="failed", stage="score_scan_failed", error=str(exc))


def _require_video_session(session_id: str) -> VideoSessionRecord:
    session = VIDEO_SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Video session not found.")
    return session


def _update_video_session(
    session_id: str,
    *,
    status: JobStatus,
    stage: str,
    reference_frames: Optional[list] = None,
    player_slots: Optional[list] = None,
    warnings: Optional[List[str]] = None,
    score_result: Optional[VideoScoreResult] = None,
    raw: Optional[dict] = None,
    error: Optional[str] = None,
) -> None:
    session = _require_video_session(session_id)
    updates = {
        "status": status,
        "stage": stage,
        "updated_at": _utc_now(),
        "error": error,
    }
    if reference_frames is not None:
        updates["reference_frames"] = reference_frames
    if player_slots is not None:
        updates["player_slots"] = player_slots
    if warnings is not None:
        updates["warnings"] = warnings
    if score_result is not None:
        updates["score_result"] = score_result
    if raw is not None:
        updates["raw"] = raw
    VIDEO_SESSIONS[session_id] = session.model_copy(update=updates)


async def _analyze_request(request: AnalyzeRequest) -> AnalyzeResponse:
    video_id = extract_youtube_video_id(request.youtube_url)
    if not video_id:
        raise HTTPException(status_code=400, detail="youtube_url must be a YouTube watch, shorts, embed, or youtu.be URL.")

    settings = get_settings()
    provider = request.provider
    if provider == "auto":
        provider = "gemma_frames" if settings.gemma_enabled else "gemini" if settings.gemini_enabled else "local_ocr"

    if provider == "gemini":
        if not settings.gemini_enabled:
            raise HTTPException(status_code=503, detail="GEMINI_API_KEY is not configured.")
        return await analyze_with_gemini(request, settings)

    if provider == "gemma_frames":
        if not settings.gemma_enabled:
            raise HTTPException(status_code=503, detail="GEMMA_API_KEY and GEMMA_CHAT_COMPLETIONS_URL are not configured.")
        return await analyze_with_gemma_frames(request, settings)

    if provider == "twelvelabs":
        raise HTTPException(status_code=501, detail="TwelveLabs adapter is planned but not implemented yet.")

    if provider == "openai_frames":
        raise HTTPException(status_code=501, detail="OpenAI frame-sampling adapter is planned but not implemented yet.")

    if provider == "local_ocr":
        raise HTTPException(status_code=501, detail="Local OCR verifier is planned but not implemented yet.")

    raise HTTPException(status_code=400, detail=f"Unsupported provider: {provider}")
