"""Tests for the pdf_extraction skill — extract_pdf_tables and extract_pdf_metadata."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any
from unittest.mock import patch

from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills.builtin.processing.extract_tables import (
    extract_pdf_metadata,
    extract_pdf_tables,
)


def _make_ctx(task_id: str = "test_extract") -> ToolContext:
    rc = RunContext(task_id=task_id)
    return ToolContext(
        context=rc,
        tool_name="extract_pdf_tables",
        tool_call_id="test_call_1",
        tool_arguments="{}",
    )


def _call_tables(file_path: str, task_id: str = "test_extract") -> dict[str, Any]:
    ctx = _make_ctx(task_id=task_id)
    args = json.dumps({"file_path": file_path})
    result = asyncio.run(extract_pdf_tables.on_invoke_tool(ctx, args))
    return json.loads(result)


def _call_metadata(file_path: str, task_id: str = "test_extract_meta") -> dict[str, Any]:
    ctx = _make_ctx(task_id=task_id)
    ctx.tool_name = "extract_pdf_metadata"
    args = json.dumps({"file_path": file_path})
    result = asyncio.run(extract_pdf_metadata.on_invoke_tool(ctx, args))
    return json.loads(result)


# ---------------------------------------------------------------------------
# extract_pdf_tables — error cases
# ---------------------------------------------------------------------------


def test_extract_tables_file_not_found() -> None:
    """extract_pdf_tables returns error JSON when file doesn't exist."""
    data = _call_tables("nonexistent.pdf")
    assert data["status"] == "error"
    assert "不存在" in data["error"]
    assert data["source_file"] == "nonexistent.pdf"


def test_extract_tables_non_pdf_file(tmp_path: Path) -> None:
    """extract_pdf_tables returns error JSON for non-PDF files."""
    txt_file = tmp_path / "data.txt"
    txt_file.write_text("not a pdf", encoding="utf-8")
    data = _call_tables(str(txt_file))
    assert data["status"] == "error"
    assert "不支持" in data["error"] or "pdf" in data["error"].lower()


def test_extract_tables_extraction_failure(tmp_path: Path) -> None:
    """extract_pdf_tables returns error JSON when extraction raises."""
    pdf_file = tmp_path / "test.pdf"
    pdf_file.write_bytes(b"%PDF-1.4 fake pdf")
    with patch(
        "app.skills.builtin.processing.extract_tables._extract_raw_tables",
        side_effect=RuntimeError("pdfplumber failed"),
    ):
        data = _call_tables(str(pdf_file), task_id="test_extract_fail")
    assert data["status"] == "error"
    assert "失败" in data["error"] or "pdfplumber" in data["error"]


def test_extract_tables_no_tables_found(tmp_path: Path) -> None:
    """extract_pdf_tables returns ok with empty outputs when no tables found."""
    pdf_file = tmp_path / "empty.pdf"
    pdf_file.write_bytes(b"%PDF-1.4 fake pdf")
    with patch(
        "app.skills.builtin.processing.extract_tables._extract_raw_tables",
        return_value=([], None),
    ):
        data = _call_tables(str(pdf_file), task_id="test_extract_empty")
    assert data["status"] == "ok"
    assert data["outputs"] == []
    assert data["summary"]["total_tables"] == 0


def test_extract_tables_success(tmp_path: Path) -> None:
    """extract_pdf_tables saves CSVs and registers parsed_datasets on success."""
    pdf_file = tmp_path / "paper.pdf"
    pdf_file.write_bytes(b"%PDF-1.4 fake pdf")
    mock_tables = [
        {"header": ["Gene", "FC"], "rows": [["BRCA1", "1.5"], ["TP53", "2.0"]], "page": 1},
    ]
    with patch(
        "app.skills.builtin.processing.extract_tables._extract_raw_tables",
        return_value=(mock_tables, None),
    ):
        ctx = _make_ctx(task_id="test_extract_ok")
        args = json.dumps({"file_path": str(pdf_file)})
        result = asyncio.run(extract_pdf_tables.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["status"] == "ok"
    assert data["summary"]["total_tables"] == 1
    assert len(data["outputs"]) == 1
    assert data["outputs"][0].endswith("paper_table_1.csv")
    # parsed_datasets should be updated
    rc: RunContext = ctx.context
    assert len(rc.parsed_datasets) == 1


# ---------------------------------------------------------------------------
# extract_pdf_metadata — error cases
# ---------------------------------------------------------------------------


def test_extract_metadata_file_not_found() -> None:
    """extract_pdf_metadata returns error JSON when file doesn't exist."""
    data = _call_metadata("nonexistent.pdf")
    assert data["status"] == "error"
    assert "不存在" in data["error"]


def test_extract_metadata_non_pdf_file(tmp_path: Path) -> None:
    """extract_pdf_metadata returns error JSON for non-PDF files."""
    txt_file = tmp_path / "data.txt"
    txt_file.write_text("not a pdf", encoding="utf-8")
    data = _call_metadata(str(txt_file))
    assert data["status"] == "error"
    assert "不支持" in data["error"] or "pdf" in data["error"].lower()


def test_extract_metadata_success(tmp_path: Path) -> None:
    """extract_pdf_metadata returns metadata JSON on success."""
    pdf_file = tmp_path / "paper.pdf"
    pdf_file.write_bytes(b"%PDF-1.4 fake pdf")
    mock_text = (
        "Gene Expression Analysis in Cancer\n"
        "Smith, J., Doe, A.\n"
        "Abstract\n"
        "This study analyzes gene expression patterns in cancer tissues.\n"
        "DOI: 10.1234/test.5678\n"
        "Figure 1: Heatmap of top genes\n"
    )
    with patch(
        "app.skills.builtin.processing.extract_tables._extract_text_for_metadata",
        return_value=(mock_text, 5),
    ):
        data = _call_metadata(str(pdf_file), task_id="test_meta_ok")

    assert data["status"] == "ok"
    assert "summary" in data
    summary = data["summary"]
    assert "title" in summary
    assert "authors" in summary
    assert "doi" in summary
    assert "abstract" in summary
    assert summary["num_pages"] == 5
