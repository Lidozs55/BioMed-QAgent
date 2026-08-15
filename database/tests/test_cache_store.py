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


# ---------------------------------------------------------------------------
# Fault injection: commit_dataset must roll back to a fully readable previous
# state when any rename in the two-file publish sequence fails, and must
# recover leftover .bak snapshots left by a crashed commit.
# ---------------------------------------------------------------------------


def _commit(store: CacheStore, *, topic: str, task: str, rows: list[dict[str, str]]) -> None:
    store.commit_dataset(
        dataset_id="ds1",
        source_namespace="user_import",
        topic=topic,
        description="desc",
        csv_rows=rows,
        created_by_task_id=task,
    )


def _ds_dir(store: CacheStore) -> Path:
    return store.root / "records" / "user_import" / "ds1"


def _fail_on_nth_replace(monkeypatch: pytest.MonkeyPatch, fail_at: int) -> None:
    """Monkeypatch os.replace to raise OSError on the ``fail_at``-th call.

    commit_dataset's replace sequence for an update is:
      1 snapshot main_data.csv, 2 snapshot manifest.json,
      3 publish main_data.csv,  4 publish manifest.json.
    """
    import os

    real_replace = os.replace
    counter = {"n": 0}

    def flaky_replace(src: str, dst: str) -> None:
        counter["n"] += 1
        if counter["n"] == fail_at:
            raise OSError(f"injected failure on replace #{counter['n']}: {src} -> {dst}")
        return real_replace(src, dst)

    monkeypatch.setattr("database.cache_store.os.replace", flaky_replace)


