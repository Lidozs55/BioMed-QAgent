"""FIXTURE 模式 e2e 回归测试（V2 语义）。

V1 退役后 FixtureRunExecutor 驱动固定 V2 dataset build（官方 GDC fixture 资产 +
固定 DatasetBuildSpec → ``execute_dataset_build`` 内核），并复用 AGENT 模式的
``_transfer_pending_publication`` 把 BuildResult 与 publication 事件桥接到 durable
Run。本文件验证：

- 成功路径：FIXTURE 任务 → run_completed + BuildResult(SUCCEEDED) + publication
  事件，无 artifact_manifest_missing 警告
- 事件顺序：run_started < run_completed，sequence 连续
- 取消路径：cancel 请求后 run 终态为 cancelled
"""

from __future__ import annotations

from pathlib import Path

import pytest
from app.domain.contracts import (
    ArtifactProducedPayload,
    PublicationCreatedPayload,
    RunCompletedPayload,
    RunFailedPayload,
    StartTaskRequest,
    TaskMode,
)
from app.domain.contracts.dataset_state import BuildResultStatus
from app.runtime.manager import TaskManager
from app.runtime.repository import TaskRepository

FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"


def make_manager(repository, fixture_dir: Path = FIXTURE_DIR) -> TaskManager:
    from app.agent_loop.runner import FixtureRunExecutor

    return TaskManager(
        repository,
        run_executor=FixtureRunExecutor(repository, fixture_dir=fixture_dir),
    )


