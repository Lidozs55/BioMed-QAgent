"""Durable Agent and fixture Run executors."""

from __future__ import annotations

import asyncio
import hashlib
from functools import partial
from pathlib import Path
from collections.abc import Awaitable, Callable, Mapping
from typing import TypeVar

from agents import Runner
from agents.stream_events import RawResponsesStreamEvent, RunItemStreamEvent

from app.agent_loop.agent import build_agent
from app.domain.contracts import (
    AssistantDeltaPayload,
    ArtifactManifestEntry,
    ArtifactProducedPayload,
    EventEnvelope,
    RunManifest,
    TaskMode,
    ToolCompletedPayload,
    ToolStartedPayload,
)
from app.domain.contracts.runtime import validate_task_databases
from app.pipeline.pinned_case import PipelineCancelledError, run_pinned_fixture
from app.runtime.compaction import CompactionCancelledError, ConversationCompactor

ASSISTANT_FLUSH_INTERVAL_SECONDS = 0.1
ASSISTANT_FLUSH_MAX_BYTES = 1024
OFFICIAL_FIXTURE_DIR = (
    Path(__file__).parents[2] / "tests" / "fixtures" / "ncbi" / "gse178352"
)
_FixtureSyncResult = TypeVar("_FixtureSyncResult")


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


def _tool_identity(item: object) -> tuple[str, str | None]:
    raw_item = _value(item, "raw_item", item)
    call_id = _value(raw_item, "call_id") or _value(raw_item, "id")
    if not isinstance(call_id, str) or not call_id:
        raise ValueError("tool stream item is missing call_id")
    name = _value(raw_item, "name")
    return call_id, name if isinstance(name, str) and name else None


def _artifact_manifest_fingerprint(output_dir: Path, task_id: str) -> str | None:
    manifest_path = output_dir / "tasks" / task_id / "artifacts" / "run_manifest.json"
    if not manifest_path.is_file():
        return None
    return hashlib.sha256(manifest_path.read_bytes()).hexdigest()


def _load_artifact_payloads(
    output_dir: Path,
    task_id: str,
    *,
    previous_fingerprint: str | None = None,
) -> list[object]:
    manifest_path = output_dir / "tasks" / task_id / "artifacts" / "run_manifest.json"
    if not manifest_path.is_file():
        return []
    manifest_bytes = manifest_path.read_bytes()
    manifest_fingerprint = hashlib.sha256(manifest_bytes).hexdigest()
    if manifest_fingerprint == previous_fingerprint:
        return []
    manifest = RunManifest.model_validate_json(manifest_bytes)
    manifest_entry = ArtifactManifestEntry(
        artifact_id="run_manifest",
        name="run_manifest.json",
        relative_path="artifacts/run_manifest.json",
        media_type="application/json",
        size_bytes=len(manifest_bytes),
        sha256=hashlib.sha256(manifest_bytes).hexdigest(),
        generated_by_step_id="step_artifact_builder_v1",
    )
    return [
        ArtifactProducedPayload(artifact=manifest_entry),
        *(
            ArtifactProducedPayload(artifact=artifact)
            for artifact in manifest.artifacts
        ),
    ]


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
                    text_delta = _extract_text_delta(event.data)
                    if text_delta:
                        await text_buffer.add(text_delta)
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
        task_session = self._repository.task_session(execution.task_id)
        build = build_agent(execution.databases)
        text_buffer = _AssistantTextBuffer(execution.emit)
        output_dir_value = getattr(self._repository, "output_dir", None)
        output_dir = Path(output_dir_value) if output_dir_value is not None else None
        try:
            previous_manifest_fingerprint = (
                await asyncio.to_thread(
                    _artifact_manifest_fingerprint,
                    output_dir,
                    execution.task_id,
                )
                if output_dir is not None
                else None
            )
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
            result = Runner.run_streamed(
                build.agent,
                execution.input,
                context=execution.context,
                session=preparation.session,
            )
            execution.set_streaming_result(result)
            try:
                await self._consume_events(execution, result, text_buffer)
            finally:
                await text_buffer.flush()
            if (
                output_dir is not None
                and not execution.context.cancellation_requested.is_set()
            ):
                payloads = await asyncio.to_thread(
                    _load_artifact_payloads,
                    output_dir,
                    execution.task_id,
                    previous_fingerprint=previous_manifest_fingerprint,
                )
                for payload in payloads:
                    if execution.context.cancellation_requested.is_set():
                        break
                    await execution.emit(payload)
        finally:
            await build.model.close()


def _load_fixture_events(path: Path) -> list[EventEnvelope]:
    return [
        EventEnvelope.model_validate_json(line)
        for line in path.read_text("utf-8").splitlines()
        if line.strip()
    ]


async def _run_fixture_sync(
    execution,
    operation: Callable[[], _FixtureSyncResult],
) -> _FixtureSyncResult:
    worker_task = asyncio.create_task(asyncio.to_thread(operation))
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
    """Run the official pinned fixture and bridge its v1 audit events."""

    def __init__(self, repository, *, fixture_dir: Path = OFFICIAL_FIXTURE_DIR) -> None:
        self._repository = repository
        self._fixture_dir = fixture_dir

    async def __call__(self, execution) -> None:
        validate_task_databases(execution.mode, execution.databases)
        await self._repository.task_session(execution.task_id).add_run_input_once(
            execution.run_id,
            execution.input,
        )
        await _run_fixture_sync(
            execution,
            partial(
                run_pinned_fixture,
                task_id=execution.task_id,
                base_dir=self._repository.tasks_dir,
                fixture_dir=self._fixture_dir,
                topic=execution.input,
                cancellation_requested=execution.context.cancellation_requested,
            ),
        )
        _check_fixture_bridge_cancellation(execution)
        legacy_events = await _run_fixture_sync(
            execution,
            partial(
                _load_fixture_events,
                self._repository.tasks_dir
                / execution.task_id
                / "logs"
                / "events.jsonl",
            ),
        )
        for event in legacy_events:
            _check_fixture_bridge_cancellation(execution)
            await execution.emit(
                event.payload,
                stage_attempt_id=event.stage_attempt_id,
                timestamp=event.timestamp,
            )


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
    choices = getattr(data, "choices", None)
    if not choices:
        return None
    delta = getattr(choices[0], "delta", None)
    if delta is None:
        return None
    content = getattr(delta, "content", None)
    if content:
        return content
    # Responses API 路径（OpenAI 原生模型）可能直接有 delta 属性
    direct_delta = getattr(data, "delta", None)
    if direct_delta:
        return direct_delta
    return None
