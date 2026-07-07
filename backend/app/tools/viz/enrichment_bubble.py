"""富集气泡图（GO/KEGG enrichment）。

用途：将富集分析 top20 通路绘制为气泡图。
输入：enrichment.py 输出的 AnalysisResult JSON（含 term/p_value/overlap）
输出：PNG 图片（12x8 inch）

X=gene_ratio，Y=term name，气泡大小=gene count，颜色=-log10(p_value)。

模块导入示例：
    from .enrichment_bubble import plot_enrichment_bubble
    from ._base import load_json

    data = load_json("results/enrichment.json")
    plot_enrichment_bubble(data, output_path="charts/enrichment.png")
"""
from ._base import save_fig, setup_matplotlib


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


def plot_enrichment_bubble(data, output_path, title=""):
    """绘制富集气泡图（取 top20 通路，按 p_value 升序）。

    Args:
        data: AnalysisResult 解析后的 dict（含 term/p_value/overlap）
        output_path: 输出 PNG 图片路径
        title: 图表标题（可选，空串则用默认 "Enrichment Bubble Plot"）

    Returns:
        dict: {"chart": output_path, "data_points": N}

    Raises:
        ValueError: 输入未找到通路数据，或无有效通路
    """
    terms = _extract_terms(data)
    if not terms:
        raise ValueError("输入中未找到通路数据")

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
        raise ValueError("无有效通路")

    order = list(range(len(names)))[::-1]  # Y 轴倒序，最大通路在顶部
    fig, ax = plt.subplots(figsize=(12, 8))
    sc = ax.scatter(ratios, order, s=[c * 30 + 20 for c in counts], c=neglog,
                    cmap="RdYlBu_r", alpha=0.85, edgecolors="grey", linewidths=0.5)
    ax.set_yticks(order)
    ax.set_yticklabels([names[i] for i in order], fontsize=8)
    ax.set_xlabel("Gene Ratio")
    ax.set_title(title or "Enrichment Bubble Plot")
    cbar = fig.colorbar(sc, ax=ax, shrink=0.6)
    cbar.set_label("-log10(p_value)")
    save_fig(fig, output_path)
    return {"chart": output_path, "data_points": len(names)}
