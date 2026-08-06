import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from app.agent_loop.context import RunContext
from app.domain.contracts import DataLevel, QueryStatus
from app.tools.crawler import CrawlerFacade


def test_run_context_preserves_positional_task_id_and_topic(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.chdir(tmp_path)

    context = RunContext("task_positional_topic", "oncology")

    assert context.task_id == "task_positional_topic"
    assert context.topic == "oncology"


def test_managed_run_context_reserves_pipeline_publication_exclusively(
    tmp_path: Path,
) -> None:
    standalone = RunContext(task_id="task_standalone", base_dir=tmp_path)
    managed = RunContext(
        task_id="task_managed",
        base_dir=tmp_path,
        managed_run_id="run_authoritative",
    )

    assert standalone.reserve_pipeline_publication() is None
    assert managed.reserve_pipeline_publication() == "run_authoritative"
    with pytest.raises(RuntimeError, match="already reserved"):
        managed.reserve_pipeline_publication()

    managed.release_pipeline_publication_reservation()

    assert managed.reserve_pipeline_publication() == "run_authoritative"


def test_managed_run_context_transfers_pending_publication_once(
    tmp_path: Path,
) -> None:
    context = RunContext(
        task_id="task_pending",
        base_dir=tmp_path,
        managed_run_id="run_pending",
    )
    handle = SimpleNamespace(run_id="run_pending")
    context.reserve_pipeline_publication()

    context.set_pending_publication(handle)

    with pytest.raises(RuntimeError, match="already reserved"):
        context.reserve_pipeline_publication()
    assert context.take_pending_publication() is handle
    assert context.take_pending_publication() is None


def test_crawler_facade_binding_is_trusted_and_exactly_once(tmp_path: Path) -> None:
    context = RunContext(task_id="task_crawler", base_dir=tmp_path)
    facade = Mock(spec=CrawlerFacade)

    with pytest.raises(RuntimeError, match="not available"):
        _ = context.crawler_facade

    context.bind_crawler_facade(facade)

    assert context.crawler_facade is facade
    with pytest.raises(RuntimeError, match="already bound"):
        context.bind_crawler_facade(Mock(spec=CrawlerFacade))


def test_child_context_owns_staging_root_and_collects_bounded_metadata(
    tmp_path: Path,
) -> None:
    parent = RunContext(task_id="parent", base_dir=tmp_path)

    child = parent.create_child_context("child-one")

    assert child.work_dir.root == parent.work_dir.staging / "subagents" / "child-one"
    assert child.work_dir.root != parent.work_dir.root
    child.record_source_asset_id("asset_sha256")
    child.record_recipe("recipe-one")
    child.record_warning("child warning")

    assert child.source_asset_ids == ["asset_sha256"]
    assert child.recipe_id == "recipe-one"
    assert child.child_warnings == ["child warning"]


def test_child_source_asset_helper_commits_to_task_source_assets(
    tmp_path: Path,
) -> None:
    parent = RunContext(task_id="parent_asset", base_dir=tmp_path)
    child = parent.create_child_context("child-one")

    asset = child.stage_source_asset(
        content=b"child bytes",
        filename="data.tsv",
        source_id="source-child",
        successful_attempt_id="attempt-child",
        data_level=DataLevel.METADATA,
        media_type="text/tab-separated-values",
    )

    assert child.source_asset_path(asset) == parent.work_dir.root / asset.relative_path
    assert child.source_asset_path(asset).read_bytes() == b"child bytes"
    assert child.source_asset_ids == [asset.asset_id]
    assert asset.relative_path.startswith("source_assets/")


def test_log_query_persists_durable_agent_results_query_log(
    tmp_path: Path,
) -> None:
    context = RunContext(task_id="task_agent_results", base_dir=tmp_path)
    context.log_query("cancer[title]", "pubmed", QueryStatus.SUCCESS, 5)
    context.log_query("pdac", "geo", QueryStatus.NOT_FOUND, 0)

    log_path = context.work_dir.agent_results / "query_log.jsonl"
    assert log_path.is_file()
    records = [
        json.loads(line)
        for line in log_path.read_text(encoding="utf-8").splitlines()
    ]
    assert records == context.query_log
    assert records == [
        {
            "query": "cancer[title]",
            "source": "pubmed",
            "status": "success",
            "records_count": 5,
        },
        {
            "query": "pdac",
            "source": "geo",
            "status": "not_found",
            "records_count": 0,
        },
    ]


def test_compress_log_keeps_full_durable_query_log(tmp_path: Path) -> None:
    context = RunContext(task_id="task_compressed", base_dir=tmp_path)
    for index in range(5):
        context.log_query(f"query-{index}", "pubmed", QueryStatus.SUCCESS, index)

    compressed = context.compress_log(keep_recent=2, summary="older queries summarized")

    assert compressed == 3
    assert len(context.query_log) == 2  # in-memory log is compressed
    log_path = context.work_dir.agent_results / "query_log.jsonl"
    records = [
        json.loads(line)
        for line in log_path.read_text(encoding="utf-8").splitlines()
    ]
    assert len(records) == 5  # durable audit keeps the full history
    assert [record["query"] for record in records] == [
        "query-0",
        "query-1",
        "query-2",
        "query-3",
        "query-4",
    ]
