"""Generate golden fixtures for the analysis tool migration (P5-09).

Runs the REAL Python tool implementations (backend/app/skills/builtin/analysis/
stats.py) on deterministic CSV fixtures and records their numeric output as
golden JSON, so the TypeScript implementation can be checked for parity
without scipy/pandas at test time.

Run from the repository backend/ directory (the backend venv is required):

    cd backend
    ./.venv/Scripts/python.exe ../server/tests/phase5/fixtures/analysis/generate-goldens.py

Everything lands next to this script (server/tests/phase5/fixtures/analysis/).
Re-running regenerates identical files (fully deterministic, no RNG).

Golden files produced:

    de_input.csv                              -- main DE/heatmap/correlation fixture
    differential_expression.golden.json       -- tool JSON (default thresholds)
    differential_expression_strict.golden.json-- tool JSON (0.01 / 0.5 thresholds)
    welch.golden.json                         -- raw scipy t/p per gene row
    basic_statistics.golden.json              -- pandas describe()-based summary
    correlation_{pearson,spearman,kendall}.golden.json
    heatmap_zscore.golden.json                -- z-score matrix + clustering order
    heatmap_zscore_top8.golden.json           -- max_genes=8 top-variable selection
    heatmap_nozscore.golden.json              -- raw matrix (NaN-free columns)
    de_fullset.csv / de_fullset.golden.json   -- BH-over-full-set before top_n case
"""

from __future__ import annotations

import asyncio
import csv
import json
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
from agents.tool_context import ToolContext
from scipy import stats
from scipy.cluster.hierarchy import leaves_list, linkage

FIXDIR = Path(__file__).resolve().parent
BACKEND = FIXDIR.parents[4] / "backend"
sys.path.insert(0, str(BACKEND))

from app.agent_loop.context import RunContext  # noqa: E402
from app.skills.builtin.analysis.stats import (  # noqa: E402
    _bh_adjust_pvalues,
    basic_statistics,
    generate_correlation_matrix,
    generate_heatmap,
    run_differential_expression,
)

GROUP_A = ["A_1", "A_2", "A_3", "A_4"]
GROUP_B = ["B_1", "B_2", "B_3"]
NUMERIC_COLS = GROUP_A + GROUP_B + ["S_1", "Z_1"]

# Deterministic hand-crafted rows. '' = missing; scientific-notation strings are
# written verbatim to exercise float parsing on both sides.
ROWS = [
    ("G01", ["2.31", "2.44", "1.98", "2.10"], ["3.55", "3.71", "3.62"], "2.7"),
    ("G02", ["1.20", "1.35", "", "1.28"], ["2.90", "3.05", "2.88"], "2.1e0"),
    ("G03", ["3.05", "2.98", "3.12", "3.20"], ["0.45", "0.52", "0.40"], "2.0"),
    ("G04", ["4.10", "4.22", "3.95", ""], ["5.80", "5.90", "6.10"], "5.3e0"),
    ("G05", ["2.55e0", "2.60", "2.48", "2.51"], ["3.00", "", "3.10"], "2.8"),
    ("G06", ["1.75", "1.82", "1.70", "1.88"], ["1.6e0", "1.55", "1.62"], "1.6"),
    ("G07", ["", "3.40", "3.52", "3.48"], ["4.60", "4.75", "4.52"], "4.2"),
    ("G08", ["2.05", "2.15", "1.95", "2.02"], ["3.35", "3.45", "3.28"], "2.6"),
    ("G09", ["0.95", "1.05", "9.8e-1", "1.10"], ["1.85", "1.92", ""], "1.4"),
    ("G10", ["2.70", "2.80", "2.65", "2.72"], ["3.15", "3.25", "3.3e0"], "3.1"),
    ("TP53", ["3.90", "4.05", "3.88", "4.00"], ["9.10", "9.35", "9.20"], "5.9"),
    ("TP53", ["3.92", "4.08", "3.85e0", "3.99"], ["9.15", "9.30", "9.25"], "5.8"),
    ("SPARSE", ["1.20", "", "", ""], ["0.85", "0.92", "0.88"], "1.1"),
    ("FLAT", ["3.00", "3.00", "3.00", "3.00"], ["1.00", "1.00", "1.00"], "3.5"),
]


def write_de_input() -> Path:
    dest = FIXDIR / "de_input.csv"
    with dest.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        writer.writerow(["gene"] + NUMERIC_COLS)
        for gene, a_vals, b_vals, s_val in ROWS:
            writer.writerow([gene] + a_vals + b_vals + [s_val, "2.5e0"])
    return dest


