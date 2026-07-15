"""RunContext — Agent loop 运行期间的共享状态。

所有工具可通过 context 访问/修改共享状态（记录、查询日志、产出物路径等）。

对应 TODO.md Section 4.2：扩展 RunContext 字段。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.tools.workdir import TaskWorkDir, create_task_workdir


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

    def __post_init__(self) -> None:
        """初始化时自动创建任务工作目录。"""
        self._work_dir: TaskWorkDir = create_task_workdir(self.task_id)

    @property
    def work_dir(self) -> TaskWorkDir:
        """任务工作目录（raw/parsed/normalized/artifacts/logs）。"""
        return self._work_dir

    @property
    def output_dir(self) -> Path:
        """兼容旧版：返回 artifacts 目录路径。"""
        return self._work_dir.artifacts

    def add_source(self, source: Any) -> None:
        """记录一个数据来源（SourceRecord）。"""
        self.sources.append(source)

    def add_raw_asset(self, path: str) -> None:
        """记录 raw 目录下的本地文件路径。"""
        self.raw_assets.append(path)

    def add_warning(
        self, severity: str, message: str, source: str | None = None
    ) -> None:
        """记录一条警告。"""
        self.warnings.append(
            {
                "severity": severity,
                "message": message,
                "source": source,
            }
        )

    def log_query(
        self, query: str, source: str, status: str, records_count: int = 0
    ) -> None:
        """记录一次查询日志。"""
        self.query_log.append(
            {
                "query": query,
                "source": source,
                "status": status,
                "records_count": records_count,
            }
        )

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
            self.query_log_summary = (
                f"{self.query_log_summary}\n\n[后续摘要]\n{summary}"
            )
        else:
            self.query_log_summary = summary
        self.query_log = self.query_log[-keep_recent:]
        return compressed
