"""PPI 网络分析脚本（基于 STRING API + networkx）。

输入：gene 列表（从 DataRecord 提取 gene_symbol，或 --gene-list 直接指定）
功能：
  1. 调用 STRING /api/json/network 获取互作边（species 默认 9606 人）
  2. 用 networkx 构建 PPI 网络
  3. 计算每节点 degree / betweenness / closeness
  4. 识别 hub genes（degree top 10%）
  5. 识别连通模块（connected_components）
输出：AnalysisResult JSON
  - stats_table: 每节点 [gene, degree, betweenness, closeness, is_hub]
  - chart_data: {nodes: [{id, degree, is_hub}], edges: [{source, target, score}]}

STRING 不可用时降级：标记 ppi_unavailable；networkx 不可用时降级为边列表。

用法：
    python scripts/analysis/ppi_network.py \
        --input cleaned.json --out ppi.json --task-id t1 \
        --species 9606 --score-threshold 0.4
    python scripts/analysis/ppi_network.py \
        --gene-list TP53,EGFR,KRAS --out ppi.json
"""
from __future__ import annotations

import sys

from _base import (
    extract_genes,
    load_records,
    log_stderr,
    make_result,
    save_error,
    save_result,
    setup_cli,
)

STRING_NETWORK_URL = "https://string-db.org/api/json/network"
HEADERS = {"User-Agent": "BioMedQAgent/1.0"}


def _fetch_string_edges(genes, species, score_threshold):
    """调用 STRING network API 获取互作边。

    STRING 支持换行分隔（%0d）的多蛋白 identifiers 查询。
    required_score 取阈值 * 1000（medium=400）。
    """
    import requests
    identifiers = "%0d".join(genes)
    params = {
        "identifiers": identifiers,
        "species": species,
        "required_score": int(score_threshold * 1000),
        "caller_identity": "BioMedQAgent",
    }
    r = requests.get(STRING_NETWORK_URL, params=params,
                     headers=HEADERS, timeout=120)
    r.raise_for_status()
    return r.json() or []


def _build_graph(edges):
    """用 networkx 构建无向图；不可用时返回 (None, None) 触发降级。"""
    try:
        import networkx as nx
        G = nx.Graph()
        for e in edges:
            a = e.get("preferredName_A") or e.get("stringId_A")
            b = e.get("preferredName_B") or e.get("stringId_B")
            if not a or not b:
                continue
            score = float(e.get("score", 0.0))
            G.add_node(a)
            G.add_node(b)
            G.add_edge(a, b, score=score)
        return G, nx
    except Exception as ex:
        log_stderr(f"networkx 不可用，降级为边列表: {ex}")
        return None, None


def _degrade_edges_only(edges_raw):
    """networkx 不可用时的降级：仅输出边列表与节点集。"""
    edge_list = []
    node_set = set()
    for e in edges_raw:
        a = e.get("preferredName_A") or e.get("stringId_A")
        b = e.get("preferredName_B") or e.get("stringId_B")
        if a and b:
            node_set.update([a, b])
            edge_list.append({"source": a, "target": b,
                              "score": round(float(e.get("score", 0.0)), 6)})
    stats = [{"gene": n, "degree": 0, "betweenness": 0.0,
              "closeness": 0.0, "is_hub": False} for n in sorted(node_set)]
    return stats, {"nodes": [{"id": n, "degree": 0, "is_hub": False}
                             for n in sorted(node_set)],
                   "edges": edge_list}, len(node_set), len(edge_list)


