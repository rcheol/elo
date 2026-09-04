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

    @property
    def gemini_enabled(self) -> bool:
        return bool(self.gemini_api_key)

    @property
    def twelvelabs_enabled(self) -> bool:
        return bool(self.twelvelabs_api_key)

    @property
    def openai_frames_enabled(self) -> bool:
        return bool(self.openai_api_key)


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
    )

