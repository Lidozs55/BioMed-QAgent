"""Learned skill save/load utilities — self-evolution engine.

Tools for the main agent to save successful browser-based workflows
as reusable learned skills, including EVOLUTION.md lifecycle tracking.
"""
from __future__ import annotations

import ast
import importlib
import logging
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.skills.registry import SkillCategory, SkillDef

logger = logging.getLogger(__name__)

_VALID_CATEGORIES = frozenset(
    {SkillCategory.DISCOVERY.value, SkillCategory.ACQUISITION.value,
     SkillCategory.PROCESSING.value, SkillCategory.ANALYSIS.value})
_LEARNED_BASE = Path(__file__).resolve().parent / "learned"

# ---------------------------------------------------------------------------
# Security validators (BLOCKER fix — docs/REVIEW_2026-07-18.md §17.3 item 6)
#
# save_workflow_as_skill is an LLM-facing @function_tool, so ``name`` and
# ``code`` are attacker-controlled (via prompt injection). Without validation:
#   - name="../malicious" enables path traversal (write outside learned/)
#   - code with ``exec``/``import os`` enables RCE when load_learned_skill
#     runs the file via importlib.import_module
# These validators block the obvious RCE primitives.
# ---------------------------------------------------------------------------

_SKILL_NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")

#: Modules that learned-skill code is allowed to import from. Anything else
#: (os, subprocess, shutil, pathlib, builtins, ...) is rejected at save time
#: and re-rejected at load time (defense in depth).
_ALLOWED_IMPORT_MODULES = frozenset({
    "app.skills.registry",
    "app.skills.evolution",
    "app.domain.contracts",
    "app.agent_loop.context",
    "agents",
    "pydantic",
    "typing",
    "datetime",
})

#: Call targets that are forbidden in learned-skill code.
_FORBIDDEN_CALL_NAMES = frozenset({
    "exec", "eval", "compile", "open", "__import__",
    "globals", "locals", "vars", "input", "breakpoint",
    "exit", "quit", "help",
})


def validate_skill_name(name: str) -> None:
    """Reject skill names that could enable path traversal or invalid modules.

    Allowed: lowercase letters, digits, underscores; must start with a letter.
    This matches Python identifier rules (lowercase subset) and prevents
    ``..`` / ``/`` / ``\\`` traversal, file extension injection, etc.

    Raises:
        ValueError: If ``name`` does not match ``^[a-z][a-z0-9_]*$``.
    """
    if not _SKILL_NAME_RE.fullmatch(name):
        raise ValueError(
            f"Invalid skill name {name!r}. Must match ^[a-z][a-z0-9_]*$ "
            f"(lowercase letters, digits, underscores; must start with a "
            f"letter)."
        )


def validate_skill_code(code: str) -> None:
    """Reject learned-skill code that contains dangerous AST constructs.

    Allowed:
        - ``from <whitelisted_module> import <names>`` (ImportFrom)
        - Function/class definitions, assignments, control flow, calls to
          non-dangerous functions.

    Forbidden:
        - Bare ``import X`` (ast.Import) — force explicit ``from ... import``
          so every import is checked against the whitelist.
        - ``from <non-whitelisted_module>`` imports (e.g. ``os``, ``subprocess``,
          ``shutil``, ``pathlib``).
        - Calls to ``exec`` / ``eval`` / ``compile`` / ``open`` / ``__import__``
          / ``globals`` / ``locals`` / ``vars`` / ``input`` / ``breakpoint``
          / ``exit`` / ``quit`` / ``help``.
        - Access to dunder attributes (``__builtins__``, ``__class__``,
          ``__subclasses__``, …) — blocks common sandbox-escape primitives.
        - Use of dunder names (e.g. ``__builtins__`` as a bare Name).

    Raises:
        ValueError: On any forbidden construct, with the offending line number.
    """
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        raise ValueError(f"Skill code has syntax error: {exc}") from exc

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            raise ValueError(
                f"Bare 'import' statements are not allowed in learned skills "
                f"(line {node.lineno}). Use 'from <module> import <name>' "
                f"with an allowed module instead."
            )
        if isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if module not in _ALLOWED_IMPORT_MODULES:
                raise ValueError(
                    f"Import from {module!r} is not allowed in learned skills "
                    f"(line {node.lineno}). Allowed modules: "
                    f"{', '.join(sorted(_ALLOWED_IMPORT_MODULES))}."
                )
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name) and func.id in _FORBIDDEN_CALL_NAMES:
                raise ValueError(
                    f"Call to {func.id!r}() is forbidden in learned skills "
                    f"(line {node.lineno})."
                )
        if isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            raise ValueError(
                f"Access to dunder attribute {node.attr!r} is forbidden in "
                f"learned skills (line {node.lineno})."
            )
        if isinstance(node, ast.Name) and node.id.startswith("__"):
            raise ValueError(
                f"Use of dunder name {node.id!r} is forbidden in learned "
                f"skills (line {node.lineno})."
            )


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
        name: Unique skill name (used as directory and module name). Must
            match ``^[a-z][a-z0-9_]*$`` — validated by ``validate_skill_name``
            to prevent path traversal.
        category: One of discovery, acquisition, processing, analysis.
        code: Python source code for the skill. Validated by
            ``validate_skill_code`` to reject ``exec``/``eval``/``open``/
            non-whitelisted imports/dunder access (RCE prevention).
        description: Short summary of what the skill does.
        instructions: Agent-facing instructions fragment.
        source_url: URL of the website that generated this skill.
        task_id: The task ID that spawned this skill.

    Returns:
        Path to the created skill .py file.

    Raises:
        ValueError: If ``name`` fails regex validation, ``code`` contains
            forbidden AST constructs, or ``category`` is invalid.
    """
    validate_skill_name(name)
    validate_skill_code(code)
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

    The template intentionally contains only fields that are actually
    populated at creation time. Earlier versions included ``[to be filled]``
    placeholders for Browser Steps / Downloaded Files / Verification /
    Known Limitations — those were never backfilled, so the file was
    permanently in a template state. Removed per docs/REVIEW_2026-07-18.md
    §17.3 item 4.

    Args:
        name: Skill name.
        category: Skill category string.
        source_url: URL of the source website.
        task_id: The originating task ID.
        description: Human-readable description.

    Returns:
        EVOLUTION.md content as a markdown string.
    """
    now = datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S UTC")
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

    Defense in depth: re-validates ``name`` against the regex whitelist and
    re-runs ``validate_skill_code`` on the on-disk ``.py`` file before
    importing. This blocks both prompt-injection-driven saves that bypassed
    validation and on-disk tampering after a skill was saved.

    Args:
        name: Skill directory/module name.
        category: One of discovery, acquisition, processing, analysis.

    Returns:
        SkillDef with enabled=True if import succeeds, None otherwise
        (including when validation fails).
    """
    if category not in _VALID_CATEGORIES:
        logger.warning(
            "Cannot load learned skill '%s': invalid category '%s'",
            name, category)
        return None

    try:
        validate_skill_name(name)
    except ValueError as exc:
        logger.warning(
            "Cannot load learned skill %r: %s", name, exc)
        return None

    skill_file = _LEARNED_BASE / category / name / f"{name}.py"
    if not skill_file.is_file():
        logger.warning(
            "Learned skill file not found: %s", skill_file)
        return None

    # Re-validate on-disk code before import (defense in depth).
    try:
        validate_skill_code(skill_file.read_text(encoding="utf-8"))
    except ValueError as exc:
        logger.error(
            "Refusing to load learned skill %r: code validation failed: %s",
            name, exc)
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
