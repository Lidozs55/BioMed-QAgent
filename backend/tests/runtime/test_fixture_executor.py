from __future__ import annotations

import json

import pytest

import app.agent_loop.runner as runner_module
import app.runtime.manager as manager_module
from app.domain.contracts import (
    EventEnvelope,
    RunStatus,
    StartRunRequest,
    StartTaskRequest,
    TaskMode,
)
from app.runtime.repository import TaskRepository


@pytest.mark.asyncio
async def test_real_pinned_fixture_first_run_bridges_legacy_events_durably(
    tmp_path,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    manager = manager_module.TaskManager(
        repository,
        run_executor=runner_module.ModeDispatchRunExecutor(repository),
    )
    await manager.start()
    request = StartTaskRequest(
        request_id="req_fixture_durable",
        input="  durable fixture topic  ",
        databases=["geo", "pubmed"],
        mode=TaskMode.FIXTURE,
    )
    try:
        accepted = await manager.create_task(request)

        assert accepted.status is RunStatus.QUEUED
        assert accepted.task_id.startswith("task_")
        assert accepted.run_id.startswith("run_")
        await manager.wait_until_idle()

        snapshot = await repository.get_snapshot(accepted.task_id)
        assert snapshot is not None
        assert snapshot.task.mode is TaskMode.FIXTURE
        assert snapshot.task.databases == ["geo", "pubmed"]
        assert snapshot.task.status is RunStatus.COMPLETED
        assert snapshot.task.active_run_id is None
        assert len(snapshot.runs) == 1
        assert snapshot.runs[0].run_id == accepted.run_id
        assert snapshot.runs[0].status is RunStatus.COMPLETED

        runtime_events = await repository.list_events(accepted.task_id)
        assert [event.sequence for event in runtime_events] == list(
            range(1, len(runtime_events) + 1)
        )
        assert [event.payload.type.value for event in runtime_events[:2]] == [
            "run_queued",
            "run_started",
        ]
        assert [event.payload.type.value for event in runtime_events[-2:]] == [
            "run_finalizing",
            "run_completed",
        ]

        legacy_path = repository.tasks_dir / accepted.task_id / "logs" / "events.jsonl"
        legacy_events = [
            EventEnvelope.model_validate_json(line)
            for line in legacy_path.read_text("utf-8").splitlines()
        ]
        bridged_events = runtime_events[2:-2]
        assert len(bridged_events) == len(legacy_events)
        for bridged, legacy in zip(bridged_events, legacy_events, strict=True):
            assert bridged.schema_version == "2.0"
            assert bridged.run_id == accepted.run_id
            assert bridged.type == legacy.type
            assert bridged.payload == legacy.payload
            assert bridged.stage_attempt_id == legacy.stage_attempt_id
            assert bridged.timestamp == legacy.timestamp
            assert bridged.event_id != legacy.event_id

        manifest_path = (
            repository.tasks_dir / accepted.task_id / "artifacts" / "run_manifest.json"
        )
        manifest = json.loads(manifest_path.read_text("utf-8"))
        assert manifest["request"]["topic"] == "durable fixture topic"

        with pytest.raises(manager_module.FixtureTaskContinuationError):
            await manager.submit_run(
                accepted.task_id,
                StartRunRequest(
                    request_id="req_fixture_new_continuation",
                    input="continue fixture",
                ),
            )
        with pytest.raises(manager_module.FixtureTaskContinuationError):
            await manager.submit_run(
                accepted.task_id,
                StartRunRequest(
                    request_id=request.request_id,
                    input="reuse create request",
                ),
            )
        unchanged = await repository.get_snapshot(accepted.task_id)
        assert unchanged is not None
        assert len(unchanged.runs) == 1
    finally:
        await manager.close()
