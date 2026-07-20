"""工具注册中心 — 汇总所有 function_tool 供 Agent 装载。

数据获取相关工具（search/parse/analyze）已迁移至 skill 模块。
"""

from __future__ import annotations

from app.skills.builtin import load_builtin_skill_descriptors
from app.skills.registry import build_agent_config, skill_registry
from app.tools.io import list_files, read_file, write_file


def _import_skill_modules() -> None:
    """Compatibility wrapper around the unified builtin bootstrap path."""
    load_builtin_skill_descriptors()


def get_all_tools() -> list:
    """返回所有已注册的 function_tool，供主 Agent 装载。"""
    _import_skill_modules()
    skills = skill_registry.list_enabled()
    _, tools = build_agent_config(skills)
    tools.extend([read_file, write_file, list_files])
    seen: set[str] = set()
    unique: list = []
    for t in tools:
        name = getattr(t, "name", str(t))
        if name not in seen:
            seen.add(name)
            unique.append(t)
    return unique
