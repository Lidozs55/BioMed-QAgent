"""Tests for the analysis skill — basic_statistics, heatmap, correlation, DE."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills.builtin.analysis.stats import (
    _bh_adjust_pvalues,
    basic_statistics,
    generate_correlation_matrix,
    generate_heatmap,
    run_differential_expression,
)
from scipy import stats
from scipy.stats import false_discovery_control


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


# ---------------------------------------------------------------------------
# run_differential_expression — BH FDR correction (padj, TODO §2.7.4)
# ---------------------------------------------------------------------------


def test_bh_adjust_pvalues_hand_computed() -> None:
    """BH step-up matches the textbook hand computation (TODO §2.7.4).

    Hand computation for ps = [0.01, 0.02, 0.03, 0.05, 0.20], m = 5.
    Sort ascending, then q(i) = p(i) * m / i:
        q(1) = 0.01 * 5/1 = 0.0500
        q(2) = 0.02 * 5/2 = 0.0500
        q(3) = 0.03 * 5/3 = 0.0500
        q(4) = 0.05 * 5/4 = 0.0625
        q(5) = 0.20 * 5/5 = 0.2000
    Enforce monotonicity from the largest (q(i) = min(q(i), q(i+1))):
        [0.0500, 0.0500, 0.0500, 0.0625, 0.2000]
    """
    assert _bh_adjust_pvalues([0.01, 0.02, 0.03, 0.05, 0.20]) == pytest.approx(
        [0.05, 0.05, 0.05, 0.0625, 0.20]
    )
    # Output preserves input order (not sorted)
    assert _bh_adjust_pvalues([0.20, 0.01, 0.05, 0.03, 0.02]) == pytest.approx(
        [0.20, 0.05, 0.0625, 0.05, 0.05]
    )


def test_bh_adjust_pvalues_matches_scipy_oracle() -> None:
    """Manual BH agrees with scipy.stats.false_discovery_control (independent oracle)."""
    ps = [
        0.0001, 0.0004, 0.0019, 0.0095, 0.0201, 0.0278, 0.0298, 0.0344,
        0.0459, 0.3240, 0.4262, 0.5719, 0.6528, 0.7590, 1.0,
    ]
    expected = false_discovery_control(np.array(ps)).tolist()
    assert _bh_adjust_pvalues(ps) == pytest.approx(expected)


def test_bh_adjust_pvalues_degenerate_inputs() -> None:
    """Empty / single / identical / tiny-N inputs are NaN-safe and never crash."""
    assert _bh_adjust_pvalues([]) == []
    assert _bh_adjust_pvalues([0.01]) == pytest.approx([0.01])
    # Hand computation for ps = [0.01, 0.04], m = 2:
    #   q(1) = 0.01 * 2/1 = 0.02 ; q(2) = 0.04 * 2/2 = 0.04
    assert _bh_adjust_pvalues([0.01, 0.04]) == pytest.approx([0.02, 0.04])
    # All-identical p-values: BH leaves them unchanged (q(i) >= p, min at i = m)
    assert _bh_adjust_pvalues([0.05] * 5) == pytest.approx([0.05] * 5)
    # Non-finite inputs are clamped to 1.0 ("no significance") — never NaN/Inf
    assert _bh_adjust_pvalues([float("nan"), 0.01]) == pytest.approx([1.0, 0.02])
    assert _bh_adjust_pvalues([float("inf")]) == [1.0]
    # Adjusted values are capped at 1.0 (same final clip as scipy)
    assert _bh_adjust_pvalues([0.01, 0.9]) == pytest.approx([0.02, 0.9])


def test_de_entries_carry_padj(tmp_path: Path) -> None:
    """Every DEG entry gains a BH-adjusted padj with 0 <= padj <= 1."""
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
    assert data["degs"]
    for deg in data["degs"]:
        assert "padj" in deg
        assert 0.0 <= deg["padj"] <= 1.0
        # BH-adjusted values are never smaller than the raw p-value
        assert deg["padj"] >= deg["pvalue"]


def test_de_padj_computed_over_all_genes_before_truncation(tmp_path: Path) -> None:
    """Top-N truncation carries padj from the FULL-set BH adjustment.

    Builds 12 genes, requests top_n=3, and independently recomputes every
    per-gene p-value (scipy t-test on the CSV data, same rule as the tool),
    then applies BH over ALL 12 p-values via scipy.  Each returned DEG's padj
    must equal the full-set adjustment for that gene — not a top-3-only
    adjustment (which would be ~4x smaller).
    """
    a_cols, b_cols = ["a1", "a2"], ["b1", "b2"]
    rows = {
        "G01": ([1.0, 2.0], [5.0, 6.0]),
        "G02": ([1.0, 2.0], [4.0, 5.0]),
        "G03": ([1.0, 2.0], [3.0, 4.0]),
        "G04": ([1.0, 2.0], [2.0, 3.0]),
        "G05": ([1.0, 2.0], [1.5, 2.5]),
        "G06": ([5.0, 6.0], [1.0, 2.0]),
        "G07": ([4.0, 5.0], [1.0, 2.0]),
        "G08": ([3.0, 4.0], [1.0, 2.0]),
        "G09": ([2.0, 3.0], [1.0, 2.0]),
        "G10": ([2.0, 2.0], [2.0, 2.0]),  # zero variance -> p = 1.0 fallback
        "G11": ([3.0, 3.0], [4.0, 4.0]),  # zero variance -> p = 1.0 fallback
        "G12": ([5.0, 5.0], [5.0, 5.0]),  # zero variance -> p = 1.0 fallback
    }
    lines = ["gene,a1,a2,b1,b2"]
    for gene, (a, b) in rows.items():
        lines.append(f"{gene},{a[0]},{a[1]},{b[0]},{b[1]}")
    csv_path = tmp_path / "de_fullset.csv"
    csv_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    data = _call(
        run_differential_expression,
        task_id="test_stats_de_fullset",
        csv_path=str(csv_path),
        group_a_cols=a_cols,
        group_b_cols=b_cols,
        gene_col="gene",
        top_n=3,
    )
    assert data["status"] == "ok"
    assert data["row_count"] == 12
    assert len(data["degs"]) == 3  # top-N truncation active (3 < 12)

    # Independent oracle: recompute p-values and BH over the FULL 12-gene set
    df = pd.read_csv(csv_path)
    full_pvals: dict[str, float] = {}
    for _, row in df.iterrows():
        a_vals = row[a_cols].dropna().values.astype(float)
        b_vals = row[b_cols].dropna().values.astype(float)
        if (
            len(a_vals) >= 2 and len(b_vals) >= 2
            and np.std(a_vals) > 0 and np.std(b_vals) > 0
        ):
            _, p = stats.ttest_ind(a_vals, b_vals, equal_var=False)
        else:
            p = 1.0
        full_pvals[str(row["gene"])] = float(p)
    oracle_padj = dict(
        zip(
            full_pvals.keys(),
            false_discovery_control(np.array(list(full_pvals.values()))).tolist(),
            strict=False,
        )
    )

    for deg in data["degs"]:
        gene = deg["gene"]
        assert deg["pvalue"] == pytest.approx(full_pvals[gene], abs=1e-6)
        assert deg["padj"] == pytest.approx(oracle_padj[gene], abs=1e-6)


def test_de_two_genes_only(tmp_path: Path) -> None:
    """Minimal 2-gene dataset still yields padj (BH over m = 2)."""
    csv_path = tmp_path / "de_two_genes.csv"
    csv_path.write_text(
        "gene,a1,a2,b1,b2\n"
        "G1,1.0,2.0,5.0,6.0\n"
        "G2,3.0,4.0,1.0,2.0\n",
        encoding="utf-8",
    )
    data = _call(
        run_differential_expression,
        task_id="test_stats_de_two_genes",
        csv_path=str(csv_path),
        group_a_cols=["a1", "a2"],
        group_b_cols=["b1", "b2"],
        gene_col="gene",
    )
    assert data["status"] == "ok"
    assert data["row_count"] == 2
    assert len(data["degs"]) == 2
    for deg in data["degs"]:
        assert "padj" in deg
        assert 0.0 <= deg["padj"] <= 1.0


def test_de_identical_pvalues_padj_equals_pvalue(tmp_path: Path) -> None:
    """Identical p-values -> padj == pvalue (BH minimum is at i = m)."""
    csv_path = tmp_path / "de_identical.csv"
    csv_path.write_text(
        "gene,a1,a2,b1,b2\n"
        "G1,1.0,3.0,2.0,4.0\n"
        "G2,2.0,4.0,1.0,3.0\n"  # group-swap of G1 -> identical p-value
        "G3,1.0,3.0,2.0,4.0\n",  # duplicate of G1 -> identical p-value
        encoding="utf-8",
    )
    data = _call(
        run_differential_expression,
        task_id="test_stats_de_identical",
        csv_path=str(csv_path),
        group_a_cols=["a1", "a2"],
        group_b_cols=["b1", "b2"],
        gene_col="gene",
    )
    assert data["status"] == "ok"
    assert len(data["degs"]) == 3
    assert len({d["pvalue"] for d in data["degs"]}) == 1
    for deg in data["degs"]:
        assert deg["padj"] == deg["pvalue"]


def test_de_single_sample_group_padj_safe(tmp_path: Path) -> None:
    """Single-sample groups fall back to p = 1.0; padj stays NaN-safe."""
    csv_path = tmp_path / "de_single_sample.csv"
    csv_path.write_text(
        "gene,a1,b1\n"
        "G1,1.0,5.0\n"
        "G2,2.0,6.0\n"
        "G3,3.0,7.0\n",
        encoding="utf-8",
    )
    data = _call(
        run_differential_expression,
        task_id="test_stats_de_single_sample",
        csv_path=str(csv_path),
        group_a_cols=["a1"],
        group_b_cols=["b1"],
        gene_col="gene",
    )
    assert data["status"] == "ok"
    assert len(data["degs"]) == 3
    for deg in data["degs"]:
        assert deg["pvalue"] == 1.0
        assert deg["padj"] == 1.0


def test_de_empty_group_raises(tmp_path: Path) -> None:
    """Empty group column lists still fail with a clear error (unchanged)."""
    csv_path = _write_csv(tmp_path)
    data = _call(
        run_differential_expression,
        task_id="test_stats_de_empty_group",
        csv_path=str(csv_path),
        group_a_cols=[],
        group_b_cols=["sample3", "sample4"],
        gene_col="gene",
    )
    assert data["status"] == "error"
    assert "at least one column" in data["error"]


def test_de_missing_group_column_raises(tmp_path: Path) -> None:
    """Unknown group columns still fail with a clear error (unchanged)."""
    csv_path = _write_csv(tmp_path)
    data = _call(
        run_differential_expression,
        task_id="test_stats_de_missing_col",
        csv_path=str(csv_path),
        group_a_cols=["sample1", "nope"],
        group_b_cols=["sample3", "sample4"],
        gene_col="gene",
    )
    assert data["status"] == "error"
    assert "group A columns not found" in data["error"]
