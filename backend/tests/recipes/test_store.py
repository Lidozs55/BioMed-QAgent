from __future__ import annotations

import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from threading import Barrier

import pytest
from app.domain.contracts import (
    ApiRequestStep,
    RecipeAttempt,
    RecipeStatus,
    WorkflowRecipe,
)
from app.recipes import WorkflowRecipeStore
from app.recipes import store as store_module

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


@pytest.mark.parametrize(
    ("field_name", "secret"),
    [
        ("client_secret", "client-secret-value"),
        ("access_token", "access-token-value"),
        ("refresh_token", "refresh-token-value"),
        ("id_token", "id-token-value"),
        ("Set-Cookie", "session-cookie-value"),
        ("Proxy-Authorization", "proxy-auth-value"),
        ("form_password", "form-password-value"),
        ("private_key", "private-key-value"),
        ("raw_credentials", "raw-credential-value"),
    ],
)
def test_store_redacts_sensitive_key_aliases_from_json_and_markdown(
    tmp_path: Path,
    field_name: str,
    secret: str,
) -> None:
    store = WorkflowRecipeStore(tmp_path)
    recipe_data = _recipe().model_dump(mode="json")
    recipe_data["input_schema"] = {
        "type": "object",
        "properties": {
            "outer": {
                "type": "object",
                "metadata": {field_name: secret},
            }
        },
    }

    stored = store.save_draft(WorkflowRecipe.model_validate(recipe_data))

    recipe_dir = tmp_path / stored.recipe_id / "1"
    json_text = (recipe_dir / "recipe.json").read_text("utf-8")
    markdown_text = (recipe_dir / "WORKFLOW.md").read_text("utf-8")
    assert secret not in json_text
    assert secret not in markdown_text
    assert "[REDACTED]" in json_text


def test_workflow_markdown_applies_independent_secret_redaction() -> None:
    recipe = _recipe(
        request_headers={"client_secret": "markdown-only-secret"},
    )

    markdown = WorkflowRecipeStore._render_workflow(recipe)

    assert "markdown-only-secret" not in markdown
    assert "[REDACTED]" in markdown


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
        verified_at=NOW,
    )

    assert verified.status is RecipeStatus.VERIFIED
    assert verified.version == 2
    assert store.get(draft.recipe_id, version=1).status is RecipeStatus.DRAFT
    assert store.find_verified(
        domain="gene-expression",
        capability="download-series-matrix",
        host="api.example.org",
    ) == [verified]

    requested = store.request_promotion(draft.recipe_id, requested_at=NOW)
    assert requested.status is RecipeStatus.VERIFIED
    assert requested.promotion_requested_at == NOW
    assert requested.version == 3

    promoted = store.approve_promotion(draft.recipe_id, promoted_at=NOW)
    assert promoted.status is RecipeStatus.PROMOTED
    assert promoted.version == 4
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
        store.approve_promotion(draft.recipe_id)

    rejected = store.reject(draft.recipe_id, reason="invalid extraction")
    with pytest.raises(ValueError, match="rejected"):
        store.mark_verified(rejected.recipe_id)


def test_store_requires_promotion_request_before_approval(tmp_path: Path) -> None:
    store = WorkflowRecipeStore(tmp_path)
    draft = store.save_draft(_recipe())
    verified = store.mark_verified(draft.recipe_id, verified_at=NOW)

    with pytest.raises(ValueError, match="request"):
        store.approve_promotion(verified.recipe_id, promoted_at=NOW)

    requested = store.request_promotion(verified.recipe_id, requested_at=NOW)
    promoted = store.approve_promotion(requested.recipe_id, promoted_at=NOW)
    assert requested.status is RecipeStatus.VERIFIED
    assert promoted.status is RecipeStatus.PROMOTED


def test_store_rejects_duplicate_promotion_request(tmp_path: Path) -> None:
    store = WorkflowRecipeStore(tmp_path)
    stored = store.save_draft(_recipe())
    stored = store.mark_verified(stored.recipe_id, verified_at=NOW)
    store.request_promotion(stored.recipe_id, requested_at=NOW)

    with pytest.raises(ValueError, match="already"):
        store.request_promotion(stored.recipe_id, requested_at=NOW)


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


