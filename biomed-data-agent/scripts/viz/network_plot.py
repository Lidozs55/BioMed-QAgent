"""PPI 网络图（protein-protein interaction network）。

用途：将 PPI 网络分析结果绘制为网络图。
输入：ppi_network.py 输出的 AnalysisResult JSON（含 nodes/edges/hub_genes）
输出：PNG 图片（10x10 inch）

节点大小 ∝ degree，hub 基因橙色，其他灰色；边透明度 ∝ score；spring_layout；标注 hub。
执行示例：
  python scripts/viz/network_plot.py --input results/ppi.json --out charts/ppi.png
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
from _base import (setup_matplotlib, save_fig, load_json, setup_cli,
                   emit_ok, emit_error, HUB_COLOR, NS_COLOR)


def _extract_network(data):
    """从 AnalysisResult JSON 中提取 {nodes, edges, hub_genes}。"""
    if isinstance(data, dict):
        result = data.get("result") or data.get("analysis_result") or data
        nodes = result.get("nodes", [])
        edges = result.get("edges", result.get("interactions", []))
        hub = result.get("hub_genes", [])
        return nodes, edges, hub
    return [], [], []


def _node_name(n):
    """从节点 dict 中提取名称。"""
    return n.get("gene", n.get("id", n.get("name", "")))


def main():
    args = setup_cli("network_plot", "PPI 网络图").parse_args()
    try:
        data = load_json(args.input)
    except Exception as e:
        emit_error(f"读取输入失败: {e}")
    nodes, edges, hub_genes = _extract_network(data)
    if not nodes:
        emit_error("输入中未找到网络节点数据")

    try:
        import networkx as nx
    except ImportError:
        emit_error("缺少 networkx，请先 pip install networkx")

    plt = setup_matplotlib()
    G = nx.Graph()
    hub_set = set(hub_genes)
    # 添加节点
    for n in nodes:
        name = _node_name(n)
        if name:
            G.add_node(name, degree=n.get("degree", 0))
    # 兜底：hub_genes 为空时按 degree 取前 10% 作为 hub
    if not hub_set and nodes:
        deg_sorted = sorted(nodes, key=lambda x: x.get("degree", 0), reverse=True)
        top_n = max(1, len(deg_sorted) // 10)
        hub_set = {_node_name(n) for n in deg_sorted[:top_n] if _node_name(n)}

    # 添加边（score 用于透明度）
    for e in edges:
        s = e.get("source", e.get("from", e.get("a", "")))
        t = e.get("target", e.get("to", e.get("b", "")))
        try:
            score = float(e.get("score", e.get("combined_score", e.get("confidence", 0.5))))
        except (TypeError, ValueError):
            score = 0.5
        if s and t:
            G.add_edge(s, t, score=score)

    if G.number_of_nodes() == 0:
        emit_error("网络图为空")

    pos = nx.spring_layout(G, k=1.0 / (len(G) ** 0.5 + 1), iterations=50, seed=42)
    degrees = dict(G.degree())
    sizes = [max(degrees.get(n, 1), 1) * 80 + 50 for n in G.nodes()]
    node_colors = [HUB_COLOR if n in hub_set else NS_COLOR for n in G.nodes()]

    fig, ax = plt.subplots(figsize=(10, 10))
    # 绘制边（透明度 ∝ score）
    for (u, v, d) in G.edges(data=True):
        s = d.get("score", 0.5)
        nx.draw_networkx_edges(G, pos, edgelist=[(u, v)],
                               alpha=min(max(s, 0.1), 1.0), width=0.6, ax=ax)
    nx.draw_networkx_nodes(G, pos, node_size=sizes, node_color=node_colors,
                           alpha=0.85, edgecolors="white", linewidths=0.5, ax=ax)
    # 仅标注 hub 基因
    labels = {n: n for n in G.nodes() if n in hub_set}
    nx.draw_networkx_labels(G, pos, labels=labels, font_size=8, font_color="black", ax=ax)
    ax.set_title(args.title or "PPI Network")
    ax.axis("off")
    save_fig(fig, args.out)
    emit_ok(args.out, data_points=G.number_of_nodes())


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        emit_error(f"运行失败: {e}")
