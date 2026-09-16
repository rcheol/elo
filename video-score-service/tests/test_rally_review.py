import base64
import io
import asyncio
import json
import re
import math
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from app.rally_ledger import parse_observations, build_review, provisional_score
from app.review_frames import evidence_sheet


def event(t, kind, team="A", verified=True):
    return {"seconds": t, "type": kind, "team": team, "confidence": .95, "verified": verified, "evidence": "visible"}


def review(events, gaps=None):
    return build_review(events, gaps or [], start=0, end=100, start_score_a=20, start_score_b=19)


def test_overlap_duplicate_is_one_point_but_new_serve_is_new_rally():
    result = review([event(1, "serve"), event(5, "end"), event(5.5, "end"),
                     event(6, "serve"), event(6.3, "end")])
    assert provisional_score(result) == (22, 19)  # no early 21:19 stop
    assert len(result["rallies"]) == 2


def test_conflicting_winner_or_missing_serve_never_auto_counts():
    result = review([event(1, "serve"), event(5, "end"), event(5.5, "end", "B"), event(20, "end")])
    assert provisional_score(result) == (20, 19)
    assert all(row["decision"] == "unknown" for row in result["rallies"])


def test_let_and_next_serve_do_not_create_points_and_missing_end_becomes_gap():
    result = review([event(1, "serve"), event(4, "let"), event(8, "serve"), event(30, "serve", "B")])
    assert provisional_score(result) == (20, 19)
    assert result["rallies"][0]["decision"] == "let"
    assert any(row["kind"] == "gap" for row in result["rallies"])


def test_failed_coverage_expands_to_whole_rally_without_double_counting():
    result = review([event(2, "serve"), event(15, "end")], [{"start": 8, "end": 10, "reason": "failed"}])
    assert provisional_score(result) == (20, 19)
    assert result["rallies"] == [{"id": "r1", "start": 2, "end": 15, "kind": "gap",
                                 "decision": "unknown", "suggested": "unknown", "reason": "failed", "evidence": ""}]


def test_no_detection_is_not_zero_score_confidence():
    result = review([])
    assert result["rallies"][0]["reason"] == "no_rallies_detected"


@pytest.mark.parametrize("payload", [{}, {"events": None}, {"events": [{"seconds": 101, "type": "end"}]},
                                      {"events": [{"seconds": float("nan"), "type": "end"}]},
                                      {"events": [{"seconds": 20, "type": "invented"}]}])
def test_invalid_model_output_is_a_failed_interval(payload):
    with pytest.raises(ValueError):
        parse_observations(payload, 0, 100)


def test_evidence_size_budget_letterbox_and_unreadable_rejection(tmp_path: Path):
    path = tmp_path / "frame.jpg"
    Image.new("RGB", (640, 480), "green").save(path)
    encoded = evidence_sheet([(1, path), (1.5, path)], None, budget=12000)
    assert len(encoded) <= 12000
    with Image.open(io.BytesIO(base64.b64decode(encoded.split(",")[1]))) as decoded:
        assert decoded.height >= 260  # >=240px content plus time label
    with pytest.raises(ValueError):
        evidence_sheet([(1, path)], None, budget=100)


def test_two_pass_pipeline_uses_reference_fixed_rate_dense_local_frames_and_whole_range(monkeypatch, tmp_path):
    from app.config import get_settings
    from app.models import ScoreScanRequest, SlotPlayer
    from app.providers import rally_review, gemma_frames

    path = tmp_path / "court.jpg"
    Image.new("RGB", (640, 360), "green").save(path)
    rates, payloads = [], []

    class FakeVideo:
        def __init__(self, url, start, end):
            self.start, self.end = start, end
        def __enter__(self):
            return self
        def __exit__(self, *_):
            pass
        def reference(self, slots):
            return Image.new("RGB", (640, 360), "white")
        def frames(self, start, end, *, fps, prefix):
            start, end = max(self.start, start), min(self.end, end)
            rates.append(fps)
            return [(start + i / fps, path) for i in range(max(1, math.ceil((end - start) * fps)))]

    async def model(settings, payload):
        payloads.append(payload)
        assert len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()) <= 40000
        prompt = payload["messages"][1]["content"][0]["text"]
        assert "current score" not in prompt.lower()
        start, end = map(float, re.search(r"\[([\d.]+), ([\d.]+)\] seconds", prompt).groups())
        events = [dict(seconds=t, type=kind, team="A", confidence=.95, evidence="visible")
                  for t, kind in [(1, "serve"), (5, "end"), (9, "serve"), (14, "end")]
                  if start <= t <= end]
        return {"choices": [{"message": {"content": json.dumps({"events": events})}}]}, None

    monkeypatch.setattr(rally_review, "ReviewVideo", FakeVideo)
    monkeypatch.setattr(gemma_frames, "_post_gemma_chat", model)
    mapping = {slot: SlotPlayer(player_id=slot, player_name=slot) for slot in ["A1", "A2", "B1", "B2"]}
    result = asyncio.run(gemma_frames.analyze_score_scan_with_gemma("test", player_mapping=mapping, hint="",
                        settings=get_settings(), request=ScoreScanRequest(end_seconds=16, start_score_a=20, start_score_b=19)))
    assert result.analysis_version == 2
    assert result.score.team_a == 22  # did not stop prematurely at 21
    assert result.review["endSeconds"] == 16
    assert 2 in rates and 8 in rates
    assert result.score.confidence == 0  # not a calibrated probability
    assert result.needs_confirmation


def test_result_budget_compacts_text_but_never_drops_rallies():
    from worker import fit_result_payload_for_upload, json_payload_size
    rows = [{"id": f"r{i + 1}", "kind": "rally", "start": i, "end": i + 1,
             "decision": "unknown", "suggested": "A", "reason": "unverified_outcome",
             "evidence": "장면 확인 필요 " * 60} for i in range(100)]
    payload = {"scoreResult": {"review": {"rallies": rows}}}
    result = fit_result_payload_for_upload(payload)
    assert json_payload_size(result) <= 40000
    assert len(result["scoreResult"]["review"]["rallies"]) == 100
    assert len(rows[0]["evidence"]) > 60  # input was not mutated


def test_actual_ffmpeg_cache_offsets_and_jpeg_encoding(monkeypatch, tmp_path):
    from app import review_frames
    from app.frame_extractor import find_ffmpeg
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        pytest.skip("ffmpeg not installed")
    source = tmp_path / "source.mp4"
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
                    "-i", "testsrc=size=640x360:rate=24", "-t", "4", "-pix_fmt", "yuv420p",
                    "-threads", "1", str(source)], check=True, timeout=30)
    monkeypatch.setattr(review_frames, "_load_youtube_info", lambda _: {"duration": 4})
    monkeypatch.setattr(review_frames, "_select_video_stream_url", lambda *_, **__: str(source))
    with review_frames.ReviewVideo("test", 1, 3) as video:
        frames = video.frames(1, 3, fps=2, prefix="coarse")
        assert [t for t, _ in frames] == [1, 1.5, 2, 2.5]
        for _, path in frames:
            with Image.open(path) as image:
                assert image.height == 360
        directory = video.directory
    assert not directory.exists()
