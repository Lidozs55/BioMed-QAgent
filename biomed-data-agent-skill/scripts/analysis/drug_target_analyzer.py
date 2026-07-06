"""药物-靶点结合分析（基于 OpenTargets GraphQL API）。

输入：
  --input：DataRecord JSON，或 --gene-list / --compound-list
功能：
  1. 从输入提取 gene list 和 compound list
  2. 对每个 gene 调用 OpenTargets GraphQL 查询其已上市/在研药物
     （先 search 由 symbol 查 Ensembl target ID，再查 target.knownDrugs）
  3. 对每个 compound 反查其靶点（search 查 drug id，再查 drug.linkedTargets）
  4. 构建药物-靶点二部图
  5. 识别 polypharmacology 药物（多靶点）与 multi-drug targets
输出：AnalysisResult JSON（标准结构）
  - stats_table: [{drug, targets, target_count, is_polypharmacology}]
  - chart_data: {nodes: [{id, type}], edges: [{source, target}]}
  - parameters: {drug_count, target_count, polypharmacology_count}
降级：API 不可用 → 空网络 + drug_data_unavailable: true，提示手工查询 DrugBank

用法：
    python scripts/analysis/drug_target_analyzer.py \
        --input cleaned.json --out drug.json --task-id t1
    python scripts/analysis/drug_target_analyzer.py \
        --gene-list TP53,EGFR --compound-list Aspirin --out drug.json
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

OPENTARGETS_GRAPHQL_URL = "https://api.platform.opentargets.org/api/v4/graphql"
HEADERS = {"User-Agent": "BioMedQAgent/1.0",
           "Content-Type": "application/json"}


def _graphql(query, variables):
    """调用 OpenTargets GraphQL 端点。"""
    import requests
    r = requests.post(OPENTARGETS_GRAPHQL_URL,
                      json={"query": query, "variables": variables},
                      headers=HEADERS, timeout=60)
    r.raise_for_status()
    return r.json()


def _search_target_id(symbol):
    """通过 OpenTargets search 由 gene symbol 查询 Ensembl target ID。"""
    query = """
    query($q: String!) {
      search(queryString: $q, entityNames: ["target"], page: {size: 1, index: 0}) {
        hits { id name entity }
      }
    }
    """
    data = _graphql(query, {"q": symbol})
    hits = ((data.get("data", {}).get("search", {}) or {})
            .get("hits", [])) or []
    if not hits:
        return None
    return hits[0].get("id")


def _fetch_drugs_for_target(target_id):
    """查询某 target 的已上市/在研药物，返回 [{drug_id, drug_name}]（去重）。

    OpenTargets v4 中 target.knownDrugs 已更名为 drugAndClinicalCandidates。
    """
    query = """
    query($ensemblId: String!) {
      target(ensemblId: $ensemblId) {
        drugAndClinicalCandidates {
          rows { drug { id name } }
        }
      }
    }
    """
    data = _graphql(query, {"ensemblId": target_id})
    rows = (((data.get("data", {}).get("target", {}) or {})
             .get("drugAndClinicalCandidates", {}) or {})
            .get("rows", [])) or []
    out = []
    seen = set()
    for row in rows:
        drug = row.get("drug") or {}
        did = drug.get("id")
        dname = drug.get("name") or did
        if did and did not in seen:
            seen.add(did)
            out.append({"drug_id": did, "drug_name": dname})
    return out


def _fetch_targets_for_drug(drug_name):
    """通过 search 由药物名查 chembl id，再经 mechanismsOfAction 反查其靶点 gene symbol。"""
    query = """
    query($q: String!) {
      search(queryString: $q, entityNames: ["drug"], page: {size: 1, index: 0}) {
        hits { id name entity }
      }
    }
    """
    data = _graphql(query, {"q": drug_name})
    hits = ((data.get("data", {}).get("search", {}) or {})
            .get("hits", [])) or []
    if not hits:
        return []
    drug_id = hits[0].get("id")
    q2 = """
    query($chemblId: String!) {
      drug(chemblId: $chemblId) {
        mechanismsOfAction {
          rows { targets { id approvedSymbol } }
        }
      }
    }
    """
    d2 = _graphql(q2, {"chemblId": drug_id})
    rows = (((d2.get("data", {}).get("drug", {}) or {})
             .get("mechanismsOfAction", {}) or {}).get("rows", [])) or []
    targets = []
    seen = set()
    for row in rows:
        for t in row.get("targets", []) or []:
            sym = t.get("approvedSymbol") or t.get("id")
            if sym and sym not in seen:
                seen.add(sym)
                targets.append(sym)
    return targets


def run_drug_target_analysis(genes, compounds, task_id):
    """执行药物-靶点结合分析；API 不可用时降级。"""
    if not genes and not compounds:
        return make_result(
            task_id, "drug_target_analysis",
            "无基因或化合物可查询（需 --input 或 --gene-list/--compound-list）",
            [], {"nodes": [], "edges": []},
            {"drug_count": 0, "target_count": 0, "polypharmacology_count": 0},
        )

    # drug_name -> set of target gene symbols
    drug_targets = {}
    had_failure = False
    succeeded_any = False

    # 基因 -> 药物
    for gene in genes:
        try:
            tid = _search_target_id(gene)
            if not tid:
                log_stderr(f"{gene} 未找到 OpenTargets target ID")
                continue
            drugs = _fetch_drugs_for_target(tid)
            log_stderr(f"{gene} 命中药物 {len(drugs)} 个")
            succeeded_any = True
            for d in drugs:
                drug_targets.setdefault(d["drug_name"], set()).add(gene)
        except Exception as e:
            log_stderr(f"{gene} OpenTargets 查询失败，降级: {e}")
            had_failure = True

    # 化合物 -> 靶点
    for comp in compounds:
        try:
            targs = _fetch_targets_for_drug(comp)
            log_stderr(f"{comp} 反查靶点 {len(targs)} 个")
            succeeded_any = True
            for t in targs:
                drug_targets.setdefault(comp, set()).add(t)
        except Exception as e:
            log_stderr(f"{comp} 靶点反查失败，降级: {e}")
            had_failure = True

    # API 全部失败 → 降级空网络
    if not drug_targets and had_failure and not succeeded_any:
        return make_result(
            task_id, "drug_target_analysis",
            "OpenTargets 不可用，药物-靶点网络为空，drug_data_unavailable；"
            "可手工查询 DrugBank（https://go.drugbank.com）",
            [], {"nodes": [], "edges": []},
            {"drug_count": 0, "target_count": 0, "polypharmacology_count": 0,
             "drug_data_unavailable": True},
        )
    # API 可用但无关系
    if not drug_targets:
        return make_result(
            task_id, "drug_target_analysis",
            "未查询到任何药物-靶点关系",
            [], {"nodes": [], "edges": []},
            {"drug_count": 0, "target_count": 0, "polypharmacology_count": 0,
             "drug_data_unavailable": False},
        )

    stats_table = []
    nodes = []
    edges = []
    all_targets = set()
    poly_count = 0
    for drug, tset in sorted(drug_targets.items()):
        tlist = sorted(tset)
        is_poly = len(tlist) > 1
        if is_poly:
            poly_count += 1
        stats_table.append({
            "drug": drug,
            "targets": tlist,
            "target_count": len(tlist),
            "is_polypharmacology": is_poly,
        })
        nodes.append({"id": drug, "type": "drug"})
        all_targets.update(tlist)
        for t in tlist:
            edges.append({"source": drug, "target": t})
    for t in sorted(all_targets):
        nodes.append({"id": t, "type": "gene"})

    text = (f"药物-靶点分析：药物 {len(drug_targets)} 个，靶点 {len(all_targets)} 个，"
            f"polypharmacology 药物 {poly_count} 个")
    return make_result(
        task_id, "drug_target_analysis", text,
        stats_table, {"nodes": nodes, "edges": edges},
        {"drug_count": len(drug_targets), "target_count": len(all_targets),
         "polypharmacology_count": poly_count,
         "drug_data_unavailable": False},
    )


def main():
    parser = setup_cli("drug_target_analyzer", "药物-靶点结合分析（OpenTargets GraphQL）")
    parser.add_argument("--gene-list", default="",
                        help="逗号分隔的基因列表；为空时从 --input 提取 gene_symbol")
    parser.add_argument("--compound-list", default="",
                        help="逗号分隔的化合物/药物名称列表")
    args = parser.parse_args()
    try:
        genes = []
        compounds = []
        if args.gene_list:
            genes = [g.strip() for g in args.gene_list.split(",") if g.strip()]
        if args.compound_list:
            compounds = [c.strip() for c in args.compound_list.split(",")
                         if c.strip()]
        if args.input and (not genes or not compounds):
            records = load_records(args.input)
            log_stderr(f"加载 {len(records)} 条记录")
            # 基因优先取 gene_symbol；化合物取 compound / drug_name 字段
            if not genes:
                genes = extract_genes(records)
            if not compounds:
                seen = set()
                for r in records:
                    f = r.get("fields", {}) if isinstance(r, dict) else {}
                    c = f.get("compound") or f.get("drug_name") or f.get("compound_name")
                    if c and c not in seen:
                        seen.add(c)
                        compounds.append(str(c))
        if not genes and not compounds:
            save_error("药物-靶点分析需要 --gene-list/--compound-list 或 --input 参数")
            sys.exit(1)
        log_stderr(f"药物-靶点分析：基因 {len(genes)} 个，化合物 {len(compounds)} 个")
        result = run_drug_target_analysis(genes, compounds, args.task_id)
        save_result(result, args.out)
        log_stderr(f"药物-靶点结果已写入 {args.out}")
    except Exception as e:
        save_error(f"药物-靶点分析失败: {e}", args.out)
        sys.exit(1)


if __name__ == "__main__":
    main()
