"""Tests for ``app.tools.pdf_tools.extract_pdf``.

Covers:
  - Error cases: missing file, path traversal, missing pdfplumber
  - Chunked extraction via ``start_page`` / ``end_page`` parameters
  - Default behavior (full document) when no page range is given
  - Result schema: ``pages`` / ``total_pages`` / ``extracted_pages`` / ``range``
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any
from unittest.mock import patch

from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.tools.pdf_tools import extract_pdf


def _make_tool_ctx(run_ctx: RunContext) -> ToolContext:
    return ToolContext(
        context=run_ctx,
        tool_name="extract_pdf",
        tool_call_id="test_call",
        tool_arguments="{}",
    )


def _call_extract(run_ctx: RunContext, **kwargs: Any) -> str:
    ctx = _make_tool_ctx(run_ctx)
    return asyncio.run(extract_pdf.on_invoke_tool(ctx, json.dumps(kwargs)))


class _FakePage:
    def __init__(self, page_number: int) -> None:
        self._page_number = page_number

    def extract_text(self) -> str:
        return f"Page {self._page_number} text"

    def extract_tables(self) -> list[Any]:
        # Return a simple table on page 1 only.
        if self._page_number == 1:
            return [
                [
                    ["gene", "value"],
                    ["BRCA1", "5.2"],
                    ["TP53", "12.1"],
                ]
            ]
        return []


class _FakePdf:
    def __init__(self, total_pages: int) -> None:
        self.pages = [_FakePage(i + 1) for i in range(total_pages)]

    def __enter__(self) -> _FakePdf:
        return self

    def __exit__(self, *args: Any) -> None:
        pass


# ── Error cases ───────────────────────────────────────────────────────


def test_extract_pdf_missing_file(tmp_path: Path) -> None:
    rc = RunContext(task_id="task_pdf_missing", base_dir=str(tmp_path / "tasks"))
    result = _call_extract(rc, input_relative_path="source_assets/nope.pdf")
    assert "不存在" in result


def test_extract_pdf_path_traversal(tmp_path: Path) -> None:
    rc = RunContext(task_id="task_pdf_traversal", base_dir=str(tmp_path / "tasks"))
    # Create a file outside the task dir that we try to reach via ../
    outside = tmp_path / "outside.pdf"
    outside.write_bytes(b"%PDF-1.4")
    result = _call_extract(rc, input_relative_path="../outside.pdf")
    assert "路径错误" in result


# ── Chunked extraction ───────────────────────────────────────────────


def test_extract_pdf_full_document_when_no_range(tmp_path: Path) -> None:
    """Default call (no start_page/end_page) extracts all pages."""
    rc = RunContext(
        task_id="task_pdf_full", base_dir=str(tmp_path / "tasks")
    )
    pdf_path = rc.work_dir.source_asset_file("doc.pdf")
    pdf_path.write_bytes(b"%PDF-1.4 fake")

    with patch("pdfplumber.open", return_value=_FakePdf(total_pages=5)):
        result = _call_extract(rc, input_relative_path="source_assets/doc.pdf")
    payload = json.loads(result)
    assert payload["total_pages"] == 5
    assert payload["extracted_pages"] == 5
    assert len(payload["pages"]) == 5
    assert payload["range"] == [1, 5]
    # Page 1 should have a table.
    assert len(payload["pages"][0]["tables"]) == 2  # 2 data rows
    # Other pages have no tables.
    assert payload["pages"][1]["tables"] == []


def test_extract_pdf_chunked_first_two_pages(tmp_path: Path) -> None:
    """Extracting pages 1-2 returns only 2 pages but reports total_pages=10."""
    rc = RunContext(
        task_id="task_pdf_chunk1", base_dir=str(tmp_path / "tasks")
    )
    pdf_path = rc.work_dir.source_asset_file("long.pdf")
    pdf_path.write_bytes(b"%PDF-1.4 fake")

    with patch("pdfplumber.open", return_value=_FakePdf(total_pages=10)):
        result = _call_extract(
            rc,
            input_relative_path="source_assets/long.pdf",
            start_page=1,
            end_page=2,
        )
    payload = json.loads(result)
    assert payload["total_pages"] == 10
    assert payload["extracted_pages"] == 2
    assert len(payload["pages"]) == 2
    assert payload["pages"][0]["page_number"] == 1
    assert payload["pages"][1]["page_number"] == 2
    assert payload["range"] == [1, 2]


def test_extract_pdf_chunked_middle_pages(tmp_path: Path) -> None:
    """Extracting pages 3-5 of a 10-page PDF returns only those pages."""
    rc = RunContext(
        task_id="task_pdf_chunk2", base_dir=str(tmp_path / "tasks")
    )
    pdf_path = rc.work_dir.source_asset_file("long.pdf")
    pdf_path.write_bytes(b"%PDF-1.4 fake")

    with patch("pdfplumber.open", return_value=_FakePdf(total_pages=10)):
        result = _call_extract(
            rc,
            input_relative_path="source_assets/long.pdf",
            start_page=3,
            end_page=5,
        )
    payload = json.loads(result)
    assert payload["total_pages"] == 10
    assert payload["extracted_pages"] == 3
    assert [p["page_number"] for p in payload["pages"]] == [3, 4, 5]
    assert payload["range"] == [3, 5]


def test_extract_pdf_end_page_clamped_to_total(tmp_path: Path) -> None:
    """end_page beyond total_pages is clamped to total_pages."""
    rc = RunContext(
        task_id="task_pdf_clamp", base_dir=str(tmp_path / "tasks")
    )
    pdf_path = rc.work_dir.source_asset_file("short.pdf")
    pdf_path.write_bytes(b"%PDF-1.4 fake")

    with patch("pdfplumber.open", return_value=_FakePdf(total_pages=4)):
        result = _call_extract(
            rc,
            input_relative_path="source_assets/short.pdf",
            start_page=2,
            end_page=99,  # beyond total
        )
    payload = json.loads(result)
    assert payload["total_pages"] == 4
    assert payload["extracted_pages"] == 3  # pages 2, 3, 4
    assert [p["page_number"] for p in payload["pages"]] == [2, 3, 4]
    # range reports requested end (99) — not clamped — so the LLM can detect
    # it requested beyond total. The actual returned pages are clamped.
    assert payload["range"] == [2, 99]


def test_extract_pdf_start_page_below_one_normalized(tmp_path: Path) -> None:
    """start_page < 1 is normalized to 1."""
    rc = RunContext(
        task_id="task_pdf_start", base_dir=str(tmp_path / "tasks")
    )
    pdf_path = rc.work_dir.source_asset_file("doc.pdf")
    pdf_path.write_bytes(b"%PDF-1.4 fake")

    with patch("pdfplumber.open", return_value=_FakePdf(total_pages=3)):
        result = _call_extract(
            rc,
            input_relative_path="source_assets/doc.pdf",
            start_page=0,
            end_page=2,
        )
    payload = json.loads(result)
    assert payload["extracted_pages"] == 2
    assert [p["page_number"] for p in payload["pages"]] == [1, 2]
