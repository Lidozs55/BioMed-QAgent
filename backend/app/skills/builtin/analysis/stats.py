"""Analysis skill — differential expression, heatmaps, statistics, and correlation on tabular data.

Reads CSV datasets from task/parsed/ (or any path), performs analysis,
writes chart PNGs and reports to task/artifacts/, and returns structured JSON
with metadata.
"""
from __future__ import annotations

import json
import logging
import math
import warnings
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Literal

import matplotlib
import numpy as np
import pandas as pd

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402  — must follow .use('Agg')
import seaborn as sns  # noqa: E402
from agents import RunContextWrapper, function_tool
from matplotlib.figure import Figure
from scipy import stats

from app.agent_loop.context import RunContext
from app.skills.registry import SkillCategory, SkillDef, skill_registry


def _safe_float(value: Any, digits: int = 4) -> float | None:
    """Convert to float and round; return None for NaN/Inf/None (RFC 7159 safety)."""
    if value is None:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(result) or math.isinf(result):
        return None
    return round(result, digits)


logger = logging.getLogger(__name__)

_PNG_DPI = 150
_PNG_KWARGS: dict[str, Any] = {"dpi": _PNG_DPI, "bbox_inches": "tight"}

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _resolve_path(path: str) -> Path:
    """Return absolute Path, resolving user-expandable prefixes."""
    return Path(path).expanduser().resolve()


def _validate_csv(path: Path) -> pd.DataFrame:
    """Read CSV and validate minimum viability.

    Returns DataFrame.  Raises ValueError with user-facing message on failure.
    """
    if not path.exists():
        raise ValueError(f"file not found: {path}")
    if path.stat().st_size == 0:
        raise ValueError(f"file is empty: {path}")

    df = pd.read_csv(path)
    if df.empty:
        raise ValueError(f"CSV has no rows: {path}")
    if len(df.columns) == 0:
        raise ValueError(f"CSV has no columns: {path}")
    return df


def _identify_gene_col(df: pd.DataFrame, gene_col: str | None) -> str:
    """Resolve the gene/symbol column.

    If *gene_col* is given and exists, return it.  Otherwise auto-detect from
    common names ('gene_symbol', 'Gene', 'Symbol', 'gene', 'ID', the first
    non-numeric column).
    """
    if gene_col and gene_col in df.columns:
        return gene_col

    candidates = ["gene_symbol", "Gene", "Symbol", "gene", "ID"]
    for col in candidates:
        if col in df.columns:
            return col

    # First non-numeric string column
    for col in df.columns:
        if df[col].dtype == object:
            return col

    raise ValueError(
        "Cannot identify gene identifier column. "
        "Please specify with gene_col= parameter."
    )


def _select_numeric_columns(
    df: pd.DataFrame, columns: list[str] | None, gene_col: str
) -> list[str]:
    """Return list of numeric column names to use for analysis.

    If *columns* is None, auto-select all numeric columns except *gene_col*.
    """
    if columns is None:
        return [
            c for c in df.select_dtypes(include=[np.number]).columns
            if c != gene_col
        ]
    # Validate user-provided columns
    missing = [c for c in columns if c not in df.columns]
    if missing:
        raise ValueError(f"columns not found in CSV: {missing}")
    return columns


def _save_png(fig: Figure, artifacts_dir: Path, filename: str) -> Path:
    """Save figure to *artifacts_dir* as PNG and close it."""
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    dest = artifacts_dir / filename
    fig.savefig(dest, **_PNG_KWARGS)
    plt.close(fig)
    return dest


