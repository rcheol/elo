"""Local video cache and bounded, timestamped evidence sheets for rally review."""
from __future__ import annotations

import base64
import io
import math
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

from app.frame_extractor import _load_youtube_info, _select_video_stream_url, _run_ffmpeg, _jpeg_scale_filter, find_ffmpeg


class ReviewVideo:
    def __init__(self, url: str, start: float, end: float | None):
        self.url, self.start, self.requested_end = url, start, end
        self.temp = None

    def __enter__(self):
        info = _load_youtube_info(self.url)
        duration = float(info.get("duration") or 0)
        if not math.isfinite(duration) or duration <= 0 or info.get("is_live"):
            raise ValueError("A finished video with a known duration is required.")
        self.end = min(duration, self.requested_end or duration)
        if self.end <= self.start or self.end - self.start > 1800 or self.end > 21600:
            raise ValueError("Select one game, at most 30 minutes, within the video.")
        self.ffmpeg = find_ffmpeg()
        stream = _select_video_stream_url(info, max_height=720)
        if not self.ffmpeg or not stream:
            raise RuntimeError("ffmpeg and a playable video stream are required.")
        self.temp = tempfile.TemporaryDirectory(prefix="honeyserve-review-")
        self.directory = Path(self.temp.name)
        self.video = self.directory / "source.mkv"
        self.stream = stream
        try:
            # Cache once. Dense second-pass reads stay local, not on Render and
            # not a fresh YouTube stream request for every rally.
            _run_ffmpeg([self.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                         "-ss", str(self.start), "-i", stream, "-t", str(self.end - self.start),
                         "-map", "0:v:0", "-an", "-vf", _jpeg_scale_filter(720),
                         "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-threads", "2",
                         str(self.video)], timeout_seconds=3600)
        except Exception:
            self.temp.cleanup()
            raise
        return self

    def __exit__(self, *_):
        if self.temp:
            self.temp.cleanup()

    def frames(self, start: float, end: float, *, fps: int, prefix: str) -> list[tuple[float, Path]]:
        start, end = max(self.start, start), min(self.end, end)
        count = max(1, math.ceil((end - start) * fps))
        directory = self.directory / prefix
        directory.mkdir(exist_ok=True)
        _run_ffmpeg([self.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                     "-ss", str(start - self.start), "-i", str(self.video), "-t", str(max(0.05, end - start)),
                     "-vf", f"fps={fps},{_jpeg_scale_filter(480)},format=yuvj420p", "-frames:v", str(count),
                     "-c:v", "mjpeg", "-threads", "1", "-q:v", "4",
                     "-pix_fmt", "yuvj420p", "-strict", "unofficial", str(directory / "%06d.jpg")])
        paths = sorted(directory.glob("*.jpg"))
        if not paths:
            raise RuntimeError("No evidence frames were decoded.")
        return [(round(start + index / fps, 3), path) for index, path in enumerate(paths)]

    def reference(self, slots: list) -> Image.Image | None:
        if not slots:
            return None
        pieces = str(slots[0].timestamp).split(":")
        try:
            seconds = sum(float(part) * 60 ** i for i, part in enumerate(reversed(pieces)))
        except ValueError:
            return None
        if seconds < 0 or not math.isfinite(seconds):
            return None
        # Only one calibration frame needs a separate seek if it lies outside
        # the selected game. Never cache hours of unrelated preceding footage.
        cached = self.start <= seconds < self.end
        source = str(self.video) if cached else self.stream
        seek = seconds - self.start if cached else seconds
        path = self.directory / "reference.jpg"
        _run_ffmpeg([self.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                     "-ss", str(seek), "-i", source, "-frames:v", "1",
                     "-vf", f"{_jpeg_scale_filter(480)},format=yuvj420p", "-threads", "1",
                     "-q:v", "4", "-pix_fmt", "yuvj420p", "-strict", "unofficial", str(path)])
        with Image.open(path) as source:
            image = source.convert("RGB")
        draw = ImageDraw.Draw(image)
        for slot in slots:
            box = slot.box_percent
            if not box:
                continue
            x, y = box.get("x", 0) / 100 * image.width, box.get("y", 0) / 100 * image.height
            w, h = box.get("w", 0) / 100 * image.width, box.get("h", 0) / 100 * image.height
            color = "#33dd88" if slot.team == "A" else "#ffad55"
            draw.rectangle((x, y, x + w, y + h), outline=color, width=3)
            draw.text((x + 2, y + 2), slot.slot_id, fill="white", stroke_width=2, stroke_fill="black")
        return image


def evidence_sheet(frames: list[tuple[float, Path]], reference: Image.Image | None, *, budget: int) -> str:
    """Respect the *encoded* request budget without shrinking to unreadable thumbnails."""
    sources = []
    if reference is not None:
        sources.append(("REFERENCE A1/A2 vs B1/B2", reference.copy()))
    for seconds, path in frames:
        with Image.open(path) as source:
            sources.append((f"t={seconds:.2f}s", source.convert("RGB")))
    if not sources:
        raise ValueError("No evidence images.")
    try:
        for height in (320, 280, 240):
            width, columns = round(height * 16 / 9), min(3, len(sources))
            sheet = Image.new("RGB", (columns * width, math.ceil(len(sources) / columns) * (height + 20)), "#171717")
            draw = ImageDraw.Draw(sheet)
            for index, (label, source) in enumerate(sources):
                x, y = index % columns * width, index // columns * (height + 20)
                # Letterbox instead of cropping out court edges or far players.
                image = ImageOps.contain(source, (width, height))
                sheet.paste(image, (x + (width - image.width) // 2, y + 20 + (height - image.height) // 2))
                draw.text((x + 4, y + 4), label, fill="white")
            for quality in (75, 65, 55, 45):
                output = io.BytesIO()
                sheet.save(output, "JPEG", quality=quality, optimize=True)
                value = "data:image/jpeg;base64," + base64.b64encode(output.getvalue()).decode("ascii")
                if len(value) <= budget:
                    return value
        raise ValueError("Evidence exceeds the upload budget at the minimum readable resolution.")
    finally:
        for _, source in sources:
            source.close()
