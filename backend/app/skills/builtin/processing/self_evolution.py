"""Self-evolution skill — agent-facing tools to save and list learned workflows.

Provides function tools the main agent uses to persist browser-based
workflows as reusable learned skills and discover previously saved skills.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.skills.evolution import list_learned_skills, save_learned_skill
from app.skills.registry import SkillCategory, SkillDef, skill_registry

logger = logging.getLogger(__name__)


@function_tool
def save_workflow_as_skill(
    ctx: RunContextWrapper[Any],
    name: str,
    category: str,
    code: str,
    description: str,
    source_url: str,
) -> str:
    """Save a successful browser-based workflow as a reusable learned skill.

    Use this after successfully completing a website data acquisition or
    processing workflow. The saved skill can be reloaded for future similar
    tasks.

    Args:
        name: Unique name for the skill (no spaces, lowercase preferred).
        category: One of discovery, acquisition, processing, or analysis.
        code: Complete Python source code for the skill module.
        description: Short summary of what this skill accomplishes.
        source_url: The website URL this workflow was built for.
    """
    run_ctx: RunContext = ctx.context
    task_id = getattr(run_ctx, "task_id", "unknown")

    logger.info(
        "Saving learned skill '%s' (category=%s) from task %s, source=%s",
        name, category, task_id, source_url)

    try:
        skill_path = save_learned_skill(
            name=name,
            category=category,
            code=code,
            description=description,
            instructions=(
                f"Use the {name} skill tools to interact with {source_url}. "
                f"Description: {description}"
            ),
            source_url=source_url,
            task_id=task_id,
        )
        return json.dumps({
            "status": "ok",
            "skill_name": name,
            "category": category,
            "skill_path": str(skill_path),
            "task_id": task_id,
        }, ensure_ascii=False)
    except ValueError as exc:
        return json.dumps({
            "status": "error",
            "error": str(exc),
        }, ensure_ascii=False)
    except Exception as exc:
        logger.exception("Failed to save learned skill '%s'", name)
        return json.dumps({
            "status": "error",
            "error": f"Failed to save skill: {exc}",
        }, ensure_ascii=False)


@function_tool
def list_my_learned_skills(ctx: RunContextWrapper[Any]) -> str:
    """List all previously saved learned skills.

    Returns a JSON array with each skill's name, category, path,
    and whether it has EVOLUTION.md documentation.
    """
    try:
        skills = list_learned_skills()
        logger.info("Listed %d learned skills", len(skills))
        return json.dumps({
            "status": "ok",
            "count": len(skills),
            "skills": skills,
        }, ensure_ascii=False)
    except Exception as exc:
        logger.exception("Failed to list learned skills")
        return json.dumps({
            "status": "error",
            "error": f"Failed to list learned skills: {exc}",
        }, ensure_ascii=False)


self_evolution_skill = SkillDef(
    name="self_evolution",
    category=SkillCategory.PROCESSING,
    description=(
        "Save and list agent-generated learned skills. "
        "Use when the agent successfully completes a browser-based workflow "
        "and wants to persist it for future reuse, or when it needs to "
        "discover previously saved workflows."
    ),
    instructions=(
        "After successfully completing a website acquisition or processing "
        "workflow, call save_workflow_as_skill to persist it. "
        "Use list_my_learned_skills to discover previously saved workflows. "
        "Saved skills have EVOLUTION.md files tracking their history."
    ),
    tools=[save_workflow_as_skill, list_my_learned_skills],
    supported_sources=["*"],
    version="0.1.0",
)

skill_registry.register(self_evolution_skill)
