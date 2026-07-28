from __future__ import annotations

import asyncio
from collections import Counter

import pytest
from app.domain.contracts import (
    SubagentCancelledPayload,
    SubagentCancelRequestedPayload,
    SubagentCompletedPayload,
    SubagentErrorCode,
    SubagentFailedPayload,
    SubagentInterruptedPayload,
    SubagentQueuedPayload,
    SubagentRequest,
    SubagentResult,
    SubagentStartedPayload,
    SubagentStatus,
    SubagentType,
)
from app.domain.contracts.events import EventPayload
from app.subagents.supervisor import SubagentSupervisor

Owner = tuple[str, str]
TerminalPayload = (
    SubagentCompletedPayload
    | SubagentFailedPayload
    | SubagentCancelledPayload
    | SubagentInterruptedPayload
)


def _request(index: int) -> SubagentRequest:
    return SubagentRequest(
        agent_type=SubagentType.SOURCE_RESEARCH,
        objective=f"Find source {index}",
        domain="bioinformatics",
        capability="source_research",
        inputs={"index": index},
    )


class RecordingSink:
    def __init__(self) -> None:
        self.events: list[tuple[str, str, str, str, EventPayload]] = []
        self._changed = asyncio.Condition()

    async def emit(
        self,
        *,
        task_id: str,
        run_id: str,
        subagent_id: str,
        parent_tool_call_id: str,
        payload: EventPayload,
    ) -> None:
        async with self._changed:
            self.events.append(
                (
                    task_id,
                    run_id,
                    subagent_id,
                    parent_tool_call_id,
                    payload,
                )
            )
            self._changed.notify_all()

    async def wait_for_payload(
        self,
        subagent_id: str,
        payload_type: type[EventPayload],
    ) -> EventPayload:
        async with asyncio.timeout(1):
            async with self._changed:
                await self._changed.wait_for(
                    lambda: any(
                        event_subagent_id == subagent_id
                        and isinstance(payload, payload_type)
                        for _, _, event_subagent_id, _, payload in self.events
                    )
                )
        return next(
            payload
            for _, _, event_subagent_id, _, payload in self.events
            if event_subagent_id == subagent_id
            and isinstance(payload, payload_type)
        )

    def payloads_for(self, subagent_id: str) -> list[EventPayload]:
        return [
            payload
            for _, _, event_subagent_id, _, payload in self.events
            if event_subagent_id == subagent_id
        ]


class BlockingRunner:
    def __init__(self) -> None:
        self.release = asyncio.Event()
        self.active_by_owner: Counter[Owner] = Counter()
        self.max_active_by_owner: Counter[Owner] = Counter()
        self.active_total = 0
        self.max_active_total = 0
        self.started_total = 0
        self._changed = asyncio.Condition()

    async def run(
        self,
        request: SubagentRequest,
        *,
        subagent_id: str,
        task_id: str,
        run_id: str,
    ) -> SubagentResult:
        del request
        owner = (task_id, run_id)
        async with self._changed:
            self.active_by_owner[owner] += 1
            self.max_active_by_owner[owner] = max(
                self.max_active_by_owner[owner],
                self.active_by_owner[owner],
            )
            self.active_total += 1
            self.max_active_total = max(self.max_active_total, self.active_total)
            self.started_total += 1
            self._changed.notify_all()
        try:
            await self.release.wait()
            return SubagentResult(
                subagent_id=subagent_id,
                status=SubagentStatus.COMPLETED,
                summary="Finished",
            )
        finally:
            async with self._changed:
                self.active_by_owner[owner] -= 1
                self.active_total -= 1
                self._changed.notify_all()

    async def wait_until_started(self, count: int) -> None:
        async with asyncio.timeout(1):
            async with self._changed:
                await self._changed.wait_for(lambda: self.started_total >= count)


