"""字段对齐引擎（Cleaner 核心模块，赛题评分重点）。

用途：将多源异构 DataRecord 的字段名对齐到统一字段名，并标准化值。
输入：raw DataRecord JSON 列表 + dictionaries/ 目录（可选）
输出：cleaned DataRecord 列表 + field_mapping.json（符合 field_mapping.schema.yaml）

对齐规则（参考 ARCHITECTURE.md 3.1.6 节）：
  - "Gene"/"SYMBOL"/"GeneSymbol"/"gene_name" → "gene_symbol"（值大写）
  - "MolName"/"Ingredient"/"化合物" → "compound_name"（值首字母大写）
  - "logFC"/"log2FoldChange"/"log2_FC" → "log2fc"（值转 float）
  - "p"/"pvalue"/"P.Value" → "p_value"（值转 float）
  - 字段不在字典中：保留原名 + quality_flag "unknown_field"

模块导入示例：
    from app.tools.cleaners.field_aligner import align_records, load_dictionaries
"""
from pathlib import Path

from ._base import load_records, save_records, make_field_mapping, statistics

try:
    import yaml  # PyYAML，在 scripts/requirements.txt 中
except ImportError:
    yaml = None

# 内置默认字段字典（当 dictionaries/ 下 YAML 缺失时使用，保证脚本可独立运行）
DEFAULT_FIELD_DICT = {
    "gene_symbol": {"label": "基因符号", "unit": None, "data_type": "string", "transform": "upper",
        "aliases": ["Gene", "SYMBOL", "GeneSymbol", "gene_name", "gene_id", "GeneID", "HGNC", "gene_symbol"]},
    "compound_name": {"label": "化合物名称", "unit": None, "data_type": "string", "transform": "title",
        "aliases": ["MolName", "Ingredient", "化合物", "Molecule", "compound", "成分", "compound_name"]},
    "log2fc": {"label": "log2倍数变化", "unit": "log2", "data_type": "number", "transform": "float",
        "aliases": ["logFC", "log2FoldChange", "log2_FC", "logFoldChange", "lfc", "log2fc"]},
    "p_value": {"label": "P值", "unit": "none", "data_type": "number", "transform": "float",
        "aliases": ["p", "pvalue", "P.Value", "p_val", "p_value", "raw_p"]},
    "adj_p_value": {"label": "校正P值", "unit": "none", "data_type": "number", "transform": "float",
        "aliases": ["padj", "fdr", "q_value", "qvalue", "adj_p_value", "FDR"]},
    "target_protein": {"label": "靶点蛋白", "unit": None, "data_type": "string", "transform": "upper",
        "aliases": ["Target", "Protein Target", "靶点", "target_protein", "target_gene"]},
    "ob_value": {"label": "口服生物利用度", "unit": "%", "data_type": "number", "transform": "float",
        "aliases": ["OB", "Oral Bioavailability", "ob_value"]},
    "dl_value": {"label": "类药性", "unit": "none", "data_type": "number", "transform": "float",
        "aliases": ["DL", "Drug Likeness", "dl_value"]},
}


def _norm_key(s):
    """归一化字段名：小写、去空格、将 . - 替换为 _。"""
    return str(s).strip().lower().replace(" ", "").replace("-", "_").replace(".", "_")


def _compact_key(s):
    """进一步去除下划线，用于二次模糊匹配（如 log2_FC ↔ log2FC）。"""
    return _norm_key(s).replace("_", "")


def load_dictionaries(dict_dir):
    """加载 dictionaries/ 下的 YAML 字典，与默认字典合并。

    支持三种 YAML 结构（自动识别）：
      1. 列表式字段字典（field_aliases.yaml）：顶层 `fields:` 列表，每项含
         unified / synonyms / data_type / default_unit / transform。这是主字典。
      2. 扁平式字段字典（兼容旧格式）：顶层 unified / aliases / label / unit 等。
      3. 实体同义词字典（gene_symbols.yaml / compound_names.yaml / unit_aliases.yaml）：
         顶层 aliases / units 列表，每项含 canonical / synonyms。这些用于值标准化，
         本函数跳过（不参与字段名对齐）。

    缺失文件或无 PyYAML 时回退到内置默认字典。
    """
    merged = {k: dict(v) for k, v in DEFAULT_FIELD_DICT.items()}
    if not dict_dir or not Path(dict_dir).is_dir() or yaml is None:
        return merged
    for fp in Path(dict_dir).glob("*.y*ml"):
        try:
            with open(fp, "r", encoding="utf-8-sig") as f:
                data = yaml.safe_load(f) or {}
        except Exception:
            continue
        if not isinstance(data, dict):
            continue

        # 结构 1：列表式字段字典（field_aliases.yaml）
        fields_list = data.get("fields")
        if isinstance(fields_list, list):
            for item in fields_list:
                if not isinstance(item, dict):
                    continue
                unified = item.get("unified")
                if not unified:
                    continue
                synonyms = item.get("synonyms") or []
                if unified not in merged:
                    merged[unified] = {"label": item.get("label", unified),
                                       "unit": item.get("default_unit"),
                                       "data_type": item.get("data_type", "string"),
                                       "transform": item.get("transform"), "aliases": []}
                entry = merged[unified]
                for k in ("label", "unit", "data_type", "transform"):
                    key = "unit" if k == "unit" else k
                    src_key = "default_unit" if k == "unit" else k
                    if item.get(src_key) is not None:
                        entry[key] = item[src_key]
                if isinstance(synonyms, list):
                    entry["aliases"] = list(dict.fromkeys(
                        entry.get("aliases", []) + [str(a) for a in synonyms]))
            continue

        # 结构 2：扁平式字段字典（兼容旧格式）
        if data.get("unified") and (data.get("aliases") or data.get("synonyms")):
            unified = data.get("unified")
            aliases = data.get("aliases") or data.get("synonyms") or []
            if unified not in merged:
                merged[unified] = {"label": data.get("label", unified), "unit": data.get("unit"),
                                   "data_type": data.get("data_type", "string"),
                                   "transform": data.get("transform"), "aliases": []}
            entry = merged[unified]
            for k in ("label", "unit", "data_type", "transform"):
                if data.get(k) is not None:
                    entry[k] = data[k]
            if isinstance(aliases, list):
                entry["aliases"] = list(dict.fromkeys(
                    entry.get("aliases", []) + [str(a) for a in aliases]))
            continue

        # 结构 3：实体同义词字典（aliases/units 列表）— 跳过，不参与字段名对齐
        # gene_symbols.yaml / compound_names.yaml / unit_aliases.yaml 在此分支被忽略
    return merged


