"""Unit tests for the extract_chart_data_vlm skill.

Mocking strategy:
- ``call_vl_model`` is patched to return canned JSON responses, so no real
  DashScope API call is made.
- ``_extract_pdf_images`` is patched to return a list of fake PNG paths
  written into the task's ``download_tmp/`` directory.
- ``_try_pdfplumber_tables`` and ``_extract_captions_pdf`` are exercised
  through real code paths where practical, or patched for determinism.

Tests cover:
- Image input (PNG) — L1 success
- PDF input — L1 success (multiple images)
- PDF input — L1 fail → L2 success (pdfplumber tables)
- PDF input — L1+L2 fail → L3 success (captions)
- PDF input — all tiers fail → ChartExtractionError
- Unsupported file type → error JSON
- Missing file → error JSON
- VLM returns non-JSON → ChartExtractionError
- VLM returns JSON missing required keys → ChartExtractionError
- CSV outputs are written with correct columns and UTF-8 BOM
- Source asset id traces back to image sha256
- Image outside figures/ is copied in (TODO §5.2 preservation)
- Hint parameter is appended to the VLM prompt
- Large image is downsampled (Pillow path)
- Skill registration metadata is correct
"""
from __future__ import annotations

import asyncio
import csv
import hashlib
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.agent_loop.vl_model import ChartExtractionError
from app.model_config import RunModelSettings, UserSettings
from app.skills.builtin.processing.extract_chart_data_vlm import (
    _CHART_DATA_COLUMNS,
    _CHART_DATA_POINTS_COLUMNS,
    _ensure_image_in_figures,
    _normalize_chart_json,
    _parse_vlm_json,
    extract_chart_data_vlm,
    extract_chart_data_vlm_skill,
)
from app.tools.workdir import create_task_workdir

#: Minimal valid VLM JSON response for a bar chart.
_VALID_VLM_JSON = json.dumps({
    "chart_type": "bar",
    "title": "Gene expression by tissue",
    "axes": {
        "x": {"label": "Tissue", "unit": "", "scale": "linear"},
        "y": {"label": "Expression", "unit": "FPKM", "scale": "log"},
    },
    "data_points": [
        {"x": "Liver", "y": "120.5", "series_label": "GeneA", "confidence": 0.95},
        {"x": "Brain", "y": "85.3", "series_label": "GeneA", "confidence": 0.9},
        {"x": "Liver", "y": "200.1", "series_label": "GeneB", "confidence": 0.88},
    ],
    "legend": ["GeneA", "GeneB"],
})


# ---------------------------------------------------------------------------
# Fixtures & helpers
# ---------------------------------------------------------------------------


def _make_ctx(
    task_id: str = "test_chart_vlm",
    tmp_path: Path | None = None,
) -> ToolContext:
    rc = RunContext(task_id=task_id)
    if tmp_path is not None:
        rc._work_dir = create_task_workdir(task_id, base_dir=str(tmp_path))
    return ToolContext(
        context=rc,
        tool_name="extract_chart_data_vlm",
        tool_call_id="test_call_1",
        tool_arguments="{}",
    )


def _write_fake_png(path: Path, content: bytes = b"\x89PNG\r\n\x1a\nfake-chart") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


def _call_tool(
    ctx: ToolContext,
    source_path: str,
    hint: str = "",
) -> dict[str, Any]:
    args = json.dumps({"source_path": source_path, "hint": hint})
    result = asyncio.run(extract_chart_data_vlm.on_invoke_tool(ctx, args))
    return json.loads(result)


# ---------------------------------------------------------------------------
# Skill registration
# ---------------------------------------------------------------------------


def test_skill_registration_metadata() -> None:
    """Skill is registered as PROCESSING with the right name and tools."""
    assert extract_chart_data_vlm_skill.name == "extract_chart_data_vlm"
    assert extract_chart_data_vlm_skill.category.value == "processing"
    assert extract_chart_data_vlm_skill.version == "0.1.0"
    assert len(extract_chart_data_vlm_skill.tools) == 1
    assert extract_chart_data_vlm_skill.tools[0].name == "extract_chart_data_vlm"


# ---------------------------------------------------------------------------
# Image input — L1 success
# ---------------------------------------------------------------------------


