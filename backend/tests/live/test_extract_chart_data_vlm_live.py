"""Live tests for the ``extract_chart_data_vlm`` skill — exercises the real
Qwen-VL (``qwen-vl-max``) model via the DashScope OpenAI-compatible endpoint.

These tests are marked ``@pytest.mark.live`` so they are skipped by default
(``uv run pytest``) and only run with ``uv run pytest -m live``.

Two acquisition channels are exercised end-to-end (TODO §5.2 + user
instruction "视觉模型应设法处理任何获得方法的论文 例如PubMed的论文也要考虑获取"):

1. **PNG image input** — a matplotlib-generated bar chart PNG (no network
   needed for asset acquisition; the only network call is to Qwen-VL).
   This represents the ``web_visual_capture`` channel where a screenshot
   has already been saved to ``source_assets/figures/``.

2. **PDF input from PubMed/PMC** — downloads a real open-access PMC PDF
   (via Europe PMC, the project_memory-mandated alternative paper channel
   for domestic network stability) and runs the full L1→L2→L3 chain on it.
   This represents the ``download_supplementary`` channel where the Agent
   has acquired a PDF from PubMed.

Tests skip only when a required precondition is absent:
- ``DASHSCOPE_API_KEY`` is not set (the VLM client cannot be built).
- The PDF download fails before extraction (network unavailable or EPMC
  rate-limited).

Once extraction is invoked, provider or fallback-chain failures fail the live
gate instead of being converted into a skip.

Run explicitly::

    uv run pytest -m live tests/live/test_extract_chart_data_vlm_live.py -v
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

import httpx
import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.config import settings
from app.skills.builtin.processing.extract_chart_data_vlm import (
    _CHART_DATA_COLUMNS,
    _CHART_DATA_POINTS_COLUMNS,
    extract_chart_data_vlm,
)
from app.tools.workdir import create_task_workdir

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        not settings.dashscope_api_key,
        reason="DASHSCOPE_API_KEY is required for VLM live tests",
    ),
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_ctx(tmp_path: Path, task_id: str) -> ToolContext:
    """Build a ToolContext bound to a fresh RunContext + workdir."""
    rc = RunContext(task_id=task_id)
    rc._work_dir = create_task_workdir(task_id, base_dir=str(tmp_path))
    return ToolContext(
        context=rc,
        tool_name="extract_chart_data_vlm",
        tool_call_id="live_call",
        tool_arguments="{}",
    )


def _generate_bar_chart_png(dest_path: Path) -> None:
    """Generate a simple, unambiguous bar chart PNG for VLM extraction.

    Uses matplotlib (already a backend dependency for chart rendering).
    The chart has clear axes labels, a title, and 4 bars — designed so
    that ``qwen-vl-max`` reliably returns a parseable bar-chart JSON.
    """
    import matplotlib

    matplotlib.use("Agg")  # non-interactive backend
    import matplotlib.pyplot as plt

    categories = ["Liver", "Brain", "Heart", "Lung"]
    values = [120.5, 85.3, 200.1, 65.8]
    fig, ax = plt.subplots(figsize=(6, 4), dpi=100)
    ax.bar(categories, values, color="#4C72B0", edgecolor="black")
    ax.set_title("Gene Expression by Tissue", fontsize=13)
    ax.set_xlabel("Tissue", fontsize=11)
    ax.set_ylabel("Expression (FPKM)", fontsize=11)
    ax.grid(axis="y", linestyle="--", alpha=0.4)
    fig.tight_layout()
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(dest_path, format="png", dpi=100)
    plt.close(fig)


def _download_epmc_pdf(pmcid: str, dest_path: Path, *, timeout: float = 30.0) -> bool:
    """Download an open-access PDF from Europe PMC.

    Europe PMC exposes a stable PDF render endpoint:
        https://europepmc.org/articles/PMC{id}?pdf=render

    Returns ``True`` on success, ``False`` on any failure (the caller
    decides whether to skip or fail the test).
    """
    url = f"https://europepmc.org/articles/PMC{pmcid}?pdf=render"
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept": "application/pdf,*/*",
    }
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            resp = client.get(url, headers=headers)
            if resp.status_code != 200:
                return False
            content_type = resp.headers.get("content-type", "")
            if "pdf" not in content_type.lower() and not resp.content.startswith(b"%PDF"):
                return False
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            dest_path.write_bytes(resp.content)
            return True
    except Exception:
        return False


def _read_csv(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    """Read a CSV with UTF-8-sig encoding (handles the BOM)."""
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        return list(reader.fieldnames or []), list(reader)


# ---------------------------------------------------------------------------
# Test 1: PNG image → Qwen-VL → chart_data.csv
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_extract_chart_data_from_png_image_live(tmp_path: Path) -> None:
    """Generate a bar chart PNG and extract chart data via qwen-vl-max.

    This represents the ``web_visual_capture`` channel: the Agent has
    already produced a PNG and ``extract_chart_data_vlm`` is invoked on
    that single image. Verifies the full L1 path (no L2/L3 fallback
    expected for a clean chart image).
    """
    ctx = _make_ctx(tmp_path, "live_vlm_png")
    rc: RunContext = ctx.context

    # Place the PNG under source_assets/figures/ (mimics web_visual_capture)
    figures_dir = rc.work_dir.source_asset_file("figures/_placeholder").parent
    figures_dir.mkdir(parents=True, exist_ok=True)
    png_path = figures_dir / "fig_test_bar_chart.png"
    _generate_bar_chart_png(png_path)
    assert png_path.exists() and png_path.stat().st_size > 1000

    args = json.dumps({
        "source_path": str(png_path),
        "hint": "bar chart, 4 categories, y-axis is FPKM expression",
    })
    result = await extract_chart_data_vlm.on_invoke_tool(ctx, args)
    data = json.loads(result)

    assert data.get("status") == "ok", (
        f"qwen-vl-max live extraction failed: status={data.get('status')}, "
        f"error={data.get('error')}"
    )
    assert data["source_file"] == "fig_test_bar_chart.png"
    assert data["total_charts"] >= 1
    assert data["total_data_points"] >= 1
    assert len(data["outputs"]) == 2
    assert data["outputs"][0].endswith("chart_data.csv")
    assert data["outputs"][1].endswith("chart_data_points.csv")

    # CSV files exist on disk
    chart_csv = Path(data["outputs"][0])
    points_csv = Path(data["outputs"][1])
    assert chart_csv.exists()
    assert points_csv.exists()

    # CSV schema
    chart_cols, chart_rows = _read_csv(chart_csv)
    assert chart_cols == _CHART_DATA_COLUMNS
    assert len(chart_rows) == data["total_charts"]
    assert chart_rows[0]["chart_type"] in {"bar", "other"}
    assert chart_rows[0]["model_name"] == "qwen-vl-max"
    assert chart_rows[0]["source_asset_id"].startswith("asset_")
    assert chart_rows[0]["source_label"] == "fig_test_bar_chart.png"

    points_cols, points_rows = _read_csv(points_csv)
    assert points_cols == _CHART_DATA_POINTS_COLUMNS
    assert len(points_rows) == data["total_data_points"]
    assert all(r["chart_id"] == chart_rows[0]["chart_id"] for r in points_rows)

    # Provenance recorded in RunContext
    assert any("chart_data.csv" in p for p in rc.parsed_datasets)
    assert any("chart_data_points.csv" in p for p in rc.parsed_datasets)
    assert len(rc.query_log) == 1
    assert rc.query_log[0]["status"] == "succeeded"

    # No degradation expected on a clean chart PNG
    assert "degradation" not in data, (
        f"L1 VLM should succeed on a clean bar chart, but degraded: {data.get('degradation')}"
    )

    print(
        f"\n[Live VLM PNG] charts={data['total_charts']} "
        f"points={data['total_data_points']} "
        f"chart_type={chart_rows[0]['chart_type']} "
        f"title={chart_rows[0]['title']!r}"
    )


# ---------------------------------------------------------------------------
# Test 2: PubMed/PMC PDF → L1/L2/L3 chain → chart_data.csv
# ---------------------------------------------------------------------------


#: Stable open-access article used by test_web_visual_capture_live.py.
#: PMID 32815912 → PMC7450705 (open access). Europe PMC PDF render is
#: reachable domestically (project_memory L1: EPMC as alternative channel).
_EPMC_TEST_PMCID = "7450705"


@pytest.mark.asyncio
async def test_extract_chart_data_from_pmc_pdf_live(tmp_path: Path) -> None:
    """Download a real PMC PDF and run the L1→L2→L3 extraction chain.

    This represents the ``download_supplementary`` channel: the Agent has
    acquired a PDF from PubMed/PMC and ``extract_chart_data_vlm`` extracts
    chart/table data. The test accepts any successful tier (L1 VLM on an
    embedded figure, L2 pdfplumber tables, or L3 captions) — the goal is
    to verify end-to-end acquisition + extraction, not to force a specific
    tier.
    """
    ctx = _make_ctx(tmp_path, "live_vlm_pdf")
    rc: RunContext = ctx.context

    # Download the PDF to source_assets/ (mimics download_supplementary)
    pdf_path = rc.work_dir.source_asset_file(f"PMC{_EPMC_TEST_PMCID}.pdf")
    if not _download_epmc_pdf(_EPMC_TEST_PMCID, pdf_path):
        pytest.skip(
            f"could not download PMC{_EPMC_TEST_PMCID} PDF from Europe PMC "
            "(network unavailable or rate-limited)"
        )

    assert pdf_path.exists() and pdf_path.stat().st_size > 1000
    assert pdf_path.read_bytes()[:5] == b"%PDF-"

    args = json.dumps({
        "source_path": str(pdf_path),
        "hint": "biomedical research article, look for figures and tables",
    })
    result = await extract_chart_data_vlm.on_invoke_tool(ctx, args)
    data = json.loads(result)

    assert data.get("status") == "ok", (
        f"all extraction tiers failed for PMC{_EPMC_TEST_PMCID}: "
        f"error={data.get('error')}"
    )
    assert data["source_file"] == f"PMC{_EPMC_TEST_PMCID}.pdf"
    assert data["total_charts"] >= 1
    assert len(data["outputs"]) == 2

    chart_csv = Path(data["outputs"][0])
    points_csv = Path(data["outputs"][1])
    assert chart_csv.exists()
    assert points_csv.exists()

    chart_cols, chart_rows = _read_csv(chart_csv)
    assert chart_cols == _CHART_DATA_COLUMNS
    assert len(chart_rows) == data["total_charts"]

    # Source asset ID traces back to the PDF's sha256
    assert all(r["source_asset_id"].startswith("asset_") for r in chart_rows)
    assert all(r["source_label"] == f"PMC{_EPMC_TEST_PMCID}.pdf" for r in chart_rows)

    # model_name reflects the tier that produced the row:
    # - L1 VLM  → "qwen-vl-max"
    # - L2 table → "pdfplumber"
    # - L3 caption → "pdfplumber_captions"
    model_names = {r["model_name"] for r in chart_rows}
    valid_models = {"qwen-vl-max", "pdfplumber", "pdfplumber_captions"}
    assert model_names.issubset(valid_models), (
        f"unexpected model_name values: {model_names - valid_models}"
    )

    points_cols, points_rows = _read_csv(points_csv)
    assert points_cols == _CHART_DATA_POINTS_COLUMNS
    assert len(points_rows) == data["total_data_points"]

    # Provenance
    assert any("chart_data.csv" in p for p in rc.parsed_datasets)
    assert rc.query_log[0]["status"] == "succeeded"

    # Report which tier was used (informational; not an assertion)
    tiers = data.get("metas", [])
    tier_labels = [t.get("tier", "L1_vlm") for t in tiers]
    degradation = data.get("degradation", [])
    print(
        f"\n[Live VLM PDF] charts={data['total_charts']} "
        f"points={data['total_data_points']} "
        f"tiers={tier_labels} "
        f"degradation={degradation or 'none'} "
        f"models={model_names}"
    )
