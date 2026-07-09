"""任务存储 — 内存 + 文件持久化。

使用内存字典做快速访问，同时持久化到 JSON 文件做恢复。
不引入 SQLite/Redis 等外部依赖，保持轻量。
"""
from __future__ import annotations

import json
import logging
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from app.config import OUTPUT_DIR
from app.models.task import Task, TaskStatus
from app.provenance.tracker import ProvenanceTracker

logger = logging.getLogger(__name__)


class TaskStore:
    """任务存储。"""

    def __init__(self):
        self._tasks: dict[str, Task] = {}
        self._provenance: dict[str, ProvenanceTracker] = {}
        self._records: dict[str, list[dict]] = {}  # task_id -> [record_dict]
        self._reports: dict[str, str] = {}  # task_id -> html
        self._analysis: dict[str, dict] = {}  # task_id -> analysis_results
        self._lock = threading.Lock()

    # ---- Task CRUD ----
    def create_task(self, research_goal: str, domain_hint: str | None = None,
                    max_sources: int = 20, enable_analysis: bool = True) -> Task:
        task = Task(
            research_goal=research_goal,
            domain_hint=domain_hint,
            max_sources=max_sources,
            enable_analysis=enable_analysis,
        )
        task.output_dir = str(OUTPUT_DIR / task.task_id)
        (OUTPUT_DIR / task.task_id).mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._tasks[task.task_id] = task
            self._provenance[task.task_id] = ProvenanceTracker(task.task_id)
            self._records[task.task_id] = []
        return task

    def get_task(self, task_id: str) -> Task | None:
        return self._tasks.get(task_id)

    def list_tasks(self) -> list[Task]:
        return sorted(self._tasks.values(),
                       key=lambda t: t.created_at, reverse=True)

    def update_task(self, task: Task):
        task.touch()
        with self._lock:
            self._tasks[task.task_id] = task

    def delete_task(self, task_id: str):
        with self._lock:
            self._tasks.pop(task_id, None)
            self._provenance.pop(task_id, None)
            self._records.pop(task_id, None)
            self._reports.pop(task_id, None)
            self._analysis.pop(task_id, None)

    # ---- Provenance ----
    def get_provenance(self, task_id: str) -> ProvenanceTracker | None:
        return self._provenance.get(task_id)

    # ---- Analysis ----
    def set_analysis(self, task_id: str, analysis: dict):
        with self._lock:
            self._analysis[task_id] = analysis

    def get_analysis(self, task_id: str) -> dict:
        return self._analysis.get(task_id, {})

    # ---- Records ----
    def set_records(self, task_id: str, records: list[dict]):
        with self._lock:
            self._records[task_id] = records

    def get_records(self, task_id: str, limit: int = 100,
                    offset: int = 0) -> list[dict]:
        recs = self._records.get(task_id, [])
        return recs[offset:offset + limit]

    def get_records_count(self, task_id: str) -> int:
        return len(self._records.get(task_id, []))

    # ---- Report ----
    def set_report(self, task_id: str, html: str):
        self._reports[task_id] = html

    def get_report(self, task_id: str) -> str:
        return self._reports.get(task_id, "")

    # ---- 持久化 ----
    def save_task_to_file(self, task_id: str):
        """保存任务数据到文件。"""
        task = self.get_task(task_id)
        if not task:
            return
        out_dir = Path(task.output_dir) if task.output_dir else OUTPUT_DIR / task_id
        out_dir.mkdir(parents=True, exist_ok=True)

        # 保存任务摘要
        summary = task.to_summary()
        with open(out_dir / "task_summary.json", "w", encoding="utf-8") as f:
            json.dump(summary, f, ensure_ascii=False, indent=2)

        # 保存记录
        records = self._records.get(task_id, [])
        if records:
            with open(out_dir / "records.json", "w", encoding="utf-8") as f:
                json.dump(records, f, ensure_ascii=False, indent=2)

        # 保存分析结果
        analysis = self._analysis.get(task_id, {})
        if analysis:
            with open(out_dir / "analysis.json", "w", encoding="utf-8") as f:
                json.dump(analysis, f, ensure_ascii=False, indent=2)

        # 保存溯源图
        prov = self.get_provenance(task_id)
        if prov and prov.nodes:
            prov.save(out_dir)

        # 保存报告
        report = self._reports.get(task_id, "")
        if report:
            with open(out_dir / "report.html", "w", encoding="utf-8") as f:
                f.write(report)

    def load_from_disk(self):
        """从磁盘恢复所有任务（后端启动时调用）。

        扫描 OUTPUT_DIR 下所有 task_summary.json，重建内存状态。
        """
        from app.models.task import Task
        if not OUTPUT_DIR.exists():
            return
        loaded = 0
        for task_dir in sorted(OUTPUT_DIR.iterdir()):
            if not task_dir.is_dir():
                continue
            summary_file = task_dir / "task_summary.json"
            if not summary_file.exists():
                continue
            try:
                with open(summary_file, "r", encoding="utf-8") as f:
                    summary = json.load(f)
                # 从 summary 重建 Task 对象
                task = Task(
                    research_goal=summary.get("research_goal", ""),
                    domain_hint=summary.get("domain", "") or None,
                    max_sources=summary.get("source_count", 20) or 20,
                    enable_analysis=True,
                )
                task.task_id = summary["task_id"]
                # status 需要转 enum
                status_str = summary.get("status", "completed")
                try:
                    task.status = TaskStatus(status_str)
                except ValueError:
                    task.status = TaskStatus.COMPLETED
                # 崩溃恢复：running 态任务在后端重启后已无进程支撑，重置为 FAILED
                _RUNNING_STATES = {
                    TaskStatus.PLANNING, TaskStatus.SEARCHING,
                    TaskStatus.ACQUIRING, TaskStatus.PARSING,
                    TaskStatus.CLEANING, TaskStatus.ANALYZING,
                    TaskStatus.REVIEWING,
                }
                if task.status in _RUNNING_STATES:
                    task.status = TaskStatus.FAILED
                    task.errors.append("后端重启时任务处于运行态，已自动标记为失败")
                task.domain = summary.get("domain", "")
                task.entities = summary.get("entities", {})
                task.total_records = summary.get("total_records", 0)
                task.avg_confidence = summary.get("avg_confidence", 0.0)
                task.source_count = summary.get("source_count", 0)
                task.created_at = summary.get("created_at", "")
                task.completed_at = summary.get("completed_at")
                task.output_dir = str(task_dir)
                # 恢复人工确认检查点数据（awaiting_confirmation 任务需依赖此数据）
                task.pending_checkpoint = summary.get("pending_checkpoint")
                task.checkpoint_payload = summary.get("checkpoint_payload", {})
                # stages 重建
                for name, info in summary.get("stages", {}).items():
                    if name in task.stages:
                        task.stages[name].status = info.get("status", "pending")
                        task.stages[name].message = info.get("message", "")
                        task.stages[name].records_count = info.get("records_count", 0)
                task.errors = summary.get("errors", [])

                with self._lock:
                    self._tasks[task.task_id] = task
                    prov = ProvenanceTracker(task.task_id)
                    # 恢复溯源图（lineage.json）
                    prov.load(task_dir)
                    self._provenance[task.task_id] = prov
                # 加载 records
                records_file = task_dir / "records.json"
                if records_file.exists():
                    with open(records_file, "r", encoding="utf-8") as f:
                        records = json.load(f)
                    with self._lock:
                        self._records[task.task_id] = records
                # 加载 analysis
                analysis_file = task_dir / "analysis.json"
                if analysis_file.exists():
                    with open(analysis_file, "r", encoding="utf-8") as f:
                        analysis = json.load(f)
                    with self._lock:
                        self._analysis[task.task_id] = analysis
                # 加载 report
                report_file = task_dir / "report.html"
                if report_file.exists():
                    with open(report_file, "r", encoding="utf-8") as f:
                        self._reports[task.task_id] = f.read()
                loaded += 1
            except Exception as e:
                logger.warning(f"恢复任务失败 {task_dir.name}: {e}")
        if loaded:
            logger.info(f"从磁盘恢复了 {loaded} 个任务")


# 全局单例
_store: TaskStore | None = None


def get_task_store() -> TaskStore:
    global _store
    if _store is None:
        _store = TaskStore()
        _store.load_from_disk()
    return _store
