"""火山图（差异表达可视化）。

用途：将差异表达分析结果绘制为火山图，X=log2fc，Y=-log10(adj_p_value)。
输入：differential_expression.py 输出的 AnalysisResult JSON（含 gene/log2fc/adj_p_value）
输出：PNG 图片（10x7 inch）

上调基因红色，下调蓝色，不显著灰色；阈值线 ±1 与 -log10(0.05)；标注 top10 显著基因。
执行示例：
  python scripts/viz/volcano_plot.py --input results/diff_expr.json --out charts/volcano.png
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
from _base import (setup_matplotlib, save_fig, load_json, setup_cli,
                   emit_ok, emit_error, UP_COLOR, DOWN_COLOR, NS_COLOR)


def _extract_genes(data):
    """从 AnalysisResult JSON 中提取基因列表，兼容 result.genes / records 等结构。"""
    if isinstance(data, dict):
        for key in ("genes", "de_genes", "results"):
            if key in data and isinstance(data[key], list):
                return data[key]
        result = data.get("result") or data.get("analysis_result") or {}
        if isinstance(result, dict):
            for key in ("genes", "de_genes", "results"):
                if key in result and isinstance(result[key], list):
                    return result[key]
        if isinstance(data.get("records"), list):
            return [r.get("fields", r) for r in data["records"]]
    return []


def _num(g, *keys):
    """从基因 dict 中按候选键取首个可转 float 的值。"""
    for k in keys:
        if g.get(k) is not None:
            try:
                return float(g[k])
            except (TypeError, ValueError):
                continue
    return None


def main():
    args = setup_cli("volcano_plot", "火山图（差异表达可视化）").parse_args()
    try:
        data = load_json(args.input)
    except Exception as e:
        emit_error(f"读取输入失败: {e}")
    genes = _extract_genes(data)
    if not genes:
        emit_error("输入中未找到基因数据（需含 log2fc / adj_p_value 字段）")

    plt = setup_matplotlib()
    import numpy as np

    xs, ys, colors = [], [], []
    for g in genes:
        x = _num(g, "log2fc", "log2FoldChange", "logFC")
        padj = _num(g, "adj_p_value", "padj", "fdr", "p_value")
        if x is None or padj is None:
            continue
        xs.append(x)
        ys.append(-np.log10(max(padj, 1e-300)))
        if padj < 0.05 and x > 1:
            colors.append(UP_COLOR)
        elif padj < 0.05 and x < -1:
            colors.append(DOWN_COLOR)
        else:
            colors.append(NS_COLOR)

    if not xs:
        emit_error("无有效数据点（log2fc 或 adj_p_value 缺失/非数值）")

    fig, ax = plt.subplots(figsize=(10, 7))
    ax.scatter(xs, ys, c=colors, s=18, alpha=0.7, edgecolors="none")
    ax.axvline(1, ls="--", color="grey", lw=0.8)
    ax.axvline(-1, ls="--", color="grey", lw=0.8)
    ax.axhline(-np.log10(0.05), ls="--", color="grey", lw=0.8)
    ax.set_xlabel("log2 Fold Change")
    ax.set_ylabel("-log10(adj_p_value)")
    ax.set_title(args.title or "Volcano Plot")

    # 标注 top10 显著基因（按 adj_p_value 升序）
    sig = sorted([g for g in genes if _num(g, "adj_p_value", "padj", "fdr", "p_value") is not None],
                 key=lambda g: _num(g, "adj_p_value", "padj", "fdr", "p_value"))[:10]
    for g in sig:
        name = g.get("gene", g.get("gene_symbol", g.get("symbol", "")))
        x = _num(g, "log2fc", "log2FoldChange", "logFC")
        padj = _num(g, "adj_p_value", "padj", "fdr", "p_value")
        if name and x is not None and padj is not None:
            ax.annotate(str(name), (x, -np.log10(max(padj, 1e-300))), fontsize=7, alpha=0.85)

    save_fig(fig, args.out)
    emit_ok(args.out, data_points=len(xs))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        emit_error(f"运行失败: {e}")
