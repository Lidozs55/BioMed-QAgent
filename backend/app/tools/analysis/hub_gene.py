"""Hub 基因识别 + 上游调控因子反查模块（基于 PPI 结果 / STRING）。

输入：
  genes / degrees / betweenness_map / closeness_map / chart_data / modules
  通常由 PPI 分析结果解析得到，或从 DataRecord 提取基因后内部调用 STRING。
功能：
  1. 从 PPI 结果或 gene 列表获取 degree/betweenness/closeness
  2. 识别 hub genes：degree 排名 top 10%
  3. 对每个 hub gene 调用 STRING interactionPartners 端点获取互作伙伴，区分：
     - 上游 TF（与 hub gene 互作且命中内置常见 TF 集合的基因）
     - 下游 targets（与 hub gene 互作的非 TF 基因）
  4. STRING 不可用时降级：仅输出 hub gene 与 degree，upstream_tf/downstream_targets 留空数组
  5. networkx 不可用时降级：用 stats_table / 边列表直接排序
输出：符合 hub_gene_result.schema.json 的 dict（直接构造，不调用 make_result）
  由调用方自行包装为 {"status":"ok","result":{...},"summary":"..."} 信封。

模块导入示例：
    from .hub_gene import run_hub_gene_analysis
    result = run_hub_gene_analysis(genes, degrees, betw, close, chart, modules,
                                   9606, 0.4, "task-1")
"""
from __future__ import annotations

import logging

from ._base import utc_now

logger = logging.getLogger(__name__)

STRING_NETWORK_URL = "https://string-db.org/api/json/network"
HEADERS = {"User-Agent": "BioMedQAgent/1.0"}

# 内置常见人类转录因子集合（约 20 个），用于判断互作伙伴是否为 TF。
# β-catenin 对应基因符号 CTNNB1。
COMMON_TF_SET = {
    "TP53", "MYC", "MYCN", "STAT1", "STAT3", "NFKB1", "FOXP3", "RELA",
    "JUN", "FOS", "SP1", "E2F1", "ATF4", "CREB1", "SMAD3", "SMAD4",
    "CTNNB1", "REL", "ETS1", "HIF1A",
}


def _fetch_string_partners(gene, species, score_threshold):
    """调用 STRING network 端点获取某基因的直接互作伙伴（仅含与该基因直接相连的边）。

    STRING 的 interactionPartners 端点已下线（404），改用 network 端点
    （单标识符查询返回邻域网络，需过滤出与目标基因直接相连的边）。
    """
    edges = _fetch_string_network([gene], species, score_threshold)
    direct = []
    for e in edges:
        a = e.get("preferredName_A") or e.get("stringId_A")
        b = e.get("preferredName_B") or e.get("stringId_B")
        if a == gene or b == gene:
            direct.append(e)
    return direct


