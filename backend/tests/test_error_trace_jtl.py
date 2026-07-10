"""Tests for error trace JTL matching and JMX preparation."""

import tempfile
from pathlib import Path

from app.services.jmeter_jmx import ERROR_TRACE_JTL_NAME, prepare_jmx_with_error_trace
from app.services.jtl_parser import Sample, find_matching_trace_sample, get_error_detail_with_trace

MINIMAL_JMX = """<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="Test Plan" enabled="true">
      <boolProp name="TestPlan.functional_mode">false</boolProp>
      <boolProp name="TestPlan.serialize_threadgroups">false</boolProp>
    </TestPlan>
    <hashTree>
      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="TG" enabled="true">
        <stringProp name="ThreadGroup.num_threads">1</stringProp>
      </ThreadGroup>
      <hashTree/>
    </hashTree>
  </hashTree>
</jmeterTestPlan>
"""

TRACE_XML = """<?xml version="1.0" encoding="UTF-8"?>
<testResults version="1.2">
  <httpSample t="50" lt="0" ts="1000" s="false"
       lb="Login" rc="500" rm="Server Error"
       tn="TG 1-1" dt="text">
    <responseHeader class="java.lang.String">HTTP/1.1 500</responseHeader>
    <requestHeader class="java.lang.String">POST /login</requestHeader>
    <responseData class="java.lang.String">ERR body</responseData>
    <samplerData class="java.lang.String">req-body</samplerData>
    <url>http://x/login</url>
  </httpSample>
</testResults>
"""

TRACE_XML_CHILD = """<?xml version="1.0" encoding="UTF-8"?>
<testResults version="1.2">
  <sample t="50" lt="0" ts="2000" s="false"
       lb="Login Transaction" rc="500" rm="Number of samples in transaction : 1"
       tn="TG 1-2" dt="text">
    <httpSample t="45" lt="0" ts="2000" s="false"
         lb="GET /login" rc="500" rm="Server Error"
         tn="TG 1-2" dt="text">
      <responseData class="java.lang.String">Error HTML body</responseData>
      <url>http://x/login</url>
    </httpSample>
  </sample>
</testResults>
"""


def test_prepare_jmx_injects_error_trace_listener():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        source = root / "scenario.jmx"
        source.write_text(MINIMAL_JMX, encoding="utf-8")
        prepared, error_jtl = prepare_jmx_with_error_trace(source, root / "run")
        assert prepared.is_file()
        assert error_jtl.name == ERROR_TRACE_JTL_NAME
        content = prepared.read_text(encoding="utf-8")
        assert "JmeterAgent Error Trace" in content
        assert "ResultCollector.error_logging" in content
        assert "ResultCollector.success_only_logging" in content
        assert "<subresults>true</subresults>" in content
        assert "<responseDataOnError>true</responseDataOnError>" in content
        assert "<xml>true</xml>" in content
        assert error_jtl.resolve().as_posix() in content
        assert content.count("responseHeaders") >= 1


def test_get_error_detail_prefers_errors_trace_jtl():
    header = (
        "timeStamp,elapsed,label,responseCode,responseMessage,threadName,"
        "dataType,success,failureMessage,bytes,sentBytes,grpThreads,allThreads,"
        "URL,Latency,IdleTime,Connect\n"
    )
    main_row = "1000,50,Login,500,Server Error,TG 1-1,text,false,assert failed,0,0,1,1,http://x/login,0,0,0\n"

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        main_jtl = root / "results.jtl"
        trace_jtl = root / "errors-trace.jtl"
        main_jtl.write_text(header + main_row, encoding="utf-8")
        trace_jtl.write_text(TRACE_XML, encoding="utf-8")

        detail = get_error_detail_with_trace(main_jtl, trace_jtl, 0)
        assert detail is not None
        assert detail.from_errors_trace is True
        assert detail.response_body == "ERR body"
        assert detail.request_body == "req-body"
        assert "500" in (detail.response_headers or "")


def test_find_matching_trace_sample_xml():
    ref = Sample(
        sample_index=3,
        timestamp_ms=2000,
        elapsed_ms=1,
        label="GET /api",
        response_code="404",
        response_message="Not Found",
        thread_name="TG 1-2",
        success=False,
        failure_message="",
    )
    header = (
        "timeStamp,elapsed,label,responseCode,responseMessage,threadName,"
        "dataType,success,failureMessage\n"
    )
    row = "2000,10,GET /api,404,Not Found,TG 1-2,text,false,\n"
    xml = """<?xml version="1.0" encoding="UTF-8"?>
<testResults version="1.2">
  <httpSample t="10" ts="2000" s="false" lb="GET /api" rc="404" rm="Not Found" tn="TG 1-2"/>
</testResults>
"""

    with tempfile.TemporaryDirectory() as tmp:
        trace_jtl = Path(tmp) / "errors-trace.jtl"
        trace_jtl.write_text(xml, encoding="utf-8")
        match = find_matching_trace_sample(trace_jtl, ref)
        assert match is not None
        assert match.label == "GET /api"


def test_find_matching_trace_sample_falls_back_to_child_with_body():
    ref = Sample(
        sample_index=1,
        timestamp_ms=2000,
        elapsed_ms=50,
        label="Login Transaction",
        response_code="500",
        response_message="Number of samples in transaction : 1",
        thread_name="TG 1-2",
        success=False,
        failure_message="failed",
    )

    with tempfile.TemporaryDirectory() as tmp:
        trace_jtl = Path(tmp) / "errors-trace.jtl"
        trace_jtl.write_text(TRACE_XML_CHILD, encoding="utf-8")
        match = find_matching_trace_sample(trace_jtl, ref)
        assert match is not None
        assert match.response_data == "Error HTML body"
