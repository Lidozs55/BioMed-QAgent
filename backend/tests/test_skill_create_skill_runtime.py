from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import AsyncIterator, Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.config import Settings
from app.domain.contracts import ApiRequestStep, WorkflowRecipe
from app.main import create_app
from app.recipes.executor import RecipeExecutor, RecipeStepResponse
from app.recipes.store import WorkflowRecipeStore
from app.skills.builtin.processing.create_skill import (
    CreateSkillRuntime,
    create_skill_tool,
)
from app.subagents.staging import SubagentStagingWorkspace
from app.tools.network_safety import PublicHttpTarget

NOW = datetime(2026, 7, 29, tzinfo=UTC)


class UnusedRecipeClient:
    async def api_request(self, **_kwargs: object) -> RecipeStepResponse:
        raise AssertionError("network client must not be used")

    async def html_extract(self, **_kwargs: object) -> RecipeStepResponse:
        raise AssertionError("network client must not be used")

    @asynccontextmanager
    async def browser_authorization(
        self,
        *,
        authorize_request: Callable[..., object],
    ) -> AsyncIterator[None]:
        del authorize_request
        yield

    async def browser_action(self, **_kwargs: object) -> RecipeStepResponse:
        raise AssertionError("network client must not be used")


@pytest.mark.asyncio
async def test_lifespan_context_factory_develops_and_validates_recipe(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={"accession": "GSE100"},
            headers={"content-type": "application/json"},
        )

    def resolve_target(_url: str, *, require_https: bool) -> PublicHttpTarget:
        assert require_https
        return PublicHttpTarget(
            connect_url="https://93.184.216.34/GSE100",
            host_header="api.example.org",
            sni_hostname="api.example.org",
        )

    configured = Settings(
        output_dir=str(tmp_path / "output"),
        skill_data_dir=str(tmp_path / "skills"),
    )
    monkeypatch.setattr(
        "app.integrations.acquisition.resolve_public_http_target",
        resolve_target,
    )
    application = create_app(
        configured,
        recipe_http_transport_factory=lambda _sni: httpx.MockTransport(handler),
    )

    async with application.router.lifespan_context(application):
        factory = application.state.task_context_factory
        context = factory("task_production_recipe")
        runtime = context.create_skill_runtime
        recipe = _production_recipe()
        developed = await _invoke(
            _tool_context(context),
            {
                "operation": "develop_workflow",
                "recipe": recipe.model_dump(mode="json"),
            },
        )
        draft = runtime.store.get(
            developed["recipe"]["recipe_id"],
            developed["recipe"]["version"],
        )
        result = await _invoke(
            _tool_context(context),
            {
                "operation": "validate_recipe",
                "recipe_id": draft.recipe_id,
                "version": draft.version,
                "inputs": {"accession": "GSE100"},
            },
        )
        verified = runtime.store.get(draft.recipe_id)

        assert application.state.task_manager._context_factory is factory
        assert runtime.store is application.state.workflow_recipe_store
        assert runtime.executor is not None
        assert runtime.workspace.root.is_relative_to(context.work_dir.root)
        assert result["status"] == "ok", result
        assert verified.status.value == "verified"
        assert verified.attempts[-1].status == "succeeded"
        assert any(
            result["source_asset"]["asset_id"] in item for item in verified.verification_evidence
        )
        assert (
            runtime.workspace.task_root.joinpath(
                result["source_asset"]["relative_path"]
            ).read_bytes()
            == b'{"accession":"GSE100"}'
        )
        assert len(requests) == 1
        assert str(requests[0].url) == "https://93.184.216.34/GSE100"
        assert requests[0].headers["host"] == "api.example.org"
        assert requests[0].extensions["sni_hostname"] == "api.example.org"
        recipe_client = application.state.recipe_client

    assert recipe_client.is_closed


@pytest.mark.asyncio
async def test_failed_draft_save_releases_dedupe_reservation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context, store = _bound_context(tmp_path)
    original_save = store.save_draft
    calls = 0

    def fail_once(recipe: WorkflowRecipe) -> WorkflowRecipe:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError("injected save failure")
        return original_save(recipe)

    monkeypatch.setattr(store, "save_draft", fail_once)
    request = {
        "operation": "develop_workflow",
        "recipe": _draft_recipe().model_dump(mode="json"),
    }

    failed = await _invoke(_tool_context(context), request)
    retried = await _invoke(_tool_context(context), request)

    assert failed["status"] == "error"
    assert retried["status"] == "ok"
    assert store.get("recipe_geo").status.value == "draft"