def run_ppi_network(genes, species, score_threshold, task_id):
    """执行 PPI 网络分析。"""
    if not genes:
        return make_result(
            task_id, "ppi_network",
            "无基因可构建 PPI 网络（未提取到 gene_symbol，也未提供 --gene-list）",
            [], {"nodes": [], "edges": []},
            {"species": species, "score_threshold": score_threshold, "gene_count": 0},
        )
    try:
        edges_raw = _fetch_string_edges(genes, species, score_threshold)
        log_stderr(f"STRING 返回 {len(edges_raw)} 条边")
    except Exception as e:
        log_stderr(f"STRING 不可用，降级: {e}")
        return make_result(
            task_id, "ppi_network",
            f"STRING 不可用（{e}），仅输出基因列表，ppi_unavailable",
            [], {"nodes": [], "edges": []},
            {"species": species, "score_threshold": score_threshold,
             "gene_count": len(genes), "genes": genes, "ppi_unavailable": True},
        )

    G, nx = _build_graph(edges_raw)
    if G is None:
        stats, chart, n_nodes, n_edges = _degrade_edges_only(edges_raw)
        return make_result(
            task_id, "ppi_network",
            f"PPI 网络分析（networkx 降级）：{n_nodes} 节点，{n_edges} 边",
            stats, chart,
            {"species": species, "score_threshold": score_threshold,
             "networkx_unavailable": True},
        )

    # 中心性指标（计算失败时该指标置 0）
    try:
        betw = nx.betweenness_centrality(G)
    except Exception:
        betw = {n: 0.0 for n in G.nodes()}
    try:
        close = nx.closeness_centrality(G)
    except Exception:
        close = {n: 0.0 for n in G.nodes()}
    deg = dict(G.degree())

    # hub genes: degree 排名前 10%
    deg_sorted = sorted(deg.items(), key=lambda x: x[1], reverse=True)
    hub_count = max(1, int(len(deg_sorted) * 0.1)) if deg_sorted else 0
    hub_set = {n for n, _ in deg_sorted[:hub_count]}

    stats_table = []
    nodes_data = []
    for n in sorted(G.nodes()):
        d = deg.get(n, 0)
        is_hub = n in hub_set
        stats_table.append({
            "gene": n,
            "degree": d,
            "betweenness": round(float(betw.get(n, 0.0)), 6),
            "closeness": round(float(close.get(n, 0.0)), 6),
            "is_hub": is_hub,
        })
        nodes_data.append({"id": n, "degree": d, "is_hub": is_hub})
    edges_data = [{"source": u, "target": v,
                   "score": round(float(d.get("score", 0.0)), 6)}
                  for u, v, d in G.edges(data=True)]

    try:
        modules = len(list(nx.connected_components(G)))
    except Exception:
        modules = 0

    text = (f"PPI 网络分析完成：{G.number_of_nodes()} 节点，"
            f"{G.number_of_edges()} 边，hub 基因 {len(hub_set)} 个，"
            f"连通模块 {modules} 个")
    return make_result(
        task_id, "ppi_network", text,
        stats_table, {"nodes": nodes_data, "edges": edges_data},
        {"species": species, "score_threshold": score_threshold,
         "gene_count": len(genes), "hub_count": len(hub_set),
         "modules": modules},
    )


def main():
    parser = setup_cli("ppi_network", "PPI 网络分析（STRING + networkx）")
    parser.add_argument("--gene-list", default="",
                        help="逗号分隔的基因列表；为空时从 --input 提取 gene_symbol")
    parser.add_argument("--species", type=int, default=9606,
                        help="物种 NCBI taxon ID（默认 9606 人）")
    parser.add_argument("--score-threshold", type=float, default=0.4,
                        help="STRING 置信度阈值（默认 0.4 medium）")
    args = parser.parse_args()
    try:
        if args.gene_list:
            genes = [g.strip() for g in args.gene_list.split(",") if g.strip()]
        else:
            if not args.input:
                save_error("PPI 分析需要 --gene-list 或 --input 参数")
                sys.exit(1)
            records = load_records(args.input)
            log_stderr(f"加载 {len(records)} 条记录")
            genes = extract_genes(records)
        log_stderr(f"PPI 基因数: {len(genes)}")
        result = run_ppi_network(genes, args.species, args.score_threshold, args.task_id)
        save_result(result, args.out)
        log_stderr(f"PPI 结果已写入 {args.out}")
    except Exception as e:
        save_error(f"PPI 网络分析失败: {e}", args.out)
        sys.exit(1)


if __name__ == "__main__":
    main()
