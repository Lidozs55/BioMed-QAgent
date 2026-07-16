from pathlib import Path

import pytest
from app.agent_loop.context import RunContext


def test_run_context_preserves_positional_task_id_and_topic(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.chdir(tmp_path)

    context = RunContext("task_positional_topic", "oncology")

    assert context.task_id == "task_positional_topic"
    assert context.topic == "oncology"
