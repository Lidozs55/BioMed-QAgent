"""Agent 模式 e2e 回归测试。

走完整的 TaskManager → AgentRunExecutor → 事件持久化链路，
验证 docs/REVIEW_2026-07-18.md §10 中的关键不变量：
- 成功路径：pending publication 产出 → artifact_produced → run_completed
- 无 artifact 路径：completed + BuildResult(NO_DATA)（phase 4a，见
  docs/superpowers/plans/2026-08-06-phase4a-terminal-state.md Task 6）
- 事件顺序：finalizing < artifact_produced/completed
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import app.agent_loop.runner as runner_module
import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.domain.contracts import (
    ArtifactProducedPayload,
    PublicationCreatedPayload,
    RunCompletedPayload,
    RunFailedPayload,
    RunFinalizingPayload,
    RunStartedPayload,
    StartTaskRequest,
    WarningPayload,
)
from app.domain.contracts.dataset_state import BuildResultStatus
from app.pipeline.dataset_build_tool import execute_dataset_build
from app.pipeline.runner import PipelineRunner
from app.runtime.manager import TaskManager
from app.runtime.repository import TaskRepository
from app.tools.workdir import create_task_workdir

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
async def test_agent_e2e_v2_dataset_build_wires_durable_build_result(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """V2 durable execution.build_result (bug-sweep REVIEW §3): when the
    Agent calls ``execute_dataset_build`` and the build succeeds, the run
    must complete with the REAL BuildResult (SUCCEEDED + publication_id),
    plus artifact_produced + publication_created events — never the generic
    NO_DATA fallback."""

    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    build = _make_build()

    class FakeResult:
        def __init__(self, context: RunContext) -> None:
            self.context = context

        async def stream_events(self):
            run_ctx = self.context
            workdir = create_task_workdir(run_ctx.task_id, base_dir=str(output_dir / "tasks"))
            matrix = workdir.source_asset_file("geo_matrix.txt.gz")
            import gzip

            with gzip.open(matrix, "wt", encoding="utf-8") as handle:
                handle.write(
                    "!series_matrix_table_begin\n"
                    '"ID_REF"\t"GSM1"\t"GSM2"\n'
                    '"AFFX-BioB-5"\t1.5\t2.0\n'
                    '"AFFX-BioB-6"\t3.0\t4.0\n'
                    "!series_matrix_table_end\n"
                )
            spec = json.dumps(
                {
                    "build_id": "build_e2e",
                    "objective": "compare GEO probe expression",
                    "dataset_family": "gene_expression",
                    "row_granularity": "probe_sample_measurement",
                    "schema_ref": "gene_expression.probe_long.v1",
                    "source_bindings": [
                        {
                            "binding_id": "binding_geo",
                            "source": "geo",
                            "accession": "GSE1",
                            "acquisition": {"mode": "builtin", "provider_id": "geo.series.v1"},
                            "adapter_id": "geo.expression.v1",
                            "parameters": {
                                "format": "series_matrix",
                                "value_semantics": "expression_value",
                                "value_scale": "log2",
                                "expression_unit": "log2_expression",
                                "platform_ids": ["GPL570"],
                            },
                        }
                    ],
                    "merge_strategy": "append_by_canonical_row",
                    "validation_profile_ref": "gene_expression.probe_release.v1",
                    "normalization_profile_ref": "gene_expression.normalization.v1",
                }
            )
            tool = ToolContext(
                context=run_ctx,
                tool_name="execute_dataset_build",
                tool_call_id="call_e2e",
                tool_arguments="{}",
            )
            data = json.loads(
                await execute_dataset_build.on_invoke_tool(
                    tool,
                    json.dumps(
                        {
                            "spec": spec,
                            "source_files": json.dumps(
                                {"binding_geo": "source_assets/geo_matrix.txt.gz"}
                            ),
                        }
                    ),
                )
            )
            assert data["status"] == "ok"
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
                request_id="request_e2e_v2_build",
                input="e2e v2 dataset build",
            )
        )
        await manager.wait_until_idle()

        events = await repository.list_events(accepted.task_id)
        payloads = [event.payload for event in events]

        assert not any(isinstance(p, RunFailedPayload) for p in payloads)

        completed = [p for p in payloads if isinstance(p, RunCompletedPayload)]
        assert len(completed) == 1
        result = completed[0].build_result
        assert result is not None
        # The durable BuildResult must be the real V2 outcome, not the
        # generic NO_DATA fallback.
        assert result.status is BuildResultStatus.SUCCEEDED
        assert result.valid_row_count == 4
        assert result.successful_sources == ["binding_geo"]
        assert result.publication_id is not None
        assert result.reason_codes == []

        # Publication + completion events accompany the run; the V2 build's
        # files stay under datasets_build/ (served by the builds API), so no
        # artifact_produced events are emitted for them.
        publications = [
            p for p in payloads if isinstance(p, PublicationCreatedPayload)
        ]
        assert len(publications) == 1
        assert publications[0].publication_id == result.publication_id
        assert publications[0].run_id == accepted.run_id
        assert len(publications[0].manifest_sha256) == 64

        # No "no artifact" warning: the V2 build is real completion evidence.
        assert not any(
            isinstance(p, WarningPayload) and p.code == "artifact_manifest_missing"
            for p in payloads
        )
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_agent_e2e_no_artifact_path_emits_completed_no_data(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """无 artifact 路径：Agent 未产出 pending → COMPLETED + BuildResult(NO_DATA)。

    phase 4a：零产物完成不再是 run_failed，manager 发射结构化终态
    completed + build_result.status == NO_DATA。
    FakeResult 有 final_output 属性，触发 agent_executed 标记。
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

        # 必须有 RunCompletedPayload 且 build_result.status == NO_DATA
        completed = [p for p in payloads if isinstance(p, RunCompletedPayload)]
        assert len(completed) == 1
        assert completed[0].build_result is not None
        assert completed[0].build_result.status is BuildResultStatus.NO_DATA
        assert completed[0].build_result.valid_row_count == 0
        assert completed[0].build_result.reason_codes == ["no_primary_data"]

        # 必须没有 RunFailedPayload
        assert not any(isinstance(p, RunFailedPayload) for p in payloads)

        # 必须没有 ArtifactProducedPayload
        assert not any(isinstance(p, ArtifactProducedPayload) for p in payloads)

        # 事件顺序：finalizing < completed
        finalizing_idx = next(
            i for i, p in enumerate(payloads) if isinstance(p, RunFinalizingPayload)
        )
        completed_idx = next(
            i for i, p in enumerate(payloads) if isinstance(p, RunCompletedPayload)
        )
        assert finalizing_idx < completed_idx

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
async def test_agent_e2e_emits_warning_before_completed_when_no_pending(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """无 pending publication 时 executor 先发 WarningPayload，manager 再发 COMPLETED。

    验证两层防御协同工作：
    - executor 层：发射 WarningPayload(code=artifact_manifest_missing)
    - manager 层：零产物完成 → COMPLETED + BuildResult(NO_DATA)
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

        completed = [p for p in payloads if isinstance(p, RunCompletedPayload)]
        assert len(completed) == 1
        assert completed[0].build_result is not None
        assert completed[0].build_result.status is BuildResultStatus.NO_DATA

        # warning 必须在 completed 之前
        warning_idx = next(
            i for i, p in enumerate(payloads) if isinstance(p, WarningPayload)
        )
        completed_idx = next(
            i for i, p in enumerate(payloads) if isinstance(p, RunCompletedPayload)
        )
        assert warning_idx < completed_idx
        # 不应有 RunFailedPayload
        assert not any(isinstance(p, RunFailedPayload) for p in payloads)
    finally:
        await manager.close()
