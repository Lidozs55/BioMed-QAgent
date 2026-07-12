"""工具注册中心 — 汇总所有 function_tool 供 Agent 装载。

数据获取相关工具（search/parse/analyze）已迁移至 skill 模块。
"""

from __future__ import annotations

from agents import function_tool

from app.skills.registry import build_agent_config, skill_registry
from app.tools.io import read_file, write_file, list_files


def _import_skill_modules() -> None:
    """尝试导入技能模块，失败时不阻塞。"""
    try:
        import app.skills.builtin.discovery.pubmed  # noqa: F401
    except ImportError:
        pass
    try:
        import app.skills.builtin.discovery.understanding  # noqa: F401
    except ImportError:
        pass
    try:
        import app.skills.builtin.acquisition.geo  # noqa: F401
    except ImportError:
        pass


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
