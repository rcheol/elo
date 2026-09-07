from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache

from dotenv import load_dotenv


load_dotenv()


@dataclass(frozen=True)
class Settings:
    gemini_api_key: str
    gemini_video_model: str
    gemini_video_processing: str
    gemini_video_media_resolution: str
    request_timeout_seconds: float
    twelvelabs_api_key: str
    openai_api_key: str
    gemma_api_key: str
    gemma_chat_completions_url: str
    gemma_model: str
    gemma_verify_tls: bool
    gemma_frame_tail_seconds: int
    gemma_frame_max_frames: int
    gemma_frame_max_height: int
    gemma_frame_jpeg_quality: int
    gemma_request_max_bytes: int
    gemma_score_scan_interval_seconds: int
    gemma_score_scan_max_frames: int
    gemma_score_scan_batch_size: int

    @property
    def gemini_enabled(self) -> bool:
        return bool(self.gemini_api_key)

    @property
    def twelvelabs_enabled(self) -> bool:
        return bool(self.twelvelabs_api_key)

    @property
    def openai_frames_enabled(self) -> bool:
        return bool(self.openai_api_key)

    @property
    def gemma_enabled(self) -> bool:
        return bool(self.gemma_api_key and self.gemma_chat_completions_url)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings(
        gemini_api_key=os.getenv("GEMINI_API_KEY", "").strip(),
        gemini_video_model=os.getenv("GEMINI_VIDEO_MODEL", "gemini-3.8-flash").strip(),
        gemini_video_processing=os.getenv("GEMINI_VIDEO_PROCESSING", "agentic").strip(),
        gemini_video_media_resolution=os.getenv("GEMINI_VIDEO_MEDIA_RESOLUTION", "high").strip(),
        request_timeout_seconds=float(os.getenv("REQUEST_TIMEOUT_SECONDS", "300")),
        twelvelabs_api_key=os.getenv("TWELVELABS_API_KEY", "").strip(),
        openai_api_key=os.getenv("OPENAI_API_KEY", "").strip(),
        gemma_api_key=os.getenv("GEMMA_API_KEY", "").strip(),
        gemma_chat_completions_url=os.getenv("GEMMA_CHAT_COMPLETIONS_URL", "").strip(),
        gemma_model=os.getenv("GEMMA_MODEL", "base/gemma-4-31b-it").strip(),
        gemma_verify_tls=_env_bool("GEMMA_VERIFY_TLS", True),
        gemma_frame_tail_seconds=int(os.getenv("GEMMA_FRAME_TAIL_SECONDS", "600")),
        gemma_frame_max_frames=int(os.getenv("GEMMA_FRAME_MAX_FRAMES", "12")),
        gemma_frame_max_height=int(os.getenv("GEMMA_FRAME_MAX_HEIGHT", "360")),
        gemma_frame_jpeg_quality=int(os.getenv("GEMMA_FRAME_JPEG_QUALITY", "16")),
        gemma_request_max_bytes=int(os.getenv("GEMMA_REQUEST_MAX_BYTES", "40000")),
        gemma_score_scan_interval_seconds=int(os.getenv("GEMMA_SCORE_SCAN_INTERVAL_SECONDS", "20")),
        gemma_score_scan_max_frames=int(os.getenv("GEMMA_SCORE_SCAN_MAX_FRAMES", "96")),
        gemma_score_scan_batch_size=int(os.getenv("GEMMA_SCORE_SCAN_BATCH_SIZE", "1")),
    )


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off"}