def _bh_adjust_pvalues(pvals: Sequence[float]) -> list[float]:
    """Benjamini-Hochberg FDR-adjusted p-values (BH step-up), order-preserving.

    For m raw p-values sorted ascending p(1) <= ... <= p(m), the BH step-up
    sets q(i) = min(1, p(i) * m / i) and then enforces monotonicity from the
    largest: q(i) = min(q(i), q(i+1)).  Returns adjusted values in the same
    order as the input (not sorted), matching
    scipy.stats.false_discovery_control(method="bh").

    Degenerate inputs are safe and never crash:
      - empty input -> []
      - single value -> [min(1, p)]
      - all-identical p-values -> unchanged (the BH minimum sits at i = m)
      - non-finite values (NaN/Inf) are clamped to 1.0 ("no significance"),
        so the helper never emits NaN/Inf in the adjusted output

    Args:
        pvals: Raw p-values in [0, 1] (any order).

    Returns:
        BH-adjusted p-values, one per input value, in input order.
    """
    n = len(pvals)
    if n == 0:
        return []
    values = [1.0 if not math.isfinite(p) else float(p) for p in pvals]
    if n == 1:
        return [min(1.0, values[0])]
    order = sorted(range(n), key=lambda i: (values[i], i))
    adjusted = [min(1.0, values[i] * n / (rank + 1)) for rank, i in enumerate(order)]
    for rank in range(n - 2, -1, -1):
        if adjusted[rank + 1] < adjusted[rank]:
            adjusted[rank] = adjusted[rank + 1]
    result = [0.0] * n
    for rank, i in enumerate(order):
        result[i] = adjusted[rank]
    return result


# ---------------------------------------------------------------------------
# Tool 1 — Differential Expression
# ---------------------------------------------------------------------------


