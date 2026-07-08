"""Acquire Agent — 爬虫采集（fallback，隔离执行）。

从 Orchestrator._stage_acquire 迁入，职责：
- 读取 search 阶段收集的 requires_crawl 信号（context["crawl_targets"]）
- 调用 WebCrawlerSource 爬取目标页面，输出 raw crawl record（含 raw_content）
- raw crawl record 由后续 parse 阶段的 LLMExtractor 转为结构化 DataRecord
- 完全隔离：爬虫失败不阻塞流水线，异常被捕获

对接文档：docs/agent_browser_integration.md
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
    description = "爬虫采集（fallback，输出原始文本供 parse 阶段 LLM 提取）"

    async def execute(self, task: Task, records: list[dict],
                      context: dict,
                      progress: ProgressCallback | None = None) -> tuple[list[dict], dict]:
        self._set_stage(task, "acquire", StageStatus.RUNNING,
                        "检查需要爬虫采集的数据源...")
        self._emit(progress, type="stage_start", stage="acquire",
                    message="检查需要爬虫采集的数据源...")

        try:
            crawl_targets = context.get("crawl_targets", [])

            if not crawl_targets:
                msg = "采集阶段完成（无需爬虫）"
                self._set_stage(task, "acquire", StageStatus.DONE, msg,
                                records_count=len(records))
                self._emit(progress, type="stage_complete", stage="acquire",
                            message=msg)
                self.store.update_task(task)
                return records, context

            # 有爬虫目标：执行爬取
            crawl_records = await self._crawl_targets(
                crawl_targets, task, progress)

            # raw crawl record 追加到 records，由 parse 阶段 LLM 提取
            records.extend(crawl_records)
            context["crawl_record_count"] = len(crawl_records)

            sources_list = ", ".join(t["source"] for t in crawl_targets)
            msg = (f"采集完成：爬取 {len(crawl_targets)} 个目标"
                   f"（{sources_list}），获得 {len(crawl_records)} 条原始记录"
                   f"（待 parse 阶段 LLM 提取）")
            self._set_stage(task, "acquire", StageStatus.DONE, msg,
                            records_count=len(records))
            self._emit(progress, type="stage_complete", stage="acquire",
                        message=msg)
        except Exception as e:
            # 隔离：爬虫异常绝不影响后续阶段
            logger.warning("acquire 阶段异常（已隔离）: %s", e)
            self._set_stage(task, "acquire", StageStatus.DONE,
                            f"采集阶段异常已隔离: {e}", records_count=len(records))
            self._emit(progress, type="stage_complete", stage="acquire",
                        message=f"采集阶段异常已隔离: {e}")

        self.store.update_task(task)
        return records, context

    async def _crawl_targets(self, crawl_targets: list[dict], task: Task,
                              progress: ProgressCallback | None) -> list[dict]:
        """逐个爬取 crawl_targets，返回 raw crawl record 列表。

        逐个执行（而非并行）以遵守各站点限速，避免被反爬。
        """
        total = len(crawl_targets)
        all_raw: list[dict] = []

        for idx, target in enumerate(crawl_targets):
            source = target.get("source", "web_crawler")
            query = target.get("query", "")
            pct = (idx + 1) / total
            self._emit(progress, type="stage_progress", stage="acquire",
                        pct=pct,
                        message=f"爬取 {source}: {query[:30]} ({idx+1}/{total})")

            result = await self._to_thread(
                self.tools.crawl_web, [target], task.task_id,
            )
            if result.success:
                raw_recs = result.data or []
                all_raw.extend(raw_recs)
                self._emit(progress, type="stage_progress", stage="acquire",
                            pct=pct,
                            message=f"✓ {source}: {len(raw_recs)} 条原始记录")
            else:
                task.errors.append(f"crawl {source}: {result.error}")
                self._emit(progress, type="stage_progress", stage="acquire",
                            pct=pct,
                            message=f"✗ {source}: {result.error[:50]}")

        return all_raw
