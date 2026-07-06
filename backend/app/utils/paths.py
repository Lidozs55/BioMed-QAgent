"""路径工具 — 定位 biomed-data-agent/scripts/ 目录。"""
from __future__ import annotations

import sys
from pathlib import Path

from app.config import SCRIPTS_DIR, SKILL_DIR


def get_scripts_dir() -> Path:
    """返回 biomed-data-agent/scripts/ 绝对路径。"""
    return SCRIPTS_DIR


def get_dictionaries_dir() -> Path:
    """返回 dictionaries/ 目录。"""
    return SKILL_DIR / "dictionaries"


def get_schemas_dir() -> Path:
    """返回 schemas/ 目录。"""
    return SKILL_DIR / "schemas"


def get_domain_templates_dir() -> Path:
    """返回 domain_templates/ 目录。"""
    return SKILL_DIR / "domain_templates"


def get_task_output_dir(task_id: str) -> Path:
    """返回指定任务的输出目录。"""
    from app.config import OUTPUT_DIR
    d = OUTPUT_DIR / task_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_script_path(script_name: str) -> Path:
    """返回脚本绝对路径。

    script_name 可以是 'datasources/pubmed_client.py' 或 'pubmed_client.py'。
    """
    p = SCRIPTS_DIR / script_name
    if p.exists():
        return p
    # 尝试在 datasources/ 下查找
    p2 = SCRIPTS_DIR / "datasources" / script_name
    if p2.exists():
        return p2
    return p  # 返回默认路径（可能在调用时报错）


def ensure_scripts_on_path():
    """将 scripts/ 各子目录加入 sys.path，使脚本可以 import _base。"""
    for subdir in ["", "datasources", "parsers", "cleaners", "analysis",
                    "optimization", "provenance", "viz", "export", "io"]:
        p = str(SCRIPTS_DIR / subdir) if subdir else str(SCRIPTS_DIR)
        if p not in sys.path:
            sys.path.insert(0, p)
