"""Prepare JMeter JMX with an error-only trace listener (full request/response JTL)."""

from __future__ import annotations

import shutil
import xml.etree.ElementTree as ET
from pathlib import Path

ERROR_TRACE_JTL_NAME = "errors-trace.jtl"
PREPARED_JMX_NAME = "run-scenario.jmx"


def _bool_prop(name: str, value: bool) -> ET.Element:
    elem = ET.Element("boolProp", {"name": name})
    elem.text = "true" if value else "false"
    return elem


def _string_prop(name: str, value: str) -> ET.Element:
    elem = ET.Element("stringProp", {"name": name})
    elem.text = value
    return elem


def _save_config_element() -> ET.Element:
    """SampleSaveConfiguration with full error trace fields."""
    obj = ET.Element("objProp")
    ET.SubElement(obj, "name").text = "saveConfig"
    value = ET.SubElement(obj, "value", {"class": "SampleSaveConfiguration"})
    flags = {
        "time": True,
        "latency": True,
        "timestamp": True,
        "success": True,
        "label": True,
        "code": True,
        "message": True,
        "threadName": True,
        "dataType": True,
        "encoding": False,
        "assertions": True,
        "subresults": True,
        "responseData": True,
        "samplerData": True,
        # CSV JTL cannot store bodies/headers (line breaks). Error trace must be XML.
        "xml": True,
        "fieldNames": True,
        "responseHeaders": True,
        "requestHeaders": True,
        "responseDataOnError": True,
        "saveAssertionResultsFailureMessage": True,
        "assertionsResultsToSave": "0",
        "bytes": True,
        "sentBytes": True,
        "url": True,
        "fileName": False,
        "hostname": False,
        "threadCounts": True,
        "sampleCount": False,
        "idleTime": True,
        "connectTime": True,
    }
    for key, enabled in flags.items():
        child = ET.SubElement(value, key)
        if isinstance(enabled, bool):
            child.text = "true" if enabled else "false"
        else:
            child.text = str(enabled)
    return obj


def _error_trace_listener(error_jtl: Path) -> ET.Element:
    collector = ET.Element(
        "ResultCollector",
        {
            "guiclass": "SimpleDataWriter",
            "testclass": "ResultCollector",
            "testname": "JmeterAgent Error Trace",
            "enabled": "true",
        },
    )
    collector.append(_bool_prop("ResultCollector.error_logging", True))
    collector.append(_bool_prop("ResultCollector.success_only_logging", False))
    collector.append(_save_config_element())
    collector.append(_string_prop("filename", error_jtl.resolve().as_posix()))
    return collector


def _find_test_plan_child_hashtree(root: ET.Element) -> ET.Element | None:
    outer = root.find("hashTree")
    if outer is None:
        return None
    children = list(outer)
    for index, child in enumerate(children):
        if child.tag == "TestPlan" and index + 1 < len(children):
            sibling = children[index + 1]
            if sibling.tag == "hashTree":
                return sibling
    return None


def prepare_jmx_with_error_trace(source_jmx: Path, run_dir: Path) -> tuple[Path, Path]:
    """
    Copy the scenario JMX into the run directory and inject an error-only ResultCollector.

    Returns (prepared_jmx_path, error_trace_jtl_path).
    """
    run_dir.mkdir(parents=True, exist_ok=True)
    dest_jmx = run_dir / PREPARED_JMX_NAME
    error_jtl = run_dir / ERROR_TRACE_JTL_NAME

    shutil.copy2(source_jmx, dest_jmx)

    tree = ET.parse(dest_jmx)
    root = tree.getroot()
    target_hashtree = _find_test_plan_child_hashtree(root)
    if target_hashtree is None:
        raise ValueError("Could not locate Test Plan hashTree in JMX for error trace listener")

    target_hashtree.append(_error_trace_listener(error_jtl))
    target_hashtree.append(ET.Element("hashTree"))

    tree.write(dest_jmx, encoding="UTF-8", xml_declaration=True)
    return dest_jmx, error_jtl
