"""Immutable, atomic storage for declarative workflow recipes."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import tempfile
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from typing import Any

from app.domain.contracts.recipe import RecipeStatus, WorkflowRecipe
from app.recipes.redaction import redact_secrets
from app.runtime.repository import atomic_write_json, atomic_write_text

_RECIPE_ID_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,127}$")
_TRANSITIONS = {
    RecipeStatus.DRAFT: {RecipeStatus.VERIFIED, RecipeStatus.REJECTED},
    RecipeStatus.VERIFIED: {RecipeStatus.PROMOTED, RecipeStatus.REJECTED},
}


def compute_recipe_digest(recipe: WorkflowRecipe) -> str:
    """Compute the canonical digest used for persisted and executed Recipes."""

    data: dict[str, Any] = recipe.model_dump(mode="json")
    data.pop("digest", None)
    canonical = json.dumps(
        data,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


class WorkflowRecipeStore:
    """Persist append-only Recipe versions below one trusted root."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()

    def save_draft(self, recipe: WorkflowRecipe) -> WorkflowRecipe:
        if recipe.status is not RecipeStatus.DRAFT:
            raise ValueError("save_draft requires a draft recipe")
        with self._lock:
            self._validate_recipe_id(recipe.recipe_id)
            version = self._next_version(recipe.recipe_id)
            candidate = recipe.model_copy(
                update={
                    "version": version,
                    "digest": "",
                    "verified_at": None,
                    "promotion_requested_at": None,
                    "promoted_at": None,
                    "rejected_at": None,
                    "rejection_reason": None,
                }
            )
            return self._persist(candidate)

    def get(self, recipe_id: str, version: int | None = None) -> WorkflowRecipe:
        self._validate_recipe_id(recipe_id)
        recipe_root = self._recipe_root(recipe_id)
        selected_version = self._latest_version(recipe_id) if version is None else version
        if selected_version < 1:
            raise ValueError("version must be at least 1")
        recipe_path = self._contained(recipe_root / str(selected_version) / "recipe.json")
        if not recipe_path.is_file():
            raise KeyError((recipe_id, selected_version))
        try:
            recipe = WorkflowRecipe.model_validate_json(recipe_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise ValueError("stored recipe is invalid") from error
        if recipe.recipe_id != recipe_id or recipe.version != selected_version:
            raise ValueError("stored recipe identity does not match its path")
        if recipe.digest != self._digest(recipe):
            raise ValueError("stored recipe digest does not match its content")
        return recipe

    def find_verified(
        self,
        domain: str,
        capability: str,
        host: str | None = None,
    ) -> list[WorkflowRecipe]:
        normalized_host = host.strip().lower().rstrip(".") if host else None
        matches: list[WorkflowRecipe] = []
        for recipe_root in sorted(self.root.iterdir()):
            if not recipe_root.is_dir() or not _RECIPE_ID_PATTERN.fullmatch(recipe_root.name):
                continue
            try:
                recipe = self.get(recipe_root.name)
            except (KeyError, ValueError):
                continue
            if (
                recipe.status is RecipeStatus.VERIFIED
                and recipe.domain == domain
                and recipe.capability == capability
                and (normalized_host is None or normalized_host in recipe.allowed_hosts)
            ):
                matches.append(recipe)
        return sorted(
            matches,
            key=lambda recipe: (
                recipe.last_succeeded_at or recipe.verified_at or recipe.created_at,
                recipe.recipe_id,
            ),
            reverse=True,
        )

    def mark_verified(
        self,
        recipe_id: str,
        *,
        verification_evidence: list[str] | None = None,
        last_succeeded_at: datetime | None = None,
        verified_at: datetime | None = None,
    ) -> WorkflowRecipe:
        timestamp = verified_at or datetime.now(UTC)
        updates: dict[str, object] = {
            "verified_at": timestamp,
            "last_succeeded_at": last_succeeded_at or timestamp,
        }
        if verification_evidence is not None:
            updates["verification_evidence"] = verification_evidence
        return self._transition(recipe_id, RecipeStatus.VERIFIED, updates)

    def reject(
        self,
        recipe_id: str,
        *,
        reason: str,
        rejected_at: datetime | None = None,
    ) -> WorkflowRecipe:
        if not reason.strip():
            raise ValueError("rejection reason must not be blank")
        return self._transition(
            recipe_id,
            RecipeStatus.REJECTED,
            {
                "rejected_at": rejected_at or datetime.now(UTC),
                "rejection_reason": reason.strip(),
            },
        )

    def request_promotion(
        self,
        recipe_id: str,
        *,
        requested_at: datetime | None = None,
    ) -> WorkflowRecipe:
        with self._lock:
            current = self.get(recipe_id)
            if current.status is not RecipeStatus.VERIFIED:
                raise ValueError(
                    f"recipe status transition {current.status.value} -> "
                    "promotion_requested is not allowed"
                )
            if current.promotion_requested_at is not None:
                raise ValueError("promotion was already requested")
            candidate = current.model_copy(
                update={
                    "version": current.version + 1,
                    "digest": "",
                    "promotion_requested_at": requested_at or datetime.now(UTC),
                }
            )
            return self._persist(candidate)

    def approve_promotion(
        self,
        recipe_id: str,
        *,
        promoted_at: datetime | None = None,
    ) -> WorkflowRecipe:
        with self._lock:
            current = self.get(recipe_id)
            if current.status is not RecipeStatus.VERIFIED:
                raise ValueError(
                    f"recipe status transition {current.status.value} -> promoted is not allowed"
                )
            if current.promotion_requested_at is None:
                raise ValueError("promotion approval requires a prior request")
            return self._transition(
                recipe_id,
                RecipeStatus.PROMOTED,
                {"promoted_at": promoted_at or datetime.now(UTC)},
            )

    def _transition(
        self,
        recipe_id: str,
        target: RecipeStatus,
        updates: Mapping[str, object],
    ) -> WorkflowRecipe:
        with self._lock:
            current = self.get(recipe_id)
            allowed = _TRANSITIONS.get(current.status, set())
            if target not in allowed:
                raise ValueError(
                    f"recipe status transition {current.status.value} -> "
                    f"{target.value} is not allowed"
                )
            candidate = current.model_copy(
                update={
                    **updates,
                    "version": current.version + 1,
                    "digest": "",
                    "status": target,
                }
            )
            return self._persist(candidate)

    def _persist(self, recipe: WorkflowRecipe) -> WorkflowRecipe:
        sanitized_data = redact_secrets(recipe.model_dump(mode="json"))
        if not isinstance(sanitized_data, Mapping):
            raise TypeError("recipe must serialize to an object")
        sanitized = WorkflowRecipe.model_validate(dict(sanitized_data))
        stored = sanitized.model_copy(update={"digest": self._digest(sanitized)})
        version_dir = self._contained(self._recipe_root(stored.recipe_id) / str(stored.version))
        if version_dir.exists():
            raise FileExistsError(
                f"recipe version already exists: {stored.recipe_id}/{stored.version}"
            )
        version_dir.parent.mkdir(parents=True, exist_ok=True)
        temporary = Path(
            tempfile.mkdtemp(
                dir=version_dir.parent,
                prefix=f".{stored.version}.",
            )
        )
        try:
            atomic_write_json(temporary / "recipe.json", stored)
            atomic_write_text(
                temporary / "WORKFLOW.md",
                self._render_workflow(stored),
            )
            temporary.replace(version_dir)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
        return stored

    def _next_version(self, recipe_id: str) -> int:
        try:
            return self._latest_version(recipe_id) + 1
        except KeyError:
            return 1

    def _latest_version(self, recipe_id: str) -> int:
        recipe_root = self._recipe_root(recipe_id)
        if not recipe_root.is_dir():
            raise KeyError(recipe_id)
        versions = [
            int(item.name)
            for item in recipe_root.iterdir()
            if item.is_dir() and item.name.isdigit() and int(item.name) >= 1
        ]
        if not versions:
            raise KeyError(recipe_id)
        return max(versions)

    def _recipe_root(self, recipe_id: str) -> Path:
        self._validate_recipe_id(recipe_id)
        return self._contained(self.root / recipe_id)

    def _contained(self, path: Path) -> Path:
        resolved = path.resolve(strict=False)
        if not resolved.is_relative_to(self.root):
            raise ValueError("recipe path must remain inside the store")
        return resolved

    @staticmethod
    def _validate_recipe_id(recipe_id: str) -> None:
        if not _RECIPE_ID_PATTERN.fullmatch(recipe_id):
            raise ValueError("recipe_id must be a safe identifier")

    @staticmethod
    def _digest(recipe: WorkflowRecipe) -> str:
        return compute_recipe_digest(recipe)

    @staticmethod
    def _render_workflow(recipe: WorkflowRecipe) -> str:
        lines = [
            f"# Workflow Recipe: {recipe.recipe_id}",
            "",
            f"- Version: {recipe.version}",
            f"- Digest: `{recipe.digest}`",
            f"- Status: {recipe.status.value}",
            f"- Domain: {recipe.domain}",
            f"- Capability: {recipe.capability}",
            f"- Generated by: {recipe.generated_by_model}",
            "",
            "## Allowed hosts",
            "",
            *(f"- {host}" for host in recipe.allowed_hosts),
            "",
            "## Declarative steps",
            "",
        ]
        for index, step in enumerate(recipe.steps, start=1):
            step_data = redact_secrets(step.model_dump(mode="json"))
            lines.append(
                f"{index}. `{step.type}` — "
                f"`{json.dumps(step_data, ensure_ascii=False, sort_keys=True)}`"
            )
        lines.extend(["", "## Attempts", ""])
        if recipe.attempts:
            for attempt in recipe.attempts:
                lines.append(
                    f"- {attempt.method}: {attempt.status} — {attempt.url}"
                    + (f" ({attempt.reason})" if attempt.reason else "")
                )
        else:
            lines.append("- No attempts recorded.")
        lines.append("")
        markdown = redact_secrets("\n".join(lines))
        assert isinstance(markdown, str)
        return markdown
