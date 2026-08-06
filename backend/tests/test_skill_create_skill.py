from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path

import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.domain.contracts import ApiRequestStep, RecipeStatus, WorkflowRecipe
from app.integrations.acquisition import ValidatedRecipeTarget
from app.recipes.executor import RecipeExecutor, RecipeStepResponse
from app.recipes.store import WorkflowRecipeStore
from app.skills.builtin import load_builtin_skill_descriptors
from app.skills.builtin.processing.create_skill import (
    CreateSkillRuntime,
    create_skill_tool,
)
from app.subagents.staging import SubagentStagingWorkspace
from app.tools.network_safety import PublicHttpTarget

NOW = datetime(2026, 7, 29, tzinfo=UTC)


class FakeRecipeClient:
    def __init__(self, responses: list[RecipeStepResponse]) -> None:
        self.responses = responses
        self.calls: list[str] = []

    async def api_request(self, **_kwargs: object) -> RecipeStepResponse:
        self.calls.append("api")
        return self.responses.pop(0)

    async def html_extract(self, **_kwargs: object) -> RecipeStepResponse:
        self.calls.append("html")
        return self.responses.pop(0)

    @asynccontextmanager
    async def browser_authorization(
        self,
        *,
        authorize_request: Callable[..., ValidatedRecipeTarget],
    ) -> AsyncIterator[None]:
        del authorize_request
        yield

    async def browser_action(self, **_kwargs: object) -> RecipeStepResponse:
        self.calls.append("browser")
        return self.responses.pop(0)


def test_create_skill_is_internal_with_one_typed_dispatcher() -> None:
    descriptors = load_builtin_skill_descriptors()
    descriptor = next(item for item in descriptors if item.name == "create_skill")

    assert descriptor.user_selectable is False
    assert descriptor.supported_sources == ()
    assert descriptor.operation_names == ("create_skill",)
    assert _operation_literals(descriptor.operations[0].tool.params_json_schema) & {
        "develop_workflow",
        "validate_recipe",
        "find_recipe",
        "request_promotion",
    } == {
        "develop_workflow",
        "validate_recipe",
        "find_recipe",
        "request_promotion",
    }


@pytest.mark.asyncio
async def test_create_skill_rejects_executable_recipe_fields(tmp_path: Path) -> None:
    context, _store, _client = _tool_context(tmp_path)
    request = {
        "operation": "develop_workflow",
        "recipe": {
            **_draft_recipe().model_dump(mode="json"),
            "code": "import os",
        },
    }

    result = await _invoke(context, request)

    assert result["status"] == "error"
    assert result["error"]["code"] == "invalid_recipe_input"


@pytest.mark.asyncio
async def test_validate_recipe_uses_trusted_draft_bootstrap_then_commits(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.recipes.executor.validate_recipe_source_url",
        lambda url, allowed_hosts: _target(url),
    )
    context, store, client = _tool_context(
        tmp_path,
        responses=[
            RecipeStepResponse(
                content=b'{"accession":"GSE100"}',
                status_code=200,
                media_type="application/json",
            )
        ],
    )
    developed = await _invoke(
        context,
        {
            "operation": "develop_workflow",
            "recipe": _draft_recipe().model_dump(mode="json"),
        },
    )
    draft = store.get(developed["recipe"]["recipe_id"], developed["recipe"]["version"])
    executor = context.context.create_skill_runtime.executor

    with pytest.raises(ValueError, match="only promoted"):
        await executor.execute(
            recipe_id=draft.recipe_id,
            version=draft.version,
            inputs={"accession": "GSE100"},
            workspace=context.context.create_skill_runtime.workspace,
        )

    before_artifacts = set(context.context.work_dir.artifacts.rglob("*"))
    result = await _invoke(
        context,
        {
            "operation": "validate_recipe",
            "recipe_id": draft.recipe_id,
            "version": draft.version,
            "inputs": {"accession": "GSE100"},
        },
    )

    verified = store.get(draft.recipe_id)
    assert result["status"] == "ok"
    assert verified.status.value == "verified"
    assert verified.attempts
    assert verified.attempts[-1].status == "succeeded"
    assert any(
        result["source_asset"]["asset_id"] in item for item in verified.verification_evidence
    )
    assert context.context.create_skill_runtime.workspace.task_root.joinpath(
        result["source_asset"]["relative_path"]
    ).is_file()
    assert set(context.context.work_dir.artifacts.rglob("*")) == before_artifacts
    assert client.calls == ["api"]


