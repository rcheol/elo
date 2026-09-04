from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator


ProviderName = Literal["auto", "gemini", "twelvelabs", "openai_frames", "local_ocr"]
AnalyzeStatus = Literal["succeeded", "failed"]
JobStatus = Literal["queued", "running", "succeeded", "failed"]
Winner = Literal["A", "B", "unknown"]


class AnalyzeRequest(BaseModel):
    youtube_url: str = Field(..., min_length=8)
    provider: ProviderName = "auto"
    expected_players: List[str] = Field(default_factory=list, max_length=8)
    hint: str = Field(default="", max_length=1000)
    save_raw: bool = False

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
