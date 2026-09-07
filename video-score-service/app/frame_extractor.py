from __future__ import annotations

import base64
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional


@dataclass(frozen=True)
class ExtractedFrame:
    timestamp_seconds: float
    data_url: str

    @property
    def timestamp_label(self) -> str:
        total = max(0, int(self.timestamp_seconds))
        minutes, seconds = divmod(total, 60)
        return f"{minutes:02d}:{seconds:02d}"


def extract_tail_frames_from_youtube(
    youtube_url: str,
    *,
    tail_seconds: int,
    max_frames: int,
    max_height: int,
    jpeg_quality: int = 7,
) -> List[ExtractedFrame]:
    info = _load_youtube_info(youtube_url)
    duration = float(info.get("duration") or 0)
    start = max(0.0, duration - tail_seconds) if duration > 0 else 0.0
    clip_duration = min(tail_seconds, duration - start) if duration > 0 else tail_seconds
    return extract_frames_from_youtube_info(
        info,
        start_seconds=start,
        duration_seconds=clip_duration,
        max_frames=max_frames,
        max_height=max_height,
        jpeg_quality=jpeg_quality,
    )


def extract_evenly_spaced_frames_from_youtube(
    youtube_url: str,
    *,
    max_frames: int,
    max_height: int,
    jpeg_quality: int = 7,
    start_ratio: float = 0.05,
    end_ratio: float = 0.95,
) -> List[ExtractedFrame]:
    info = _load_youtube_info(youtube_url)
    duration = float(info.get("duration") or 0)
    if duration <= 0:
        return extract_frames_from_youtube_info(
            info,
            start_seconds=0,
            duration_seconds=max_frames,
            max_frames=max_frames,
            max_height=max_height,
            jpeg_quality=jpeg_quality,
        )

    safe_start_ratio = min(0.95, max(0.0, start_ratio))
    safe_end_ratio = min(1.0, max(safe_start_ratio + 0.01, end_ratio))
    start = duration * safe_start_ratio
    clip_duration = max(1.0, duration * safe_end_ratio - start)
    return extract_frames_from_youtube_info(
        info,
        start_seconds=start,
        duration_seconds=clip_duration,
        max_frames=max_frames,
        max_height=max_height,
        jpeg_quality=jpeg_quality,
    )


def extract_score_scan_frames_from_youtube(
    youtube_url: str,
    *,
    interval_seconds: int,
    max_frames: int,
    max_height: int,
    jpeg_quality: int = 7,
) -> List[ExtractedFrame]:
    info = _load_youtube_info(youtube_url)
    duration = float(info.get("duration") or 0)
    if duration <= 0:
        return extract_frames_from_youtube_info(
            info,
            start_seconds=0,
            duration_seconds=max_frames * interval_seconds,
            max_frames=max_frames,
            max_height=max_height,
            jpeg_quality=jpeg_quality,
        )

    frame_count = min(max_frames, max(1, int(duration // interval_seconds) + 1))
    return extract_frames_from_youtube_info(
        info,
        start_seconds=0,
        duration_seconds=duration,
        max_frames=frame_count,
        max_height=max_height,
        jpeg_quality=jpeg_quality,
    )


def extract_frames_from_youtube_info(
    info: dict,
    *,
    start_seconds: float,
    duration_seconds: float,
    max_frames: int,
    max_height: int,
    jpeg_quality: int = 7,
) -> List[ExtractedFrame]:
    ffmpeg_path = find_ffmpeg()
    if not ffmpeg_path:
        raise RuntimeError("ffmpeg is required for Gemma frame extraction. Install imageio-ffmpeg or put ffmpeg on PATH.")

    stream_url = _select_video_stream_url(info, max_height=max_height)
    if not stream_url:
        raise RuntimeError("Could not find a playable YouTube video stream.")

    clip_duration = max(1.0, duration_seconds)
    sample_fps = max_frames / clip_duration

    with tempfile.TemporaryDirectory(prefix="honeyserve-frames-") as temp_dir:
        output_pattern = str(Path(temp_dir) / "frame_%03d.jpg")
        command = [
            ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            f"{start_seconds:.3f}",
            "-i",
            stream_url,
            "-t",
            f"{clip_duration:.3f}",
            "-vf",
            f"fps={sample_fps:.6f},scale=-2:min({max_height}\\,ih)",
            "-frames:v",
            str(max_frames),
            "-q:v",
            str(max(2, min(31, int(jpeg_quality)))),
            output_pattern,
        ]
        subprocess.run(command, check=True)

        paths = sorted(Path(temp_dir).glob("frame_*.jpg"))
        if not paths:
            raise RuntimeError("ffmpeg did not extract any frames.")

        interval = clip_duration / max(1, len(paths) - 1)
        frames: List[ExtractedFrame] = []
        for index, path in enumerate(paths):
            timestamp = start_seconds + interval * index
            frames.append(
                ExtractedFrame(
                    timestamp_seconds=timestamp,
                    data_url=_jpeg_to_data_url(path),
                )
            )
        return frames


def find_ffmpeg() -> Optional[str]:
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path:
        return ffmpeg_path
    try:
        import imageio_ffmpeg
    except ImportError:
        return None
    return imageio_ffmpeg.get_ffmpeg_exe()


def _load_youtube_info(youtube_url: str) -> dict:
    try:
        from yt_dlp import YoutubeDL
    except ImportError as exc:  # pragma: no cover - deployment dependency guard
        raise RuntimeError("yt-dlp is required for YouTube frame extraction.") from exc

    options = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "format": "bv*[height<=720]/bv*/bestvideo/best",
        "nocheckcertificate": not _env_bool("YTDLP_VERIFY_TLS", True),
    }
    with YoutubeDL(options) as ydl:
        return ydl.extract_info(youtube_url, download=False)


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off"}


def _select_video_stream_url(info: dict, *, max_height: int) -> Optional[str]:
    formats = info.get("formats") or []
    candidates = []
    for item in formats:
        if item.get("vcodec") == "none":
            continue
        if not item.get("url"):
            continue
        height = int(item.get("height") or 0)
        if height and height > max_height:
            continue
        candidates.append(item)

    if not candidates and info.get("url"):
        return str(info["url"])

    if not candidates:
        return None

    best = max(candidates, key=lambda item: (int(item.get("height") or 0), float(item.get("tbr") or 0)))
    return str(best["url"])


def _jpeg_to_data_url(path: Path) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"
