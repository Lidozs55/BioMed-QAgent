"""Focused tests for stable skill discovery and invocation tools."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence
from typing import Any

import httpx
import pytest
from agents import RunContextWrapper, function_tool
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills import gateway as gateway_module
from app.skills.catalog import SkillCatalog, SkillDescriptor
from app.skills.gateway import build_skill_gateway
from app.skills.llm_search import LLMRerankingSkillSearchStrategy
from app.skills.packages import SkillPackageLoader
from app.skills.registry import SkillCategory, SkillDef
from app.skills.search import SkillSearchStrategy
from app.subagents.input_broker import SubagentInputBroker
from jsonschema.validators import validator_for as jsonschema_validator_for


@function_tool
async def fetch_record(
    ctx: RunContextWrapper[RunContext],
    accession: str,
    limit: int = 1,
) -> dict[str, Any]:
    """Fetch a test record."""
    return {
        "task_id": ctx.context.task_id,
        "accession": accession,
        "limit": limit,
    }


def _skill(
    *,
    name: str = "geo_fetch",
    enabled: bool = True,
    version: str = "2.1.0",
    supported_sources: list[str] | None = None,
) -> SkillDescriptor:
    return SkillDescriptor.from_skill_def(
        SkillDef(
            name=name,
            category=SkillCategory.ACQUISITION,
            description="Download GEO expression records.",
            supported_sources=(["geo"] if supported_sources is None else supported_sources),
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


class RecordingSearchStrategy:
    def __init__(self) -> None:
        self.candidate_names: tuple[str, ...] = ()

    def search(
        self,
        candidates: Sequence[SkillDescriptor],
        text: str,
    ) -> tuple[SkillDescriptor, ...]:
        self.candidate_names = tuple(item.name for item in candidates)
        return tuple(candidates)


class RecordingSubagentSink:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    async def emit(self, **kwargs: Any) -> None:
        self.events.append(kwargs)


def _protected_manifest() -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "name": "protected_db",
        "display_name": "Protected DB",
        "version": "1.0.0",
        "category": "acquisition",
        "description": "Fetch protected and public records.",
        "supported_sources": ["protected_db"],
        "operations": [
            {
                "name": "fetch_protected",
                "description": "Fetch a protected record.",
                "method": "GET",
                "url": "https://api.example.test/protected",
                "auth": {
                    "source": "env",
                    "reference": "DEMO_TOKEN",
                    "location": "header",
                    "name": "Authorization",
                    "prefix": "Bearer ",
                },
            },
            {
                "name": "fetch_public",
                "description": "Fetch a public record.",
                "method": "GET",
                "url": "https://api.example.test/public",
            },
        ],
    }


@pytest.mark.asyncio
async def test_find_skill_filters_text_category_and_source() -> None:
    catalog = SkillCatalog([_skill()])
    find_skill, _ = build_skill_gateway(catalog)

    found = await _call(
        find_skill,
        _context(sources=["geo"]),
        text="download expression records",
        category="acquisition",
        source="geo",
    )
    public_alternative = await _call(
        find_skill,
        _context(sources=["pubmed"]),
        source="geo",
    )

    assert find_skill.name == "find_skill"
    assert found["status"] == "ok"
    assert [item["name"] for item in found["skills"]] == ["geo_fetch"]
    assert [item["name"] for item in public_alternative["skills"]] == ["geo_fetch"]


@pytest.mark.asyncio
async def test_find_skill_source_filter_is_case_insensitive() -> None:
    find_skill, _ = build_skill_gateway(SkillCatalog([_skill()]))

    result = await _call(
        find_skill,
        _context(sources=["geo"]),
        source="GEO",
    )

    assert [item["name"] for item in result["skills"]] == ["geo_fetch"]


@pytest.mark.asyncio
async def test_explicit_source_filter_excludes_preferred_alternatives() -> None:
    find_skill, _ = build_skill_gateway(
        SkillCatalog(
            [
                _skill(),
                _skill(name="pdb_fetch", supported_sources=["pdb"]),
            ]
        )
    )

    result = await _call(
        find_skill,
        _context(sources=["geo"]),
        source="pdb",
    )

    assert [item["name"] for item in result["skills"]] == ["pdb_fetch"]


@pytest.mark.asyncio
async def test_find_skill_prefers_selected_sources_after_strategy_ranking() -> None:
    alternative_first = SkillDescriptor.from_skill_def(
        SkillDef(
            name="pubmed",
            category=SkillCategory.DISCOVERY,
            description="Search literature.",
            supported_sources=["pubmed"],
            tools=[fetch_record],
        ),
        user_selectable=True,
    )
    preferred_second = _skill()
    alternative_third = _skill(
        name="pdb_fetch",
        supported_sources=["pdb"],
    )
    strategy = RecordingSearchStrategy()
    search_strategy: SkillSearchStrategy = strategy
    find_skill, _ = build_skill_gateway(
        SkillCatalog([alternative_first, preferred_second, alternative_third]),
        search_strategy=search_strategy,
    )

    result = await _call(
        find_skill,
        _context(sources=["GEO"]),
        text="anything",
    )

    assert strategy.candidate_names == ("pubmed", "geo_fetch", "pdb_fetch")
    assert [item["name"] for item in result["skills"]] == [
        "geo_fetch",
        "pubmed",
        "pdb_fetch",
    ]
    assert set(result) == {"status", "generation", "skills"}


@pytest.mark.asyncio
async def test_public_unselected_source_is_discoverable_and_invocable() -> None:
    pubmed = SkillDescriptor.from_skill_def(
        SkillDef(
            name="pubmed",
            category=SkillCategory.DISCOVERY,
            description="Search PubMed literature.",
            supported_sources=["pubmed"],
            tools=[fetch_record],
        ),
        user_selectable=True,
    )
    find_skill, invoke_skill = build_skill_gateway(SkillCatalog([pubmed]))
    context = _context(sources=["geo"])

    found = await _call(find_skill, context, source="pubmed")
    invoked = await _call(
        invoke_skill,
        context,
        skill="pubmed",
        operation="fetch_record",
        arguments={"accession": "PMID1", "limit": 1},
    )

    assert [item["name"] for item in found["skills"]] == ["pubmed"]
    assert invoked["status"] == "ok", json.dumps(invoked)
    assert invoked["result"]["accession"] == "PMID1"


@pytest.mark.asyncio
async def test_protected_package_operation_requires_hil_before_tool_invocation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"ok": True})

    monkeypatch.setattr(
        "app.skills.packages.validate_public_http_url",
        lambda url: url,
    )
    descriptor = SkillPackageLoader(
        secrets={"DEMO_TOKEN": "top-secret"},
        http_transport=httpx.MockTransport(handler),
    ).load_manifest(_protected_manifest())
    find_skill, invoke_skill = build_skill_gateway(SkillCatalog([descriptor]))
    context = _context(sources=["geo"])

    found = await _call(find_skill, context)
    protected = await _call(
        invoke_skill,
        context,
        skill="protected_db",
        operation="fetch_protected",
        arguments={},
    )

    assert [item["name"] for item in found["skills"]] == ["protected_db"]
    assert protected["status"] == "error"
    assert protected["error"]["code"] == "credential_required"
    assert "HIL" in protected["error"]["message"]
    assert requests == []

    public = await _call(
        invoke_skill,
        context,
        skill="protected_db",
        operation="fetch_public",
        arguments={},
    )

    assert public["status"] == "ok"
    assert len(requests) == 1
    assert requests[0].url.path == "/public"
    assert "Authorization" not in requests[0].headers
    assert "top-secret" not in repr(requests[0])


@pytest.mark.asyncio
async def test_child_protected_operation_waits_for_exact_hil_request_and_resumes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"ok": True})

    monkeypatch.setattr(
        "app.skills.packages.validate_public_http_url",
        lambda url: url,
    )
    descriptor = SkillPackageLoader(
        secrets={"DEMO_TOKEN": "top-secret"},
        http_transport=httpx.MockTransport(handler),
    ).load_manifest(_protected_manifest())
    _, invoke_skill = build_skill_gateway(SkillCatalog([descriptor]))
    context = RunContext(
        task_id="task_child",
        managed_run_id="run_child",
        subagent_id="sub_child",
    )
    broker = SubagentInputBroker()
    sink = RecordingSubagentSink()
    context.bind_subagent_runtime(
        supervisor=object(),
        runner=object(),
        event_sink=sink,
        input_broker=broker,
    )
    tool_context = ToolContext(
        context=context,
        tool_name="invoke_skill",
        tool_call_id="call_child",
        tool_arguments="{}",
    )

    pending = asyncio.create_task(
        _call(
            invoke_skill,
            tool_context,
            skill="protected_db",
            operation="fetch_protected",
            arguments={},
        )
    )
    for _ in range(20):
        await asyncio.sleep(0)
        if sink.events:
            break

    assert len(sink.events) == 1
    required = sink.events[0]["payload"]
    assert required.type == "subagent_input_required"
    assert required.subagent_id == "sub_child"
    assert "top-secret" not in repr(required)
    assert not pending.done()

    await broker.resume(
        task_id="task_child",
        run_id="run_child",
        request_id=required.request_id,
        decision="approve",
        detail={"confirmed": True},
    )
    result = await pending

    assert result["status"] == "ok"
    assert len(requests) == 1
    assert len(sink.events) == 2
    assert sink.events[1]["payload"].type == "subagent_input_resumed"


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
async def test_source_less_public_skill_is_allowed_with_preferred_sources() -> None:
    catalog = SkillCatalog([_skill(supported_sources=[])])
    find_skill, invoke_skill = build_skill_gateway(catalog)
    context = _context(sources=["geo"])

    found = await _call(find_skill, context)
    invoked = await _call(
        invoke_skill,
        context,
        skill="geo_fetch",
        operation="fetch_record",
        arguments={"accession": "GSE1", "limit": 1},
    )

    assert [item["name"] for item in found["skills"]] == ["geo_fetch"]
    assert invoked["status"] == "ok", json.dumps(invoked)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("catalog", "skill", "operation", "sources", "error_code"),
    [
        (SkillCatalog(), "missing", "fetch_record", ["geo"], "skill_not_found"),
        (
            SkillCatalog([_skill(enabled=False)]),
            "geo_fetch",
            "fetch_record",
            ["geo"],
            "skill_disabled",
        ),
        (SkillCatalog([_skill()]), "geo_fetch", "missing", ["geo"], "operation_not_found"),
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


class _AsyncRecordingStrategy(LLMRerankingSkillSearchStrategy):
    def __init__(self) -> None:
        super().__init__()
        self.async_called = False

    async def search_async(self, candidates, text, model_settings):  # type: ignore[override]
        self.async_called = True
        self.model_settings_arg = model_settings
        return tuple(candidates)


@pytest.mark.asyncio
async def test_find_skill_dispatches_to_search_async_when_available() -> None:
    strategy = _AsyncRecordingStrategy()
    find_skill, _ = build_skill_gateway(SkillCatalog([_skill()]), search_strategy=strategy)
    ctx = _context()
    result = await _call(find_skill, ctx, text="geo")

    assert strategy.async_called is True
    assert strategy.model_settings_arg is ctx.context.model_settings
    assert '"geo_fetch"' in json.dumps(result, ensure_ascii=False)


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["", "   "])
async def test_find_skill_treats_blank_source_as_unspecified(
    source: str,
) -> None:
    """LLM callers serialize an unset optional param as ''; that must behave
    like ``source=None`` instead of filtering every candidate out."""
    find_skill, _ = build_skill_gateway(SkillCatalog([_skill()]))
    ctx = _context()
    result = await _call(find_skill, ctx, text="", source=source)

    assert '"geo_fetch"' in json.dumps(result, ensure_ascii=False)


@pytest.mark.asyncio
async def test_find_skill_source_alias_browser_matches_browser_skill() -> None:
    """source='browser' resolves browser_fallback via its supported_sources."""
    browser = SkillDescriptor.from_skill_def(
        SkillDef(
            name="browser_fallback",
            category=SkillCategory.ACQUISITION,
            description="Browser fallback acquisition.",
            supported_sources=["browser", "browser_fallback", "http", "web"],
            tools=[fetch_record],
        ),
    )
    find_skill, _ = build_skill_gateway(SkillCatalog([_skill(), browser]))
    ctx = _context()
    result = await _call(find_skill, ctx, text="", source="browser")
    names = [s["name"] for s in result["skills"]]

    assert names == ["browser_fallback"]


@pytest.mark.asyncio
async def test_invoke_skill_accepts_omitted_defaulted_parameter() -> None:
    """The SDK marks defaulted params as required in strict schemas; the
    gateway must treat them as optional so callers may omit them (e.g. the
    agent calls search_pubchem without max_results)."""
    _, invoke_skill = build_skill_gateway(SkillCatalog([_skill()]))
    ctx = _context()
    result = await _call(invoke_skill, ctx, skill="geo_fetch", operation="fetch_record", arguments={"accession": "GSE1"})

    assert result["status"] == "ok"
    assert result["result"]["limit"] == 1


@pytest.mark.asyncio
async def test_find_skill_locates_pubmed_by_source_without_category() -> None:
    """Regression: PubMed skill is discoverable via source-only find_skill.

    The 2026-08-04 run log showed the Agent passing category="acquisition"
    alongside source="pubmed", which filtered out the pubmed skill (it is a
    discovery-class skill) and made the Agent wrongly conclude PubMed was
    unavailable. This test pins the source-only discovery path so the catalog
    and gateway never silently drop the pubmed skill again.
    """
    from app.skills.builtin import load_builtin_skill_descriptors

    catalog = SkillCatalog(load_builtin_skill_descriptors())
    find_skill, _ = build_skill_gateway(catalog)

    found = await _call(
        find_skill,
        _context(sources=["pubmed"]),
        text="PubMed literature",
        source="pubmed",
    )

    assert found["status"] == "ok"
    names = [item["name"] for item in found["skills"]]
    assert "pubmed" in names


@pytest.mark.asyncio
async def test_find_skill_source_pubmed_with_acquisition_category_returns_empty() -> None:
    """Regression baseline: source="pubmed" + category="acquisition" yields none.

    PubMed is a discovery-class skill, so combining source="pubmed" with
    category="acquisition" (as the Agent did in the 2026-08-04 run) filters it
    out via the gateway's category hard-filter. This test documents that
    behaviour so future changes to the filter logic are intentional.
    """
    from app.skills.builtin import load_builtin_skill_descriptors

    catalog = SkillCatalog(load_builtin_skill_descriptors())
    find_skill, _ = build_skill_gateway(catalog)

    found = await _call(
        find_skill,
        _context(sources=["pubmed"]),
        text="PubMed literature",
        category="acquisition",
        source="pubmed",
    )

    assert found["status"] == "ok"
    assert found["skills"] == []
