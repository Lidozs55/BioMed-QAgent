"""上游转录因子（TF）网络构建（基于 STRING network 端点）。

输入：
  --input：DataRecord JSON 或 --gene-list 逗号分隔基因列表
功能：
  1. 提取 gene 列表
  2. 调用 STRING network 端点对每个基因获取互作伙伴
     （interactionPartners 端点已下线，改用 network 端点 + 直接相连边过滤）
  3. 过滤出 TF（命中内置常见 TF 集合的伙伴视为该基因的上游调控因子）
  4. 构建调控网络 TF → target gene
  5. 计算 TF 的 out-degree（调控多少个 target）
  6. 识别 master TF（out-degree top 5）
输出：AnalysisResult JSON（标准结构）
  - stats_table: [{tf, target_count, targets, is_master}]
  - chart_data: {nodes: [{id, type, is_master}], edges: [{source, target}]}
  - parameters: {gene_count, tf_count, master_tf_count}
降级：STRING 不可用 → 空网络 + regulator_unavailable: true

用法：
    python scripts/analysis/upstream_regulator.py \
        --input cleaned.json --out upstream.json --task-id t1
    python scripts/analysis/upstream_regulator.py \
        --gene-list TP53,EGFR,KRAS --out upstream.json
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
                     headers=HEADERS, timeout=60)
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


def run_upstream_regulator(genes, species, score_threshold, task_id):
    """构建上游 TF 调控网络；STRING 不可用时降级。"""
    if not genes:
        return make_result(
            task_id, "upstream_regulator",
            "无基因可构建上游调控网络（未提取到 gene_symbol，也未提供 --gene-list）",
            [], {"nodes": [], "edges": []},
            {"gene_count": 0, "tf_count": 0, "master_tf_count": 0},
        )

    # TF -> set of regulated input genes
    tf_targets = {}
    had_failure = False
    succeeded_any = False
    for gene in genes:
        try:
            partners = _fetch_partners(gene, species, score_threshold)
            log_stderr(f"{gene} 互作伙伴 {len(partners)} 个")
            pset = _partners_of(gene, partners)
            succeeded_any = True
            for tf in pset & COMMON_TF_SET:
                tf_targets.setdefault(tf, set()).add(gene)
        except Exception as e:
            log_stderr(f"{gene} STRING 查询失败，降级: {e}")
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


def main():
    parser = setup_cli("upstream_regulator", "上游转录因子（TF）调控网络构建")
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
                save_error("上游调控分析需要 --gene-list 或 --input 参数")
                sys.exit(1)
            records = load_records(args.input)
            log_stderr(f"加载 {len(records)} 条记录")
            genes = extract_genes(records)
        log_stderr(f"上游调控分析基因数: {len(genes)}")
        result = run_upstream_regulator(genes, args.species,
                                        args.score_threshold, args.task_id)
        save_result(result, args.out)
        log_stderr(f"上游调控结果已写入 {args.out}")
    except Exception as e:
        save_error(f"上游调控分析失败: {e}", args.out)
        sys.exit(1)


if __name__ == "__main__":
    main()