class ImmediateRunner:
    def __init__(
        self,
        status: SubagentStatus = SubagentStatus.COMPLETED,
        *,
        error_code: SubagentErrorCode | None = None,
    ) -> None:
        self.status = status
        self.error_code = error_code

    async def run(
        self,
        request: SubagentRequest,
        *,
        subagent_id: str,
        task_id: str,
        run_id: str,
    ) -> SubagentResult:
        del request, task_id, run_id
        return SubagentResult(
            subagent_id=subagent_id,
            status=self.status,
            summary=f"Runner returned {self.status.value}",
            error_code=self.error_code,
        )


class NeverFinishesRunner:
    async def run(
        self,
        request: SubagentRequest,
        *,
        subagent_id: str,
        task_id: str,
        run_id: str,
    ) -> SubagentResult:
        del request, subagent_id, task_id, run_id
        await asyncio.Event().wait()
        raise AssertionError("unreachable")


class ErrorRunner:
    async def run(
        self,
        request: SubagentRequest,
        *,
        subagent_id: str,
        task_id: str,
        run_id: str,
    ) -> SubagentResult:
        del request, subagent_id, task_id, run_id
        raise RuntimeError("runner exploded")


class CancellationIgnoringRunner:
    def __init__(self) -> None:
        self.started = asyncio.Event()

    async def run(
        self,
        request: SubagentRequest,
        *,
        subagent_id: str,
        task_id: str,
        run_id: str,
    ) -> SubagentResult:
        del request, task_id, run_id
        self.started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            return SubagentResult(
                subagent_id=subagent_id,
                status=SubagentStatus.COMPLETED,
                summary="Ignored cancellation",
            )
        raise AssertionError("unreachable")


@pytest.mark.asyncio
async def test_start_batch_returns_queued_records_and_emits_before_scheduling() -> None:
    sink = RecordingSink()
    supervisor = SubagentSupervisor()

    records = await supervisor.start_batch(
        task_id="task_1",
        run_id="run_1",
        parent_tool_call_id="call_1",
        requests=[_request(0), _request(1)],
        runner=ImmediateRunner(),
        sink=sink,
    )

    assert [record.status for record in records] == [
        SubagentStatus.QUEUED,
        SubagentStatus.QUEUED,
    ]
    assert all(record.task_id == "task_1" for record in records)
    assert all(record.run_id == "run_1" for record in records)
    assert all(record.parent_tool_call_id == "call_1" for record in records)
    for record in records:
        result = await supervisor.wait(record.subagent_id)
        payloads = sink.payloads_for(record.subagent_id)
        assert isinstance(payloads[0], SubagentQueuedPayload)
        assert isinstance(payloads[1], SubagentStartedPayload)
        assert isinstance(payloads[2], SubagentCompletedPayload)
        assert result.status is SubagentStatus.COMPLETED

    await supervisor.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("requests", "message"),
    [
        ([], "at least 1"),
        ([_request(index) for index in range(9)], "at most 8"),
    ],
)
async def test_supervisor_enforces_batch_bounds(
    requests: list[SubagentRequest],
    message: str,
) -> None:
    supervisor = SubagentSupervisor()

    with pytest.raises(ValueError, match=message):
        await supervisor.start_batch(
            task_id="task_1",
            run_id="run_1",
            parent_tool_call_id="call_1",
            requests=requests,
            runner=ImmediateRunner(),
            sink=RecordingSink(),
        )

    await supervisor.shutdown()


@pytest.mark.asyncio
async def test_supervisor_enforces_per_run_and_shared_global_limits() -> None:
    runner = BlockingRunner()
    sink = RecordingSink()
    supervisor = SubagentSupervisor(global_limit=4, per_run_limit=3)

    first = await supervisor.start_batch(
        task_id="task_1",
        run_id="run_shared",
        parent_tool_call_id="call_1",
        requests=[_request(index) for index in range(8)],
        runner=runner,
        sink=sink,
    )
    second = await supervisor.start_batch(
        task_id="task_2",
        run_id="run_shared",
        parent_tool_call_id="call_2",
        requests=[_request(index) for index in range(8)],
        runner=runner,
        sink=sink,
    )

    await runner.wait_until_started(4)
    assert runner.max_active_by_owner[("task_1", "run_shared")] <= 3
    assert runner.max_active_by_owner[("task_2", "run_shared")] <= 3
    assert runner.max_active_total == 4

    await supervisor.cancel_run("task_1", "run_shared", reason="test cleanup")
    await supervisor.cancel_run("task_2", "run_shared", reason="test cleanup")
    results = [
        await supervisor.wait(item.subagent_id) for item in [*first, *second]
    ]
    assert all(result.status is SubagentStatus.CANCELLED for result in results)
    await supervisor.shutdown()


