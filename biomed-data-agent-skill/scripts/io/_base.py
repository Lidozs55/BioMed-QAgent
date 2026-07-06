"""_base.py — IO 转换公共基类与工具函数。

提供 setup_cli / detect_format / emit_ok / emit_error / make_record /
load_records / save_json 等共享工具，供 scripts/io 下所有转换脚本复用。
脚本通过 ``import _base`` 引用（运行时本目录会被加入 sys.path）。
"""
import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone


def _now_iso():
    """当前 UTC 时间 ISO 8601 字符串。"""
    return datetime.now(timezone.utc).isoformat()


def _hash8(text):
    """MD5 前 8 位，用于 record_id 生成。"""
    return hashlib.md5(text.encode("utf-8")).hexdigest()[:8]


def setup_cli(name, description):
    """返回 argparse.ArgumentParser，预设 --input/--out 参数。"""
    parser = argparse.ArgumentParser(prog=name, description=description)
    parser.add_argument("--input", required=True, help="输入文件路径")
    parser.add_argument("--out", required=True, help="输出文件路径")
    return parser


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


def emit_ok(output, count):
    """输出成功 JSON 到 stdout：{"status": "ok", "output": "...", "count": N}。"""
    print(json.dumps({"status": "ok", "output": output, "count": count},
                     ensure_ascii=False))


def emit_error(message):
    """输出错误 JSON 到 stdout 并 exit 1：{"status": "error", "message": "..."}。"""
    print(json.dumps({"status": "error", "message": message}, ensure_ascii=False))
    sys.exit(1)
