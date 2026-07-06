"""生物信息学分析公共基类与工具。

提供：
- load_records: 从 JSON 加载 DataRecord 列表
- save_result / save_error: 保存统一 AnalysisResult / 错误信封 JSON
- setup_cli: 构造统一 argparse（--input/--out/--task-id）
- make_result: 构造统一 AnalysisResult 结构
- extract_genes: 从 DataRecord 提取去重 gene_symbol
- 常用统计学阈值常量

被 differential_expression.py / enrichment.py / ppi_network.py 复用。
路径使用 pathlib 兼容跨平台；代码中按 Unix 风格书写。
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

# ===== 常用统计学阈值 =====
P_VALUE_THRESHOLD = 0.05
LOG2FC_THRESHOLD = 1.0


def utc_now() -> str:
    """返回 ISO 8601 UTC 时间戳。"""
    return datetime.utcnow().isoformat() + "Z"


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


def make_result(task_id, analysis_type, summary, stats_table, chart_data, parameters):
    """构造统一 AnalysisResult 结构。

    返回 dict，包含分析类型、摘要、统计表、可视化数据、参数与时间戳。
    """
    return {
        "task_id": task_id,
        "analysis_type": analysis_type,
        "summary": summary,
        "stats_table": stats_table,
        "chart_data": chart_data,
        "parameters": parameters,
        "created_at": utc_now(),
    }


def save_result(result, output_path):
    """保存 AnalysisResult JSON。包装成统一成功信封，自动创建父目录。

    成功: {"status": "ok", "result": {...}, "summary": "..."}
    """
    payload = {
        "status": "ok",
        "result": result,
        "summary": result.get("summary", ""),
    }
    p = Path(output_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2, default=str)
    return payload


def save_error(message, output_path=None):
    """保存错误信封到文件（若提供路径），并返回错误 payload。

    失败: {"status": "error", "message": "..."}
    """
    payload = {"status": "error", "message": message}
    if output_path:
        p = Path(output_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
    return payload


def setup_cli(name, description):
    """返回 argparse.ArgumentParser，预设 --input/--out/--task-id 参数。

    --input 不强制必填（enrichment/ppi 可改用 --gene-list）；
    --out 必填；--task-id 可选。
    """
    parser = argparse.ArgumentParser(prog=name, description=description)
    parser.add_argument("--input", default=None,
                        help="输入 DataRecord JSON 文件或目录")
    parser.add_argument("--out", required=True,
                        help="输出 AnalysisResult JSON 文件路径")
    parser.add_argument("--task-id", default="", help="任务 ID（用于溯源）")
    return parser


def extract_genes(records):
    """从 DataRecord 列表中提取去重的 gene_symbol。

    优先取 fields.gene_symbol；缺失时尝试 fields.gene / fields.symbol。
    """
    genes = []
    seen = set()
    for r in records:
        fields = r.get("fields", {}) if isinstance(r, dict) else {}
        sym = fields.get("gene_symbol") or fields.get("gene") or fields.get("symbol")
        if sym and sym not in seen:
            seen.add(sym)
            genes.append(str(sym))
    return genes


def log_stderr(msg):
    """日志输出到 stderr。"""
    sys.stderr.write(f"[analysis] {msg}\n")
    sys.stderr.flush()
