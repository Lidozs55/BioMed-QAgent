"""Unit tests for ``commit_to_cache`` function tool.

Covers:
  - Tool parses CSV text into rows and writes to CacheStore via init_cache_store
  - CSV with extra (non-schema) columns is rejected with a helpful message
  - CSV with a subset of the 22 columns is accepted (missing cols filled "")
  - After commit, the dataset is queryable via search_local_cache / get_cache_dataset
  - Tool returns JSON status payload with dataset_id and row_count
  - Errors (uninitialized store, empty CSV) return error strings (not raise)
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.tools import cache_store as cache_store_module
from app.tools.cache_store import (
    CACHE_MAIN_DATA_COLUMNS,
    CacheStore,
    init_cache_store,
)
from app.tools.cache_tools import commit_to_cache


def _make_ctx(run_ctx: RunContext, tool_name: str = "commit_to_cache") -> ToolContext:
    return ToolContext(
        context=run_ctx,
        tool_name=tool_name,
        tool_call_id="test_call_1",
        tool_arguments="{}",
    )


def _call(tool, ctx: ToolContext, **kwargs: Any) -> str:
    return asyncio.run(tool.on_invoke_tool(ctx, json.dumps(kwargs)))


@pytest.fixture
def initialized_store(tmp_path: Path) -> CacheStore:
    """Initialize the global CacheStore singleton pointing at tmp_path."""
    store = init_cache_store(tmp_path / "cache")
    yield store
    # Reset the global so other tests start clean.
    cache_store_module._global_store = None


def test_commit_to_cache_writes_dataset_and_returns_status(
    initialized_store: CacheStore,
) -> None:
    rc = RunContext(task_id="task_import_001")
    ctx = _make_ctx(rc)

    # CSV with 22-column subset
    csv_text = (
        "record_id,dataset_id,sample_id,measurement_type,expression_value\n"
        "r1,ds_test,S001,expression,12.4\n"
        "r2,ds_test,S002,expression,8.7\n"
    )
    result = _call(
        ctx=ctx,
        tool=commit_to_cache,
        csv_content=csv_text,
        dataset_id="ds_test",
        topic="Test expression",
        description="A small test dataset",
        source_files="samples.csv",
    )

    payload = json.loads(result)
    assert payload["status"] == "ok"
    assert payload["dataset_id"] == "ds_test"
    assert payload["source_namespace"] == "user_import"
    assert payload["row_count"] == 2
    assert payload["column_count"] == len(CACHE_MAIN_DATA_COLUMNS)
    assert payload["created_by_task_id"] == "task_import_001"

    # Verify the dataset is queryable directly via the store.
    manifest, rows = initialized_store.get_dataset("user_import", "ds_test")
    assert manifest is not None
    assert len(rows) == 2
    assert rows[0]["record_id"] == "r1"
    assert rows[0]["sample_id"] == "S001"
    assert rows[0]["expression_value"] == "12.4"
    # Missing columns were filled with ""
    assert rows[0]["gene_id"] == ""
    assert rows[0]["source_column_name"] == ""


def test_commit_to_cache_rejects_extra_columns(
    initialized_store: CacheStore,
) -> None:
    rc = RunContext(task_id="t1")
    ctx = _make_ctx(rc)

    csv_text = (
        "record_id,dataset_id,custom_extra_col\n"
        "r1,ds1,foo\n"
    )
    result = _call(
        ctx=ctx,
        tool=commit_to_cache,
        csv_content=csv_text,
        dataset_id="ds1",
        topic="t",
        description="d",
        source_files="",
    )

    assert "CSV 解析失败" in result
    assert "custom_extra_col" in result


def test_commit_to_cache_rejects_empty_csv(
    initialized_store: CacheStore,
) -> None:
    rc = RunContext(task_id="t1")
    ctx = _make_ctx(rc)

    # Only header, no data rows
    csv_text = "record_id,dataset_id\n"
    result = _call(
        ctx=ctx,
        tool=commit_to_cache,
        csv_content=csv_text,
        dataset_id="ds1",
        topic="t",
        description="d",
    )

    assert "CSV 解析失败" in result
    assert "为空" in result


def test_commit_to_cache_rejects_invalid_dataset_id(
    initialized_store: CacheStore,
) -> None:
    rc = RunContext(task_id="t1")
    ctx = _make_ctx(rc)

    csv_text = "record_id,dataset_id\nr1,ds1\n"
    result = _call(
        ctx=ctx,
        tool=commit_to_cache,
        csv_content=csv_text,
        # Uppercase + dot — invalid per ^[a-z0-9][a-z0-9_-]*$
        dataset_id="Bad.ID",
        topic="t",
        description="d",
    )

    assert "缓存写入失败" in result
    assert "dataset_id" in result


def test_commit_to_cache_returns_error_when_store_uninitialized() -> None:
    """When CacheStore is not initialized, tool returns a clear error string."""
    # Ensure the global is cleared (other fixtures may have set it).
    original = cache_store_module._global_store
    cache_store_module._global_store = None
    try:
        rc = RunContext(task_id="t1")
        ctx = _make_ctx(rc)
        csv_text = "record_id,dataset_id\nr1,ds1\n"
        result = _call(
            ctx=ctx,
            tool=commit_to_cache,
            csv_content=csv_text,
            dataset_id="ds1",
            topic="t",
            description="d",
        )
        assert "本地缓存未初始化" in result
    finally:
        cache_store_module._global_store = original


def test_commit_to_cache_records_source_files_csv(
    initialized_store: CacheStore,
) -> None:
    rc = RunContext(task_id="t1")
    ctx = _make_ctx(rc)

    csv_text = (
        "record_id,dataset_id\nr1,ds_clinical\nr2,ds_clinical\n"
    )
    result = _call(
        ctx=ctx,
        tool=commit_to_cache,
        csv_content=csv_text,
        dataset_id="ds_clinical",
        topic="clinical",
        description="clinical data",
        source_files="patients.csv,meta.json",
    )

    payload = json.loads(result)
    assert payload["status"] == "ok"

    manifest = initialized_store.describe_dataset("user_import", "ds_clinical")
    assert manifest is not None
    assert manifest.source_files == ["patients.csv", "meta.json"]
