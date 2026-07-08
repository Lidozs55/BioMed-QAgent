"""上游转录因子（TF）网络构建模块（基于 STRING network 端点）。

输入：
  gene 列表（从 DataRecord 提取 gene_symbol，或外部直接指定）
功能：
  1. 提取 gene 列表
  2. 调用 STRING network 端点对每个基因获取互作伙伴
     （interactionPartners 端点已下线，改用 network 端点 + 直接相连边过滤）
  3. 过滤出 TF（命中内置常见 TF 集合的伙伴视为该基因的上游调控因子）
  4. 构建调控网络 TF → target gene
  5. 计算 TF 的 out-degree（调控多少个 target）
  6. 识别 master TF（out-degree top 5）
输出：AnalysisResult dict（标准结构）
  - stats_table: [{tf, target_count, targets, is_master}]
  - chart_data: {nodes: [{id, type, is_master}], edges: [{source, target}]}
  - parameters: {gene_count, tf_count, master_tf_count}
降级：STRING 不可用 → 空网络 + regulator_unavailable: true

模块导入示例：
    from .upstream_regulator import run_upstream_regulator
    result = run_upstream_regulator(["TP53", "EGFR", "KRAS"], 9606, 0.4, "task-1")
"""
from __future__ import annotations

import logging

from ._base import make_result

logger = logging.getLogger(__name__)

STRING_NETWORK_URL = "https://string-db.org/api/json/network"
HEADERS = {"User-Agent": "BioMedQAgent/1.0"}

# 内置常见人类转录因子集合（约 20 个），用于识别互作伙伴中的 TF。
# β-catenin 对应基因符号 CTNNB1。
COMMON_TF_SET = {
    "TP53", "MYC", "MYCN", "STAT1", "STAT3", "NFKB1", "FOXP3", "RELA",
    "JUN", "FOS", "SP1", "E2F1", "ATF4", "CREB1", "SMAD3", "SMAD4",
    "CTNNB1", "REL", "ETS1", "HIF1A",
}


def _fetch_partners(gene, species, score_threshold):
    """调用 STRING network 端点获取某基因的直接互作伙伴（仅含与该基因直接相连的边）。

    STRING 的 interactionPartners 端点已下线（404），改用 network 端点
    （单标识符查询返回邻域网络，需过滤出与目标基因直接相连的边）。
    """
    import requests
    params = {
        "identifiers": gene,
        "species": species,
        "required_score": int(score_threshold * 1000),
        "caller_identity": "BioMedQAgent",
    }
    r = requests.get(STRING_NETWORK_URL, params=params,
                     headers=HEADERS, timeout=30)
    r.raise_for_status()
    edges = r.json() or []
    direct = []
    for e in edges:
        a = e.get("preferredName_A") or e.get("stringId_A")
        b = e.get("preferredName_B") or e.get("stringId_B")
        if a == gene or b == gene:
            direct.append(e)
    return direct


def _partners_of(gene, partners_raw):
    """从 STRING 响应边列表提取对端基因集合（排除自身）。"""
    out = set()
    for p in partners_raw:
        a = p.get("preferredName_A") or p.get("stringId_A")
        b = p.get("preferredName_B") or p.get("stringId_B")
        partner = b if a == gene else a
        if partner and partner != gene:
            out.add(partner)
    return out


