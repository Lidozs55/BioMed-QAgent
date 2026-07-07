"""表达热图（expression matrix heatmap）。

用途：对基因表达矩阵绘制热图，行=基因，列=样本，z-score 中心化，双向聚类。
输入：cleaned DataRecord JSON（含 expression_matrix 字段）或 GEO SOFT parser 输出
输出：PNG 图片（12x10 inch）

颜色映射 RdBu_r（红高蓝低），seaborn clustermap 行+列聚类。
样本数 < 2 或数据缺失时抛出 ValueError。

模块导入示例：
    from .heatmap import plot_heatmap
    from ._base import load_json

    data = load_json("results/geo_expr.json")
    plot_heatmap(data, output_path="charts/heatmap.png")
"""
from ._base import save_fig, setup_matplotlib


def _extract_matrix(data):
    """递归从输入 JSON 中提取表达矩阵 {genes, samples, values}。"""
    def _find(obj):
        if isinstance(obj, dict):
            if isinstance(obj.get("expression_matrix"), dict):
                return obj["expression_matrix"]
            if "genes" in obj and "samples" in obj and "values" in obj:
                return obj
            for v in obj.values():
                found = _find(v)
                if found:
                    return found
        return None
    return _find(data)


def plot_heatmap(data, output_path, title=""):
    """绘制表达热图（seaborn clustermap，行/列双向聚类，z-score 按行中心化）。

    Args:
        data: 输入 JSON 解析后的 dict（需含 expression_matrix.genes/samples/values）
        output_path: 输出 PNG 图片路径
        title: 图表标题（可选，空串则用默认 "Expression Heatmap"）

    Returns:
        dict: {"chart": output_path, "data_points": 基因数 × 样本数}

    Raises:
        ValueError: 输入未找到 expression_matrix，字段缺失，或样本数 < 2
        ImportError: 缺少 seaborn
    """
    mat = _extract_matrix(data)
    if not mat:
        raise ValueError("输入中未找到 expression_matrix（需含 genes/samples/values）")

    genes = mat.get("genes", [])
    samples = mat.get("samples", [])
    values = mat.get("values", [])
    if not genes or not samples or not values:
        raise ValueError("表达矩阵字段缺失或不完整")
    if len(values) < 1 or len(values[0]) < 2:
        raise ValueError("样本数 < 2，无法绘制热图")

    setup_matplotlib()
    import numpy as np
    import pandas as pd
    try:
        import seaborn as sns
    except ImportError as e:
        raise ImportError("缺少 seaborn，请先 pip install seaborn") from e

    arr = np.array(values, dtype=float)
    df = pd.DataFrame(arr, index=genes, columns=samples)
    # z_score=0 按行（基因）中心化，center=0 红蓝居中
    g = sns.clustermap(df, cmap="RdBu_r", center=0, z_score=0,
                       figsize=(12, 10), xticklabels=True, yticklabels=True,
                       dendrogram_ratio=(0.1, 0.1), cbar_pos=(0.02, 0.82, 0.03, 0.15))
    g.fig.suptitle(title or "Expression Heatmap", y=1.02)
    save_fig(g.fig, output_path)
    return {"chart": output_path, "data_points": len(genes) * len(samples)}
