"""工具注册中心 — 汇总所有 function_tool 供 Agent 装载。

数据获取相关工具（search/parse/analyze）已迁移至 skill 模块。
"""

from __future__ import annotations

from contextlib import suppress

from app.skills.registry import build_agent_config, skill_registry
from app.tools.io import list_files, read_file, write_file

BUILTIN_SKILL_MODULES = (
    "app.skills.builtin.discovery.pubmed",
    "app.skills.builtin.discovery.understanding",
    "app.skills.builtin.acquisition.geo",
    "app.skills.builtin.acquisition.pdb",
    "app.skills.builtin.acquisition.gdc",
    "app.skills.builtin.acquisition.xena",
    "app.skills.builtin.acquisition.browser",
    "app.skills.builtin.acquisition.reactome",
    "app.skills.builtin.acquisition.pubchem",
    "app.skills.builtin.processing.self_evolution",
    "app.skills.builtin.processing.extract_tables",
    "app.skills.builtin.analysis.stats",
)


def _import_skill_modules() -> None:
    """尝试导入技能模块，失败时不阻塞。"""
    for module_name in BUILTIN_SKILL_MODULES:
        with suppress(ImportError):
            __import__(module_name)


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
