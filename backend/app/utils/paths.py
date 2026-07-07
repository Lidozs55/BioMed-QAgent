"""路径工具 — 定位 backend/app/resources/ 等资源目录。"""
from __future__ import annotations

from pathlib import Path

from app.config import RESOURCES_DIR


def get_dictionaries_dir() -> Path:
    """返回 dictionaries/ 目录（字段对齐/单位归一化字典）。"""
    return RESOURCES_DIR / "dictionaries"


def get_schemas_dir() -> Path:
    """返回 schemas/ 目录（DataRecord 等结构定义）。"""
    return RESOURCES_DIR / "schemas"


def get_domain_templates_dir() -> Path:
    """返回 domain_templates/ 目录（领域模板）。"""
    return RESOURCES_DIR / "domain_templates"


def get_task_output_dir(task_id: str) -> Path:
    """返回指定任务的输出目录。"""
    from app.config import OUTPUT_DIR
    d = OUTPUT_DIR / task_id
    d.mkdir(parents=True, exist_ok=True)
    return d
