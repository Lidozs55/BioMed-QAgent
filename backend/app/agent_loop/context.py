"""RunContext — Agent loop 运行期间的共享状态。

所有工具可通过 context 访问/修改共享状态（记录、查询日志、产出物路径等）。

对应 TODO.md Section 4.2：扩展 RunContext 字段。
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from app.domain.contracts import (
    DataLevel,
    EventEnvelope,
    QueryStatus,
    SourceAsset,
    StageName,
    SubagentInputRequiredPayload,
    SubagentInputResumedPayload,
    UserInputResumedPayload,
    generate_prefixed_uuid,
)
from app.model_config import RunModelSettings
from app.tools.workdir import TaskWorkDir, create_task_workdir

if TYPE_CHECKING:
    from app.pipeline.runner import PendingPublication, PendingPublicationCleanup
    from app.skills.builtin.processing.create_skill import CreateSkillRuntime
    from app.subagents.input_broker import SubagentInputBroker
    from app.subagents.staging import SubagentStagingWorkspace
    from app.subagents.supervisor import SubagentEventSink, SubagentRunner, SubagentSupervisor
    from app.tools.crawler import CrawlerFacade


ProgressEmitter = Callable[
    [StageName, str, int, int | None, dict[str, object]],
    Awaitable[None],
]


UserInputSubmitter = Callable[[UserInputResumedPayload], bool]

_SENSITIVE_INPUT_KEYS = {
    "api_key",
    "authorization",
    "credential",
    "password",
    "secret",
    "token",
}


def _redact_input_detail(detail: dict[str, object]) -> dict[str, object]:
    """Keep durable HIL detail useful without persisting credential material."""

    safe: dict[str, object] = {}
    for key, value in detail.items():
        normalized_key = key.casefold()
        if any(marker in normalized_key for marker in _SENSITIVE_INPUT_KEYS):
            continue
        safe[key] = value[:200] if isinstance(value, str) else value
    return safe


@dataclass(frozen=True, slots=True)
class ManagedPipelineBridge:
    """Run-owned bridge from an Agent Function Tool to the durable runtime."""

    run_id: str
    event_sink: Callable[[EventEnvelope], Awaitable[None]]
    install_user_input_submitter: Callable[[UserInputSubmitter], None]
    clear_user_input_submitter: Callable[[UserInputSubmitter], None]


@dataclass(frozen=True, slots=True)
class SubagentRuntime:
    """Run-owned handles for managed child-agent delegation."""

    supervisor: SubagentSupervisor
    runner: SubagentRunner
    event_sink: SubagentEventSink
    input_broker: SubagentInputBroker | None = None


@dataclass(slots=True)
class _CreateSkillReservations:
    """One parent-Run dedupe guard, shared by its isolated child contexts."""

    keys: set[tuple[str, str]] = field(default_factory=set)
    guard: threading.Lock = field(default_factory=threading.Lock)

    @contextmanager
    def reserve(self, domain: str, capability: str) -> Iterator[None]:
        key = (domain.strip().casefold(), capability.strip().casefold())
        with self.guard:
            if key in self.keys:
                raise ValueError(
                    "create_skill already developed this domain and capability in the current Run"
                )
            self.keys.add(key)
        try:
            yield
        except BaseException:
            with self.guard:
                self.keys.discard(key)
            raise


@dataclass
class RunContext:
    """任务级共享状态，通过 Runner.run(..., context=ctx) 注入。

    Attributes:
        task_id: 任务 ID（用于产物目录隔离）。
        topic: 用户研究主题（由 server 层注入）。
        preferred_sources: 用户允许的数据库列表；未指定时为空。
        plan: Agent 制定的执行计划（自由格式）。
        sources: 已使用的数据源记录（SourceRecord 列表）。
        raw_assets: raw 目录下的本地文件路径列表。
        parsed_datasets: parsed 目录下的解析产物路径列表。
        records: 已采集的 DataRecord 列表。
        artifacts: 产出物文件路径（CSV、报告、图表等）。
        warnings: 过程中产生的警告列表。
        query_log: 记录每次检索的 query/source/status/records_count。
        cancellation_requested: Cooperative cancellation token for tools.
    """

    task_id: str = "default"
    base_dir: str | Path | None = field(default=None, repr=False, kw_only=True)
    work_dir_root: str | Path | None = field(default=None, repr=False, kw_only=True)
    subagent_id: str | None = field(default=None, repr=False, kw_only=True)
    managed_run_id: str | None = field(default=None, repr=False, kw_only=True)
    model_settings: RunModelSettings = field(
        default_factory=RunModelSettings.default,
        repr=False,
        kw_only=True,
    )
    topic: str = ""
    preferred_sources: list[str] = field(default_factory=list)
    plan: str = ""

    sources: list[Any] = field(default_factory=list)
    raw_assets: list[str] = field(default_factory=list)
    parsed_datasets: list[str] = field(default_factory=list)
    records: list[dict] = field(default_factory=list)
    artifacts: list[str] = field(default_factory=list)
    warnings: list[dict] = field(default_factory=list)

    query_log: list[dict] = field(default_factory=list)
    query_log_summary: str = ""
    cancellation_requested: asyncio.Event = field(
        default_factory=asyncio.Event,
        repr=False,
    )
    compaction_requested: asyncio.Event = field(
        default_factory=asyncio.Event,
        repr=False,
    )
    # TODO §8.4: per-source follow-up counter for LLM self-enforcement.
    # Each log_query(status=NOT_FOUND) increments the counter for that source.
    # LLM reads followup_search_count via RunContext to self-enforce the
    # 3-round limit (project_memory hard constraint).
    _followup_counts: dict[str, int] = field(
        default_factory=dict,
        init=False,
        repr=False,
    )
    _pipeline_publication_reserved: bool = field(
        default=False,
        init=False,
        repr=False,
    )
    _pending_publication: PendingPublication | PendingPublicationCleanup | None = field(
        default=None,
        init=False,
        repr=False,
    )
    _managed_pipeline_bridge: ManagedPipelineBridge | None = field(
        default=None,
        init=False,
        repr=False,
    )
    _managed_terminal_error: BaseException | None = field(
        default=None,
        init=False,
        repr=False,
    )
    _progress_emitter: ProgressEmitter | None = field(
        default=None,
        init=False,
        repr=False,
    )
    _model_settings_bound: bool = field(default=False, init=False, repr=False)
    _create_skill_runtime: CreateSkillRuntime | None = field(
        default=None,
        init=False,
        repr=False,
    )
    _crawler_facade: CrawlerFacade | None = field(
        default=None,
        init=False,
        repr=False,
    )
    _staging_task_root: Path | None = field(
        default=None,
        init=False,
        repr=False,
    )
    _source_asset_workspace: SubagentStagingWorkspace | None = field(
        default=None,
        init=False,
        repr=False,
    )
    _source_asset_ids: list[str] = field(
        default_factory=list,
        init=False,
        repr=False,
    )
    _recipe_id: str | None = field(default=None, init=False, repr=False)
    _child_warnings: list[str] = field(
        default_factory=list,
        init=False,
        repr=False,
    )
    _create_skill_reservations: _CreateSkillReservations = field(
        default_factory=_CreateSkillReservations,
        init=False,
        repr=False,
    )
    _subagent_runtime: SubagentRuntime | None = field(
        default=None,
        init=False,
        repr=False,
    )
    _delegated_subagent_ids: set[str] = field(
        default_factory=set,
        init=False,
        repr=False,
    )

    def __post_init__(self) -> None:
        """初始化时自动创建任务工作目录。"""
        base_dir = str(self.base_dir) if self.base_dir is not None else None
        self._work_dir: TaskWorkDir = create_task_workdir(
            self.task_id,
            base_dir=base_dir,
            root_dir=self.work_dir_root,
        )

    def bind_model_settings(self, model_settings: RunModelSettings) -> None:
        """Bind the executor-captured model snapshot exactly once."""

        if self._model_settings_bound:
            raise RuntimeError("run model settings are already bound")
        self.model_settings = model_settings
        self._model_settings_bound = True

    def bind_create_skill_runtime(self, runtime: CreateSkillRuntime) -> None:
        """Bind the trusted Recipe services available to this Run exactly once."""

        if self._create_skill_runtime is not None:
            raise RuntimeError("create_skill runtime is already bound")
        self._create_skill_runtime = runtime

    def bind_crawler_facade(self, facade: CrawlerFacade) -> None:
        """Bind the lifespan-owned crawler transport exactly once."""

        if self._crawler_facade is not None:
            raise RuntimeError("crawler facade is already bound")
        self._crawler_facade = facade

    def bind_subagent_runtime(
        self,
        *,
        supervisor: SubagentSupervisor,
        runner: SubagentRunner,
        event_sink: SubagentEventSink,
        input_broker: SubagentInputBroker | None = None,
    ) -> None:
        """Bind the manager-owned child runtime to this parent Run once."""

        if self._subagent_runtime is not None:
            raise RuntimeError("subagent runtime is already bound")
        self._subagent_runtime = SubagentRuntime(
            supervisor=supervisor,
            runner=runner,
            event_sink=event_sink,
            input_broker=input_broker,
        )

    @property
    def subagent_runtime(self) -> SubagentRuntime:
        """Return delegation services installed by the managed Run owner."""

        if self._subagent_runtime is None:
            raise RuntimeError("subagent runtime is not available")
        return self._subagent_runtime

    def create_child_context(
        self,
        subagent_id: str,
        *,
        preferred_sources: list[str] | None = None,
    ) -> RunContext:
        """Create an isolated child context while retaining trusted services."""

        child = RunContext(
            task_id=self.task_id,
            work_dir_root=self._work_dir.staging / "subagents" / subagent_id,
            subagent_id=subagent_id,
            model_settings=self.model_settings,
            preferred_sources=list(preferred_sources or self.preferred_sources),
        )
        child._create_skill_reservations = self._create_skill_reservations
        child._staging_task_root = self._work_dir.root
        if self._crawler_facade is not None:
            child.bind_crawler_facade(self._crawler_facade)
        if self._create_skill_runtime is not None:
            from app.skills.builtin.processing.create_skill import CreateSkillRuntime
            from app.subagents.staging import SubagentStagingWorkspace

            runtime = self._create_skill_runtime
            child.bind_create_skill_runtime(
                CreateSkillRuntime(
                    store=runtime.store,
                    executor=runtime.executor,
                    workspace=SubagentStagingWorkspace(self._work_dir.root, subagent_id),
                )
            )
        return child

    def source_asset_workspace(self) -> SubagentStagingWorkspace:
        """Return the task or child-owned SourceAsset staging boundary."""

        if self._source_asset_workspace is None:
            from app.subagents.staging import SubagentStagingWorkspace

            if self.subagent_id is None:
                task_root = self._work_dir.root
                workspace_id = generate_prefixed_uuid("run_staging")
            else:
                if self._staging_task_root is None:
                    raise RuntimeError("child staging task root is not available")
                task_root = self._staging_task_root
                workspace_id = self.subagent_id
            self._source_asset_workspace = SubagentStagingWorkspace(
                task_root,
                workspace_id,
            )
        return self._source_asset_workspace

    def stage_source_asset(
        self,
        *,
        content: bytes,
        filename: str,
        source_id: str,
        successful_attempt_id: str,
        data_level: DataLevel,
        media_type: str,
    ) -> SourceAsset:
        """Stage, validate, commit, and collect one SourceAsset."""

        workspace = self.source_asset_workspace()
        asset = workspace.stage_bytes(
            content=content,
            filename=filename,
            source_id=source_id,
            successful_attempt_id=successful_attempt_id,
            data_level=data_level,
            media_type=media_type,
        )
        workspace.validate_source_asset(asset)
        committed = workspace.commit_source_asset(asset)
        self.record_source_asset_id(committed.asset_id)
        return committed

    def commit_staged_source_asset(self, asset: SourceAsset) -> SourceAsset:
        """Validate and commit an asset already staged in this Run boundary."""

        workspace = self.source_asset_workspace()
        workspace.validate_source_asset(asset)
        committed = workspace.commit_source_asset(asset)
        self.record_source_asset_id(committed.asset_id)
        return committed

    def source_asset_path(self, asset: SourceAsset) -> Path:
        """Return the task-local path for a committed SourceAsset."""

        return self.source_asset_workspace().task_root / asset.relative_path

    @property
    def source_asset_ids(self) -> list[str]:
        """Return bounded SourceAsset IDs collected by this child context."""

        return list(self._source_asset_ids)

    @property
    def recipe_id(self) -> str | None:
        """Return the latest WorkflowRecipe ID collected by this child."""

        return self._recipe_id

    @property
    def child_warnings(self) -> list[str]:
        """Return bounded warning strings for the child result contract."""

        return list(self._child_warnings)

    def record_source_asset_id(self, asset_id: str) -> None:
        """Record one non-empty SourceAsset ID without duplicating it."""

        normalized = asset_id.strip()
        if not normalized:
            raise ValueError("source asset ID must not be blank")
        if normalized not in self._source_asset_ids:
            self._source_asset_ids.append(normalized)

    def record_recipe(self, recipe_id: str) -> None:
        """Record the child WorkflowRecipe ID without accepting blanks."""

        normalized = recipe_id.strip()
        if not normalized:
            raise ValueError("recipe ID must not be blank")
        self._recipe_id = normalized

    def record_warning(self, message: str) -> None:
        """Record one bounded child warning for ``SubagentResult``."""

        normalized = message.strip()
        if normalized and normalized not in self._child_warnings:
            self._child_warnings.append(normalized)

    async def request_subagent_input(
        self,
        *,
        summary: str,
        prompt_kind: str,
        detail: dict[str, object] | None = None,
    ) -> SubagentInputResumedPayload:
        """Pause one child for approval without changing the parent Run state."""

        if self.subagent_id is None or self.managed_run_id is None:
            raise RuntimeError("subagent input requires a managed child context")
        runtime = self.subagent_runtime
        if runtime.input_broker is None:
            raise RuntimeError("subagent input broker is unavailable")
        request_id = generate_prefixed_uuid("subagent_input")
        required = SubagentInputRequiredPayload(
            subagent_id=self.subagent_id,
            request_id=request_id,
            summary=summary,
            prompt_kind=prompt_kind,
            detail=detail or {},
        )
        event_kwargs = {
            "task_id": self.task_id,
            "run_id": self.managed_run_id,
            "subagent_id": self.subagent_id,
            "parent_tool_call_id": f"subagent:{self.subagent_id}",
        }
        await runtime.event_sink.emit(payload=required, **event_kwargs)
        resumed = await runtime.input_broker.request(
            task_id=self.task_id,
            run_id=self.managed_run_id,
            payload=required,
        )
        await runtime.event_sink.emit(
            payload=SubagentInputResumedPayload(
                subagent_id=resumed.subagent_id,
                request_id=resumed.request_id,
                decision=resumed.decision,
                detail=_redact_input_detail(resumed.detail),
            ),
            **event_kwargs,
        )
        return resumed

    def record_delegated_subagents(self, subagent_ids: list[str]) -> None:
        """Record handles this parent Run may later retrieve or cancel."""

        self._delegated_subagent_ids.update(subagent_ids)

    def require_delegated_subagent(self, subagent_id: str) -> None:
        """Fail closed for handles not created by this live parent Run."""

        if subagent_id not in self._delegated_subagent_ids:
            raise PermissionError("subagent handle does not belong to this run")

    @property
    def crawler_facade(self) -> CrawlerFacade:
        """Return the trusted crawler transport for this Run."""

        if self._crawler_facade is None:
            raise RuntimeError("crawler facade is not available")
        return self._crawler_facade

    @property
    def crawler_facade_or_none(self) -> CrawlerFacade | None:
        """Return the bound crawler for legacy isolated contexts, if any."""

        return self._crawler_facade

    @property
    def create_skill_runtime(self) -> CreateSkillRuntime:
        """Return trusted Recipe services without accepting model-provided paths."""

        if self._create_skill_runtime is None:
            raise RuntimeError("create_skill runtime is not available")
        return self._create_skill_runtime

    @contextmanager
    def reserve_create_skill(
        self,
        domain: str,
        capability: str,
    ) -> Iterator[None]:
        """Reserve one capability, releasing it only when development fails."""

        with self._create_skill_reservations.reserve(domain, capability):
            yield

    @property
    def work_dir(self) -> TaskWorkDir:
        """任务工作目录（raw/parsed/normalized/artifacts/logs）。"""
        return self._work_dir

    @property
    def output_dir(self) -> Path:
        """兼容旧版：返回 artifacts 目录路径。"""
        return self._work_dir.artifacts

    def reserve_pipeline_publication(self) -> str | None:
        """Reserve the managed Run's single Pipeline publication slot."""

        if self.managed_run_id is None:
            return None
        if self._pipeline_publication_reserved:
            raise RuntimeError("pipeline publication is already reserved")
        self._pipeline_publication_reserved = True
        return self.managed_run_id

    def bind_managed_run(self, run_id: str) -> None:
        """Bind this context to the manager's authoritative Run identity."""

        if self._pipeline_publication_reserved or self._pending_publication is not None:
            raise RuntimeError("managed run cannot change after Pipeline reservation")
        if self.managed_run_id is not None and self.managed_run_id != run_id:
            raise RuntimeError("managed run is already bound")
        self.managed_run_id = run_id

    def bind_managed_pipeline_bridge(self, bridge: ManagedPipelineBridge) -> None:
        """Bind one durable event/resume bridge to the authoritative Run."""

        if self.managed_run_id != bridge.run_id:
            raise ValueError("managed pipeline bridge run_id must match managed run")
        if self._managed_pipeline_bridge is not None:
            raise RuntimeError("managed pipeline bridge is already bound")
        self._managed_pipeline_bridge = bridge

    def bind_progress_emitter(self, emitter: ProgressEmitter) -> None:
        """Attach the Agent executor's progress event channel.

        Skills call ``emit_progress`` to surface mid-stage numbers (papers
        found, bytes downloaded, rows cleaned) to the frontend without
        waiting for stage_completed. See docs/REVIEW_2026-07-18.md §4.
        """

        if self._progress_emitter is not None:
            raise RuntimeError("progress emitter is already bound")
        self._progress_emitter = emitter

    async def emit_progress(
        self,
        stage: StageName,
        kind: str,
        current: int,
        total: int | None = None,
        detail: dict[str, object] | None = None,
    ) -> None:
        """Emit a mid-stage progress event if an emitter is bound.

        No-op when no emitter is attached (e.g. unit tests, fixture mode
        without bridge). Skills should call this freely; the context decides
        whether to forward.
        """

        emitter = self._progress_emitter
        if emitter is None:
            return
        await emitter(stage, kind, current, total, detail or {})

    @property
    def managed_pipeline_bridge(self) -> ManagedPipelineBridge | None:
        """Return the authoritative Run bridge, if this is a managed context."""

        return self._managed_pipeline_bridge

    def set_managed_terminal_error(self, error: BaseException) -> None:
        """Retain a Pipeline decision that must fail the authoritative Run."""

        if self.managed_run_id is None:
            raise RuntimeError("managed terminal errors require a managed run")
        if self._managed_terminal_error is not None:
            raise RuntimeError("managed terminal error is already installed")
        self._managed_terminal_error = error

    def take_managed_terminal_error(self) -> BaseException | None:
        """Transfer a managed terminal error to the Agent executor once."""

        error = self._managed_terminal_error
        self._managed_terminal_error = None
        return error

    def release_pipeline_publication_reservation(self) -> None:
        """Release a failed managed Pipeline Tool reservation."""

        if self._pending_publication is not None:
            raise RuntimeError("pending pipeline publication is already installed")
        self._pipeline_publication_reserved = False

    def set_pending_publication(self, handle: PendingPublication) -> None:
        """Install the validated package reserved for this managed Run."""

        if self.managed_run_id is None or not self._pipeline_publication_reserved:
            raise RuntimeError("pipeline publication is not reserved")
        if self._pending_publication is not None:
            raise RuntimeError("pending pipeline publication is already installed")
        if handle.run_id != self.managed_run_id:
            raise ValueError("pending publication run_id must match managed run_id")
        self._pending_publication = handle

    def set_pending_publication_cleanup(
        self,
        handle: PendingPublicationCleanup,
    ) -> None:
        """Retain failed cleanup for transfer to the managed Run owner."""

        if self.managed_run_id is None or not self._pipeline_publication_reserved:
            raise RuntimeError("pipeline publication is not reserved")
        if self._pending_publication is not None:
            raise RuntimeError("pending pipeline publication is already installed")
        if handle.run_id != self.managed_run_id:
            raise ValueError("pending publication run_id must match managed run_id")
        self._pending_publication = handle

    def take_pending_publication(
        self,
    ) -> PendingPublication | PendingPublicationCleanup | None:
        """Transfer the managed Run's publication ownership at most once."""

        handle = self._pending_publication
        if handle is not None:
            self._pending_publication = None
            self._pipeline_publication_reserved = False
        return handle

    def add_source(self, source: Any) -> None:
        """记录一个数据来源（SourceRecord）。"""
        self.sources.append(source)

    def add_raw_asset(self, path: str) -> None:
        """记录 raw 目录下的本地文件路径。"""
        self.raw_assets.append(path)

    def add_warning(self, severity: str, message: str, source: str | None = None) -> None:
        """记录一条警告。"""
        self.warnings.append(
            {
                "severity": severity,
                "message": message,
                "source": source,
            }
        )

    def log_query(
        self,
        query: str,
        source: str,
        status: QueryStatus | str,
        records_count: int = 0,
    ) -> None:
        """记录一次查询日志。

        ``status`` 接受 ``QueryStatus`` 枚举或字符串。枚举值会被序列化为
        其字符串形式（``QueryStatus.SUCCESS`` → ``"success"``），保证
        ``query_log`` JSON 可序列化且跨 skill 一致（TODO §1.8）。

        TODO §8.4: ``NOT_FOUND`` 状态会累加 per-source follow-up 计数，
        通过 ``followup_search_count`` property 暴露给 LLM 自查 3 轮上限。
        """
        # 支持 QueryStatus 枚举传入;StrEnum 的 __str__ 返回 value,
        # 但显式转换避免任何边界情况。
        status_value = status.value if isinstance(status, QueryStatus) else str(status)
        self.query_log.append(
            {
                "query": query,
                "source": source,
                "status": status_value,
                "records_count": records_count,
            }
        )
        # TODO §8.4: per-source follow-up counter.
        if status_value == QueryStatus.NOT_FOUND.value:
            self._followup_counts[source] = self._followup_counts.get(source, 0) + 1

    @property
    def followup_search_count(self) -> int:
        """Total follow-up searches across all sources (NOT_FOUND count).

        LLM reads this via RunContext to self-enforce the 3-round limit.
        Returns the max per-source count, so the LLM knows the worst-case
        follow-up depth. A single source hitting 3 triggers the limit.
        """
        if not self._followup_counts:
            return 0
        return max(self._followup_counts.values())

    def query_log_size(self) -> int:
        """估算 query_log 的字符总量（触发压缩判断用）。"""
        import json

        return len(json.dumps(self.query_log, ensure_ascii=False))

    def compress_log(self, keep_recent: int, summary: str) -> int:
        """用摘要替换旧查询记录，保留最近 keep_recent 条。返回被压缩的条数。"""
        total = len(self.query_log)
        if total <= keep_recent:
            return 0
        compressed = total - keep_recent
        if self.query_log_summary:
            self.query_log_summary = f"{self.query_log_summary}\n\n[后续摘要]\n{summary}"
        else:
            self.query_log_summary = summary
        self.query_log = self.query_log[-keep_recent:]
        return compressed
