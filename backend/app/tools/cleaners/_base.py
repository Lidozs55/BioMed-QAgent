"""公共基类与工具：DataRecord 加载/保存、字段映射构造、统计。

被 field_aligner.py / unit_normalizer.py / duplicate_detector.py 复用。
所有路径在代码中以 Unix 风格书写，运行时使用 pathlib 兼容跨平台。

模块导入示例：
    from .._base import load_records, save_records, make_field_mapping, statistics
"""
import json
from pathlib import Path


def _load_json_file(fp):
    """读取单个 JSON 文件，返回 DataRecord 列表。

    支持三种结构：裸数组、单对象、{"records": [...]} 信封。
    """
    with open(fp, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        if "records" in data and isinstance(data["records"], list):
            return data["records"]
        return [data]
    return []


def load_records(input_path):
    """从 JSON 文件或目录加载 DataRecord 列表。

    - input_path 为目录：递归合并所有 .json 文件
    - input_path 为文件：读取单个 JSON（数组或 {"records": [...]} 信封）
    """
    p = Path(input_path)
    if p.is_dir():
        records = []
        for fp in sorted(p.rglob("*.json")):
            records.extend(_load_json_file(fp))
        return records
    if p.is_file():
        return _load_json_file(p)
    raise FileNotFoundError(f"输入路径不存在: {input_path}")


def save_records(records, output_path):
    """保存 DataRecord 列表（或结果信封）到 JSON 文件。自动创建父目录。"""
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)


def make_field_mapping(unified_name, label, unit, data_type, source_mappings):
    """构造字段映射表项（符合 schemas/field_mapping.schema.yaml）。"""
    return {
        "unified_field_name": unified_name,
        "unified_field_label": label,
        "unified_unit": unit,
        "unified_data_type": data_type,
        "description": label,
        "source_mappings": source_mappings,
    }


def statistics(records):
    """返回统计信息：{total, by_source, avg_confidence, flagged_count}。"""
    by_source = {}
    conf_sum = 0.0
    flagged = 0
    for r in records:
        src = r.get("source_ref", {}).get("source_name", "unknown")
        by_source[src] = by_source.get(src, 0) + 1
        conf_sum += float(r.get("extraction_confidence", 0.0) or 0.0)
        if r.get("quality_flags"):
            flagged += 1
    total = len(records)
    return {
        "total": total,
        "by_source": by_source,
        "avg_confidence": round(conf_sum / total, 4) if total else 0.0,
        "flagged_count": flagged,
    }
