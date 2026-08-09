"""Durable Agent and fixture Run executors."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import shutil
import time
from collections.abc import Awaitable, Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from agents import Runner
from agents.exceptions import MaxTurnsExceeded
from agents.stream_events import RawResponsesStreamEvent, RunItemStreamEvent
from agents.tool_context import ToolContext

from app.agent_loop.agent import (
    AGENT_MAX_TURNS as AGENT_MAX_TURNS,  # noqa: F401 — 测试契约 re-export
)
from app.agent_loop.agent import AgentBuild, build_agent, resolve_agent_max_turns
from app.agent_loop.context import (
    ManagedPipelineBridge,
    PendingDatasetBuild,
    PendingPublicationCleanup,
    RunContext,
)
from app.agent_loop.import_agent import (
    ATTACHMENT_PARSING_MAX_TURNS,
    build_attachment_parsing_agent,
)
from app.agent_loop.invocation import (
    InvocationPreflight,
    record_calibration_from_result,
)
from app.agent_loop.main_input_broker import MainInputBroker
from app.agent_loop.model import run_model_settings_scope, to_run_model_settings
from app.domain.contracts import (
    ArtifactProducedPayload,
    AssistantDeltaPayload,
    AssistantReasoningDeltaPayload,
    AssistantStreamDeltaFrame,
    AssistantStreamEndFrame,
    CancelRequestedPayload,
    EventEnvelope,
    OperationProgressPayload,
    PublicationCreatedPayload,
    StageName,
    StageProgressPayload,
    TaskCompletedPayload,
    TaskMode,
    ToolCompletedPayload,
    ToolStartedPayload,
    UserInputRequiredPayload,
    UserInputResumedPayload,
    WarningPayload,
    build_event,
    stage_operation_spec,
)
from app.domain.contracts.dataset_state import BuildResultStatus
from app.domain.contracts.runtime import validate_task_databases
from app.model_config import RunModelSettings
from app.model_config.token_estimation import (
    ChatCompletionsPromptShape,
    ChatCompletionsStructuralPolicy,
)
from app.model_settings import get_current_model_configuration
from app.pipeline.dataset_build_tool import execute_dataset_build
from app.runtime.compaction import CompactionCancelledError, ConversationCompactor
from app.skills.catalog import SkillCatalog
from app.subagents.agents import ManagedChildAgentRunner

if TYPE_CHECKING:
    from app.subagents.input_broker import SubagentInputBroker
    from app.subagents.supervisor import SubagentEventSink, SubagentSupervisor

if TYPE_CHECKING:
    from app.runtime.manager import RunExecution

logger = logging.getLogger(__name__)

ASSISTANT_FLUSH_INTERVAL_SECONDS = 0.1
ASSISTANT_FLUSH_MAX_BYTES = 1024
OFFICIAL_FIXTURE_DIR = (
    Path(__file__).parents[2] / "tests" / "fixtures" / "ncbi" / "gse178352"
)
#: 单次 Run 最多允许的 max_turns 暂停次数（默认 3）。
#: 硬上限 = (max_turns_resume_limit + 1) × agent_max_turns = 4 × 240 = 960 轮。
MAX_TURNS_RESUME_LIMIT: int = 3
#: Qwen 偶发返回非 JSON 的 function.arguments 导致 400，最多重试次数。
QWEN_FUNCTION_ARGS_RETRY_LIMIT: int = 2


def resolve_max_turns_resume_limit(
    model_settings: RunModelSettings | None = None,
) -> int:
    """Return the configured max_turns resume limit (default 3)."""

    from app.model_settings import get_runtime_limits

    if model_settings is not None:
        return model_settings.runtime_limits.max_turns_resume_limit
    return get_runtime_limits().max_turns_resume_limit


class _AgentRunCancelled(RuntimeError):
    """Agent run cancelled by a user decision (no-progress or max-turns reject)."""


class NoProgressDetected(Exception):
    """Raised when the no-progress detector fires inside one Agent Run."""

    def __init__(
        self,
        *,
        tool_name: str,
        args_hash: str,
        occurrences: int,
        window_seconds: float,
    ) -> None:
        super().__init__(
            f"no-progress detected: {tool_name} repeated {occurrences}x "
            f"within {window_seconds:g}s"
        )
        self.tool_name = tool_name
        self.args_hash = args_hash
        self.occurrences = occurrences
        self.window_seconds = window_seconds


class NoProgressDetector:
    """Sliding-window detector for dense repeats of the same tool call.

    Semantics (docs/REVIEW_2026-07-31 §7, user-confirmed):
    - Only ``large-volume short-time dense repeats`` count: the same
      ``(tool_name, args_hash)`` fingerprint seen >= threshold times within
      a sliding window triggers.
    - Long gaps do NOT count: if the gap between two same-fingerprint calls
      exceeds the window, earlier occurrences are discarded (it may be a
      re-check of prior work).
    - A user instruction between two calls resets the count (the calls may be
      user-directed, not a loop).
    """

    def __init__(self, *, window_seconds: float, threshold: int) -> None:
        self._window = window_seconds
        self._threshold = threshold
        self._fingerprints: dict[tuple[str, str], list[float]] = {}
        self._fired: set[tuple[str, str]] = set()

    def reset(self) -> None:
        """Discard all counts (a user instruction arrived between calls)."""

        self._fingerprints.clear()

    def record(self, tool_name: str, args_hash: str, now: float | None = None) -> int | None:
        """Record one tool call; return occurrence count when the threshold
        is crossed, else ``None``. Each fingerprint fires at most once per Run."""

        now = time.monotonic() if now is None else now
        key = (tool_name, args_hash)
        if key in self._fired:
            return None
        stamps = self._fingerprints.setdefault(key, [])
        # Drop occurrences outside the sliding window. If the gap since the
        # last same-fingerprint call exceeds the window, the whole count is
        # discarded (long interval = plausible re-check, not a dense repeat).
        stamps[:] = [ts for ts in stamps if now - ts <= self._window]
        stamps.append(now)
        if len(stamps) >= self._threshold:
            self._fired.add(key)
            return len(stamps)
        return None

# 流式 JSON 截断配置
#: 检测到行首 ``{`` 后，缓冲可疑 JSON 的最大字节数。超过则认定非工具参数
#: JSON，作为普通文本补发，避免长文本被无谓延迟。
ASSISTANT_JSON_SUSPECT_MAX_BYTES: int = 65536
#: Markdown 代码围栏标记（``` 或 ~~~），用于禁用行首 ``{`` 的 JSON 检测。
_CODE_FENCE_RE = re.compile(r"```|~~~")
#: 行首 ``{`` 模式（换行后允许可选空白再 ``{``），用于触发 JSON 可疑模式。
_JSON_START_RE = re.compile(r"\n[ \t]*\{")


class JsonSuspectBuffer:
    """State machine that buffers text starting with a line-head ``{``.

    Qwen 等 LLM 在 function_call 前会把参数 JSON 作为 text_delta 输出。
    检测到行首 ``{``（非代码围栏内）时进入可疑模式，缓冲后续内容不发出，
    直到 ``finalize`` 根据 finish_reason 判断丢弃（tool_call 或合法 JSON）
    或补发（非 JSON 文本）。详见 docs/REVIEW_2026-07-20-llm-output-hygiene.md。

    The ``add``/``end`` orchestration (trigger detection, code-fence tracking,
    segment rotation) lives in ``_AssistantTextBuffer``; this class owns only
    the suspect buffering state and the discard/resend decision.
    """

    def __init__(
        self,
        *,
        flush_callback: Callable[[str], Awaitable[None]],
        max_bytes: int = ASSISTANT_JSON_SUSPECT_MAX_BYTES,
    ) -> None:
        self._flush_callback = flush_callback
        self._max_bytes = max_bytes
        self._active: bool = False
        self._parts: list[str] = []
        self._bytes: int = 0

    @property
    def active(self) -> bool:
        return self._active

    def activate(self) -> None:
        """Enter suspect buffering mode (subsequent ``add`` calls buffer)."""
        self._active = True

    async def add(self, delta: str) -> None:
        """将 delta 累积到可疑 JSON 缓冲，超限时作为普通文本补发。"""
        self._parts.append(delta)
        self._bytes += len(delta.encode("utf-8"))
        if self._bytes >= self._max_bytes:
            await self._flush_as_text()

    async def _flush_as_text(self) -> None:
        """将可疑 JSON 缓冲作为普通文本补发（认定非工具参数 JSON）。"""
        text = "".join(self._parts)
        self._parts = []
        self._bytes = 0
        self._active = False
        if text:
            await self._flush_callback(text)

    async def finalize(self, finish_reason: str) -> None:
        """At segment end, decide discard vs resend.

        - ``tool_call``: 确认是工具参数 JSON，丢弃。
        - 合法 JSON (dict/list): 模型把 JSON 当文本输出，丢弃。
        - 非 JSON 文本: 作为普通文本补发到当前 segment。
        """
        if not self._active:
            return
        text = "".join(self._parts)
        self._parts = []
        self._bytes = 0
        self._active = False
        if finish_reason == "tool_call":
            return  # 确认是工具参数 JSON，丢弃
        if not text:
            return
        is_json = False
        try:
            parsed = json.loads(text)
            if isinstance(parsed, (dict, list)):
                is_json = True
        except json.JSONDecodeError:
            pass
        if not is_json:
            # 非 JSON 文本，补发到当前 segment
            await self._flush_callback(text)


class _AssistantTextBuffer:
    def __init__(
        self,
        execution: RunExecution,
        *,
        max_bytes: int = ASSISTANT_FLUSH_MAX_BYTES,
        flush_interval: float = ASSISTANT_FLUSH_INTERVAL_SECONDS,
    ) -> None:
        if max_bytes < 1:
            raise ValueError("max_bytes must be positive")
        bound_execution = getattr(execution, "__self__", None)
        if bound_execution is not None:
            execution = bound_execution
        self._execution = execution
        self._max_bytes = max_bytes
        self._flush_interval = flush_interval
        self._parts: list[str] = []
        self._byte_count = 0
        self._started_at: float | None = None
        self._base_stream_id = f"assistant:{execution.run_id}"
        self._segment_index = 0
        self._stream_id = self._base_stream_id
        self._next_chunk_index = 0
        self._from_chunk_index: int | None = None
        self._through_chunk_index: int | None = None
        self._segment_active = False
        self._has_ended = False
        # 流式 JSON 截断状态机：检测到行首 `{`（非代码围栏内）时进入可疑模式，
        # 缓冲后续内容不发出，直到 end() 根据 finish_reason 判断丢弃
        # （tool_call 或合法 JSON）或补发（非 JSON 文本）。
        # 详见 docs/REVIEW_2026-07-20-llm-output-hygiene.md。
        self._json_suspect = JsonSuspectBuffer(flush_callback=self._add_raw)
        # Markdown 代码围栏状态（跨 chunk 检测）
        self._in_code_fence: bool = False
        self._code_fence_tail: str = ""
        # 已发出文本的最后一个字符（用于跨 chunk 检测 `\n{` 模式）
        self._last_emitted_char: str = ""

    async def add(self, delta: str) -> None:
        if not delta:
            return
        if self._json_suspect.active:
            await self._json_suspect.add(delta)
            return
        # 更新代码围栏状态（跨 chunk 检测 ```` ``` ````）
        self._update_code_fence_state(delta)
        # 检测行首 `{`（非代码围栏内）触发 JSON 可疑模式
        trigger_index = self._find_json_trigger(delta)
        if trigger_index < 0:
            await self._add_raw(delta)
            return
        before = delta[:trigger_index]
        after = delta[trigger_index:]
        if before:
            await self._add_raw(before)
        # 进入缓冲模式前先结束当前 segment，让前端显示"正在思考..."提示。
        # 缓冲结束后若补发文本会创建新 segment（_has_ended=True 触发轮转）。
        if self._segment_active:
            await self.end("tool_call_pending")
        self._json_suspect.activate()
        await self._json_suspect.add(after)

    def _update_code_fence_state(self, delta: str) -> None:
        """更新代码围栏状态，跨 chunk 检测 ```` ``` ```` 和 ``~~`` 标记。"""
        combined = self._code_fence_tail + delta
        tail_len = len(self._code_fence_tail)
        for match in _CODE_FENCE_RE.finditer(combined):
            # 跳过完全落在 tail 内的匹配（上次已处理）
            if match.end() <= tail_len:
                continue
            self._in_code_fence = not self._in_code_fence
        # 保留最后 2 字符用于跨 chunk 检测 3 字符围栏标记
        self._code_fence_tail = combined[-2:] if len(combined) >= 2 else combined

    def _find_json_trigger(self, delta: str) -> int:
        """检测行首 ``{`` 触发位置（非代码围栏内）。

        返回 ``{`` 在 delta 中的索引，未触发返回 -1。
        触发条件：
        - delta 以 ``{`` 开头，且上文以换行结尾或为 segment 开头；或
        - delta 中存在 ``\\n[ \\t]*{`` 模式。
        - 不在代码围栏内。
        """
        if self._in_code_fence:
            return -1
        if delta.startswith("{") and self._last_emitted_char in ("", "\n"):
            return 0
        match = _JSON_START_RE.search(delta)
        if match:
            return match.end() - 1  # ``{`` 的索引
        return -1

    async def _add_raw(self, delta: str) -> None:
        """原始 add 逻辑：发出 live stream 帧并累积到 durable 缓冲。"""
        chunks = self._split_delta(delta)
        if self._has_ended:
            self._segment_index += 1
            self._stream_id = f"{self._base_stream_id}:{self._segment_index}"
            self._next_chunk_index = 0
            self._has_ended = False
        for chunk in chunks:
            chunk_bytes = len(chunk.encode("utf-8"))
            if self._parts and self._byte_count + chunk_bytes > self._max_bytes:
                await self.flush()
            chunk_index = self._next_chunk_index
            await self._execution.emit_assistant_stream(
                AssistantStreamDeltaFrame(
                    task_id=self._execution.task_id,
                    run_id=self._execution.run_id,
                    stream_id=self._stream_id,
                    chunk_index=chunk_index,
                    delta=chunk,
                )
            )
            self._next_chunk_index += 1
            if not self._parts:
                self._started_at = asyncio.get_running_loop().time()
                self._from_chunk_index = chunk_index
            self._parts.append(chunk)
            self._through_chunk_index = chunk_index
            self._byte_count += chunk_bytes
            self._segment_active = True
            if self._byte_count >= self._max_bytes:
                await self.flush()
        if delta:
            self._last_emitted_char = delta[-1]

    def _split_delta(self, delta: str) -> list[str]:
        chunks: list[str] = []
        characters: list[str] = []
        byte_count = 0
        for character in delta:
            character_bytes = len(character.encode("utf-8"))
            if character_bytes > self._max_bytes:
                raise ValueError(
                    "UTF-8 code point exceeds assistant buffer max_bytes"
                )
            if characters and byte_count + character_bytes > self._max_bytes:
                chunks.append("".join(characters))
                characters = []
                byte_count = 0
            characters.append(character)
            byte_count += character_bytes
        if characters:
            chunks.append("".join(characters))
        return chunks

    async def end(self, finish_reason: str) -> None:
        # 先处理可疑 JSON 缓冲：tool_call 丢弃，其他情况尝试 json.loads，
        # 合法 JSON 丢弃，非法则作为普通文本补发。
        await self._json_suspect.finalize(finish_reason)
        if not self._segment_active and self._has_ended:
            return
        await self.flush()
        last_chunk_index = (
            self._next_chunk_index - 1 if self._next_chunk_index else None
        )
        await self._execution.emit_assistant_stream(
            AssistantStreamEndFrame(
                task_id=self._execution.task_id,
                run_id=self._execution.run_id,
                stream_id=self._stream_id,
                last_chunk_index=last_chunk_index,
                finish_reason=finish_reason,
            )
        )
        self._segment_active = False
        self._has_ended = True
        # 重置 markdown 状态，避免上一个 segment 未关闭的围栏影响下一个
        self._in_code_fence = False
        self._code_fence_tail = ""
        self._last_emitted_char = ""

    def seconds_until_flush(self) -> float | None:
        if self._started_at is None:
            return None
        elapsed = asyncio.get_running_loop().time() - self._started_at
        return max(0.0, self._flush_interval - elapsed)

    async def flush(self) -> None:
        if not self._parts:
            return
        delta = "".join(self._parts)
        from_chunk_index = self._from_chunk_index
        through_chunk_index = self._through_chunk_index
        if from_chunk_index is None or through_chunk_index is None:
            raise RuntimeError("assistant text buffer lost its chunk range")
        emit_task = asyncio.create_task(
            self._execution.emit(
                AssistantDeltaPayload(
                    delta=delta,
                    stream_id=self._stream_id,
                    from_chunk_index=from_chunk_index,
                    through_chunk_index=through_chunk_index,
                )
            )
        )
        try:
            await asyncio.shield(emit_task)
        except asyncio.CancelledError:
            while not emit_task.done():
                try:
                    await asyncio.shield(emit_task)
                except asyncio.CancelledError:
                    continue
                except Exception:
                    break
            if not emit_task.cancelled():
                try:
                    emit_task.result()
                except Exception:
                    pass
                else:
                    self._clear_confirmed_batch()
            raise
        self._clear_confirmed_batch()

    def _clear_confirmed_batch(self) -> None:
        self._parts.clear()
        self._byte_count = 0
        self._started_at = None
        self._from_chunk_index = None
        self._through_chunk_index = None


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


def _truncate_for_event(
    value: object,
    *,
    depth: int = 3,
    str_limit: int = 200,
    list_limit: int = 20,
) -> Any:
    """递归截断事件 payload 中的大对象，防止 events.jsonl 膨胀。

    - 字符串超过 str_limit 字符时截断并追加 ``...[truncated]``
    - 列表截断到前 list_limit 项；深度耗尽时替换为 ``[list:N]``
    - dict 递归到 depth 层；深度耗尽时替换为 ``[dict:N]``
    - 原始值（int/float/bool/None）原样返回
    """
    if isinstance(value, str):
        if len(value) > str_limit:
            return value[:str_limit] + "...[truncated]"
        return value
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    if isinstance(value, list):
        if depth <= 0:
            return f"[list:{len(value)}]"
        truncated = value[:list_limit]
        return [
            _truncate_for_event(
                v,
                depth=depth - 1,
                str_limit=str_limit,
                list_limit=list_limit,
            )
            for v in truncated
        ]
    if isinstance(value, dict):
        if depth <= 0:
            return f"[dict:{len(value)}]"
        return {
            k: _truncate_for_event(
                v,
                depth=depth - 1,
                str_limit=str_limit,
                list_limit=list_limit,
            )
            for k, v in value.items()
        }
    return str(value)[:str_limit]


def _extract_tool_arguments(raw_item: object) -> dict[str, Any] | None:
    """从 SDK raw_item.arguments（JSON 字符串）解析并截断工具调用参数。

    返回 ``None`` 表示无参数或解析失败（前端兜底显示"调用 {toolName}"）。
    """
    args_json = _value(raw_item, "arguments", None)
    if not args_json:
        return None
    if not isinstance(args_json, str):
        # 部分 SDK 可能直接返回 dict；直接截断
        if isinstance(args_json, dict):
            return _truncate_for_event(args_json)
        return None
    try:
        parsed = json.loads(args_json)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(parsed, dict):
        return None
    return _truncate_for_event(parsed)


def _tool_args_fingerprint_raw(raw_item: object) -> str:
    """Canonical fingerprint of the RAW (untruncated) tool arguments.

    Hashing the full parsed JSON before ``_truncate_for_event`` avoids
    collisions between distinct calls whose arguments share a long prefix
    (docs/REVIEW_2026-07-31 §4.2 B2 — only identical calls count).
    """

    args_json = _value(raw_item, "arguments", None)
    if not args_json:
        return ""
    if isinstance(args_json, str):
        try:
            parsed = json.loads(args_json)
        except (json.JSONDecodeError, TypeError):
            return args_json
        if isinstance(parsed, dict):
            return hashlib.sha256(
                json.dumps(parsed, sort_keys=True, default=str, ensure_ascii=False).encode()
            ).hexdigest()
        return args_json
    if isinstance(args_json, dict):
        return hashlib.sha256(
            json.dumps(args_json, sort_keys=True, default=str, ensure_ascii=False).encode()
        ).hexdigest()
    return str(args_json)

#: ``ToolCompletedPayload.output`` 字符串化后的最大长度（4KB）。
TOOL_OUTPUT_MAX_BYTES = 4096


def _truncate_tool_output(output: object) -> str:
    """字符串化 tool output 并截断到 4KB，防止 events.jsonl 膨胀。"""
    text = str(output)
    if len(text) > TOOL_OUTPUT_MAX_BYTES:
        return text[:TOOL_OUTPUT_MAX_BYTES] + "...[truncated]"
    return text


class AgentRunExecutor:
    """Execute one manager-owned Run against its durable SDK session."""

    def __init__(
        self,
        repository,
        *,
        skill_catalog: SkillCatalog | None = None,
        compactor=None,
        subagent_supervisor: SubagentSupervisor | None = None,
        subagent_event_sink: SubagentEventSink | None = None,
        subagent_input_broker: SubagentInputBroker | None = None,
    ) -> None:
        self._repository = repository
        self.skill_catalog = skill_catalog
        self._compactor = compactor or ConversationCompactor(repository)
        self._subagent_supervisor = subagent_supervisor
        self._subagent_event_sink = subagent_event_sink
        self._subagent_input_broker = subagent_input_broker

    def _build(self, execution) -> AgentBuild:
        """Build the Agent for this executor (overridable by subclasses)."""
        if self.skill_catalog is None:
            return build_agent(execution.databases)
        return build_agent(self.skill_catalog, execution.databases)

    def _max_turns(self, execution=None) -> int:
        """Return the max_turns for this executor's Agent loop.

        ``execution`` is optional for backward compatibility; subclasses that
        need run-specific max_turns (e.g. ``ImportRunExecutor``) can read it.
        """
        settings = None
        if execution is not None:
            settings = getattr(execution.context, "model_settings", None)
        return resolve_agent_max_turns(settings)

    def attach_subagent_runtime(
        self,
        *,
        supervisor: SubagentSupervisor,
        event_sink: SubagentEventSink,
        input_broker: SubagentInputBroker | None = None,
    ) -> None:
        """Receive the lifecycle-owned supervisor before any managed Run starts."""

        self._subagent_supervisor = supervisor
        self._subagent_event_sink = event_sink
        self._subagent_input_broker = input_broker

    def _bind_subagent_runtime(self, execution) -> None:
        """Attach this Run's child dispatcher without sharing parent SDK state."""

        context = execution.context
        if (
            not isinstance(context, RunContext)
            or self._subagent_supervisor is None
            or self._subagent_event_sink is None
        ):
            return
        try:
            _ = context.subagent_runtime
        except RuntimeError:
            pass
        else:
            return
        context.bind_subagent_runtime(
            supervisor=self._subagent_supervisor,
            runner=ManagedChildAgentRunner(context, self.skill_catalog),
            event_sink=self._subagent_event_sink,
            input_broker=self._subagent_input_broker,
        )

    def _bind_main_input_broker(self, execution) -> None:
        """Attach this Run's main-run human-input broker (data_correction).

        Installed once per Run so the request-id counter resets per Run;
        subagent/child contexts never receive a broker (spec §3-D1).
        """

        context = execution.context
        if not isinstance(context, RunContext):
            return
        if context.main_input_broker is not None:
            return
        context.bind_main_input_broker(
            MainInputBroker(
                run_id=execution.run_id,
                fixture=execution.mode is TaskMode.FIXTURE,
                emit=execution.emit,
                install_user_input_submitter=execution.set_user_input_submitter,
                clear_user_input_submitter=execution.clear_user_input_submitter,
                cancellation_requested=context.cancellation_requested,
                artifacts_dir=context.work_dir.artifacts,
            )
        )

    @staticmethod
    async def _consume_events(
        execution,
        result,
        text_buffer: _AssistantTextBuffer,
        *,
        no_progress_detector: NoProgressDetector | None = None,
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
                    await text_buffer.end("stop")
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
                        await text_buffer.end(
                            _normalize_assistant_finish_reason(finish_reason)
                        )
                    if (
                        finish_reason == "length"
                        and not truncation_warned
                    ):
                        truncation_warned = True
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
                    await text_buffer.end("tool_call")
                    call_id, tool_name = _tool_identity(event.item)
                    resolved_name = tool_name or "unknown"
                    tool_names[call_id] = resolved_name
                    raw_item = _value(event.item, "raw_item", event.item)
                    arguments = _extract_tool_arguments(raw_item)
                    if no_progress_detector is not None:
                        args_hash = _tool_args_fingerprint_raw(raw_item)
                        occurrences = no_progress_detector.record(
                            resolved_name,
                            args_hash,
                        )
                        if occurrences is not None:
                            raise NoProgressDetected(
                                tool_name=resolved_name,
                                args_hash=args_hash,
                                occurrences=occurrences,
                                window_seconds=no_progress_detector._window,
                            )
                    await execution.emit(
                        ToolStartedPayload(
                            tool_call_id=call_id,
                            tool_name=resolved_name,
                            arguments=arguments,
                        )
                    )
                elif event.name == "tool_output":
                    await text_buffer.end("tool_call")
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
                            output=_truncate_tool_output(
                                _value(event.item, "output", "")
                            ),
                            is_error=is_error,
                        )
                    )
        except MaxTurnsExceeded:
            await text_buffer.end("max_turns")
            raise
        except asyncio.CancelledError:
            await text_buffer.end("cancelled")
            raise
        except Exception:
            await text_buffer.end("error")
            raise
        finally:
            if pending_event is not None and not pending_event.done():
                pending_event.cancel()
                await asyncio.gather(pending_event, return_exceptions=True)

    async def __call__(self, execution) -> None:
        model_settings = execution.model_settings or to_run_model_settings(
            get_current_model_configuration()
        )
        bind_model_settings = getattr(
            execution.context,
            "bind_model_settings",
            None,
        )
        if callable(bind_model_settings):
            bind_model_settings(model_settings)
        self._bind_subagent_runtime(execution)
        self._bind_main_input_broker(execution)
        task_session = self._repository.task_session(
            execution.task_id,
            run_id=execution.run_id,
        )
        with run_model_settings_scope(model_settings):
            build = self._build(execution)
        text_buffer = _AssistantTextBuffer(execution)
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
                # T3 (Phase 7): mirror the stage_progress event with an
                # operation_progress event (ARCHITECTURE §14.2).
                operation_id, label, category = stage_operation_spec(stage)
                await execution.emit(
                    OperationProgressPayload(
                        operation_id=operation_id,
                        label=label,
                        category=category,
                        kind=kind,
                        current=current,
                        total=total,
                        detail=detail,
                    )
                )

            bind_progress_emitter(emit_progress)
        try:
            await self._run_agent_loop(
                execution, build, text_buffer, model_settings, task_session
            )
        except (asyncio.CancelledError, CompactionCancelledError):
            await text_buffer.end("cancelled")
            raise
        except Exception:
            await text_buffer.end("error")
            raise
        else:
            await text_buffer.end("stop")
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

    async def _run_agent_loop(
        self,
        execution,
        build: AgentBuild,
        text_buffer: _AssistantTextBuffer,
        model_settings: RunModelSettings,
        task_session,
    ) -> None:
        """Run the streaming Agent loop with max_turns/no-progress/Qwen recovery.

        Extracted from ``__call__`` for readability. ``__call__`` handles model
        binding, sub-agent runtime binding, pipeline bridge / progress emitter
        installation, and the terminal ``text_buffer.end`` / cleanup; this method
        owns the inner ``Runner.run_streamed`` loop and its recovery paths.

        Recovery paths (all pre-existing, unchanged behavior):
        - ``MaxTurnsExceeded`` → pause-resume via ``_await_max_turns_resume``.
        - ``NoProgressDetected`` → pause-resume via ``_await_no_progress_resume``.
        - Qwen malformed ``function.arguments`` 400 → retry with a correction
          instruction (up to ``QWEN_FUNCTION_ARGS_RETRY_LIMIT`` times).
        """
        # Build per-invocation preflight from the immutable Run budget.
        # Every SDK invocation is gated by a fresh CompactionRequest that
        # carries the current ``agent_input``, resolved instructions, and
        # the frozen ContextBudget.
        prompt_shape = getattr(
            build, "prompt_shape",
            _default_prompt_shape(),
        )
        preflight_builder = InvocationPreflight.from_budget(
            budget=model_settings.context_budget,
            prompt_shape=prompt_shape,
            compactor=self._compactor,
        )
        # Agent 循环：每次 Runner.run_streamed 消耗 max_turns 个 turn；
        # 若 SDK 抛 MaxTurnsExceeded，发射 UserInputRequiredPayload 走
        # pause-resume。用户选"继续"时复用 durable Session，但不把
        # 已持久化的历史再次作为新输入追加。
        # See docs/REVIEW_2026-07-18.md §11.
        agent_input: str | list = execution.input
        result = None
        resume_count = 0
        qwen_retry_count = 0
        runtime_limits = getattr(model_settings, "runtime_limits", None)
        no_progress_detector = (
            NoProgressDetector(
                window_seconds=runtime_limits.no_progress_window_seconds,
                threshold=runtime_limits.no_progress_repeat_threshold,
            )
            if runtime_limits is not None
            else None
        )
        while True:
            # 用户指令（非空 agent_input：初始用户文本 / Qwen 重放）重置
            # 无进展计数；max_turns 续跑 (agent_input=[]) 不清零。
            if no_progress_detector is not None and agent_input:
                no_progress_detector.reset()
            run_ctx = execution.context
            preparation = await preflight_builder.preflight(
                execution.task_id,
                agent_input,
                model_handle=build.model,
                emit=execution.emit,
                session=task_session,
                cancellation_requested=execution.context.cancellation_requested,
                commit=execution.commit_compaction,
                context=(
                    run_ctx if isinstance(run_ctx, RunContext) else None
                ),
            )
            if execution.context.cancellation_requested.is_set():
                raise CompactionCancelledError(
                    "conversation compaction was cancelled before Agent Run"
                )
            # reset_streaming_result 让续跑的 Runner.run_streamed 能挂载新的
            # RunResultStreaming (上一轮已 exhausted),保持 cancel 通道对准
            # 当前活跃的 SDK run。首轮为 no-op (_streaming_result 本就为 None)。
            execution.reset_streaming_result()
            result = Runner.run_streamed(
                build.agent,
                preparation.agent_input,
                context=execution.context,
                session=preparation.session,
                max_turns=self._max_turns(execution),
            )
            execution.set_streaming_result(result)
            try:
                await self._consume_events(
                    execution,
                    result,
                    text_buffer,
                    no_progress_detector=no_progress_detector,
                )
            except NoProgressDetected as exc:
                await text_buffer.flush()
                decision = await self._await_no_progress_resume(
                    execution,
                    detector=exc,
                )
                if decision.decision == "reject":
                    raise _AgentRunCancelled(
                        "agent run cancelled by user after no-progress detected"
                    ) from None
                # 用户选择继续：保留 durable Session 续跑，清空无进展计数
                # （用户指令视为有效中断），避免同一指纹再次触发。
                if no_progress_detector is not None:
                    no_progress_detector.reset()
                agent_input = []
                continue
            except MaxTurnsExceeded:
                await text_buffer.flush()
                resume_limit = resolve_max_turns_resume_limit(
                    getattr(execution.context, "model_settings", None),
                )
                if resume_count >= resume_limit:
                    raise RuntimeError(
                        f"agent exceeded max_turns resume limit "
                        f"({resume_limit} times; hard cap "
                        f"{(resume_limit + 1) * self._max_turns(execution)} turns)"
                    ) from None
                decision = await self._await_max_turns_resume(
                    execution,
                    resume_count=resume_count,
                )
                if decision.decision == "reject":
                    raise _AgentRunCancelled(
                        "agent run cancelled by user after max_turns reached"
                    ) from None
                resume_count += 1
                # Durable Session 已拥有上一轮的完整上下文。这里若传
                # result.to_input_list()，SDK 会把历史再次 append 到
                # Session，进而生成重复 MessageRecord。
                agent_input = []
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
                    discard_invalid_calls = getattr(
                        task_session,
                        "discard_invalid_function_calls",
                        None,
                    )
                    discarded_call_count = 0
                    if callable(discard_invalid_calls):
                        discarded_call_count = await discard_invalid_calls()
                    await execution.emit(
                        WarningPayload(
                            code="llm_function_args_retry",
                            message=(
                                f"LLM returned malformed function arguments "
                                f"(400); discarded {discarded_call_count} invalid "
                                f"tool call(s); retrying Run "
                                f"({qwen_retry_count}/"
                                f"{QWEN_FUNCTION_ARGS_RETRY_LIMIT})"
                            ),
                        )
                    )
                    # 不重放 execution.input（避免重复全部历史工具调用）。
                    # 先移除 durable Session 中无法再次发送的非法调用，
                    # 再追加一条修正指令，让模型重新生成合法调用。
                    agent_input = [
                        {
                            "role": "user",
                            "content": (
                                "上一工具调用参数非法（400），请仅修正并重发"
                                "该工具调用，不要重复已完成的工作。"
                            ),
                        }
                    ]
                    continue
                raise
            finally:
                await text_buffer.flush()
            # 消耗成功后，记录权威输入 usage 残差供未来 Run 校准。
            # 缺失/不支持/零 input usage 为 no-op；活跃 Run 的预算不变。
            record_calibration_from_result(
                result,
                preparation.estimate,
                model_settings.context_budget,
            )
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

    async def _await_max_turns_resume(
        self,
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

        max_turns = self._max_turns(execution)
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
                        f"Agent 已达到最大轮次 ({max_turns})，是否继续工作？"
                    ),
                    detail={
                        "max_turns": max_turns,
                        "resume_count": resume_count,
                        "resume_limit": resolve_max_turns_resume_limit(
                            getattr(execution.context, "model_settings", None),
                        ),
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

    async def _await_no_progress_resume(
        self,
        execution: RunExecution,
        *,
        detector: NoProgressDetected,
    ) -> UserInputResumedPayload:
        """Pause the Agent Run after no-progress detection and wait for user.

        Mirrors ``_await_max_turns_resume`` with ``prompt_kind="no_progress"``;
        reuses the same pause-resume infrastructure (UserInputSubmitter +
        ``POST /runs/{run_id}/resume``).
        """

        request_id = f"no_progress-{execution.run_id}"
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
                    prompt_kind="no_progress",
                    summary=(
                        "检测到无进展：同一工具调用在短时间内密集重复 "
                        f"({detector.tool_name} × {detector.occurrences})，"
                        "是否继续工作？"
                    ),
                    detail={
                        "tool_name": detector.tool_name,
                        "args_hash": detector.args_hash,
                        "occurrences": detector.occurrences,
                        "window_seconds": detector.window_seconds,
                    },
                )
            )
            await event.wait()
        finally:
            execution.clear_user_input_submitter(submitter)

        if not decision_holder:
            raise RuntimeError("no_progress resume event set without a decision")
        await execution.emit(decision_holder[0])
        return decision_holder[0]

    @staticmethod
    async def _transfer_pending_publication(execution: RunExecution) -> None:
        take_pending = getattr(execution.context, "take_pending_publication", None)
        if not callable(take_pending):
            return
        pending = take_pending()
        if pending is None:
            take_build = getattr(
                execution.context, "take_dataset_build_outcome", None
            )
            if callable(take_build):
                outcome = take_build()
                if outcome is not None:
                    await _transfer_dataset_build_outcome(execution, outcome)
                    return
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
            execution.set_build_result(pending.manifest.build_result)
            payloads = [
                ArtifactProducedPayload(artifact=pending.manifest_entry),
                *(
                    ArtifactProducedPayload(artifact=artifact)
                    for artifact in pending.manifest.artifacts
                ),
            ]

            async def commit_agent_artifacts() -> list[EventEnvelope]:
                await _run_sync_operation(pending.publish)
                manifest_digest = pending.manifest_entry.sha256
                publication_id = f"pub-{execution.run_id}"
                # Phase 4b T4: only SUCCEEDED/PARTIAL_SUCCESS build results
                # carry a publication_id (BuildResult.validate_state forbids it
                # on NO_DATA). A pipeline NO_DATA manifest (T1-T3) must keep
                # publication_id None while its audit package still publishes.
                if (
                    execution.build_result is not None
                    and execution.build_result.status
                    in (BuildResultStatus.SUCCEEDED, BuildResultStatus.PARTIAL_SUCCESS)
                ):
                    execution.set_build_result(
                        execution.build_result.model_copy(
                            update={"publication_id": publication_id}
                        )
                    )
                publication_event = build_event(
                    task_id=execution.task_id,
                    run_id=execution.run_id,
                    sequence=len(payloads) + 1,
                    payload=PublicationCreatedPayload(
                        publication_id=publication_id,
                        run_id=execution.run_id,
                        manifest_sha256=manifest_digest,
                        supersedes_publication_id=None,
                        published_at=datetime.now(UTC),
                    ),
                )
                return [
                    build_event(
                        task_id=execution.task_id,
                        run_id=execution.run_id,
                        sequence=index,
                        payload=payload,
                    )
                    for index, payload in enumerate(payloads, start=1)
                ] + [publication_event]

            async def abort_agent_artifacts() -> None:
                await _run_sync_operation(pending.abort)

            execution.set_completion_operations(
                commit_agent_artifacts,
                abort_agent_artifacts,
            )
        except BaseException:
            await _run_sync_operation(pending.abort)
            raise


async def _transfer_dataset_build_outcome(
    execution: RunExecution, outcome: PendingDatasetBuild
) -> None:
    """Bridge a V2 ``execute_dataset_build`` outcome into the durable Run.

    Bug-sweep REVIEW §3 (V2-dup): sets ``execution.build_result`` to the
    tool's authoritative BuildResult and registers the publication completion
    event so the Run completes with the real outcome (never the generic
    NO_DATA fallback).  No files are moved — the build outputs already live
    under the task's ``datasets_build/<build_id>/`` directory and are served
    by the builds API.
    """

    if outcome.run_id != execution.run_id:
        raise RuntimeError("pending dataset build run_id does not match execution")
    execution.set_build_result(outcome.build_result)
    publication = outcome.publication
    manifest_sha256 = outcome.manifest_sha256

    async def commit_dataset_build() -> list[EventEnvelope]:
        events: list[EventEnvelope] = []
        if publication is not None and manifest_sha256 is not None:
            events.append(
                build_event(
                    task_id=execution.task_id,
                    run_id=execution.run_id,
                    sequence=1,
                    payload=PublicationCreatedPayload(
                        publication_id=publication.publication_id,
                        run_id=execution.run_id,
                        manifest_sha256=manifest_sha256,
                        supersedes_publication_id=publication.supersedes_publication_id,
                        published_at=publication.published_at,
                    ),
                )
            )
        return events

    async def noop_abort_dataset_build() -> None:
        return None

    execution.set_completion_operations(
        commit_dataset_build, noop_abort_dataset_build
    )


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


class FixtureRunExecutor:
    """Run the fixed V2 fixture build and bridge its durable outcome/events.

    V1 退役后 FIXTURE 模式的 V2 实现：把官方 fixture 资产（GDC 表达矩阵）复制进
    任务工作目录，用固定 DatasetBuildSpec 驱动 ``execute_dataset_build`` 内核，
    再复用 ``_transfer_pending_publication`` 把 BuildResult 与 publication 事件
    桥接到 durable Run（与 AGENT 模式同一转移路径）。
    """

    def __init__(
        self,
        repository,
        *,
        fixture_dir: Path = OFFICIAL_FIXTURE_DIR,
    ) -> None:
        self._repository = repository
        self._fixture_dir = fixture_dir

    async def __call__(self, execution) -> None:
        validate_task_databases(execution.mode, execution.databases)
        await self._repository.task_session(execution.task_id).add_run_input_once(
            execution.run_id,
            execution.input,
        )
        # V2 工具只解析任务工作目录内的文件：先把 fixture 资产复制进去。
        workdir = execution.context.work_dir
        source_rel = "source_assets/fixture_gdc_expression.tsv"
        asset_path = workdir.root / source_rel
        asset_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(_fixture_gdc_expression(self._fixture_dir), asset_path)

        spec = {
            "build_id": "fixture_build",
            "objective": execution.input or "fixture dataset build",
            "dataset_family": "gene_expression",
            "row_granularity": "gene_sample_measurement",
            "schema_ref": "gene_expression.long.v1",
            "source_bindings": [
                {
                    "binding_id": "binding_gdc",
                    "source": "gdc",
                    "acquisition": {"mode": "builtin", "provider_id": "gdc.v1"},
                    "adapter_id": "gdc.expression.v1",
                    "accession": "TCGA-FIXTURE",
                }
            ],
            "merge_strategy": "append_by_canonical_row",
            "validation_profile_ref": "gene_expression.release.v1",
            "normalization_profile_ref": "gene_expression.normalization.v1",
        }
        tool = ToolContext(
            context=execution.context,
            tool_name="execute_dataset_build",
            tool_call_id="fixture_build",
            tool_arguments="{}",
        )
        raw = await execute_dataset_build.on_invoke_tool(
            tool,
            json.dumps(
                {
                    "spec": json.dumps(spec),
                    "source_files": json.dumps({"binding_gdc": source_rel}),
                }
            ),
        )
        envelope = json.loads(raw)
        if envelope.get("status") != "ok":
            raise RuntimeError(
                f"fixture build failed: {envelope.get('message', envelope)}"
            )
        await AgentRunExecutor._transfer_pending_publication(execution)


def _fixture_gdc_expression(fixture_dir: Path) -> Path:
    """Locate the official GDC expression fixture asset.

    ``fixture_dir`` points at the GEO series fixture
    (``tests/fixtures/ncbi/gse178352/``); the GDC expression fixture lives at
    the shared fixture root (``tests/fixtures/gdc/gdc_expression.tsv``).
    """
    return fixture_dir.parents[1] / "gdc" / "gdc_expression.tsv"


class ModeDispatchRunExecutor:
    """Delegate authoritative Task modes to their focused executors."""

    def __init__(
        self,
        repository,
        *,
        skill_catalog: SkillCatalog | None = None,
    ) -> None:
        self.agent_executor = AgentRunExecutor(repository, skill_catalog=skill_catalog)
        self.fixture_executor = FixtureRunExecutor(repository)
        self.import_executor = ImportRunExecutor(repository, skill_catalog=skill_catalog)

    async def __call__(self, execution) -> None:
        if execution.mode is TaskMode.AGENT:
            await self.agent_executor(execution)
            return
        if execution.mode is TaskMode.FIXTURE:
            await self.fixture_executor(execution)
            return
        if execution.mode is TaskMode.IMPORT:
            await self.import_executor(execution)
            return
        raise ValueError(f"unsupported task mode: {execution.mode}")

    def attach_subagent_runtime(
        self,
        *,
        supervisor: SubagentSupervisor,
        event_sink: SubagentEventSink,
        input_broker: SubagentInputBroker | None = None,
    ) -> None:
        """Forward lifecycle-owned child services to model-backed executors."""

        self.agent_executor.attach_subagent_runtime(
            supervisor=supervisor,
            event_sink=event_sink,
            input_broker=input_broker,
        )
        self.import_executor.attach_subagent_runtime(
            supervisor=supervisor,
            event_sink=event_sink,
            input_broker=input_broker,
        )


class ImportRunExecutor(AgentRunExecutor):
    """IMPORT 任务执行器 — 双阶段串联（附件解析 → 主研究）。

    生命周期（D1 决策）：
      - Run #1：``source_assets/`` 非空 → 附件解析 Agent
        （``build_attachment_parsing_agent``），max_turns=40
      - Run #2+：``source_assets/`` 为空（Run #1 完成后已归档）→ 标准
        研究 Agent（``build_agent``），max_turns=AGENT_MAX_TURNS

    Run #1 完成后，``__call__`` 把 ``source_assets/`` 中的文件移动到
    ``source_assets/archived/``，使 Run #2 检测为空从而路由到标准 Agent。
    前端通过监听 Run #1 完成事件，调 ``POST /tasks/{task_id}/runs``
    入队 Run #2（主研究）。

    两个 Run 的 ``RunContext`` 完全独立（D9 决策），不共享对话历史。
    """

    def _build(self, execution) -> AgentBuild:
        if self._has_pending_attachments(execution):
            return build_attachment_parsing_agent()
        if self.skill_catalog is None:
            return build_agent(execution.databases)
        return build_agent(self.skill_catalog, execution.databases)

    def _max_turns(self, execution=None) -> int:
        if execution is not None and self._has_pending_attachments(execution):
            return ATTACHMENT_PARSING_MAX_TURNS
        settings = None
        if execution is not None:
            settings = getattr(execution.context, "model_settings", None)
        return resolve_agent_max_turns(settings)

    @staticmethod
    def _has_pending_attachments(execution) -> bool:
        """检测 ``source_assets/`` 顶层是否有待处理文件（非 archived 子目录）。"""
        source_assets = execution.context.work_dir.source_assets
        if not source_assets.is_dir():
            return False
        return any(entry.is_file() for entry in source_assets.iterdir())

    async def __call__(self, execution) -> None:  # type: ignore[override]
        await super().__call__(execution)
        # Run #1（附件解析）成功完成后，归档 source_assets/ 中的文件，
        # 使后续 Run 检测为空 → 路由到标准研究 Agent。
        if self._has_pending_attachments(execution):
            ImportRunExecutor._archive_source_assets(execution)

    @staticmethod
    def _archive_source_assets(execution) -> None:
        """把 ``source_assets/`` 顶层文件移动到 ``source_assets/archived/``。"""
        import shutil

        source_assets = execution.context.work_dir.source_assets
        archived = source_assets / "archived"
        archived.mkdir(parents=True, exist_ok=True)
        for entry in source_assets.iterdir():
            if entry.is_file():
                shutil.move(str(entry), str(archived / entry.name))


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


def _normalize_assistant_finish_reason(finish_reason: str) -> str:
    if finish_reason in {"tool_calls", "function_call"}:
        return "tool_call"
    return finish_reason


def _default_prompt_shape() -> ChatCompletionsPromptShape:
    """Return a minimal prompt shape for builds that do not carry one."""
    return ChatCompletionsPromptShape(
        instructions="",
        serialized_tool_schemas=(),
        policy=ChatCompletionsStructuralPolicy(),
    )
