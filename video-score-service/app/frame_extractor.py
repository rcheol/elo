from __future__ import annotations

import base64
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


def extract_tail_frames_from_youtube(
    youtube_url: str,
    *,
    tail_seconds: int,
    max_frames: int,
    max_height: int,
) -> List[ExtractedFrame]:
    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        raise RuntimeError("ffmpeg is required for Gemma frame extraction.")

    info = _load_youtube_info(youtube_url)
    duration = float(info.get("duration") or 0)
    stream_url = _select_video_stream_url(info, max_height=max_height)
    if not stream_url:
        raise RuntimeError("Could not find a playable YouTube video stream.")

    start = max(0.0, duration - tail_seconds) if duration > 0 else 0.0
    sample_fps = max_frames / max(1, min(tail_seconds, int(duration - start) if duration > 0 else tail_seconds))

    with tempfile.TemporaryDirectory(prefix="honeyserve-frames-") as temp_dir:
        output_pattern = str(Path(temp_dir) / "frame_%03d.jpg")
        command = [
            ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            f"{start:.3f}",
            "-i",
            stream_url,
            "-vf",
            f"fps={sample_fps:.6f},scale=-2:min({max_height}\\,ih)",
            "-frames:v",
            str(max_frames),
            output_pattern,
        ]
        subprocess.run(command, check=True)

        paths = sorted(Path(temp_dir).glob("frame_*.jpg"))
        if not paths:
            raise RuntimeError("ffmpeg did not extract any frames.")

        interval = (min(tail_seconds, duration - start) / max(1, len(paths) - 1)) if duration > 0 else 0
        frames: List[ExtractedFrame] = []
        for index, path in enumerate(paths):
            timestamp = start + interval * index
            frames.append(
                ExtractedFrame(
                    timestamp_seconds=timestamp,
                    data_url=_jpeg_to_data_url(path),
                )
            )
        return frames


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
    }
    with YoutubeDL(options) as ydl:
        return ydl.extract_info(youtube_url, download=False)


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

