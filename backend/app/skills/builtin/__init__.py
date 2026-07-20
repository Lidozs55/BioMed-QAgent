"""Builtin skill discovery and catalog adaptation."""

from __future__ import annotations

import importlib
import pkgutil

from app.skills.catalog import SkillDescriptor
from app.skills.registry import skill_registry

_NON_SELECTABLE_BUILTINS = {
    "browser_fallback",
    "local_cache",
    "web_visual_capture",
    "literature_understanding",
    "self_evolution",
    "pdf_extraction",
    "extract_chart_data_vlm",
    "analysis",
}
_PIPELINE_SUPPORTED_BUILTINS = {"pubmed", "geo"}


def load_builtin_skill_descriptors() -> tuple[SkillDescriptor, ...]:
    """Import every builtin skill module and adapt the registered definitions."""
    for module in pkgutil.walk_packages(__path__, prefix=f"{__name__}."):
        if not module.ispkg:
            importlib.import_module(module.name)
    return tuple(
        SkillDescriptor.from_skill_def(
            skill,
            display_name=skill.name.replace("_", " ").title(),
            user_selectable=(
                bool(skill.supported_sources)
                and skill.name not in _NON_SELECTABLE_BUILTINS
            ),
            pipeline_supported=skill.name in _PIPELINE_SUPPORTED_BUILTINS,
        )
        for skill in skill_registry.list_enabled()
    )


__all__ = ["load_builtin_skill_descriptors"]
