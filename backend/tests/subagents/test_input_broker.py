from __future__ import annotations

import asyncio

import pytest
from app.domain.contracts import (
    SubagentInputRequiredPayload,
    SubagentStatus,
)
from app.subagents.input_broker import SubagentInputBroker
from app.subagents.supervisor import SubagentSupervisor


def _input_request(
    request_id: str,
    subagent_id: str,
) -> SubagentInputRequiredPayload:
    return SubagentInputRequiredPayload(
        subagent_id=subagent_id,
        request_id=request_id,
        summary=f"Confirm {subagent_id}",
        prompt_kind="confirmation",
    )


async def _start_request(
    broker: SubagentInputBroker,
    *,
    task_id: str,
    run_id: str,
    request_id: str,
    subagent_id: str,
) -> asyncio.Task:
    waiter = asyncio.create_task(
        broker.request(
            task_id=task_id,
            run_id=run_id,
            payload=_input_request(request_id, subagent_id),
        )
    )
    await asyncio.sleep(0)
    return waiter


@pytest.mark.asyncio
async def test_resume_targets_only_matching_subagent_request() -> None:
    broker = SubagentInputBroker()
    first = await _start_request(
        broker,
        task_id="task_1",
        run_id="run_1",
        request_id="request_1",
        subagent_id="sub_1",
    )
    second = await _start_request(
        broker,
        task_id="task_1",
        run_id="run_1",
        request_id="request_2",
        subagent_id="sub_2",
    )

    resumed = await broker.resume(
        task_id="task_1",
        run_id="run_1",
        request_id="request_1",
        decision="approve",
        detail={"confirmed": True},
    )

    assert resumed.subagent_id == "sub_1"
    assert resumed.decision == "approve"
    assert (await first) == resumed
    assert not second.done()
    await broker.cancel_subagent(
        task_id="task_1",
        run_id="run_1",
        subagent_id="sub_2",
    )
    with pytest.raises(asyncio.CancelledError):
        await second


@pytest.mark.asyncio
async def test_duplicate_request_id_is_rejected_globally() -> None:
    broker = SubagentInputBroker()
    first = await _start_request(
        broker,
        task_id="task_1",
        run_id="run_1",
        request_id="request_duplicate",
        subagent_id="sub_1",
    )
    try:
        with pytest.raises(ValueError, match="duplicate request_id"):
            await broker.request(
                task_id="task_2",
                run_id="run_2",
                payload=_input_request("request_duplicate", "sub_2"),
            )
    finally:
        await broker.cancel_run(task_id="task_1", run_id="run_1")
        with pytest.raises(asyncio.CancelledError):
            await first


@pytest.mark.asyncio
async def test_resume_ownership_mismatch_does_not_consume_request() -> None:
    broker = SubagentInputBroker()
    waiter = await _start_request(
        broker,
        task_id="task_owner",
        run_id="run_owner",
        request_id="request_owner",
        subagent_id="sub_owner",
    )

    with pytest.raises(ValueError, match="does not belong"):
        await broker.try_resume(
            task_id="task_other",
            run_id="run_owner",
            request_id="request_owner",
            decision="approve",
            detail={},
        )

    assert not waiter.done()
    assert await broker.try_resume(
        task_id="task_owner",
        run_id="run_owner",
        request_id="request_owner",
        decision="reject",
        detail={"reason": "not allowed"},
    )
    assert (await waiter).decision == "reject"


@pytest.mark.asyncio
async def test_duplicate_resume_race_resolves_exactly_one_caller() -> None:
    broker = SubagentInputBroker()
    waiter = await _start_request(
        broker,
        task_id="task_1",
        run_id="run_1",
        request_id="request_race",
        subagent_id="sub_1",
    )

    outcomes = await asyncio.gather(
        broker.try_resume(
            task_id="task_1",
            run_id="run_1",
            request_id="request_race",
            decision="approve",
            detail={"caller": 1},
        ),
        broker.try_resume(
            task_id="task_1",
            run_id="run_1",
            request_id="request_race",
            decision="reject",
            detail={"caller": 2},
        ),
    )

    assert sorted(outcomes) == [False, True]
    assert (await waiter).detail in ({"caller": 1}, {"caller": 2})


@pytest.mark.asyncio
async def test_cancelled_request_caller_removes_its_pending_future() -> None:
    broker = SubagentInputBroker()
    waiter = await _start_request(
        broker,
        task_id="task_1",
        run_id="run_1",
        request_id="request_cancelled_caller",
        subagent_id="sub_1",
    )

    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter

    assert not await broker.try_resume(
        task_id="task_1",
        run_id="run_1",
        request_id="request_cancelled_caller",
        decision="approve",
        detail={},
    )


@pytest.mark.asyncio
async def test_cancel_run_does_not_cancel_another_runs_waiter() -> None:
    broker = SubagentInputBroker()
    first = await _start_request(
        broker,
        task_id="task_1",
        run_id="run_1",
        request_id="request_1",
        subagent_id="sub_1",
    )
    sibling = await _start_request(
        broker,
        task_id="task_1",
        run_id="run_2",
        request_id="request_2",
        subagent_id="sub_2",
    )

    await broker.cancel_run(task_id="task_1", run_id="run_1")

    with pytest.raises(asyncio.CancelledError):
        await first
    assert not sibling.done()
    await broker.cancel_run(task_id="task_1", run_id="run_2")
    with pytest.raises(asyncio.CancelledError):
        await sibling


class _AwaitingInputRunner:
    def __init__(self, broker: SubagentInputBroker) -> None:
        self.broker = broker
        self.waiting = asyncio.Event()

    async def run(
        self,
        _request,
        *,
        subagent_id: str,
        task_id: str,
        run_id: str,
    ):
        self.waiting.set()
        await self.broker.request(
            task_id=task_id,
            run_id=run_id,
            payload=_input_request("request_supervised", subagent_id),
        )
        raise AssertionError("cancelled input request must not resume")


class _RecordingSink:
    async def emit(self, **_kwargs) -> None:
        return None


@pytest.mark.asyncio
async def test_supervisor_cancel_cleans_matching_broker_waiter() -> None:
    from app.domain.contracts import SubagentRequest, SubagentType

    broker = SubagentInputBroker()
    supervisor = SubagentSupervisor(input_broker=broker)
    runner = _AwaitingInputRunner(broker)
    records = await supervisor.start_batch(
        task_id="task_1",
        run_id="run_1",
        parent_tool_call_id="call_1",
        requests=[
            SubagentRequest(
                agent_type=SubagentType.SOURCE_RESEARCH,
                objective="Wait for confirmation",
                domain="example.org",
                capability="confirmation",
            )
        ],
        runner=runner,
        sink=_RecordingSink(),
    )
    subagent_id = records[0].subagent_id
    await asyncio.wait_for(runner.waiting.wait(), timeout=1)
    try:
        result = await supervisor.cancel(subagent_id)

        assert result.status is SubagentStatus.CANCELLED
        with pytest.raises(LookupError):
            await broker.resume(
                task_id="task_1",
                run_id="run_1",
                request_id="request_supervised",
                decision="approve",
                detail={},
            )
    finally:
        await supervisor.shutdown()
