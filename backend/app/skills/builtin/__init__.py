"""Builtin skill tool collection — Phase 2 direct-tools layout.

The Python Skill catalog/gateway/registry runtime was removed in Phase 2
(docs/migration/phase2-skills-tools-migration.md). Builtin skill modules now
export plain module constants (SKILL_NAME, SKILL_CATEGORY, SKILL_DESCRIPTION,
SKILL_VERSION, SUPPORTED_SOURCES, SKILL_TOOLS) and their operations are
registered as direct tools on the legacy Agent. The SOP knowledge that used to
live in SkillDef.instructions migrated to `.pi/skills/<name>/SKILL.md`.

The stable Skill ↔ Tool mapping is mirrored in
`server/src/agent/skills/skill-tool-map.ts`; `backend/tests/test_builtin_tools.py`
pins this Python side so the two cannot drift.
"""

from __future__ import annotations

import pkgutil
from dataclasses import dataclass

from app.domain.contracts.enums import DATABASE_IDENTIFIER_ALIASES, SOURCE_CAPABILITIES
from app.skills.categories import SkillCategory

# Skills that exist as agent capabilities but must not be user-selectable
# databases in the UI (research aids, cache access, visual evidence, …).
_NON_SELECTABLE_BUILTINS = {
    "browser_fallback",
    "local_cache",
    "web_visual_capture",
    "literature_understanding",
    "pdf_extraction",
    "extract_chart_data_vlm",
    "analysis",
}

# Derive the pipeline-supported set from the single source-of-truth capability
# table so the databases projection and the Pipeline tool cannot drift.
_PIPELINE_SUPPORTED_BUILTINS = {
    identifier
    for identifier, database in DATABASE_IDENTIFIER_ALIASES.items()
    if SOURCE_CAPABILITIES[database].value == "pipeline_supported"
}

# The create_skill module is deleted in Phase 2; excluded defensively until the
# file itself is removed.
_EXCLUDED_MODULES = {"create_skill"}


@dataclass(frozen=True, slots=True)
class BuiltinSkillRecord:
    """Static metadata for one builtin skill's direct tools."""

    name: str
    category: SkillCategory
    description: str
    version: str
    supported_sources: tuple[str, ...]
    tool_names: tuple[str, ...]
    user_selectable: bool
    pipeline_supported: bool


def builtin_skill_modules() -> tuple[str, ...]:
    """Return builtin module names from the single package discovery path."""
    return tuple(
        module.name
        for module in pkgutil.walk_packages(__path__, prefix=f"{__name__}.")
        if not module.ispkg
        and not module.name.rsplit(".", 1)[-1].startswith("_")
        and not any(name in module.name for name in _EXCLUDED_MODULES)
    )


def load_builtin_tools() -> list:
    """Import every builtin skill module and return the deduped direct tools."""
    for module_name in builtin_skill_modules():
        __import__(module_name)
    seen: set[str] = set()
    tools: list = []
    for module_name in builtin_skill_modules():
        module = __import__(module_name, fromlist=["SKILL_TOOLS"])
        for tool in getattr(module, "SKILL_TOOLS", []):
            tool_name = getattr(tool, "name", str(tool))
            if tool_name not in seen:
                seen.add(tool_name)
                tools.append(tool)
    return tools


def builtin_skill_records() -> dict[str, BuiltinSkillRecord]:
    """Return the static builtin skill table keyed by skill name."""
    records: dict[str, BuiltinSkillRecord] = {}
    for module_name in builtin_skill_modules():
        module = __import__(module_name, fromlist=["SKILL_NAME"])
        name = getattr(module, "SKILL_NAME", None)
        if name is None:
            continue
        tool_names = tuple(
            getattr(tool, "name", str(tool))
            for tool in getattr(module, "SKILL_TOOLS", [])
        )
        records[name] = BuiltinSkillRecord(
            name=name,
            category=module.SKILL_CATEGORY,
            description=getattr(module, "SKILL_DESCRIPTION", ""),
            version=getattr(module, "SKILL_VERSION", "0.1.0"),
            supported_sources=tuple(getattr(module, "SUPPORTED_SOURCES", [])),
            tool_names=tool_names,
            user_selectable=(
                name not in _NON_SELECTABLE_BUILTINS
                and bool(getattr(module, "SUPPORTED_SOURCES", []))
            ),
            pipeline_supported=name in _PIPELINE_SUPPORTED_BUILTINS,
        )
    return records


__all__ = [
    "builtin_skill_modules",
    "builtin_skill_records",
    "load_builtin_tools",
    "BuiltinSkillRecord",
]