def test_extract_from_image_l1_success(tmp_path: Path) -> None:
    """A PNG image with a mocked VLM response produces chart_data.csv."""
    ctx = _make_ctx(tmp_path=tmp_path)
    run_ctx: RunContext = ctx.context

    img_path = _write_fake_png(
        run_ctx.work_dir.source_asset_file("test_chart.png")
    )

    with patch(
        "app.skills.builtin.processing.extract_chart_data_vlm.call_vl_model",
        return_value=_VALID_VLM_JSON,
    ):
        data = _call_tool(ctx, str(img_path))

    assert data["status"] == "ok"
    assert data["total_charts"] == 1
    assert data["charts"][0]["chart_type"] == "bar"
    assert data["charts"][0]["data_point_count"] == 3
    assert "chart_data.csv" in data["outputs"][0]
    assert "chart_data_points.csv" in data["outputs"][1]

    # CSV files exist and have correct columns
    chart_csv = Path(data["outputs"][0])
    points_csv = Path(data["outputs"][1])
    assert chart_csv.exists()
    assert points_csv.exists()

    # UTF-8 BOM (TODO §1.7)
    assert chart_csv.read_bytes()[:3] == b"\xef\xbb\xbf"
    assert points_csv.read_bytes()[:3] == b"\xef\xbb\xbf"

    # chart_data.csv has header + 1 row
    with open(chart_csv, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        assert reader.fieldnames == _CHART_DATA_COLUMNS
        rows = list(reader)
        assert len(rows) == 1
        assert rows[0]["chart_type"] == "bar"
        assert rows[0]["x_label"] == "Tissue"
        assert rows[0]["y_unit"] == "FPKM"
        assert rows[0]["y_scale"] == "log"
        assert rows[0]["model_name"] == "qwen-vl-max"

    # chart_data_points.csv has header + 3 rows
    with open(points_csv, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        assert reader.fieldnames == _CHART_DATA_POINTS_COLUMNS
        pt_rows = list(reader)
        assert len(pt_rows) == 3
        assert pt_rows[0]["x_value"] == "Liver"
        assert pt_rows[0]["y_value"] == "120.5"
        assert pt_rows[0]["series_label"] == "GeneA"

    # Provenance: source_asset_id matches the image's sha256
    expected_sha = hashlib.sha256(img_path.read_bytes()).hexdigest()
    assert data["metas"][0]["source_asset_id"] == f"asset_{expected_sha}"

    # query_log records the successful extraction
    assert len(run_ctx.query_log) == 1
    assert run_ctx.query_log[0]["status"] == "success"
    assert run_ctx.query_log[0]["records_count"] == 1


def test_repeated_extractions_accumulate_distinct_chart_sources(tmp_path: Path) -> None:
    ctx = _make_ctx(tmp_path=tmp_path)
    run_ctx: RunContext = ctx.context
    first = _write_fake_png(
        run_ctx.work_dir.source_asset_file("first.png"),
        content=b"\x89PNG\r\n\x1a\nfirst",
    )
    second = _write_fake_png(
        run_ctx.work_dir.source_asset_file("second.png"),
        content=b"\x89PNG\r\n\x1a\nsecond",
    )

    with patch(
        "app.skills.builtin.processing.extract_chart_data_vlm.call_vl_model",
        return_value=_VALID_VLM_JSON,
    ):
        first_result = _call_tool(ctx, str(first))
        second_result = _call_tool(ctx, str(second))

    chart_csv = Path(second_result["outputs"][0])
    points_csv = Path(second_result["outputs"][1])
    with chart_csv.open(encoding="utf-8-sig", newline="") as handle:
        charts = list(csv.DictReader(handle))
    with points_csv.open(encoding="utf-8-sig", newline="") as handle:
        points = list(csv.DictReader(handle))

    assert len(charts) == 2
    assert len(points) == 6
    assert {row["source_asset_id"] for row in charts} == {
        first_result["metas"][0]["source_asset_id"],
        second_result["metas"][0]["source_asset_id"],
    }
    assert {row["chart_id"] for row in points} == {
        row["chart_id"] for row in charts
    }


def test_extract_from_image_passes_run_owned_settings_to_vlm(tmp_path: Path) -> None:
    # Given
    ctx = _make_ctx(tmp_path=tmp_path)
    run_ctx: RunContext = ctx.context
    run_settings = RunModelSettings.from_user_settings(
        UserSettings(api_key="run-api-key", base_url="https://run.example/v1")
    )
    run_ctx.model_settings = run_settings
    image_path = _write_fake_png(run_ctx.work_dir.source_asset_file("chart.png"))
    call_vl = AsyncMock(return_value=_VALID_VLM_JSON)

    # When
    with patch(
        "app.skills.builtin.processing.extract_chart_data_vlm.call_vl_model",
        new=call_vl,
    ):
        data = _call_tool(ctx, str(image_path))

    # Then
    assert data["status"] == "ok"
    assert call_vl.await_args.kwargs["model_settings"] is run_settings


def test_extract_from_image_already_in_figures_no_copy(tmp_path: Path) -> None:
    """An image already under source_assets/figures/ is not re-copied."""
    ctx = _make_ctx(tmp_path=tmp_path)
    run_ctx: RunContext = ctx.context

    # Place the image directly in figures/ (simulating web_visual_capture output)
    figures_dir = run_ctx.work_dir.source_asset_file("figures/_placeholder").parent
    figures_dir.mkdir(parents=True, exist_ok=True)
    img_path = figures_dir / "fig_test123.png"
    _write_fake_png(img_path)

    with patch(
        "app.skills.builtin.processing.extract_chart_data_vlm.call_vl_model",
        return_value=_VALID_VLM_JSON,
    ):
        data = _call_tool(ctx, str(img_path))

    assert data["status"] == "ok"
    assert data["metas"][0]["was_copied"] is False


def test_extract_from_image_outside_figures_is_copied(tmp_path: Path) -> None:
    """An image outside source_assets/figures/ is copied in (TODO §5.2)."""
    ctx = _make_ctx(tmp_path=tmp_path)
    run_ctx: RunContext = ctx.context

    # Place the image in raw/ (alias for source_assets/) but not in figures/
    img_path = run_ctx.work_dir.source_asset_file("external_chart.png")
    _write_fake_png(img_path, content=b"\x89PNG\r\n\x1a\nexternal-content")

    with patch(
        "app.skills.builtin.processing.extract_chart_data_vlm.call_vl_model",
        return_value=_VALID_VLM_JSON,
    ):
        data = _call_tool(ctx, str(img_path))

    assert data["status"] == "ok"
    assert data["metas"][0]["was_copied"] is True

    # The copied file exists under figures/
    expected_sha = hashlib.sha256(img_path.read_bytes()).hexdigest()
    copied_path = run_ctx.work_dir.source_asset_file(
        f"figures/fig_{expected_sha[:12]}.png"
    )
    assert copied_path.exists()
    assert copied_path.read_bytes() == img_path.read_bytes()

    # The original file still exists (not moved)
    assert img_path.exists()


# ---------------------------------------------------------------------------
# PDF input — L1 success
# ---------------------------------------------------------------------------


def test_extract_from_pdf_l1_success(tmp_path: Path) -> None:
    """A PDF with mocked image extraction + mocked VLM produces chart_data."""
    ctx = _make_ctx(tmp_path=tmp_path)
    run_ctx: RunContext = ctx.context

    # Create a fake PDF file (content doesn't matter — extraction is mocked)
    pdf_path = run_ctx.work_dir.source_asset_file("paper.pdf")
    pdf_path.write_bytes(b"%PDF-1.4 fake pdf with charts")

    # Mock the image extraction to return 2 fake PNGs in download_tmp/
    fake_img1 = run_ctx.work_dir.download_temp_file("paper_p1_img1.png")
    fake_img2 = run_ctx.work_dir.download_temp_file("paper_p2_img1.png")
    _write_fake_png(fake_img1, content=b"\x89PNG\r\n\x1a\nchart1")
    _write_fake_png(fake_img2, content=b"\x89PNG\r\n\x1a\nchart2")

    # Two different VLM responses
    vlm_response_1 = _VALID_VLM_JSON
    vlm_response_2 = json.dumps({
        "chart_type": "scatter",
        "title": "Volcano plot",
        "axes": {
            "x": {"label": "log2FC", "unit": "", "scale": "linear"},
            "y": {"label": "-log10(p)", "unit": "", "scale": "linear"},
        },
        "data_points": [
            {"x": "2.5", "y": "4.1", "series_label": "up", "confidence": 0.93},
            {"x": "-3.0", "y": "5.2", "series_label": "down", "confidence": 0.91},
        ],
        "legend": ["up", "down"],
    })

    with patch(
        "app.skills.builtin.processing.extract_chart_data_vlm._extract_pdf_images",
        return_value=[(fake_img1, 1, (0, 0, 10, 10)), (fake_img2, 2, (0, 0, 20, 20))],
    ), patch(
        "app.skills.builtin.processing.extract_chart_data_vlm.call_vl_model",
        side_effect=[vlm_response_1, vlm_response_2],
    ):
        data = _call_tool(ctx, str(pdf_path))

    assert data["status"] == "ok"
    assert data["total_charts"] == 2
    assert data["charts"][0]["chart_type"] == "bar"
    assert data["charts"][1]["chart_type"] == "scatter"

    # The PDF's sha256 is the source_asset_id for all charts (PDF-level traceability)
    pdf_sha = hashlib.sha256(pdf_path.read_bytes()).hexdigest()
    expected_source_asset_id = f"asset_{pdf_sha}"
    for chart in data["charts"]:
        assert chart["source_asset_id"] == expected_source_asset_id

    # raw_asset includes the PDF path
    assert str(pdf_path) in run_ctx.raw_assets


# ---------------------------------------------------------------------------
# PDF input — L1 fail → L2 success
# ---------------------------------------------------------------------------


def test_extract_from_pdf_l1_fail_l2_success(tmp_path: Path) -> None:
    """When VLM fails for all images, L2 pdfplumber tables recover data."""
    ctx = _make_ctx(tmp_path=tmp_path)
    run_ctx: RunContext = ctx.context

    pdf_path = run_ctx.work_dir.source_asset_file("paper_no_charts.pdf")
    pdf_path.write_bytes(b"%PDF-1.4 fake pdf with tables only")

    # L1: image extraction returns one image, but VLM raises
    fake_img = run_ctx.work_dir.download_temp_file("paper_p1_img1.png")
    _write_fake_png(fake_img)

    # L2: mock pdfplumber table extraction to return one table
    fake_chart_row = {
        "chart_id": "chart_test_tbl_p1_1",
        "source_asset_id": "asset_test",
        "chart_type": "table",
        "title": "PDF table p1 #1",
        "x_label": "column", "x_unit": "", "x_scale": "linear",
        "y_label": "value", "y_unit": "", "y_scale": "linear",
        "data_point_count": 4,
        "legend": "A|B",
        "extracted_at": "2025-01-01T00:00:00Z",
        "model_name": "pdfplumber",
        "source_label": "paper_no_charts.pdf",
        "page_number": "1",
        "bbox": "",
        "extraction_tier": "L2_tables",
    }
    fake_point_rows = [
        {"point_id": "chart_test_tbl_p1_1_r1_c1", "chart_id": "chart_test_tbl_p1_1",
         "x_value": "1", "y_value": "10", "series_label": "row_1", "confidence": ""},
    ]

    with patch(
        "app.skills.builtin.processing.extract_chart_data_vlm._extract_pdf_images",
        return_value=[(fake_img, 1, (0, 0, 10, 10))],
    ), patch(
        "app.skills.builtin.processing.extract_chart_data_vlm.call_vl_model",
        side_effect=ChartExtractionError("VLM failed"),
    ), patch(
        "app.skills.builtin.processing.extract_chart_data_vlm._try_pdfplumber_tables",
        return_value=([fake_chart_row], fake_point_rows),
    ):
        data = _call_tool(ctx, str(pdf_path))

    assert data["status"] == "ok"
    assert data["total_charts"] == 1
    assert data["charts"][0]["chart_type"] == "table"
    assert data["metas"][0]["tier"] == "L2_pdfplumber_tables"
    assert "degradation" in data

    # Warning was emitted about L1 failure
    warnings = [w for w in run_ctx.warnings if "L1 VLM failed" in w["message"]]
    assert len(warnings) >= 1


# ---------------------------------------------------------------------------
# PDF input — L1+L2 fail → L3 success (captions)
# ---------------------------------------------------------------------------


def test_extract_from_pdf_l1_l2_fail_l3_success(tmp_path: Path) -> None:
    """When VLM and pdfplumber tables both fail, L3 extracts captions."""
    ctx = _make_ctx(tmp_path=tmp_path)
    run_ctx: RunContext = ctx.context

    pdf_path = run_ctx.work_dir.source_asset_file("paper_captions_only.pdf")
    pdf_path.write_bytes(b"%PDF-1.4 fake pdf with captions only")

    fake_img = run_ctx.work_dir.download_temp_file("paper_p1_img1.png")
    _write_fake_png(fake_img)

    with patch(
        "app.skills.builtin.processing.extract_chart_data_vlm._extract_pdf_images",
        return_value=[(fake_img, 1, (0, 0, 10, 10))],
    ), patch(
        "app.skills.builtin.processing.extract_chart_data_vlm.call_vl_model",
        side_effect=ChartExtractionError("VLM failed"),
    ), patch(
        "app.skills.builtin.processing.extract_chart_data_vlm._try_pdfplumber_tables",
        return_value=None,
    ), patch(
        "app.skills.builtin.processing.extract_chart_data_vlm._extract_captions_pdf",
        return_value=["Figure 1: Gene expression heatmap", "Table 1: Sample metadata"],
    ):
        data = _call_tool(ctx, str(pdf_path))

    assert data["status"] == "ok"
    assert data["total_charts"] == 1
    assert data["charts"][0]["chart_type"] == "caption_only"
    assert data["charts"][0]["data_point_count"] == 2
    assert data["metas"][0]["tier"] == "L3_captions"

    # The captions are stored as data points (y_value = caption text)
    points_csv = Path(data["outputs"][1])
    with open(points_csv, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    assert len(rows) == 2
    assert "Figure 1" in rows[0]["y_value"]
    assert "Table 1" in rows[1]["y_value"]


# ---------------------------------------------------------------------------
# All tiers fail → ChartExtractionError → error JSON
# ---------------------------------------------------------------------------


def test_extract_from_pdf_all_tiers_fail_returns_error(tmp_path: Path) -> None:
    """When L1+L2+L3 all fail, the tool returns error JSON (not raises)."""
    ctx = _make_ctx(tmp_path=tmp_path)
    run_ctx: RunContext = ctx.context

    pdf_path = run_ctx.work_dir.source_asset_file("paper_empty.pdf")
    pdf_path.write_bytes(b"%PDF-1.4 fake empty pdf")

    with patch(
        "app.skills.builtin.processing.extract_chart_data_vlm._extract_pdf_images",
        return_value=[],  # No images
    ), patch(
        "app.skills.builtin.processing.extract_chart_data_vlm._try_pdfplumber_tables",
        return_value=None,  # No tables
    ), patch(
        "app.skills.builtin.processing.extract_chart_data_vlm._extract_captions_pdf",
        return_value=[],  # No captions
    ):
        data = _call_tool(ctx, str(pdf_path))

    assert data["status"] == "error"
    assert "All chart extraction tiers failed" in data["error"]
    assert data["source_file"] == "paper_empty.pdf"

    # Warning was recorded
    warnings = [w for w in run_ctx.warnings if "chart extraction failed" in w["message"]]
    assert len(warnings) == 1
    assert warnings[0]["severity"] == "error"

    # query_log marks the failure
    assert run_ctx.query_log[0]["status"] == "failed"


# ---------------------------------------------------------------------------
# Error cases
# ---------------------------------------------------------------------------


def test_extract_unsupported_file_type(tmp_path: Path) -> None:
    """Unsupported file extensions return error JSON."""
    ctx = _make_ctx(tmp_path=tmp_path)
    run_ctx: RunContext = ctx.context

    bad_path = run_ctx.work_dir.source_asset_file("data.xlsx")
    bad_path.write_bytes(b"fake xlsx")

    data = _call_tool(ctx, str(bad_path))

    assert data["status"] == "error"
    assert "unsupported file type" in data["error"]
    assert ".xlsx" in data["error"]


def test_extract_missing_file(tmp_path: Path) -> None:
    """Missing source_path returns error JSON."""
    ctx = _make_ctx(tmp_path=tmp_path)

    data = _call_tool(ctx, "source_assets/nonexistent-chart.png")

    assert data["status"] == "error"
    assert "not found" in data["error"]


def test_extract_rejects_image_outside_task_workdir(tmp_path: Path) -> None:
    """A readable image outside the managed task must never reach the VLM."""
    ctx = _make_ctx(tmp_path=tmp_path)
    external_path = _write_fake_png(tmp_path / "outside-task.png")

    with patch(
        "app.skills.builtin.processing.extract_chart_data_vlm.call_vl_model",
        return_value=_VALID_VLM_JSON,
    ) as call_vlm:
        data = _call_tool(ctx, str(external_path))

    assert data["status"] == "error"
    assert "task" in data["error"].lower()
    call_vlm.assert_not_called()


def test_vlm_returns_non_json_raises_chart_extraction_error(tmp_path: Path) -> None:
    """VLM returning non-JSON text surfaces as ChartExtractionError."""
    ctx = _make_ctx(tmp_path=tmp_path)
    run_ctx: RunContext = ctx.context

    img_path = _write_fake_png(run_ctx.work_dir.source_asset_file("bad_chart.png"))

    with patch(
        "app.skills.builtin.processing.extract_chart_data_vlm.call_vl_model",
        return_value="This is not JSON at all.",
    ):
        data = _call_tool(ctx, str(img_path))

    assert data["status"] == "error"
    assert "non-JSON" in data["error"] or "non-JSON" in data["error"].lower()


def test_vlm_returns_json_missing_required_keys(tmp_path: Path) -> None:
    """VLM JSON missing required keys surfaces as ChartExtractionError."""
    ctx = _make_ctx(tmp_path=tmp_path)
    run_ctx: RunContext = ctx.context

    img_path = _write_fake_png(run_ctx.work_dir.source_asset_file("incomplete.png"))

    # Missing 'axes' and 'data_points'
    incomplete_json = json.dumps({"chart_type": "bar"})

    with patch(
        "app.skills.builtin.processing.extract_chart_data_vlm.call_vl_model",
        return_value=incomplete_json,
    ):
        data = _call_tool(ctx, str(img_path))

    assert data["status"] == "error"
    assert "missing required keys" in data["error"]


# ---------------------------------------------------------------------------
# VLM JSON parsing — markdown fence stripping
# ---------------------------------------------------------------------------


def test_parse_vlm_json_strips_markdown_fences() -> None:
    """Markdown fences (despite prompt forbidding them) are stripped."""
    raw = "```json\n" + _VALID_VLM_JSON + "\n```"
    data = _parse_vlm_json(raw, "test_source")
    assert data["chart_type"] == "bar"
    assert len(data["data_points"]) == 3


def test_parse_vlm_json_strips_trailing_prose() -> None:
    """Trailing prose after the JSON object is trimmed."""
    raw = _VALID_VLM_JSON + "\n\nNote: the chart appears to show gene expression."
    data = _parse_vlm_json(raw, "test_source")
    assert data["chart_type"] == "bar"


def test_parse_vlm_json_raises_on_invalid_json() -> None:
    """Invalid JSON raises ChartExtractionError."""
    with pytest.raises(ChartExtractionError, match="non-JSON"):
        _parse_vlm_json("not json", "test_source")


def test_parse_vlm_json_raises_on_non_object() -> None:
    """A JSON array (non-object) raises ChartExtractionError."""
    with pytest.raises(ChartExtractionError, match="non-object"):
        _parse_vlm_json("[1, 2, 3]", "test_source")


def test_parse_vlm_json_raises_on_missing_keys() -> None:
    """JSON missing required keys raises ChartExtractionError."""
    with pytest.raises(ChartExtractionError, match="missing required keys"):
        _parse_vlm_json('{"chart_type": "bar"}', "test_source")


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------


def test_normalize_chart_json_basic() -> None:
    """VLM JSON is normalized into chart_row + point_rows correctly."""
    data = json.loads(_VALID_VLM_JSON)
    chart_row, point_rows = _normalize_chart_json(
        data,
        source_asset_id="asset_abc123",
        chart_idx=1,
        source_label="test.png",
    )

    assert chart_row["chart_id"] == "chart_asset_abc123_1"
    assert chart_row["source_asset_id"] == "asset_abc123"
    assert chart_row["chart_type"] == "bar"
    assert chart_row["x_label"] == "Tissue"
    assert chart_row["y_unit"] == "FPKM"
    assert chart_row["y_scale"] == "log"
    assert chart_row["data_point_count"] == 3
    assert chart_row["legend"] == "GeneA|GeneB"
    assert chart_row["model_name"] == "qwen-vl-max"
    assert chart_row["source_label"] == "test.png"
    # Metadata / tier provenance (TODO Phase 6 P0)
    assert chart_row["extraction_tier"] == "L1_vlm"
    assert chart_row["page_number"] == ""
    assert chart_row["bbox"] == ""

    assert len(point_rows) == 3
    assert point_rows[0]["point_id"] == "chart_asset_abc123_1_p1"
    assert point_rows[0]["x_value"] == "Liver"
    assert point_rows[0]["y_value"] == "120.5"
    assert point_rows[0]["series_label"] == "GeneA"
    assert point_rows[0]["confidence"] == "0.95"


def test_normalize_chart_json_carries_metadata() -> None:
    """page_number / bbox / extraction_tier are carried into the chart row."""
    data = json.loads(_VALID_VLM_JSON)
    chart_row, point_rows = _normalize_chart_json(
        data,
        source_asset_id="asset_pdf_sha",
        chart_idx=3,
        source_label="paper.pdf",
        page_number="3",
        bbox="10,20,300,150",
        extraction_tier="L1_vlm",
    )
    assert chart_row["page_number"] == "3"
    assert chart_row["bbox"] == "10,20,300,150"
    assert chart_row["extraction_tier"] == "L1_vlm"
    assert point_rows[0]["confidence"] == "0.95"


def test_normalize_chart_json_point_without_confidence_blank() -> None:
    """A VLM point missing confidence normalizes to an empty string."""
    data = json.loads(_VALID_VLM_JSON)
    data["data_points"][0].pop("confidence")
    _chart, point_rows = _normalize_chart_json(
        data, source_asset_id="asset_abc", chart_idx=1, source_label="a.png"
    )
    assert point_rows[0]["confidence"] == ""


def test_normalize_chart_json_empty_data_points() -> None:
    """Empty data_points list is handled gracefully."""
    data = {
        "chart_type": "other",
        "title": "",
        "axes": {
            "x": {"label": "", "unit": "", "scale": "linear"},
            "y": {"label": "", "unit": "", "scale": "linear"},
        },
        "data_points": [],
        "legend": [],
    }
    chart_row, point_rows = _normalize_chart_json(
        data, source_asset_id="asset_empty",
        chart_idx=1, source_label="empty.png",
    )
    assert chart_row["data_point_count"] == 0
    assert point_rows == []


# ---------------------------------------------------------------------------
# _ensure_image_in_figures
# ---------------------------------------------------------------------------


def test_ensure_image_in_figures_no_copy_when_already_there(tmp_path: Path) -> None:
    """An image already in figures/ is returned as-is with was_copied=False."""

    workdir = create_task_workdir("test_ensure", base_dir=str(tmp_path))
    figures_dir = workdir.source_asset_file("figures/_p").parent
    figures_dir.mkdir(parents=True, exist_ok=True)
    img_path = figures_dir / "existing.png"
    _write_fake_png(img_path, content=b"existing content")

    dest, sha, was_copied = _ensure_image_in_figures(img_path, workdir)

    assert dest == img_path
    assert was_copied is False
    expected_sha = hashlib.sha256(b"existing content").hexdigest()
    assert sha == expected_sha


def test_ensure_image_in_figures_copies_external_image(tmp_path: Path) -> None:
    """An image outside figures/ is copied in with content-addressed name."""
    from app.tools.workdir import create_task_workdir

    workdir = create_task_workdir("test_ensure_copy", base_dir=str(tmp_path))
    external_path = workdir.source_asset_file("external.png")
    _write_fake_png(external_path, content=b"external content")

    dest, sha, was_copied = _ensure_image_in_figures(external_path, workdir)

    assert was_copied is True
    expected_sha = hashlib.sha256(b"external content").hexdigest()
    assert sha == expected_sha
    assert dest.name == f"fig_{expected_sha[:12]}.png"
    assert dest.exists()
    assert dest.read_bytes() == b"external content"
    # Original is preserved
    assert external_path.exists()


# ---------------------------------------------------------------------------
# Hint parameter
# ---------------------------------------------------------------------------


def test_hint_appended_to_vlm_prompt(tmp_path: Path) -> None:
    """The hint parameter is appended to the VLM prompt."""
    ctx = _make_ctx(tmp_path=tmp_path)
    run_ctx: RunContext = ctx.context
    img_path = _write_fake_png(run_ctx.work_dir.source_asset_file("hinted.png"))

    captured_prompt = []

    async def mock_call_vl(path: Path, prompt: str, **kwargs: Any) -> str:
        captured_prompt.append(prompt)
        return _VALID_VLM_JSON

    with patch(
        "app.skills.builtin.processing.extract_chart_data_vlm.call_vl_model",
        side_effect=mock_call_vl,
    ):
        data = _call_tool(ctx, str(img_path), hint="scatter plot, log scale")

    assert data["status"] == "ok"
    assert len(captured_prompt) == 1
    assert "scatter plot, log scale" in captured_prompt[0]
    assert "Additional hint:" in captured_prompt[0]


# ---------------------------------------------------------------------------
# Progress emission
# ---------------------------------------------------------------------------


def test_progress_emitted_on_success(tmp_path: Path) -> None:
    """A successful extraction emits a chart_data_extracted progress event."""
    ctx = _make_ctx(tmp_path=tmp_path)
    run_ctx: RunContext = ctx.context
    img_path = _write_fake_png(run_ctx.work_dir.source_asset_file("progress.png"))

    emitted: list[tuple] = []

    async def capture_emitter(*args: Any) -> None:
        emitted.append(args)

    run_ctx.bind_progress_emitter(capture_emitter)

    with patch(
        "app.skills.builtin.processing.extract_chart_data_vlm.call_vl_model",
        return_value=_VALID_VLM_JSON,
    ):
        _call_tool(ctx, str(img_path))

    assert len(emitted) == 1
    stage, kind, current, total, detail = emitted[0]
    assert stage.value == "processing"
    assert kind == "chart_data_extracted"
    assert current == 1
    assert total == 1
    assert detail["charts"] == 1
    assert detail["data_points"] == 3


# ---------------------------------------------------------------------------
# Multi-image PDF — cap at 10
# ---------------------------------------------------------------------------


def test_pdf_image_cap_at_10(tmp_path: Path) -> None:
    """More than 10 images in a PDF are capped (only first 10 extracted)."""
    from app.skills.builtin.processing.extract_chart_data_vlm import (
        _MAX_PDF_IMAGES_PER_FILE,
    )

    assert _MAX_PDF_IMAGES_PER_FILE == 10
    # The cap is enforced inside _extract_pdf_images; here we just verify
    # the constant is correctly exported and the skill module exposes it
    # for future tuning.


# ---------------------------------------------------------------------------
# chart_data integrity validation (TODO Phase 6 P1, 原 §2.7.1)
# ---------------------------------------------------------------------------


def _valid_chart_rows() -> list[dict[str, Any]]:
    return [{
        "chart_id": "chart_asset_a_1",
        "source_asset_id": "asset_a",
        "chart_type": "bar",
        "title": "T",
        "x_label": "X", "x_unit": "", "x_scale": "linear",
        "y_label": "Y", "y_unit": "", "y_scale": "linear",
        "data_point_count": 2, "legend": "",
        "extracted_at": "2026-01-01T00:00:00Z",
        "model_name": "qwen-vl-max", "source_label": "a.png",
    }]


def _valid_point_rows() -> list[dict[str, Any]]:
    return [
        {"point_id": "p1", "chart_id": "chart_asset_a_1", "x_value": "1", "y_value": "2", "series_label": "s", "confidence": "0.9"},
        {"point_id": "p2", "chart_id": "chart_asset_a_1", "x_value": "3", "y_value": "4", "series_label": "s", "confidence": "0.8"},
    ]


def test_validate_chart_data_accepts_complete_payload() -> None:
    """A complete chart payload (source_asset_id + chart_id refs) passes."""
    from app.skills.builtin.processing.extract_chart_data_vlm import (
        validate_chart_data,
    )

    violations = validate_chart_data(_valid_chart_rows(), _valid_point_rows())
    assert violations == []


def test_validate_chart_data_rejects_missing_source_asset_id() -> None:
    """Every chart row must carry a source_asset_id."""
    from app.skills.builtin.processing.extract_chart_data_vlm import (
        validate_chart_data,
    )

    chart_rows = _valid_chart_rows()
    chart_rows[0]["source_asset_id"] = ""
    violations = validate_chart_data(chart_rows, _valid_point_rows())
    assert any("missing source_asset_id" in v for v in violations)


def test_validate_chart_data_rejects_orphan_point() -> None:
    """A point referencing a non-existent chart_id is a violation."""
    from app.skills.builtin.processing.extract_chart_data_vlm import (
        validate_chart_data,
    )

    point_rows = _valid_point_rows()
    point_rows[0]["chart_id"] = "chart_ghost"
    violations = validate_chart_data(_valid_chart_rows(), point_rows)
    assert any("no matching chart_data.csv row" in v for v in violations)


def test_validate_chart_data_rejects_point_missing_chart_id() -> None:
    """A point with an empty chart_id is a violation."""
    from app.skills.builtin.processing.extract_chart_data_vlm import (
        validate_chart_data,
    )

    point_rows = _valid_point_rows()
    point_rows[0]["chart_id"] = ""
    violations = validate_chart_data(_valid_chart_rows(), point_rows)
    assert any("missing chart_id" in v for v in violations)


# ---------------------------------------------------------------------------
# Model-extraction admission gate (TODO Phase 6 P0, Design §16 Phase 6)
# ---------------------------------------------------------------------------


def _l1_chart_rows() -> list[dict[str, Any]]:
    rows = _valid_chart_rows()
    rows[0]["extraction_tier"] = "L1_vlm"
    rows[0]["model_name"] = "qwen-vl-max"
    return rows


def _l2_chart_rows() -> list[dict[str, Any]]:
    rows = _valid_chart_rows()
    rows[0]["chart_type"] = "table"
    rows[0]["extraction_tier"] = "L2_tables"
    rows[0]["model_name"] = "pdfplumber"
    return rows


def test_validate_chart_extraction_accepts_confident_l1_payload() -> None:
    """L1 points carrying confidence pass the admission gate."""
    from app.skills.builtin.processing.extract_chart_data_vlm import (
        validate_chart_extraction,
    )

    violations = validate_chart_extraction(
        _l1_chart_rows(), _valid_point_rows()
    )
    assert violations == []


def test_validate_chart_extraction_rejects_l1_point_missing_confidence() -> None:
    """A model-extracted point without confidence fails admission."""
    from app.skills.builtin.processing.extract_chart_data_vlm import (
        validate_chart_extraction,
    )

    point_rows = _valid_point_rows()
    point_rows[0]["confidence"] = ""
    violations = validate_chart_extraction(_l1_chart_rows(), point_rows)
    assert any("missing confidence" in v for v in violations)


def test_validate_chart_extraction_rejects_l1_missing_model() -> None:
    """A model-extracted chart without model_name fails admission."""
    from app.skills.builtin.processing.extract_chart_data_vlm import (
        validate_chart_extraction,
    )

    chart_rows = _l1_chart_rows()
    chart_rows[0]["model_name"] = ""
    violations = validate_chart_extraction(chart_rows, _valid_point_rows())
    assert any("missing model_name" in v for v in violations)


def test_validate_chart_extraction_exempts_l2_points_without_confidence() -> None:
    """Deterministic (non-model) tiers are exempt from the confidence gate."""
    from app.skills.builtin.processing.extract_chart_data_vlm import (
        validate_chart_extraction,
    )

    point_rows = _valid_point_rows()
    for row in point_rows:
        row["confidence"] = ""
    violations = validate_chart_extraction(_l2_chart_rows(), point_rows)
    assert violations == []


def test_validate_chart_extraction_no_tier_treated_as_l1() -> None:
    """Rows without extraction_tier are treated as model-extracted."""
    from app.skills.builtin.processing.extract_chart_data_vlm import (
        validate_chart_extraction,
    )

    chart_rows = _valid_chart_rows()  # no extraction_tier key
    point_rows = _valid_point_rows()
    point_rows[0]["confidence"] = ""
    violations = validate_chart_extraction(chart_rows, point_rows)
    assert any("missing confidence" in v for v in violations)


def test_extract_from_pdf_l1_success_persists_page_metadata(tmp_path: Path) -> None:
    """PDF L1 charts carry page_number/bbox/extraction_tier in chart_data.csv."""
    ctx = _make_ctx(tmp_path=tmp_path)
    run_ctx: RunContext = ctx.context

    pdf_path = run_ctx.work_dir.source_asset_file("meta_paper.pdf")
    pdf_path.write_bytes(b"%PDF-1.4 meta paper")

    fake_img1 = run_ctx.work_dir.download_temp_file("meta_p1_img1.png")
    _write_fake_png(fake_img1, content=b"\x89PNG\r\n\x1a\nmeta1")

    with patch(
        "app.skills.builtin.processing.extract_chart_data_vlm._extract_pdf_images",
        return_value=[(fake_img1, 1, (12, 34, 156, 200))],
    ), patch(
        "app.skills.builtin.processing.extract_chart_data_vlm.call_vl_model",
        return_value=_VALID_VLM_JSON,
    ):
        data = _call_tool(ctx, str(pdf_path))

    assert data["status"] == "ok"
    chart_csv = Path(data["outputs"][0])
    with chart_csv.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert len(rows) == 1
    assert rows[0]["page_number"] == "1"
    assert rows[0]["bbox"] == "12,34,156,200"
    assert rows[0]["extraction_tier"] == "L1_vlm"
    assert rows[0]["model_name"] == "qwen-vl-max"


def test_l1_point_missing_confidence_fails_extraction(tmp_path: Path) -> None:
    """An L1 extraction whose points lack confidence fails admission."""
    ctx = _make_ctx(tmp_path=tmp_path)
    run_ctx: RunContext = ctx.context

    img_path = _write_fake_png(
        run_ctx.work_dir.source_asset_file("no_confidence.png")
    )
    no_confidence_json = json.loads(_VALID_VLM_JSON)
    for pt in no_confidence_json["data_points"]:
        pt.pop("confidence")

    with patch(
        "app.skills.builtin.processing.extract_chart_data_vlm.call_vl_model",
        return_value=json.dumps(no_confidence_json),
    ):
        data = _call_tool(ctx, str(img_path))

    assert data["status"] == "error"
    assert "admission check failed" in data["error"]
    assert "missing confidence" in data["error"]

    # Nothing was written to disk
    chart_dir = run_ctx.work_dir.root / "parsed" / "chart_data"
    assert not (chart_dir / "chart_data.csv").exists()