def test_concurrent_develop_persists_exactly_one_draft(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context, store = _bound_context(tmp_path)
    original_save = store.save_draft
    entered = threading.Event()
    release = threading.Event()
    first_call = True
    call_guard = threading.Lock()

    def block_first(recipe: WorkflowRecipe) -> WorkflowRecipe:
        nonlocal first_call
        with call_guard:
            should_block = first_call
            first_call = False
        if should_block:
            entered.set()
            assert release.wait(timeout=2)
        return original_save(recipe)

    monkeypatch.setattr(store, "save_draft", block_first)
    first = _draft_recipe()
    second = first.model_copy(update={"recipe_id": "recipe_concurrent"})

    with ThreadPoolExecutor(max_workers=2) as executor:
        first_future = executor.submit(_develop_sync, context, first)
        assert entered.wait(timeout=2)
        second_future = executor.submit(_develop_sync, context, second)
        second_result = second_future.result(timeout=2)
        release.set()
        first_result = first_future.result(timeout=2)

    results = [first_result, second_result]
    assert sum(result["status"] == "ok" for result in results) == 1
    assert (
        sum(
            result["error"]["code"] == "create_skill_failed"
            for result in results
            if result["status"] == "error"
        )
        == 1
    )
    assert len([path for path in store.root.iterdir() if path.is_dir()]) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("field_name", ["shell_command", "javascript"])
async def test_nested_executable_recipe_field_is_rejected_without_store_write(
    tmp_path: Path,
    field_name: str,
) -> None:
    context, store = _bound_context(tmp_path)
    recipe = _draft_recipe().model_dump(mode="json")
    recipe["source_asset_mapping"][field_name] = "dangerous payload"

    result = await _invoke(
        _tool_context(context),
        {"operation": "develop_workflow", "recipe": recipe},
    )

    assert result["status"] == "error"
    assert result["error"]["code"] == "invalid_recipe_input"
    assert not any(store.root.iterdir())


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("location", "secret"),
    [
        ("authorization", "Bearer private-token"),
        ("client_secret", "client-secret-value"),
        ("token", "access-token-value"),
        ("bearer_text", "Bearer embedded-secret"),
        ("assignment", "api_key=assignment-secret"),
    ],
)
async def test_develop_rejects_secrets_before_reservation_or_store_write(
    tmp_path: Path,
    location: str,
    secret: str,
) -> None:
    context, store = _bound_context(tmp_path)
    recipe = _recipe_with_secret(location, secret)

    rejected = await _invoke(
        _tool_context(context),
        {"operation": "develop_workflow", "recipe": recipe},
    )
    clean_retry = await _invoke(
        _tool_context(context),
        {
            "operation": "develop_workflow",
            "recipe": _draft_recipe().model_dump(mode="json"),
        },
    )

    assert rejected["status"] == "error"
    assert rejected["error"]["code"] == "invalid_recipe_input"
    assert clean_retry["status"] == "ok"
    assert [path.name for path in store.root.iterdir() if path.is_dir()] == ["recipe_geo"]


def _bound_context(tmp_path: Path) -> tuple[RunContext, WorkflowRecipeStore]:
    context = RunContext(task_id="task_review", base_dir=tmp_path / "tasks")
    store = WorkflowRecipeStore(tmp_path / "recipes")
    context.bind_create_skill_runtime(
        CreateSkillRuntime(
            store=store,
            executor=RecipeExecutor(client=UnusedRecipeClient(), store=store),
            workspace=SubagentStagingWorkspace(context.work_dir.root, "sub_review"),
        )
    )
    return context, store


def _tool_context(context: RunContext) -> ToolContext[RunContext]:
    return ToolContext(
        context=context,
        tool_name="create_skill",
        tool_call_id="call_review",
        tool_arguments="{}",
    )


async def _invoke(
    context: ToolContext[RunContext],
    request: dict[str, object],
) -> dict[str, object]:
    raw = await create_skill_tool.on_invoke_tool(context, json.dumps(request))
    result = json.loads(raw)
    assert isinstance(result, dict)
    return result


def _develop_sync(context: RunContext, recipe: WorkflowRecipe) -> dict[str, object]:
    return asyncio.run(
        _invoke(
            _tool_context(context),
            {
                "operation": "develop_workflow",
                "recipe": recipe.model_dump(mode="json"),
            },
        )
    )


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


def _production_recipe() -> WorkflowRecipe:
    return _draft_recipe().model_copy(
        update={
            "steps": [
                ApiRequestStep(
                    url_template="https://api.example.org/{accession}",
                    request_headers={"Host": "attacker.example"},
                    output_name="result.json",
                )
            ],
        }
    )


def _recipe_with_secret(location: str, secret: str) -> dict[str, object]:
    recipe = _draft_recipe().model_dump(mode="json")
    if location == "authorization":
        recipe["steps"][0]["request_headers"] = {"Authorization": secret}
    elif location == "client_secret":
        recipe["source_asset_mapping"]["client_secret"] = secret
    elif location == "token":
        recipe["output_extraction"]["access_token"] = secret
    elif location == "bearer_text":
        recipe["security_requirements"] = [secret]
    else:
        recipe["verification_evidence"] = [secret]
    return recipe
