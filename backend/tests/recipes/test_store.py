from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from app.domain.contracts import (
    ApiRequestStep,
    RecipeAttempt,
    RecipeStatus,
    WorkflowRecipe,
)
from app.recipes import WorkflowRecipeStore

NOW = datetime(2026, 7, 29, tzinfo=UTC)


def test_store_writes_json_and_workflow_markdown(tmp_path: Path) -> None:
    store = WorkflowRecipeStore(tmp_path)

    stored = store.save_draft(_recipe())

    recipe_dir = tmp_path / stored.recipe_id / str(stored.version)
    assert (recipe_dir / "recipe.json").is_file()
    assert (recipe_dir / "WORKFLOW.md").is_file()
    assert len(stored.digest) == 64
    assert store.get(stored.recipe_id) == stored


def test_store_redacts_secrets_from_all_fields_before_persisting(
    tmp_path: Path,
) -> None:
    store = WorkflowRecipeStore(tmp_path)

    stored = store.save_draft(
        _recipe(
            request_headers={"Authorization": "Bearer private-token"},
            attempts=[
                RecipeAttempt(
                    method="api",
                    url="https://api.example.org/data?api_key=query-secret",
                    status="failed",
                    started_at=NOW,
                    finished_at=NOW,
                    reason="Cookie: session=reason-secret",
                )
            ],
            verification_evidence=[
                "request failed with token=evidence-secret",
            ],
        )
    )

    recipe_dir = tmp_path / stored.recipe_id / "1"
    json_text = (recipe_dir / "recipe.json").read_text("utf-8")
    markdown_text = (recipe_dir / "WORKFLOW.md").read_text("utf-8")
    persisted = json.loads(json_text)
    combined = json_text + markdown_text
    for secret in (
        "private-token",
        "query-secret",
        "reason-secret",
        "evidence-secret",
    ):
        assert secret not in combined
    assert "[REDACTED]" in combined
    assert persisted["steps"][0]["request_headers"]["Authorization"] == "[REDACTED]"


def test_store_creates_immutable_monotonic_versions(tmp_path: Path) -> None:
    store = WorkflowRecipeStore(tmp_path)
    first = store.save_draft(_recipe())
    first_bytes = (tmp_path / first.recipe_id / "1" / "recipe.json").read_bytes()

    second = store.save_draft(
        _recipe(verification_evidence=["a second independently observed attempt"])
    )

    assert second.version == 2
    assert second.digest != first.digest
    assert (tmp_path / first.recipe_id / "1" / "recipe.json").read_bytes() == first_bytes
    assert store.get(first.recipe_id, version=1) == first
    assert store.get(first.recipe_id, version=2) == second


def test_store_transitions_append_versions_and_find_verified(tmp_path: Path) -> None:
    store = WorkflowRecipeStore(tmp_path)
    draft = store.save_draft(_recipe())

    verified = store.mark_verified(
        draft.recipe_id,
        verification_evidence=["asset_deadbeef passed SourceAsset validation"],
        last_succeeded_at=NOW,
    )

    assert verified.status is RecipeStatus.VERIFIED
    assert verified.version == 2
    assert store.get(draft.recipe_id, version=1).status is RecipeStatus.DRAFT
    assert store.find_verified(
        domain="gene-expression",
        capability="download-series-matrix",
        host="api.example.org",
    ) == [verified]

    promoted = store.request_promotion(draft.recipe_id)
    assert promoted.status is RecipeStatus.PROMOTED
    assert promoted.version == 3
    assert (
        store.find_verified(
            domain="gene-expression",
            capability="download-series-matrix",
        )
        == []
    )


@pytest.mark.parametrize("initial_status", [RecipeStatus.DRAFT, RecipeStatus.VERIFIED])
def test_store_allows_rejection_from_draft_or_verified(
    tmp_path: Path,
    initial_status: RecipeStatus,
) -> None:
    store = WorkflowRecipeStore(tmp_path)
    stored = store.save_draft(_recipe(recipe_id=f"recipe_{initial_status.value}"))
    if initial_status is RecipeStatus.VERIFIED:
        stored = store.mark_verified(stored.recipe_id)

    rejected = store.reject(stored.recipe_id, reason="validation rejected")

    assert rejected.status is RecipeStatus.REJECTED
    assert rejected.rejection_reason == "validation rejected"


def test_store_rejects_invalid_state_transitions(tmp_path: Path) -> None:
    store = WorkflowRecipeStore(tmp_path)
    draft = store.save_draft(_recipe())

    with pytest.raises(ValueError, match="draft.*promoted"):
        store.request_promotion(draft.recipe_id)

    rejected = store.reject(draft.recipe_id, reason="invalid extraction")
    with pytest.raises(ValueError, match="rejected"):
        store.mark_verified(rejected.recipe_id)


@pytest.mark.parametrize(
    "recipe_id",
    ["../outside", "..", "nested/recipe", r"nested\recipe", "C:escape"],
)
def test_store_rejects_recipe_id_path_traversal(
    tmp_path: Path,
    recipe_id: str,
) -> None:
    store = WorkflowRecipeStore(tmp_path)

    with pytest.raises(ValueError, match="recipe_id"):
        store.save_draft(_recipe(recipe_id=recipe_id))


def test_store_detects_tampered_recipe_json(tmp_path: Path) -> None:
    store = WorkflowRecipeStore(tmp_path)
    stored = store.save_draft(_recipe())
    path = tmp_path / stored.recipe_id / "1" / "recipe.json"
    raw = json.loads(path.read_text("utf-8"))
    raw["capability"] = "tampered"
    path.write_text(json.dumps(raw), encoding="utf-8")

    with pytest.raises(ValueError, match="digest"):
        store.get(stored.recipe_id)


def _recipe(
    *,
    recipe_id: str = "recipe_geo",
    request_headers: dict[str, str] | None = None,
    attempts: list[RecipeAttempt] | None = None,
    verification_evidence: list[str] | None = None,
) -> WorkflowRecipe:
    return WorkflowRecipe(
        recipe_id=recipe_id,
        created_at=NOW,
        generated_by_model="qwen-plus",
        domain="gene-expression",
        capability="download-series-matrix",
        allowed_hosts=["api.example.org"],
        url_patterns=["https://api.example.org/*"],
        input_schema={
            "type": "object",
            "properties": {"accession": {"type": "string"}},
            "required": ["accession"],
        },
        steps=[
            ApiRequestStep(
                type="api_request",
                url_template="https://api.example.org/{accession}",
                request_headers=request_headers or {},
            )
        ],
        attempts=attempts or [],
        output_extraction={"format": "csv"},
        source_asset_mapping={"media_type": "text/csv"},
        security_requirements=["public HTTPS only"],
        hil_requirements=["credentials are forbidden"],
        verification_evidence=verification_evidence or [],
    )
