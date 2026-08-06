from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path

import pytest
from app.domain.contracts import (
    ApiRequestStep,
    BrowserActionStep,
    DataLevel,
    HtmlExtractStep,
    RecipeAttempt,
    WorkflowRecipe,
)
from app.integrations.acquisition import ValidatedRecipeTarget
from app.recipes.executor import (
    RecipeExecutor,
    RecipeStepResponse,
)
from app.recipes.store import WorkflowRecipeStore
from app.subagents.staging import SubagentStagingWorkspace
from app.tools.network_safety import PublicHttpTarget

NOW = datetime(2026, 7, 29, tzinfo=UTC)


class FakeRecipeClient:
    def __init__(self, responses: list[RecipeStepResponse]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.browser_contacts: list[str] = []
        self._authorize_request: Callable[..., ValidatedRecipeTarget] | None = None

    async def api_request(self, **kwargs: object) -> RecipeStepResponse:
        self.calls.append(("api", kwargs))
        return self.responses.pop(0)

    async def html_extract(self, **kwargs: object) -> RecipeStepResponse:
        self.calls.append(("html", kwargs))
        return self.responses.pop(0)

    @asynccontextmanager
    async def browser_authorization(
        self,
        *,
        authorize_request: Callable[..., ValidatedRecipeTarget],
    ) -> AsyncIterator[None]:
        assert self._authorize_request is None
        self._authorize_request = authorize_request
        try:
            yield
        finally:
            self._authorize_request = None

    async def browser_action(self, **kwargs: object) -> RecipeStepResponse:
        self.calls.append(("browser", kwargs))
        if kwargs["action"] == "navigate":
            self._contact_browser(str(kwargs["current_url"]), resource_type="main_frame")
        return self.responses.pop(0)

    def _contact_browser(
        self,
        url: str,
        *,
        resource_type: str,
    ) -> ValidatedRecipeTarget:
        if self._authorize_request is None:
            raise RuntimeError("browser transport used outside authorization scope")
        target = self._authorize_request(url, resource_type=resource_type)
        self.browser_contacts.append(url)
        return target


@pytest.mark.asyncio
async def test_promoted_recipe_produces_staged_source_asset(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_target_validator(monkeypatch)
    store, recipe = _stored_promoted_recipe(tmp_path / "recipes")
    client = FakeRecipeClient(
        [
            RecipeStepResponse(
                content=b'{"accession":"GSE100"}',
                status_code=200,
                media_type="application/json",
            )
        ]
    )
    workspace = SubagentStagingWorkspace(tmp_path / "task", "sub_1")

    result = await RecipeExecutor(client=client, store=store).execute(
        recipe_id=recipe.recipe_id,
        version=recipe.version,
        inputs={"accession": "GSE100"},
        workspace=workspace,
    )

    assert result.source_asset.source_id == "src_recipe"
    assert result.source_asset.data_level is DataLevel.METADATA
    assert result.download_attempt.attempt_id == (result.source_asset.successful_attempt_id)
    assert result.attempts[0].method == "api"
    assert result.attempts[0].status == "succeeded"
    assert workspace.staged_path(result.source_asset).read_bytes().startswith(b"{")
    target = client.calls[0][1]["target"]
    assert isinstance(target, ValidatedRecipeTarget)
    assert target.url == "https://api.example.org/GSE100"


@pytest.mark.asyncio
async def test_executor_percent_encodes_declared_template_values(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_target_validator(monkeypatch)
    store, recipe = _stored_promoted_recipe(tmp_path / "recipes")
    client = FakeRecipeClient(
        [
            RecipeStepResponse(
                content=b"ok",
                status_code=200,
                media_type="text/plain",
            )
        ]
    )

    await RecipeExecutor(client=client, store=store).execute(
        recipe_id=recipe.recipe_id,
        version=recipe.version,
        inputs={"accession": "a/b@evil.example"},
        workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
    )

    target = client.calls[0][1]["target"]
    assert isinstance(target, ValidatedRecipeTarget)
    assert target.url == "https://api.example.org/a%2Fb%40evil.example"


@pytest.mark.asyncio
async def test_executor_percent_encodes_browser_navigation_values(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_target_validator(monkeypatch)
    draft = _draft_recipe().model_copy(
        update={
            "attempts": _fallback_evidence(),
            "steps": [
                BrowserActionStep(
                    action="navigate",
                    value="https://api.example.org/{accession}",
                ),
                BrowserActionStep(
                    action="extract",
                    target="body",
                    output_name="page.html",
                ),
            ],
        }
    )
    store, recipe = _store_promoted(tmp_path / "recipes", draft)
    client = FakeRecipeClient(
        [
            RecipeStepResponse(
                content=b"",
                status_code=200,
                media_type="text/html",
            ),
            RecipeStepResponse(
                content=b"<html></html>",
                status_code=200,
                media_type="text/html",
            ),
        ]
    )

    await RecipeExecutor(client=client, store=store).execute(
        recipe_id=recipe.recipe_id,
        version=recipe.version,
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
    store, recipe = _stored_promoted_recipe(tmp_path / "recipes")
    client = FakeRecipeClient([])

    with pytest.raises(ValueError, match=message):
        await RecipeExecutor(client=client, store=store).execute(
            recipe_id=recipe.recipe_id,
            version=recipe.version,
            inputs=inputs,
            workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
        )

    assert client.calls == []


@pytest.mark.asyncio
async def test_executor_rejects_tampered_or_unverified_stored_recipe(
    tmp_path: Path,
) -> None:
    root = tmp_path / "recipes"
    store, promoted = _stored_promoted_recipe(root)
    recipe_path = root / promoted.recipe_id / str(promoted.version) / "recipe.json"
    serialized = json.loads(recipe_path.read_text(encoding="utf-8"))
    serialized["capability"] = "tampered"
    recipe_path.write_text(json.dumps(serialized), encoding="utf-8")
    client = FakeRecipeClient([])
    executor = RecipeExecutor(client=client, store=store)
    workspace = SubagentStagingWorkspace(tmp_path / "task", "sub_1")

    with pytest.raises(ValueError, match="digest"):
        await executor.execute(
            recipe_id=promoted.recipe_id,
            version=promoted.version,
            inputs={"accession": "GSE100"},
            workspace=workspace,
        )

    draft_store = WorkflowRecipeStore(tmp_path / "draft-recipes")
    draft = draft_store.save_draft(
        _draft_recipe().model_copy(update={"recipe_id": "recipe_unverified"})
    )
    with pytest.raises(ValueError, match="promoted"):
        await RecipeExecutor(client=client, store=draft_store).execute(
            recipe_id=draft.recipe_id,
            version=draft.version,
            inputs={"accession": "GSE100"},
            workspace=workspace,
        )


@pytest.mark.asyncio
async def test_executor_records_failed_fallback_before_success(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_target_validator(monkeypatch)
    draft = _draft_recipe().model_copy(
        update={
            "steps": [
                ApiRequestStep(
                    url_template="https://api.example.org/{accession}",
                    output_name="result.json",
                ),
                HtmlExtractStep(
                    url_template="https://api.example.org/{accession}",
                    selectors={"download": "a.download"},
                    output_name="result.csv",
                ),
            ]
        }
    )
    store, recipe = _store_promoted(tmp_path / "recipes", draft)
    client = FakeRecipeClient(
        [
            RecipeStepResponse(
                content=b"",
                status_code=503,
                media_type="application/json",
                error="service unavailable",
            ),
            RecipeStepResponse(
                content=b"csv-data",
                status_code=200,
                media_type="text/csv",
            ),
        ]
    )

    result = await RecipeExecutor(client=client, store=store).execute(
        recipe_id=recipe.recipe_id,
        version=recipe.version,
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
    _patch_target_validator(monkeypatch)

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
                    output_name="result.json",
                )
            ],
        }
    )
    store, recipe = _store_promoted(tmp_path / "recipes", draft)

    with pytest.raises(TimeoutError, match="recipe execution timed out"):
        await RecipeExecutor(client=SlowClient([]), store=store).execute(
            recipe_id=recipe.recipe_id,
            version=recipe.version,
            inputs={"accession": "GSE100"},
            workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
        )


@pytest.mark.asyncio
async def test_executor_revalidates_redirect_before_following(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    checked: list[str] = []

    def validate(
        url: str,
        allowed_hosts: list[str],
    ) -> ValidatedRecipeTarget:
        checked.append(url)
        if "evil.example" in url:
            raise ValueError("host is not allowed")
        return _target(url)

    monkeypatch.setattr("app.recipes.executor.validate_recipe_source_url", validate)
    store, recipe = _stored_promoted_recipe(tmp_path / "recipes")
    client = FakeRecipeClient(
        [
            RecipeStepResponse(
                content=b"",
                status_code=302,
                media_type="text/plain",
                redirect_url="https://evil.example/result",
            )
        ]
    )

    with pytest.raises(ValueError, match="not allowed"):
        await RecipeExecutor(client=client, store=store).execute(
            recipe_id=recipe.recipe_id,
            version=recipe.version,
            inputs={"accession": "GSE100"},
            workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
        )

    assert checked[-1] == "https://evil.example/result"
    assert len(client.calls) == 1


def test_recipe_contract_rejects_unknown_browser_action() -> None:
    with pytest.raises(ValueError):
        BrowserActionStep.model_validate({"type": "browser_action", "action": "evaluate"})


@pytest.mark.asyncio
async def test_executor_rejects_verified_recipe_in_production(
    tmp_path: Path,
) -> None:
    store, verified = _stored_verified_recipe(tmp_path / "recipes")
    client = FakeRecipeClient([])

    with pytest.raises(ValueError, match="only promoted"):
        await RecipeExecutor(client=client, store=store).execute(
            recipe_id=verified.recipe_id,
            version=verified.version,
            inputs={"accession": "GSE100"},
            workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
        )
    assert client.calls == []


@pytest.mark.asyncio
async def test_executor_trial_execution_accepts_verified_recipe(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_target_validator(monkeypatch)
    store, verified = _stored_verified_recipe(tmp_path / "recipes")
    client = FakeRecipeClient(
        [
            RecipeStepResponse(
                content=b'{"accession":"GSE100"}',
                status_code=200,
                media_type="application/json",
            )
        ]
    )

    result = await RecipeExecutor(client=client, store=store).execute_for_trial(
        recipe_id=verified.recipe_id,
        version=verified.version,
        inputs={"accession": "GSE100"},
        workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
    )

    assert result.source_asset.source_id == "src_recipe"
    assert result.attempts[0].status == "succeeded"


@pytest.mark.asyncio
async def test_executor_trial_execution_rejects_promoted_recipe(
    tmp_path: Path,
) -> None:
    store, promoted = _stored_promoted_recipe(tmp_path / "recipes")
    client = FakeRecipeClient([])

    with pytest.raises(ValueError, match="limited trial"):
        await RecipeExecutor(client=client, store=store).execute_for_trial(
            recipe_id=promoted.recipe_id,
            version=promoted.version,
            inputs={"accession": "GSE100"},
            workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
        )
    assert client.calls == []


@pytest.mark.asyncio
async def test_executor_rejects_rejected_recipe_in_production(
    tmp_path: Path,
) -> None:
    store, verified = _stored_verified_recipe(tmp_path / "recipes")
    rejected = store.reject(verified.recipe_id, reason="fixture rejection")
    client = FakeRecipeClient([])

    with pytest.raises(ValueError, match="only promoted"):
        await RecipeExecutor(client=client, store=store).execute(
            recipe_id=rejected.recipe_id,
            version=rejected.version,
            inputs={"accession": "GSE100"},
            workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
        )
    assert client.calls == []


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


def _stored_verified_recipe(
    root: Path,
) -> tuple[WorkflowRecipeStore, WorkflowRecipe]:
    return _store_verified(root, _draft_recipe())


def _stored_promoted_recipe(
    root: Path,
) -> tuple[WorkflowRecipeStore, WorkflowRecipe]:
    return _store_promoted(root, _draft_recipe())


def _store_verified(
    root: Path,
    draft: WorkflowRecipe,
) -> tuple[WorkflowRecipeStore, WorkflowRecipe]:
    store = WorkflowRecipeStore(root)
    stored = store.save_draft(draft)
    verified = store.mark_verified(
        stored.recipe_id,
        verification_evidence=["fixture"],
    )
    return store, verified


def _store_promoted(
    root: Path,
    draft: WorkflowRecipe,
) -> tuple[WorkflowRecipeStore, WorkflowRecipe]:
    store, verified = _store_verified(root, draft)
    requested = store.request_promotion(verified.recipe_id)
    promoted = store.approve_promotion(requested.recipe_id)
    return store, promoted


def _fallback_evidence() -> list[RecipeAttempt]:
    return [
        RecipeAttempt(
            method="api",
            url="https://api.example.org/data",
            status="failed",
            reason="API unavailable",
            fallback_reason="falling back to html",
            started_at=NOW,
            finished_at=NOW,
        ),
        RecipeAttempt(
            method="html",
            url="https://api.example.org/data",
            status="failed",
            reason="HTML unavailable",
            fallback_reason="falling back to browser",
            started_at=NOW,
            finished_at=NOW,
        ),
    ]


def _patch_target_validator(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.recipes.executor.validate_recipe_source_url",
        lambda url, allowed_hosts: _target(url),
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
