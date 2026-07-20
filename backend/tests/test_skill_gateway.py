"""Focused tests for stable skill discovery and invocation tools."""

from __future__ import annotations

import json
from typing import Any

import pytest
from agents import RunContextWrapper, function_tool
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills import gateway as gateway_module
from app.skills.catalog import SkillCatalog, SkillDescriptor
from app.skills.gateway import build_skill_gateway
from app.skills.registry import SkillCategory, SkillDef
from jsonschema.validators import validator_for as jsonschema_validator_for


@function_tool
async def fetch_record(
    ctx: RunContextWrapper[RunContext], accession: str, limit: int = 1,
) -> dict[str, Any]:
    """Fetch a test record."""
    return {
        "task_id": ctx.context.task_id,
        "accession": accession,
        "limit": limit,
    }


def _skill(
    *,
    enabled: bool = True,
    version: str = "2.1.0",
    supported_sources: list[str] | None = None,
) -> SkillDescriptor:
    return SkillDescriptor.from_skill_def(
        SkillDef(
            name="geo_fetch",
            category=SkillCategory.ACQUISITION,
            description="Download GEO expression records.",
            supported_sources=(
                ["geo"] if supported_sources is None else supported_sources
            ),
            version=version,
            enabled=enabled,
            tools=[fetch_record],
        ),
    )


def _context(*, sources: list[str] | None = None) -> ToolContext[RunContext]:
    run_context = RunContext(task_id="gateway", preferred_sources=sources or [])
    return ToolContext(
        context=run_context,
        tool_name="gateway",
        tool_call_id="call-1",
        tool_arguments="{}",
    )


async def _call(tool: Any, ctx: ToolContext[RunContext], **kwargs: Any) -> dict[str, Any]:
    value = await tool.on_invoke_tool(ctx, json.dumps(kwargs))
    assert isinstance(value, str)
    return json.loads(value)


@pytest.mark.asyncio
async def test_find_skill_filters_text_category_source_and_allowlist() -> None:
    catalog = SkillCatalog([_skill()])
    find_skill, _ = build_skill_gateway(catalog)

    found = await _call(
        find_skill,
        _context(sources=["geo"]),
        text="expression",
        category="acquisition",
        source="geo",
    )
    blocked = await _call(
        find_skill,
        _context(sources=["pubmed"]),
        source="geo",
    )

    assert find_skill.name == "find_skill"
    assert found["status"] == "ok"
    assert [item["name"] for item in found["skills"]] == ["geo_fetch"]
    assert blocked["skills"] == []


@pytest.mark.asyncio
async def test_invoke_skill_success_uses_existing_run_context() -> None:
    _, invoke_skill = build_skill_gateway(SkillCatalog([_skill()]))

    result = await _call(
        invoke_skill,
        _context(sources=["geo"]),
        skill="geo_fetch",
        operation="fetch_record",
        arguments={"accession": "GSE1", "limit": 3},
    )

    assert invoke_skill.name == "invoke_skill"
    assert result == {
        "status": "ok",
        "skill": "geo_fetch",
        "version": "2.1.0",
        "operation": "fetch_record",
        "result": {"task_id": "gateway", "accession": "GSE1", "limit": 3},
    }


@pytest.mark.asyncio
async def test_invoke_skill_uses_handle_pinned_to_one_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog = SkillCatalog([_skill(version="1.0.0")])
    _, invoke_skill = build_skill_gateway(catalog)

    def replace_and_delete_during_validation(schema: dict[str, Any]) -> Any:
        catalog.replace_all([_skill(version="2.0.0")])
        catalog.remove("geo_fetch")
        return jsonschema_validator_for(schema)

    monkeypatch.setattr(
        gateway_module,
        "validator_for",
        replace_and_delete_during_validation,
    )

    result = await _call(
        invoke_skill,
        _context(sources=["geo"]),
        skill="geo_fetch",
        operation="fetch_record",
        arguments={"accession": "GSE1", "limit": 1},
    )

    assert result["status"] == "ok", json.dumps(result, indent=2)
    assert result["version"] == "1.0.0"
    assert result["result"]["accession"] == "GSE1"
    assert catalog.snapshot().skills == {}


@pytest.mark.asyncio
async def test_source_less_acquisition_skill_is_denied_by_non_empty_allowlist() -> None:
    catalog = SkillCatalog([_skill(supported_sources=[])])
    find_skill, invoke_skill = build_skill_gateway(catalog)
    context = _context(sources=["geo"])

    found = await _call(find_skill, context)
    invoked = await _call(
        invoke_skill,
        context,
        skill="geo_fetch",
        operation="fetch_record",
        arguments={"accession": "GSE1"},
    )

    assert found["skills"] == []
    assert invoked["status"] == "error"
    assert invoked["error"]["code"] == "source_not_allowed"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("catalog", "skill", "operation", "sources", "error_code"),
    [
        (SkillCatalog(), "missing", "fetch_record", ["geo"], "skill_not_found"),
        (SkillCatalog([_skill(enabled=False)]), "geo_fetch", "fetch_record", ["geo"], "skill_disabled"),
        (SkillCatalog([_skill()]), "geo_fetch", "missing", ["geo"], "operation_not_found"),
        (SkillCatalog([_skill()]), "geo_fetch", "fetch_record", ["pubmed"], "source_not_allowed"),
    ],
)
async def test_invoke_skill_returns_structured_resolution_errors(
    catalog: SkillCatalog,
    skill: str,
    operation: str,
    sources: list[str],
    error_code: str,
) -> None:
    _, invoke_skill = build_skill_gateway(catalog)

    result = await _call(
        invoke_skill,
        _context(sources=sources),
        skill=skill,
        operation=operation,
        arguments={},
    )

    assert result["status"] == "error"
    assert result["error"]["code"] == error_code


@pytest.mark.asyncio
async def test_invoke_skill_returns_argument_validation_error() -> None:
    _, invoke_skill = build_skill_gateway(SkillCatalog([_skill()]))

    result = await _call(
        invoke_skill,
        _context(sources=["geo"]),
        skill="geo_fetch",
        operation="fetch_record",
        arguments={"accession": "GSE1", "limit": "not-an-integer"},
    )

    assert result["status"] == "error"
    assert result["error"]["code"] == "invalid_arguments"