def test_store_rejects_tampered_lifecycle_with_recomputed_digest(
    tmp_path: Path,
) -> None:
    store = WorkflowRecipeStore(tmp_path)
    stored = store.save_draft(_recipe())
    path = tmp_path / stored.recipe_id / "1" / "recipe.json"
    raw = json.loads(path.read_text("utf-8"))
    raw["verified_at"] = NOW.isoformat()
    raw["digest"] = _digest_raw_recipe(raw)
    path.write_text(json.dumps(raw), encoding="utf-8")

    with pytest.raises(ValueError, match="stored recipe is invalid"):
        store.get(stored.recipe_id)


def test_find_verified_requires_exact_domain_and_capability(tmp_path: Path) -> None:
    store = WorkflowRecipeStore(tmp_path)
    stored = store.save_draft(_recipe())
    store.mark_verified(stored.recipe_id, verified_at=NOW)

    assert (
        store.find_verified(
            domain="gene",
            capability="download-series-matrix",
        )
        == []
    )
    assert (
        store.find_verified(
            domain="gene-expression",
            capability="download",
        )
        == []
    )


def test_independent_stores_racing_same_version_never_overwrite(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first_store = WorkflowRecipeStore(tmp_path)
    second_store = WorkflowRecipeStore(tmp_path)
    barrier = Barrier(2)
    first_next = first_store._next_version
    second_next = second_store._next_version

    def synchronized_first(recipe_id: str) -> int:
        version = first_next(recipe_id)
        barrier.wait(timeout=5)
        return version

    def synchronized_second(recipe_id: str) -> int:
        version = second_next(recipe_id)
        barrier.wait(timeout=5)
        return version

    monkeypatch.setattr(first_store, "_next_version", synchronized_first)
    monkeypatch.setattr(second_store, "_next_version", synchronized_second)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(first_store.save_draft, _recipe()),
            executor.submit(
                second_store.save_draft,
                _recipe(verification_evidence=["second writer"]),
            ),
        ]
        outcomes: list[WorkflowRecipe | Exception] = []
        for future in futures:
            try:
                outcomes.append(future.result(timeout=10))
            except Exception as error:
                outcomes.append(error)

    winners = [item for item in outcomes if isinstance(item, WorkflowRecipe)]
    failures = [item for item in outcomes if isinstance(item, Exception)]
    assert len(winners) == 1
    assert len(failures) == 1
    assert first_store.get("recipe_geo") == winners[0]
    assert [item.name for item in (tmp_path / "recipe_geo").iterdir() if item.name.isdigit()] == [
        "1"
    ]
    assert not list((tmp_path / "recipe_geo").glob(".*"))


def test_second_file_failure_leaves_no_visible_version_and_retry_reuses_number(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = WorkflowRecipeStore(tmp_path)
    real_atomic_write_text = store_module.atomic_write_text

    def fail_workflow(path: Path, content: str) -> None:
        if path.name == "WORKFLOW.md":
            raise OSError("injected second-file failure")
        real_atomic_write_text(path, content)

    monkeypatch.setattr(store_module, "atomic_write_text", fail_workflow)
    with pytest.raises(OSError, match="second-file"):
        store.save_draft(_recipe())

    recipe_root = tmp_path / "recipe_geo"
    assert recipe_root.is_dir()
    assert list(recipe_root.iterdir()) == []

    monkeypatch.setattr(store_module, "atomic_write_text", real_atomic_write_text)
    stored = store.save_draft(_recipe())
    assert stored.version == 1


def test_store_rejects_symlink_recipe_escape(tmp_path: Path) -> None:
    store_root = tmp_path / "recipes"
    outside = tmp_path / "outside"
    store = WorkflowRecipeStore(store_root)
    outside.mkdir()
    try:
        (store_root / "recipe_geo").symlink_to(outside, target_is_directory=True)
    except OSError as error:
        pytest.skip(f"directory symlinks unavailable: {error}")

    with pytest.raises(ValueError, match="inside"):
        store.save_draft(_recipe())
    assert list(outside.iterdir()) == []


def test_store_uses_resolved_contained_paths(tmp_path: Path) -> None:
    store = WorkflowRecipeStore(tmp_path)
    nested = tmp_path / "nested"
    nested.mkdir()
    non_normalized = nested / ".." / "recipe_geo"

    assert store._contained(non_normalized) == (tmp_path / "recipe_geo").resolve()


def _digest_raw_recipe(raw: dict[str, object]) -> str:
    canonical_data = dict(raw)
    canonical_data.pop("digest", None)
    canonical = json.dumps(
        canonical_data,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


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
