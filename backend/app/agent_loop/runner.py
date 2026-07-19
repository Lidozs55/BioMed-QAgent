"""Durable Agent and fixture Run executors."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Mapping
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING

from agents import Runner
from agents.exceptions import MaxTurnsExceeded
from agents.stream_events import RawResponsesStreamEvent, RunItemStreamEvent

from app.agent_loop.agent import AGENT_MAX_TURNS, build_agent
from app.agent_loop.context import ManagedPipelineBridge
from app.domain.contracts import (
    ArtifactProducedPayload,
    AssistantDeltaPayload,
    AssistantReasoningDeltaPayload,
    CancelRequestedPayload,
    EventEnvelope,
    StageName,
    StageProgressPayload,
    TaskCompletedPayload,
    TaskMode,
    TaskState,
    ToolCompletedPayload,
    ToolStartedPayload,
    UserInputRequiredPayload,
    UserInputResumedPayload,
    WarningPayload,
    build_event,
)
from app.domain.contracts.runtime import validate_task_databases
from app.pipeline.runner import PendingPublicationCleanup, PipelineRunner
from app.pipeline.stages import PipelineCancelledError
from app.runtime.compaction import CompactionCancelledError, ConversationCompactor

if TYPE_CHECKING:
    from app.runtime.manager import RunExecution

logger = logging.getLogger(__name__)

ASSISTANT_FLUSH_INTERVAL_SECONDS = 0.1
ASSISTANT_FLUSH_MAX_BYTES = 1024
OFFICIAL_FIXTURE_DIR = (
    Path(__file__).parents[2] / "tests" / "fixtures" / "ncbi" / "gse178352"
)
#: 单次 Run 最多允许的 max_turns 暂停次数（防止无限续跑）。
MAX_TURNS_RESUME_LIMIT: int = 3
#: Qwen 偶发返回非 JSON 的 function.arguments 导致 400，最多重试次数。
QWEN_FUNCTION_ARGS_RETRY_LIMIT: int = 2


class _AssistantTextBuffer:
    def __init__(
        self,
        emit: Callable[[object], Awaitable[object]],
        *,
        max_bytes: int = ASSISTANT_FLUSH_MAX_BYTES,
        flush_interval: float = ASSISTANT_FLUSH_INTERVAL_SECONDS,
    ) -> None:
        self._emit = emit
        self._max_bytes = max_bytes
        self._flush_interval = flush_interval
        self._parts: list[str] = []
        self._byte_count = 0
        self._started_at: float | None = None

    async def add(self, delta: str) -> None:
        for character in delta:
            character_bytes = len(character.encode("utf-8"))
            if self._parts and self._byte_count + character_bytes > self._max_bytes:
                await self.flush()
            if not self._parts:
                self._started_at = asyncio.get_running_loop().time()
            self._parts.append(character)
            self._byte_count += character_bytes
            if self._byte_count == self._max_bytes:
                await self.flush()

    def seconds_until_flush(self) -> float | None:
        if self._started_at is None:
            return None
        elapsed = asyncio.get_running_loop().time() - self._started_at
        return max(0.0, self._flush_interval - elapsed)

    async def flush(self) -> None:
        if not self._parts:
            return
        delta = "".join(self._parts)
        self._parts.clear()
        self._byte_count = 0
        self._started_at = None
        await self._emit(AssistantDeltaPayload(delta=delta))


def _value(item: object, name: str, default: object = None) -> object:
    if isinstance(item, Mapping):
        return item.get(name, default)
    return getattr(item, name, default)


def _is_qwen_function_args_error(exc: BaseException) -> bool:
    """Detect Qwen/DashScope 400 errors caused by malformed function arguments.

    Qwen 偶发返回非 JSON 的 function.arguments，下次请求时 DashScope 返回:
    ``<400> InternalError.Algo.InvalidParameter: The "function.arguments"
    parameter of the code model must be in JSON format.``
    此类错误可重试:重新跑一遍 Run,Qwen 通常会生成合法 JSON。
    """
    message = str(exc)
    if "function.arguments" not in message:
        return False
    return (
        "must be in JSON format" in message
        or "InvalidParameter" in message
        or "invalid_parameter_error" in message
    )


def _tool_identity(item: object) -> tuple[str, str | None]:
    raw_item = _value(item, "raw_item", item)
    call_id = _value(raw_item, "call_id") or _value(raw_item, "id")
    if not isinstance(call_id, str) or not call_id:
        raise ValueError("tool stream item is missing call_id")
    name = _value(raw_item, "name")
    return call_id, name if isinstance(name, str) and name else None


class AgentRunExecutor:
    """Execute one manager-owned Run against its durable SDK session."""

    def __init__(self, repository, *, compactor=None) -> None:
        self._repository = repository
        self._compactor = compactor or ConversationCompactor(repository)

    @staticmethod
    async def _consume_events(
        execution,
        result,
        text_buffer: _AssistantTextBuffer,
    ) -> None:
        iterator = result.stream_events().__aiter__()
        pending_event: asyncio.Task | None = None
        tool_names: dict[str, str] = {}
        truncation_warned = False
        try:
            while True:
                if pending_event is None:
                    pending_event = asyncio.create_task(iterator.__anext__())
                done, _ = await asyncio.wait(
                    {pending_event},
                    timeout=text_buffer.seconds_until_flush(),
                )
                if not done:
                    await text_buffer.flush()
                    continue
                completed = pending_event
                pending_event = None
                try:
                    event = completed.result()
                except StopAsyncIteration:
                    return
                if isinstance(event, RawResponsesStreamEvent):
                    reasoning_delta = _extract_reasoning_delta(event.data)
                    if reasoning_delta:
                        await execution.emit(
                            AssistantReasoningDeltaPayload(delta=reasoning_delta)
                        )
                    text_delta = _extract_text_delta(event.data)
                    if text_delta:
                        logger.debug("[RAW] %s", text_delta)
                        await text_buffer.add(text_delta)
                    # 检测 LLM 截断:finish_reason="length" 时发射 warning
                    # (见 docs/REVIEW_2026-07-18.md §2)。
                    finish_reason = _extract_finish_reason(event.data)
                    if finish_reason:
                        logger.debug("[RAW_DONE] finish_reason=%s", finish_reason)
                    if (
                        finish_reason == "length"
                        and not truncation_warned
                    ):
                        truncation_warned = True
                        await text_buffer.flush()
                        await execution.emit(
                            WarningPayload(
                                code="llm_output_truncated",
                                message=(
                                    "LLM output was truncated due to max_tokens "
                                    "(finish_reason=length)"
                                ),
                            )
                        )
                    continue
                if not isinstance(event, RunItemStreamEvent):
                    continue
                if event.name == "tool_called":
                    await text_buffer.flush()
                    call_id, tool_name = _tool_identity(event.item)
                    resolved_name = tool_name or "unknown"
                    tool_names[call_id] = resolved_name
                    await execution.emit(
                        ToolStartedPayload(
                            tool_call_id=call_id,
                            tool_name=resolved_name,
                        )
                    )
                elif event.name == "tool_output":
                    await text_buffer.flush()
                    call_id, tool_name = _tool_identity(event.item)
                    raw_item = _value(event.item, "raw_item", event.item)
                    status = _value(raw_item, "status")
                    is_error = bool(
                        _value(event.item, "is_error", False)
                        or _value(raw_item, "is_error", False)
                        or status in {"error", "failed"}
                    )
                    await execution.emit(
                        ToolCompletedPayload(
                            tool_call_id=call_id,
                            tool_name=tool_name or tool_names.get(call_id, "unknown"),
                            output=str(_value(event.item, "output", "")),
                            is_error=is_error,
                        )
                    )
        finally:
            if pending_event is not None and not pending_event.done():
                pending_event.cancel()
                await asyncio.gather(pending_event, return_exceptions=True)

    async def __call__(self, execution) -> None:
        task_session = self._repository.task_session(
            execution.task_id,
            run_id=execution.run_id,
        )
        build = build_agent(execution.databases)
        text_buffer = _AssistantTextBuffer(execution.emit)
        bind_pipeline_bridge = getattr(
            execution.context,
            "bind_managed_pipeline_bridge",
            None,
        )
        if callable(bind_pipeline_bridge):

            async def persist_pipeline_event(event: EventEnvelope) -> None:
                if isinstance(event.payload, CancelRequestedPayload):
                    return
                if isinstance(
                    event.payload,
                    (ArtifactProducedPayload, TaskCompletedPayload),
                ):
                    return
                await execution.emit(
                    event.payload,
                    stage_attempt_id=event.stage_attempt_id,
                    timestamp=event.timestamp,
                )

            bind_pipeline_bridge(
                ManagedPipelineBridge(
                    run_id=execution.run_id,
                    event_sink=persist_pipeline_event,
                    install_user_input_submitter=execution.set_user_input_submitter,
                    clear_user_input_submitter=execution.clear_user_input_submitter,
                )
            )
        # Bind a progress emitter so Skills (search_pubmed, search_geo, ...)
        # can surface mid-stage numbers to the frontend via
        # RunContext.emit_progress. See docs/REVIEW_2026-07-18.md §4.
        bind_progress_emitter = getattr(
            execution.context,
            "bind_progress_emitter",
            None,
        )
        if callable(bind_progress_emitter):

            async def emit_progress(
                stage: StageName,
                kind: str,
                current: int,
                total: int | None,
                detail: dict[str, object],
            ) -> None:
                await execution.emit(
                    StageProgressPayload(
                        stage=stage,
                        kind=kind,
                        current=current,
                        total=total,
                        detail=detail,
                    )
                )

            bind_progress_emitter(emit_progress)
        try:
            preparation = await self._compactor.prepare(
                execution.task_id,
                model_handle=build.model,
                emit=execution.emit,
                session=task_session,
                cancellation_requested=execution.context.cancellation_requested,
                commit=execution.commit_compaction,
            )
            if execution.context.cancellation_requested.is_set():
                raise CompactionCancelledError(
                    "conversation compaction was cancelled before Agent Run"
                )
            # Agent 循环：每次 Runner.run_streamed 消耗 max_turns 个 turn；
            # 若 SDK 抛 MaxTurnsExceeded，发射 UserInputRequiredPayload 走
            # pause-resume，用户选"继续"则用 result.to_input_list() 续跑。
            # See docs/REVIEW_2026-07-18.md §11.
            agent_input: str | list = execution.input
            result = None
            resume_count = 0
            qwen_retry_count = 0
            while True:
                # reset_streaming_result 让续跑的 Runner.run_streamed 能挂载新的
                # RunResultStreaming (上一轮已 exhausted),保持 cancel 通道对准
                # 当前活跃的 SDK run。首轮为 no-op (_streaming_result 本就为 None)。
                execution.reset_streaming_result()
                result = Runner.run_streamed(
                    build.agent,
                    agent_input,
                    context=execution.context,
                    session=preparation.session,
                    max_turns=AGENT_MAX_TURNS,
                )
                execution.set_streaming_result(result)
                try:
                    await self._consume_events(execution, result, text_buffer)
                except MaxTurnsExceeded:
                    await text_buffer.flush()
                    if resume_count >= MAX_TURNS_RESUME_LIMIT:
                        raise RuntimeError(
                            f"agent exceeded max_turns resume limit "
                            f"({MAX_TURNS_RESUME_LIMIT} times)"
                        ) from None
                    decision = await self._await_max_turns_resume(
                        execution,
                        resume_count=resume_count,
                    )
                    if decision.decision == "reject":
                        raise PipelineCancelledError(
                            "agent run cancelled by user after max_turns reached"
                        ) from None
                    resume_count += 1
                    # 用上一轮的 to_input_list() 续跑，保留完整上下文。
                    agent_input = result.to_input_list()
                    continue
                except Exception as exc:
                    # Qwen 偶发返回非 JSON 的 function.arguments 导致 400。
                    # 重试时用原始 execution.input 从头跑,Qwen 通常会生成合法 JSON。
                    # See docs/REVIEW_2026-07-18.md §3.
                    if (
                        _is_qwen_function_args_error(exc)
                        and qwen_retry_count < QWEN_FUNCTION_ARGS_RETRY_LIMIT
                    ):
                        qwen_retry_count += 1
                        await text_buffer.flush()
                        await execution.emit(
                            WarningPayload(
                                code="llm_function_args_retry",
                                message=(
                                    f"LLM returned malformed function arguments "
                                    f"(400); retrying Run "
                                    f"({qwen_retry_count}/"
                                    f"{QWEN_FUNCTION_ARGS_RETRY_LIMIT})"
                                ),
                            )
                        )
                        # 从原始用户输入重新开始,避免把 malformed tool call
                        # 带入下一轮 conversation history 再次触发 400。
                        agent_input = execution.input
                        continue
                    raise
                finally:
                    await text_buffer.flush()
                break
            # final_output 校验:若 Agent 未产出有效输出则抛异常,
            # 避免 LLM 截断/不调 tool 时静默 completed。
            # 见 docs/REVIEW_2026-07-18.md §2。
            # 用 getattr 安全访问:mock result 可能没有 final_output 属性,
            # 此时跳过校验(测试场景由测试自身保证语义)。
            if not execution.context.cancellation_requested.is_set():
                final_output = getattr(result, "final_output", None)
                if isinstance(final_output, str) and not final_output.strip():
                    raise RuntimeError(
                        "agent returned empty final_output; "
                        "refusing to silently complete without output"
                    )
                # 真实 SDK result 有 final_output 属性，标记 agent_executed
                # 让 manager 的成功证据校验生效。
                if hasattr(result, "final_output"):
                    execution.mark_agent_executed()
        finally:
            terminal_error: BaseException | None = None
            try:
                await self._transfer_pending_publication(execution)
                take_terminal_error = getattr(
                    execution.context,
                    "take_managed_terminal_error",
                    None,
                )
                if callable(take_terminal_error):
                    terminal_error = take_terminal_error()
            finally:
                await build.model.close()
            if terminal_error is not None:
                raise terminal_error

    @staticmethod
    async def _await_max_turns_resume(
        execution: RunExecution,
        *,
        resume_count: int,
    ) -> UserInputResumedPayload:
        """Pause the Agent Run after max_turns and wait for user decision.

        Reuses the manager's pause-resume infrastructure: registers a
        ``UserInputSubmitter`` that unblocks an ``asyncio.Event``, emits
        ``UserInputRequiredPayload(prompt_kind="max_turns_reached")`` (which
        transitions the Run to ``AWAITING_USER_INPUT``), and waits for
        ``POST /runs/{run_id}/resume``. See docs/REVIEW_2026-07-18.md §11.
        """

        request_id = f"max_turns-{execution.run_id}-{resume_count}"
        event: asyncio.Event = asyncio.Event()
        decision_holder: list[UserInputResumedPayload] = []

        def submitter(payload: UserInputResumedPayload) -> bool:
            if payload.request_id != request_id:
                return False
            decision_holder.append(payload)
            event.set()
            return True

        execution.set_user_input_submitter(submitter)
        try:
            await execution.emit(
                UserInputRequiredPayload(
                    request_id=request_id,
                    prompt_kind="max_turns_reached",
                    summary=(
                        f"Agent 已达到最大轮次 ({AGENT_MAX_TURNS})，是否继续工作？"
                    ),
                    detail={
                        "max_turns": AGENT_MAX_TURNS,
                        "resume_count": resume_count,
                        "resume_limit": MAX_TURNS_RESUME_LIMIT,
                    },
                )
            )
            await event.wait()
        finally:
            execution.clear_user_input_submitter(submitter)

        if not decision_holder:
            raise RuntimeError("max_turns resume event set without a decision")
        # Mirror the pipeline: emit UserInputResumedPayload after waking so the
        # reducer transitions AWAITING_USER_INPUT -> RUNNING before the manager
        # emits RunFinalizingPayload (RUNNING -> FINALIZING).
        await execution.emit(decision_holder[0])
        return decision_holder[0]

    @staticmethod
    async def _transfer_pending_publication(execution: RunExecution) -> None:
        take_pending = getattr(execution.context, "take_pending_publication", None)
        if not callable(take_pending):
            return
        pending = take_pending()
        if pending is None:
            # Agent 未产出 pending publication(未调 tool 或 tool 未产出 artifact)。
            # 发射 warning 让用户知道无 artifact 产出。
            # manager 的成功证据校验会把空 completion_events 转 RunFailed
            # (见 docs/REVIEW_2026-07-18.md §1)。
            if (
                not execution.context.cancellation_requested.is_set()
                and execution.agent_executed
            ):
                await execution.emit(
                    WarningPayload(
                        code="artifact_manifest_missing",
                        message=(
                            "agent completed but no pending publication "
                            "was produced (manifest missing)"
                        ),
                    )
                )
            return
        if isinstance(pending, PendingPublicationCleanup):
            try:
                if pending.run_id != execution.run_id:
                    raise RuntimeError(
                        "pending publication run_id does not match execution"
                    )

                async def abort_agent_cleanup() -> None:
                    await _run_sync_operation(pending.abort)

                execution.set_completion_cleanup(abort_agent_cleanup)
            except BaseException:
                await _run_sync_operation(pending.abort)
                raise
            raise pending.error
        try:
            if pending.run_id != execution.run_id:
                raise RuntimeError("pending publication run_id does not match execution")
            payloads = [
                ArtifactProducedPayload(artifact=pending.manifest_entry),
                *(
                    ArtifactProducedPayload(artifact=artifact)
                    for artifact in pending.manifest.artifacts
                ),
            ]

            async def commit_agent_artifacts() -> list[EventEnvelope]:
                await _run_sync_operation(pending.publish)
                return [
                    build_event(
                        task_id=execution.task_id,
                        run_id=execution.run_id,
                        sequence=index,
                        payload=payload,
                    )
                    for index, payload in enumerate(payloads, start=1)
                ]

            async def abort_agent_artifacts() -> None:
                await _run_sync_operation(pending.abort)

            execution.set_completion_operations(
                commit_agent_artifacts,
                abort_agent_artifacts,
            )
        except BaseException:
            await _run_sync_operation(pending.abort)
            raise


async def _run_sync_operation[ResultT](
    operation: Callable[[], ResultT],
) -> ResultT:
    worker_task = asyncio.create_task(asyncio.to_thread(operation))
    try:
        return await asyncio.shield(worker_task)
    except asyncio.CancelledError:
        while not worker_task.done():
            try:
                await asyncio.shield(worker_task)
            except asyncio.CancelledError:
                continue
            except BaseException:
                break
        if not worker_task.cancelled():
            worker_task.exception()
        raise


async def _run_pipeline_with_cancellation(execution, runner):
    """Await an async PipelineRunner while draining it after cancellation."""

    worker_task = asyncio.create_task(runner.run())
    try:
        return await asyncio.shield(worker_task)
    except asyncio.CancelledError:
        execution.context.cancellation_requested.set()
        while not worker_task.done():
            try:
                await asyncio.shield(worker_task)
            except asyncio.CancelledError:
                continue
            except BaseException:
                break
        if not worker_task.cancelled():
            worker_task.exception()
        raise


def _check_fixture_bridge_cancellation(execution) -> None:
    if execution.context.cancellation_requested.is_set():
        raise PipelineCancelledError("fixture pipeline was cancelled")


class FixtureRunExecutor:
    """Run the deterministic PipelineRunner and bridge its v1 audit events."""

    def __init__(
        self,
        repository,
        *,
        fixture_dir: Path = OFFICIAL_FIXTURE_DIR,
        pipeline_runner_factory=PipelineRunner,
    ) -> None:
        self._repository = repository
        self._fixture_dir = fixture_dir
        self._pipeline_runner_factory = pipeline_runner_factory

    async def __call__(self, execution) -> None:
        validate_task_databases(execution.mode, execution.databases)
        await self._repository.task_session(execution.task_id).add_run_input_once(
            execution.run_id,
            execution.input,
        )
        streamed_event_ids: set[str] = set()
        completion_events: list[EventEnvelope] = []

        async def persist_pipeline_event(event: EventEnvelope) -> None:
            if event.event_id in streamed_event_ids:
                return
            if isinstance(event.payload, CancelRequestedPayload):
                streamed_event_ids.add(event.event_id)
                return
            if isinstance(
                event.payload,
                (ArtifactProducedPayload, TaskCompletedPayload),
            ):
                completion_events.append(event)
            else:
                await execution.emit(
                    event.payload,
                    stage_attempt_id=event.stage_attempt_id,
                    timestamp=event.timestamp,
                )
            streamed_event_ids.add(event.event_id)

        runner = self._pipeline_runner_factory(
            task_id=execution.task_id,
            base_dir=self._repository.tasks_dir,
            fixture_dir=self._fixture_dir,
            topic=execution.input,
            cancellation_requested=execution.context.cancellation_requested,
            defer_publication=True,
            run_id=execution.run_id,
        )
        abort = getattr(runner, "abort", None)
        transferred = False
        set_event_sink = getattr(runner, "set_event_sink", None)
        streams_events = callable(set_event_sink)
        if callable(set_event_sink):
            set_event_sink(persist_pipeline_event)
        submitter = getattr(runner, "submit_user_input", None)
        if callable(submitter):
            execution.set_user_input_submitter(submitter)
        try:
            manifest = await _run_pipeline_with_cancellation(execution, runner)
            if not streams_events:
                for event in list(runner.events):
                    await persist_pipeline_event(event)
            if manifest.task_state is TaskState.CANCELLED:
                raise PipelineCancelledError("fixture pipeline was cancelled")
            if manifest.task_state is TaskState.FAILED:
                raise RuntimeError("fixture pipeline failed validation or execution")
            _check_fixture_bridge_cancellation(execution)

            pending_factory = getattr(runner, "pending_publication", None)
            pending = pending_factory() if callable(pending_factory) else None
            publish = pending.publish if pending is not None else getattr(
                runner,
                "publish",
                None,
            )
            abort = pending.abort if pending is not None else abort
            if pending is not None:
                completion_events.insert(
                    0,
                    build_event(
                        task_id=execution.task_id,
                        run_id=execution.run_id,
                        sequence=1,
                        payload=ArtifactProducedPayload(
                            artifact=pending.manifest_entry
                        ),
                    ),
                )
            if callable(publish) or completion_events or callable(abort):

                async def commit_fixture_completion() -> list[EventEnvelope]:
                    if callable(publish):
                        operation = (
                            publish
                            if pending is not None
                            else partial(publish, execution.run_id)
                        )
                        await _run_sync_operation(operation)
                    return completion_events

                async def abort_fixture_completion() -> None:
                    if callable(abort):
                        await _run_sync_operation(abort)

                execution.set_completion_operations(
                    commit_fixture_completion,
                    abort_fixture_completion,
                )
                transferred = True
        except BaseException:
            if not transferred and callable(abort):
                try:
                    await _run_sync_operation(abort)
                except BaseException:

                    async def abort_fixture_cleanup() -> None:
                        await _run_sync_operation(abort)

                    execution.set_completion_cleanup(abort_fixture_cleanup)
                    transferred = True
                    raise
            raise


class ModeDispatchRunExecutor:
    """Delegate authoritative Task modes to their focused executors."""

    def __init__(self, repository) -> None:
        self.agent_executor = AgentRunExecutor(repository)
        self.fixture_executor = FixtureRunExecutor(repository)

    async def __call__(self, execution) -> None:
        if execution.mode is TaskMode.AGENT:
            await self.agent_executor(execution)
            return
        if execution.mode is TaskMode.FIXTURE:
            await self.fixture_executor(execution)
            return
        raise ValueError(f"unsupported task mode: {execution.mode}")


def _extract_text_delta(data) -> str | None:
    """从 ChatCompletions 原始事件中安全提取文本 delta。

    DashScope/Qwen 走 Chat Completions 路径，原始事件为 ChatCompletionChunk，
    结构为 chunk.choices[0].delta.content。不推送 role 或空 delta。
    """
    event_type = getattr(data, "type", None)
    if isinstance(event_type, str) and "reasoning" in event_type:
        return None
    direct_delta = getattr(data, "delta", None)
    if isinstance(direct_delta, str) and direct_delta:
        return direct_delta
    choices = getattr(data, "choices", None)
    if not choices:
        return None
    delta = getattr(choices[0], "delta", None)
    if delta is None:
        return None
    content = getattr(delta, "content", None)
    if content:
        return content
    return None


def _extract_reasoning_delta(data) -> str | None:
    event_type = getattr(data, "type", None)
    direct_delta = getattr(data, "delta", None)
    if (
        isinstance(event_type, str)
        and "reasoning" in event_type
        and isinstance(direct_delta, str)
        and direct_delta
    ):
        return direct_delta
    choices = getattr(data, "choices", None)
    if choices:
        delta = getattr(choices[0], "delta", None)
        reasoning = getattr(delta, "reasoning_content", None)
        if isinstance(reasoning, str) and reasoning:
            return reasoning
        reasoning = getattr(delta, "reasoning", None)
        if isinstance(reasoning, str) and reasoning:
            return reasoning
    direct_reasoning = getattr(data, "reasoning_content", None)
    if isinstance(direct_reasoning, str) and direct_reasoning:
        return direct_reasoning
    return None


def _extract_finish_reason(data) -> str | None:
    """从 ChatCompletions 原始事件中提取 finish_reason。

    DashScope/Qwen 走 Chat Completions 路径，finish_reason 位于
    chunk.choices[0].finish_reason。SDK 在 finish_reason="length" 时
    不抛异常，把 partial content 当 final_output 返回，因此需要
    主动检测并发射 warning（见 docs/REVIEW_2026-07-18.md §2）。
    """
    choices = getattr(data, "choices", None)
    if not choices:
        return None
    finish_reason = getattr(choices[0], "finish_reason", None)
    if isinstance(finish_reason, str) and finish_reason:
        return finish_reason
    return None
