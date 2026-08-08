"""V2 Dataset Cache (Design §16 Phase 7 P0; ARCHITECTURE §13).

Layout::

    cache/datasets/<namespace>/<dataset_id>/
        ├── dataset_manifest.json      # authoritative role-based manifest
        ├── primary.csv                # primary dataset (from manifest)
        ├── schema.json                # schema artifact
        ├── provenance.json            # provenance artifact
        └── cache_manifest.json        # cache entry metadata (keywords, timestamps)

The cache identity is content-derived: the ``dataset_id`` is a deterministic
digest over the build parameters (family / Schema version / source binding /
Adapter version / normalization profile / merge strategy / asset digests),
so identical rebuilds hit the same key and any parameter change produces a
new key. Keywords are search-only — they never participate in the identity
(ARCHITECTURE §13: 关键词用于检索缓存，不用于决定资产身份).

Writes are atomic (temp dir + rename); a crash never leaves a partial entry.
"""
from __future__ import annotations

import hashlib
import json
import shutil
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from app.datasets.contracts import (
    DatasetBuildSpec,
    DatasetManifest,
    ManifestArtifactEntry,
)
from app.domain.contracts.source import SourceAsset

CACHE_DATASETS_DIR = "datasets"


@dataclass(frozen=True)
class CacheEntry:
    """One committed V2 cache entry (metadata only, no data rows)."""

    namespace: str
    dataset_id: str
    manifest_id: str
    build_id: str
    dataset_family: str
    schema_ref: str
    row_count: int
    published_at: str
    keywords: tuple[str, ...]
    directory: Path


