"""Parse JMeter CSV JTL samples and aggregate live metrics."""

from __future__ import annotations

import base64
import csv
import html
import io
import re
import statistics
import time
import xml.etree.ElementTree as ET
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.schemas import (
    ErrorDetailOut,
    ErrorSample,
    LiveMetricsSnapshot,
    ResponseCodeCount,
    TransactionMetric,
)
from app.models import TestRunStatus


JTL_HEADER = (
    "timeStamp,elapsed,label,responseCode,responseMessage,threadName,"
    "dataType,success,failureMessage,bytes,sentBytes,grpThreads,allThreads,"
    "URL,Latency,IdleTime,Connect"
)


def _default_header_map() -> dict[str, int]:
    return {name: index for index, name in enumerate(JTL_HEADER.split(","))}


def _parse_header_map(line: str) -> dict[str, int]:
    reader = csv.reader(io.StringIO(line.strip()))
    try:
        cols = next(reader)
    except StopIteration:
        return _default_header_map()
    return {name.strip(): index for index, name in enumerate(cols)}


def _col(row: list[str], header: dict[str, int], name: str, default: str = "") -> str:
    index = header.get(name)
    if index is None or index >= len(row):
        return default
    return row[index]


@dataclass
class Sample:
    sample_index: int
    timestamp_ms: int
    elapsed_ms: float
    label: str
    response_code: str
    response_message: str
    thread_name: str
    success: bool
    failure_message: str
    all_threads: int = 0
    url: str = ""
    data_type: str = ""
    sample_type: str = ""
    response_data: str = ""
    response_headers: str = ""
    request_headers: str = ""
    sampler_data: str = ""
    query_string: str = ""


def _http_message_body(text: str) -> str | None:
    for sep in ("\r\n\r\n", "\n\n"):
        if sep in text:
            body = text.split(sep, 1)[1].strip()
            if body:
                return body
    return None


def _resolve_request_body(sample: Sample) -> str | None:
    """Extract request payload from samplerData and/or JMeter queryString."""
    candidates: list[str] = []
    if sample.query_string.strip():
        candidates.append(sample.query_string.strip())
    if sample.sampler_data.strip():
        candidates.append(sample.sampler_data.strip())

    http_methods = ("GET ", "POST ", "PUT ", "PATCH ", "DELETE ", "HEAD ", "OPTIONS ", "TRACE ")
    for text in candidates:
        if text.upper().startswith(http_methods):
            body = _http_message_body(text)
            if body:
                return body
            continue
        return text
    return None


def _sample_kind(sample: Sample) -> str:
    """Classify JMeter samples: transaction controllers vs HTTP/API requests."""
    msg = (sample.response_message or "").lower()
    data_type = (sample.data_type or "").strip().lower()
    url = (sample.url or "").strip().lower()
    sample_type = (sample.sample_type or "").strip().lower()

    if "samples in transaction" in msg:
        return "transaction"

    if sample_type:
        if "transaction" in sample_type:
            return "transaction"
        if sample_type in ("http", "https") or "httpsample" in sample_type.replace("_", ""):
            return "request"

    # Transaction controllers leave dataType blank; HTTP samplers use text/bin.
    if not data_type:
        if url.startswith(("http://", "https://", "jdbc:")):
            return "request"
        return "transaction"

    if data_type in ("text", "bin", "text/plain", "application/json", "application/xml"):
        return "request"

    if url.startswith(("http://", "https://", "jdbc:")):
        return "request"

    return "transaction"


