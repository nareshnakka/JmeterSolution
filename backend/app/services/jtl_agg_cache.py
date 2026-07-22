"""Thread-safe single-flight LRU cache for parsed completed-run JTL aggregators.

Parallel report tabs (metrics / errors / graphs / compare) share one parse per run
fingerprint so idle-mode report generation stays fast under multi-page load.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from concurrent.futures import Future
from pathlib import Path
from typing import Any, Callable

# Keep enough warm reports for several parallel browser tabs without unbounded RAM.
DEFAULT_MAX_ENTRIES = 24
# Cap concurrent full JTL parses so the thread pool stays free for other HTTP work
# (parallel tabs wait on single-flight / this semaphore instead of timing out).
DEFAULT_MAX_CONCURRENT_PARSES = 2


class JtlAggCache:
    def __init__(
        self,
        max_entries: int = DEFAULT_MAX_ENTRIES,
        max_concurrent_parses: int = DEFAULT_MAX_CONCURRENT_PARSES,
    ) -> None:
        self._max_entries = max(1, max_entries)
        self._lock = threading.Lock()
        self._cache: OrderedDict[int, tuple[int, int, Any]] = OrderedDict()
        self._inflight: dict[int, Future[Any]] = {}
        self._parse_slots = threading.Semaphore(max(1, max_concurrent_parses))

    def clear(self) -> None:
        with self._lock:
            self._cache.clear()

    def get(self, run_id: int, fingerprint: tuple[int, int]) -> Any | None:
        with self._lock:
            hit = self._cache.get(run_id)
            if not hit:
                return None
            if hit[0] != fingerprint[0] or hit[1] != fingerprint[1]:
                return None
            self._cache.move_to_end(run_id)
            return hit[2]

    def put(self, run_id: int, jtl: Path | str | None, agg: Any) -> None:
        """Warm or refresh cache (e.g. right after a run finishes)."""
        fingerprint = self._fingerprint(jtl)
        with self._lock:
            self._cache[run_id] = (fingerprint[0], fingerprint[1], agg)
            self._cache.move_to_end(run_id)
            self._evict_locked()

    def get_or_load(
        self,
        run_id: int,
        jtl: Path | str,
        loader: Callable[[], Any],
    ) -> Any:
        """Return cached aggregator or load once; concurrent callers wait on the leader."""
        path = Path(jtl)
        fingerprint = self._fingerprint(path)

        with self._lock:
            hit = self._cache.get(run_id)
            if hit and hit[0] == fingerprint[0] and hit[1] == fingerprint[1]:
                self._cache.move_to_end(run_id)
                return hit[2]

            existing = self._inflight.get(run_id)
            if existing is not None:
                fut = existing
                leader = False
            else:
                fut = Future()
                self._inflight[run_id] = fut
                leader = True

        if not leader:
            return fut.result(timeout=600)

        try:
            with self._parse_slots:
                agg = loader()
            with self._lock:
                self._cache[run_id] = (fingerprint[0], fingerprint[1], agg)
                self._cache.move_to_end(run_id)
                self._evict_locked()
            fut.set_result(agg)
            return agg
        except Exception as exc:
            if not fut.done():
                fut.set_exception(exc)
            raise
        finally:
            with self._lock:
                if self._inflight.get(run_id) is fut:
                    del self._inflight[run_id]

    def _evict_locked(self) -> None:
        while len(self._cache) > self._max_entries:
            self._cache.popitem(last=False)

    @staticmethod
    def _fingerprint(jtl: Path | str | None) -> tuple[int, int]:
        if not jtl:
            return (0, 0)
        path = Path(jtl)
        if not path.is_file():
            return (0, 0)
        st = path.stat()
        return (st.st_mtime_ns, st.st_size)


jtl_agg_cache = JtlAggCache()