def _call(tool, task_dir: Path, **kwargs) -> dict:
    rc = RunContext(task_id="golden", work_dir_root=str(task_dir))
    ctx = ToolContext(
        context=rc,
        tool_name="stats",
        tool_call_id="golden_1",
        tool_arguments="{}",
    )
    result = asyncio.run(tool.on_invoke_tool(ctx, json.dumps(kwargs)))
    return json.loads(result)


def _heatmap_internals(csv_file: Path, max_genes: int, zscore: bool,
                       columns: list[str] | None) -> dict:
    """Replicate the generate_heatmap matrix/clustering pipeline (the part the
    tool does not return) and cross-check with scipy + seaborn semantics."""
    df = pd.read_csv(csv_file)
    resolved_gene = "gene"
    if columns is None:
        numeric_cols = [c for c in df.select_dtypes(include=[np.number]).columns
                        if c != resolved_gene]
    else:
        numeric_cols = columns
    subset = df[[resolved_gene] + numeric_cols].copy()
    subset[numeric_cols] = subset[numeric_cols].apply(pd.to_numeric,
                                                      errors="coerce", axis=0)
    subset = subset.dropna(subset=numeric_cols, how="all")
    if len(subset) > max_genes:
        stds = np.nanstd(subset[numeric_cols].values, axis=1)
        assert len(set(np.round(stds, 9))) == len(stds), "std ties — fixture fix"
        top_indices = np.argsort(stds)[::-1][:max_genes]
        subset = subset.iloc[top_indices]
    matrix = subset.set_index(resolved_gene)[numeric_cols].astype(float)
    values = matrix.values.copy()
    if zscore:
        row_means = np.nanmean(values, axis=1, keepdims=True)
        row_stds = np.nanstd(values, axis=1, ddof=0, keepdims=True)
        row_stds[row_stds == 0] = np.nan
        values = (values - row_means) / row_stds
        values = np.nan_to_num(values, nan=0.0)
    row_order = None
    col_order = None
    if len(subset) > 1:
        zr = linkage(values, method="average", metric="euclidean")
        _assert_distinct(zr, "rows")
        row_order = [int(i) for i in leaves_list(zr)]
    if len(numeric_cols) > 1:
        zc = linkage(values.T, method="average", metric="euclidean")
        _assert_distinct(zc, "cols")
        col_order = [int(i) for i in leaves_list(zc)]
    return {
        "display_genes": [str(g) for g in matrix.index.tolist()],
        "columns_used": list(numeric_cols),
        "row_order": row_order,
        "col_order": col_order,
        "matrix": [[round(float(v), 12) for v in row] for row in values],
    }


def _assert_distinct(z, label: str) -> None:
    heights = [float(h) for h in z[:, 2]]
    diffs = [b - a for a, b in zip(heights, heights[1:])]
    assert all(d > 1e-7 for d in diffs), f"linkage tie risk in {label}: {heights}"