@pytest.mark.asyncio
async def test_find_recipe_returns_only_exact_verified_metadata(tmp_path: Path) -> None:
    context, store, _client = _tool_context(tmp_path)
    matching = store.save_draft(_draft_recipe())
    verified = store.mark_verified(matching.recipe_id)
    other_host = store.save_draft(
        _draft_recipe().model_copy(
            update={
                "recipe_id": "recipe_other_host",
                "allowed_hosts": ["other.example.org"],
            }
        )
    )
    store.mark_verified(other_host.recipe_id)
    store.save_draft(_draft_recipe().model_copy(update={"recipe_id": "recipe_draft"}))
    promoted = store.save_draft(_draft_recipe().model_copy(update={"recipe_id": "recipe_promoted"}))
    store.mark_verified(promoted.recipe_id)
    store.request_promotion(promoted.recipe_id)
    store.approve_promotion(promoted.recipe_id)

    result = await _invoke(
        context,
        {
            "operation": "find_recipe",
            "domain": verified.domain,
            "capability": verified.capability,
            "host": "api.example.org",
        },
    )

    assert [item["recipe_id"] for item in result["recipes"]] == [verified.recipe_id]
    assert all(item["status"] == "verified" for item in result["recipes"])
    assert "steps" not in result["recipes"][0]
    assert "input_schema" not in result["recipes"][0]


@pytest.mark.asyncio
async def test_request_promotion_only_records_pending_request(tmp_path: Path) -> None:
    context, store, _client = _tool_context(tmp_path)
    draft = store.save_draft(_draft_recipe())
    store.mark_verified(draft.recipe_id)

    result = await _invoke(
        context,
        {"operation": "request_promotion", "recipe_id": draft.recipe_id},
    )

    current = store.get(draft.recipe_id)
    assert result["status"] == "ok"
    assert current.status is RecipeStatus.VERIFIED
    assert current.promotion_requested_at is not None
    assert current.promoted_at is None
    assert list(tmp_path.rglob("*.py")) == []


@pytest.mark.asyncio
async def test_develop_workflow_deduplicates_domain_capability_per_run(
    tmp_path: Path,
) -> None:
    context, _store, _client = _tool_context(tmp_path)
    first = _draft_recipe().model_copy(
        update={"domain": "Gene Expression", "capability": "Download Matrix"}
    )
    duplicate = _draft_recipe().model_copy(
        update={
            "recipe_id": "recipe_duplicate",
            "domain": " gene expression ",
            "capability": " download matrix ",
        }
    )

    assert (
        await _invoke(
            context,
            {
                "operation": "develop_workflow",
                "recipe": first.model_dump(mode="json"),
            },
        )
    )["status"] == "ok"
    result = await _invoke(
        context,
        {
            "operation": "develop_workflow",
            "recipe": duplicate.model_dump(mode="json"),
        },
    )

    assert result["status"] == "error"
    assert result["error"]["code"] == "create_skill_failed"
    assert "already developed" in result["error"]["message"]


@pytest.mark.asyncio
async def test_validation_client_failure_leaves_recipe_draft(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.recipes.executor.validate_recipe_source_url",
        lambda url, allowed_hosts: _target(url),
    )
    context, store, _client = _tool_context(
        tmp_path,
        responses=[
            RecipeStepResponse(
                content=b"",
                status_code=500,
                media_type="application/json",
            )
        ],
    )
    draft = store.save_draft(_draft_recipe())
    before_artifacts = set(context.context.work_dir.artifacts.rglob("*"))

    result = await _invoke(
        context,
        {
            "operation": "validate_recipe",
            "recipe_id": draft.recipe_id,
            "version": draft.version,
            "inputs": {"accession": "GSE100"},
        },
    )

    assert result["status"] == "error"
    assert store.get(draft.recipe_id).status is RecipeStatus.DRAFT
    assert set(context.context.work_dir.artifacts.rglob("*")) == before_artifacts


@pytest.mark.asyncio
async def test_validation_commit_failure_leaves_recipe_draft(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.recipes.executor.validate_recipe_source_url",
        lambda url, allowed_hosts: _target(url),
    )
    context, store, _client = _tool_context(
        tmp_path,
        responses=[
            RecipeStepResponse(
                content=b"ok",
                status_code=200,
                media_type="text/plain",
            )
        ],
    )
    draft = store.save_draft(_draft_recipe())
    monkeypatch.setattr(
        SubagentStagingWorkspace,
        "commit_source_asset",
        lambda self, asset: (_ for _ in ()).throw(ValueError("commit failed")),
    )

    result = await _invoke(
        context,
        {
            "operation": "validate_recipe",
            "recipe_id": draft.recipe_id,
            "version": draft.version,
            "inputs": {"accession": "GSE100"},
        },
    )

    assert result["status"] == "error"
    assert store.get(draft.recipe_id).status is RecipeStatus.DRAFT
    assert not any(context.context.work_dir.artifacts.rglob("*"))


