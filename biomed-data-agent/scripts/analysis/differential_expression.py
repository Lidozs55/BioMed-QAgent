"""差异表达分析脚本。

输入：cleaned DataRecord 列表（fields 含 gene_symbol, log2fc, p_value）
功能：
  1. 用 statsmodels BH FDR 校正 p 值，得到 adj_p_value
  2. 标记显著基因（adj_p_value < p_threshold 且 |log2fc| > lfc_threshold）
  3. 统计上调 / 下调 / 不显著数量
  4. 生成火山图（volcano plot）数据
输出：AnalysisResult JSON
  - stats_table: 每基因 [gene_symbol, log2fc, p_value, adj_p_value, regulation]
  - chart_data: 火山图点 [{x: log2fc, y: -log10(p), gene, significant}]

用法：
    python scripts/analysis/differential_expression.py \
        --input cleaned.json --out diff_expr.json --task-id t1 \
        --p-threshold 0.05 --lfc-threshold 1.0
"""
from __future__ import annotations

import math
import sys

from _base import (
    LOG2FC_THRESHOLD,
    P_VALUE_THRESHOLD,
    load_records,
    log_stderr,
    make_result,
    save_error,
    save_result,
    setup_cli,
)


def _safe_float(v):
    """安全转 float；None / 非数 / NaN / Inf 返回 None。"""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def _regulation(lfc, adj_p, p_thr, lfc_thr):
    """根据 log2fc 与 adj_p_value 判定调控方向。"""
    if adj_p is None or lfc is None:
        return "not_significant"
    if adj_p < p_thr and abs(lfc) > lfc_thr:
        return "up" if lfc > 0 else "down"
    return "not_significant"


def _bh_fdr(pvals):
    """Benjamini-Hochberg FDR 校正，返回 adj_p_value 列表。

    优先用 statsmodels；不可用时退化为内置 BH 实现。
    """
    try:
        from statsmodels.stats.multitest import multipletests
        _, adj, _, _ = multipletests(pvals, alpha=0.05, method="fdr_bh")
        return [float(x) for x in adj]
    except Exception as e:
        log_stderr(f"statsmodels 不可用，退化为内置 BH: {e}")
        return _bh_builtin(pvals)


def _bh_builtin(pvals):
    """纯 Python 实现的 BH FDR 校正。"""
    n = len(pvals)
    if n == 0:
        return []
    order = sorted(range(n), key=lambda i: pvals[i])
    adj = [0.0] * n
    prev = 1.0
    # 从大到小累积取 min，保证单调性
    for k in range(n, 0, -1):
        idx = order[k - 1]
        val = pvals[idx] * n / k
        if val > prev:
            val = prev
        adj[idx] = min(val, 1.0)
        prev = val
    return adj


def run_diff_expression(records, p_threshold, lfc_threshold, task_id):
    """对 cleaned DataRecord 列表执行差异表达分析。"""
    rows = []
    for r in records:
        f = r.get("fields", {}) if isinstance(r, dict) else {}
        gene = f.get("gene_symbol") or f.get("gene") or f.get("symbol")
        if not gene:
            continue
        lfc = _safe_float(f.get("log2fc", f.get("log2foldchange", f.get("logFC"))))
        pv = _safe_float(f.get("p_value", f.get("pvalue")))
        if lfc is None or pv is None:
            continue
        rows.append({"gene": str(gene), "log2fc": lfc, "p_value": pv})

    if not rows:
        return make_result(
            task_id, "differential_expression",
            "无可用差异表达记录（缺少 gene_symbol/log2fc/p_value）",
            [], [], {"p_threshold": p_threshold, "lfc_threshold": lfc_threshold},
        )

    adj = _bh_fdr([r["p_value"] for r in rows])

    stats_table = []
    chart_data = []
    up = down = nonsig = 0
    for r, ap in zip(rows, adj):
        reg = _regulation(r["log2fc"], ap, p_threshold, lfc_threshold)
        if reg == "up":
            up += 1
        elif reg == "down":
            down += 1
        else:
            nonsig += 1
        stats_table.append({
            "gene_symbol": r["gene"],
            "log2fc": round(r["log2fc"], 6),
            "p_value": r["p_value"],
            "adj_p_value": ap,
            "regulation": reg,
        })
        # 火山图：y = -log10(p)，p=0 时截断避免 inf
        p_eff = max(r["p_value"], 1e-300)
        chart_data.append({
            "x": round(r["log2fc"], 6),
            "y": round(-math.log10(p_eff), 6),
            "gene": r["gene"],
            "significant": reg != "not_significant",
        })

    summary_stats = {
        "total_genes": len(rows),
        "up_regulated": up,
        "down_regulated": down,
        "not_significant": nonsig,
    }
    text = (f"差异表达分析完成：共 {len(rows)} 基因，"
            f"上调 {up}，下调 {down}，不显著 {nonsig}")
    return make_result(
        task_id, "differential_expression", text,
        stats_table, chart_data,
        {"p_threshold": p_threshold, "lfc_threshold": lfc_threshold,
         "summary": summary_stats},
    )


def main():
    parser = setup_cli("differential_expression", "差异表达分析（BH FDR 校正 + 火山图数据）")
    parser.add_argument("--p-threshold", type=float, default=P_VALUE_THRESHOLD,
                        help="adj_p_value 显著性阈值（默认 0.05）")
    parser.add_argument("--lfc-threshold", type=float, default=LOG2FC_THRESHOLD,
                        help="|log2fc| 显著性阈值（默认 1.0）")
    args = parser.parse_args()
    if not args.input:
        save_error("差异表达分析需要 --input 参数")
        sys.exit(1)
    try:
        records = load_records(args.input)
        log_stderr(f"加载 {len(records)} 条记录")
        result = run_diff_expression(records, args.p_threshold,
                                     args.lfc_threshold, args.task_id)
        save_result(result, args.out)
        log_stderr(f"差异表达结果已写入 {args.out}")
    except Exception as e:
        save_error(f"差异表达分析失败: {e}", args.out)
        sys.exit(1)


if __name__ == "__main__":
    main()