@function_tool
def run_differential_expression(
    ctx: RunContextWrapper[Any],
    csv_path: str,
    group_a_cols: list[str],
    group_b_cols: list[str],
    gene_col: str = "",
    pval_threshold: float = 0.05,
    log2fc_threshold: float = 1.0,
    top_n: int = 100,
) -> str:
    """Perform differential expression analysis between two sample groups.

    Reads a gene expression CSV (rows=genes, columns=samples), computes
    log2 fold-change and p-values via two-sided Welch's t-test, applies
    Benjamini-Hochberg FDR correction (padj), and generates a volcano plot
    saved to task/artifacts/.

    Args:
        ctx: Run context (injected by SDK).
        csv_path: Path to the CSV file (absolute or relative).
        group_a_cols: Column names belonging to group A (e.g. control).
        group_b_cols: Column names belonging to group B (e.g. treatment).
        gene_col: Column containing gene identifiers.  Auto-detected if empty.
        pval_threshold: P-value cutoff for significance (default 0.05).
        log2fc_threshold: Absolute log2 fold-change cutoff (default 1.0).
        top_n: Number of top DEGs to include in returns (default 100).

    Returns:
        JSON with keys:
            status           — "ok" or "error"
            source_file      — resolved CSV path
            row_count        — total genes tested
            group_a_count    — number of samples in group A
            group_b_count    — number of samples in group B
            significant_up   — count of up-regulated DEGs
            significant_down — count of down-regulated DEGs
            degs             — list of top DEG entries (gene, log2FC, pvalue,
                                padj, neg_log10_pval, significant); ranked by
                                raw p-value, padj is the BH FDR-adjusted
                                p-value computed over ALL tested genes
            volcano_plot     — path to PNG in artifacts/
            outputs          — list of artifact file paths
            error            — present only on failure
    """
    run_ctx: RunContext = ctx.context
    artifacts_dir = run_ctx.work_dir.artifacts

    try:
        csv_file = _resolve_path(csv_path)
        df = _validate_csv(csv_file)

        # Resolve gene column
        resolved_gene = _identify_gene_col(df, gene_col or None)

        # Validate group columns
        missing_a = [c for c in group_a_cols if c not in df.columns]
        missing_b = [c for c in group_b_cols if c not in df.columns]
        if missing_a:
            raise ValueError(f"group A columns not found: {missing_a}")
        if missing_b:
            raise ValueError(f"group B columns not found: {missing_b}")

        if len(group_a_cols) < 1 or len(group_b_cols) < 1:
            raise ValueError("both groups must have at least one column")

        # Extract numeric expression matrices
        group_a = df[group_a_cols].apply(pd.to_numeric, errors="coerce")
        group_b = df[group_b_cols].apply(pd.to_numeric, errors="coerce")

        # Compute statistics per gene (row-wise vectorized where possible)
        log2fc_list: list[float] = []
        pval_list: list[float] = []
        genes: list[str] = df[resolved_gene].astype(str).tolist()

        for idx in range(len(df)):
            a_vals = group_a.iloc[idx].dropna().values.astype(float)
            b_vals = group_b.iloc[idx].dropna().values.astype(float)

            # Compute log2FC: log2(mean_B + 1) - log2(mean_A + 1)
            mean_a = np.mean(a_vals) if len(a_vals) > 0 else 0.0
            mean_b = np.mean(b_vals) if len(b_vals) > 0 else 0.0
            pseudo = 1.0  # avoid log(0)
            log2fc = np.log2(max(mean_b + pseudo, 1e-9)) - np.log2(max(mean_a + pseudo, 1e-9))
            log2fc_list.append(log2fc)

            # Welch's t-test (requires at least 2 values per group)
            if len(a_vals) >= 2 and len(b_vals) >= 2 and np.std(a_vals) > 0 and np.std(b_vals) > 0:
                t_stat, p_val = stats.ttest_ind(a_vals, b_vals, equal_var=False)
                pval_list.append(float(p_val))
            else:
                pval_list.append(1.0)

        # Count significant DEGs
        sig_up = int(sum(
            1 for fc, p in zip(log2fc_list, pval_list, strict=False)
            if float(p) <= pval_threshold and float(fc) >= log2fc_threshold
        ))
        sig_down = int(sum(
            1 for fc, p in zip(log2fc_list, pval_list, strict=False)
            if float(p) <= pval_threshold and float(fc) <= -log2fc_threshold
        ))

        # BH FDR correction over the FULL p-value set (all genes tested),
        # before any top-N truncation.  Ranking stays on the raw p-value;
        # padj is reported alongside for multiplicity-aware significance.
        padj_list = _bh_adjust_pvalues(pval_list)

        # Build top DEG list sorted by p-value
        deg_records = sorted(
            [
                {
                    "gene": str(g),
                    "log2FC": round(float(fc), 4),
                    "pvalue": round(float(pv), 6),
                    "padj": round(float(adj), 6),
                    "neg_log10_pval": round(float(-np.log10(max(float(pv), 1e-300))), 4),
                    "significant": bool(
                        float(pv) <= pval_threshold and abs(float(fc)) >= log2fc_threshold
                    ),
                }
                for g, fc, pv, adj in zip(
                    genes, log2fc_list, pval_list, padj_list, strict=False
                )
            ],
            key=lambda x: x["pvalue"],
        )[:top_n]

        # --- Volcano plot ---
        fig, ax = plt.subplots(figsize=(10, 7))
        neg_log_pvals = [-np.log10(max(p, 1e-300)) for p in pval_list]

        # Non-significant
        ns_mask = [
            not (pv <= pval_threshold and abs(fc) >= log2fc_threshold)
            for pv, fc in zip(pval_list, log2fc_list, strict=False)
        ]
        ax.scatter(
            [fc for fc, m in zip(log2fc_list, ns_mask, strict=False) if m],
            [nlp for nlp, m in zip(neg_log_pvals, ns_mask, strict=False) if m],
            s=8, c="grey", alpha=0.5, label="NS",
        )
        # Up-regulated
        up_mask = [
            pv <= pval_threshold and fc >= log2fc_threshold
            for pv, fc in zip(pval_list, log2fc_list, strict=False)
        ]
        ax.scatter(
            [fc for fc, m in zip(log2fc_list, up_mask, strict=False) if m],
            [nlp for nlp, m in zip(neg_log_pvals, up_mask, strict=False) if m],
            s=12, c="red", alpha=0.7, label=f"Up ({sig_up})",
        )
        # Down-regulated
        down_mask = [
            pv <= pval_threshold and fc <= -log2fc_threshold
            for pv, fc in zip(pval_list, log2fc_list, strict=False)
        ]
        ax.scatter(
            [fc for fc, m in zip(log2fc_list, down_mask, strict=False) if m],
            [nlp for nlp, m in zip(neg_log_pvals, down_mask, strict=False) if m],
            s=12, c="blue", alpha=0.7, label=f"Down ({sig_down})",
        )
        ax.axhline(-np.log10(pval_threshold), color="grey", linestyle="--", linewidth=0.8)
        ax.axvline(log2fc_threshold, color="grey", linestyle="--", linewidth=0.8)
        ax.axvline(-log2fc_threshold, color="grey", linestyle="--", linewidth=0.8)
        ax.set_xlabel("log₂ Fold Change")
        ax.set_ylabel("-log₁₀(p-value)")
        ax.set_title(
            f"Volcano Plot\n"
            f"Up: {sig_up}  |  Down: {sig_down}  "
            f"(p < {pval_threshold}, |log₂FC| > {log2fc_threshold})"
        )
        ax.legend(loc="best", fontsize=9)
        fig.tight_layout()

        volcano_filename = "volcano_plot.png"
        volcano_path = _save_png(fig, artifacts_dir, volcano_filename)

        outputs = [str(volcano_path)]

        return json.dumps({
            "status": "ok",
            "source_file": str(csv_file),
            "gene_column": resolved_gene,
            "row_count": len(df),
            "group_a_count": len(group_a_cols),
            "group_b_count": len(group_b_cols),
            "significant_up": sig_up,
            "significant_down": sig_down,
            "pval_threshold": pval_threshold,
            "log2fc_threshold": log2fc_threshold,
            "degs": deg_records,
            "volcano_plot": str(volcano_path),
            "outputs": outputs,
        }, ensure_ascii=False)

    except Exception as exc:
        logger.exception("run_differential_expression failed")
        return json.dumps({
            "status": "error",
            "source_file": csv_path,
            "row_count": 0,
            "group_a_count": 0,
            "group_b_count": 0,
            "significant_up": 0,
            "significant_down": 0,
            "degs": [],
            "volcano_plot": "",
            "outputs": [],
            "error": str(exc),
        }, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool 2 — Heatmap
# ---------------------------------------------------------------------------


@function_tool
def generate_heatmap(
    ctx: RunContextWrapper[Any],
    csv_path: str,
    columns: list[str] | None = None,
    gene_col: str = "",
    max_genes: int = 50,
    zscore: bool = True,
    cluster_rows: bool = True,
    cluster_cols: bool = True,
    cmap: str = "RdBu_r",
) -> str:
    """Generate a clustered heatmap from tabular gene expression data.

    Reads a CSV, selects numeric columns (all if *columns* is None), optionally
    applies z-score normalization per row, and renders a seaborn clustermap
    saved to task/artifacts/.

    Args:
        ctx: Run context (injected by SDK).
        csv_path: Path to the CSV file.
        columns: Specific sample columns to include (None → all numeric).
        gene_col: Column with gene identifiers. Auto-detected if empty.
        max_genes: Cap on number of rows displayed (default 50).
        zscore: Apply z-score normalization per row (default True).
        cluster_rows: Whether to cluster rows (default True).
        cluster_cols: Whether to cluster columns (default True).
        cmap: Matplotlib colormap name (default "RdBu_r").

    Returns:
        JSON with keys:
            status        — "ok" or "error"
            source_file   — resolved CSV path
            rows_displayed — number of genes in the heatmap
            columns_used  — sample columns included
            zscore        — whether z-score normalization was applied
            heatmap_png   — path to PNG in artifacts/
            outputs       — list of artifact file paths
            error         — present only on failure
    """
    run_ctx: RunContext = ctx.context
    artifacts_dir = run_ctx.work_dir.artifacts

    try:
        csv_file = _resolve_path(csv_path)
        df = _validate_csv(csv_file)

        resolved_gene = _identify_gene_col(df, gene_col or None)
        numeric_cols = _select_numeric_columns(df, columns, resolved_gene)

        if len(numeric_cols) < 2:
            raise ValueError(
                f"Need at least 2 numeric columns; found {len(numeric_cols)}"
            )

        # Subset and prepare matrix
        use_cols = [resolved_gene] + numeric_cols
        subset = df[use_cols].copy()
        # Ensure numeric columns are float (force DataFrame for single-col case)
        subset[numeric_cols] = subset[numeric_cols].apply(
            pd.to_numeric, errors="coerce", axis=0,
        )

        # Drop rows where ALL numeric values are NA
        subset = subset.dropna(subset=numeric_cols, how="all")

        # Limit number of genes
        if len(subset) > max_genes:
            # Select top variable genes (by standard deviation)
            # Double-bracket to keep DataFrame even with 1 numeric col
            subset_values = subset[numeric_cols].values
            stds = np.nanstd(subset_values, axis=1)
            top_indices = np.argsort(stds)[::-1][:max_genes]
            subset = subset.iloc[top_indices]

        display_rows = len(subset)

        # Build matrix
        matrix = subset.set_index(resolved_gene)[numeric_cols].astype(float)

        # Z-score normalization per row
        if zscore:
            values = matrix.values
            row_means = np.nanmean(values, axis=1, keepdims=True)
            row_stds = np.nanstd(values, axis=1, ddof=0, keepdims=True)
            row_stds[row_stds == 0] = np.nan
            values = (values - row_means) / row_stds
            values = np.nan_to_num(values, nan=0.0)
            matrix = pd.DataFrame(values, index=matrix.index, columns=matrix.columns)

        # --- Clustermap ---
        row_cluster = cluster_rows and display_rows > 1
        col_cluster = cluster_cols and len(numeric_cols) > 1

        g = sns.clustermap(
            matrix,
            cmap=cmap,
            row_cluster=row_cluster,
            col_cluster=col_cluster,
            figsize=(max(8, len(numeric_cols) * 0.5), max(6, display_rows * 0.3)),
            xticklabels=True,
            yticklabels=(display_rows <= 80),
            dendrogram_ratio=(0.1, 0.05),
            cbar_pos=(0.02, 0.8, 0.03, 0.15),
        )
        g.ax_heatmap.set_xlabel("Samples")
        g.ax_heatmap.set_ylabel("Genes")
        title = "Clustered Heatmap"
        if zscore:
            title += " (Z-score normalized)"
        g.fig.suptitle(title, y=1.02, fontsize=13)

        heatmap_filename = "heatmap.png"
        heatmap_path = _save_png(g.fig, artifacts_dir, heatmap_filename)

        outputs = [str(heatmap_path)]

        return json.dumps({
            "status": "ok",
            "source_file": str(csv_file),
            "gene_column": resolved_gene,
            "rows_displayed": display_rows,
            "total_rows_in_csv": len(df),
            "columns_used": numeric_cols,
            "zscore": zscore,
            "heatmap_png": str(heatmap_path),
            "outputs": outputs,
        }, ensure_ascii=False)

    except Exception as exc:
        logger.exception("generate_heatmap failed")
        return json.dumps({
            "status": "error",
            "source_file": csv_path,
            "rows_displayed": 0,
            "columns_used": [],
            "zscore": zscore,
            "heatmap_png": "",
            "outputs": [],
            "error": str(exc),
        }, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool 3 — Basic Statistics
# ---------------------------------------------------------------------------


@function_tool
def basic_statistics(
    ctx: RunContextWrapper[Any],
    csv_path: str,
    columns: list[str] | None = None,
) -> str:
    """Compute descriptive statistics for numeric columns in a CSV.

    Calculates mean, median, standard deviation, min, max, quartiles, and
    missing-value counts per column.  Saves a summary report CSV to
    task/artifacts/.

    Args:
        ctx: Run context (injected by SDK).
        csv_path: Path to the CSV file.
        columns: Specific columns to analyze (None → all numeric).

    Returns:
        JSON with keys:
            status       — "ok" or "error"
            source_file  — resolved CSV path
            total_rows   — row count of the full CSV
            columns_analyzed — list of column names
            stats_report — path to CSV report in artifacts/
            summary      — dict with column-level stats arrays
            outputs      — list of artifact file paths
            error        — present only on failure
    """
    run_ctx: RunContext = ctx.context
    artifacts_dir = run_ctx.work_dir.artifacts

    try:
        csv_file = _resolve_path(csv_path)
        df = _validate_csv(csv_file)

        if columns is None:
            num_cols = [
                c for c in df.select_dtypes(include=[np.number]).columns
            ]
        else:
            missing = [c for c in columns if c not in df.columns]
            if missing:
                raise ValueError(f"columns not found in CSV: {missing}")
            num_cols = [c for c in columns if pd.api.types.is_numeric_dtype(df[c])]

        if not num_cols:
            raise ValueError("no numeric columns found to analyze")

        stats_rows: list[dict[str, Any]] = []
        summary: dict[str, dict[str, float]] = {}

        for col in num_cols:
            series = df[col]
            desc = series.describe()
            missing_count = int(series.isna().sum())
            missing_pct = round(missing_count / len(df) * 100, 2)

            col_stats = {
                "column": col,
                "count": int(desc.get("count", 0)),
                "mean": _safe_float(desc.get("mean")),
                "std": _safe_float(desc.get("std")),
                "min": _safe_float(desc.get("min")),
                "q25": _safe_float(desc.get("25%")),
                "median": _safe_float(desc.get("50%")),
                "q75": _safe_float(desc.get("75%")),
                "max": _safe_float(desc.get("max")),
                "missing": missing_count,
                "missing_pct": missing_pct,
            }
            stats_rows.append(col_stats)
            summary[col] = col_stats

        # Save stats report CSV
        report_df = pd.DataFrame(stats_rows)
        report_path = artifacts_dir / "stats_report.csv"
        report_df.to_csv(report_path, index=False)

        outputs = [str(report_path)]

        return json.dumps({
            "status": "ok",
            "source_file": str(csv_file),
            "total_rows": len(df),
            "columns_analyzed": num_cols,
            "stats_report": str(report_path),
            "summary": summary,
            "outputs": outputs,
        }, ensure_ascii=False)

    except Exception as exc:
        logger.exception("basic_statistics failed")
        return json.dumps({
            "status": "error",
            "source_file": csv_path,
            "total_rows": 0,
            "columns_analyzed": [],
            "stats_report": "",
            "summary": {},
            "outputs": [],
            "error": str(exc),
        }, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool 4 — Correlation Matrix
# ---------------------------------------------------------------------------


@function_tool
def generate_correlation_matrix(
    ctx: RunContextWrapper[Any],
    csv_path: str,
    columns: list[str] | None = None,
    method: Literal["pearson", "spearman", "kendall"] = "pearson",
    cmap: str = "coolwarm",
) -> str:
    """Compute pairwise correlation matrix for numeric columns and save a heatmap.

    Calculates Pearson (or Spearman) correlation between numeric columns,
    renders a heatmap, and saves the PNG to task/artifacts/.

    Args:
        ctx: Run context (injected by SDK).
        csv_path: Path to the CSV file.
        columns: Columns to include (None → all numeric).
        method: Correlation method — "pearson" or "spearman" (default "pearson").
        cmap: Matplotlib colormap for the heatmap (default "coolwarm").

    Returns:
        JSON with keys:
            status            — "ok" or "error"
            source_file       — resolved CSV path
            method            — correlation method used
            columns_used      — column names included
            correlation_png   — path to PNG in artifacts/
            outputs           — list of artifact file paths
            error             — present only on failure
    """
    run_ctx: RunContext = ctx.context
    artifacts_dir = run_ctx.work_dir.artifacts

    try:
        csv_file = _resolve_path(csv_path)
        df = _validate_csv(csv_file)

        if columns is None:
            num_cols = [
                c for c in df.select_dtypes(include=[np.number]).columns
            ]
        else:
            missing = [c for c in columns if c not in df.columns]
            if missing:
                raise ValueError(f"columns not found in CSV: {missing}")
            num_cols = [c for c in columns if pd.api.types.is_numeric_dtype(df[c])]

        if len(num_cols) < 2:
            raise ValueError(
                f"Need at least 2 numeric columns for correlation; "
                f"found {len(num_cols)}"
            )

        # Compute correlation matrix
        corr_df = df[num_cols].corr(method=method)

        # --- Heatmap ---
        fig, ax = plt.subplots(figsize=(max(8, len(num_cols) * 0.8),
                                        max(6, len(num_cols) * 0.7)))
        mask = np.triu(np.ones_like(corr_df, dtype=bool), k=1) if len(num_cols) > 1 else None
        with warnings.catch_warnings():
            warnings.filterwarnings(
                "ignore",
                message=r"The set_bad function will be deprecated.*",
                category=PendingDeprecationWarning,
                module=r"seaborn\.matrix",
            )
            sns.heatmap(
                corr_df,
                annot=(len(num_cols) <= 20),
                fmt=".2f",
                cmap=cmap,
                mask=mask,
                center=0,
                vmin=-1,
                vmax=1,
                square=True,
                linewidths=0.5,
                cbar_kws={"shrink": 0.8},
                ax=ax,
            )
        ax.set_title(
            f"{method.capitalize()} Correlation Matrix ({len(num_cols)} variables)",
            fontsize=13,
        )
        fig.tight_layout()

        corr_filename = "correlation_matrix.png"
        corr_path = _save_png(fig, artifacts_dir, corr_filename)

        outputs = [str(corr_path)]

        return json.dumps({
            "status": "ok",
            "source_file": str(csv_file),
            "method": method,
            "columns_used": num_cols,
            "correlation_png": str(corr_path),
            "outputs": outputs,
        }, ensure_ascii=False)

    except Exception as exc:
        logger.exception("generate_correlation_matrix failed")
        return json.dumps({
            "status": "error",
            "source_file": csv_path,
            "method": method,
            "columns_used": [],
            "correlation_png": "",
            "outputs": [],
            "error": str(exc),
        }, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Skill registration
# ---------------------------------------------------------------------------

analysis_skill = SkillDef(
    name="analysis",
    category=SkillCategory.ANALYSIS,
    description=(
        "Statistical analysis and visualization for tabular biomedical data. "
        "Use when the user needs differential expression analysis, heatmaps, "
        "volcano plots, basic descriptive statistics, or correlation matrices "
        "on CSV datasets."
    ),
    instructions=(
        "Use the analysis tools to perform statistical computations and "
        "generate publication-quality visualizations. "
        "run_differential_expression computes log2 fold-changes and "
        "Benjamini-Hochberg FDR-adjusted p-values (`padj`) between two "
        "sample groups with a volcano plot. "
        "generate_heatmap creates clustered heatmaps with optional z-score "
        "normalization. basic_statistics produces descriptive stats "
        "(mean/median/std/min/max/missing counts) per column. "
        "generate_correlation_matrix computes Pearson or Spearman correlation "
        "between numeric columns and renders a heatmap. "
        "All outputs (PNGs, CSVs) are saved to the task artifacts directory."
    ),
    tools=[
        run_differential_expression,
        generate_heatmap,
        basic_statistics,
        generate_correlation_matrix,
    ],
    supported_sources=["csv", "tabular"],
    version="0.1.0",
)

skill_registry.register(analysis_skill)
