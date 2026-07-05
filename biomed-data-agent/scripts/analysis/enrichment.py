"""GO/KEGG 富集分析脚本（基于 Enrichr API）。

输入：gene 列表（从 DataRecord 提取 gene_symbol，或 --gene-list 直接指定）
功能：
  1. POST /addList 上传基因列表，获得 userListId
  2. GET /enrich?userListId=X&backgroundType=<library> 获取富集结果
  3. 解析每条通路：term / overlap / p_value / adj_p_value / genes / z_score
  4. 生成气泡图（bubble plot）数据
输出：AnalysisResult JSON
  - stats_table: 每通路 [term, overlap, p_value, adj_p_value, genes, z_score]
  - chart_data: 气泡图点 [{x: -log10(p), y: gene_ratio, size: count, term, genes}]

Enrichr 不可用时降级：只输出基因列表并标记 enrichment_unavailable。

用法：
    python scripts/analysis/enrichment.py \
        --input cleaned.json --out enrich.json --task-id t1 \
        --library KEGG_2021_Human
    python scripts/analysis/enrichment.py \
        --gene-list TP53,EGFR,KRAS --out enrich.json --library GO_Biological_Process_2023
"""
from __future__ import annotations

import math
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

ENRICHR_URL = "https://maayanlab.cloud/Enrichr"
HEADERS = {"User-Agent": "BioMedQAgent/1.0"}


def _post_gene_list(genes):
    """上传基因列表到 Enrichr，返回 userListId。"""
    import requests
    payload = {
        "list": (None, "\n".join(genes)),
        "description": (None, "BioMedQAgent enrichment"),
    }
    r = requests.post(f"{ENRICHR_URL}/addList", files=payload,
                      headers=HEADERS, timeout=60)
    r.raise_for_status()
    data = r.json()
    user_list_id = data.get("userListId")
    if not user_list_id:
        raise ValueError(f"Enrichr 未返回 userListId: {data}")
    return user_list_id


def _fetch_enrichment(user_list_id, library):
    """查询 Enrichr 富集结果，返回 term 列表。"""
    import requests
    params = {"userListId": user_list_id, "backgroundType": library}
    r = requests.get(f"{ENRICHR_URL}/enrich", params=params,
                     headers=HEADERS, timeout=120)
    r.raise_for_status()
    data = r.json()
    return data.get(library, []) or []


def _parse_term(item):
    """解析 Enrichr 单条富集结果。

    Enrichr 字段顺序：
    [rank, term_name, p_value, z_score, combined_score,
     overlapping_genes, adjusted_p_value, old_p_value, old_adjusted_p_value]
    term_name 常含 overlap 后缀，如 "Pathway (4/89)"。
    """
    if len(item) < 7:
        return None
    term = item[1]
    p_value = float(item[2])
    z_score = float(item[3]) if item[3] is not None else 0.0
    overlap_genes = item[5] if isinstance(item[5], list) else []
    adj_p_value = float(item[6])
    # 从 term 名解析 overlap "Name (k/N)"
    overlap = ""
    if "(" in term and ")" in term:
        inner = term[term.rfind("(") + 1:term.rfind(")")]
        if "/" in inner:
            overlap = inner
    if not overlap:
        overlap = f"{len(overlap_genes)}/?"
    # 去掉 term 末尾的 " (k/N)"
    term_clean = term.rsplit(" (", 1)[0] if " (" in term else term
    return {
        "term": term_clean,
        "overlap": overlap,
        "p_value": p_value,
        "adj_p_value": adj_p_value,
        "genes": overlap_genes,
        "z_score": z_score,
        "count": len(overlap_genes),
    }


def run_enrichment(genes, library, task_id):
    """执行 Enrichr 富集分析；失败时降级。"""
    if not genes:
        return make_result(
            task_id, "enrichment",
            "无基因可富集（未提取到 gene_symbol，也未提供 --gene-list）",
            [], [], {"library": library, "gene_count": 0},
        )
    try:
        user_list_id = _post_gene_list(genes)
        log_stderr(f"Enrichr userListId={user_list_id}")
        terms = _fetch_enrichment(user_list_id, library)
        log_stderr(f"Enrichr 返回 {len(terms)} 条通路")
    except Exception as e:
        log_stderr(f"Enrichr 不可用，降级输出基因列表: {e}")
        return make_result(
            task_id, "enrichment",
            f"Enrichr 不可用（{e}），仅输出基因列表，enrichment_unavailable",
            [], [],
            {"library": library, "gene_count": len(genes),
             "genes": genes, "enrichment_unavailable": True},
        )

    stats_table = []
    chart_data = []
    for item in terms:
        parsed = _parse_term(item)
        if not parsed:
            continue
        stats_table.append({
            "term": parsed["term"],
            "overlap": parsed["overlap"],
            "p_value": parsed["p_value"],
            "adj_p_value": parsed["adj_p_value"],
            "genes": parsed["genes"],
            "z_score": round(parsed["z_score"], 4),
        })
        p_eff = max(parsed["p_value"], 1e-300)
        # gene_ratio = 命中基因数 / 总输入基因数
        ratio = parsed["count"] / len(genes) if genes else 0
        chart_data.append({
            "x": round(-math.log10(p_eff), 6),
            "y": round(ratio, 6),
            "size": parsed["count"],
            "term": parsed["term"],
            "genes": parsed["genes"],
        })

    text = (f"富集分析完成：{library} 共 {len(stats_table)} 条通路，"
            f"输入基因 {len(genes)} 个")
    return make_result(
        task_id, "enrichment", text,
        stats_table, chart_data,
        {"library": library, "gene_count": len(genes)},
    )


def main():
    parser = setup_cli("enrichment", "GO/KEGG 富集分析（Enrichr API）")
    parser.add_argument("--gene-list", default="",
                        help="逗号分隔的基因列表；为空时从 --input 提取 gene_symbol")
    parser.add_argument("--library", default="KEGG_2021_Human",
                        help="Enrichr 背景库（默认 KEGG_2021_Human）")
    args = parser.parse_args()
    try:
        if args.gene_list:
            genes = [g.strip() for g in args.gene_list.split(",") if g.strip()]
        else:
            if not args.input:
                save_error("富集分析需要 --gene-list 或 --input 参数")
                sys.exit(1)
            records = load_records(args.input)
            log_stderr(f"加载 {len(records)} 条记录")
            genes = extract_genes(records)
        log_stderr(f"富集分析基因数: {len(genes)}")
        result = run_enrichment(genes, args.library, args.task_id)
        save_result(result, args.out)
        log_stderr(f"富集结果已写入 {args.out}")
    except Exception as e:
        save_error(f"富集分析失败: {e}", args.out)
        sys.exit(1)


if __name__ == "__main__":
    main()
