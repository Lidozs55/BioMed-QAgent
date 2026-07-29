from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from pathlib import Path

import pytest
from app.domain.contracts import (
    ApiRequestStep,
    BrowserActionStep,
    DataLevel,
    HtmlExtractStep,
    WorkflowRecipe,
)
from app.recipes.executor import RecipeExecutor, RecipeStepResponse
from app.recipes.store import WorkflowRecipeStore
from app.subagents.staging import SubagentStagingWorkspace


class FakeRecipeClient:
    def __init__(self, responses: list[RecipeStepResponse]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, dict[str, object]]] = []

    async def api_request(self, **kwargs: object) -> RecipeStepResponse:
        self.calls.append(("api", kwargs))
        return self.responses.pop(0)

    async def html_extract(self, **kwargs: object) -> RecipeStepResponse:
        self.calls.append(("html", kwargs))
        return self.responses.pop(0)

    async def browser_action(self, **kwargs: object) -> RecipeStepResponse:
        self.calls.append(("browser", kwargs))
        return self.responses.pop(0)


@pytest.mark.asyncio
async def test_verified_recipe_produces_staged_source_asset(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.recipes.executor.validate_recipe_source_url",
        lambda url, allowed_hosts: "api.example.org",
    )
    recipe = _stored_verified_recipe(tmp_path / "recipes")
    client = FakeRecipeClient(
        [
            RecipeStepResponse(
                content=b'{"accession":"GSE100"}',
                final_url="https://api.example.org/GSE100",
                status_code=200,
                media_type="application/json",
            )
        ]
    )
    workspace = SubagentStagingWorkspace(tmp_path / "task", "sub_1")

    result = await RecipeExecutor(client=client).execute(
        recipe,
        inputs={"accession": "GSE100"},
        workspace=workspace,
    )

    assert result.source_asset.source_id == "src_recipe"
    assert result.source_asset.data_level is DataLevel.METADATA
    assert result.download_attempt.attempt_id == (result.source_asset.successful_attempt_id)
    assert result.attempts[0].method == "api"
    assert result.attempts[0].status == "succeeded"
    assert workspace.staged_path(result.source_asset).read_bytes().startswith(b"{")
    assert client.calls[0][1]["url"] == "https://api.example.org/GSE100"


@pytest.mark.asyncio
async def test_executor_percent_encodes_declared_template_values(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.recipes.executor.validate_recipe_source_url",
        lambda url, allowed_hosts: "api.example.org",
    )
    recipe = _stored_verified_recipe(tmp_path / "recipes")
    client = FakeRecipeClient(
        [
            RecipeStepResponse(
                content=b"ok",
                final_url="https://api.example.org/a%2Fb%40evil.example",
                status_code=200,
                media_type="text/plain",
            )
        ]
    )

    await RecipeExecutor(client=client).execute(
        recipe,
        inputs={"accession": "a/b@evil.example"},
        workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
    )

    assert client.calls[0][1]["url"] == ("https://api.example.org/a%2Fb%40evil.example")


@pytest.mark.asyncio
async def test_executor_percent_encodes_browser_navigation_values(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.recipes.executor.validate_recipe_source_url",
        lambda url, allowed_hosts: "api.example.org",
    )
    draft = _draft_recipe().model_copy(
        update={
            "steps": [
                BrowserActionStep(
                    action="navigate",
                    value="https://api.example.org/{accession}",
                    output_name="page.html",
                )
            ]
        }
    )
    client = FakeRecipeClient(
        [
            RecipeStepResponse(
                content=b"<html></html>",
                final_url="https://api.example.org/a%2Fb",
                status_code=200,
                media_type="text/html",
            )
        ]
    )

    await RecipeExecutor(client=client).execute(
        _store_verified(tmp_path / "recipes", draft),
        inputs={"accession": "a/b"},
        workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
    )

    assert client.calls[0][1]["current_url"] == "https://api.example.org/a%2Fb"
    assert client.calls[0][1]["value"] == "https://api.example.org/a%2Fb"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "inputs, message",
    [
        ({}, "missing"),
        ({"accession": "GSE100", "host": "evil.example"}, "unexpected"),
    ],
)
async def test_executor_rejects_missing_or_extra_inputs_before_client_call(
    tmp_path: Path,
    inputs: dict[str, str],
    message: str,
) -> None:
    client = FakeRecipeClient([])

    with pytest.raises(ValueError, match=message):
        await RecipeExecutor(client=client).execute(
            _stored_verified_recipe(tmp_path / "recipes"),
            inputs=inputs,
            workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
        )

    assert client.calls == []


