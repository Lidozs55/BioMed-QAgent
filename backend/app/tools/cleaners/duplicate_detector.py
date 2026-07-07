"""重复检测与去重模块。

用途：基于 (gene_symbol, compound_name, context) 三元组识别同一实体，
      保留置信度最高的记录，标记其余为 duplicate，并检测数值冲突。
输入：normalized DataRecord 列表（unit_normalizer 输出）
输出：deduplicated DataRecord 列表 + duplicate_report.json

规则（参考 ARCHITECTURE.md 3.1.6 节）：
  - 实体识别键：(gene_symbol, compound_name, context)
      context 为生物学上下文（疾病/条件/任务），而非数据源；同实体不同来源会被归组
  - 综合置信度 = extraction_confidence × source_reliability
  - 每组保留置信度最高的一条；其余合并到主记录 processing_log
  - 同实体数值差异 > 20% → quality_flag "conflict" + "needs_review"

模块导入示例：
    from app.tools.cleaners.duplicate_detector import deduplicate
"""
from collections import defaultdict

from ._base import load_records, save_records, statistics

# 数据源可靠性权重（参考 ARCHITECTURE.md 数据源类型，API > 数据库 > 爬虫）
SOURCE_RELIABILITY = {
    "pubmed": 0.95, "ncbi_gene": 0.95, "ncbi": 0.95,
    "geo": 0.90, "kegg": 0.90, "pdb": 0.92,
    "string": 0.88, "tcmsp": 0.85, "tcm": 0.80,
    "openalex": 0.85, "semantic_scholar": 0.83,
}
DEFAULT_RELIABILITY = 0.70

# 参与冲突检测的数值字段
NUMERIC_FIELDS = ("log2fc", "p_value", "adj_p_value", "ob_value",
                  "dl_value", "fold_change", "concentration")
CONFLICT_THRESHOLD = 0.20  # 20% 差异阈值


def _reliability(source_name):
    return SOURCE_RELIABILITY.get((source_name or "").lower(), DEFAULT_RELIABILITY)


def _confidence(record):
    """综合置信度 = extraction_confidence × source_reliability。"""
    conf = float(record.get("extraction_confidence", 0.5) or 0.5)
    src = record.get("source_ref", {}).get("source_name", "unknown")
    return conf * _reliability(src)


def _entity_key(record):
    """构造实体识别键：(gene_symbol, compound_name, context)。

    context 取 fields.context / task_id，保证同实体不同来源被归组以检测冲突。
    """
    fields = record.get("fields", {})
    gene = str(fields.get("gene_symbol", "")).strip().upper()
    comp = str(fields.get("compound_name", "")).strip().lower()
    if not gene and not comp:
        return None
    context = str(fields.get("context", "")).strip().lower()
    if not context:
        context = str(record.get("task_id", "")).strip().lower()
    return (gene, comp, context)


def _to_float(v):
    try:
        if isinstance(v, str):
            v = v.strip().replace(",", "")
        return float(v)
    except (ValueError, TypeError):
        return None


def _detect_conflicts(main_rec, dup_records):
    """检测主记录与重复记录间的数值冲突（差异 > 20%）。"""
    conflicts = []
    main_fields = main_rec.get("fields", {})
    for dup in dup_records:
        dup_fields = dup.get("fields", {})
        for f in NUMERIC_FIELDS:
            if f not in main_fields or f not in dup_fields:
                continue
            mv = _to_float(main_fields[f])
            dv = _to_float(dup_fields[f])
            if mv is None or dv is None:
                continue
            base = abs(mv) if abs(mv) > 1e-12 else 1.0
            diff = abs(mv - dv) / base
            if diff > CONFLICT_THRESHOLD:
                conflicts.append({
                    "field": f, "main_value": mv, "duplicate_value": dv,
                    "diff_ratio": round(diff, 4),
                    "kept_record_id": main_rec.get("record_id", ""),
                    "duplicate_record_id": dup.get("record_id", ""),
                    "duplicate_source": dup.get("source_ref", {}).get("source_name", ""),
                })
    return conflicts


def deduplicate(records):
    """去重主流程。返回 (deduplicated_records, duplicate_report)。"""
    groups = defaultdict(list)
    no_key = []
    for r in records:
        key = _entity_key(r)
        if key is None:
            no_key.append(r)
        else:
            groups[key].append(r)

    deduped = list(no_key)
    duplicates = []
    conflicts = []

    for key, group in groups.items():
        if len(group) == 1:
            deduped.append(group[0])
            continue
        # 按综合置信度降序，保留最高
        scored = sorted(group, key=_confidence, reverse=True)
        main = dict(scored[0])
        dups = scored[1:]
        conf = _detect_conflicts(main, dups)
        if conf:
            flags = list(main.get("quality_flags", []))
            for tag in ("conflict", "needs_review"):
                if tag not in flags:
                    flags.append(tag)
            main["quality_flags"] = flags
            conflicts.extend(conf)
        for d in dups:
            duplicates.append({
                "entity_key": list(key),
                "kept_record_id": main.get("record_id", ""),
                "duplicate_record_id": d.get("record_id", ""),
                "duplicate_source": d.get("source_ref", {}).get("source_name", ""),
                "kept_confidence": round(_confidence(main), 4),
                "duplicate_confidence": round(_confidence(d), 4),
            })
        log = list(main.get("processing_log", []))
        log.append("deduplicated: merged " + ", ".join(d.get("record_id", "") for d in dups))
        main["processing_log"] = log
        deduped.append(main)

    report = {
        "duplicates": duplicates,
        "conflicts": conflicts,
        "total_duplicates": len(duplicates),
        "total_conflicts": len(conflicts),
    }
    return deduped, report