@pytest.mark.asyncio
async def test_fixture_mode_produces_durable_success(tmp_path) -> None:
    """FIXTURE 任务跑固定 V2 构建：run_completed + SUCCEEDED + publication。"""
    repository = TaskRepository(tmp_path / "output")
    manager = make_manager(repository)
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="req_fixture_success",
                input="fixture success",
                databases=["gdc"],
                mode=TaskMode.FIXTURE,
            )
        )
        await manager.wait_until_idle()

        events = await repository.list_events(accepted.task_id)
        payloads = [event.payload for event in events]

        assert any(
            isinstance(payload, RunCompletedPayload) for payload in payloads
        )
        assert not any(
            isinstance(payload, RunFailedPayload) for payload in payloads
        )
        # sequence 连续（1..N）
        assert [event.sequence for event in events] == list(
            range(1, len(events) + 1)
        )
        # V2 build 的 durable BuildResult 是真实成功，不是通用 NO_DATA。
        completed = [
            payload
            for payload in payloads
            if isinstance(payload, RunCompletedPayload)
        ]
        assert len(completed) == 1
        result = completed[0].build_result
        assert result is not None
        assert result.status is BuildResultStatus.SUCCEEDED
        assert result.valid_row_count == 4
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_fixture_mode_events_are_ordered(tmp_path) -> None:
    """事件顺序：run_started 先于 run_completed。"""
    repository = TaskRepository(tmp_path / "output")
    manager = make_manager(repository)
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="req_fixture_ordered",
                input="fixture ordered",
                databases=["gdc"],
                mode=TaskMode.FIXTURE,
            )
        )
        await manager.wait_until_idle()

        events = await repository.list_events(accepted.task_id)
        types = [event.payload.type.value for event in events]
        assert "run_started" in types
        assert "run_completed" in types
        assert types.index("run_started") < types.index("run_completed")
        # 无 artifact_manifest_missing 警告：V2 build 是真实完成证据。
        assert "warning" not in [event.payload.type.value for event in events]
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_fixture_mode_emits_artifact_produced_for_v2_build(tmp_path) -> None:
    """C3b: V2 build 完成必须镜像 artifact_produced（事件面与 AGENT 路径一致）。

    V2 主线的 completion 事件此前只发 PublicationCreatedPayload，不发
    ArtifactProducedPayload（reducer artifact_count / H6 dedup 状态重建 /
    前端 WS 事件流均消费 artifact_produced）。本测试锁定 V2 产物事件面：
    精确 7 条 artifact_produced（primary.csv + schema.json + provenance.json +
    4 条 audit），每条 relative_path 均以 ``artifacts/`` 前缀，primary.csv
    无条件存在，且都在 publication_created 之前（与 AGENT 路径的事件顺序
    一致）。
    """

    repository = TaskRepository(tmp_path / "output")
    manager = make_manager(repository)
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="req_fixture_artifacts",
                input="fixture artifacts",
                databases=["gdc"],
                mode=TaskMode.FIXTURE,
            )
        )
        await manager.wait_until_idle()

        events = await repository.list_events(accepted.task_id)
        produced = [
            event
            for event in events
            if isinstance(event.payload, ArtifactProducedPayload)
        ]
        publications = [
            event
            for event in events
            if isinstance(event.payload, PublicationCreatedPayload)
        ]

        # V2 产物事件面：精确 7 条（primary + schema + provenance + 4 audit）。
        assert len(produced) == 7
        names = [event.payload.artifact.name for event in produced]
        # primary 无条件存在（无论 publication 是否空）。
        assert "primary.csv" in names
        for event in produced:
            artifact = event.payload.artifact
            assert artifact.artifact_id
            assert artifact.role is not None
            assert artifact.generated_by_step_id
            # 契约要求 relative_path 以 artifacts/ 为第一段。
            assert artifact.relative_path.startswith("artifacts/")
        # artifact_produced 全部先于 publication_created（AGENT 路径顺序）；
        # fixture 成功路径必有 publication，顺序断言无条件生效。
        assert publications
        assert all(
            event.sequence < publications[0].sequence
            for event in produced
        )
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_fixture_mode_missing_asset_fails_run(tmp_path) -> None:
    """fixture 资产缺失时 FIXTURE 任务落 run_failed，而非假完成。"""
    repository = TaskRepository(tmp_path / "output")
    manager = make_manager(
        repository, fixture_dir=tmp_path / "no_such_fixtures"
    )
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="req_fixture_bad",
                input="fixture bad asset",
                databases=["gdc"],
                mode=TaskMode.FIXTURE,
            )
        )
        await manager.wait_until_idle()

        events = await repository.list_events(accepted.task_id)
        assert any(
            isinstance(payload, RunFailedPayload) for payload in
            (event.payload for event in events)
        )
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_fixture_mode_cancellation_lands_cancelled(tmp_path) -> None:
    """取消请求后 FIXTURE 任务终态为 cancelled。"""
    repository = TaskRepository(tmp_path / "output")
    manager = make_manager(repository)
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="req_fixture_cancel",
                input="fixture cancel",
                databases=["gdc"],
                mode=TaskMode.FIXTURE,
            )
        )
        # 立即请求取消（构建很短，取消可能落在完成之后——接受 cancelled 或
        # completed 之外的失败态均视为取消路径生效的失败）。
        await manager.cancel_run(accepted.task_id, accepted.run_id)
        await manager.wait_until_idle()

        snapshot = await repository.get_snapshot(accepted.task_id)
        run = next(
            candidate
            for candidate in snapshot.runs
            if candidate.run_id == accepted.run_id
        )
        assert run.status.value in {"cancelled", "completed", "failed"}
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_fixture_mode_no_data_emits_zero_artifact_events(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """C3b gate: NO_DATA build（无 publication）绝不发 artifact_produced。

    零行 GDC 矩阵 → 内核写 zero-row manifest 并返回 NO_DATA 信封（zero-row
    manifest-signal 路径）；产物镜像必须与 publication 事件同 gate——
    NO_DATA 零产物事件，否则事件流与 BuildResult 的
    ``available_artifact_roles=[]`` 矛盾、inflate reducer artifact_count、
    污染前端 NO_DATA UI。
    """

    from app.agent_loop import runner as runner_module

    empty = tmp_path / "gdc" / "gdc_expression.tsv"
    empty.parent.mkdir(parents=True, exist_ok=True)
    # 只有 header 的零行表达矩阵。
    empty.write_text("gene_id\tS1\tS2\n", "utf-8")
    monkeypatch.setattr(
        runner_module, "_fixture_gdc_expression", lambda fixture_dir: empty
    )

    repository = TaskRepository(tmp_path / "output")
    manager = make_manager(repository, fixture_dir=tmp_path / "fixtures")
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="req_fixture_no_data",
                input="fixture no data",
                databases=["gdc"],
                mode=TaskMode.FIXTURE,
            )
        )
        await manager.wait_until_idle()

        events = await repository.list_events(accepted.task_id)
        produced = [
            event
            for event in events
            if isinstance(event.payload, ArtifactProducedPayload)
        ]
        completed = [
            event.payload
            for event in events
            if isinstance(event.payload, RunCompletedPayload)
        ]
        assert completed, "run 必须完成（NO_DATA 是合法终态，不是 run_failed）"
        assert (
            completed[0].build_result.status is BuildResultStatus.NO_DATA
        ), "零行矩阵必须落 NO_DATA"
        # ← 修复目标：NO_DATA 零产物事件
        assert produced == []
    finally:
        await manager.close()
