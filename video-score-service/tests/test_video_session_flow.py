from pydantic import ValidationError

from app.models import PlayerMappingRequest, PlayerSlot, ScoreReading
from app.providers.gemma_frames import (
    _parse_rally_window_analysis,
    _player_slot_candidate_is_found,
    _player_slot_candidate_score,
    _select_final_score,
    _select_scoreboard_checkpoint,
)


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


def test_parse_rally_window_analysis_extracts_rally_and_scoreboard():
    events, scoreboards, evidence, warnings = _parse_rally_window_analysis(
        {
            "events": [
                {
                    "timestamp": "03:12",
                    "type": "rally_end",
                    "servingTeam": "A",
                    "rallyWinner": "B",
                    "confidence": 0.82,
                    "note": "Team A lift lands long and players reset.",
                }
            ],
            "scoreboard": {
                "visible": True,
                "scoreA": 4,
                "scoreB": 5,
                "confidence": 0.9,
                "note": "Digits are visible after the rally.",
            },
            "evidence": [{"timestamp": "03:12", "text": "B prepares to serve next."}],
        }
    )

    assert not warnings
    assert len(events) == 1
    assert events[0].event_type == "rally_end"
    assert events[0].rally_winner == "B"
    assert len(scoreboards) == 1
    assert scoreboards[0].score_a == 4
    assert scoreboards[0].score_b == 5
    assert evidence[0].text == "B prepares to serve next."


def test_scoreboard_checkpoint_only_applies_small_forward_jumps():
    checkpoint = _select_scoreboard_checkpoint(
        [ScoreReading(timestamp="01:00", score_a=3, score_b=2, confidence=0.9)],
        score_a=2,
        score_b=2,
        accepted_rallies=3,
    )
    assert checkpoint is not None
    assert checkpoint.score_a == 3

    large_jump = _select_scoreboard_checkpoint(
        [ScoreReading(timestamp="02:00", score_a=12, score_b=8, confidence=0.95)],
        score_a=2,
        score_b=2,
        accepted_rallies=3,
    )
    assert large_jump is None


def test_player_slot_candidate_prefers_distinguishable_mapping_frame():
    slots = [
        PlayerSlot(slot_id="A1", team="A", label="near-left", description="white shirt", confidence=0.8),
        PlayerSlot(slot_id="A2", team="A", label="near-right", description="blue shirt", confidence=0.8),
        PlayerSlot(slot_id="B1", team="B", label="far-left", description="black shirt", confidence=0.75),
        PlayerSlot(slot_id="B2", team="B", label="far-right", description="red shirt", confidence=0.75),
    ]
    strong = {
        "found": True,
        "visiblePlayers": 4,
        "distinguishablePlayers": 4,
        "qualityScore": 82,
        "identificationQuality": "good",
    }
    weak = {
        "found": True,
        "visiblePlayers": 4,
        "distinguishablePlayers": 2,
        "qualityScore": 35,
        "identificationQuality": "poor",
        "warnings": ["far-side players are small and blurred"],
    }

    assert _player_slot_candidate_is_found(strong, slots)
    assert not _player_slot_candidate_is_found(weak, slots)
    assert _player_slot_candidate_score(strong, slots) > _player_slot_candidate_score(weak, slots)
