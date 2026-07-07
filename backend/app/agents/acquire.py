"""Acquire Agent — 浏览器/爬虫采集（隔离占位）。

从 Orchestrator._stage_acquire 迁入。当前实现完全隔离：
- 识别 search 阶段收集的 requires_crawl 信号
- 记录需要爬虫的数据源到 task.errors（非致命提示）
- 不执行实际爬取，返回原始 records 不变
- 异常被捕获，绝不影响后续 parse/clean/analyze 阶段

后续可通过 Project Skill Library 升级为可执行的 Acquire Skill。
"""
from __future__ import annotations

import logging

from app.agents.base import BaseAgent, ProgressCallback
from app.agents.registry import AgentRegistry
from app.models.task import Task, StageStatus

logger = logging.getLogger(__name__)


@AgentRegistry.register
class AcquireAgent(BaseAgent):
    name = "acquire"
    description = "浏览器/爬虫采集（当前为隔离占位）"

    async def execute(self, task: Task, records: list[dict],
                      context: dict,
                      progress: ProgressCallback | None = None) -> tuple[list[dict], dict]:
        self._set_stage(task, "acquire", StageStatus.RUNNING,
                        "检查需要爬虫采集的数据源...")
        self._emit(progress, type="stage_start", stage="acquire",
                    message="检查需要爬虫采集的数据源...")

        try:
            crawl_targets = context.get("crawl_targets", [])
            crawl_needed = len(crawl_targets)

            if crawl_needed > 0:
                sources_list = ", ".join(t["source"] for t in crawl_targets)
                self._emit(progress, type="stage_progress", stage="acquire",
                            pct=0.5,
                            message=f"需要爬虫采集: {sources_list}（当前未实现，已跳过）")
                task.errors.append(
                    f"acquire: {crawl_needed} 个数据源需要爬虫采集"
                    f"（{sources_list}），当前未实现浏览器工具，已跳过。"
                    "对接方式见 docs/agent_browser_integration.md"
                )

            msg = (f"采集阶段完成。需要爬虫的数据源: {crawl_needed} 个"
                   f"{'（已跳过，未实现）' if crawl_needed else '（无需爬虫）'}")
            self._set_stage(task, "acquire", StageStatus.DONE, msg,
                            records_count=len(records))
            self._emit(progress, type="stage_complete", stage="acquire", message=msg)
        except Exception as e:
            logger.warning("acquire 阶段异常（已隔离）: %s", e)
            self._set_stage(task, "acquire", StageStatus.DONE,
                            f"采集阶段异常已隔离: {e}", records_count=len(records))
            self._emit(progress, type="stage_complete", stage="acquire",
                        message=f"采集阶段异常已隔离: {e}")

        self.store.update_task(task)
        return records, context