@pytest.mark.asyncio
async def test_wait_returns_stable_terminal_result_and_rejects_unknown_id() -> None:
    supervisor = SubagentSupervisor()
    records = await supervisor.start_batch(
        task_id="task_1",
        run_id="run_1",
        parent_tool_call_id="call_1",
        requests=[_request(0)],
        runner=ImmediateRunner(),
        sink=RecordingSink(),
    )

    first = await supervisor.wait(records[0].subagent_id)
    second = await supervisor.wait(records[0].subagent_id)

    assert first is second
    with pytest.raises(LookupError, match="unknown subagent"):
        await supervisor.wait("subagent_missing")
    await supervisor.shutdown()


@pytest.mark.asyncio
async def test_timeout_maps_to_failed_timed_out_result() -> None:
    sink = RecordingSink()
    supervisor = SubagentSupervisor(timeout_seconds=0.01)
    records = await supervisor.start_batch(
        task_id="task_1",
        run_id="run_1",
        parent_tool_call_id="call_1",
        requests=[_request(0)],
        runner=NeverFinishesRunner(),
        sink=sink,
    )

    result = await supervisor.wait(records[0].subagent_id)

    assert result.status is SubagentStatus.FAILED
    assert result.error_code is SubagentErrorCode.TIMED_OUT
    assert len(
        [
            payload
            for payload in sink.payloads_for(records[0].subagent_id)
            if isinstance(payload, TerminalPayload)
        ]
    ) == 1
    assert isinstance(sink.payloads_for(records[0].subagent_id)[-1], SubagentFailedPayload)
    await supervisor.shutdown()


@pytest.mark.asyncio
async def test_unexpected_runner_error_maps_to_failed_internal_error() -> None:
    sink = RecordingSink()
    supervisor = SubagentSupervisor()
    records = await supervisor.start_batch(
        task_id="task_1",
        run_id="run_1",
        parent_tool_call_id="call_1",
        requests=[_request(0)],
        runner=ErrorRunner(),
        sink=sink,
    )

    result = await supervisor.wait(records[0].subagent_id)

    assert result.status is SubagentStatus.FAILED
    assert result.error_code is SubagentErrorCode.INTERNAL_ERROR
    assert result.error_message == "runner exploded"
    assert isinstance(sink.payloads_for(records[0].subagent_id)[-1], SubagentFailedPayload)
    await supervisor.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "payload_type"),
    [
        (SubagentStatus.COMPLETED, SubagentCompletedPayload),
        (SubagentStatus.FAILED, SubagentFailedPayload),
        (SubagentStatus.CANCELLED, SubagentCancelledPayload),
        (SubagentStatus.INTERRUPTED, SubagentInterruptedPayload),
    ],
)
async def test_runner_terminal_result_emits_matching_payload(
    status: SubagentStatus,
    payload_type: type[TerminalPayload],
) -> None:
    sink = RecordingSink()
    supervisor = SubagentSupervisor()
    records = await supervisor.start_batch(
        task_id="task_1",
        run_id="run_1",
        parent_tool_call_id="call_1",
        requests=[_request(0)],
        runner=ImmediateRunner(status),
        sink=sink,
    )

    result = await supervisor.wait(records[0].subagent_id)

    assert result.status is status
    assert isinstance(sink.payloads_for(records[0].subagent_id)[-1], payload_type)
    await supervisor.shutdown()


