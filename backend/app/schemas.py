"""Pydantic request/response schemas."""

from datetime import datetime
import json
from typing import Any

from pydantic import BaseModel, Field, field_serializer, field_validator, model_validator

from app.models import ScenarioFileKind, TestRunStatus, TestRunType
from app.utils.datetime_utils import naive_utc, to_utc_iso


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


class JmeterProperty(BaseModel):
    name: str
    value: str = ""


class ScenarioOut(BaseModel):
    id: int
    application_id: int
    name: str
    tag: str | None
    tags: list[str] = Field(default_factory=list)
    jmx_filename: str
    description: str | None
    jmeter_properties: list[JmeterProperty] = Field(default_factory=list)
    created_at: datetime

    model_config = {"from_attributes": True}

    @model_validator(mode="before")
    @classmethod
    def load_jmeter_properties(cls, data: Any) -> Any:
        if isinstance(data, dict):
            raw = data.get("jmeter_properties_json") or data.get("jmeter_properties")
            if isinstance(raw, str):
                from app.scenario_properties import parse_jmeter_properties

                data = {**data, "jmeter_properties": parse_jmeter_properties(raw)}
            return data
        if hasattr(data, "id"):
            from app.scenario_properties import parse_jmeter_properties

            return {
                "id": data.id,
                "application_id": data.application_id,
                "name": data.name,
                "tag": data.tag,
                "jmx_filename": data.jmx_filename,
                "description": data.description,
                "created_at": data.created_at,
                "jmeter_properties": parse_jmeter_properties(data.jmeter_properties_json),
            }
        return data

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
    jmeter_properties: list[JmeterProperty] = Field(default_factory=list)
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
    schedule_id: int | None = None
    schedule_frequency: str | None = None
    next_run_at: datetime | None = None
    queued_run_id: int | None = None
    is_queued: bool = False

    @field_serializer(
        "created_at",
        "last_run_started_at",
        "last_run_finished_at",
        "next_run_at",
        when_used="json",
    )
    def serialize_datetimes(self, value: datetime | None) -> str | None:
        return to_utc_iso(value) if value else None


class ScenarioScheduleCreate(BaseModel):
    frequency: str
    run_at: datetime
    days_of_week: list[int] | None = None
    notes: str | None = None

    @field_validator("run_at")
    @classmethod
    def normalize_run_at(cls, value: datetime) -> datetime:
        return naive_utc(value)


class ScenarioScheduleOut(BaseModel):
    id: int
    scenario_id: int
    frequency: str
    run_at: datetime
    days_of_week: list[int] = Field(default_factory=list)
    next_run_at: datetime
    is_active: bool
    notes: str | None
    created_at: datetime

    model_config = {"from_attributes": True}

    @field_serializer("run_at", "next_run_at", "created_at", when_used="json")
    def serialize_datetimes(self, value: datetime) -> str:
        return to_utc_iso(value)


# --- Test runs ---

DEFAULT_RUN_DESCRIPTION = "Verification Test"


class TestRunCreate(BaseModel):
    scenario_id: int
    notes: str | None = None


class TestRunSchedule(BaseModel):
    scenario_id: int
    scheduled_at: datetime
    notes: str | None = None

    @field_validator("scheduled_at")
    @classmethod
    def normalize_scheduled_at(cls, value: datetime) -> datetime:
        return naive_utc(value)


def normalize_run_notes(notes: str | None) -> str:
    cleaned = (notes or "").strip()
    return cleaned or DEFAULT_RUN_DESCRIPTION


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
    is_archived: bool = False
    archived_at: datetime | None = None
    consider_for_release: bool = False
    created_at: datetime
    # Enriched fields (optional)
    scenario_name: str | None = None
    release_name: str | None = None
    build_name: str | None = None
    application_name: str | None = None
    scenario_tags: list[str] = Field(default_factory=list)

    model_config = {"from_attributes": True}

    @field_serializer(
        "scheduled_at",
        "started_at",
        "finished_at",
        "archived_at",
        "created_at",
        when_used="json",
    )
    def serialize_datetimes(self, value: datetime | None) -> str | None:
        return to_utc_iso(value) if value else None


class QueuedRunItem(TestRunOut):
    queue_position: int


class ScheduledQueueItem(BaseModel):
    schedule_id: int | None = None
    test_run_id: int | None = None
    scenario_id: int
    scenario_name: str | None = None
    release_id: int | None = None
    release_name: str | None = None
    build_id: int | None = None
    build_name: str | None = None
    application_id: int | None = None
    application_name: str | None = None
    scenario_tags: list[str] = Field(default_factory=list)
    frequency: str | None = None
    run_at: datetime | None = None
    days_of_week: list[int] = Field(default_factory=list)
    next_run_at: datetime
    notes: str | None = None

    @field_serializer("run_at", "next_run_at", when_used="json")
    def serialize_datetimes(self, value: datetime | None) -> str | None:
        return to_utc_iso(value) if value else None


class TestRunQueueOut(BaseModel):
    running: TestRunOut | None = None
    queued: list[QueuedRunItem] = Field(default_factory=list)
    scheduled: list[ScheduledQueueItem] = Field(default_factory=list)


class HostResourceSample(BaseModel):
    t: float
    cpu_percent: float
    memory_percent: float
    memory_used_mb: float
    memory_total_mb: float
    recorded_at: str | None = None


class HostResourcesOut(BaseModel):
    interval_seconds: int
    samples: list[HostResourceSample] = Field(default_factory=list)


class TransactionMetric(BaseModel):
    label: str
    kind: str = "transaction"
    samples: int = 0
    errors: int = 0
    error_pct: float = 0.0
    avg_ms: float = 0.0
    min_ms: float = 0.0
    max_ms: float = 0.0
    median_ms: float = 0.0
    p90_ms: float = 0.0
    p95_ms: float = 0.0
    p99_ms: float = 0.0
    throughput: float = 0.0


