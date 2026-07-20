"""Stable Agent-facing gateway tools for the mutable skill catalog."""

from __future__ import annotations

import json
from typing import Any

from agents import FunctionTool, RunContextWrapper, function_tool
from jsonschema import ValidationError as JsonSchemaValidationError
from jsonschema.validators import validator_for

from app.agent_loop.context import RunContext
from app.skills.catalog import SkillCatalog, SkillDescriptor
from app.skills.registry import SkillCategory


def _is_allowed(descriptor: SkillDescriptor, context: RunContext) -> bool:
    allowlist = context.preferred_sources
    if not allowlist or descriptor.category != SkillCategory.ACQUISITION:
        return True
    if not descriptor.supported_sources:
        return True
    return bool(set(allowlist).intersection(descriptor.supported_sources))


def _error(
    code: str,
    message: str,
    *,
    skill: str | None = None,
    version: str | None = None,
    operation: str | None = None,
) -> str:
    return json.dumps(
        {
            "status": "error",
            "skill": skill,
            "version": version,
            "operation": operation,
            "error": {"code": code, "message": message},
        },
        ensure_ascii=False,
    )


def build_skill_gateway(catalog: SkillCatalog) -> tuple[FunctionTool, FunctionTool]:
    """Build stable SDK gateway tools bound to a catalog object."""

    @function_tool(name_override="find_skill")
    async def _find_skill(
        ctx: RunContextWrapper[RunContext],
        text: str = "",
        category: SkillCategory | None = None,
        source: str | None = None,
    ) -> str:
        """Find enabled skills by text, category, and supported data source."""
        query = text.casefold().strip()
        snapshot = catalog.snapshot()
        matches: list[dict[str, Any]] = []
        for descriptor in snapshot.skills.values():
            if not descriptor.enabled or not _is_allowed(descriptor, ctx.context):
                continue
            if category is not None and descriptor.category != category:
                continue
            if source is not None and source not in descriptor.supported_sources:
                continue
            haystack = " ".join(
                (
                    descriptor.name,
                    descriptor.display_name,
                    descriptor.description,
                    *descriptor.supported_sources,
                    *descriptor.operation_names,
                ),
            ).casefold()
            if query and query not in haystack:
                continue
            matches.append(descriptor.manifest.model_dump(mode="json"))
        return json.dumps(
            {
                "status": "ok",
                "generation": snapshot.generation,
                "skills": matches,
            },
            ensure_ascii=False,
        )

    @function_tool(name_override="invoke_skill", strict_mode=False)
    async def _invoke_skill(
        ctx: RunContextWrapper[RunContext],
        skill: str,
        operation: str,
        arguments: dict[str, Any],
    ) -> str:
        """Resolve and invoke one enabled skill operation."""
        snapshot = catalog.snapshot()
        descriptor = snapshot.skills.get(skill)
        if descriptor is None:
            return _error(
                "skill_not_found",
                f"Skill '{skill}' was not found.",
                skill=skill,
                operation=operation,
            )
        if not descriptor.enabled:
            return _error(
                "skill_disabled",
                f"Skill '{skill}' is disabled.",
                skill=skill,
                version=descriptor.version,
                operation=operation,
            )
        tool = descriptor.resolve_operation(operation)
        if tool is None:
            return _error(
                "operation_not_found",
                f"Operation '{operation}' was not found for skill '{skill}'.",
                skill=skill,
                version=descriptor.version,
                operation=operation,
            )
        if not _is_allowed(descriptor, ctx.context):
            return _error(
                "source_not_allowed",
                f"Skill '{skill}' is outside the task database allowlist.",
                skill=skill,
                version=descriptor.version,
                operation=operation,
            )
        try:
            validator_class = validator_for(tool.params_json_schema)
            validator_class.check_schema(tool.params_json_schema)
            validator_class(tool.params_json_schema).validate(arguments)
        except JsonSchemaValidationError as exc:
            return _error(
                "invalid_arguments",
                exc.message,
                skill=skill,
                version=descriptor.version,
                operation=operation,
            )

        handle = catalog.resolve(skill, operation)
        if handle is None:
            return _error(
                "operation_not_found",
                f"Operation '{operation}' is no longer available.",
                skill=skill,
                version=descriptor.version,
                operation=operation,
            )
        result = await handle.invoke(ctx, arguments)
        return json.dumps(
            {
                "status": "ok",
                "skill": handle.skill,
                "version": handle.version,
                "operation": handle.operation,
                "result": result,
            },
            ensure_ascii=False,
        )

    return _find_skill, _invoke_skill


skill_catalog = SkillCatalog()
find_skill, invoke_skill = build_skill_gateway(skill_catalog)
