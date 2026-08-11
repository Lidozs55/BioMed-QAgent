"""Legacy main_data.csv cache wrapper (Phase 7 T2, P1).

Read-side projection that exposes the OLD 22-column cache (the ``CacheStore``
records tree under ``cache/records/<namespace>/<dataset_id>/``) through the
new V2 cache API as schema ``gene_expression.long.legacy.v1``.

The legacy rows are already the long-v1 shape: ``CACHE_MAIN_DATA_COLUMNS``
is exactly the ``gene_expression.long.v1`` field list (asserted in
``tests/test_legacy_cache_wrapper.py``), so the wrapper is a small adapter —
it reads ``manifest.json`` + ``main_data.csv`` and projects them onto the new
cache entry shape. It is deliberately NOT a new engine: no writes, no index
maintenance, no schema conversion. Legacy entries keep their own ids and
namespaces; the API merges them with V2 ``DatasetCacheV2`` entries and serves
them under the legacy schema ref (``gene_expression.long.legacy.v1``) so
clients can distinguish the transition-period source.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from app.datasets.contracts import ManifestArtifactEntry
from app.domain.contracts.dataset_state import ArtifactRole
from app.tools.cache_store import CacheDatasetManifest

#: Legacy 22-column cache rows are served under this schema ref (never the
#: canonical ``gene_expression.long.v1`` — a wrapped legacy row has no V2
#: provenance/validation to back the canonical contract).
LEGACY_SCHEMA_REF = "gene_expression.long.legacy.v1"
LEGACY_DATASET_FAMILY = "gene_expression"

#: Safe-segment guards mirror ``DatasetCacheV2._validate_namespace`` and the
#: CacheStore namespace/id regexes; lookups never touch a path segment that
#: could escape the cache root.
_SAFE_SEGMENT = re.compile(r"^[a-z0-9][a-z0-9_-]*$")

_RECORDS_DIR = "records"


@dataclass(frozen=True)
class LegacyCacheEntry:
    """One legacy cache record projected onto the new cache entry shape."""

    namespace: str
    dataset_id: str
    dataset_family: str
    schema_ref: str
    row_count: int
    published_at: str
    keywords: tuple[str, ...]
    directory: Path
    manifest: CacheDatasetManifest


def list_legacy(
    root: Path | str,
    *,
    namespace: str | None = None,
    limit: int = 10_000,
) -> list[LegacyCacheEntry]:
    """List legacy records under ``<root>/records/``, newest first.

    Scans the records tree directly (the authoritative on-disk layout) rather
    than the CacheStore sqlite index, so the projection stays read-only and
    never depends on index freshness.
    """

    records = Path(root) / _RECORDS_DIR
    if not records.is_dir():
        return []
    candidates: list[Path] = []
    if namespace is not None:
        if not _SAFE_SEGMENT.fullmatch(namespace):
            return []
        namespace_dir = records / namespace
        if not namespace_dir.is_dir():
            return []
        candidates = [
            child
            for child in namespace_dir.iterdir()
            if child.is_dir() and not child.name.startswith(".")
        ]
    else:
        for namespace_dir in records.iterdir():
            if not namespace_dir.is_dir() or namespace_dir.name.startswith("."):
                continue
            candidates.extend(
                child
                for child in namespace_dir.iterdir()
                if child.is_dir() and not child.name.startswith(".")
            )
    entries: list[LegacyCacheEntry] = []
    for dataset_dir in candidates:
        if not (dataset_dir / "manifest.json").is_file():
            continue
        try:
            entry = _load_entry(dataset_dir, dataset_dir.parent.name, dataset_dir.name)
        except (OSError, json.JSONDecodeError, TypeError, KeyError):
            continue
        entries.append(entry)
    entries.sort(key=lambda entry: entry.published_at, reverse=True)
    return entries[:limit]


def find_legacy(
    root: Path | str,
    namespace: str,
    dataset_id: str,
) -> LegacyCacheEntry | None:
    """Look up one legacy record by namespace + dataset_id."""

    if not _SAFE_SEGMENT.fullmatch(namespace) or not _SAFE_SEGMENT.fullmatch(
        dataset_id
    ):
        return None
    dataset_dir = Path(root) / _RECORDS_DIR / namespace / dataset_id
    if not (dataset_dir / "manifest.json").is_file():
        return None
    try:
        return _load_entry(dataset_dir, namespace, dataset_id)
    except (OSError, json.JSONDecodeError, TypeError, KeyError):
        return None


def find_legacy_global(root: Path | str, dataset_id: str) -> LegacyCacheEntry | None:
    """Look up one legacy record by dataset_id across every namespace."""

    for entry in list_legacy(root, limit=10_000):
        if entry.dataset_id == dataset_id:
            return entry
    return None


def legacy_artifacts(entry: LegacyCacheEntry) -> list[ManifestArtifactEntry]:
    """The legacy record's artifact inventory: main_data.csv + manifest.json."""

    main_data_path = entry.directory / "main_data.csv"
    manifest_path = entry.directory / "manifest.json"
    return [
        ManifestArtifactEntry(
            artifact_id="main_data",
            role=ArtifactRole.PRIMARY_DATASET,
            relative_path="main_data.csv",
            media_type="text/csv",
            size_bytes=main_data_path.stat().st_size,
            sha256=_file_sha256(main_data_path),
        ),
        ManifestArtifactEntry(
            artifact_id="manifest",
            role=ArtifactRole.SCHEMA,
            relative_path="manifest.json",
            media_type="application/json",
            size_bytes=manifest_path.stat().st_size,
            sha256=_file_sha256(manifest_path),
        ),
    ]


def _load_entry(
    dataset_dir: Path,
    namespace: str,
    dataset_id: str,
) -> LegacyCacheEntry:
    manifest_data = json.loads(
        (dataset_dir / "manifest.json").read_text("utf-8")
    )
    manifest = CacheDatasetManifest(**manifest_data)
    return LegacyCacheEntry(
        namespace=namespace,
        dataset_id=dataset_id,
        dataset_family=LEGACY_DATASET_FAMILY,
        schema_ref=LEGACY_SCHEMA_REF,
        row_count=int(manifest.row_count),
        published_at=_iso_timestamp(manifest.created_at),
        keywords=tuple(manifest.keywords or []),
        directory=dataset_dir,
        manifest=manifest,
    )


def _iso_timestamp(value: str) -> str:
    """Normalize a created_at timestamp to a comparable ISO string.

    Legacy ``created_at`` values are written as ``datetime.now(UTC).isoformat()``
    (``+00:00`` suffix); tolerate older naive values by adding UTC so the
    newest-first sort is stable across record generations.
    """

    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return value
    if parsed.tzinfo is None:
        return parsed.isoformat() + "+00:00"
    return value


def _file_sha256(path: Path, chunk_size: int = 1 << 20) -> str:
    """Chunked sha256 (mirrors the routes helper; bounded memory)."""

    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()