@pytest.mark.asyncio
async def test_executor_rejects_tampered_or_unverified_recipe(
    tmp_path: Path,
) -> None:
    verified = _stored_verified_recipe(tmp_path / "recipes")
    tampered = verified.model_copy(update={"capability": "different"})
    client = FakeRecipeClient([])
    workspace = SubagentStagingWorkspace(tmp_path / "task", "sub_1")

    with pytest.raises(ValueError, match="digest"):
        await RecipeExecutor(client=client).execute(
            tampered, inputs={"accession": "GSE100"}, workspace=workspace
        )
    with pytest.raises(ValueError, match="verified"):
        await RecipeExecutor(client=client).execute(
            _draft_recipe(), inputs={"accession": "GSE100"}, workspace=workspace
        )


@pytest.mark.asyncio
async def test_executor_records_failed_fallback_before_success(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.recipes.executor.validate_recipe_source_url",
        lambda url, allowed_hosts: "api.example.org",
    )
    draft = _draft_recipe().model_copy(
        update={
            "steps": [
                ApiRequestStep(url_template="https://api.example.org/{accession}"),
                HtmlExtractStep(
                    url_template="https://api.example.org/{accession}",
                    selectors={"download": "a.download"},
                ),
            ]
        }
    )
    recipe = _store_verified(tmp_path / "recipes", draft)
    client = FakeRecipeClient(
        [
            RecipeStepResponse(
                content=b"",
                final_url="https://api.example.org/GSE100",
                status_code=503,
                media_type="application/json",
                error="service unavailable",
            ),
            RecipeStepResponse(
                content=b"csv-data",
                final_url="https://api.example.org/GSE100",
                status_code=200,
                media_type="text/csv",
            ),
        ]
    )

    result = await RecipeExecutor(client=client).execute(
        recipe,
        inputs={"accession": "GSE100"},
        workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
    )

    assert [attempt.method for attempt in result.attempts] == ["api", "html"]
    assert [attempt.status for attempt in result.attempts] == [
        "failed",
        "succeeded",
    ]
    assert result.attempts[0].fallback_reason == "falling back to html"


@pytest.mark.asyncio
async def test_executor_enforces_step_and_total_timeouts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.recipes.executor.validate_recipe_source_url",
        lambda url, allowed_hosts: "api.example.org",
    )

    class SlowClient(FakeRecipeClient):
        async def api_request(self, **kwargs: object) -> RecipeStepResponse:
            await asyncio.sleep(0.05)
            raise AssertionError("request was not cancelled")

    draft = _draft_recipe().model_copy(
        update={
            "timeout_seconds": 0.02,
            "steps": [
                ApiRequestStep(
                    url_template="https://api.example.org/{accession}",
                    timeout_seconds=0.01,
                )
            ],
        }
    )

    with pytest.raises(TimeoutError, match="recipe execution timed out"):
        await RecipeExecutor(client=SlowClient([])).execute(
            _store_verified(tmp_path / "recipes", draft),
            inputs={"accession": "GSE100"},
            workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
        )


@pytest.mark.asyncio
async def test_executor_revalidates_redirect_chain_and_final_url(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    checked: list[str] = []

    def validate(url: str, allowed_hosts: list[str]) -> str:
        checked.append(url)
        if "evil.example" in url:
            raise ValueError("host is not allowed")
        return "api.example.org"

    monkeypatch.setattr("app.recipes.executor.validate_recipe_source_url", validate)
    client = FakeRecipeClient(
        [
            RecipeStepResponse(
                content=b"secret",
                final_url="https://evil.example/result",
                redirect_chain=("https://api.example.org/start",),
                status_code=200,
                media_type="text/plain",
            )
        ]
    )

    with pytest.raises(ValueError, match="not allowed"):
        await RecipeExecutor(client=client).execute(
            _stored_verified_recipe(tmp_path / "recipes"),
            inputs={"accession": "GSE100"},
            workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
        )

    assert checked[-1] == "https://evil.example/result"


def test_recipe_contract_rejects_unknown_browser_action() -> None:
    with pytest.raises(ValueError):
        BrowserActionStep.model_validate({"type": "browser_action", "action": "evaluate"})


def _draft_recipe() -> WorkflowRecipe:
    return WorkflowRecipe(
        recipe_id="recipe_geo",
        created_at=datetime(2026, 7, 29, tzinfo=UTC),
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


def _stored_verified_recipe(root: Path) -> WorkflowRecipe:
    return _store_verified(root, _draft_recipe())


def _store_verified(root: Path, draft: WorkflowRecipe) -> WorkflowRecipe:
    store = WorkflowRecipeStore(root)
    stored = store.save_draft(draft)
    return store.mark_verified(stored.recipe_id, verification_evidence=["fixture"])
