from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

import app.agent_loop.runner as runner_module
from app.pipeline.pinned_case import run_pinned_fixture


FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"


@pytest.mark.asyncio
async def test_runner_emits_manifest_artifact_ids_before_done(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    output_dir = tmp_path / "output"
    manifest = run_pinned_fixture(
        task_id="task_runner_artifacts",
        base_dir=output_dir / "tasks",
        fixture_dir=FIXTURE_DIR,
    )

    class FakeResult:
        final_output = "complete"

        async def stream_events(self):
            if False:
                yield None

    monkeypatch.setattr(runner_module, "require_model_credentials", lambda: None)
    monkeypatch.setattr(runner_module, "create_agent", lambda databases=None: object())
    monkeypatch.setattr(runner_module, "get_loaded_skill_names", lambda: [])
    monkeypatch.setattr(
        runner_module.Runner, "run_streamed", lambda *a, **k: FakeResult()
    )
    monkeypatch.setattr(
        runner_module, "settings", SimpleNamespace(output_dir=str(output_dir))
    )

    events = [
        event
        async for event in runner_module.run_agent_stream(
            "test", "task_runner_artifacts", databases=["pubmed", "geo"]
        )
    ]

    artifact_events = [
        event for event in events if event["type"] == "artifact_produced"
    ]
    assert artifact_events[0]["artifact_id"] == "run_manifest"
    assert {event["artifact_id"] for event in artifact_events[1:]} == {
        artifact.artifact_id for artifact in manifest.artifacts
    }
    assert events[-1] == {"type": "done", "final_output": "complete"}
