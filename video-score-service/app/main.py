from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, List, Optional
from uuid import uuid4

from fastapi import BackgroundTasks, FastAPI, HTTPException

from app.config import get_settings
from app.models import AnalyzeRequest, AnalyzeResponse, JobCreated, JobRecord, JobStatus, ProviderInfo
from app.providers.gemini import analyze_with_gemini
from app.providers.heuristics import extract_youtube_video_id


app = FastAPI(
    title="HoneyServe Video Score Service",
    version="0.1.0",
    description="Extract final badminton doubles scores from YouTube match videos.",
)

JOBS: Dict[str, JobRecord] = {}


@app.get("/healthz")
def healthz() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/models", response_model=List[ProviderInfo])
def models() -> List[ProviderInfo]:
    settings = get_settings()
    return [
        ProviderInfo(
            provider="gemini",
            enabled=settings.gemini_enabled,
            model=settings.gemini_video_model,
            role="primary",
            note="Direct public YouTube URL video understanding.",
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


async def _analyze_request(request: AnalyzeRequest) -> AnalyzeResponse:
    video_id = extract_youtube_video_id(request.youtube_url)
    if not video_id:
        raise HTTPException(status_code=400, detail="youtube_url must be a YouTube watch, shorts, embed, or youtu.be URL.")

    settings = get_settings()
    provider = request.provider
    if provider == "auto":
        provider = "gemini" if settings.gemini_enabled else "local_ocr"

    if provider == "gemini":
        if not settings.gemini_enabled:
            raise HTTPException(status_code=503, detail="GEMINI_API_KEY is not configured.")
        return await analyze_with_gemini(request, settings)

    if provider == "twelvelabs":
        raise HTTPException(status_code=501, detail="TwelveLabs adapter is planned but not implemented yet.")

    if provider == "openai_frames":
        raise HTTPException(status_code=501, detail="OpenAI frame-sampling adapter is planned but not implemented yet.")

    if provider == "local_ocr":
        raise HTTPException(status_code=501, detail="Local OCR verifier is planned but not implemented yet.")

    raise HTTPException(status_code=400, detail=f"Unsupported provider: {provider}")
