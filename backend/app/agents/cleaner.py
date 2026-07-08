"""Cleaner Agent — 数据清洗与字段对齐。

从 Orchestrator._stage_clean 迁入，职责：
- 字段对齐（dictionaries 归一化字段名）
- 单位归一化
- 去重
- 质量标记统计 + 记录溯源
"""
from __future__ import annotations

import logging

from app.agents.base import BaseAgent, ProgressCallback
from app.agents.registry import AgentRegistry
from app.models.task import Task, StageStatus
from app.utils.paths import get_task_output_dir, get_dictionaries_dir

logger = logging.getLogger(__name__)


@AgentRegistry.register
class CleanerAgent(BaseAgent):
    name = "clean"
    description = "字段对齐 + 单位归一化 + 去重"

    async def execute(self, task: Task, records: list[dict],
                      context: dict,
                      progress: ProgressCallback | None = None) -> tuple[list[dict], dict]:
        self._set_stage(task, "clean", StageStatus.RUNNING, "正在清洗与字段对齐...")
        self._emit(progress, type="stage_start", stage="clean",
                    message="数据清洗：字段对齐、单位归一化、去重...")

        out_dir = get_task_output_dir(task.task_id)
        cleaned = records

        # 保存原始记录（供溯源/调试）
        raw_file = out_dir / "raw_records.json"
        self._write_records(raw_file, records)

        # Step 1: 字段对齐
        self._emit(progress, type="stage_progress", stage="clean",
                    pct=0.2, message="字段对齐中...")
        dict_dir = get_dictionaries_dir()
        result = await self._to_thread(self.tools.align_fields, cleaned, dict_dir)
        if result.success:
            cleaned = self._extract_records(result) or cleaned
            self._write_records(out_dir / "aligned_records.json", cleaned)
            self._emit(progress, type="stage_progress", stage="clean",
                        pct=0.4, message=f"字段对齐完成：{len(cleaned)} 条")
        else:
            task.errors.append(f"field_aligner: {result.error}")

        # Step 2: 单位归一化
        self._emit(progress, type="stage_progress", stage="clean",
                    pct=0.6, message="单位归一化中...")
        if cleaned:
            result = await self._to_thread(self.tools.normalize_units, cleaned)
            if result.success:
                cleaned = self._extract_records(result) or cleaned
                self._write_records(out_dir / "normalized_records.json", cleaned)
                self._emit(progress, type="stage_progress", stage="clean",
                            pct=0.8, message=f"单位归一化完成：{len(cleaned)} 条")
            else:
                task.errors.append(f"unit_normalizer: {result.error}")

        # Step 3: 去重
        if cleaned:
            result = await self._to_thread(self.tools.deduplicate, cleaned)
            if result.success:
                cleaned = self._extract_records(result) or cleaned
                self._emit(progress, type="stage_progress", stage="clean",
                            pct=0.95, message=f"去重完成：{len(cleaned)} 条")
        self._write_records(out_dir / "deduped_records.json", cleaned)

        # 统计质量标记
        flags_count = sum(1 for r in cleaned if r.get("quality_flags"))
        avg_conf = 0.0
        if cleaned:
            confs = [r.get("extraction_confidence", 1.0) for r in cleaned]
            avg_conf = sum(confs) / len(confs)

        msg = (f"清洗完成：{len(cleaned)} 条记录，平均置信度 {avg_conf:.2%}，"
               f"{flags_count} 条有质量标记")
        task.avg_confidence = avg_conf
        self._set_stage(task, "clean", StageStatus.DONE, msg,
                        records_count=len(cleaned))
        self._emit(progress, type="stage_complete", stage="clean",
                    message=msg, records_count=len(cleaned),
                    avg_confidence=avg_conf)

        # 记录溯源：清洗阶段
        prov = self.store.get_provenance(task.task_id)
        if prov and cleaned:
            rec_ids = [r.get("record_id", "") for r in cleaned]
            input_ids = [r.get("record_id", "") for r in records]
            prov.record("clean", "clean_agent",
                       tool_name="field_aligner+unit_normalizer+duplicate_detector",
                       input_records=input_ids,
                       output_records=rec_ids,
                       parameters={"input_count": len(records),
                                   "output_count": len(cleaned),
                                   "avg_confidence": avg_conf})

        self.store.set_records(task.task_id, cleaned)
        self.store.update_task(task)
        return cleaned, context
