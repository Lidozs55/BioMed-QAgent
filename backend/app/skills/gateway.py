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
from app.skills.search import (
    LexicalSkillSearchStrategy,
    SkillSearchStrategy,
    normalize_skill_search_text,
)


def _matches_preferred_source(
    descriptor: SkillDescriptor,
    preferred_sources: set[str],
) -> bool:
    return bool(
        preferred_sources.intersection(
            normalize_skill_search_text(source) for source in descriptor.supported_sources
        )
    )


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


def build_skill_gateway(
    catalog: SkillCatalog,
    search_strategy: SkillSearchStrategy | None = None,
) -> tuple[FunctionTool, FunctionTool]:
    """Build stable SDK gateway tools bound to a catalog object."""
    resolved_search_strategy = (
        search_strategy if search_strategy is not None else LexicalSkillSearchStrategy()
    )

    @function_tool(name_override="find_skill")
    async def _find_skill(
        ctx: RunContextWrapper[RunContext],
        text: str = "",
        category: SkillCategory | None = None,
        source: str | None = None,
    ) -> str:
        """Find enabled skills by capability text, category, and data source.

        Pass a short natural-language capability description in ``text``. When
        the database is known, prefer ``source`` for an exact, case-insensitive
        source filter.
        """
        snapshot = catalog.snapshot()
        normalized_source = normalize_skill_search_text(source) if source is not None else None
        candidates: list[SkillDescriptor] = []
        for descriptor in snapshot.skills.values():
            if not descriptor.enabled:
                continue
            if category is not None and descriptor.category != category:
                continue
            if normalized_source is not None:
                normalized_supported_sources = {
                    normalize_skill_search_text(item) for item in descriptor.supported_sources
                }
                if normalized_source not in normalized_supported_sources:
                    continue
            candidates.append(descriptor)
        if not candidates:
            matches = ()
        else:
            search_async = getattr(resolved_search_strategy, "search_async", None)
            if search_async is not None:
                matches = await search_async(
                    candidates,
                    text,
                    ctx.context.model_settings,
                )
            else:
                matches = resolved_search_strategy.search(candidates, text)
        if normalized_source is None:
            preferred_sources = {
                normalize_skill_search_text(item) for item in ctx.context.preferred_sources
            }
            if preferred_sources:
                matches = tuple(
                    descriptor
                    for descriptor in matches
                    if _matches_preferred_source(descriptor, preferred_sources)
                ) + tuple(
                    descriptor
                    for descriptor in matches
                    if not _matches_preferred_source(
                        descriptor,
                        preferred_sources,
                    )
                )
        return json.dumps(
            {
                "status": "ok",
                "generation": snapshot.generation,
                "skills": [descriptor.manifest.model_dump(mode="json") for descriptor in matches],
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
        handle = snapshot.resolve(skill, operation)
        if handle is None:
            return _error(
                "operation_not_found",
                f"Operation '{operation}' was not found for skill '{skill}'.",
                skill=skill,
                version=descriptor.version,
                operation=operation,
            )
        if handle.access_requirement == "credential_required":
            if ctx.context.subagent_id is None:
                return _error(
                    "credential_required",
                    (
                        f"Operation '{operation}' requires HIL approval before "
                        "credentials can be used."
                    ),
                    skill=skill,
                    version=handle.version,
                    operation=operation,
                )
            try:
                resumed = await ctx.context.request_subagent_input(
                    summary=f"Approve credential use for {skill}.{operation}",
                    prompt_kind="api_key_or_credential",
                    detail={"skill": skill, "operation": operation},
                )
            except (LookupError, RuntimeError, ValueError) as error:
                return _error(
                    "credential_hil_unavailable",
                    str(error),
                    skill=skill,
                    version=handle.version,
                    operation=operation,
                )
            if resumed.decision != "approve":
                return _error(
                    "credential_required",
                    "Credential use was rejected by the user.",
                    skill=skill,
                    version=handle.version,
                    operation=operation,
                )
        try:
            validator_class = validator_for(handle.tool.params_json_schema)
            validator_class.check_schema(handle.tool.params_json_schema)
            validator_class(handle.tool.params_json_schema).validate(arguments)
        except JsonSchemaValidationError as exc:
            return _error(
                "invalid_arguments",
                exc.message,
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