@dataclass
class MetricsAggregator:
    test_run_id: int
    bucket_seconds: int = 5
    timeline_bucket_seconds: int = 1
    start_wall_time: float = field(default_factory=time.time)

    samples: list[Sample] = field(default_factory=list)
    errors: list[ErrorSample] = field(default_factory=list)
    label_time_series: dict[str, list[dict[str, Any]]] = field(default_factory=lambda: defaultdict(list))
    label_error_series: dict[str, list[dict[str, Any]]] = field(default_factory=lambda: defaultdict(list))
    all_error_series: list[dict[str, Any]] = field(default_factory=list)

    status: TestRunStatus = TestRunStatus.RUNNING
    _last_bucket: int = -1
    _last_all_threads: int = 0
    _users_by_timeline_bucket: dict[int, int] = field(default_factory=dict)
    _throughput_by_timeline_bucket: dict[int, int] = field(default_factory=dict)
    _throughput_success_by_timeline_bucket: dict[int, int] = field(default_factory=dict)
    _header_map: dict[str, int] = field(default_factory=_default_header_map)
    jtl_byte_offset: int = 0
    _revision: int = 0
    _error_count: int = 0
    _snapshot_cache: LiveMetricsSnapshot | None = field(default=None, repr=False)
    _snapshot_revision: int = -1
    _snapshot_status: TestRunStatus | None = None
    _transactions_cache: list[TransactionMetric] | None = field(default=None, repr=False)
    _transactions_revision: int = -1
    _response_codes_cache: list[ResponseCodeCount] | None = field(default=None, repr=False)
    _response_codes_revision: int = -1

    def ingest_line(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        if line.startswith("timeStamp"):
            self._header_map = _parse_header_map(line)
            return

        sample = _parse_jtl_line(line, self._header_map)
        if sample is None:
            return
        self._ingest_sample(sample)

    def _ingest_sample(self, sample: Sample) -> None:
        sample.sample_index = len(self.samples)
        self.samples.append(sample)
        self._revision += 1
        if len(self.samples) == 1:
            self.start_wall_time = sample.timestamp_ms / 1000.0
        self._last_all_threads = max(self._last_all_threads, sample.all_threads)
        self._update_buckets(sample)
        if not sample.success:
            self._error_count += 1
            self.errors.append(self._sample_to_error(sample))
        if len(self.errors) > 500:
            self.errors = self.errors[-500:]

    def _sample_to_error(self, sample: Sample) -> ErrorSample:
        return ErrorSample(
            sample_index=sample.sample_index,
            timestamp=sample.timestamp_ms,
            label=sample.label,
            response_code=sample.response_code,
            response_message=sample.response_message,
            failure_message=sample.failure_message,
            thread_name=sample.thread_name,
            url=sample.url,
            elapsed_ms=sample.elapsed_ms,
        )

    def _update_buckets(self, sample: Sample) -> None:
        elapsed = (sample.timestamp_ms / 1000.0) - self.start_wall_time
        if elapsed < 0:
            elapsed = time.time() - self.start_wall_time
        bucket = int(elapsed // self.bucket_seconds)
        timeline_bucket = int(elapsed // self.timeline_bucket_seconds)

        prev_users = self._users_by_timeline_bucket.get(timeline_bucket, 0)
        self._users_by_timeline_bucket[timeline_bucket] = max(prev_users, sample.all_threads)
        # Count every sample (pass + fail) so Hits/s always has data when traffic exists.
        self._throughput_by_timeline_bucket[timeline_bucket] = (
            self._throughput_by_timeline_bucket.get(timeline_bucket, 0) + 1
        )
        if sample.success:
            self._throughput_success_by_timeline_bucket[timeline_bucket] = (
                self._throughput_success_by_timeline_bucket.get(timeline_bucket, 0) + 1
            )

        series = self.label_time_series[sample.label]
        if not series or series[-1].get("bucket") != bucket:
            series.append({"bucket": bucket, "t": round(elapsed, 1), "elapsed": [sample.elapsed_ms]})
        else:
            series[-1]["elapsed"].append(sample.elapsed_ms)

        if not sample.success:
            err_label = self.label_error_series[sample.label]
            self._append_error_bucket(err_label, bucket, elapsed)
            self._append_error_bucket(self.all_error_series, bucket, elapsed)

    def _bucket_time(self, bucket: int) -> float:
        return round(bucket * self.bucket_seconds, 1)

    def _timeline_time(self, bucket: int) -> float:
        return round(bucket * self.timeline_bucket_seconds, 1)

    def _sample_end_seconds(self) -> float:
        """Elapsed seconds at the last JTL sample (actual test activity end)."""
        if not self.samples:
            return 0.001
        last_ts = max(s.timestamp_ms for s in self.samples) / 1000.0
        return max(last_ts - self.start_wall_time, 0.001)

    def _sample_end_bucket(self) -> int:
        return int(self._sample_end_seconds() // self.timeline_bucket_seconds)

    def _timeline_max_bucket(self) -> int:
        """Last timeline bucket with sample activity (never wall-clock padded)."""
        buckets: list[int] = []
        if self._users_by_timeline_bucket:
            buckets.append(max(self._users_by_timeline_bucket))
        if self._throughput_by_timeline_bucket:
            buckets.append(max(self._throughput_by_timeline_bucket))
        sample_end = self._sample_end_bucket()
        if not buckets:
            return sample_end
        return min(max(buckets), sample_end)

    def _filled_active_users_series(self) -> list[dict[str, Any]]:
        """Virtual users timeline — sparse step points (only value changes)."""
        if not self._users_by_timeline_bucket:
            return []

        max_bucket = self._timeline_max_bucket()
        result: list[dict[str, Any]] = []
        last_users = 0
        for bucket in range(0, max_bucket + 1):
            if bucket in self._users_by_timeline_bucket:
                users = self._users_by_timeline_bucket[bucket]
                if users != last_users:
                    result.append({"t": self._timeline_time(bucket), "users": users})
                    last_users = users
        if not result:
            result.append({"t": 0.0, "users": 0})
        return self._downsample_timeline_points(result)

    def _filled_throughput_series(self) -> list[dict[str, Any]]:
        """Hits/s timeline using adaptive buckets so long runs stay chartable (~300 pts)."""
        if not self._throughput_by_timeline_bucket and not self.samples:
            return []

        max_bucket = self._timeline_max_bucket()
        if max_bucket < 0:
            return [{"t": 0.0, "hits_per_sec": 0.0}]

        # Prefer ~300 points across the whole window (1s for short runs, coarser for long).
        target_points = 300
        stride = max(1, (max_bucket + 1 + target_points - 1) // target_points)
        result: list[dict[str, Any]] = []
        for start in range(0, max_bucket + 1, stride):
            end = min(start + stride, max_bucket + 1)
            total = 0
            for bucket in range(start, end):
                total += self._throughput_by_timeline_bucket.get(bucket, 0)
            seconds = (end - start) * self.timeline_bucket_seconds
            result.append(
                {
                    "t": self._timeline_time(start),
                    "hits_per_sec": round(total / seconds, 2) if seconds > 0 else 0.0,
                }
            )
        return result

    def _downsample_timeline_points(
        self,
        points: list[dict[str, Any]],
        max_points: int = 500,
    ) -> list[dict[str, Any]]:
        """Keep first/last points and evenly sample the middle for small API payloads."""
        if len(points) <= max_points:
            return points
        if max_points < 3:
            return points[:max_points]
        result = [points[0]]
        middle = max_points - 2
        step = (len(points) - 2) / middle
        for i in range(middle):
            idx = 1 + int(i * step)
            result.append(points[idx])
        last = points[-1]
        if result[-1].get("t") != last.get("t"):
            result.append(last)
        return result

    def _append_error_bucket(
        self, series: list[dict[str, Any]], bucket: int, elapsed: float
    ) -> None:
        del elapsed  # bucket start time is used for stable chart ordering
        for entry in series:
            if entry.get("bucket") == bucket:
                entry["errors"] += 1
                return
        series.append({"bucket": bucket, "t": self._bucket_time(bucket), "errors": 1})
        series.sort(key=lambda e: e.get("bucket", 0))

    def _elapsed_seconds(self) -> float:
        sample_end = self._sample_end_seconds()
        if not self.samples:
            return 0.001
        if self.status == TestRunStatus.RUNNING:
            wall = max(time.time() - self.start_wall_time, 0.001)
            # After samples stop, don't keep inflating elapsed/chart while JMeter shuts down.
            if wall - sample_end > 15:
                return sample_end
            return max(wall, sample_end)
        return sample_end

    def _collect_samples_for_aggregate(
        self,
        label_filter: str | None = None,
        kind_filter: str | None = None,
    ) -> list[Sample]:
        """Collect raw samples using the same rules as the aggregate report filters."""
        grouped: dict[tuple[str, str], list[Sample]] = defaultdict(list)
        label_q = label_filter.strip().lower() if label_filter else ""

        for s in self.samples:
            if label_q and label_q not in s.label.lower():
                continue
            grouped[(s.label, _sample_kind(s))].append(s)

        transaction_labels = {label for (label, kind) in grouped if kind == "transaction"}
        selected: list[Sample] = []
        for (label, kind), items in grouped.items():
            if kind == "request" and label in transaction_labels:
                continue
            if kind_filter and kind_filter != "all" and kind != kind_filter:
                continue
            selected.extend(items)
        return selected

    def _metric_from_samples(self, items: list[Sample], elapsed_sec: float) -> TransactionMetric:
        elapsed_vals = [i.elapsed_ms for i in items]
        errors = sum(1 for i in items if not i.success)
        n = len(items)
        sorted_vals = sorted(elapsed_vals)
        return TransactionMetric(
            label="TOTAL",
            kind="transaction",
            samples=n,
            errors=errors,
            error_pct=round(100.0 * errors / n, 2) if n else 0,
            avg_ms=round(statistics.mean(elapsed_vals), 2) if n else 0,
            min_ms=round(min(elapsed_vals), 2) if n else 0,
            max_ms=round(max(elapsed_vals), 2) if n else 0,
            median_ms=round(statistics.median(sorted_vals), 2) if n else 0,
            p90_ms=round(_percentile(sorted_vals, 90), 2) if n else 0,
            p95_ms=round(_percentile(sorted_vals, 95), 2) if n else 0,
            p99_ms=round(_percentile(sorted_vals, 99), 2) if n else 0,
            throughput=round(n / elapsed_sec, 2) if elapsed_sec > 0 else 0,
        )

    def transaction_totals(
        self,
        label_filter: str | None = None,
        kind_filter: str | None = None,
    ) -> TransactionMetric | None:
        """Compute TOTAL row from pooled samples (correct percentiles and averages)."""
        items = self._collect_samples_for_aggregate(label_filter, kind_filter)
        if not items:
            return None
        return self._metric_from_samples(items, self._elapsed_seconds())

    def transaction_metrics(self, label_filter: str | None = None) -> list[TransactionMetric]:
        if label_filter is None and self._transactions_cache is not None:
            if self._transactions_revision == self._revision:
                return self._transactions_cache

        grouped: dict[tuple[str, str], list[Sample]] = defaultdict(list)
        label_q = label_filter.strip().lower() if label_filter else ""

        for s in self.samples:
            if label_q and label_q not in s.label.lower():
                continue
            grouped[(s.label, _sample_kind(s))].append(s)

        transaction_labels = {label for (label, kind) in grouped if kind == "transaction"}

        results: list[TransactionMetric] = []
        elapsed_sec = self._elapsed_seconds()
        for (label, kind), items in sorted(grouped.items()):
            # Skip request aggregates that share a label with a transaction controller row.
            if kind == "request" and label in transaction_labels:
                continue
            metric = self._metric_from_samples(items, elapsed_sec)
            metric.label = label
            metric.kind = kind
            results.append(metric)
        if label_filter is None:
            self._transactions_cache = results
            self._transactions_revision = self._revision
        return results

    def response_code_counts(self) -> list[ResponseCodeCount]:
        if self._response_codes_cache is not None and self._response_codes_revision == self._revision:
            return self._response_codes_cache

        totals: dict[str, int] = defaultdict(int)
        for sample in self.samples:
            code = (sample.response_code or "").strip() or "N/A"
            totals[code] += 1

        total = len(self.samples)
        results = [
            ResponseCodeCount(
                response_code=code,
                count=count,
                pct=round(100.0 * count / total, 2) if total else 0.0,
            )
            for code, count in sorted(totals.items(), key=lambda item: (-item[1], item[0]))
        ]
        self._response_codes_cache = results
        self._response_codes_revision = self._revision
        return results

    def snapshot(self) -> LiveMetricsSnapshot:
        cache_valid = (
            self._snapshot_cache is not None
            and self._snapshot_revision == self._revision
            and self._snapshot_status == self.status
        )
        if cache_valid:
            if self.status == TestRunStatus.RUNNING:
                elapsed = round(self._elapsed_seconds(), 1)
                cached = self._snapshot_cache
                assert cached is not None
                if (
                    cached.elapsed_seconds != elapsed
                    or cached.active_threads != self._last_all_threads
                ):
                    # Elapsed/thread heartbeat only — keep cached series/transactions.
                    updated = cached.model_copy(
                        update={
                            "elapsed_seconds": elapsed,
                            "active_threads": self._last_all_threads,
                        }
                    )
                    self._snapshot_cache = updated
                    return updated
                return cached
            return self._snapshot_cache

        elapsed = self._elapsed_seconds()
        snap = LiveMetricsSnapshot(
            test_run_id=self.test_run_id,
            status=self.status,
            active_threads=self._last_all_threads,
            elapsed_seconds=round(elapsed, 1),
            total_samples=len(self.samples),
            total_errors=self._error_count,
            transactions=self.transaction_metrics(),
            errors=self.errors[-50:],
            response_codes=self.response_code_counts(),
            active_users_series=self._filled_active_users_series(),
            throughput_series=self._filled_throughput_series(),
        )
        self._snapshot_cache = snap
        self._snapshot_revision = self._revision
        self._snapshot_status = self.status
        return snap

    def _test_window_end_seconds(self) -> float:
        """End of the active load window, excluding post-test idle samples."""
        if not self.samples:
            return 0.001

        ends: list[float] = []

        active_buckets = sorted(
            bucket for bucket, users in self._users_by_timeline_bucket.items() if users > 0
        )
        if active_buckets:
            last_active = active_buckets[-1]
            end_bucket = last_active
            for bucket in sorted(self._users_by_timeline_bucket):
                if bucket > last_active:
                    end_bucket = bucket
                    break
            ends.append(self._timeline_time(min(end_bucket, self._sample_end_bucket())))

        if self._throughput_success_by_timeline_bucket:
            tp_end = self._timeline_time(max(self._throughput_success_by_timeline_bucket))
            ends.append(min(tp_end, self._sample_end_seconds()))

        if ends:
            return min(ends)

        return self._sample_end_seconds()

    def _cap_graph_time(self, points: list[dict[str, Any]]) -> list[dict[str, Any]]:
        max_t = self._test_window_end_seconds()
        return [p for p in points if float(p.get("t", 0)) <= max_t + 0.001]

    def label_graph(
        self,
        labels: list[str] | None = None,
        cumulative: bool = False,
    ) -> dict[str, Any]:
        """Return time-series avg response time for selected labels."""
        if labels is None or "ALL" in labels:
            target_labels = list(self.label_time_series.keys())
            cumulative = True
        else:
            target_labels = labels

        series: list[dict[str, Any]] = []
        for label in target_labels:
            buckets = self.label_time_series.get(label, [])
            points = []
            for b in buckets:
                if float(b["t"]) > self._test_window_end_seconds() + 0.001:
                    continue
                vals = b["elapsed"]
                points.append({"t": b["t"], "avg_ms": round(statistics.mean(vals), 2) if vals else 0})
            series.append({"label": label, "points": points})

        if cumulative and len(series) > 1:
            by_t: dict[float, list[float]] = defaultdict(list)
            for s in series:
                for p in s["points"]:
                    by_t[p["t"]].append(p["avg_ms"])
            merged = [{"t": t, "avg_ms": round(statistics.mean(v), 2)} for t, v in sorted(by_t.items())]
            return {
                "mode": "cumulative",
                "series": [{"label": "ALL", "points": self._cap_graph_time(merged)}],
                "test_window_end": round(self._test_window_end_seconds(), 1),
            }

        for s in series:
            s["points"] = self._cap_graph_time(s["points"])
        return {
            "mode": "individual",
            "series": series,
            "test_window_end": round(self._test_window_end_seconds(), 1),
        }

    def error_graph(
        self,
        labels: list[str] | None = None,
        cumulative: bool = False,
    ) -> dict[str, Any]:
        """Return per-interval error counts (not cumulative). cumulative param is ignored."""

        def _interval_points(raw: list[dict[str, Any]]) -> list[dict[str, Any]]:
            if not raw:
                return []
            by_bucket: dict[int, int] = {}
            for entry in raw:
                bucket = int(entry.get("bucket", 0))
                by_bucket[bucket] = by_bucket.get(bucket, 0) + int(entry.get("errors", 0))
            if not by_bucket:
                return []
            window_end_bucket = int(self._test_window_end_seconds() // self.bucket_seconds)
            max_bucket = min(max(by_bucket), window_end_bucket)
            return [
                {"t": self._bucket_time(b), "errors": by_bucket.get(b, 0)}
                for b in range(max_bucket + 1)
                if self._bucket_time(b) <= self._test_window_end_seconds() + 0.001
            ]

        if labels is None or "ALL" in labels:
            return {
                "mode": "all",
                "series": [{"label": "ALL", "points": _interval_points(self.all_error_series)}],
                "test_window_end": round(self._test_window_end_seconds(), 1),
            }

        target_labels = labels or []
        series: list[dict[str, Any]] = []
        for label in target_labels:
            points = _interval_points(self.label_error_series.get(label, []))
            series.append({"label": label, "points": points})

        return {
            "mode": "individual",
            "series": series,
            "test_window_end": round(self._test_window_end_seconds(), 1),
        }

    def search_errors(self, query: str | None = None, limit: int = 200) -> list[ErrorSample]:
        """Search all failed samples (full JTL), most recent first."""
        failed = [s for s in self.samples if not s.success]
        errors = [self._sample_to_error(s) for s in reversed(failed)]
        if not query or not query.strip():
            return errors[:limit]

        q = query.strip().lower()

        def _matches(error: ErrorSample) -> bool:
            for val in (
                error.label,
                error.response_code,
                error.response_message,
                error.failure_message,
                error.thread_name,
                error.url,
            ):
                if val and q in val.lower():
                    return True
            return False

        return [e for e in errors if _matches(e)][:limit]

    def get_error_detail(self, sample_index: int) -> ErrorDetailOut | None:
        if sample_index < 0 or sample_index >= len(self.samples):
            return None
        sample = self.samples[sample_index]
        if sample.success:
            return None
        return sample_to_error_detail(sample)


def _parse_jtl_success(raw: str) -> bool:
    """Accept common JMeter/CSV success encodings."""
    value = (raw or "").strip().lower()
    return value in {"true", "1", "yes", "y", "ok"}


def _sample_from_row(row: list[str], header: dict[str, int], sample_index: int) -> Sample | None:
    if len(row) < 8:
        return None
    try:
        all_threads_raw = _col(row, header, "allThreads", "0")
        try:
            all_threads = int(float(all_threads_raw or 0))
        except ValueError:
            all_threads = 0
        return Sample(
            sample_index=sample_index,
            timestamp_ms=int(_col(row, header, "timeStamp", "0")),
            elapsed_ms=float(_col(row, header, "elapsed", "0") or 0),
            label=_col(row, header, "label"),
            response_code=_col(row, header, "responseCode"),
            response_message=_col(row, header, "responseMessage"),
            thread_name=_col(row, header, "threadName"),
            success=_parse_jtl_success(_col(row, header, "success", "false")),
            failure_message=_col(row, header, "failureMessage"),
            all_threads=all_threads,
            url=_col(row, header, "URL"),
            data_type=_col(row, header, "dataType"),
            sample_type=_col(row, header, "sampleType"),
            response_data=_col(row, header, "responseData"),
            response_headers=_col(row, header, "responseHeaders"),
            request_headers=_col(row, header, "requestHeaders"),
            sampler_data=_col(row, header, "samplerData"),
            query_string=_col(row, header, "queryString"),
        )
    except ValueError:
        return None


def _parse_jtl_line(line: str, header: dict[str, int]) -> Sample | None:
    try:
        reader = csv.reader(io.StringIO(line))
        row = next(reader)
        return _sample_from_row(row, header, 0)
    except StopIteration:
        return None


def get_sample_from_jtl(path: str | Path, sample_index: int) -> Sample | None:
    """Load one sample by index using proper CSV parsing (supports multiline response bodies)."""
    jtl = Path(path)
    if not jtl.is_file():
        return None
    with open(jtl, encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        try:
            header_row = next(reader)
        except StopIteration:
            return None
        header = {name.strip(): index for index, name in enumerate(header_row)}
        for idx, row in enumerate(reader):
            if idx == sample_index:
                return _sample_from_row(row, header, sample_index)
            if idx > sample_index:
                break
    return None


def sample_to_error_detail(sample: Sample, *, from_errors_trace: bool = False) -> ErrorDetailOut:
    body = sample.response_data.strip() if sample.response_data else None
    request_body = _resolve_request_body(sample)
    return ErrorDetailOut(
        sample_index=sample.sample_index,
        timestamp=sample.timestamp_ms,
        label=sample.label,
        response_code=sample.response_code,
        response_message=sample.response_message,
        failure_message=sample.failure_message,
        thread_name=sample.thread_name,
        url=sample.url,
        elapsed_ms=sample.elapsed_ms,
        response_body=body or None,
        response_headers=sample.response_headers.strip() or None,
        request_headers=sample.request_headers.strip() or None,
        request_body=request_body or None,
        from_errors_trace=from_errors_trace,
    )


def _samples_match_for_trace(ref: Sample, candidate: Sample) -> bool:
    return (
        ref.timestamp_ms == candidate.timestamp_ms
        and ref.label == candidate.label
        and ref.thread_name == candidate.thread_name
        and ref.response_code == candidate.response_code
    )


def _sample_has_trace_payload(sample: Sample) -> bool:
    return bool(
        (sample.response_data or "").strip()
        or (sample.sampler_data or "").strip()
        or (sample.query_string or "").strip()
        or (sample.response_headers or "").strip()
        or (sample.request_headers or "").strip()
    )


def _merge_error_detail(primary: ErrorDetailOut, fallback: ErrorDetailOut) -> ErrorDetailOut:
    """Fill missing trace fields from the main JTL row."""
    updates: dict[str, Any] = {}
    if not primary.response_body and fallback.response_body:
        updates["response_body"] = fallback.response_body
    if not primary.request_body and fallback.request_body:
        updates["request_body"] = fallback.request_body
    if not primary.response_headers and fallback.response_headers:
        updates["response_headers"] = fallback.response_headers
    if not primary.request_headers and fallback.request_headers:
        updates["request_headers"] = fallback.request_headers
    if not primary.url and fallback.url:
        updates["url"] = fallback.url
    if updates:
        return primary.model_copy(update=updates)
    return primary


def _is_xml_jtl(path: Path) -> bool:
    try:
        with open(path, "rb") as f:
            head = f.read(512).lstrip()
    except OSError:
        return False
    return head.startswith(b"<?xml") or head.startswith(b"<testResults")


_JMETER_XML_TAG_RE = re.compile(
    r"<(/?)(httpSample|sample|javaSample|testResults)\b([^>]*)>",
    re.IGNORECASE,
)
_JMETER_SAMPLE_END_RE = re.compile(
    r"</(?:httpSample|sample|javaSample)\s*>",
    re.IGNORECASE,
)
_JMETER_SAMPLE_SELF_CLOSE_RE = re.compile(
    r"<(?:httpSample|sample|javaSample)\b[^>]*/>",
    re.IGNORECASE,
)


def _close_open_jmeter_xml_tags(prefix: str) -> str:
    """Append closing tags for any still-open JMeter sample/root elements."""
    open_tags: list[str] = []
    for match in _JMETER_XML_TAG_RE.finditer(prefix):
        closing, tag, attrs = match.group(1), match.group(2), match.group(3)
        if attrs.rstrip().endswith("/"):
            continue
        local = tag.lower()
        if closing:
            if open_tags and open_tags[-1].lower() == local:
                open_tags.pop()
            continue
        open_tags.append(tag)

    repaired = prefix
    for tag in reversed(open_tags):
        repaired += f"</{tag}>"
    return repaired


def _recover_incomplete_jmeter_xml(text: str) -> str | None:
    """
    Recover parseable XML from an in-progress JMeter errors-trace.jtl.

    While a test runs, JMeter writes samples but typically leaves </testResults>
    unclosed until shutdown. A sample may also be truncated mid-write.
    """
    stripped = text.strip()
    if not stripped or "<testResults" not in stripped:
        return None

    candidates: list[str] = []
    if "</testResults>" not in stripped:
        candidates.append(stripped + "\n</testResults>\n")
    else:
        candidates.append(stripped)

    ends = [m.end() for m in _JMETER_SAMPLE_END_RE.finditer(stripped)]
    ends.extend(m.end() for m in _JMETER_SAMPLE_SELF_CLOSE_RE.finditer(stripped))
    for end in sorted(set(ends), reverse=True):
        candidates.append(_close_open_jmeter_xml_tags(stripped[:end]))

    seen: set[str] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        try:
            ET.fromstring(candidate)
            return candidate
        except ET.ParseError:
            continue
    return None


def _parse_jmeter_xml_jtl(path: Path) -> ET.Element | None:
    """Parse JMeter XML JTL, including incomplete files written while a test is running."""
    try:
        return ET.parse(path).getroot()
    except ET.ParseError:
        pass
    except OSError:
        return None

    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None

    recovered = _recover_incomplete_jmeter_xml(text)
    if recovered is None:
        return None
    try:
        return ET.fromstring(recovered)
    except ET.ParseError:
        return None


def _xml_local_tag(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _is_jmeter_sample_tag(tag: str) -> bool:
    local = _xml_local_tag(tag).lower()
    return local in ("httpsample", "sample", "javasample") or local.endswith("sample")


def _xml_child_text(elem: ET.Element, name: str) -> str:
    return _xml_field_text(elem, name)


def _xml_field_text(elem: ET.Element, *names: str) -> str:
    """Read JMeter XML child fields (supports CDATA, base64, and java.net.URL)."""
    for name in names:
        for child in elem:
            if _xml_local_tag(child.tag) != name:
                continue
            raw = "".join(child.itertext()).strip()
            if not raw and child.text:
                raw = child.text.strip()
            if not raw:
                continue
            if (child.get("enc") or "").lower() == "base64":
                try:
                    return base64.b64decode(raw).decode("utf-8", errors="replace")
                except Exception:
                    return raw
            return html.unescape(raw)
    return ""


def _merge_sample_trace_fields(base: Sample, donor: Sample) -> Sample:
    """Fill missing trace fields on base from donor (e.g. child httpSample under a transaction)."""
    return Sample(
        sample_index=base.sample_index,
        timestamp_ms=base.timestamp_ms or donor.timestamp_ms,
        elapsed_ms=base.elapsed_ms or donor.elapsed_ms,
        label=base.label or donor.label,
        response_code=base.response_code or donor.response_code,
        response_message=base.response_message or donor.response_message,
        thread_name=base.thread_name or donor.thread_name,
        success=base.success,
        failure_message=base.failure_message or donor.failure_message,
        all_threads=base.all_threads,
        url=base.url or donor.url,
        data_type=base.data_type or donor.data_type,
        sample_type=base.sample_type or donor.sample_type,
        response_data=base.response_data or donor.response_data,
        response_headers=base.response_headers or donor.response_headers,
        request_headers=base.request_headers or donor.request_headers,
        sampler_data=base.sampler_data or donor.sampler_data,
        query_string=base.query_string or donor.query_string,
    )


def _enrich_sample_from_descendants(elem: ET.Element, sample: Sample) -> Sample:
    """Merge trace payload from nested httpSample elements (transaction controllers)."""
    enriched = sample
    for child in elem.iter():
        if child is elem or not _is_jmeter_sample_tag(child.tag):
            continue
        sub = _sample_from_xml_element(child, sample.sample_index)
        if sub is None or sub.success or not _sample_has_trace_payload(sub):
            continue
        enriched = _merge_sample_trace_fields(enriched, sub)
    return enriched


def _sample_from_xml_element(elem: ET.Element, sample_index: int) -> Sample | None:
    try:
        timestamp_ms = int(elem.get("ts", "0") or 0)
        elapsed_ms = float(elem.get("t", "0") or 0)
    except ValueError:
        return None

    sample = Sample(
        sample_index=sample_index,
        timestamp_ms=timestamp_ms,
        elapsed_ms=elapsed_ms,
        label=elem.get("lb", "") or "",
        response_code=elem.get("rc", "") or "",
        response_message=elem.get("rm", "") or "",
        thread_name=elem.get("tn", "") or "",
        success=_parse_jtl_success(elem.get("s", "false") or "false"),
        failure_message=_xml_field_text(elem, "failureMessage"),
        url=_xml_field_text(elem, "java.net.URL", "url"),
        data_type=elem.get("dt", "") or "",
        sample_type=_xml_local_tag(elem.tag),
        response_data=_xml_field_text(elem, "responseData"),
        response_headers=_xml_field_text(elem, "responseHeader", "responseHeaders"),
        request_headers=_xml_field_text(elem, "requestHeader", "requestHeaders"),
        sampler_data=_xml_field_text(elem, "samplerData"),
        query_string=_xml_field_text(elem, "queryString"),
    )
    return _enrich_sample_from_descendants(elem, sample)


def _find_matching_trace_sample_xml(path: Path, ref: Sample) -> Sample | None:
    root = _parse_jmeter_xml_jtl(path)
    if root is None:
        return None

    exact: Sample | None = None
    loose: Sample | None = None
    url_match: Sample | None = None
    ref_url = (ref.url or "").strip().lower()

    for idx, elem in enumerate(root.iter()):
        if not _is_jmeter_sample_tag(elem.tag):
            continue
        sample = _sample_from_xml_element(elem, idx)
        if sample is None or sample.success:
            continue
        if _samples_match_for_trace(ref, sample):
            exact = sample
            if _sample_has_trace_payload(sample):
                return sample
        elif (
            sample.timestamp_ms == ref.timestamp_ms
            and sample.thread_name == ref.thread_name
        ):
            if loose is None or (
                _sample_has_trace_payload(sample) and not _sample_has_trace_payload(loose)
            ):
                loose = sample
        elif ref_url and (sample.url or "").strip().lower() == ref_url:
            if url_match is None or (
                _sample_has_trace_payload(sample) and not _sample_has_trace_payload(url_match)
            ):
                url_match = sample

    for candidate in (exact, loose, url_match):
        if candidate is not None and _sample_has_trace_payload(candidate):
            return candidate
    return exact or loose or url_match


def _find_matching_trace_sample_csv(path: Path, ref: Sample) -> Sample | None:
    exact: Sample | None = None
    loose: Sample | None = None
    with open(path, encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        try:
            header_row = next(reader)
        except StopIteration:
            return None
        header = {name.strip(): index for index, name in enumerate(header_row)}
        for idx, row in enumerate(reader):
            sample = _sample_from_row(row, header, idx)
            if sample is None or sample.success:
                continue
            if _samples_match_for_trace(ref, sample):
                exact = sample
                if _sample_has_trace_payload(sample):
                    return sample
            elif (
                sample.timestamp_ms == ref.timestamp_ms
                and sample.thread_name == ref.thread_name
            ):
                if loose is None or (
                    _sample_has_trace_payload(sample) and not _sample_has_trace_payload(loose)
                ):
                    loose = sample

    if exact is not None and _sample_has_trace_payload(exact):
        return exact
    if loose is not None and _sample_has_trace_payload(loose):
        return loose
    return exact or loose


def find_matching_trace_sample(trace_jtl: str | Path, ref: Sample) -> Sample | None:
    """Find the best failed sample in errors-trace.jtl (XML or legacy CSV)."""
    path = Path(trace_jtl)
    if not path.is_file():
        return None
    if _is_xml_jtl(path):
        return _find_matching_trace_sample_xml(path, ref)
    return _find_matching_trace_sample_csv(path, ref)


def get_error_detail_from_jtl(path: str | Path, sample_index: int) -> ErrorDetailOut | None:
    sample = get_sample_from_jtl(path, sample_index)
    if sample is None or sample.success:
        return None
    return sample_to_error_detail(sample)


def get_error_detail_with_trace(
    main_jtl: str | Path | None,
    trace_jtl: str | Path | None,
    sample_index: int,
    *,
    main_sample: Sample | None = None,
) -> ErrorDetailOut | None:
    """Resolve error detail from errors-trace.jtl when available, else results.jtl."""
    if main_sample is None:
        if main_jtl is None:
            return None
        main_sample = get_sample_from_jtl(main_jtl, sample_index)
    if main_sample is None or main_sample.success:
        return None

    if trace_jtl:
        trace_sample = find_matching_trace_sample(trace_jtl, main_sample)
        if trace_sample is not None:
            detail = sample_to_error_detail(trace_sample, from_errors_trace=True)
            detail.sample_index = main_sample.sample_index
            main_detail = sample_to_error_detail(main_sample)
            return _merge_error_detail(detail, main_detail)

    return sample_to_error_detail(main_sample)


def search_errors_from_jtl(
    path: str | Path,
    query: str | None = None,
    limit: int = 200,
) -> list[ErrorSample]:
    """Return failed samples from a JTL file, most recent first."""
    jtl = Path(path)
    if not jtl.is_file():
        return []

    failed: list[ErrorSample] = []
    with open(jtl, encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        try:
            header_row = next(reader)
        except StopIteration:
            return []
        header = {name.strip(): index for index, name in enumerate(header_row)}
        for idx, row in enumerate(reader):
            sample = _sample_from_row(row, header, idx)
            if sample is None or sample.success:
                continue
            failed.append(
                ErrorSample(
                    sample_index=sample.sample_index,
                    timestamp=sample.timestamp_ms,
                    label=sample.label,
                    response_code=sample.response_code,
                    response_message=sample.response_message,
                    failure_message=sample.failure_message,
                    thread_name=sample.thread_name,
                    url=sample.url,
                    elapsed_ms=sample.elapsed_ms,
                )
            )

    errors = list(reversed(failed))
    if not query or not query.strip():
        return errors[:limit]

    q = query.strip().lower()

    def _matches(error: ErrorSample) -> bool:
        for val in (
            error.label,
            error.response_code,
            error.response_message,
            error.failure_message,
            error.thread_name,
            error.url,
        ):
            if val and q in val.lower():
                return True
        return False

    return [e for e in errors if _matches(e)][:limit]


def _percentile(sorted_vals: list[float], pct: float) -> float:
    if not sorted_vals:
        return 0.0
    k = (len(sorted_vals) - 1) * (pct / 100.0)
    f = int(k)
    c = min(f + 1, len(sorted_vals) - 1)
    if f == c:
        return sorted_vals[f]
    return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)


def append_jtl_file(
    agg: MetricsAggregator,
    path: str | Path,
    offset: int | None = None,
) -> tuple[int, bool]:
    """Append new JTL CSV rows from a byte offset. Returns (new_offset, changed)."""
    jtl = Path(path)
    if not jtl.is_file():
        return offset if offset is not None else agg.jtl_byte_offset, False

    start = offset if offset is not None else agg.jtl_byte_offset
    size = jtl.stat().st_size
    if size <= start:
        return start, False

    changed = False
    with open(jtl, encoding="utf-8", errors="replace") as f:
        f.seek(start)
        reader = csv.reader(f)
        if start == 0:
            try:
                header_row = next(reader)
            except StopIteration:
                return 0, False
            agg._header_map = {name.strip(): index for index, name in enumerate(header_row)}

        for row in reader:
            sample = _sample_from_row(row, agg._header_map, 0)
            if sample is not None:
                agg._ingest_sample(sample)
                changed = True
        new_offset = f.tell()

    agg.jtl_byte_offset = new_offset
    return new_offset, changed


def parse_jtl_file(path: str | Path) -> MetricsAggregator:
    """Parse a full JTL file with CSV-aware parsing (handles multiline response bodies)."""
    agg = MetricsAggregator(test_run_id=0, start_wall_time=time.time())
    append_jtl_file(agg, path, 0)
    return agg
