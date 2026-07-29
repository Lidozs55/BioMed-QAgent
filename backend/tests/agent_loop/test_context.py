from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from app.agent_loop.context import RunContext
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