def build_alias_index(field_dict):
    """构造 归一化别名 → unified_name 索引（含二次 compact 匹配）。"""
    index = {}
    for unified, info in field_dict.items():
        for key in (_norm_key(unified), _compact_key(unified)):
            index[key] = unified
        for a in info.get("aliases", []):
            for key in (_norm_key(a), _compact_key(a)):
                index[key] = unified
    return index


def _apply_transform(value, transform):
    """对值应用标准化变换。失败时原样返回（不抛异常）。"""
    if value is None or transform is None:
        return value
    try:
        if transform == "upper":
            return str(value).strip().upper()
        if transform == "title":
            return str(value).strip().title()
        if transform == "lower":
            return str(value).strip().lower()
        if transform == "float":
            if isinstance(value, str):
                value = value.strip().replace(",", "")
            return float(value)
    except (ValueError, TypeError):
        return value
    return value


def align_records(records, field_dict):
    """对齐字段。返回 (cleaned_records, field_mapping_list)。"""
    alias_index = build_alias_index(field_dict)
    # unified → {(source, original_field, original_unit)} 命中记录
    mapping_hits = {}
    cleaned = []
    for r in records:
        src = r.get("source_ref", {}).get("source_name", "unknown")
        old_fields = r.get("fields", {})
        new_fields = {}
        new_unit_info = {}
        flags = list(r.get("quality_flags", []))
        # 字段级溯源：记录每个字段的映射/变换链路
        field_prov = dict(r.get("field_provenance", {}))

        for fname, fval in old_fields.items():
            unified = alias_index.get(_norm_key(fname)) or alias_index.get(_compact_key(fname))
            if unified is None:
                # 未知字段：保留原名并打标
                new_fields[fname] = fval
                if "unknown_field" not in flags:
                    flags.append("unknown_field")
                continue
            info = field_dict[unified]
            new_fields[unified] = _apply_transform(fval, info.get("transform"))
            # 迁移 unit_info：优先原字段单位，否则用字典默认单位
            orig_unit = r.get("unit_info", {}).get(fname) or info.get("unit")
            if orig_unit:
                new_unit_info[unified] = orig_unit
            mapping_hits.setdefault(unified, set()).add((src, fname, orig_unit))
            # 追加字段级溯源条目（字段名对齐 + 值变换）
            chain = field_prov.setdefault(unified, [])
            chain.append({
                "step": "field_align",
                "from": fname,
                "to": unified,
                "transform": info.get("transform"),
                "source": src,
            })

        r2 = dict(r)
        r2["fields"] = new_fields
        r2["unit_info"] = new_unit_info
        r2["quality_flags"] = flags
        r2["processing_log"] = list(r.get("processing_log", [])) + ["field_aligned"]
        r2["field_provenance"] = field_prov
        cleaned.append(r2)

    # 构造 field_mapping 表（仅包含实际命中的字段）
    field_mapping = []
    for unified, info in field_dict.items():
        hits = mapping_hits.get(unified)
        if not hits:
            continue
        source_mappings = [
            {"source_name": s, "original_field_name": ofn, "original_unit": ou,
             "transform": None, "confidence": 0.95}
            for (s, ofn, ou) in sorted(hits)
        ]
        field_mapping.append(make_field_mapping(
            unified_name=unified, label=info.get("label", unified),
            unit=info.get("unit"), data_type=info.get("data_type", "string"),
            source_mappings=source_mappings))
    return cleaned, field_mapping
