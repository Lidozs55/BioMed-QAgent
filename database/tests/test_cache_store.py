"""Unit tests for ``database.cache_store.CacheStore`` (Phase 8 schema-neutral).

Covers:
  - commit_dataset writes records/ + manifest.json + index.sqlite3 atomically
  - list_datasets / search_datasets / describe_dataset / get_dataset query paths
  - dataset_id and source_namespace regex validation (path-traversal guard)
  - schema-neutral columns: no global 22-column constant, schema comes from the
    record's own manifest / CSV header
  - old records (manifest without ``columns``) stay readable (read-compatible)
  - empty csv_rows is rejected; missing columns are filled with empty strings
  - re-committing the same (namespace, dataset_id) overwrites the previous data
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from database.cache_store import CacheStore


def _row(**overrides: str) -> dict[str, str]:
    """Build a row with a small fixed schema; tests override select cols."""
    base = {
        "record_id": "",
        "dataset_id": "",
        "sample_id": "",
        "measurement_type": "",
        "expression_value": "",
    }
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
    assert data["column_count"] == 5
    assert data["columns"] == list(_row().keys())
    assert data["created_by_task_id"] == "task-001"
    assert data["source_files"] == ["expr.csv"]
    assert manifest.row_count == 2


def test_commit_dataset_schema_neutral(store: CacheStore) -> None:
    """Any column schema is accepted; schema is recorded in the manifest."""
    rows = [
        {"gene": "TP53", "sample": "S1", "value": "1.5"},
        {"gene": "BRCA1", "sample": "S2", "value": "2.5"},
    ]
    manifest = store.commit_dataset(
        dataset_id="ds_custom",
        source_namespace="user_import",
        topic="custom schema",
        description="arbitrary columns",
        csv_rows=rows,
        created_by_task_id="t1",
    )
    assert manifest.column_count == 3
    assert manifest.columns == ["gene", "sample", "value"]

    result = store.get_dataset("user_import", "ds_custom")
    assert result is not None
    loaded_manifest, loaded_rows = result
    assert loaded_manifest.columns == ["gene", "sample", "value"]
    assert loaded_rows[0] == {"gene": "TP53", "sample": "S1", "value": "1.5"}

    # CSV header is the record's own schema
    csv_text = (
        store.root / "records" / "user_import" / "ds_custom" / "main_data.csv"
    ).read_text(encoding="utf-8-sig")
    assert csv_text.splitlines()[0] == "gene,sample,value"


def test_commit_dataset_explicit_columns(store: CacheStore) -> None:
    """Explicit columns reorder and pad the written rows."""
    manifest = store.commit_dataset(
        dataset_id="ds_cols",
        source_namespace="user_import",
        topic="t",
        description="d",
        csv_rows=[
            {"a": "1", "b": "2", "c": "3"},
            {"a": "4", "c": "6"},
        ],
        created_by_task_id="t1",
        columns=["c", "a", "b"],
    )
    assert manifest.columns == ["c", "a", "b"]
    result = store.get_dataset("user_import", "ds_cols")
    assert result is not None
    _, rows = result
    assert rows[0] == {"c": "3", "a": "1", "b": "2"}
    assert rows[1] == {"c": "6", "a": "4", "b": ""}


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
    assert set(returned_rows[0].keys()) == set(_row().keys())


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
    assert manifest.columns == list(_row().keys())


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

    brca_results = store.search_datasets("BRCA")
    assert len(brca_results) == 1
    assert brca_results[0].dataset_id == "ds1"

    hosp_results = store.search_datasets("Hospital")
    assert len(hosp_results) == 1
    assert hosp_results[0].dataset_id == "ds1"

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
            source_namespace="Bad-Namespace",
            topic="t",
            description="d",
            csv_rows=[_row(record_id="r1", dataset_id="ds1")],
            created_by_task_id="t1",
        )


def test_invalid_dataset_id_rejected(store: CacheStore) -> None:
    with pytest.raises(ValueError, match="dataset_id"):
        store.commit_dataset(
            dataset_id="UPPER.CASE",
            source_namespace="user_import",
            topic="t",
            description="d",
            csv_rows=[_row(record_id="r1", dataset_id="x")],
            created_by_task_id="t1",
        )


def test_invalid_column_names_rejected(store: CacheStore) -> None:
    with pytest.raises(ValueError, match="invalid column name"):
        store.commit_dataset(
            dataset_id="ds1",
            source_namespace="user_import",
            topic="t",
            description="d",
            csv_rows=[{"bad\rcolumn": "value"}],
            created_by_task_id="t1",
        )
    with pytest.raises(ValueError, match="invalid column name"):
        store.commit_dataset(
            dataset_id="ds1",
            source_namespace="user_import",
            topic="t",
            description="d",
            csv_rows=[{"a,b": "value"}],
            created_by_task_id="t1",
        )


def test_duplicate_column_names_rejected(store: CacheStore) -> None:
    with pytest.raises(ValueError, match="column names must be unique"):
        store.commit_dataset(
            dataset_id="ds1",
            source_namespace="user_import",
            topic="t",
            description="d",
            csv_rows=[{"a": "1", "b": "2"}],
            created_by_task_id="t1",
            columns=["a", "a"],
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

    listed = store.list_datasets(source_namespace="user_import")
    assert len(listed) == 1


def test_old_record_without_columns_stays_readable(store: CacheStore) -> None:
    """Phase 8 read-compat: pre-migration records (manifest without
    ``columns``) are served with the schema inferred from the CSV header."""
    dataset_dir = store.root / "records" / "user_import" / "ds_old"
    dataset_dir.mkdir(parents=True)
    (dataset_dir / "main_data.csv").write_text(
        "gene,sample,value\ngeneA,S1,1.0\n", encoding="utf-8-sig",
    )
    (dataset_dir / "manifest.json").write_text(
        json.dumps({
            "dataset_id": "ds_old",
            "source_namespace": "user_import",
            "topic": "legacy record",
            "description": "written before Phase 8",
            "row_count": 1,
            "column_count": 3,
            "created_at": "2026-01-01T00:00:00+00:00",
            "created_by_task_id": "old_task",
            "source_files": [],
            "extra": {},
            "keywords": None,
        }),
        encoding="utf-8",
    )

    result = store.get_dataset("user_import", "ds_old")
    assert result is not None
    manifest, rows = result
    assert manifest.columns == ["gene", "sample", "value"]
    assert rows == [{"gene": "geneA", "sample": "S1", "value": "1.0"}]

    described = store.describe_dataset("user_import", "ds_old")
    assert described is not None
    assert described.columns == ["gene", "sample", "value"]


def test_main_data_csv_uses_utf8_sig_encoding(store: CacheStore) -> None:
    rows = [_row(record_id="r1", dataset_id="ds1", sample_id="Sα001")]
    store.commit_dataset(
        dataset_id="ds1",
        source_namespace="user_import",
        topic="t",
        description="d",
        csv_rows=rows,
        created_by_task_id="t1",
    )

    result = store.get_dataset("user_import", "ds1")
    assert result is not None
    _manifest, returned = result
    assert returned[0]["sample_id"] == "Sα001"


# ── D2: FTS5 + keywords tests ───────────────────────────────────────


def test_commit_dataset_with_keywords_persists_in_manifest(store: CacheStore) -> None:
    rows = [_row(record_id="r1", dataset_id="ds_kw")]
    manifest = store.commit_dataset(
        dataset_id="ds_kw",
        source_namespace="user_import",
        topic="Pharmacogenomics cohort",
        description="Drug response data",
        csv_rows=rows,
        created_by_task_id="t1",
        keywords=["BRCA1", "paclitaxel", "breast cancer", "TP53"],
    )
    assert manifest.keywords == ["BRCA1", "paclitaxel", "breast cancer", "TP53"]

    dataset_dir = store.root / "records" / "user_import" / "ds_kw"
    data = json.loads((dataset_dir / "manifest.json").read_text(encoding="utf-8"))
    assert data["keywords"] == ["BRCA1", "paclitaxel", "breast cancer", "TP53"]

    desc = store.describe_dataset("user_import", "ds_kw")
    assert desc is not None
    assert desc.keywords == ["BRCA1", "paclitaxel", "breast cancer", "TP53"]


def test_commit_dataset_keywords_none_defaults_to_empty(store: CacheStore) -> None:
    rows = [_row(record_id="r1", dataset_id="ds_nokw")]
    manifest = store.commit_dataset(
        dataset_id="ds_nokw",
        source_namespace="user_import",
        topic="t",
        description="d",
        csv_rows=rows,
        created_by_task_id="t1",
    )
    assert manifest.keywords == []


def test_search_datasets_matches_by_keyword(store: CacheStore) -> None:
    rows = [_row(record_id="r1", dataset_id="ds1")]
    store.commit_dataset(
        dataset_id="ds_drug",
        source_namespace="user_import",
        topic="Clinical responses",
        description="Patient outcomes",
        csv_rows=rows,
        created_by_task_id="t1",
        keywords=["imatinib", "CML", "BCR-ABL"],
    )
    store.commit_dataset(
        dataset_id="ds_other",
        source_namespace="user_import",
        topic="Other study",
        description="Unrelated",
        csv_rows=rows,
        created_by_task_id="t1",
        keywords=["BRCA1", "breast cancer"],
    )

    results = store.search_datasets("imatinib")
    assert len(results) == 1
    assert results[0].dataset_id == "ds_drug"

    results = store.search_datasets("CML")
    assert len(results) == 1
    assert results[0].dataset_id == "ds_drug"


def test_search_datasets_fts5_matches_partial_word(store: CacheStore) -> None:
    rows = [_row(record_id="r1", dataset_id="ds1")]
    store.commit_dataset(
        dataset_id="ds_partial",
        source_namespace="user_import",
        topic="Oncology repository",
        description="Cancer data",
        csv_rows=rows,
        created_by_task_id="t1",
        keywords=["pharmacogenomics"],
    )
    results = store.search_datasets("pharma")
    assert any(r.dataset_id == "ds_partial" for r in results)


def test_search_datasets_empty_query_returns_empty(store: CacheStore) -> None:
    rows = [_row(record_id="r1", dataset_id="ds1")]
    store.commit_dataset(
        dataset_id="ds1",
        source_namespace="user_import",
        topic="t",
        description="d",
        csv_rows=rows,
        created_by_task_id="t1",
    )
    assert store.search_datasets("") == []
    assert store.search_datasets("   ") == []


def test_recommit_updates_fts5_index(store: CacheStore) -> None:
    rows = [_row(record_id="r1", dataset_id="ds1")]
    store.commit_dataset(
        dataset_id="ds1",
        source_namespace="user_import",
        topic="original topic",
        description="first desc",
        csv_rows=rows,
        created_by_task_id="t1",
        keywords=["original_kw"],
    )
    store.commit_dataset(
        dataset_id="ds1",
        source_namespace="user_import",
        topic="updated topic",
        description="second desc",
        csv_rows=rows,
        created_by_task_id="t2",
        keywords=["updated_kw"],
    )
    assert store.search_datasets("original_kw") == []
    upd_results = store.search_datasets("updated_kw")
    assert len(upd_results) == 1
    assert upd_results[0].dataset_id == "ds1"


def test_fts5_supports_chinese_query(store: CacheStore) -> None:
    rows = [_row(record_id="r1", dataset_id="ds_cn")]
    store.commit_dataset(
        dataset_id="ds_cn",
        source_namespace="user_import",
        topic="乳腺癌队列",
        description="临床数据",
        csv_rows=rows,
        created_by_task_id="t1",
        keywords=["BRCA1", "乳腺癌", "紫杉醇"],
    )
    results = store.search_datasets("乳腺癌")
    assert len(results) == 1
    assert results[0].dataset_id == "ds_cn"
