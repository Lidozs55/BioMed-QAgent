"""Tests for the pdf_extraction skill — extract_pdf_tables and extract_pdf_metadata."""
from __future__ import annotations

import asyncio
import json
import zlib
from pathlib import Path
from typing import Any
from unittest.mock import patch

from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills.builtin.processing.extract_tables import (
    _extract_text_via_regex,
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


# ---------------------------------------------------------------------------
# P2-1 (TODO §2.7.3): regex fallback — CJK / UTF-16BE hex strings
# ---------------------------------------------------------------------------


FIXTURE_DIR = Path(__file__).parent / "fixtures" / "pdf"
MINIMAL_TABLE_PDF = FIXTURE_DIR / "minimal_table.pdf"
SCANNED_IMAGE_PDF = FIXTURE_DIR / "scanned_image.pdf"


CJK_TEXT = "基因表达分析"


def _pdf_blob(stream_contents: list[bytes]) -> bytes:
    """Assemble a PDF-stream bytes blob from FlateDecode-compressed contents."""
    def flate(data: bytes) -> bytes:
        return zlib.compress(data)

    streams = b"".join(
        b"<< /Filter /FlateDecode >>\r\nstream\r\n" + flate(c) + b"\r\nendstream"
        for c in stream_contents
    )
    return (
        b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n"
        + streams
        + b"\ntrailer\n<< >>\n%%EOF"
    )


def _cjk_hex_blob() -> bytes:
    """A blob whose only text-showing op is a UTF-16BE hex string ``<...> Tj``."""
    cjk_hex = CJK_TEXT.encode("utf-16-be").hex().upper().encode("ascii")
    return _pdf_blob([b"BT /F1 12 Tf 72 720 Td <" + cjk_hex + b"> Tj ET"])


def _cjk_literal_blob() -> bytes:
    """A blob whose only text-showing op is a UTF-8 CJK literal ``(...) Tj``."""
    return _pdf_blob([b"BT /F1 12 Tf 72 700 Td (" + CJK_TEXT.encode("utf-8") + b") Tj ET"])


def _cjk_pdf_blob() -> bytes:
    """Craft a PDF-stream bytes blob containing CJK content.

    Includes a UTF-16BE hex-string PDF string ``<...> Tj``, a CJK literal
    written as UTF-8 inside ``(...) Tj``, a tab-separated CJK row (so the
    fallback's row detector finds a table), and a plain-ASCII ``Tj`` to prove
    ASCII behavior is untouched.  Streams are FlateDecode compressed so the
    fallback's stream decompression path is exercised.
    """
    cjk_hex = CJK_TEXT.encode("utf-16-be").hex().upper().encode("ascii")
    return _pdf_blob([
        b"BT /F1 12 Tf 72 720 Td <" + cjk_hex + b"> Tj ET",
        b"BT /F1 12 Tf 72 700 Td (" + CJK_TEXT.encode("utf-8") + b") Tj ET",
        # tab-separated row so the regex fallback's row detector finds a table
        b"BT /F1 12 Tf 72 660 Td (" + CJK_TEXT.encode("utf-8") + b"\tFC) Tj ET",
        b"BT /F1 12 Tf 72 680 Td (Gene) Tj ET",
    ])


def test_regex_fallback_decodes_utf16be_hex_strings(tmp_path: Path) -> None:
    """CJK in a UTF-16BE PDF hex string ``<...>`` is decoded by the regex fallback."""
    pdf = tmp_path / "cjk_hex.pdf"
    pdf.write_bytes(_cjk_hex_blob())
    text = _extract_text_via_regex(str(pdf))
    assert CJK_TEXT in text


def test_regex_fallback_recovers_cjk_literals(tmp_path: Path) -> None:
    """CJK literals written as UTF-8 inside ``(...)`` survive the regex fallback."""
    pdf = tmp_path / "cjk_literal.pdf"
    pdf.write_bytes(_cjk_literal_blob())
    text = _extract_text_via_regex(str(pdf))
    assert CJK_TEXT in text


def test_regex_fallback_keeps_ascii_behavior(tmp_path: Path) -> None:
    """CJK handling must not disturb plain-ASCII extraction."""
    pdf = tmp_path / "ascii.pdf"
    pdf.write_bytes(_cjk_pdf_blob())
    text = _extract_text_via_regex(str(pdf))
    assert "Gene" in text


def test_extract_tables_regex_fallback_cjk_via_tool(tmp_path: Path) -> None:
    """extract_pdf_tables via the regex fallback saves a CSV with decoded CJK."""
    ctx, pdf_file = _task_file(
        tmp_path, "test_extract_cjk", "cjk.pdf", _cjk_pdf_blob()
    )
    with patch(
        "app.skills.builtin.processing.extract_tables._resolve_pdf_backend",
        return_value=(None, None),
    ):
        args = json.dumps({"file_path": str(pdf_file)})
        data = json.loads(asyncio.run(extract_pdf_tables.on_invoke_tool(ctx, args)))
    assert data["status"] == "ok"
    assert data["summary"]["total_tables"] == 1
    csv_path = Path(data["outputs"][0])
    content = csv_path.read_text(encoding="utf-8-sig")
    assert CJK_TEXT in content


# ---------------------------------------------------------------------------
# P2-1 (TODO §2.7.3): scanned-PDF diagnostics — VLM channel warning
# ---------------------------------------------------------------------------


def test_extract_tables_scanned_pdf_warns_vlm_channel(tmp_path: Path) -> None:
    """An image-only PDF (no text layer) yields no tables plus a VLM warning.

    OCR is intentionally not part of the stack (pytesseract was rejected, see
    pyproject.toml / TODO §5.2); the tool must instead point the Agent at the
    Qwen-VL ``extract_chart_data_vlm`` channel.
    """
    ctx, pdf_file = _task_file(
        tmp_path, "test_extract_scanned", "scanned.pdf", SCANNED_IMAGE_PDF.read_bytes()
    )
    args = json.dumps({"file_path": str(pdf_file)})
    data = json.loads(asyncio.run(extract_pdf_tables.on_invoke_tool(ctx, args)))
    assert data["status"] == "ok"
    assert data["outputs"] == []
    assert data["summary"]["total_tables"] == 0
    assert "extract_chart_data_vlm" in data["warning"]
    assert "Qwen" in data["warning"] or "VLM" in data["warning"] or "视觉" in data["warning"]


# ---------------------------------------------------------------------------
# P2-3 (TODO §2.7.5): real pdfplumber path with a minimal PDF fixture
# ---------------------------------------------------------------------------


def test_extract_tables_real_pdfplumber_path(tmp_path: Path) -> None:
    """extract_pdf_tables parses a real PDF through the real pdfplumber path.

    No mocks: the committed ``minimal_table.pdf`` fixture is parsed by the
    installed pdfplumber backend end-to-end.
    """
    ctx, pdf_file = _task_file(
        tmp_path,
        "test_extract_real",
        "minimal_table.pdf",
        MINIMAL_TABLE_PDF.read_bytes(),
    )
    args = json.dumps({"file_path": str(pdf_file)})
    data = json.loads(asyncio.run(extract_pdf_tables.on_invoke_tool(ctx, args)))
    assert data["status"] == "ok"
    assert "warning" not in data
    assert data["summary"]["total_tables"] == 1
    table = data["summary"]["tables"][0]
    assert table["column_names"] == ["Gene", "FC"]
    assert table["column_count"] == 2
    assert table["row_count"] == 2
    csv_content = Path(data["outputs"][0]).read_text(encoding="utf-8-sig")
    assert "BRCA1" in csv_content and "TP53" in csv_content


def test_extract_metadata_real_pdfplumber_path(tmp_path: Path) -> None:
    """extract_pdf_metadata works against the real PDF fixture (no mocks)."""
    ctx, pdf_file = _task_file(
        tmp_path,
        "test_meta_real",
        "minimal_table.pdf",
        MINIMAL_TABLE_PDF.read_bytes(),
    )
    ctx.tool_name = "extract_pdf_metadata"
    args = json.dumps({"file_path": str(pdf_file)})
    data = json.loads(asyncio.run(extract_pdf_metadata.on_invoke_tool(ctx, args)))
    assert data["status"] == "ok"
    summary = data["summary"]
    assert summary["title"] == "Gene Expression Analysis in Cancer"
    assert "Smith" in summary["authors"]
    assert summary["doi"] == "10.1234/test.5678"
    assert "gene expression" in summary["abstract"]
    assert summary["num_pages"] == 1