def _fetch_string_network(genes, species, score_threshold):
    """调用 STRING network 端点获取互作边（PPI 结果缺失时使用）。"""
    import requests
    identifiers = "%0d".join(genes)
    params = {
        "identifiers": identifiers,
        "species": species,
        "required_score": int(score_threshold * 1000),
        "caller_identity": "BioMedQAgent",
    }
    r = requests.get(STRING_NETWORK_URL, params=params,
                     headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.json() or []


def _degree_from_edges(edges_raw):
    """从 STRING 边列表计算每节点 degree（networkx 不可用时的降级路径）。"""
    deg = {}
    for e in edges_raw:
        a = e.get("preferredName_A") or e.get("stringId_A")
        b = e.get("preferredName_B") or e.get("stringId_B")
        if not a or not b:
            continue
        deg[a] = deg.get(a, 0) + 1
        deg[b] = deg.get(b, 0) + 1
    return deg


def _build_centralities(genes, species, score_threshold):
    """从基因列表调用 STRING 构建 PPI，计算 degree/betweenness/closeness。

    STRING 不可用返回 None；networkx 不可用降级为仅 degree。
    返回 (degrees, betweenness, closeness, chart_data, modules, n_edges)。
    """
    try:
        edges_raw = _fetch_string_network(genes, species, score_threshold)
        logger.warning(f"STRING 返回 {len(edges_raw)} 条边")
    except Exception as e:
        logger.warning(f"STRING 不可用，降级: {e}")
        return None

    try:
        import networkx as nx
        G = nx.Graph()
        for e in edges_raw:
            a = e.get("preferredName_A") or e.get("stringId_A")
            b = e.get("preferredName_B") or e.get("stringId_B")
            if not a or not b:
                continue
            G.add_edge(a, b, score=float(e.get("score", 0.0)))
        deg = dict(G.degree())
        try:
            betw = nx.betweenness_centrality(G)
        except Exception:
            betw = {n: 0.0 for n in G.nodes()}
        try:
            close = nx.closeness_centrality(G)
        except Exception:
            close = {n: 0.0 for n in G.nodes()}
        try:
            modules = len(list(nx.connected_components(G)))
        except Exception:
            modules = 0
        nodes_data = [{"id": n, "degree": deg.get(n, 0), "is_hub": False}
                      for n in sorted(G.nodes())]
        edges_data = [{"source": u, "target": v,
                       "score": round(float(d.get("score", 0.0)), 6)}
                      for u, v, d in G.edges(data=True)]
        return (deg, betw, close, {"nodes": nodes_data, "edges": edges_data},
                modules, G.number_of_edges())
    except Exception as e:
        logger.warning(f"networkx 不可用，降级为 degree 直算: {e}")
        deg = _degree_from_edges(edges_raw)
        nodes_data = [{"id": n, "degree": d, "is_hub": False}
                      for n, d in deg.items()]
        edges_data = [{"source": e.get("preferredName_A") or e.get("stringId_A"),
                       "target": e.get("preferredName_B") or e.get("stringId_B"),
                       "score": round(float(e.get("score", 0.0)), 6)}
                      for e in edges_raw]
        betw = {n: 0.0 for n in deg}
        close = {n: 0.0 for n in deg}
        return (deg, betw, close, {"nodes": nodes_data, "edges": edges_data},
                0, len(edges_data))


def _resolve_from_ppi_file(path):
    """从 PPI AnalysisResult JSON 提取 degrees/betweenness/closeness/chart_data/modules。

    支持信封 {"status":"ok","result":{...}} 与裸 result 两种结构。
    """
    from ._base import load_records
    records = load_records(path)
    obj = records[0] if records else {}
    if isinstance(obj, dict) and "result" in obj and isinstance(obj["result"], dict):
        obj = obj["result"]
    stats_table = obj.get("stats_table", []) if isinstance(obj, dict) else []
    chart_data = obj.get("chart_data", {}) if isinstance(obj, dict) else {}
    parameters = obj.get("parameters", {}) if isinstance(obj, dict) else {}
    degrees = {}
    betw = {}
    close = {}
    genes = []
    for row in stats_table:
        if not isinstance(row, dict):
            continue
        g = row.get("gene") or row.get("gene_symbol")
        if not g:
            continue
        degrees[g] = int(row.get("degree", 0))
        betw[g] = float(row.get("betweenness", 0.0))
        close[g] = float(row.get("closeness", 0.0))
        genes.append(g)
    modules = int(parameters.get("modules", 0)) if isinstance(parameters, dict) else 0
    return genes, degrees, betw, close, chart_data, modules


def run_hub_gene_analysis(genes, degrees, betweenness_map, closeness_map,
                          chart_data, modules, species, score_threshold, task_id):
    """执行 hub 基因识别与上游调控因子反查。

    直接构造符合 hub_gene_result.schema.json 的 dict 返回。
    """
    # 空网络：STRING 完全不可用且无 PPI 结果
    if not degrees:
        return {
            "task_id": task_id,
            "analysis_type": "hub_gene_analysis",
            "hub_genes": [],
            "network_summary": {"total_nodes": 0, "total_edges": 0,
                                "hub_count": 0, "modules": 0},
            "chart_data": {"nodes": [], "edges": [], "tf_unavailable": True},
            "summary": "无可用 PPI 节点，无法识别 hub 基因（STRING 不可用或输入为空）",
            "created_at": utc_now(),
        }

    # hub genes: degree 排名前 10%
    deg_sorted = sorted(degrees.items(), key=lambda x: x[1], reverse=True)
    hub_count = max(1, int(len(deg_sorted) * 0.1))
    hub_set = {g for g, _ in deg_sorted[:hub_count]}

    # chart_data 节点/边（优先用传入的 chart_data，否则用 degree 构造）
    nodes_data = (chart_data.get("nodes") if isinstance(chart_data, dict)
                  and isinstance(chart_data.get("nodes"), list) else None)
    edges_data = (chart_data.get("edges") if isinstance(chart_data, dict)
                  and isinstance(chart_data.get("edges"), list) else None)
    if nodes_data is None:
        nodes_data = [{"id": g, "degree": d, "is_hub": g in hub_set}
                      for g, d in degrees.items()]
    if edges_data is None:
        edges_data = []
    total_nodes = len(degrees)
    total_edges = len(edges_data) if isinstance(edges_data, list) else 0

    # 对每个 hub gene 反查上游 TF / 下游靶基因
    tf_available = True
    hub_genes_out = []
    for gene in sorted(hub_set):
        upstream_tf = []
        downstream = []
        try:
            partners = _fetch_string_partners(gene, species, score_threshold)
            logger.warning(f"{gene} STRING 互作伙伴 {len(partners)} 个")
            for p in partners:
                a = p.get("preferredName_A") or p.get("stringId_A")
                b = p.get("preferredName_B") or p.get("stringId_B")
                partner = b if a == gene else a
                if not partner or partner == gene:
                    continue
                if partner in COMMON_TF_SET:
                    upstream_tf.append(partner)
                else:
                    downstream.append(partner)
        except Exception as e:
            logger.warning(f"{gene} 上游 TF 反查失败，降级: {e}")
            tf_available = False

        hub_genes_out.append({
            "gene": gene,
            "degree": int(degrees.get(gene, 0)),
            "betweenness": round(float(betweenness_map.get(gene, 0.0)), 6),
            "closeness": round(float(closeness_map.get(gene, 0.0)), 6),
            "is_hub": True,
            "upstream_tf": sorted(set(upstream_tf)),
            "downstream_targets": sorted(set(downstream)),
            "pathways": [],
            "druggability": "unknown",
        })

    if tf_available:
        summary_text = (f"hub 基因识别完成：{len(hub_genes_out)} 个 hub 基因，"
                        f"网络 {total_nodes} 节点 / {total_edges} 边，"
                        f"连通模块 {modules} 个")
    else:
        summary_text = (f"hub 基因识别完成：{len(hub_genes_out)} 个 hub 基因；"
                        f"STRING 互作查询不可用，上游 TF 反查降级"
                        f"（tf_unavailable）")

    return {
        "task_id": task_id,
        "analysis_type": "hub_gene_analysis",
        "hub_genes": hub_genes_out,
        "network_summary": {"total_nodes": total_nodes,
                            "total_edges": total_edges,
                            "hub_count": len(hub_genes_out),
                            "modules": modules},
        "chart_data": {"nodes": nodes_data, "edges": edges_data,
                       "tf_unavailable": not tf_available},
        "summary": summary_text,
        "created_at": utc_now(),
    }