def run_upstream_regulator(genes, species, score_threshold, task_id,
                            ppi_edges=None):
    """构建上游 TF 调控网络；STRING 不可用时降级。

    Args:
        genes: 基因 symbol 列表
        species: NCBI taxonomy ID
        score_threshold: STRING combined_score 阈值
        task_id: 任务 ID
        ppi_edges: 可选，PPI 分析的边数据列表 [{"source": str, "target": str}, ...]
                   传入时直接从中提取互作伙伴，不再调用 STRING API（避免 N 次串行请求）
    """
    if not genes:
        return make_result(
            task_id, "upstream_regulator",
            "无基因可构建上游调控网络（未提取到 gene_symbol，也未提供 gene 列表）",
            [], {"nodes": [], "edges": []},
            {"gene_count": 0, "tf_count": 0, "master_tf_count": 0},
        )

    # TF -> set of regulated input genes
    tf_targets = {}
    had_failure = False
    succeeded_any = False

    if ppi_edges:
        # 复用 PPI 结果：从边数据中提取每个基因的互作伙伴（无需调用 STRING）
        gene_set = set(genes)
        for edge in ppi_edges:
            src = edge.get("source", "")
            tgt = edge.get("target", "")
            if not src or not tgt:
                continue
            # 双向检查：src 是输入基因 → tgt 是伙伴；tgt 是输入基因 → src 是伙伴
            if src in gene_set:
                if tgt in COMMON_TF_SET:
                    tf_targets.setdefault(tgt, set()).add(src)
                succeeded_any = True
            if tgt in gene_set:
                if src in COMMON_TF_SET:
                    tf_targets.setdefault(src, set()).add(tgt)
                succeeded_any = True
        logger.info("upstream_regulator: 从 PPI 边数据提取 TF 互作（%d 条边）",
                    len(ppi_edges))
    else:
        # 逐基因调用 STRING API（降级路径，仅在无 PPI 结果时使用）
        for gene in genes:
            try:
                partners = _fetch_partners(gene, species, score_threshold)
                logger.warning(f"{gene} 互作伙伴 {len(partners)} 个")
                pset = _partners_of(gene, partners)
                succeeded_any = True
                for tf in pset & COMMON_TF_SET:
                    tf_targets.setdefault(tf, set()).add(gene)
            except Exception as e:
                logger.warning(f"{gene} STRING 查询失败，降级: {e}")
                had_failure = True

    # STRING 全部失败 → 降级空网络
    if not tf_targets and had_failure and not succeeded_any:
        return make_result(
            task_id, "upstream_regulator",
            "STRING 不可用，上游调控网络为空，regulator_unavailable",
            [], {"nodes": [], "edges": []},
            {"gene_count": len(genes), "tf_count": 0, "master_tf_count": 0,
             "regulator_unavailable": True},
        )
    # STRING 可用但无 TF 互作
    if not tf_targets:
        return make_result(
            task_id, "upstream_regulator",
            "未识别到上游 TF（输入基因与内置 TF 集合无互作）",
            [], {"nodes": [], "edges": []},
            {"gene_count": len(genes), "tf_count": 0, "master_tf_count": 0,
             "regulator_unavailable": False},
        )

    # master TF：out-degree top 5
    tf_sorted = sorted(tf_targets.items(),
                       key=lambda x: len(x[1]), reverse=True)
    master_count = min(5, len(tf_sorted))
    master_set = {tf for tf, _ in tf_sorted[:master_count]}

    stats_table = []
    nodes = []
    edges = []
    target_nodes = set()
    for tf, targets in tf_sorted:
        tlist = sorted(targets)
        is_master = tf in master_set
        stats_table.append({
            "tf": tf,
            "target_count": len(tlist),
            "targets": tlist,
            "is_master": is_master,
        })
        nodes.append({"id": tf, "type": "tf", "is_master": is_master})
        target_nodes.update(tlist)
        for t in tlist:
            edges.append({"source": tf, "target": t})
    for t in sorted(target_nodes):
        nodes.append({"id": t, "type": "target"})

    text = (f"上游调控网络：识别 TF {len(tf_targets)} 个，"
            f"master TF {master_count} 个，调控关系 {len(edges)} 条")
    return make_result(
        task_id, "upstream_regulator", text,
        stats_table, {"nodes": nodes, "edges": edges},
        {"gene_count": len(genes), "tf_count": len(tf_targets),
         "master_tf_count": master_count,
         "regulator_unavailable": False},
    )
