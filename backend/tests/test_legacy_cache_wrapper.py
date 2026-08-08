"""Legacy main_data.csv cache wrapper tests (Phase 7 T2).

The OLD 22-column cache (``cache/records/<namespace>/<dataset_id>/``,
written by ``CacheStore``) must be readable through the new V2 cache API as
schema ``gene_expression.long.legacy.v1``. This module tests the small
read-side projection (``app/datasets/build/legacy_cache.py``) that adapts
legacy records onto the new cache entry shape.
"""

from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path

from app.datasets.build.legacy_cache import (
    LEGACY_DATASET_FAMILY,
    LEGACY_SCHEMA_REF,
    find_legacy,
    find_legacy_global,
    legacy_artifacts,
    list_legacy,
)
from app.datasets.schema_registry import build_gene_expression_schema
from app.domain.contracts.dataset_state import ArtifactRole
from app.tools.cache_store import CACHE_MAIN_DATA_COLUMNS

_LEGACY_ROW = {
    "record_id": "row_1",
    "dataset_id": "dataset_legacy_a",
    "source_id": "src_gdc",
    "asset_id": "asset_1",
    "gene_id_raw": "TP53",
    "gene_id": "ENSG00000141510",
    "gene_id_namespace": "ensembl_gene",
    "gene_id_version": "GRCh38",
    "sample_id": "TCGA-01",
    "source_sample_alias": "TCGA-01",
    "measurement_type": "rna_expression",
    "value_semantics": "expression_value",
    "value_scale": "log2",
    "is_normalized": "true",
    "is_integer_expected": "false",
    "expression_value": "3.5",
    "expression_unit": "log2_expression",
    "source_logical_file": "gdc_expression.tsv",
    "source_line_number": "42",
    "source_column_index": "3",
    "source_column_name": "TP53",
    "source_raw_value": "11.31",
}


def _write_legacy_dataset(
    root: Path,
    *,
    namespace: str,
    dataset_id: str,
    rows: list[dict[str, str]] | None = None,
    topic: str = "TP53 expression",
    keywords: list[str] | None = None,
    created_at: str = "2026-07-14T10:00:00+00:00",
) -> Path:
    """Write one legacy CacheStore-format dataset under ``root/records/``."""
    dataset_dir = root / "records" / namespace / dataset_id
    dataset_dir.mkdir(parents=True)
    rows = rows or [_LEGACY_ROW]
    with (dataset_dir / "main_data.csv").open(
        "w", encoding="utf-8-sig", newline=""
    ) as handle:
        writer = csv.DictWriter(handle, fieldnames=list(CACHE_MAIN_DATA_COLUMNS))
        writer.writeheader()
        for row in rows:
            writer.writerow({col: row.get(col, "") for col in CACHE_MAIN_DATA_COLUMNS})
    (dataset_dir / "manifest.json").write_text(
        json.dumps(
            {
                "dataset_id": dataset_id,
                "source_namespace": namespace,
                "topic": topic,
                "description": "legacy cached dataset",
                "row_count": len(rows),
                "column_count": len(CACHE_MAIN_DATA_COLUMNS),
                "created_at": created_at,
                "created_by_task_id": "task_legacy",
                "source_files": ["gdc_expression.tsv"],
                "extra": {},
                "keywords": keywords or [],
            },
            ensure_ascii=False,
            indent=2,
        ),
        "utf-8",
    )
    return dataset_dir


def test_legacy_columns_are_exactly_the_long_v1_schema_fields() -> None:
    """The projection is field-identical: the 22 legacy columns ARE the
    ``gene_expression.long.v1`` field list, so serving them under the legacy
    schema ref is a faithful shape match, not a re-mapping."""
    schema = build_gene_expression_schema()
    assert [field.name for field in schema.fields] == list(CACHE_MAIN_DATA_COLUMNS)


def test_list_legacy_projects_entries_onto_long_legacy_schema(
    tmp_path: Path,
) -> None:
    _write_legacy_dataset(tmp_path, namespace="user_import", dataset_id="dataset_a")
    _write_legacy_dataset(tmp_path, namespace="pubmed", dataset_id="dataset_b")

    entries = list_legacy(tmp_path)

    assert [entry.dataset_id for entry in entries] == ["dataset_b", "dataset_a"]
    first = entries[1]
    assert first.namespace == "user_import"
    assert first.schema_ref == LEGACY_SCHEMA_REF
    assert first.dataset_family == LEGACY_DATASET_FAMILY
    assert first.row_count == 1
    assert first.published_at == "2026-07-14T10:00:00+00:00"
    assert first.keywords == ()
    assert first.directory == tmp_path / "records" / "user_import" / "dataset_a"


def test_list_legacy_namespace_filter_and_keywords(tmp_path: Path) -> None:
    _write_legacy_dataset(
        tmp_path,
        namespace="user_import",
        dataset_id="dataset_a",
        keywords=["TP53", "expression"],
    )
    _write_legacy_dataset(tmp_path, namespace="pubmed", dataset_id="dataset_b")

    only_user = list_legacy(tmp_path, namespace="user_import")
    assert [entry.dataset_id for entry in only_user] == ["dataset_a"]
    assert only_user[0].keywords == ("TP53", "expression")
    assert list_legacy(tmp_path, namespace="nope") == []
    assert list_legacy(tmp_path / "missing") == []


def test_find_legacy_and_global_find(tmp_path: Path) -> None:
    _write_legacy_dataset(tmp_path, namespace="user_import", dataset_id="dataset_a")

    found = find_legacy(tmp_path, "user_import", "dataset_a")
    assert found is not None
    assert found.manifest.dataset_id == "dataset_a"
    assert find_legacy(tmp_path, "user_import", "missing") is None
    assert find_legacy(tmp_path, "other", "dataset_a") is None

    global_found = find_legacy_global(tmp_path, "dataset_a")
    assert global_found is not None
    assert global_found.namespace == "user_import"
    assert find_legacy_global(tmp_path, "missing") is None


def test_find_legacy_rejects_unsafe_ids(tmp_path: Path) -> None:
    _write_legacy_dataset(tmp_path, namespace="user_import", dataset_id="dataset_a")
    assert find_legacy(tmp_path, "../escape", "dataset_a") is None
    assert find_legacy(tmp_path, "user_import", "../escape") is None
    assert find_legacy_global(tmp_path, "../escape") is None


def test_legacy_artifacts_declare_main_data_and_manifest(tmp_path: Path) -> None:
    dataset_dir = _write_legacy_dataset(
        tmp_path, namespace="user_import", dataset_id="dataset_a"
    )
    entry = find_legacy(tmp_path, "user_import", "dataset_a")
    assert entry is not None

    artifacts = legacy_artifacts(entry)
    assert [a.artifact_id for a in artifacts] == ["main_data", "manifest"]
    main_data, manifest = artifacts
    assert main_data.role is ArtifactRole.PRIMARY_DATASET
    assert main_data.relative_path == "main_data.csv"
    assert main_data.size_bytes == (dataset_dir / "main_data.csv").stat().st_size
    assert main_data.sha256 == hashlib.sha256(
        (dataset_dir / "main_data.csv").read_bytes()
    ).hexdigest()
    assert manifest.role is ArtifactRole.SCHEMA
    assert manifest.relative_path == "manifest.json"
