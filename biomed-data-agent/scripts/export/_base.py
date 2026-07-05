"""导出脚本公共基类与工具。

提供：load_records / load_lineage / setup_cli（--input/--out/--task-id/--lineage）、
flatten_record / get_source_columns / build_columns（展平 DataRecord 为表格行）、
statistics（{total, by_source, avg_confidence, flagged_count, conflict_count}）、
emit_ok / emit_error / log_stderr / utc_now（统一输出与时间戳）。
被 to_csv / to_excel / to_report / to_docx 复用。
"""
import argparse
import json
import sys
from datetime import datetime
from pathlib import Path


def load_records(input_path):
    """从 JSON 文件或目录加载 DataRecord 列表（支持裸数组/单对象/{"records":[...]} 信封）。"""
    p = Path(input_path)

    def _load(fp):
        with open(fp, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and isinstance(data.get("records"), list):
            return data["records"]
        return [data] if isinstance(data, dict) else []
    if p.is_dir():
        records = []
        for fp in sorted(p.rglob("*.json")):
            records.extend(_load(fp))
        return records
    if p.is_file():
        return _load(p)
    raise FileNotFoundError(f"输入路径不存在: {input_path}")


def load_lineage(lineage_path):
    """加载 lineage.json。路径为空或文件不存在时返回 None。"""
    if not lineage_path:
        return None
    p = Path(lineage_path)
    if not p.is_file():
        return None
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def setup_cli(name, description):
    """返回 argparse.ArgumentParser，预设 --input/--out/--task-id/--lineage 参数。"""
    parser = argparse.ArgumentParser(prog=name, description=description)
    parser.add_argument("--input", required=True, help="输入 cleaned DataRecord JSON 文件或目录")
    parser.add_argument("--out", required=True, help="输出文件路径")
    parser.add_argument("--task-id", default="", help="任务 ID（用于报告头部）")
    parser.add_argument("--lineage", default=None, help="lineage.json 路径（可选）")
    return parser

def get_source_columns(record):
    """从 source_ref 提取 source_doi / source_url / source_pmid / source_accession 列。"""
    src = record.get("source_ref", {}) or {}
    return {k: (src.get(k, "") or "") for k in
            ("source_doi", "source_url", "source_pmid", "source_accession")}


def _serialize(v):
    """列表/字典序列化为 JSON 字符串；None 转空串。"""
    if isinstance(v, (list, dict)):
        return json.dumps(v, ensure_ascii=False)
    return "" if v is None else v


def flatten_record(record):
    """把 DataRecord 展平为顶层字段字典（用于 CSV/Excel）。

    顺序：record_id, task_id, [fields 展平], source_name, source_doi,
    source_url, source_pmid, source_accession, extraction_method,
    extraction_confidence, quality_flags, created_at
    """
    flat = {"record_id": record.get("record_id", "") or "",
            "task_id": record.get("task_id", "") or ""}
    for k, v in (record.get("fields", {}) or {}).items():
        flat[k] = _serialize(v)
    src = record.get("source_ref", {}) or {}
    flat["source_name"] = src.get("source_name", "") or ""
    flat.update(get_source_columns(record))
    flat["extraction_method"] = record.get("extraction_method", "") or ""
    conf = record.get("extraction_confidence")
    flat["extraction_confidence"] = "" if conf is None else conf
    flat["quality_flags"] = ";".join(str(x) for x in (record.get("quality_flags", []) or []))
    flat["created_at"] = record.get("created_at", "") or ""
    return flat


def build_columns(records):
    """构造完整列顺序：record_id, task_id, [fields...], source_name, ...,
    extraction_method, extraction_confidence, quality_flags, created_at。
    """
    cols = ["record_id", "task_id"]
    seen = set()
    for r in records:
        for k in (r.get("fields", {}) or {}).keys():
            if k not in seen:
                seen.add(k)
                cols.append(k)
    cols.extend(["source_name", "source_doi", "source_url", "source_pmid",
                 "source_accession", "extraction_method", "extraction_confidence",
                 "quality_flags", "created_at"])
    return cols


def statistics(records):
    """返回 {total, by_source, avg_confidence, flagged_count, conflict_count}。"""
    by_source, conf_sum, flagged, conflict = {}, 0.0, 0, 0
    for r in records:
        src = (r.get("source_ref", {}) or {}).get("source_name", "unknown")
        by_source[src] = by_source.get(src, 0) + 1
        conf_sum += float(r.get("extraction_confidence", 0.0) or 0.0)
        flags = r.get("quality_flags", []) or []
        if flags:
            flagged += 1
        if "conflict" in flags:
            conflict += 1
    total = len(records)
    return {"total": total, "by_source": by_source,
            "avg_confidence": round(conf_sum / total, 4) if total else 0.0,
            "flagged_count": flagged, "conflict_count": conflict}


def utc_now():
    """返回 ISO 8601 UTC 时间戳。"""
    return datetime.utcnow().isoformat() + "Z"

def emit_ok(output, rows=0, **extra):
    """输出成功 JSON 到 stdout：{"status":"ok","output":...,"rows":N}。"""
    payload = {"status": "ok", "output": str(output), "rows": int(rows)}
    payload.update(extra)
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()

def emit_error(message):
    """输出错误 JSON 到 stdout 并以 exit code 1 退出。"""
    sys.stdout.write(json.dumps({"status": "error", "message": message},
                                ensure_ascii=False) + "\n")
    sys.stdout.flush()
    sys.exit(1)

def log_stderr(msg):
    """日志输出到 stderr。"""
    sys.stderr.write(f"[export] {msg}\n")
    sys.stderr.flush()
