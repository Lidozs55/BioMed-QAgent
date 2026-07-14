"""工具注册中心 — 汇总所有 function_tool 供 Agent 装载。

数据获取相关工具（search/parse/analyze）已迁移至 skill 模块。
"""

from __future__ import annotations

from contextlib import suppress

from app.skills.registry import SkillDef, build_agent_config, skill_registry
from app.tools.io import list_files, read_file, write_file

browser_fallback_skill: SkillDef | None = None
with suppress(ImportError):
    from app.skills.builtin.acquisition.browser import browser_fallback_skill  # noqa: F401
self_evolution_skill: SkillDef | None = None
with suppress(ImportError):
    from app.skills.builtin.processing.self_evolution import self_evolution_skill  # noqa: F401


def _import_skill_modules() -> None:
    """尝试导入技能模块，失败时不阻塞。"""
    with suppress(ImportError):
        import app.skills.builtin.discovery.pubmed  # noqa: F401
    with suppress(ImportError):
        import app.skills.builtin.discovery.understanding  # noqa: F401
    with suppress(ImportError):
        import app.skills.builtin.acquisition.geo  # noqa: F401
    with suppress(ImportError):
        import app.skills.builtin.acquisition.pdb  # noqa: F401
    with suppress(ImportError):
        import app.skills.builtin.acquisition.gdc  # noqa: F401
    with suppress(ImportError):
        import app.skills.builtin.acquisition.xena  # noqa: F401
    with suppress(ImportError):
        import app.skills.builtin.acquisition.browser  # noqa: F401
    with suppress(ImportError):
        import app.skills.builtin.processing.self_evolution  # noqa: F401
    with suppress(ImportError):
        import app.skills.builtin.processing.extract_tables  # noqa: F401
    with suppress(ImportError):
        import app.skills.builtin.analysis.stats  # noqa: F401


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
