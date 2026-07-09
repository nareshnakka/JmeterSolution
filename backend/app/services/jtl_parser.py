"""Parse JMeter CSV JTL samples and aggregate live metrics."""

from __future__ import annotations

import csv
import io
import statistics
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.schemas import ErrorDetailOut, ErrorSample, LiveMetricsSnapshot, TransactionMetric
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
    _header_map: dict[str, int] = field(default_factory=_default_header_map)

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
        if len(self.samples) == 1:
            self.start_wall_time = sample.timestamp_ms / 1000.0
        self._last_all_threads = max(self._last_all_threads, sample.all_threads)
        self._update_buckets(sample)
        if not sample.success:
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
        if sample.success:
            self._throughput_by_timeline_bucket[timeline_bucket] = (
                self._throughput_by_timeline_bucket.get(timeline_bucket, 0) + 1
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

    def _timeline_max_bucket(self) -> int:
        buckets: list[int] = []
        if self._users_by_timeline_bucket:
            buckets.append(max(self._users_by_timeline_bucket))
        if self._throughput_by_timeline_bucket:
            buckets.append(max(self._throughput_by_timeline_bucket))
        if not buckets:
            return 0
        max_bucket = max(buckets)
        if self.status == TestRunStatus.RUNNING:
            current = int(self._elapsed_seconds() // self.timeline_bucket_seconds)
            max_bucket = max(max_bucket, current)
        return max_bucket

    def _filled_active_users_series(self) -> list[dict[str, Any]]:
        """BlazeMeter-style virtual users: max concurrent users per 1s bucket, step-held."""
        if not self._users_by_timeline_bucket:
            return []

        max_bucket = self._timeline_max_bucket()
        result: list[dict[str, Any]] = []
        last_users = 0
        for bucket in range(0, max_bucket + 1):
            if bucket in self._users_by_timeline_bucket:
                last_users = self._users_by_timeline_bucket[bucket]
            result.append({"t": self._timeline_time(bucket), "users": last_users})
        return result

    def _filled_throughput_series(self) -> list[dict[str, Any]]:
        """Hits per second per timeline bucket (successful samples)."""
        if not self._throughput_by_timeline_bucket and not self.samples:
            return []

        max_bucket = self._timeline_max_bucket()
        result: list[dict[str, Any]] = []
        for bucket in range(0, max_bucket + 1):
            count = self._throughput_by_timeline_bucket.get(bucket, 0)
            hits_per_sec = round(count / self.timeline_bucket_seconds, 2)
            result.append({"t": self._timeline_time(bucket), "hits_per_sec": hits_per_sec})
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
        if not self.samples:
            return 0.001
        if self.status == TestRunStatus.RUNNING:
            return max(time.time() - self.start_wall_time, 0.001)
        last_ts = max(s.timestamp_ms for s in self.samples) / 1000.0
        return max(last_ts - self.start_wall_time, 0.001)

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
        return results

    def snapshot(self) -> LiveMetricsSnapshot:
        elapsed = self._elapsed_seconds()
        total_errors = sum(1 for s in self.samples if not s.success)
        return LiveMetricsSnapshot(
            test_run_id=self.test_run_id,
            status=self.status,
            active_threads=self._last_all_threads,
            elapsed_seconds=round(elapsed, 1),
            total_samples=len(self.samples),
            total_errors=total_errors,
            transactions=self.transaction_metrics(),
            errors=self.errors[-50:],
            active_users_series=self._filled_active_users_series(),
            throughput_series=self._filled_throughput_series(),
        )

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
                vals = b["elapsed"]
                points.append({"t": b["t"], "avg_ms": round(statistics.mean(vals), 2) if vals else 0})
            series.append({"label": label, "points": points})

        if cumulative and len(series) > 1:
            by_t: dict[float, list[float]] = defaultdict(list)
            for s in series:
                for p in s["points"]:
                    by_t[p["t"]].append(p["avg_ms"])
            merged = [{"t": t, "avg_ms": round(statistics.mean(v), 2)} for t, v in sorted(by_t.items())]
            return {"mode": "cumulative", "series": [{"label": "ALL", "points": merged}]}

        return {"mode": "individual", "series": series}

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
            max_bucket = max(by_bucket)
            return [
                {"t": self._bucket_time(b), "errors": by_bucket.get(b, 0)}
                for b in range(max_bucket + 1)
            ]

        if labels is None or "ALL" in labels:
            return {
                "mode": "all",
                "series": [{"label": "ALL", "points": _interval_points(self.all_error_series)}],
            }

        target_labels = labels or []
        series: list[dict[str, Any]] = []
        for label in target_labels:
            points = _interval_points(self.label_error_series.get(label, []))
            series.append({"label": label, "points": points})

        return {"mode": "individual", "series": series}

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
            success=_col(row, header, "success", "false").lower() == "true",
            failure_message=_col(row, header, "failureMessage"),
            all_threads=all_threads,
            url=_col(row, header, "URL"),
            data_type=_col(row, header, "dataType"),
            sample_type=_col(row, header, "sampleType"),
            response_data=_col(row, header, "responseData"),
            response_headers=_col(row, header, "responseHeaders"),
            request_headers=_col(row, header, "requestHeaders"),
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


def sample_to_error_detail(sample: Sample) -> ErrorDetailOut:
    body = sample.response_data.strip() if sample.response_data else None
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
    )


def get_error_detail_from_jtl(path: str | Path, sample_index: int) -> ErrorDetailOut | None:
    sample = get_sample_from_jtl(path, sample_index)
    if sample is None or sample.success:
        return None
    return sample_to_error_detail(sample)


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


def parse_jtl_file(path: str | Path) -> MetricsAggregator:
    """Parse a JTL file with CSV-aware parsing (handles multiline response bodies)."""
    agg = MetricsAggregator(test_run_id=0, start_wall_time=time.time())
    jtl = Path(path)
    if not jtl.is_file():
        return agg
    with open(jtl, encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        try:
            header_row = next(reader)
        except StopIteration:
            return agg
        agg._header_map = {name.strip(): index for index, name in enumerate(header_row)}
        for idx, row in enumerate(reader):
            sample = _sample_from_row(row, agg._header_map, idx)
            if sample is not None:
                agg._ingest_sample(sample)
    return agg
