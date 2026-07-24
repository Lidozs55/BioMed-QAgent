"""Agent 模式 e2e 回归测试。

走完整的 TaskManager → AgentRunExecutor → 事件持久化链路，
验证 docs/REVIEW_2026-07-18.md §10 中的关键不变量：
- 成功路径：pending publication 产出 → artifact_produced → run_completed
- 失败路径：无 artifact → run_failed（不静默 completed）
- 事件顺序：finalizing < artifact_produced < completed/failed
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import app.agent_loop.runner as runner_module
import pytest
from app.agent_loop.context import RunContext
from app.domain.contracts import (
    ArtifactProducedPayload,
    RunCompletedPayload,
    RunFailedPayload,
    RunFinalizingPayload,
    RunStartedPayload,
    StartTaskRequest,
    WarningPayload,
)
from app.pipeline.runner import PipelineRunner
from app.runtime.manager import TaskManager
from app.runtime.repository import TaskRepository

FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"

pytestmark = pytest.mark.usefixtures("runnable_agent_model_settings")


class NoopCompactor:
    async def prepare(
        self,
        task_id,
        *,
        model_handle,
        emit,
        request=None,
        session,
        cancellation_requested,
        commit,
    ):
        return SimpleNamespace(
            session=session,
            agent_input=request.agent_input if request is not None else "",
            estimate=SimpleNamespace(total=0),
        )


def make_executor(repository):
    return runner_module.AgentRunExecutor(
        repository,
        compactor=NoopCompactor(),
    )


def _make_build():
    return SimpleNamespace(
        agent=object(),
        skill_names=(),
        model=SimpleNamespace(close=AsyncMock()),
    )


@pytest.mark.asyncio
async def test_agent_e2e_success_path_emits_artifacts_and_completed(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """成功路径：Agent 通过 fixture pipeline 产出 pending → run_completed。

    复用 test_manager_persists_all_executor_artifacts_before_terminal_events
    的模式，额外校验：
    1. 事件顺序严格：run_started < run_finalizing < artifact_produced < run_completed
    2. run_manifest 一定是第一个 artifact
    3. 没有 RunFailedPayload
    4. .runtime-publication.json marker 存在且 schema 正确
    """

    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    build = _make_build()

    class FakeResult:
        def __init__(self, context: RunContext) -> None:
            self.context = context

        async def stream_events(self):
            run_id = self.context.reserve_pipeline_publication()
            assert run_id is not None
            runner = PipelineRunner(
                task_id=self.context.task_id,
                base_dir=output_dir / "tasks",
                fixture_dir=FIXTURE_DIR,
                defer_publication=True,
                run_id=run_id,
            )
            await runner.run()
            self.context.set_pending_publication(runner.pending_publication())
            if False:
                yield None

    def run_streamed(*args, **kwargs):
        return FakeResult(kwargs["context"])

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(runner_module.Runner, "run_streamed", run_streamed)
    manager = TaskManager(repository, run_executor=make_executor(repository))
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_e2e_success",
                input="e2e success path",
            )
        )
        await manager.wait_until_idle()

        events = await repository.list_events(accepted.task_id)
        payloads = [event.payload for event in events]

        # 不应有失败
        assert not any(isinstance(p, RunFailedPayload) for p in payloads)
        # 不应有 warning
        assert not any(isinstance(p, WarningPayload) for p in payloads)

        # 关键事件类型存在
        assert any(isinstance(p, RunStartedPayload) for p in payloads)
        assert any(isinstance(p, RunFinalizingPayload) for p in payloads)
        assert any(isinstance(p, RunCompletedPayload) for p in payloads)
        artifact_payloads = [
            p for p in payloads if isinstance(p, ArtifactProducedPayload)
        ]
        assert len(artifact_payloads) > 1  # run_manifest + 至少一个 artifact

        # 事件顺序严格校验
        started_idx = next(
            i for i, p in enumerate(payloads) if isinstance(p, RunStartedPayload)
        )
        finalizing_idx = next(
            i for i, p in enumerate(payloads) if isinstance(p, RunFinalizingPayload)
        )
        first_artifact_idx = next(
            i for i, p in enumerate(payloads) if isinstance(p, ArtifactProducedPayload)
        )
        completed_idx = next(
            i for i, p in enumerate(payloads) if isinstance(p, RunCompletedPayload)
        )
        assert started_idx < finalizing_idx < first_artifact_idx < completed_idx

        # run_manifest 一定是第一个 artifact
        assert artifact_payloads[0].artifact.artifact_id == "run_manifest"

        # publication marker 存在且 schema 正确
        marker_path = (
            repository.tasks_dir
            / accepted.task_id
            / "artifacts"
            / ".runtime-publication.json"
        )
        assert marker_path.is_file()
        marker = json.loads(marker_path.read_text("utf-8"))
        assert marker["schema_version"] == 1
        assert marker["task_id"] == accepted.task_id
        assert marker["run_id"] == accepted.run_id
        assert "manifest_sha256" in marker
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_agent_e2e_no_artifact_path_emits_failed(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """失败路径：Agent 未产出 pending → run_failed（不静默 completed）。

    覆盖 manager.py 成功证据校验的 e2e 行为。
    FakeResult 有 final_output 属性，触发 agent_executed 标记，
    让 manager 的成功证据校验生效。
    """

    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    build = _make_build()

    class FakeResult:
        final_output = "e2e no artifact"

        async def stream_events(self):
            if False:
                yield None

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(
        runner_module.Runner,
        "run_streamed",
        lambda *args, **kwargs: FakeResult(),
    )
    manager = TaskManager(repository, run_executor=make_executor(repository))
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_e2e_no_artifact",
                input="e2e no artifact path",
            )
        )
        await manager.wait_until_idle()

        events = await repository.list_events(accepted.task_id)
        payloads = [event.payload for event in events]

        # 必须有 RunFailedPayload
        failures = [p for p in payloads if isinstance(p, RunFailedPayload)]
        assert len(failures) == 1
        assert "artifact" in failures[0].error.lower()

        # 必须没有 RunCompletedPayload
        assert not any(isinstance(p, RunCompletedPayload) for p in payloads)

        # 必须没有 ArtifactProducedPayload
        assert not any(isinstance(p, ArtifactProducedPayload) for p in payloads)

        # 事件顺序：finalizing < failed
        finalizing_idx = next(
            i for i, p in enumerate(payloads) if isinstance(p, RunFinalizingPayload)
        )
        failed_idx = next(
            i for i, p in enumerate(payloads) if isinstance(p, RunFailedPayload)
        )
        assert finalizing_idx < failed_idx

        # 不应有 publication marker
        marker_path = (
            repository.tasks_dir
            / accepted.task_id
            / "artifacts"
            / ".runtime-publication.json"
        )
        assert not marker_path.exists()
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_agent_e2e_emits_warning_before_failed_when_no_pending(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """无 pending publication 时 executor 先发 WarningPayload，manager 再发 RunFailedPayload。

    验证两层防御协同工作：
    - executor 层：发射 WarningPayload(code=artifact_manifest_missing)
    - manager 层：completion_events 为空 + agent_executed → RunFailedPayload
    """

    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    build = _make_build()

    class FakeResult:
        final_output = "e2e warning then failed"

        async def stream_events(self):
            if False:
                yield None

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(
        runner_module.Runner,
        "run_streamed",
        lambda *args, **kwargs: FakeResult(),
    )
    manager = TaskManager(repository, run_executor=make_executor(repository))
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_e2e_warning_failed",
                input="e2e warning then failed",
            )
        )
        await manager.wait_until_idle()

        events = await repository.list_events(accepted.task_id)
        payloads = [event.payload for event in events]

        warnings = [p for p in payloads if isinstance(p, WarningPayload)]
        assert len(warnings) == 1
        assert warnings[0].code == "artifact_manifest_missing"

        failures = [p for p in payloads if isinstance(p, RunFailedPayload)]
        assert len(failures) == 1

        # warning 必须在 failed 之前
        warning_idx = next(
            i for i, p in enumerate(payloads) if isinstance(p, WarningPayload)
        )
        failed_idx = next(
            i for i, p in enumerate(payloads) if isinstance(p, RunFailedPayload)
        )
        assert warning_idx < failed_idx
    finally:
        await manager.close()
