from __future__ import annotations

import base64
import math
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple


@dataclass(frozen=True)
class ExtractedFrame:
    timestamp_seconds: float
    data_url: str

    @property
    def timestamp_label(self) -> str:
        total = max(0, int(self.timestamp_seconds))
        minutes, seconds = divmod(total, 60)
        return f"{minutes:02d}:{seconds:02d}"


@dataclass(frozen=True)
class ExtractedFrameWindow:
    timestamp_seconds: float
    data_url: str
    panel_timestamps: Tuple[float, ...]

    @property
    def timestamp_label(self) -> str:
        return _format_timestamp(self.timestamp_seconds)

    @property
    def panel_timestamp_labels(self) -> Tuple[str, ...]:
        return tuple(_format_timestamp(value) for value in self.panel_timestamps)

    @property
    def time_range_label(self) -> str:
        labels = self.panel_timestamp_labels
        if not labels:
            return self.timestamp_label
        if labels[0] == labels[-1]:
            return labels[0]
        return f"{labels[0]}-{labels[-1]}"


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


def extract_timeline_frame_windows_from_youtube(
    youtube_url: str,
    *,
    interval_seconds: int,
    max_sampled_frames: int,
    max_height: int,
    jpeg_quality: int = 20,
    frames_per_window: int = 3,
) -> List[ExtractedFrameWindow]:
    info = _load_youtube_info(youtube_url)
    return extract_timeline_frame_windows_from_youtube_info(
        info,
        interval_seconds=interval_seconds,
        max_sampled_frames=max_sampled_frames,
        max_height=max_height,
        jpeg_quality=jpeg_quality,
        frames_per_window=frames_per_window,
    )


def extract_timeline_frame_windows_from_youtube_info(
    info: dict,
    *,
    interval_seconds: int,
    max_sampled_frames: int,
    max_height: int,
    jpeg_quality: int = 20,
    frames_per_window: int = 3,
) -> List[ExtractedFrameWindow]:
    ffmpeg_path = find_ffmpeg()
    if not ffmpeg_path:
        raise RuntimeError("ffmpeg is required for Gemma frame extraction. Install imageio-ffmpeg or put ffmpeg on PATH.")

    stream_url = _select_video_stream_url(info, max_height=max_height)
    if not stream_url:
        raise RuntimeError("Could not find a playable YouTube video stream.")

    requested_interval = max(1.0, float(interval_seconds))
    safe_frames_per_window = max(2, min(4, int(frames_per_window)))
    duration = float(info.get("duration") or 0)
    max_samples = max(1, int(max_sampled_frames))
    duration_sample_count = int(duration // requested_interval) + 1 if duration > 0 else max_samples
    sample_count = max(1, min(max_samples, duration_sample_count))
    sample_interval = requested_interval
    if duration > 0 and duration_sample_count > max_samples and max_samples > 1:
        sample_interval = duration / float(max_samples - 1)
    window_count = max(1, math.ceil(sample_count / safe_frames_per_window))
    clip_duration = max(1.0, (sample_count - 1) * sample_interval + 0.25)
    if duration > 0:
        clip_duration = min(duration, clip_duration)

    with tempfile.TemporaryDirectory(prefix="honeyserve-rally-windows-") as temp_dir:
        output_pattern = str(Path(temp_dir) / "window_%03d.jpg")
        command = [
            ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            stream_url,
            "-threads",
            "1",
            "-t",
            f"{clip_duration:.3f}",
            "-vf",
            (
                f"fps=1/{sample_interval:.6f},"
                f"{_jpeg_scale_filter(max_height)},"
                "format=yuvj420p,"
                f"tile={safe_frames_per_window}x1:padding=4:margin=4:color=black"
            ),
            "-frames:v",
            str(window_count),
            "-q:v",
            str(max(2, min(31, int(jpeg_quality)))),
            "-pix_fmt",
            "yuvj420p",
            "-strict",
            "unofficial",
            output_pattern,
        ]
        _run_ffmpeg(command)

        paths = sorted(Path(temp_dir).glob("window_*.jpg"))
        if not paths:
            raise RuntimeError("ffmpeg did not extract any rally timeline windows.")

        windows: List[ExtractedFrameWindow] = []
        for index, path in enumerate(paths):
            first_sample_index = index * safe_frames_per_window
            panel_timestamps = tuple(
                min(duration, float((first_sample_index + offset) * sample_interval)) if duration > 0
                else float((first_sample_index + offset) * sample_interval)
                for offset in range(safe_frames_per_window)
                if first_sample_index + offset < sample_count
            )
            if not panel_timestamps:
                panel_timestamps = (float(first_sample_index * sample_interval),)
            windows.append(
                ExtractedFrameWindow(
                    timestamp_seconds=panel_timestamps[0],
                    panel_timestamps=panel_timestamps,
                    data_url=_jpeg_to_data_url(path),
                )
            )
        return windows


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

    if max_frames <= 30:
        return _extract_sparse_frames_from_stream(
            stream_url,
            ffmpeg_path=ffmpeg_path,
            start_seconds=start_seconds,
            duration_seconds=clip_duration,
            max_frames=max_frames,
            max_height=max_height,
            jpeg_quality=jpeg_quality,
        )

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
            "-threads",
            "1",
            "-t",
            f"{clip_duration:.3f}",
            "-vf",
            f"fps={sample_fps:.6f},{_jpeg_scale_filter(max_height)},format=yuvj420p",
            "-frames:v",
            str(max_frames),
            "-q:v",
            str(max(2, min(31, int(jpeg_quality)))),
            "-pix_fmt",
            "yuvj420p",
            "-strict",
            "unofficial",
            output_pattern,
        ]
        _run_ffmpeg(command)

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


