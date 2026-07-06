"""富集气泡图（GO/KEGG enrichment）。

用途：将富集分析 top20 通路绘制为气泡图。
输入：enrichment.py 输出的 AnalysisResult JSON（含 term/p_value/overlap）
输出：PNG 图片（12x8 inch）

X=gene_ratio，Y=term name，气泡大小=gene count，颜色=-log10(p_value)。
执行示例：
  python scripts/viz/enrichment_bubble.py --input results/enrichment.json --out charts/enrichment.png
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
from _base import setup_matplotlib, save_fig, load_json, setup_cli, emit_ok, emit_error


def _extract_terms(data):
    """从 AnalysisResult JSON 中提取通路列表。"""
    if isinstance(data, dict):
        for key in ("terms", "pathways", "results"):
            if key in data and isinstance(data[key], list):
                return data[key]
        result = data.get("result") or data.get("analysis_result") or {}
        if isinstance(result, dict):
            for key in ("terms", "pathways", "results"):
                if key in result and isinstance(result[key], list):
                    return result[key]
    return []


def _pval(t):
    """安全提取 p_value 并转 float。"""
    for k in ("p_value", "pvalue", "adj_p_value", "fdr"):
        v = t.get(k)
        if v is not None:
            try:
                return float(v)
            except (TypeError, ValueError):
                continue
    return 1.0


def main():
    args = setup_cli("enrichment_bubble", "富集气泡图").parse_args()
    try:
        data = load_json(args.input)
    except Exception as e:
        emit_error(f"读取输入失败: {e}")
    terms = _extract_terms(data)
    if not terms:
        emit_error("输入中未找到通路数据")

    # 取 top 20（按 p_value 升序）
    terms = sorted(terms, key=_pval)[:20]

    plt = setup_matplotlib()
    import numpy as np

    names, ratios, counts, neglog = [], [], [], []
    for t in terms:
        name = t.get("term", t.get("name", t.get("description", t.get("pathway", ""))))
        overlap = t.get("overlap", t.get("genes", []))
        if isinstance(overlap, str):  # 形如 "5/100"
            parts = overlap.split("/")
            ov = int(parts[0]) if parts[0].isdigit() else len(overlap.split(","))
            total = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
        elif isinstance(overlap, (list, tuple)):
            ov = len(overlap)
            total = t.get("total_genes", t.get("gene_list_size", 0))
        else:
            ov = t.get("gene_count", 0)
            total = t.get("total_genes", 0)
        gc = t.get("gene_count", t.get("count", ov))
        ratio = (ov / total) if total else float(ov)
        names.append(str(name)[:60])
        ratios.append(ratio)
        counts.append(max(int(gc) if gc else ov, 1))
        neglog.append(-np.log10(max(_pval(t), 1e-300)))

    if not names:
        emit_error("无有效通路")

    order = list(range(len(names)))[::-1]  # Y 轴倒序，最大通路在顶部
    fig, ax = plt.subplots(figsize=(12, 8))
    sc = ax.scatter(ratios, order, s=[c * 30 + 20 for c in counts], c=neglog,
                    cmap="RdYlBu_r", alpha=0.85, edgecolors="grey", linewidths=0.5)
    ax.set_yticks(order)
    ax.set_yticklabels([names[i] for i in order], fontsize=8)
    ax.set_xlabel("Gene Ratio")
    ax.set_title(args.title or "Enrichment Bubble Plot")
    cbar = fig.colorbar(sc, ax=ax, shrink=0.6)
    cbar.set_label("-log10(p_value)")
    save_fig(fig, args.out)
    emit_ok(args.out, data_points=len(names))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        emit_error(f"运行失败: {e}")
