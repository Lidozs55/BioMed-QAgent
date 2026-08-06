"""WorkflowRecipeSourceFetcher tests (Design §9.3 Acquisition Provider)."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from pathlib import Path

import pytest
from app.datasets.contracts import (
    AcquisitionMode,
    SourceBinding,
    SourceBindingAcquisition,
)
from app.domain.contracts import ApiRequestStep, WorkflowRecipe
from app.integrations.acquisition import ValidatedRecipeTarget
from app.recipes.executor import RecipeExecutor, RecipeStepResponse
from app.recipes.source_fetcher import WorkflowRecipeSourceFetcher
from app.recipes.store import WorkflowRecipeStore
from app.subagents.staging import SubagentStagingWorkspace
from app.tools.network_safety import PublicHttpTarget

NOW = datetime(2026, 7, 29, tzinfo=UTC)


class FakeRecipeClient:
    """Minimal client: the test recipe only issues one API request."""

    def __init__(self, response: RecipeStepResponse) -> None:
        self.response = response
        self.calls = 0

    async def api_request(self, **kwargs: object) -> RecipeStepResponse:
        self.calls += 1
        return self.response


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


def _store_promoted(root: Path) -> tuple[WorkflowRecipeStore, WorkflowRecipe]:
    store = WorkflowRecipeStore(root)
    stored = store.save_draft(_draft_recipe())
    verified = store.mark_verified(stored.recipe_id, verification_evidence=["fixture"])
    requested = store.request_promotion(verified.recipe_id)
    promoted = store.approve_promotion(requested.recipe_id)
    return store, promoted


def _binding(
    recipe_id: str,
    recipe_version: int,
    *,
    mode: AcquisitionMode = AcquisitionMode.WORKFLOW_RECIPE,
) -> SourceBinding:
    return SourceBinding(
        binding_id="srcbind_geo",
        source="geo",
        acquisition=SourceBindingAcquisition(
            mode=mode,
            provider_id="gdc.files.v1" if mode is AcquisitionMode.BUILTIN else None,
            recipe_id=recipe_id if mode is AcquisitionMode.WORKFLOW_RECIPE else None,
            recipe_version=recipe_version if mode is AcquisitionMode.WORKFLOW_RECIPE else None,
        ),
        adapter_id="geo.series_matrix.v1",
        parameters={"accession": "GSE100"},
    )


@pytest.mark.asyncio
async def test_fetcher_executes_promoted_recipe_and_commits_source_asset(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.recipes.executor.validate_recipe_source_url",
        lambda url, allowed_hosts: _target(url),
    )
    store, promoted = _store_promoted(tmp_path / "recipes")
    client = FakeRecipeClient(
        RecipeStepResponse(
            content=b'{"accession":"GSE100"}',
            status_code=200,
            media_type="application/json",
        )
    )
    fetcher = WorkflowRecipeSourceFetcher(
        executor=RecipeExecutor(client=client, store=store),
        store=store,
    )
    workspace = SubagentStagingWorkspace(tmp_path / "task", "sub_1")

    result = await fetcher.fetch(
        binding=_binding(promoted.recipe_id, promoted.version),
        workspace=workspace,
    )

    assert client.calls == 1
    assert result.source_asset.source_id == "src_recipe"
    assert result.download_attempt.status.value == "succeeded"
    committed_path = workspace.task_root.joinpath(result.source_asset.relative_path)
    assert committed_path.is_file()
    assert hashlib.sha256(committed_path.read_bytes()).hexdigest() == result.source_asset.sha256


@pytest.mark.asyncio
async def test_fetcher_rejects_non_workflow_recipe_mode(
    tmp_path: Path,
) -> None:
    store, promoted = _store_promoted(tmp_path / "recipes")
    fetcher = WorkflowRecipeSourceFetcher(
        executor=RecipeExecutor(client=FakeRecipeClient(RecipeStepResponse(
            content=b"",
            status_code=200,
            media_type="text/plain",
        )), store=store),
        store=store,
    )

    with pytest.raises(ValueError, match="workflow_recipe"):
        await fetcher.fetch(
            binding=_binding(
                promoted.recipe_id,
                promoted.version,
                mode=AcquisitionMode.BUILTIN,
            ),
            workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
        )


@pytest.mark.asyncio
async def test_fetcher_blocks_verified_recipe_in_production(
    tmp_path: Path,
) -> None:
    store = WorkflowRecipeStore(tmp_path / "recipes")
    stored = store.save_draft(_draft_recipe())
    verified = store.mark_verified(stored.recipe_id, verification_evidence=["fixture"])
    client = FakeRecipeClient(RecipeStepResponse(
        content=b'{"accession":"GSE100"}',
        status_code=200,
        media_type="application/json",
    ))
    fetcher = WorkflowRecipeSourceFetcher(
        executor=RecipeExecutor(client=client, store=store),
        store=store,
    )

    with pytest.raises(ValueError, match="only promoted"):
        await fetcher.fetch(
            binding=_binding(verified.recipe_id, verified.version),
            workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
        )
    assert client.calls == 0