def test_commit_update_failure_after_manifest_publish_rolls_back(
    store: CacheStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Publish CSV 成功 → 发布 manifest 故意失败 → 旧 dataset 仍完整可读。"""
    _commit(store, topic="old", task="t1", rows=[_row(record_id="r1", dataset_id="ds1")])
    _fail_on_nth_replace(monkeypatch, fail_at=4)

    with pytest.raises(OSError, match="injected failure"):
        _commit(
            store,
            topic="new",
            task="t2",
            rows=[
                _row(record_id="r1", dataset_id="ds1"),
                _row(record_id="r2", dataset_id="ds1"),
                _row(record_id="r3", dataset_id="ds1"),
            ],
        )

    # 旧 dataset 完整可读：manifest 与 CSV 都还是第一版
    result = store.get_dataset("user_import", "ds1")
    assert result is not None
    manifest, rows = result
    assert manifest.topic == "old"
    assert manifest.created_by_task_id == "t1"
    assert len(rows) == 1

    # 无 .tmp / .bak 残留
    assert sorted(p.name for p in _ds_dir(store).iterdir()) == [
        "main_data.csv",
        "manifest.json",
    ]


def test_commit_new_dataset_failure_at_csv_publish_leaves_nothing(
    store: CacheStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """新 dataset：CSV 发布（第 1 次 replace）失败 → 目录里不留任何半成品。"""
    _fail_on_nth_replace(monkeypatch, fail_at=1)
    with pytest.raises(OSError, match="injected failure"):
        _commit(store, topic="new", task="t1", rows=[_row(record_id="r1", dataset_id="ds1")])

    assert list(_ds_dir(store).iterdir()) == []
    assert store.get_dataset("user_import", "ds1") is None


def test_commit_new_dataset_failure_at_manifest_publish_removes_csv(
    store: CacheStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """新 dataset：manifest 发布（第 2 次 replace）失败 → 已发布的 CSV 被回滚删除。"""
    _fail_on_nth_replace(monkeypatch, fail_at=2)
    with pytest.raises(OSError, match="injected failure"):
        _commit(store, topic="new", task="t1", rows=[_row(record_id="r1", dataset_id="ds1")])

    assert list(_ds_dir(store).iterdir()) == []
    assert store.get_dataset("user_import", "ds1") is None


def test_commit_update_failure_at_csv_snapshot_keeps_old_state(
    store: CacheStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """既有 dataset：快照阶段（第 1 次 replace）失败 → 旧状态原封不动。"""
    _commit(store, topic="old", task="t1", rows=[_row(record_id="r1", dataset_id="ds1")])
    _fail_on_nth_replace(monkeypatch, fail_at=1)
    with pytest.raises(OSError, match="injected failure"):
        _commit(store, topic="new", task="t2", rows=[_row(record_id="r2", dataset_id="ds1")])

    result = store.get_dataset("user_import", "ds1")
    assert result is not None
    manifest, rows = result
    assert manifest.topic == "old"
    assert len(rows) == 1
    assert rows[0]["record_id"] == "r1"


def test_commit_recovers_crash_between_snapshot_renames_keeps_old_state(
    store: CacheStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """崩溃窗口：CSV 已快照、manifest 尚未快照（两次快照重命名之间）。

    模拟：
        os.replace(main_data.csv, main_data.csv.bak) 成功 → 进程崩溃。
    状态：csv.bak 存在、CSV 缺失、manifest.json（旧）存在、json.bak 缺失。

    下次 commit 的 recovery 必须把唯一旧 CSV 副本**还原**而不是删除；
    若随后写盘失败，旧 dataset 仍须完整可读（否则数据永久丢失）。
    """
    import os as _os

    _commit(store, topic="old", task="t1", rows=[_row(record_id="r1", dataset_id="ds1")])
    d = _ds_dir(store)

    # 崩溃点：第一次快照重命名完成，第二次（manifest）未执行
    _os.replace(d / "main_data.csv", d / "main_data.csv.bak")
    assert not (d / "main_data.csv").exists()
    assert (d / "main_data.csv.bak").exists()
    assert (d / "manifest.json").exists()
    assert not (d / "manifest.json.bak").exists()

    # 下次 commit：recovery 先执行；随后写 .tmp 失败 → 回滚后旧数据必须可读。
    def fail_write(*_args: object, **_kwargs: object) -> None:
        raise OSError("injected write failure")

    monkeypatch.setattr(
        "database.cache_store.CacheStore._write_main_data", fail_write
    )
    with pytest.raises(OSError, match="injected write failure"):
        _commit(store, topic="new", task="t2", rows=[_row(record_id="r2", dataset_id="ds1")])

    result = store.get_dataset("user_import", "ds1")
    assert result is not None
    manifest, rows = result
    assert manifest.topic == "old"
    assert manifest.created_by_task_id == "t1"
    assert len(rows) == 1
    assert rows[0]["record_id"] == "r1"
    assert sorted(p.name for p in d.iterdir()) == [
        "main_data.csv",
        "manifest.json",
    ]


def test_commit_recovers_crash_between_snapshot_renames_then_publishes(
    store: CacheStore,
) -> None:
    """同一崩溃窗口，但下次 commit 成功：recovery 还原旧 CSV 后正常发布新版本。"""
    import os as _os

    _commit(store, topic="old", task="t1", rows=[_row(record_id="r1", dataset_id="ds1")])
    d = _ds_dir(store)

    _os.replace(d / "main_data.csv", d / "main_data.csv.bak")
    assert not (d / "main_data.csv").exists()

    _commit(store, topic="new", task="t2", rows=[_row(record_id="r2", dataset_id="ds1")])

    result = store.get_dataset("user_import", "ds1")
    assert result is not None
    manifest, rows = result
    assert manifest.topic == "new"
    assert rows[0]["record_id"] == "r2"
    assert sorted(p.name for p in d.iterdir()) == [
        "main_data.csv",
        "manifest.json",
    ]


def test_commit_recovers_leftover_backups_before_publish(
    store: CacheStore,
) -> None:
    """崩溃恢复：遗留 .bak（快照已取、发布未完成）→ 下次 commit 先还原旧状态再发布。"""
    _commit(store, topic="old", task="t1", rows=[_row(record_id="r1", dataset_id="ds1")])

    # 模拟崩溃点：快照已取走，两个最终文件都还不在（发布未开始）
    d = _ds_dir(store)
    import os as _os

    _os.replace(d / "main_data.csv", d / "main_data.csv.bak")
    _os.replace(d / "manifest.json", d / "manifest.json.bak")
    assert not (d / "main_data.csv").exists()

    _commit(store, topic="new", task="t2", rows=[_row(record_id="r2", dataset_id="ds1")])

    result = store.get_dataset("user_import", "ds1")
    assert result is not None
    manifest, rows = result
    assert manifest.topic == "new"
    assert rows[0]["record_id"] == "r2"
    assert sorted(p.name for p in d.iterdir()) == ["main_data.csv", "manifest.json"]


def test_commit_cleans_leftover_backups_after_completed_publish(
    store: CacheStore,
) -> None:
    """崩溃恢复：遗留 .bak 但最终文件已发布（越过 commit point）→ 只清理不还原。"""
    _commit(store, topic="old", task="t1", rows=[_row(record_id="r1", dataset_id="ds1")])

    # 模拟崩溃点：发布完成但快照清理未执行（快照是副本，最终文件也已就位）
    d = _ds_dir(store)
    import shutil as _shutil

    _shutil.copy2(d / "main_data.csv", d / "main_data.csv.bak")
    _shutil.copy2(d / "manifest.json", d / "manifest.json.bak")
    # 此刻：最终文件就位（发布完成），快照仍在（清理未执行）
    assert (d / "main_data.csv.bak").exists()

    _commit(store, topic="new", task="t2", rows=[_row(record_id="r2", dataset_id="ds1")])

    result = store.get_dataset("user_import", "ds1")
    assert result is not None
    manifest, rows = result
    assert manifest.topic == "new"
    assert rows[0]["record_id"] == "r2"
    assert sorted(p.name for p in d.iterdir()) == ["main_data.csv", "manifest.json"]
