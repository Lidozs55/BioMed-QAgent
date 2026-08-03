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
from app.tools.workdir import create_task_workdir


def _make_ctx(
    task_id: str = "test_extract",
    tmp_path: Path | None = None,
) -> ToolContext:
    rc = RunContext(task_id=task_id)
    if tmp_path is not None:
        rc._work_dir = create_task_workdir(task_id, base_dir=str(tmp_path))
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


def _task_file(
    tmp_path: Path,
    task_id: str,
    filename: str,
    content: bytes,
) -> tuple[ToolContext, Path]:
    ctx = _make_ctx(task_id=task_id, tmp_path=tmp_path)
    run_ctx: RunContext = ctx.context
    path = run_ctx.work_dir.source_asset_file(filename)
    path.write_bytes(content)
    return ctx, path


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
    ctx, txt_file = _task_file(
        tmp_path, "test_extract_non_pdf", "data.txt", b"not a pdf"
    )
    args = json.dumps({"file_path": str(txt_file)})
    data = json.loads(asyncio.run(extract_pdf_tables.on_invoke_tool(ctx, args)))
    assert data["status"] == "error"
    assert "不支持" in data["error"] or "pdf" in data["error"].lower()


def test_extract_tables_rejects_pdf_outside_task_workdir(tmp_path: Path) -> None:
    """Table extraction must not open a task-external PDF."""
    external_pdf = tmp_path / "outside.pdf"
    external_pdf.write_bytes(b"%PDF-1.4 external")
    ctx = _make_ctx(task_id="test_extract_boundary", tmp_path=tmp_path)

    with patch(
        "app.skills.builtin.processing.extract_tables._extract_raw_tables"
    ) as extract:
        args = json.dumps({"file_path": str(external_pdf)})
        data = json.loads(
            asyncio.run(extract_pdf_tables.on_invoke_tool(ctx, args))
        )

    assert data["status"] == "error"
    assert "task" in data["error"].lower()
    extract.assert_not_called()


def test_extract_tables_extraction_failure(tmp_path: Path) -> None:
    """extract_pdf_tables returns error JSON when extraction raises."""
    ctx, pdf_file = _task_file(
        tmp_path, "test_extract_fail", "test.pdf", b"%PDF-1.4 fake pdf"
    )
    with patch(
        "app.skills.builtin.processing.extract_tables._extract_raw_tables",
        side_effect=RuntimeError("pdfplumber failed"),
    ):
        args = json.dumps({"file_path": str(pdf_file)})
        data = json.loads(asyncio.run(extract_pdf_tables.on_invoke_tool(ctx, args)))
    assert data["status"] == "error"
    assert "失败" in data["error"] or "pdfplumber" in data["error"]


def test_extract_tables_no_tables_found(tmp_path: Path) -> None:
    """extract_pdf_tables returns ok with empty outputs when no tables found."""
    ctx, pdf_file = _task_file(
        tmp_path, "test_extract_empty", "empty.pdf", b"%PDF-1.4 fake pdf"
    )
    with patch(
        "app.skills.builtin.processing.extract_tables._extract_raw_tables",
        return_value=([], None),
    ):
        args = json.dumps({"file_path": str(pdf_file)})
        data = json.loads(asyncio.run(extract_pdf_tables.on_invoke_tool(ctx, args)))
    assert data["status"] == "ok"
    assert data["outputs"] == []
    assert data["summary"]["total_tables"] == 0


def test_extract_tables_success(tmp_path: Path) -> None:
    """extract_pdf_tables saves CSVs and registers parsed_datasets on success."""
    ctx, pdf_file = _task_file(
        tmp_path, "test_extract_ok", "paper.pdf", b"%PDF-1.4 fake pdf"
    )
    mock_tables = [
        {"header": ["Gene", "FC"], "rows": [["BRCA1", "1.5"], ["TP53", "2.0"]], "page": 1},
    ]
    with patch(
        "app.skills.builtin.processing.extract_tables._extract_raw_tables",
        return_value=(mock_tables, None),
    ):
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
    ctx, txt_file = _task_file(
        tmp_path, "test_metadata_non_pdf", "data.txt", b"not a pdf"
    )
    ctx.tool_name = "extract_pdf_metadata"
    args = json.dumps({"file_path": str(txt_file)})
    data = json.loads(asyncio.run(extract_pdf_metadata.on_invoke_tool(ctx, args)))
    assert data["status"] == "error"
    assert "不支持" in data["error"] or "pdf" in data["error"].lower()


def test_extract_metadata_rejects_pdf_outside_task_workdir(tmp_path: Path) -> None:
    """Metadata extraction must not open a task-external PDF."""
    external_pdf = tmp_path / "outside-meta.pdf"
    external_pdf.write_bytes(b"%PDF-1.4 external")
    ctx = _make_ctx(task_id="test_metadata_boundary", tmp_path=tmp_path)

    with patch(
        "app.skills.builtin.processing.extract_tables._extract_text_for_metadata"
    ) as extract:
        ctx.tool_name = "extract_pdf_metadata"
        args = json.dumps({"file_path": str(external_pdf)})
        data = json.loads(
            asyncio.run(extract_pdf_metadata.on_invoke_tool(ctx, args))
        )

    assert data["status"] == "error"
    assert "task" in data["error"].lower()
    extract.assert_not_called()


def test_extract_metadata_success(tmp_path: Path) -> None:
    """extract_pdf_metadata returns metadata JSON on success."""
    ctx, pdf_file = _task_file(
        tmp_path, "test_meta_ok", "paper.pdf", b"%PDF-1.4 fake pdf"
    )
    ctx.tool_name = "extract_pdf_metadata"
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
        args = json.dumps({"file_path": str(pdf_file)})
        data = json.loads(asyncio.run(extract_pdf_metadata.on_invoke_tool(ctx, args)))

    assert data["status"] == "ok"
    assert "summary" in data
    summary = data["summary"]
    assert "title" in summary
    assert "authors" in summary
    assert "doi" in summary
    assert "abstract" in summary
    assert summary["num_pages"] == 5