@pytest.mark.asyncio
async def test_cancel_emits_request_then_one_cancelled_terminal_event() -> None:
    runner = CancellationIgnoringRunner()
    sink = RecordingSink()
    supervisor = SubagentSupervisor()
    records = await supervisor.start_batch(
        task_id="task_1",
        run_id="run_1",
        parent_tool_call_id="call_1",
        requests=[_request(0)],
        runner=runner,
        sink=sink,
    )
    subagent_id = records[0].subagent_id
    await asyncio.wait_for(runner.started.wait(), timeout=1)

    result = await supervisor.cancel(subagent_id, reason="user stopped it")

    assert result.status is SubagentStatus.CANCELLED
    lifecycle = sink.payloads_for(subagent_id)
    assert [
        type(payload)
        for payload in lifecycle
        if isinstance(
            payload,
            (
                SubagentCancelRequestedPayload,
                SubagentCompletedPayload,
                SubagentFailedPayload,
                SubagentCancelledPayload,
                SubagentInterruptedPayload,
            ),
        )
    ] == [SubagentCancelRequestedPayload, SubagentCancelledPayload]
    assert (
        next(
            payload
            for payload in lifecycle
            if isinstance(payload, SubagentCancelRequestedPayload)
        ).reason
        == "user stopped it"
    )
    assert await supervisor.cancel(subagent_id, reason="duplicate") is result
    await supervisor.shutdown()


@pytest.mark.asyncio
async def test_cancel_run_only_cancels_exact_task_and_run_owner() -> None:
    runner = BlockingRunner()
    sink = RecordingSink()
    supervisor = SubagentSupervisor(global_limit=4, per_run_limit=3)
    targets = await supervisor.start_batch(
        task_id="task_1",
        run_id="run_1",
        parent_tool_call_id="call_target",
        requests=[_request(0)],
        runner=runner,
        sink=sink,
    )
    other_task = await supervisor.start_batch(
        task_id="task_2",
        run_id="run_1",
        parent_tool_call_id="call_other_task",
        requests=[_request(1)],
        runner=runner,
        sink=sink,
    )
    other_run = await supervisor.start_batch(
        task_id="task_1",
        run_id="run_2",
        parent_tool_call_id="call_other_run",
        requests=[_request(2)],
        runner=runner,
        sink=sink,
    )
    await runner.wait_until_started(3)

    results = await supervisor.cancel_run("task_1", "run_1", reason="parent stopped")

    assert [result.subagent_id for result in results] == [targets[0].subagent_id]
    assert results[0].status is SubagentStatus.CANCELLED
    assert runner.active_by_owner[("task_2", "run_1")] == 1
    assert runner.active_by_owner[("task_1", "run_2")] == 1
    assert not any(
        isinstance(payload, SubagentCancelRequestedPayload)
        for record in [*other_task, *other_run]
        for payload in sink.payloads_for(record.subagent_id)
    )

    await supervisor.shutdown()


@pytest.mark.asyncio
async def test_shutdown_is_idempotent_and_awaits_all_children() -> None:
    runner = BlockingRunner()
    supervisor = SubagentSupervisor(global_limit=2, per_run_limit=1)
    records = await supervisor.start_batch(
        task_id="task_1",
        run_id="run_1",
        parent_tool_call_id="call_1",
        requests=[_request(index) for index in range(3)],
        runner=runner,
        sink=RecordingSink(),
    )
    await runner.wait_until_started(1)

    await supervisor.shutdown()
    await supervisor.shutdown()

    assert [
        (await supervisor.wait(record.subagent_id)).status for record in records
    ] == [SubagentStatus.CANCELLED] * 3
    pending_children = [
        task
        for task in asyncio.all_tasks()
        if task is not asyncio.current_task()
        and task.get_name().startswith("subagent:")
        and not task.done()
    ]
    assert pending_children == []
    with pytest.raises(RuntimeError, match="shut down"):
        await supervisor.start_batch(
            task_id="task_1",
            run_id="run_2",
            parent_tool_call_id="call_2",
            requests=[_request(0)],
            runner=ImmediateRunner(),
            sink=RecordingSink(),
        )
