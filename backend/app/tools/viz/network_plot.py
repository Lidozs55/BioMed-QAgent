"""PPI 网络图（protein-protein interaction network）。

用途：将 PPI 网络分析结果绘制为网络图。
输入：ppi_network.py 输出的 AnalysisResult JSON（含 nodes/edges/hub_genes）
输出：PNG 图片（10x10 inch）

节点大小 ∝ degree，hub 基因橙色，其他灰色；边透明度 ∝ score；spring_layout；标注 hub。

模块导入示例：
    from .network_plot import plot_network
    from ._base import load_json

    data = load_json("results/ppi.json")
    plot_network(data, output_path="charts/ppi.png")
"""
from ._base import (
    HUB_COLOR,
    NS_COLOR,
    save_fig,
    setup_matplotlib,
)


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


def plot_network(data, output_path, title=""):
    """绘制 PPI 网络图（spring_layout，节点大小 ∝ degree，hub 橙色）。

    Args:
        data: AnalysisResult 解析后的 dict（含 nodes/edges/hub_genes）
        output_path: 输出 PNG 图片路径
        title: 图表标题（可选，空串则用默认 "PPI Network"）

    Returns:
        dict: {"chart": output_path, "data_points": 节点数}

    Raises:
        ValueError: 输入未找到网络节点数据，或网络图为空
        ImportError: 缺少 networkx
    """
    nodes, edges, hub_genes = _extract_network(data)
    if not nodes:
        raise ValueError("输入中未找到网络节点数据")

    try:
        import networkx as nx
    except ImportError as e:
        raise ImportError("缺少 networkx，请先 pip install networkx") from e

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
        raise ValueError("网络图为空")

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
    ax.set_title(title or "PPI Network")
    ax.axis("off")
    save_fig(fig, output_path)
    return {"chart": output_path, "data_points": G.number_of_nodes()}
