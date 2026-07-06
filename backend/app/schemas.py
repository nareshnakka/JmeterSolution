"""Pydantic request/response schemas."""

from datetime import datetime
import json
from typing import Any

from pydantic import BaseModel, Field, model_validator

from app.models import ScenarioFileKind, TestRunStatus, TestRunType


# --- Release hierarchy ---

class ReleaseCreate(BaseModel):
    name: str
    description: str | None = None


class ReleaseOut(BaseModel):
    id: int
    name: str
    description: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class BuildCreate(BaseModel):
    name: str
    description: str | None = None


class BuildOut(BaseModel):
    id: int
    release_id: int
    name: str
    description: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ApplicationCreate(BaseModel):
    name: str
    app_type: str | None = None
    description: str | None = None


class ApplicationOut(BaseModel):
    id: int
    build_id: int
    name: str
    app_type: str | None
    description: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ScenarioOut(BaseModel):
    id: int
    application_id: int
    name: str
    tag: str | None
    tags: list[str] = Field(default_factory=list)
    jmx_filename: str
    description: str | None
    created_at: datetime

    model_config = {"from_attributes": True}

    @model_validator(mode="after")
    def extract_tags(self) -> "ScenarioOut":
        if self.tag:
            try:
                parsed = json.loads(self.tag)
                if isinstance(parsed, list):
                    self.tags = [str(t) for t in parsed]
                else:
                    self.tags = [str(self.tag)]
            except json.JSONDecodeError:
                self.tags = [self.tag]
        return self


class ScenarioFileOut(BaseModel):
    id: int
    filename: str
    kind: ScenarioFileKind
    created_at: datetime

    model_config = {"from_attributes": True}


class ScenarioListItem(BaseModel):
    id: int
    name: str
    tags: list[str] = Field(default_factory=list)
    jmx_filename: str
    release_id: int
    release_name: str
    build_id: int
    build_name: str
    application_id: int
    application_name: str
    application_type: str | None = None
    created_at: datetime
    last_run_id: int | None = None
    last_run_status: TestRunStatus | None = None
    last_run_started_at: datetime | None = None
    last_run_finished_at: datetime | None = None
    active_run_id: int | None = None
    is_running: bool = False


# --- Test runs ---

class TestRunCreate(BaseModel):
    scenario_id: int
    notes: str | None = None


class TestRunSchedule(BaseModel):
    scenario_id: int
    scheduled_at: datetime
    notes: str | None = None


class TestRunOut(BaseModel):
    id: int
    scenario_id: int
    run_type: TestRunType
    status: TestRunStatus
    scheduled_at: datetime | None
    started_at: datetime | None
    finished_at: datetime | None
    run_dir: str | None
    jtl_path: str | None
    log_path: str | None
    error_message: str | None
    notes: str | None
    created_at: datetime
    # Enriched fields (optional)
    scenario_name: str | None = None
    release_name: str | None = None
    build_name: str | None = None
    application_name: str | None = None
    scenario_tags: list[str] = Field(default_factory=list)

    model_config = {"from_attributes": True}


class TransactionMetric(BaseModel):
    label: str
    samples: int = 0
    errors: int = 0
    error_pct: float = 0.0
    avg_ms: float = 0.0
    min_ms: float = 0.0
    max_ms: float = 0.0
    median_ms: float = 0.0
    p90_ms: float = 0.0
    p95_ms: float = 0.0
    throughput: float = 0.0


class ErrorSample(BaseModel):
    timestamp: int
    label: str
    response_code: str
    response_message: str
    failure_message: str
    thread_name: str
    url: str = ""


class LiveMetricsSnapshot(BaseModel):
    test_run_id: int
    status: TestRunStatus
    active_threads: int = 0
    elapsed_seconds: float = 0.0
    total_samples: int = 0
    total_errors: int = 0
    transactions: list[TransactionMetric] = Field(default_factory=list)
    errors: list[ErrorSample] = Field(default_factory=list)
    active_users_series: list[dict[str, Any]] = Field(default_factory=list)
    throughput_series: list[dict[str, Any]] = Field(default_factory=list)


class TestRunDeleteRequest(BaseModel):
    test_run_ids: list[int] = Field(..., min_length=1)


class TestRunDeleteFailure(BaseModel):
    id: int
    error: str


class TestRunDeleteOut(BaseModel):
    deleted: list[int]
    failed: list[TestRunDeleteFailure] = Field(default_factory=list)


class CompareRequest(BaseModel):
    test_run_ids: list[int]


class CompareRunSummary(BaseModel):
    test_run_id: int
    scenario_name: str
    release_name: str
    build_name: str
    status: TestRunStatus
    started_at: datetime | None
    finished_at: datetime | None
    transactions: list[TransactionMetric]


class ArtifactInfo(BaseModel):
    name: str
    path: str
    size_bytes: int
    is_directory: bool


class TestRunLogsOut(BaseModel):
    content: str
    offset: int
    size: int
    complete: bool
