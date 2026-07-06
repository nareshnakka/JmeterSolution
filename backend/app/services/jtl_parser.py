"""Parse JMeter CSV JTL samples and aggregate live metrics."""

from __future__ import annotations

import csv
import io
import statistics
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from app.schemas import ErrorSample, LiveMetricsSnapshot, TransactionMetric
from app.models import TestRunStatus


JTL_HEADER = (
    "timeStamp,elapsed,label,responseCode,responseMessage,threadName,"
    "dataType,success,failureMessage,bytes,sentBytes,grpThreads,allThreads,"
    "URL,Latency,IdleTime,Connect"
)


@dataclass
class Sample:
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


@dataclass
class MetricsAggregator:
    test_run_id: int
    bucket_seconds: int = 5
    start_wall_time: float = field(default_factory=time.time)

    samples: list[Sample] = field(default_factory=list)
    errors: list[ErrorSample] = field(default_factory=list)
    active_users_series: list[dict[str, Any]] = field(default_factory=list)
    label_time_series: dict[str, list[dict[str, Any]]] = field(default_factory=lambda: defaultdict(list))
    label_error_series: dict[str, list[dict[str, Any]]] = field(default_factory=lambda: defaultdict(list))
    all_error_series: list[dict[str, Any]] = field(default_factory=list)

    status: TestRunStatus = TestRunStatus.RUNNING
    _last_bucket: int = -1
    _last_all_threads: int = 0

    def ingest_line(self, line: str) -> None:
        line = line.strip()
        if not line or line.startswith("timeStamp"):
            return
        sample = _parse_jtl_line(line)
        if sample is None:
            return
        self.samples.append(sample)
        if len(self.samples) == 1:
            self.start_wall_time = sample.timestamp_ms / 1000.0
        self._last_all_threads = max(self._last_all_threads, sample.all_threads)
        self._update_buckets(sample)
        if not sample.success:
            self.errors.append(
                ErrorSample(
                    timestamp=sample.timestamp_ms,
                    label=sample.label,
                    response_code=sample.response_code,
                    response_message=sample.response_message,
                    failure_message=sample.failure_message,
                    thread_name=sample.thread_name,
                    url=sample.url,
                )
            )
        # Keep error list bounded for live feed
        if len(self.errors) > 500:
            self.errors = self.errors[-500:]

    def _update_buckets(self, sample: Sample) -> None:
        elapsed = (sample.timestamp_ms / 1000.0) - self.start_wall_time
        if elapsed < 0:
            elapsed = time.time() - self.start_wall_time
        bucket = int(elapsed // self.bucket_seconds)
        if bucket > self._last_bucket:
            self.active_users_series.append(
                {"t": round(elapsed, 1), "users": sample.all_threads}
            )
            self._last_bucket = bucket
        elif self.active_users_series:
            self.active_users_series[-1]["users"] = max(
                self.active_users_series[-1]["users"], sample.all_threads
            )

        # Per-label rolling avg in bucket
        series = self.label_time_series[sample.label]
        if not series or series[-1].get("bucket") != bucket:
            series.append({"bucket": bucket, "t": round(elapsed, 1), "elapsed": [sample.elapsed_ms]})
        else:
            series[-1]["elapsed"].append(sample.elapsed_ms)

        if not sample.success:
            err_label = self.label_error_series[sample.label]
            self._append_error_bucket(err_label, bucket, elapsed)
            self._append_error_bucket(self.all_error_series, bucket, elapsed)

    def _append_error_bucket(
        self, series: list[dict[str, Any]], bucket: int, elapsed: float
    ) -> None:
        for entry in series:
            if entry.get("bucket") == bucket:
                entry["errors"] += 1
                entry["t"] = round(elapsed, 1)
                return
        series.append({"bucket": bucket, "t": round(elapsed, 1), "errors": 1})

    def transaction_metrics(self, label_filter: str | None = None) -> list[TransactionMetric]:
        grouped: dict[str, list[Sample]] = defaultdict(list)
        for s in self.samples:
            if label_filter and label_filter not in s.label:
                continue
            grouped[s.label].append(s)

        results: list[TransactionMetric] = []
        elapsed_sec = max(time.time() - self.start_wall_time, 0.001)
        for label, items in sorted(grouped.items()):
            elapsed_vals = [i.elapsed_ms for i in items]
            errors = sum(1 for i in items if not i.success)
            n = len(items)
            sorted_vals = sorted(elapsed_vals)
            results.append(
                TransactionMetric(
                    label=label,
                    samples=n,
                    errors=errors,
                    error_pct=round(100.0 * errors / n, 2) if n else 0,
                    avg_ms=round(statistics.mean(elapsed_vals), 2) if n else 0,
                    min_ms=round(min(elapsed_vals), 2) if n else 0,
                    max_ms=round(max(elapsed_vals), 2) if n else 0,
                    median_ms=round(statistics.median(sorted_vals), 2) if n else 0,
                    p90_ms=round(_percentile(sorted_vals, 90), 2) if n else 0,
                    p95_ms=round(_percentile(sorted_vals, 95), 2) if n else 0,
                    throughput=round(n / elapsed_sec, 2),
                )
            )
        return results

    def snapshot(self) -> LiveMetricsSnapshot:
        elapsed = time.time() - self.start_wall_time
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
            active_users_series=self.active_users_series,
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
            # Merge by time bucket — average across labels at each t
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
        """Return cumulative error count over time for all or selected labels."""

        def _cumulative_points(buckets: list[dict[str, Any]]) -> list[dict[str, Any]]:
            by_bucket: dict[int, dict[str, Any]] = {}
            for bucket in buckets:
                num = bucket["bucket"]
                if num not in by_bucket:
                    by_bucket[num] = {"bucket": num, "t": bucket["t"], "errors": 0}
                by_bucket[num]["errors"] += bucket["errors"]
                by_bucket[num]["t"] = max(by_bucket[num]["t"], bucket["t"])

            running = 0
            points = []
            for num in sorted(by_bucket.keys()):
                running += by_bucket[num]["errors"]
                points.append({"t": by_bucket[num]["t"], "errors": running})
            return points

        if labels is None or "ALL" in labels:
            cumulative = True

        if cumulative:
            return {
                "mode": "cumulative",
                "series": [{"label": "ALL", "points": _cumulative_points(self.all_error_series)}],
            }

        target_labels = labels or []
        series: list[dict[str, Any]] = []
        for label in target_labels:
            points = _cumulative_points(self.label_error_series.get(label, []))
            series.append({"label": label, "points": points})

        return {"mode": "individual", "series": series}

    def search_errors(self, query: str | None = None, limit: int = 200) -> list[ErrorSample]:
        """Search all failed samples (full JTL), most recent first."""
        failed = [s for s in self.samples if not s.success]
        errors = [
            ErrorSample(
                timestamp=s.timestamp_ms,
                label=s.label,
                response_code=s.response_code,
                response_message=s.response_message,
                failure_message=s.failure_message,
                thread_name=s.thread_name,
                url=s.url,
            )
            for s in reversed(failed)
        ]
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


def _parse_jtl_line(line: str) -> Sample | None:
    try:
        reader = csv.reader(io.StringIO(line))
        row = next(reader)
        if len(row) < 13:
            return None
        return Sample(
            timestamp_ms=int(row[0]),
            elapsed_ms=float(row[1]),
            label=row[2],
            response_code=row[3],
            response_message=row[4],
            thread_name=row[5],
            success=row[7].lower() == "true",
            failure_message=row[8] if len(row) > 8 else "",
            all_threads=int(row[12]) if len(row) > 12 and row[12].isdigit() else 0,
            url=row[13] if len(row) > 13 else "",
        )
    except (ValueError, StopIteration):
        return None


def _percentile(sorted_vals: list[float], pct: float) -> float:
    if not sorted_vals:
        return 0.0
    k = (len(sorted_vals) - 1) * (pct / 100.0)
    f = int(k)
    c = min(f + 1, len(sorted_vals) - 1)
    if f == c:
        return sorted_vals[f]
    return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)


def parse_jtl_file(path: str) -> MetricsAggregator:
    """Parse a completed JTL file for comparison / post-run views."""
    agg = MetricsAggregator(test_run_id=0, start_wall_time=time.time())
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            agg.ingest_line(line)
    return agg
