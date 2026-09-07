from pydantic import ValidationError

from app.models import PlayerMappingRequest, ScoreReading
from app.providers.gemma_frames import _select_final_score


def test_player_mapping_requires_four_unique_slots():
    PlayerMappingRequest(
        slots={
            "A1": {"player_id": "p1", "player_name": "A1"},
            "A2": {"player_id": "p2", "player_name": "A2"},
            "B1": {"player_id": "p3", "player_name": "B1"},
            "B2": {"player_id": "p4", "player_name": "B2"},
        }
    )

    try:
        PlayerMappingRequest(
            slots={
                "A1": {"player_id": "p1", "player_name": "A1"},
                "A2": {"player_id": "p1", "player_name": "A2"},
                "B1": {"player_id": "p3", "player_name": "B1"},
                "B2": {"player_id": "p4", "player_name": "B2"},
            }
        )
    except ValidationError:
        return

    raise AssertionError("duplicate player mapping should fail")


def test_select_final_score_prefers_latest_valid_badminton_score():
    score, warning = _select_final_score(
        [
            ScoreReading(timestamp="05:00", score_a=10, score_b=8, confidence=0.8),
            ScoreReading(timestamp="20:00", score_a=21, score_b=18, confidence=0.7),
            ScoreReading(timestamp="22:00", score_a=22, score_b=20, confidence=0.6),
        ]
    )

    assert warning is None
    assert score.team_a == 22
    assert score.team_b == 20
    assert score.winner == "A"


def test_select_final_score_returns_low_confidence_latest_when_no_final_shape():
    score, warning = _select_final_score(
        [
            ScoreReading(timestamp="05:00", score_a=10, score_b=8, confidence=0.8),
            ScoreReading(timestamp="15:00", score_a=19, score_b=18, confidence=0.8),
        ]
    )

    assert warning
    assert score.team_a == 19
    assert score.team_b == 18
    assert score.confidence == 0.45

