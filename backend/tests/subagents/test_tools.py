from __future__ import annotations

import asyncio

import pytest
from app.agent_loop.context import RunContext
from app.domain.contracts import (
    SubagentRequest,
    SubagentResult,
    SubagentStatus,
    SubagentType,
)
from app.subagents.supervisor import SubagentSupervisor
from app.subagents.tools import (
    cancel_subagent_impl,
    delegate_research_impl,
    get_subagent_results_impl,
)


class _Sink:
    async def emit(self, **_kwargs: object) -> None:
        return None


class _BlockingRunner:
    def __init__(self) -> None:
        self.release = asyncio.Event()

    async def run(
        self,
        _request: SubagentRequest,
        *,
        subagent_id: str,
        task_id: str,
        run_id: str,
    ) -> SubagentResult:
        del task_id, run_id
        await self.release.wait()
        return SubagentResult(
            subagent_id=subagent_id,
            status=SubagentStatus.COMPLETED,
            summary="finished",
        )


def _research_request(source: str) -> SubagentRequest:
    return SubagentRequest(
        agent_type=SubagentType.SOURCE_RESEARCH,
        objective=f"Research {source}",
        target_source=source,
        domain=source,
        capability="source_research",
    )


@pytest.fixture
def agent_context(tmp_path):
    context = RunContext(
        task_id="task_delegate",
        managed_run_id="run_delegate",
        base_dir=tmp_path,
    )
    supervisor = SubagentSupervisor()
    runner = _BlockingRunner()
    context.bind_subagent_runtime(
        supervisor=supervisor,
        runner=runner,
        event_sink=_Sink(),
    )
    return context, supervisor, runner


@pytest.mark.asyncio
async def test_delegate_returns_handles_before_children_finish(agent_context) -> None:
    context, supervisor, runner = agent_context
    result = await delegate_research_impl(
        context,
        [_research_request("geo"), _research_request("arrayexpress")],
        parent_tool_call_id="call_delegate",
    )

    assert len(result.subagents) == 2
    assert {item.status for item in result.subagents} == {SubagentStatus.QUEUED}

    runner.release.set()
    await asyncio.gather(*(supervisor.wait(item.subagent_id) for item in result.subagents))


@pytest.mark.asyncio
async def test_get_subagent_results_returns_terminal_owned_results(agent_context) -> None:
    context, supervisor, runner = agent_context
    handles = await delegate_research_impl(
        context,
        [_research_request("geo")],
        parent_tool_call_id="call_lookup",
    )
    child_id = handles.subagents[0].subagent_id

    runner.release.set()
    await supervisor.wait(child_id)
    results = await get_subagent_results_impl(context, [child_id])

    assert results.subagents[0].subagent_id == child_id
    assert results.subagents[0].status is SubagentStatus.COMPLETED


@pytest.mark.asyncio
async def test_cancel_subagent_cancels_owned_child(agent_context) -> None:
    context, _supervisor, _runner = agent_context
    handles = await delegate_research_impl(
        context,
        [_research_request("geo")],
        parent_tool_call_id="call_cancel",
    )

    result = await cancel_subagent_impl(context, handles.subagents[0].subagent_id)

    assert result.status is SubagentStatus.CANCELLED


@pytest.mark.asyncio
async def test_result_and_cancel_reject_foreign_or_unknown_handles(agent_context, tmp_path) -> None:
    context, supervisor, runner = agent_context
    handles = await delegate_research_impl(
        context,
        [_research_request("geo")],
        parent_tool_call_id="call_foreign",
    )
    foreign_context = RunContext(
        task_id="other_task",
        managed_run_id="other_run",
        base_dir=tmp_path,
    )
    foreign_context.bind_subagent_runtime(
        supervisor=supervisor,
        runner=runner,
        event_sink=_Sink(),
    )
    child_id = handles.subagents[0].subagent_id

    with pytest.raises(PermissionError, match="does not belong"):
        await get_subagent_results_impl(foreign_context, [child_id])
    with pytest.raises(PermissionError, match="does not belong"):
        await cancel_subagent_impl(foreign_context, child_id)
    with pytest.raises(PermissionError, match="does not belong"):
        await get_subagent_results_impl(context, ["subagent_unknown"])

    runner.release.set()
    await supervisor.wait(child_id)
