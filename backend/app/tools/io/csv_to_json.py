"""csv_to_json.py — CSV 转 DataRecord JSON 列表。

输入：CSV 文件（UTF-8，首行为表头，支持引号转义与空值）
输出：符合 schemas/data_record.schema.json 的 DataRecord 列表

列识别规则：
  - 有 record_id 列则用作 record_id，否则用 文件路径+行号 hash 生成 csv-<hash8>
  - 有 source_name 列则构造 source_ref.source_name，否则用 source_name 参数（默认 csv_import）
  - source_doi / source_url / source_pmid / source_accession 列若存在则写入 source_ref
  - extraction_confidence 列若存在则覆盖默认置信度（0.85）

模块导入示例：
    from .io.csv_to_json import convert
    records = convert("data.csv", task_id="T1", source_name="user_upload")
"""
import csv

from ._base import _hash8, make_record, save_json

# 不进入 fields 的元数据列（与 source_ref / 置信度相关）
_META_COLS = {"record_id", "source_name", "source_doi", "source_url",
              "source_pmid", "source_accession", "extraction_confidence"}


def _try_infer(val):
    """简单类型推断：布尔 / 整数 / 浮点 / 字符串。"""
    s = str(val).strip()
    if s == "":
        return ""
    if s.lower() in ("true", "false"):
        return s.lower() == "true"
    try:
        if "." in s or "e" in s.lower():
            return float(s)
        return int(s)
    except (ValueError, TypeError):
        return s


def _build_source_ref(source_name, file_path, row):
    """构造 source_ref，从行中提取可选字段。"""
    ref = {"source_name": source_name, "source_type": "file", "query": file_path}
    for field in ("source_doi", "source_url", "source_pmid", "source_accession"):
        val = row.get(field)
        if val:
            ref[field] = str(val)
    return ref


def convert(input_path, task_id, source_name):
    """读取 CSV 并转为 DataRecord 列表。"""
    records = []
    with open(input_path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        headers = reader.fieldnames or []
        has_rid = "record_id" in headers
        for i, row in enumerate(reader):
            # 收集 fields（排除元数据列与空值）
            fields = {}
            for k, v in row.items():
                if not k or k in _META_COLS:
                    continue
                if v is None or v == "":
                    continue
                fields[k] = _try_infer(v)
            if not fields:
                continue
            src = row.get("source_name") or source_name
            rid = row.get("record_id") if has_rid and row.get("record_id") else None
            if not rid:
                # 用 文件路径+行号+行内容 生成稳定 hash，保证幂等与去重可行
                seed = f"{input_path}:{i}:{sorted(row.items())}"
                rid = f"csv-{_hash8(seed)}"
            rec = make_record(task_id, src, fields, input_path)
            rec["record_id"] = rid
            rec["source_ref"] = _build_source_ref(src, input_path, row)
            conf = row.get("extraction_confidence")
            if conf:
                try:
                    rec["extraction_confidence"] = float(conf)
                except (ValueError, TypeError):
                    pass
            records.append(rec)
    return records