def _extract_sparse_frames_from_stream(
    stream_url: str,
    *,
    ffmpeg_path: str,
    start_seconds: float,
    duration_seconds: float,
    max_frames: int,
    max_height: int,
    jpeg_quality: int,
) -> List[ExtractedFrame]:
    timestamps = _sample_timestamps(start_seconds, duration_seconds, max_frames)
    frames: List[ExtractedFrame] = []
    errors: List[str] = []

    with tempfile.TemporaryDirectory(prefix="honeyserve-sparse-frames-") as temp_dir:
        for index, timestamp in enumerate(timestamps, start=1):
            path = Path(temp_dir) / f"frame_{index:03d}.jpg"
            command = [
                ffmpeg_path,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                f"{timestamp:.3f}",
                "-i",
                stream_url,
                "-threads",
                "1",
                "-frames:v",
                "1",
                "-vf",
                f"{_jpeg_scale_filter(max_height)},format=yuvj420p",
                "-q:v",
                str(max(2, min(31, int(jpeg_quality)))),
                "-pix_fmt",
                "yuvj420p",
                "-strict",
                "unofficial",
                str(path),
            ]
            try:
                _run_ffmpeg(command, timeout_seconds=30)
            except RuntimeError as exc:
                errors.append(f"{_format_timestamp(timestamp)}: {exc}")
                continue
            if path.exists():
                frames.append(
                    ExtractedFrame(
                        timestamp_seconds=timestamp,
                        data_url=_jpeg_to_data_url(path),
                    )
                )

    if not frames:
        raise RuntimeError("ffmpeg did not extract any sparse frames. " + " | ".join(errors[-3:]))
    return frames


def _sample_timestamps(start_seconds: float, duration_seconds: float, max_frames: int) -> List[float]:
    count = max(1, int(max_frames))
    if count == 1:
        return [max(0.0, start_seconds)]
    interval = max(0.0, duration_seconds) / float(count - 1)
    return [max(0.0, start_seconds + interval * index) for index in range(count)]


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

    direct_candidates = [item for item in candidates if not _is_hls_format(item)]
    if direct_candidates:
        candidates = direct_candidates

    best = max(
        candidates,
        key=lambda item: (
            int(item.get("height") or 0),
            int(item.get("fps") or 0),
            float(item.get("tbr") or 0),
        ),
    )
    return str(best["url"])


def _is_hls_format(item: dict) -> bool:
    protocol = str(item.get("protocol") or "").lower()
    url = str(item.get("url") or "").lower()
    return "m3u8" in protocol or "m3u8" in url or "hls_playlist" in url


def _jpeg_to_data_url(path: Path) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def _run_ffmpeg(command: List[str], *, timeout_seconds: Optional[float] = None) -> None:
    try:
        subprocess.run(
            command,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_seconds,
        )
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or str(exc)).strip()
        if len(detail) > 700:
            detail = detail[-700:]
        raise RuntimeError(detail or f"ffmpeg exited with code {exc.returncode}") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"ffmpeg timed out after {timeout_seconds:g} seconds") from exc


def _jpeg_scale_filter(max_height: int) -> str:
    safe_height = max(2, int(max_height))
    return (
        "scale="
        f"w=trunc(iw*min(1\\,{safe_height}/ih)/2)*2:"
        f"h=trunc(ih*min(1\\,{safe_height}/ih)/2)*2,"
        "setsar=1"
    )


def _format_timestamp(value: float) -> str:
    total = max(0, int(value))
    minutes, seconds = divmod(total, 60)
    return f"{minutes:02d}:{seconds:02d}"
