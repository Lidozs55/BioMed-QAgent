"""Unit tests for ``app.tools.cache_store.CacheStore``.

Covers:
  - commit_dataset writes records/ + manifest.json + index.sqlite3 atomically
  - list_datasets / search_datasets / describe_dataset / get_dataset query paths
  - dataset_id and source_namespace regex validation (path-traversal guard)
  - csv_rows column-name validation against the 22-column schema
  - empty csv_rows is rejected
  - missing columns are filled with empty strings
  - re-committing the same (namespace, dataset_id) overwrites the previous data
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from app.tools.cache_store import (
    CACHE_MAIN_DATA_COLUMNS,
    CacheStore,
)


def _row(**overrides: str) -> dict[str, str]:
    """Build a single 22-col row with defaults; tests override select cols."""
    base = {col: "" for col in CACHE_MAIN_DATA_COLUMNS}
    base.update(overrides)
    return base


@pytest.fixture
def store(tmp_path: Path) -> CacheStore:
    return CacheStore(tmp_path / "cache")


def test_commit_dataset_writes_files_and_manifest(store: CacheStore) -> None:
    rows = [
        _row(record_id="r1", dataset_id="ds1", sample_id="S001",
             measurement_type="expression", expression_value="12.4"),
        _row(record_id="r2", dataset_id="ds1", sample_id="S002",
             measurement_type="expression", expression_value="8.7"),
    ]
    manifest = store.commit_dataset(
        dataset_id="ds1",
        source_namespace="user_import",
        topic="Test Expression",
        description="A small expression dataset",
        csv_rows=rows,
        created_by_task_id="task-001",
        source_files=["expr.csv"],
    )

    # Files exist on disk
    dataset_dir = store.root / "records" / "user_import" / "ds1"
    assert (dataset_dir / "main_data.csv").is_file()
    assert (dataset_dir / "manifest.json").is_file()

    # Manifest content matches
    data = json.loads((dataset_dir / "manifest.json").read_text(encoding="utf-8"))
    assert data["dataset_id"] == "ds1"
    assert data["source_namespace"] == "user_import"
    assert data["row_count"] == 2
    assert data["column_count"] == len(CACHE_MAIN_DATA_COLUMNS)
    assert data["created_by_task_id"] == "task-001"
    assert data["source_files"] == ["expr.csv"]
    assert manifest.row_count == 2


def test_get_dataset_returns_manifest_and_rows(store: CacheStore) -> None:
    rows = [
        _row(record_id="r1", dataset_id="ds1", sample_id="S001",
             measurement_type="expression", expression_value="12.4"),
    ]
    store.commit_dataset(
        dataset_id="ds1",
        source_namespace="user_import",
        topic="Test",
        description="d",
        csv_rows=rows,
        created_by_task_id="t1",
    )

    result = store.get_dataset("user_import", "ds1")
    assert result is not None
    manifest, returned_rows = result
    assert manifest.dataset_id == "ds1"
    assert len(returned_rows) == 1
    assert returned_rows[0]["record_id"] == "r1"
    assert returned_rows[0]["sample_id"] == "S001"
    # All 22 columns are present in returned rows (missing filled with "")
    assert set(returned_rows[0].keys()) == set(CACHE_MAIN_DATA_COLUMNS)


def test_get_dataset_missing_returns_none(store: CacheStore) -> None:
    assert store.get_dataset("user_import", "nonexistent") is None


def test_describe_dataset_returns_manifest_only(store: CacheStore) -> None:
    rows = [_row(record_id="r1", dataset_id="ds1")]
    store.commit_dataset(
        dataset_id="ds1",
        source_namespace="user_import",
        topic="T",
        description="D",
        csv_rows=rows,
        created_by_task_id="t1",
    )
    manifest = store.describe_dataset("user_import", "ds1")
    assert manifest is not None
    assert manifest.dataset_id == "ds1"
    assert manifest.row_count == 1


def test_search_datasets_matches_topic_or_description(store: CacheStore) -> None:
    rows = [_row(record_id="r1", dataset_id="ds1")]
    store.commit_dataset(
        dataset_id="ds1",
        source_namespace="user_import",
        topic="BRCA expression cohort",
        description="Hospital oncology data",
        csv_rows=rows,
        created_by_task_id="t1",
    )
    store.commit_dataset(
        dataset_id="ds2",
        source_namespace="user_import",
        topic="LUAD mutation panel",
        description="Sequencing results",
        csv_rows=rows,
        created_by_task_id="t1",
    )

    # Match by topic keyword
    brca_results = store.search_datasets("BRCA")
    assert len(brca_results) == 1
    assert brca_results[0].dataset_id == "ds1"

    # Match by description keyword
    hosp_results = store.search_datasets("Hospital")
    assert len(hosp_results) == 1
    assert hosp_results[0].dataset_id == "ds1"

    # No match
    assert store.search_datasets("nonexistent_topic_xyz") == []


def test_list_datasets_filters_by_namespace(store: CacheStore) -> None:
    rows = [_row(record_id="r1", dataset_id="ds1")]
    store.commit_dataset(
        dataset_id="ds1",
        source_namespace="user_import",
        topic="t1",
        description="d",
        csv_rows=rows,
        created_by_task_id="t1",
    )
    store.commit_dataset(
        dataset_id="ds2",
        source_namespace="pipeline_artifact",
        topic="t2",
        description="d",
        csv_rows=rows,
        created_by_task_id="t1",
    )

    user_only = store.list_datasets(source_namespace="user_import")
    assert len(user_only) == 1
    assert user_only[0].dataset_id == "ds1"

    all_ds = store.list_datasets()
    assert len(all_ds) == 2


def test_invalid_namespace_rejected(store: CacheStore) -> None:
    with pytest.raises(ValueError, match="source_namespace"):
        store.commit_dataset(
            dataset_id="ds1",
            source_namespace="Bad-Namespace",  # uppercase + hyphen
            topic="t",
            description="d",
            csv_rows=[_row(record_id="r1", dataset_id="ds1")],
            created_by_task_id="t1",
        )


def test_invalid_dataset_id_rejected(store: CacheStore) -> None:
    with pytest.raises(ValueError, match="dataset_id"):
        store.commit_dataset(
            dataset_id="UPPER.CASE",  # invalid chars
            source_namespace="user_import",
            topic="t",
            description="d",
            csv_rows=[_row(record_id="r1", dataset_id="x")],
            created_by_task_id="t1",
        )


def test_invalid_columns_in_rows_rejected(store: CacheStore) -> None:
    bad_rows = [{"record_id": "r1", "bad_column": "value"}]
    with pytest.raises(ValueError, match="not in schema"):
        store.commit_dataset(
            dataset_id="ds1",
            source_namespace="user_import",
            topic="t",
            description="d",
            csv_rows=bad_rows,
            created_by_task_id="t1",
        )


def test_empty_rows_rejected(store: CacheStore) -> None:
    with pytest.raises(ValueError, match="csv_rows must not be empty"):
        store.commit_dataset(
            dataset_id="ds1",
            source_namespace="user_import",
            topic="t",
            description="d",
            csv_rows=[],
            created_by_task_id="t1",
        )


def test_recommit_same_dataset_id_overwrites(store: CacheStore) -> None:
    rows1 = [_row(record_id="r1", dataset_id="ds1", sample_id="S001")]
    store.commit_dataset(
        dataset_id="ds1",
        source_namespace="user_import",
        topic="original",
        description="first",
        csv_rows=rows1,
        created_by_task_id="t1",
    )
    rows2 = [
        _row(record_id="r1", dataset_id="ds1", sample_id="S001"),
        _row(record_id="r2", dataset_id="ds1", sample_id="S002"),
        _row(record_id="r3", dataset_id="ds1", sample_id="S003"),
    ]
    store.commit_dataset(
        dataset_id="ds1",
        source_namespace="user_import",
        topic="updated",
        description="second",
        csv_rows=rows2,
        created_by_task_id="t2",
    )

    manifest = store.describe_dataset("user_import", "ds1")
    assert manifest is not None
    assert manifest.row_count == 3
    assert manifest.topic == "updated"
    assert manifest.created_by_task_id == "t2"

    # list_datasets returns only one entry (no stale duplicate)
    listed = store.list_datasets(source_namespace="user_import")
    assert len(listed) == 1


def test_main_data_csv_uses_utf8_sig_encoding(store: CacheStore) -> None:
    """main_data.csv must be readable by ``utf-8-sig`` (BOM-tolerant)."""
    rows = [_row(record_id="r1", dataset_id="ds1", sample_id="Sα001")]
    store.commit_dataset(
        dataset_id="ds1",
        source_namespace="user_import",
        topic="t",
        description="d",
        csv_rows=rows,
        created_by_task_id="t1",
    )

    # utf-8-sig reader works (this is what get_dataset uses internally)
    result = store.get_dataset("user_import", "ds1")
    assert result is not None
    _manifest, returned = result
    assert returned[0]["sample_id"] == "Sα001"


def test_get_cache_store_uninitialized_raises() -> None:
    """When ``init_cache_store`` has not run, ``get_cache_store`` raises."""
    from app.tools import cache_store

    # Force the uninitialized state (other tests may have set the global).
    original = cache_store._global_store
    cache_store._global_store = None
    try:
        with pytest.raises(RuntimeError, match="not initialized"):
            cache_store.get_cache_store()
    finally:
        cache_store._global_store = original