class ErrorSample(BaseModel):
    sample_index: int
    timestamp: int
    label: str
    response_code: str
    response_message: str
    failure_message: str
    thread_name: str
    url: str = ""
    elapsed_ms: float = 0.0


class ResponseCodeCount(BaseModel):
    response_code: str
    count: int
    pct: float = 0.0


class ErrorDetailOut(BaseModel):
    sample_index: int
    timestamp: int
    label: str
    response_code: str
    response_message: str
    failure_message: str
    thread_name: str
    url: str = ""
    elapsed_ms: float = 0.0
    response_body: str | None = None
    response_headers: str | None = None
    request_headers: str | None = None
    request_body: str | None = None
    from_errors_trace: bool = False


class LiveMetricsSnapshot(BaseModel):
    test_run_id: int
    status: TestRunStatus
    active_threads: int = 0
    elapsed_seconds: float = 0.0
    total_samples: int = 0
    total_errors: int = 0
    transactions: list[TransactionMetric] = Field(default_factory=list)
    errors: list[ErrorSample] = Field(default_factory=list)
    response_codes: list[ResponseCodeCount] = Field(default_factory=list)
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


class TestRunDeleteByDateRequest(BaseModel):
    finished_from: datetime | None = None
    finished_to: datetime | None = None
    include_archived: bool = True
    dry_run: bool = False


class TestRunDeleteByDateOut(BaseModel):
    match_count: int
    sample_ids: list[int] = Field(default_factory=list)
    deleted: list[int] = Field(default_factory=list)
    failed: list[TestRunDeleteFailure] = Field(default_factory=list)


class TestRunConsiderRequest(BaseModel):
    test_run_ids: list[int] = Field(..., min_length=1)
    consider: bool = True


class TestRunConsiderOut(BaseModel):
    updated: list[int]
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


class SystemConfigOut(BaseModel):
    jmeter_home: str
    data_root: str
    archive_retention_months: int
    auto_archive_enabled: bool
    resource_sample_interval_seconds: int
    live_dashboard_refresh_interval_seconds: int
    aggregate_total_avg_title: str
    aggregate_total_avg_filter: str
    aggregate_total_avg_exclude: str
    aggregate_load_avg_title: str
    aggregate_load_avg_filter: str
    aggregate_submit_avg_title: str
    aggregate_submit_avg_filter: str
    jmeter_found: bool
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class SystemConfigUpdate(BaseModel):
    jmeter_home: str
    data_root: str
    archive_retention_months: int = Field(default=3, ge=1, le=120)
    auto_archive_enabled: bool = True
    resource_sample_interval_seconds: int = Field(default=10, ge=5, le=300)
    live_dashboard_refresh_interval_seconds: int = Field(default=10, ge=5, le=300)
    aggregate_total_avg_title: str = Field(default="Total Avg", min_length=1, max_length=128)
    aggregate_total_avg_filter: str = Field(default="", max_length=256)
    aggregate_total_avg_exclude: str = Field(default="", max_length=2048)
    aggregate_load_avg_title: str = Field(default="Load Avg", min_length=1, max_length=128)
    aggregate_load_avg_filter: str = Field(default="_L_", max_length=256)
    aggregate_submit_avg_title: str = Field(default="Submit Avg", min_length=1, max_length=128)
    aggregate_submit_avg_filter: str = Field(default="_S_", max_length=256)


class AggregateSummaryConfigUpdate(BaseModel):
    aggregate_total_avg_title: str = Field(default="Total Avg", min_length=1, max_length=128)
    aggregate_total_avg_filter: str = Field(default="", max_length=256)
    aggregate_total_avg_exclude: str = Field(default="", max_length=2048)
    aggregate_load_avg_title: str = Field(default="Load Avg", min_length=1, max_length=128)
    aggregate_load_avg_filter: str = Field(default="_L_", max_length=256)
    aggregate_submit_avg_title: str = Field(default="Submit Avg", min_length=1, max_length=128)
    aggregate_submit_avg_filter: str = Field(default="_S_", max_length=256)


class ArchiveRunItem(BaseModel):
    id: int
    scenario_name: str | None = None
    release_name: str | None = None
    build_name: str | None = None
    application_name: str | None = None
    status: TestRunStatus
    finished_at: datetime | None
    is_archived: bool
    archived_at: datetime | None
    run_dir: str | None


class ArchiveActionRequest(BaseModel):
    test_run_ids: list[int] = Field(..., min_length=1)


class ArchiveActionOut(BaseModel):
    succeeded: list[int]
    failed: list[TestRunDeleteFailure] = Field(default_factory=list)


class AutoArchiveOut(BaseModel):
    archived: list[int]
    retention_months: int


class AppNotificationOut(BaseModel):
    id: int
    kind: str
    title: str
    message: str
    payload: dict | None = None
    actions: list[dict] = Field(default_factory=list)
    created_at: datetime

    @field_serializer("created_at", when_used="json")
    def serialize_created_at(self, value: datetime) -> str:
        return to_utc_iso(value)


class NotificationClearRequest(BaseModel):
    ids: list[int] | None = None


class NotificationClearOut(BaseModel):
    deleted: int


class UpdateCheckOut(BaseModel):
    current_version: str
    latest_version: str | None = None
    update_available: bool = False
    remote_commit: str | None = None
    repo_available: bool = False
    pending_version: str | None = None
    update_started: bool = False


class UpdateApplyRequest(BaseModel):
    confirmed: bool = True
    version: str | None = None


class UpdateApplyOut(BaseModel):
    status: str
    message: str