def derive_dataset_id(
    spec: DatasetBuildSpec,
    source_assets: dict[str, SourceAsset],
) -> str:
    """Content-derived cache key for a build (family/schema/bindings/...)."""
    material = {
        "family": spec.dataset_family,
        "row_granularity": spec.row_granularity,
        "schema_ref": spec.schema_ref,
        "merge_strategy": spec.merge_strategy,
        "normalization_profile_ref": spec.normalization_profile_ref,
        "validation_profile_ref": spec.validation_profile_ref,
        "bindings": [
            {
                "binding_id": binding.binding_id,
                "source": binding.source,
                "adapter_id": binding.adapter_id,
            }
            for binding in spec.source_bindings
        ],
        "asset_digests": {
            binding_id: asset.sha256
            for binding_id, asset in sorted(source_assets.items())
        },
    }
    digest = hashlib.sha256(
        json.dumps(material, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    return f"dataset_{digest[:24]}"


class DatasetCacheV2:
    """Content-addressed V2 dataset cache rooted at ``<root>/datasets/``."""

    def __init__(self, root: Path | str) -> None:
        self._root = Path(root)
        self._datasets_dir = self._root / CACHE_DATASETS_DIR

    @property
    def root(self) -> Path:
        return self._root

    def commit(
        self,
        *,
        namespace: str,
        output_dir: Path,
        spec: DatasetBuildSpec,
        source_assets: dict[str, SourceAsset],
        keywords: list[str] | None = None,
    ) -> CacheEntry:
        """Copy a build's immutable artifacts into the content-addressed cache.

        ``output_dir`` must contain ``dataset_manifest.json`` plus every
        artifact it declares. The entry is staged under a temp directory and
        atomically renamed into place; an existing entry with the same digest
        is left untouched (immutable).
        """
        _validate_namespace(namespace)
        dataset_id = derive_dataset_id(spec, source_assets)
        manifest_path = output_dir / "dataset_manifest.json"
        if not manifest_path.is_file():
            raise FileNotFoundError(
                f"no dataset_manifest.json under {output_dir}; cannot cache"
            )
        manifest = DatasetManifest.model_validate_json(
            manifest_path.read_text("utf-8")
        )
        entry_dir = self._datasets_dir / namespace / dataset_id
        if entry_dir.is_dir():
            return self._load_entry(entry_dir, namespace, dataset_id)

        entry_dir.parent.mkdir(parents=True, exist_ok=True)
        staged = entry_dir.with_name(f".{dataset_id}.staging")
        if staged.exists():
            shutil.rmtree(staged)
        staged.mkdir(parents=True)
        try:
            for artifact in manifest.artifacts:
                _copy_artifact(output_dir, artifact, staged)
            shutil.copy2(manifest_path, staged / "dataset_manifest.json")
            cache_manifest = {
                "namespace": namespace,
                "dataset_id": dataset_id,
                "manifest_id": manifest.manifest_id,
                "build_id": manifest.build_id,
                "dataset_family": manifest.dataset_family,
                "schema_ref": manifest.schema_ref,
                "row_count": manifest.row_count,
                "published_at": datetime.now(UTC).isoformat(),
                "keywords": [k.strip() for k in (keywords or []) if k and k.strip()],
            }
            (staged / "cache_manifest.json").write_text(
                json.dumps(cache_manifest, ensure_ascii=False, indent=2) + "\n",
                "utf-8",
            )
            staged.rename(entry_dir)
        except OSError as exc:
            shutil.rmtree(staged, ignore_errors=True)
            raise OSError(f"dataset cache commit failed: {exc}") from exc
        return self._load_entry(entry_dir, namespace, dataset_id)

    def find(
        self,
        namespace: str,
        dataset_id: str,
    ) -> CacheEntry | None:
        _validate_namespace(namespace)
        entry_dir = self._datasets_dir / namespace / dataset_id
        if not entry_dir.is_dir() or not (entry_dir / "cache_manifest.json").is_file():
            return None
        return self._load_entry(entry_dir, namespace, dataset_id)

    def list(
        self,
        *,
        namespace: str | None = None,
        limit: int = 50,
    ) -> list[CacheEntry]:
        entries: list[CacheEntry] = []
        if namespace is not None:
            _validate_namespace(namespace)
        base = (
            self._datasets_dir / namespace if namespace is not None else self._datasets_dir
        )
        if not base.is_dir():
            return entries
        candidates: list[Path] = []
        if namespace is not None:
            candidates = [
                child
                for child in base.iterdir()
                if child.is_dir() and not child.name.startswith(".")
            ]
        else:
            # Two levels deep: <root>/datasets/<namespace>/<dataset_id>/
            for namespace_dir in base.iterdir():
                if not namespace_dir.is_dir() or namespace_dir.name.startswith("."):
                    continue
                candidates.extend(
                    child
                    for child in namespace_dir.iterdir()
                    if child.is_dir() and not child.name.startswith(".")
                )
        for entry_dir in candidates:
            if not (entry_dir / "cache_manifest.json").is_file():
                continue
            try:
                entries.append(
                    self._load_entry(entry_dir, entry_dir.parent.name, entry_dir.name)
                )
            except (OSError, json.JSONDecodeError, KeyError):
                continue
        entries.sort(key=lambda e: e.published_at, reverse=True)
        return entries[:limit]

    def search(self, keyword: str, *, limit: int = 20) -> list[CacheEntry]:
        """Keyword search over cache entry metadata (search-only, not identity)."""
        needle = keyword.strip().lower()
        if not needle:
            return []
        matches = [
            entry
            for entry in self.list(limit=10_000)
            if needle in entry.dataset_family.lower()
            or needle in entry.schema_ref.lower()
            or needle in entry.build_id.lower()
            or any(needle in kw.lower() for kw in entry.keywords)
        ]
        return matches[:limit]

    # ------------------------------------------------------------------ utils

    def _load_entry(
        self,
        entry_dir: Path,
        namespace: str,
        dataset_id: str,
    ) -> CacheEntry:
        data = json.loads((entry_dir / "cache_manifest.json").read_text("utf-8"))
        return CacheEntry(
            namespace=namespace,
            dataset_id=dataset_id,
            manifest_id=data["manifest_id"],
            build_id=data["build_id"],
            dataset_family=data["dataset_family"],
            schema_ref=data["schema_ref"],
            row_count=int(data["row_count"]),
            published_at=str(data["published_at"]),
            keywords=tuple(data.get("keywords") or []),
            directory=entry_dir,
        )


def _validate_namespace(namespace: str) -> None:
    if not namespace or "/" in namespace or "\\" in namespace or namespace in {".", ".."}:
        raise ValueError(
            f"invalid cache namespace {namespace!r}: must be a single safe segment"
        )


def _copy_artifact(
    output_dir: Path,
    artifact: ManifestArtifactEntry,
    dest_root: Path,
) -> None:
    src = output_dir / artifact.relative_path
    if not src.is_file():
        raise FileNotFoundError(
            f"manifest artifact missing on disk: {artifact.relative_path}"
        )
    dest = dest_root / artifact.relative_path
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
