"""_base.py — 达尔文自优化机制的公共基类与工具函数。

提供：
- utc_now / _hash8 / _load_json / _save_json 通用工具
- DEFAULT_THRESHOLDS 各 stage 默认阈值（达尔文判定标准）
- load_records 从 JSON 加载 DataRecord 列表（与 analysis/_base.py 兼容）
- make_evaluation 构造 EvaluationResult 结构
- save_evaluation 保存评估结果
- load_evaluation / save_reflection 评估与反思日志的读写
- setup_cli 构造统一 argparse

被 stage_evaluator.py / reflection_loop.py / keyword_expander.py 复用。
路径使用 pathlib 兼容跨平台；代码中按 Unix 风格书写。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path


# ===== 各 stage 默认阈值（达尔文 Stage Gate 判定标准）=====
# 任一指标未达标即 passed=false，触发反思循环
DEFAULT_THRESHOLDS = {
    "search": {
        "min_coverage": 0.6,        # 关键实体覆盖率 ≥ 60%
        "min_confidence": 0.7,      # 平均置信度 ≥ 0.7
        "max_conflict_rate": 0.3,   # 冲突率 ≤ 30%
        "min_sources": 2,           # 至少 2 个数据源有结果
    },
    "acquire": {
        "min_coverage": 0.6,
        "min_confidence": 0.65,
        "max_conflict_rate": 0.3,
        "min_sources": 2,
    },
    "parse": {
        "min_coverage": 0.7,
        "min_confidence": 0.75,
        "max_conflict_rate": 0.25,
        "min_sources": 2,
    },
    "clean": {
        "min_coverage": 0.8,        # 清洗后覆盖率应较高
        "min_confidence": 0.8,
        "max_conflict_rate": 0.2,
        "min_sources": 2,
    },
    "analyze": {
        "min_coverage": 0.7,
        "min_confidence": 0.8,
        "max_conflict_rate": 0.2,
        "min_sources": 1,           # 分析阶段不强求多源
    },
    "export": {
        "min_coverage": 0.9,        # 导出前覆盖率应最高
        "min_confidence": 0.8,
        "max_conflict_rate": 0.15,
        "min_sources": 2,
    },
}

# 达尔文循环最大迭代次数（每个 stage 最多自优化 3 轮）
MAX_ITERATIONS = 3


def utc_now() -> str:
    """返回 ISO 8601 UTC 时间戳。"""
    return datetime.utcnow().isoformat() + "Z"


def _hash8(text: str) -> str:
    """MD5 前 8 位，用于 ID 生成。"""
    return hashlib.md5(text.encode("utf-8")).hexdigest()[:8]


def _load_json(fp):
    """读取 JSON 文件，返回原始对象（不做 records 解包）。"""
    with open(fp, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_json(obj, fp):
    """保存 JSON 到文件，自动创建父目录。"""
    p = Path(fp)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2, default=str)


def load_records(input_path):
    """从 JSON 文件或目录加载 DataRecord 列表。

    支持裸数组 / 单对象 / {"records": [...]} 信封；目录则递归合并所有 .json。
    """
    p = Path(input_path)
    if p.is_dir():
        records = []
        for fp in sorted(p.rglob("*.json")):
            try:
                records.extend(_unpack_records(_load_json(fp)))
            except Exception:
                continue
        return records
    if p.is_file():
        return _unpack_records(_load_json(p))
    return []


def _unpack_records(data):
    """把多种结构解包为 records 列表。"""
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        if "records" in data and isinstance(data["records"], list):
            return data["records"]
        # 可能是 AnalysisResult 信封 {"status":"ok","result":{...}}
        if "result" in data and isinstance(data["result"], dict):
            return []  # 分析结果不是 DataRecord
        return [data]
    return []


def make_evaluation(task_id, stage, iteration, metrics, thresholds,
                    passed, gaps, suggestions):
    """构造符合 evaluation_result.schema.json 的 EvaluationResult。"""
    return {
        "task_id": task_id,
        "stage": stage,
        "iteration": iteration,
        "metrics": metrics,
        "thresholds": thresholds,
        "passed": passed,
        "gaps": gaps,
        "suggestions": suggestions,
        "created_at": utc_now(),
    }


def save_evaluation(evaluation, output_path):
    """保存评估结果到 JSON 文件，包装为统一信封。"""
    payload = {
        "status": "ok",
        "evaluation": evaluation,
        "passed": evaluation.get("passed", False),
    }
    _save_json(payload, output_path)
    return payload


def save_error(message, output_path=None):
    """保存错误信封。"""
    payload = {"status": "error", "message": message}
    if output_path:
        _save_json(payload, output_path)
    return payload


def load_evaluation(path):
    """读取评估结果 JSON，返回 EvaluationResult dict。"""
    data = _load_json(path)
    if isinstance(data, dict) and "evaluation" in data:
        return data["evaluation"]
    if isinstance(data, dict) and "task_id" in data and "stage" in data:
        return data
    return {}


def load_reflection(path):
    """读取反思日志 JSON。"""
    if not Path(path).exists():
        return None
    return _load_json(path)


def save_reflection(reflection, path):
    """保存反思日志 JSON。"""
    _save_json(reflection, path)


def setup_cli(name, description):
    """返回 argparse.ArgumentParser，预设 --task-id 参数。"""
    parser = argparse.ArgumentParser(prog=name, description=description)
    parser.add_argument("--task-id", default="default", help="任务 ID")
    parser.add_argument("--out", required=True, help="输出 JSON 文件路径")
    return parser


def emit_ok_stdout(payload):
    """输出成功信封到 stdout。"""
    print(json.dumps(payload, ensure_ascii=False, default=str))


def emit_error_stdout(message):
    """输出错误信封到 stdout 并 exit 1。"""
    print(json.dumps({"status": "error", "message": message}, ensure_ascii=False))
    sys.exit(1)


def log_stderr(msg):
    """日志输出到 stderr。"""
    sys.stderr.write(f"[optimization] {msg}\n")
    sys.stderr.flush()
