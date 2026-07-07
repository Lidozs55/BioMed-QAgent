"""merge_json.py — 多个 DataRecord JSON 合并。

输入：多个 JSON 文件或目录（目录会被递归扫描 *.json）
输出：合并后的单个 JSON（去重，基于 record_id）

合并策略：
  - 按 record_id 去重（首次出现的 record 保留）
  - 按 source_name 分组统计，写入输出信封 by_source 字段
  - 输出结构：{"records": [...], "count": N, "by_source": {...}}

模块导入示例：
    from .io.merge_json import merge, collect_inputs
    records, by_source = merge(["dir1/", "dir2/", "file.json"])
"""
import json
from pathlib import Path


def _load_one(fp):
    """读取单个 JSON 文件为 DataRecord 列表（支持裸数组/单对象/records 信封）。"""
    with open(fp, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        if "records" in data and isinstance(data["records"], list):
            return data["records"]
        return [data]
    return []


def collect_inputs(paths):
    """展开输入路径列表：目录递归扫描 *.json，文件直接收集。"""
    files = []
    for p in paths:
        pp = Path(p)
        if pp.is_dir():
            files.extend(sorted(pp.rglob("*.json")))
        elif pp.is_file():
            files.append(pp)
    return files


def merge(paths):
    """合并多个 JSON 文件，按 record_id 去重，返回 (records, by_source)。"""
    seen = {}
    by_source = {}
    for fp in collect_inputs(paths):
        for r in _load_one(fp):
            rid = r.get("record_id")
            if not rid:
                # 无 record_id 的记录跳过去重但保留？此处按 schema 要求跳过
                continue
            if rid in seen:
                continue
            seen[rid] = r
            src = r.get("source_ref", {}).get("source_name", "unknown")
            by_source[src] = by_source.get(src, 0) + 1
    return list(seen.values()), by_source
