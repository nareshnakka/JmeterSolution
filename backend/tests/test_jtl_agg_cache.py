"""Tests for single-flight LRU JTL aggregator cache."""

import threading
import time
from pathlib import Path

from app.services.jtl_agg_cache import JtlAggCache


def test_get_or_load_caches_by_fingerprint(tmp_path: Path):
    jtl = tmp_path / "results.jtl"
    jtl.write_text("a", encoding="utf-8")
    cache = JtlAggCache(max_entries=4)
    calls = {"n": 0}

    def loader():
        calls["n"] += 1
        return {"samples": [1, 2, 3]}

    a = cache.get_or_load(1, jtl, loader)
    b = cache.get_or_load(1, jtl, loader)
    assert a is b
    assert calls["n"] == 1


def test_get_or_load_single_flight(tmp_path: Path):
    jtl = tmp_path / "results.jtl"
    jtl.write_text("a", encoding="utf-8")
    cache = JtlAggCache(max_entries=4)
    calls = {"n": 0}
    started = threading.Event()
    release = threading.Event()

    def loader():
        calls["n"] += 1
        started.set()
        release.wait(timeout=5)
        return {"ok": True}

    results: list[object] = []

    def worker():
        results.append(cache.get_or_load(7, jtl, loader))

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    assert started.wait(timeout=2)
    time.sleep(0.05)
    release.set()
    for t in threads:
        t.join(timeout=5)

    assert calls["n"] == 1
    assert len(results) == 8
    assert all(r is results[0] for r in results)


def test_lru_eviction(tmp_path: Path):
    cache = JtlAggCache(max_entries=2)
    files = []
    for i in range(3):
        p = tmp_path / f"r{i}.jtl"
        p.write_text(str(i), encoding="utf-8")
        files.append(p)
        cache.get_or_load(i, p, lambda i=i: {"id": i})

    # run 0 should be evicted
    assert cache.get(0, cache._fingerprint(files[0])) is None
    assert cache.get(1, cache._fingerprint(files[1])) is not None
    assert cache.get(2, cache._fingerprint(files[2])) is not None


def test_put_warms_cache(tmp_path: Path):
    jtl = tmp_path / "results.jtl"
    jtl.write_text("x", encoding="utf-8")
    cache = JtlAggCache(max_entries=4)
    warm = {"warm": True}
    cache.put(9, jtl, warm)
    calls = {"n": 0}

    def loader():
        calls["n"] += 1
        return {"cold": True}

    got = cache.get_or_load(9, jtl, loader)
    assert got is warm
    assert calls["n"] == 0
