"""多源整合 CSV 导出 — 按实体类型分组、字段对齐。

与 to_csv 的区别：
- to_csv: 所有记录平铺，字段稀疏（适合溯源审计）
- merge_csv: 按实体类型分组，字段对齐（适合研究分析）

模块导入示例：
    from app.tools.export.merge_csv import write_merged_csv
    groups, rows = write_merged_csv(records, "merged_data.csv")
"""
import csv
import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)


def classify_record(r: dict) -> str:
    """根据记录字段判断实体类型。"""
    fields = r.get("fields", {})
    src = r.get("source_ref", {}).get("source_name", "")
    if fields.get("title") or fields.get("pmid") or fields.get("arxiv_id"):
        return "literature"
    if fields.get("compound_name") or fields.get("ob") or fields.get("dl"):
        return "compound"
    if fields.get("gene_symbol") or fields.get("uniprot_id") or fields.get("gene_id"):
        return "gene"
    if fields.get("compound") and fields.get("target"):
        return "interaction"
    if fields.get("pathway_name") or fields.get("term") or fields.get("kegg_id"):
        return "pathway"
    if fields.get("log2fc") or fields.get("pvalue") or fields.get("adj_p"):
        return "expression"
    if src in ("pubmed", "openalex", "semantic_scholar", "arxiv"):
        return "literature"
    if src in ("string", "biogrid"):
        return "interaction"
    if src in ("kegg", "reactome"):
        return "pathway"
    if src in ("tcmsp", "pubchem", "drugbank"):
        return "compound"
    if src in ("uniprot", "hgnc", "ensembl"):
        return "gene"
    return "other"


def get_group_columns(group: str, records: list[dict]) -> list[str]:
    """根据分组类型返回标准化列头。"""
    base = ["source_name", "confidence", "source_url"]
    schemas = {
        "literature": ["title", "abstract", "authors", "year", "journal",
                      "doi", "pmid", "arxiv_id", "keywords"],
        "compound": ["compound_name", "herb", "ob", "dl", "smiles",
                     "mol_weight", "formula", "cas_number"],
        "gene": ["gene_symbol", "uniprot_id", "gene_id", "chromosome",
                 "function", "disease"],
        "interaction": ["compound", "target", "action", "score",
                       "evidence", "source_db"],
        "pathway": ["pathway_name", "term", "kegg_id", "p_value",
                   "adj_p_value", "gene_count", "genes", "category"],
        "expression": ["gene_symbol", "log2fc", "pvalue", "adj_p",
                      "fc", "stat", "phenotype"],
        "other": [],
    }
    cols = schemas.get(group, [])
    if not cols:
        seen = set(base)
        dynamic = []
        for r in records[:50]:
            for k in r.get("fields", {}):
                if k not in seen:
                    dynamic.append(k)
                    seen.add(k)
        cols = dynamic[:15]
    return base + cols


def write_merged_csv(records: list[dict], path) -> tuple[int, int]:
    """生成多源整合 CSV — 按实体类型分组，字段对齐，便于研究分析。

    Returns:
        (分组数, 总行数)
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    if not records:
        path.write_text("", encoding="utf-8-sig")
        return (0, 0)

    groups: dict[str, list[dict]] = {}
    for r in records:
        etype = classify_record(r)
        groups.setdefault(etype, []).append(r)

    total_rows = 0
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        for group_name, group_records in sorted(groups.items()):
            writer.writerow(
                [f"=== {group_name.upper()} ({len(group_records)} 条) ==="])
            columns = get_group_columns(group_name, group_records)
            writer.writerow(columns)
            for r in group_records:
                fields = r.get("fields", {})
                src = r.get("source_ref", {})
                row = []
                for col in columns:
                    if col == "source_name":
                        row.append(src.get("source_name", ""))
                    elif col == "confidence":
                        row.append(f"{r.get('extraction_confidence', 0):.2f}")
                    elif col == "source_url":
                        row.append(src.get("url", src.get("doi", "")))
                    else:
                        val = fields.get(col, "")
                        if isinstance(val, (list, dict)):
                            val = json.dumps(val, ensure_ascii=False)
                        row.append(str(val) if val is not None else "")
                writer.writerow(row)
                total_rows += 1
            writer.writerow([])

    logger.info("整合CSV写入 %d 行 → %s", total_rows, path)
    return (len(groups), total_rows)
