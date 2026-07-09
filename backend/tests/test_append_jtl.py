"""Tests for incremental JTL tail parsing."""

import tempfile
from pathlib import Path

from app.services.jtl_parser import MetricsAggregator, append_jtl_file


def test_append_jtl_file_reads_only_new_bytes():
    header = (
        "timeStamp,elapsed,label,responseCode,responseMessage,threadName,"
        "dataType,success,failureMessage,bytes,sentBytes,grpThreads,allThreads,URL\n"
    )
    row1 = "1000,100,GET /a,200,OK,TG 1-1,text,true,,0,0,1,1,http://example.com/a\n"
    row2 = "2000,120,GET /b,200,OK,TG 1-2,text,true,,0,0,1,2,http://example.com/b\n"

    with tempfile.TemporaryDirectory() as tmp:
        jtl = Path(tmp) / "results.jtl"
        jtl.write_text(header + row1, encoding="utf-8")

        agg = MetricsAggregator(test_run_id=1)
        offset, changed = append_jtl_file(agg, jtl, 0)
        assert changed is True
        assert len(agg.samples) == 1
        assert agg.samples[0].label == "GET /a"

        jtl.write_text(header + row1 + row2, encoding="utf-8")
        offset2, changed2 = append_jtl_file(agg, jtl, offset)
        assert changed2 is True
        assert len(agg.samples) == 2
        assert agg.samples[1].label == "GET /b"
        assert offset2 > offset
