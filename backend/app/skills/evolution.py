"""Learned skill save/load utilities — self-evolution engine.

Tools for the main agent to save successful browser-based workflows
as reusable learned skills, including EVOLUTION.md lifecycle tracking.
"""
from __future__ import annotations

import importlib
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.skills.registry import SkillCategory, SkillDef

logger = logging.getLogger(__name__)

_VALID_CATEGORIES = frozenset(
    {SkillCategory.DISCOVERY.value, SkillCategory.ACQUISITION.value,
     SkillCategory.PROCESSING.value, SkillCategory.ANALYSIS.value})
_LEARNED_BASE = Path(__file__).resolve().parent / "learned"


def save_learned_skill(
    name: str,
    category: str,
    code: str,
    description: str,
    instructions: str,
    source_url: str,
    task_id: str,
) -> Path:
    """Persist a learned skill to disk.

    Args:
        name: Unique skill name (used as directory and module name).
        category: One of discovery, acquisition, processing, analysis.
        code: Python source code for the skill.
        description: Short summary of what the skill does.
        instructions: Agent-facing instructions fragment.
        source_url: URL of the website that generated this skill.
        task_id: The task ID that spawned this skill.

    Returns:
        Path to the created skill .py file.

    Raises:
        ValueError: If category is invalid.
    """
    if category not in _VALID_CATEGORIES:
        raise ValueError(
            f"Invalid category '{category}'. Must be one of: "
            f"{', '.join(sorted(_VALID_CATEGORIES))}")

    skill_dir = _LEARNED_BASE / category / name
    skill_dir.mkdir(parents=True, exist_ok=True)

    skill_file = skill_dir / f"{name}.py"
    skill_file.write_text(code, encoding="utf-8")

    evolution_md = create_evolution_md(
        name=name,
        category=category,
        source_url=source_url,
        task_id=task_id,
        description=description,
    )
    (skill_dir / "EVOLUTION.md").write_text(evolution_md, encoding="utf-8")

    init_file = skill_dir / "__init__.py"
    if not init_file.exists():
        init_file.write_text(
            f"\"\"\"learned {category} Skill — {name}: {description}\"\"\"\n",
            encoding="utf-8")

    logger.info(
        "Saved learned skill '%s' in category '%s' at %s",
        name, category, skill_file)

    return skill_file


def create_evolution_md(
    name: str,
    category: str,
    source_url: str,
    task_id: str,
    description: str,
) -> str:
    """Generate an EVOLUTION.md template for a learned skill.

    Args:
        name: Skill name.
        category: Skill category string.
        source_url: URL of the source website.
        task_id: The originating task ID.
        description: Human-readable description.

    Returns:
        EVOLUTION.md content as a markdown string.
    """
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    return (
        f"# {name} — Evolution Record\n"
        f"\n"
        f"| Field | Value |\n"
        f"|-------|-------|\n"
        f"| Created | {now} |\n"
        f"| Category | {category} |\n"
        f"| Target | {source_url} |\n"
        f"| Source Task | {task_id} |\n"
        f"| Status | auto-generated |\n"
        f"| Description | {description} |\n"
        f"\n"
        f"## Browser Steps\n"
        f"[to be filled]\n"
        f"\n"
        f"## Downloaded Files\n"
        f"[to be filled]\n"
        f"\n"
        f"## Verification\n"
        f"[to be filled]\n"
        f"\n"
        f"## Usage Stats\n"
        f"\n"
        f"| Metric | Count |\n"
        f"|--------|-------|\n"
        f"| Successful Uses | 0 |\n"
        f"| Failed Uses | 0 |\n"
        f"\n"
        f"## Modifications\n"
        f"\n"
        f"| Date | Author | Change |\n"
        f"|------|--------|--------|\n"
        f"| {now} | auto-generated | Initial creation from task {task_id} |\n"
        f"\n"
        f"## Known Limitations\n"
        f"[to be filled]\n"
    )


def list_learned_skills() -> list[dict[str, Any]]:
    """Scan the learned skills directory and return discovered skills.

    Returns:
        List of dicts with keys: name, category, path (relative to learned/),
        has_evolution_md, has_code.
    """
    results: list[dict[str, Any]] = []
    _ensure_learned_base()

    for category_dir in _LEARNED_BASE.iterdir():
        if not category_dir.is_dir():
            continue
        category = category_dir.name
        if category.startswith("_") or category == "__pycache__":
            continue

        for skill_dir in category_dir.iterdir():
            if not skill_dir.is_dir():
                continue
            name = skill_dir.name
            if name.startswith("_") or name == "__pycache__":
                continue

            skill_file = skill_dir / f"{name}.py"
            evolution_file = skill_dir / "EVOLUTION.md"
            relative = skill_file.relative_to(_LEARNED_BASE.parent)

            results.append({
                "name": name,
                "category": category,
                "path": str(relative),
                "has_evolution_md": evolution_file.exists(),
                "has_code": skill_file.exists(),
            })

    return results


def load_learned_skill(name: str, category: str) -> SkillDef | None:
    """Attempt to import and return a learned skill's SkillDef.

    Args:
        name: Skill directory/module name.
        category: One of discovery, acquisition, processing, analysis.

    Returns:
        SkillDef with enabled=True if import succeeds, None otherwise.
    """
    if category not in _VALID_CATEGORIES:
        logger.warning(
            "Cannot load learned skill '%s': invalid category '%s'",
            name, category)
        return None

    module_path = f"app.skills.learned.{category}.{name}.{name}"
    try:
        mod = importlib.import_module(module_path)
    except ModuleNotFoundError:
        logger.warning(
            "Learned skill module not found: %s", module_path)
        return None
    except Exception as exc:
        logger.error(
            "Failed to import learned skill module %s: %s",
            module_path, exc)
        return None

    # Scan for a SkillDef instance in the module namespace.
    for attr_name in dir(mod):
        obj = getattr(mod, attr_name, None)
        if isinstance(obj, SkillDef):
            obj.enabled = True
            logger.info(
                "Loaded learned skill '%s' from %s", obj.name, module_path)
            return obj

    logger.warning(
        "No SkillDef found in learned skill module %s", module_path)
    return None


def _ensure_learned_base() -> None:
    """Ensure the learned/ base directory exists."""
    _LEARNED_BASE.mkdir(parents=True, exist_ok=True)
