"""表达热图（expression matrix heatmap）。

用途：对基因表达矩阵绘制热图，行=基因，列=样本，z-score 中心化，双向聚类。
输入：cleaned DataRecord JSON（含 expression_matrix 字段）或 GEO SOFT parser 输出
输出：PNG 图片（12x10 inch）

颜色映射 RdBu_r（红高蓝低），seaborn clustermap 行+列聚类。
样本数 < 2 或数据缺失时输出错误。
执行示例：
  python scripts/viz/heatmap.py --input results/geo_expr.json --out charts/heatmap.png
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
from _base import setup_matplotlib, save_fig, load_json, setup_cli, emit_ok, emit_error


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


def main():
    args = setup_cli("heatmap", "表达热图").parse_args()
    try:
        data = load_json(args.input)
    except Exception as e:
        emit_error(f"读取输入失败: {e}")
    mat = _extract_matrix(data)
    if not mat:
        emit_error("输入中未找到 expression_matrix（需含 genes/samples/values）")

    genes = mat.get("genes", [])
    samples = mat.get("samples", [])
    values = mat.get("values", [])
    if not genes or not samples or not values:
        emit_error("表达矩阵字段缺失或不完整")
    if len(values) < 1 or len(values[0]) < 2:
        emit_error("样本数 < 2，无法绘制热图")

    setup_matplotlib()
    import numpy as np
    import pandas as pd
    try:
        import seaborn as sns
    except ImportError:
        emit_error("缺少 seaborn，请先 pip install seaborn")

    arr = np.array(values, dtype=float)
    df = pd.DataFrame(arr, index=genes, columns=samples)
    # z_score=0 按行（基因）中心化，center=0 红蓝居中
    g = sns.clustermap(df, cmap="RdBu_r", center=0, z_score=0,
                       figsize=(12, 10), xticklabels=True, yticklabels=True,
                       dendrogram_ratio=(0.1, 0.1), cbar_pos=(0.02, 0.82, 0.03, 0.15))
    g.fig.suptitle(args.title or "Expression Heatmap", y=1.02)
    save_fig(g.fig, args.out)
    emit_ok(args.out, data_points=len(genes) * len(samples))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        emit_error(f"运行失败: {e}")