@pytest.mark.asyncio
async def test_validation_mark_verified_failure_does_not_publish_artifacts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.recipes.executor.validate_recipe_source_url",
        lambda url, allowed_hosts: _target(url),
    )
    context, store, _client = _tool_context(
        tmp_path,
        responses=[
            RecipeStepResponse(
                content=b"ok",
                status_code=200,
                media_type="text/plain",
            )
        ],
    )
    draft = store.save_draft(_draft_recipe())
    monkeypatch.setattr(
        store,
        "mark_verified",
        lambda *args, **kwargs: (_ for _ in ()).throw(ValueError("store failed")),
    )

    result = await _invoke(
        context,
        {
            "operation": "validate_recipe",
            "recipe_id": draft.recipe_id,
            "version": draft.version,
            "inputs": {"accession": "GSE100"},
        },
    )

    assert result["status"] == "error"
    assert store.get(draft.recipe_id).status is RecipeStatus.DRAFT
    assert not any(context.context.work_dir.artifacts.rglob("*"))


@pytest.mark.asyncio
async def test_validation_rejects_stale_draft_version(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.recipes.executor.validate_recipe_source_url",
        lambda url, allowed_hosts: _target(url),
    )
    context, store, _client = _tool_context(
        tmp_path,
        responses=[
            RecipeStepResponse(
                content=b"ok",
                status_code=200,
                media_type="text/plain",
            )
        ],
    )
    stale = store.save_draft(_draft_recipe())
    latest = store.save_draft(_draft_recipe())

    result = await _invoke(
        context,
        {
            "operation": "validate_recipe",
            "recipe_id": stale.recipe_id,
            "version": stale.version,
            "inputs": {"accession": "GSE100"},
        },
    )

    assert result["status"] == "error"
    assert "version changed" in result["error"]["message"]
    assert store.get(stale.recipe_id).version == latest.version
    assert store.get(stale.recipe_id).status is RecipeStatus.DRAFT
    assert not any(context.context.work_dir.artifacts.rglob("*"))


@pytest.mark.asyncio
async def test_unbound_runtime_and_invalid_operation_return_structured_errors(
    tmp_path: Path,
) -> None:
    run_context = RunContext(task_id="task_unbound", base_dir=tmp_path)
    context = ToolContext(
        context=run_context,
        tool_name="create_skill",
        tool_call_id="call_unbound",
        tool_arguments="{}",
    )

    invalid = await _invoke(context, {"operation": "execute_python"})
    unbound = await _invoke(
        context,
        {
            "operation": "find_recipe",
            "domain": "gene-expression",
            "capability": "download-series-matrix",
        },
    )

    assert invalid["status"] == "error"
    assert invalid["error"]["code"] == "invalid_recipe_input"
    assert unbound["status"] == "error"
    assert unbound["error"]["code"] == "create_skill_failed"


def _tool_context(
    tmp_path: Path,
    *,
    responses: list[RecipeStepResponse] | None = None,
) -> tuple[ToolContext[RunContext], WorkflowRecipeStore, FakeRecipeClient]:
    run_context = RunContext(task_id="task_create_skill", base_dir=tmp_path)
    store = WorkflowRecipeStore(tmp_path / "recipes")
    client = FakeRecipeClient(responses or [])
    runtime = CreateSkillRuntime(
        store=store,
        executor=RecipeExecutor(client=client, store=store),
        workspace=SubagentStagingWorkspace(run_context.work_dir.root, "sub_1"),
    )
    run_context.bind_create_skill_runtime(runtime)
    return (
        ToolContext(
            context=run_context,
            tool_name="create_skill",
            tool_call_id="call_create_skill",
            tool_arguments="{}",
        ),
        store,
        client,
    )


async def _invoke(
    context: ToolContext[RunContext],
    request: dict[str, object],
) -> dict[str, object]:
    raw = await create_skill_tool.on_invoke_tool(context, json.dumps(request))
    result = json.loads(raw)
    assert isinstance(result, dict)
    return result


def _draft_recipe() -> WorkflowRecipe:
    return WorkflowRecipe(
        recipe_id="recipe_geo",
        created_at=NOW,
        generated_by_model="qwen-plus",
        domain="gene-expression",
        capability="download-series-matrix",
        allowed_hosts=["api.example.org"],
        input_schema={
            "type": "object",
            "properties": {"accession": {"type": "string"}},
            "required": ["accession"],
            "additionalProperties": False,
        },
        steps=[
            ApiRequestStep(
                url_template="https://api.example.org/{accession}",
                output_name="result.json",
            )
        ],
        source_asset_mapping={
            "source_id": "src_recipe",
            "data_level": "metadata",
            "filename": "result.json",
        },
    )


def _target(url: str) -> ValidatedRecipeTarget:
    return ValidatedRecipeTarget(
        url=url,
        host="api.example.org",
        public_target=PublicHttpTarget(
            connect_url=url.replace("api.example.org", "93.184.216.34"),
            host_header="api.example.org",
            sni_hostname="api.example.org",
        ),
    )


def _operation_literals(schema: object) -> set[str]:
    if isinstance(schema, dict):
        values = {
            value for key, value in schema.items() if key == "const" and isinstance(value, str)
        }
        for value in schema.values():
            values.update(_operation_literals(value))
        return values
    if isinstance(schema, list):
        values: set[str] = set()
        for value in schema:
            values.update(_operation_literals(value))
        return values
    return set()