def main() -> None:
    csv_file = write_de_input()
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = Path(tmp)

        # --- differential expression (default + strict thresholds) ---------
        for suffix, pth, fct in (
            ("", 0.05, 1.0),
            ("_strict", 0.01, 0.5),
        ):
            data = _call(
                run_differential_expression, task_dir,
                csv_path=str(csv_file),
                group_a_cols=GROUP_A, group_b_cols=GROUP_B,
                gene_col="gene",
                pval_threshold=pth, log2fc_threshold=fct, top_n=100,
            )
            assert data["status"] == "ok", data
            golden = {
                "gene_column": data["gene_column"],
                "row_count": data["row_count"],
                "group_a_count": data["group_a_count"],
                "group_b_count": data["group_b_count"],
                "significant_up": data["significant_up"],
                "significant_down": data["significant_down"],
                "pval_threshold": data["pval_threshold"],
                "log2fc_threshold": data["log2fc_threshold"],
                "degs": data["degs"],
            }
            (FIXDIR / f"differential_expression{suffix}.golden.json").write_text(
                json.dumps(golden, indent=1, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )

        # --- raw Welch t/p per gene row (full precision scipy oracle) ------
        df = pd.read_csv(csv_file)
        welch_rows = []
        for _, row in df.iterrows():
            a_vals = [float(v) for v in row[GROUP_A].dropna()]
            b_vals = [float(v) for v in row[GROUP_B].dropna()]
            if (len(a_vals) >= 2 and len(b_vals) >= 2
                    and np.std(a_vals) > 0 and np.std(b_vals) > 0):
                t, p = stats.ttest_ind(
                    np.array(a_vals), np.array(b_vals), equal_var=False)
                t_out, p_out = float(t), float(p)
            else:
                t_out, p_out = None, 1.0
            welch_rows.append({
                "gene": str(row["gene"]),
                "a": a_vals,
                "b": b_vals,
                "t": t_out,
                "p": p_out,
            })
        (FIXDIR / "welch.golden.json").write_text(
            json.dumps({"genes": welch_rows}, indent=1) + "\n", encoding="utf-8")

        # --- basic statistics -------------------------------------------------
        data = _call(basic_statistics, task_dir, csv_path=str(csv_file))
        assert data["status"] == "ok", data
        (FIXDIR / "basic_statistics.golden.json").write_text(
            json.dumps({
                "total_rows": data["total_rows"],
                "columns_analyzed": data["columns_analyzed"],
                "summary": data["summary"],
            }, indent=1) + "\n", encoding="utf-8")

        # --- correlation matrices (pandas .corr) ------------------------------
        for method in ("pearson", "spearman", "kendall"):
            data = _call(generate_correlation_matrix, task_dir,
                         csv_path=str(csv_file), method=method)
            assert data["status"] == "ok", data
            corr = df[NUMERIC_COLS].corr(method=method)
            (FIXDIR / f"correlation_{method}.golden.json").write_text(
                json.dumps({
                    "columns": list(corr.columns),
                    "values": [[None if pd.isna(v) else float(v)
                                for v in row] for row in corr.values],
                }, indent=1) + "\n", encoding="utf-8")

        # --- heatmap goldens ---------------------------------------------------
        for name, max_genes, zscore, columns in (
            ("heatmap_zscore", 50, True, None),
            ("heatmap_zscore_top8", 8, True, None),
            ("heatmap_nozscore", 50, False, ["B_1", "S_1", "Z_1"]),
        ):
            data = _call(generate_heatmap, task_dir, csv_path=str(csv_file),
                         columns=columns, max_genes=max_genes, zscore=zscore)
            assert data["status"] == "ok", data
            internals = _heatmap_internals(csv_file, max_genes, zscore, columns)
            (FIXDIR / f"{name}.golden.json").write_text(
                json.dumps({
                    "rows_displayed": data["rows_displayed"],
                    "total_rows_in_csv": data["total_rows_in_csv"],
                    "columns_used": data["columns_used"],
                    "zscore": data["zscore"],
                    **internals,
                }, indent=1) + "\n", encoding="utf-8")

        # --- BH-over-full-set before top_n (12-gene mirror of the Python test)
        fullset_rows = {
            "G01": ([1.0, 2.0], [5.0, 6.0]),
            "G02": ([1.0, 2.0], [4.0, 5.0]),
            "G03": ([1.0, 2.0], [3.0, 4.0]),
            "G04": ([1.0, 2.0], [2.0, 3.0]),
            "G05": ([1.0, 2.0], [1.5, 2.5]),
            "G06": ([5.0, 6.0], [1.0, 2.0]),
            "G07": ([4.0, 5.0], [1.0, 2.0]),
            "G08": ([3.0, 4.0], [1.0, 2.0]),
            "G09": ([2.0, 3.0], [1.0, 2.0]),
            "G10": ([2.0, 2.0], [2.0, 2.0]),
            "G11": ([3.0, 3.0], [4.0, 4.0]),
            "G12": ([5.0, 5.0], [5.0, 5.0]),
        }
        fullset_path = FIXDIR / "de_fullset.csv"
        with fullset_path.open("w", newline="", encoding="utf-8") as fh:
            writer = csv.writer(fh, lineterminator="\n")
            writer.writerow(["gene", "a1", "a2", "b1", "b2"])
            for gene, (a, b) in fullset_rows.items():
                writer.writerow([gene, a[0], a[1], b[0], b[1]])
        fdf = pd.read_csv(fullset_path)
        full_pvals = []
        for _, row in fdf.iterrows():
            a_vals = row[["a1", "a2"]].dropna().values.astype(float)
            b_vals = row[["b1", "b2"]].dropna().values.astype(float)
            if (len(a_vals) >= 2 and len(b_vals) >= 2
                    and np.std(a_vals) > 0 and np.std(b_vals) > 0):
                _, p = stats.ttest_ind(a_vals, b_vals, equal_var=False)
                full_pvals.append(float(p))
            else:
                full_pvals.append(1.0)
        full_padj = _bh_adjust_pvalues(full_pvals)
        data = _call(run_differential_expression, task_dir,
                     csv_path=str(fullset_path),
                     group_a_cols=["a1", "a2"], group_b_cols=["b1", "b2"],
                     gene_col="gene", top_n=3)
        assert data["status"] == "ok", data
        (FIXDIR / "de_fullset.golden.json").write_text(
            json.dumps({
                "row_count": data["row_count"],
                "degs": data["degs"],
                "pvalues_all": full_pvals,
                "padj_all": full_padj,
            }, indent=1) + "\n", encoding="utf-8")

    print("goldens written to", FIXDIR)


if __name__ == "__main__":
    main()
