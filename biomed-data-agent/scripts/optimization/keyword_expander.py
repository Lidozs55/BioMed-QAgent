"""keyword_expander.py — 关键词扩展器（达尔文循环的"找更多"能力）。

基于已有 DataRecord 列表提取已覆盖的实体（gene/compound/disease），
利用 dictionaries/ 下的同义词字典扩展查询：
  - 同义词扩展：TP53 → p53, P53, Li-Fraumeni syndrome
  - 关联实体扩展：找到的 gene → 反查其通路 → 通路内其他基因
  - 跨源扩展：化合物 → SMILES → PubChem CID 反查

输出新查询串列表，供 Agent 在反思循环中执行 expand_search。

用法：
    python scripts/optimization/keyword_expander.py \\
        --records cleaned.json \\
        --entities 'TP53,quercetin,pancreatic_cancer' \\
        --dictionaries dictionaries/ \\
        --out expanded_keywords.json

输出：{"status":"ok","expanded_queries":[...],"new_entities":[...],"by_strategy":{...}}
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_HERE = Path(__file__).parent.resolve()
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
from _base import (
    emit_error_stdout,
    emit_ok_stdout,
    load_records,
    log_stderr,
    setup_cli,
)


def _try_load_yaml(fp):
    """安全加载 YAML，失败时返回 None。"""
    try:
        import yaml
    except ImportError:
        return None
    try:
        with open(fp, "r", encoding="utf-8") as f:
            return yaml.safe_load(f)
    except Exception:
        return None


def _build_alias_index(dictionaries_dir):
    """从 dictionaries/ 加载同义词字典，构造 alias → canonical 反查索引。

    返回 {"gene": {"tp53": "TP53", "p53": "TP53", ...}, "compound": {...}}
    """
    idx = {"gene": {}, "compound": {}, "disease": {}, "pathway": {}}
    p = Path(dictionaries_dir)
    if not p.is_dir():
        return idx

    # gene_symbols.yaml
    fp = p / "gene_symbols.yaml"
    if fp.exists():
        data = _try_load_yaml(fp)
        if data and isinstance(data.get("aliases"), list):
            for item in data["aliases"]:
                canon = item.get("canonical")
                if not canon:
                    continue
                idx["gene"][str(canon).lower()] = canon
                for syn in item.get("synonyms", []):
                    idx["gene"][str(syn).lower()] = canon

    # compound_names.yaml
    fp = p / "compound_names.yaml"
    if fp.exists():
        data = _try_load_yaml(fp)
        if data and isinstance(data.get("aliases"), list):
            for item in data["aliases"]:
                canon = item.get("canonical")
                if not canon:
                    continue
                idx["compound"][str(canon).lower()] = canon
                for syn in item.get("synonyms", []):
                    idx["compound"][str(syn).lower()] = canon

    # disease_names.yaml（如存在）
    fp = p / "disease_names.yaml"
    if fp.exists():
        data = _try_load_yaml(fp)
        if data and isinstance(data.get("aliases"), list):
            for item in data["aliases"]:
                canon = item.get("canonical")
                if not canon:
                    continue
                idx["disease"][str(canon).lower()] = canon
                for syn in item.get("synonyms", []):
                    idx["disease"][str(syn).lower()] = canon

    return idx


def _extract_entities_from_records(records):
    """从 DataRecord 中提取已覆盖的实体。"""
    genes = set()
    compounds = set()
    diseases = set()
    pathways = set()
    for r in records:
        if not isinstance(r, dict):
            continue
        f = r.get("fields", {}) if isinstance(r.get("fields"), dict) else {}
        for gk in ("gene_symbol", "gene", "symbol", "target_gene"):
            v = f.get(gk)
            if v:
                if isinstance(v, list):
                    genes.update(str(x) for x in v)
                else:
                    genes.add(str(v))
        for ck in ("compound_name", "mol_name", "drug_name"):
            v = f.get(ck)
            if v:
                if isinstance(v, list):
                    compounds.update(str(x) for x in v)
                else:
                    compounds.add(str(v))
        for dk in ("disease", "cancer_type", "indication"):
            v = f.get(dk)
            if v:
                diseases.add(str(v))
        for pk in ("pathway_id", "pathway", "kegg_id"):
            v = f.get(pk)
            if v:
                pathways.add(str(v))
    return {
        "gene": genes,
        "compound": compounds,
        "disease": diseases,
        "pathway": pathways,
    }


def _parse_entities_str(entities_str):
    """解析 --entities 字符串为实体集合。"""
    result = {"gene": set(), "compound": set(), "disease": set(), "pathway": set()}
    if not entities_str:
        return result
    for part in entities_str.split(","):
        part = part.strip()
        if not part:
            continue
        if ":" in part:
            typ, val = part.split(":", 1)
            typ = typ.strip().lower()
            val = val.strip()
            if typ in result:
                result[typ].add(val)
        else:
            # 无类型标注时按命名特征归类
            if part[0:1].isupper() and part.isalpha() and len(part) <= 6:
                result["gene"].add(part)
            else:
                result["compound"].add(part)
                result["gene"].add(part)
    return result


def expand_keywords(records, expected_entities, alias_index):
    """执行关键词扩展，返回 (新查询串列表, 新实体集合, 按策略分组)。"""
    covered = _extract_entities_from_records(records)
    expanded_queries = []
    new_entities = {"gene": set(), "compound": set(), "disease": set(), "pathway": set()}
    by_strategy = {"synonym": [], "missing_entity": [], "cross_entity": []}

    # 策略 1：缺失实体的直接查询
    for entity_type, expected_set in expected_entities.items():
        if not expected_set:
            continue
        missing = expected_set - covered.get(entity_type, set())
        for m in missing:
            query = f"{m}"
            expanded_queries.append(query)
            new_entities[entity_type].add(m)
            by_strategy["missing_entity"].append({
                "entity": m, "type": entity_type, "query": query,
                "reason": "用户查询中的实体尚未被任何数据源覆盖",
            })

    # 策略 2：同义词扩展（已覆盖的 gene/compound 加同义词作为 OR 查询）
    for entity_type in ("gene", "compound"):
        for entity in covered.get(entity_type, set()):
            alias_map = alias_index.get(entity_type, {})
            canon = alias_map.get(entity.lower())
            if canon and canon != entity:
                # 已用别名，扩展为 canonical OR alias
                query = f"{canon} OR {entity}"
                expanded_queries.append(query)
                new_entities[entity_type].add(canon)
                by_strategy["synonym"].append({
                    "entity": entity, "canonical": canon, "query": query,
                    "reason": "已检索到别名，扩展 canonical 提升召回",
                })

    # 策略 3：跨实体关联扩展
    # 如果同时有 gene 和 compound，生成 'gene AND compound' 关联查询
    if covered["gene"] and covered["compound"]:
        for g in list(covered["gene"])[:3]:
            for c in list(covered["compound"])[:3]:
                query = f"{g} AND {c}"
                expanded_queries.append(query)
                by_strategy["cross_entity"].append({
                    "gene": g, "compound": c, "query": query,
                    "reason": "gene-compound 关联检索，发现直接互作证据",
                })

    # 策略 4：disease → gene 反查（已知疾病时找疾病相关基因）
    if covered["disease"] and not covered["gene"]:
        for d in list(covered["disease"])[:3]:
            query = f"{d} AND (gene OR target OR biomarker)"
            expanded_queries.append(query)
            by_strategy["cross_entity"].append({
                "disease": d, "query": query,
                "reason": "已知疾病但无基因，扩展检索疾病相关基因",
            })

    # 去重
    seen = set()
    deduped = []
    for q in expanded_queries:
        if q not in seen:
            seen.add(q)
            deduped.append(q)

    new_entities_flat = []
    for typ, vals in new_entities.items():
        for v in vals:
            new_entities_flat.append({"type": typ, "value": v})

    return deduped, new_entities_flat, by_strategy


def main():
    parser = setup_cli("keyword_expander", "关键词扩展器（达尔文循环的'找更多'能力）")
    parser.add_argument("--records", required=True,
                        help="已有的 DataRecord JSON 文件或目录")
    parser.add_argument("--entities", default="",
                        help="用户查询中的关键实体，逗号分隔")
    parser.add_argument("--dictionaries", default=None,
                        help="dictionaries/ 目录路径（用于同义词扩展）")
    args = parser.parse_args()

    try:
        records = load_records(args.records)
        log_stderr(f"加载 {len(records)} 条记录")

        expected = _parse_entities_str(args.entities)
        log_stderr(f"期望实体: { {k: len(v) for k, v in expected.items()} }")

        alias_index = {}
        if args.dictionaries:
            alias_index = _build_alias_index(args.dictionaries)
            log_stderr(f"加载别名索引: { {k: len(v) for k, v in alias_index.items()} }")

        expanded_queries, new_entities, by_strategy = expand_keywords(
            records, expected, alias_index)

        payload = {
            "status": "ok",
            "expanded_queries": expanded_queries,
            "query_count": len(expanded_queries),
            "new_entities": new_entities,
            "by_strategy": by_strategy,
        }
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2, default=str)
        emit_ok_stdout({
            "status": "ok",
            "query_count": len(expanded_queries),
            "by_strategy_counts": {k: len(v) for k, v in by_strategy.items()},
        })
        log_stderr(f"扩展完成: {len(expanded_queries)} 个新查询")
    except Exception as e:
        log_stderr(f"扩展失败: {e}")
        emit_error_stdout(f"keyword_expander 失败: {e}")


if __name__ == "__main__":
    main()
