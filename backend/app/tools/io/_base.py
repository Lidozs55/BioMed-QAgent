"""IO 转换公共基类与工具函数。

提供 detect_format / make_record / load_records / save_json /
_now_iso / _hash8 等共享工具，供 .csv_to_json / .excel_to_json /
.json_to_csv / .merge_json 复用。

模块导入示例：
    from .io._base import make_record, save_json, detect_format
"""
import hashlib
import json
import os
from datetime import datetime, timezone


def _now_iso():
    """当前 UTC 时间 ISO 8601 字符串。"""
    return datetime.now(timezone.utc).isoformat()


def _hash8(text):
    """MD5 前 8 位，用于 record_id 生成。"""
    return hashlib.md5(text.encode("utf-8")).hexdigest()[:8]


def detect_format(file_path):
    """根据扩展名检测格式：json/csv/xlsx/tsv/yaml/unknown。"""
    lower = os.path.splitext(file_path)[1].lower()
    return {".json": "json", ".csv": "csv", ".xlsx": "xlsx", ".xls": "xlsx",
            ".tsv": "tsv", ".yaml": "yaml", ".yml": "yaml"}.get(lower, "unknown")


def make_record(task_id, source_name, fields, file_path,
                confidence=0.85, method="table"):
    """构造符合 schemas/data_record.schema.json 的 DataRecord dict。"""
    seed = f"{source_name}:{file_path}:{json.dumps(fields, sort_keys=True, default=str)}"
    return {
        "record_id": f"{source_name}-{_hash8(seed)}",
        "task_id": task_id,
        "fields": fields,
        "source_ref": {"source_name": source_name, "source_type": "file",
                       "query": file_path, "retrieved_at": _now_iso()},
        "extraction_method": method,
        "extraction_confidence": confidence,
        "quality_flags": [],
        "created_at": _now_iso(),
    }


def load_records(input_path):
    """从 JSON 文件加载 DataRecord 列表（支持裸数组/单对象/records 信封）。"""
    with open(input_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        if "records" in data and isinstance(data["records"], list):
            return data["records"]
        return [data]
    return []


def save_json(obj, output_path):
    """保存对象为 JSON 文件，自动创建父目录。"""
    out_dir = os.path.dirname(os.path.abspath(output_path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2, default=str)
