from app.providers.heuristics import extract_json_object, extract_youtube_video_id, score_has_badminton_shape
from app.frame_extractor import _select_video_stream_url


def test_extract_youtube_video_id_from_watch_url():
    assert extract_youtube_video_id("https://www.youtube.com/watch?v=9hE5-98ZeCg") == "9hE5-98ZeCg"


def test_extract_youtube_video_id_from_short_url():
    assert extract_youtube_video_id("https://youtu.be/abc123?t=10") == "abc123"


def test_rejects_non_youtube_url():
    assert extract_youtube_video_id("https://example.com/watch?v=abc123") is None


def test_badmiton_score_shape():
    assert score_has_badminton_shape(21, 18)
    assert score_has_badminton_shape(22, 20)
    assert score_has_badminton_shape(30, 29)
    assert not score_has_badminton_shape(21, 20)
    assert not score_has_badminton_shape(20, 18)


def test_extract_json_object_from_fenced_text():
    assert extract_json_object('```json\n{"found": true}\n```') == {"found": True}


def test_select_video_stream_prefers_direct_https_over_hls():
    direct_url = "https://rr.example.com/direct-video.webm"
    info = {
        "formats": [
            {
                "format_id": "hls-480",
                "height": 480,
                "fps": 60,
                "tbr": 2200,
                "vcodec": "avc1",
                "protocol": "m3u8_native",
                "url": "https://manifest.example.com/api/manifest/hls_playlist/stream.m3u8",
            },
            {
                "format_id": "direct-480",
                "height": 480,
                "fps": 60,
                "tbr": 1500,
                "vcodec": "vp9",
                "protocol": "https",
                "url": direct_url,
            },
        ]
    }

    assert _select_video_stream_url(info, max_height=480) == direct_url
