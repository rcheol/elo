from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator


ProviderName = Literal["auto", "gemini", "gemma_frames", "twelvelabs", "openai_frames", "local_ocr"]
AnalyzeStatus = Literal["succeeded", "failed"]
JobStatus = Literal["queued", "running", "succeeded", "failed"]
Winner = Literal["A", "B", "unknown"]
SlotId = Literal["A1", "A2", "B1", "B2"]
TeamId = Literal["A", "B"]


class AnalyzeRequest(BaseModel):
    youtube_url: str = Field(..., min_length=8)
    provider: ProviderName = "auto"
    expected_players: List[str] = Field(default_factory=list, max_length=8)
    hint: str = Field(default="", max_length=1000)
    save_raw: bool = False
    frame_image_urls: List[str] = Field(default_factory=list, max_length=20)
    frame_tail_seconds: Optional[int] = Field(default=None, ge=30, le=3600)
    frame_max_frames: Optional[int] = Field(default=None, ge=1, le=30)

    @field_validator("expected_players")
    @classmethod
    def clean_expected_players(cls, value: List[str]) -> List[str]:
        return [name.strip() for name in value if name and name.strip()]


class Score(BaseModel):
    team_a: int = Field(..., ge=0, le=40)
    team_b: int = Field(..., ge=0, le=40)
    winner: Winner
    confidence: float = Field(..., ge=0.0, le=1.0)


class Evidence(BaseModel):
    timestamp: str = Field(default="")
    text: str = Field(default="")


class AnalyzeResponse(BaseModel):
    status: AnalyzeStatus
    provider: str
    model: str
    score: Optional[Score] = None
    evidence: List[Evidence] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)
    raw: Optional[Dict[str, Any]] = None


class ProviderInfo(BaseModel):
    provider: str
    enabled: bool
    model: Optional[str] = None
    role: str
    note: str


class JobCreated(BaseModel):
    job_id: str
    status: JobStatus
    poll_url: str


class JobRecord(BaseModel):
    job_id: str
    status: JobStatus
    created_at: str
    updated_at: str
    result: Optional[AnalyzeResponse] = None
    error: Optional[str] = None


class ReferenceFrame(BaseModel):
    timestamp: str
    image_data_url: str


class PlayerSlot(BaseModel):
    slot_id: SlotId
    team: TeamId
    label: str
    description: str = ""
    timestamp: str = ""
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


class SlotPlayer(BaseModel):
    player_id: str = Field(..., min_length=1)
    player_name: str = Field(..., min_length=1)


class VideoSessionCreateRequest(BaseModel):
    youtube_url: str = Field(..., min_length=8)
    hint: str = Field(default="", max_length=1000)
    save_raw: bool = False
    calibration_max_frames: int = Field(default=4, ge=1, le=12)


class PlayerMappingRequest(BaseModel):
    slots: Dict[str, SlotPlayer]

    @field_validator("slots")
    @classmethod
    def validate_slots(cls, value: Dict[str, SlotPlayer]) -> Dict[str, SlotPlayer]:
        required = {"A1", "A2", "B1", "B2"}
        keys = set(value.keys())
        if keys != required:
            missing = ", ".join(sorted(required - keys))
            extra = ", ".join(sorted(keys - required))
            parts = []
            if missing:
                parts.append(f"missing: {missing}")
            if extra:
                parts.append(f"extra: {extra}")
            raise ValueError("; ".join(parts))

        player_ids = [slot.player_id for slot in value.values()]
        if len(set(player_ids)) != 4:
            raise ValueError("Each slot must map to a different player.")
        return value


class ScoreScanRequest(BaseModel):
    scan_interval_seconds: Optional[int] = Field(default=None, ge=5, le=180)
    max_frames: Optional[int] = Field(default=None, ge=8, le=240)
    batch_size: Optional[int] = Field(default=None, ge=1, le=20)
    hint: str = Field(default="", max_length=1000)
    save_raw: bool = False


class ScoreReading(BaseModel):
    timestamp: str
    score_a: int = Field(..., ge=0, le=40)
    score_b: int = Field(..., ge=0, le=40)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    note: str = ""


class VideoScoreResult(BaseModel):
    score: Optional[Score] = None
    readings: List[ScoreReading] = Field(default_factory=list)
    evidence: List[Evidence] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)
    needs_confirmation: bool = True
    match_payload: Optional[Dict[str, Any]] = None


class ConfirmMatchRequest(BaseModel):
    confirmed: bool = True
    played_at: Optional[str] = None


class ConfirmMatchResponse(BaseModel):
    confirmed: bool
    match_payload: Dict[str, Any]


class VideoSessionRecord(BaseModel):
    session_id: str
    status: JobStatus
    stage: str
    youtube_url: str
    created_at: str
    updated_at: str
    reference_frames: List[ReferenceFrame] = Field(default_factory=list)
    player_slots: List[PlayerSlot] = Field(default_factory=list)
    player_mapping: Dict[str, SlotPlayer] = Field(default_factory=dict)
    score_result: Optional[VideoScoreResult] = None
    warnings: List[str] = Field(default_factory=list)
    error: Optional[str] = None
    raw: Optional[Dict[str, Any]] = None
