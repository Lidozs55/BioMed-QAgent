"""单位归一化模块。

用途：对 cleaned DataRecord 的数值字段进行单位归一化。
输入：cleaned DataRecord 列表（field_aligner 输出）
输出：normalized DataRecord 列表 + unit_changes.json

归一化规则（参考 ARCHITECTURE.md 3.1.6 节）：
  - 自然对数 ln → log2：log2(x) = ln(x)/ln(2)
  - log10 → log2：log2(x) = log10(x) * log(10)/ln(2)
  - fold_change（线性倍数）→ log2fc：log2(x)
  - pvalue 科学计数法统一为 float
  - 浓度单位统一：μM/µM → uM；nM/mM 保留但标记
  - 基因表达 count：CPM/TPM 不互转，仅标记 unit_uncertain
  - 单位不确定时添加 quality_flag "unit_uncertain"

执行示例：
  python scripts/cleaners/unit_normalizer.py --input results/cleaned.json --out results/normalized.json
"""
import json
import math
import os
import sys
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
from _base import load_records, save_records, setup_cli, statistics

LN2 = math.log(2)

# 字段名 → 期望的归一化目标单位
NUMERIC_UNIT_FIELDS = {
    "log2fc": "log2",
    "fold_change": "log2",
    "p_value": "none",
    "adj_p_value": "none",
    "ob_value": "%",
    "dl_value": "none",
    "concentration": "uM",
    "expression_count": "count",
}

# 单位别名 → 标准单位（小写归一化后匹配）
UNIT_ALIASES = {
    "log2": "log2", "log2fc": "log2", "log2foldchange": "log2",
    "ln": "ln", "naturallog": "ln", "loge": "ln",
    "log10": "log10", "log_10": "log10",
    "um": "uM", "µm": "uM", "μm": "uM", "micromolar": "uM", "u_m": "uM",
    "nm": "nM", "nanomolar": "nM",
    "mm": "mM", "millimolar": "mM",
    "%": "%", "percent": "%",
    "cpm": "CPM", "tpm": "TPM",
    "none": "none", "": "none", "count": "count",
}


def _norm_unit(u):
    """归一化单位字符串到标准形式。"""
    if u is None:
        return None
    key = str(u).strip().lower().replace(" ", "")
    return UNIT_ALIASES.get(key, str(u).strip())


def _to_float(v):
    """安全转 float，失败返回 None。"""
    try:
        if isinstance(v, str):
            v = v.strip().replace(",", "")
        return float(v)
    except (ValueError, TypeError):
        return None


def normalize_value(field, value, orig_unit, target_unit, flags):
    """根据单位归一化数值。返回 (new_value, new_unit, changed_info|None)。"""
    if value is None:
        return value, target_unit, None
    fv = _to_float(value)
    if fv is None:
        # 非数值，保留原值
        return value, target_unit, None

    changed = None
    # ln → log2
    if orig_unit == "ln" and target_unit == "log2":
        return round(fv / LN2, 6), target_unit, ("ln", "log2")
    # log10 → log2
    if orig_unit == "log10" and target_unit == "log2":
        return round(fv * math.log(10) / LN2, 6), target_unit, ("log10", "log2")
    # 线性 fold_change → log2fc
    if field == "fold_change" and target_unit == "log2":
        if fv <= 0:
            flags.append("unit_uncertain")
            return fv, target_unit, None
        return round(math.log2(fv), 6), target_unit, ("linear", "log2")
    # 浓度：μM/µM → uM（仅统一符号）
    if target_unit == "uM" and orig_unit in ("µm", "μm"):
        return fv, "uM", (orig_unit, "uM")
    # 表达量 CPM/TPM 不互转，标记
    if field == "expression_count" and orig_unit in ("CPM", "TPM") and orig_unit != target_unit:
        if "unit_uncertain" not in flags:
            flags.append("unit_uncertain")
        return fv, orig_unit, None
    return fv, target_unit, None


def normalize_records(records):
    """对每条记录的数值字段做单位归一化。返回 (normalized_records, unit_changes)。"""
    normalized = []
    unit_changes = {}  # field → {original_unit, new_unit, count}
    for r in records:
        fields = dict(r.get("fields", {}))
        unit_info = dict(r.get("unit_info", {}))
        flags = list(r.get("quality_flags", []))

        for fname, fval in fields.items():
            target_unit = NUMERIC_UNIT_FIELDS.get(fname)
            if target_unit is None:
                continue
            orig_unit = _norm_unit(unit_info.get(fname)) or _norm_unit(target_unit)
            new_val, new_unit, changed = normalize_value(
                fname, fval, orig_unit, target_unit, flags)
            fields[fname] = new_val
            unit_info[fname] = new_unit
            if changed:
                entry = unit_changes.setdefault(
                    fname, {"original_unit": changed[0], "new_unit": changed[1], "count": 0})
                entry["count"] += 1

        r2 = dict(r)
        r2["fields"] = fields
        r2["unit_info"] = unit_info
        r2["quality_flags"] = list(dict.fromkeys(flags))
        r2["processing_log"] = list(r.get("processing_log", [])) + ["unit_normalized"]
        normalized.append(r2)
    return normalized, unit_changes


def main():
    parser = setup_cli("unit_normalizer", "单位归一化：统一数值字段单位")
    args = parser.parse_args()
    try:
        records = load_records(args.input)
        normalized, unit_changes = normalize_records(records)
        # 单独保存 unit_changes.json
        uc_path = Path(args.out).parent / "unit_changes.json"
        with open(uc_path, "w", encoding="utf-8") as f:
            json.dump(unit_changes, f, ensure_ascii=False, indent=2)
        result = {
            "status": "ok",
            "records": normalized,
            "unit_changes": unit_changes,
            "count": len(normalized),
            "stats": statistics(normalized),
        }
        save_records(result, args.out)
        print(json.dumps({"status": "ok", "count": len(normalized),
                          "unit_changes": unit_changes}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
