"""Tests for the analysis skill — basic_statistics, heatmap, correlation, DE."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills.builtin.analysis.stats import (
    basic_statistics,
    generate_correlation_matrix,
    generate_heatmap,
    run_differential_expression,
)


def _make_ctx(task_id: str = "test_stats") -> ToolContext:
    rc = RunContext(task_id=task_id)
    return ToolContext(
        context=rc,
        tool_name="basic_statistics",
        tool_call_id="test_call_1",
        tool_arguments="{}",
    )


def _write_csv(tmp_path: Path, name: str = "data.csv") -> Path:
    """Create a small CSV with numeric columns for testing."""
    csv_path = tmp_path / name
    csv_path.write_text(
        "gene,sample1,sample2,sample3,sample4\n"
        "BRCA1,1.0,2.0,1.5,3.0\n"
        "TP53,5.0,6.0,5.5,7.0\n"
        "EGFR,3.0,4.0,3.5,4.5\n"
        "MYC,2.0,3.0,2.5,3.5\n"
        "KRAS,4.0,5.0,4.5,5.5\n",
        encoding="utf-8",
    )
    return csv_path


def _call(tool, task_id: str, **kwargs) -> dict[str, Any]:
    ctx = _make_ctx(task_id=task_id)
    args = json.dumps(kwargs)
    result = asyncio.run(tool.on_invoke_tool(ctx, args))
    return json.loads(result)


# ---------------------------------------------------------------------------
# basic_statistics
# ---------------------------------------------------------------------------


def test_basic_statistics_success(tmp_path: Path) -> None:
    """basic_statistics returns stats summary for numeric columns."""
    csv_path = _write_csv(tmp_path)
    data = _call(
        basic_statistics,
        task_id="test_stats_basic",
        csv_path=str(csv_path),
    )
    assert data["status"] == "ok"
    assert data["total_rows"] == 5
    assert "sample1" in data["columns_analyzed"]
    assert "summary" in data
    assert "sample1" in data["summary"]
    assert "mean" in data["summary"]["sample1"]
    assert "median" in data["summary"]["sample1"]
    # stats_report CSV should be generated
    assert data["stats_report"]
    assert Path(data["stats_report"]).exists()


def test_basic_statistics_file_not_found() -> None:
    """basic_statistics returns error JSON for non-existent file."""
    data = _call(
        basic_statistics,
        task_id="test_stats_nofile",
        csv_path="/nonexistent/file.csv",
    )
    assert data["status"] == "error"
    assert "error" in data


def test_basic_statistics_empty_csv(tmp_path: Path) -> None:
    """basic_statistics returns error JSON for empty CSV."""
    csv_path = tmp_path / "empty.csv"
    csv_path.write_text("", encoding="utf-8")
    data = _call(
        basic_statistics,
        task_id="test_stats_empty",
        csv_path=str(csv_path),
    )
    assert data["status"] == "error"
    assert "error" in data


# ---------------------------------------------------------------------------
# generate_heatmap
# ---------------------------------------------------------------------------


def test_generate_heatmap_success(tmp_path: Path) -> None:
    """generate_heatmap creates a PNG file in artifacts/."""
    csv_path = _write_csv(tmp_path)
    data = _call(
        generate_heatmap,
        task_id="test_stats_heatmap",
        csv_path=str(csv_path),
    )
    assert data["status"] == "ok"
    assert data["heatmap_png"]
    assert Path(data["heatmap_png"]).exists()
    assert data["heatmap_png"].endswith(".png")


# ---------------------------------------------------------------------------
# generate_correlation_matrix
# ---------------------------------------------------------------------------


def test_generate_correlation_matrix_success(tmp_path: Path) -> None:
    """generate_correlation_matrix creates a PNG file in artifacts/."""
    csv_path = _write_csv(tmp_path)
    data = _call(
        generate_correlation_matrix,
        task_id="test_stats_corr",
        csv_path=str(csv_path),
    )
    assert data["status"] == "ok"
    assert data["correlation_png"]
    assert Path(data["correlation_png"]).exists()
    assert data["correlation_png"].endswith(".png")


# ---------------------------------------------------------------------------
# run_differential_expression
# ---------------------------------------------------------------------------


def test_run_differential_expression_success(tmp_path: Path) -> None:
    """run_differential_expression returns DE results with volcano plot."""
    csv_path = _write_csv(tmp_path)
    data = _call(
        run_differential_expression,
        task_id="test_stats_de",
        csv_path=str(csv_path),
        group_a_cols=["sample1", "sample2"],
        group_b_cols=["sample3", "sample4"],
        gene_col="gene",
    )
    assert data["status"] == "ok"
    assert data["gene_column"] == "gene"
    assert data["row_count"] == 5
    assert "degs" in data
    assert isinstance(data["degs"], list)
    # volcano plot should be generated
    assert data["volcano_plot"]
    assert Path(data["volcano_plot"]).exists()


def test_run_differential_expression_has_padj(tmp_path: Path) -> None:
    """run_differential_expression outputs BH-FDR-adjusted padj per DEG."""
    csv_path = _write_csv(tmp_path)
    data = _call(
        run_differential_expression,
        task_id="test_stats_de_padj",
        csv_path=str(csv_path),
        group_a_cols=["sample1", "sample2"],
        group_b_cols=["sample3", "sample4"],
        gene_col="gene",
    )
    assert data["status"] == "ok"
    assert data["fdr_method"] == "Benjamini–Hochberg"
    assert len(data["degs"]) == 5
    for deg in data["degs"]:
        assert "padj" in deg
        assert 0.0 <= deg["padj"] <= 1.0
        assert deg["padj"] >= deg["pvalue"]  # FDR 校正不会使 p 值变小


def test_bh_fdr_monotonic_and_capped() -> None:
    """_bh_fdr returns monotonic adjusted p-values capped at 1.0."""
    from app.skills.builtin.analysis.stats import _bh_fdr

    pvals = [0.001, 0.01, 0.02, 0.05, 0.1, 0.5]
    padj = _bh_fdr(pvals)
    assert len(padj) == len(pvals)
    # 校正后按原 p 顺序应单调不减
    by_p = sorted(zip(pvals, padj, strict=False))
    for (_, pa_prev), (_, pa_cur) in zip(by_p, by_p[1:], strict=False):
        assert pa_cur >= pa_prev - 1e-12
    for pa in padj:
        assert 0.0 <= pa <= 1.0
    # 最大 p 的 padj 通常为 1.0（BH 性质）
    assert padj[pvals.index(max(pvals))] == 1.0


def test_bh_fdr_empty() -> None:
    """_bh_fdr handles empty input."""
    from app.skills.builtin.analysis.stats import _bh_fdr

    assert _bh_fdr([]) == []
