"""事件领域模型 — 任务生命周期事件工厂。

用于记录任务状态变更和关键操作，支持来源追踪和审计。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from itertools import count


class EventType(str, Enum):
    """任务事件类型。"""

    TASK_CREATED = "task_created"
    STATUS_CHANGED = "status_changed"
    SKILL_LOADED = "skill_loaded"
    TOOL_CALLED = "tool_called"
    TOOL_OUTPUT = "tool_output"
    FILE_DOWNLOADED = "file_downloaded"
    ARTIFACT_PRODUCED = "artifact_produced"
    WARNING = "warning"
    TASK_COMPLETED = "task_completed"
    TASK_FAILED = "task_failed"


@dataclass
class TaskEvent:
    """任务事件记录。"""

    schema_version: str
    task_id: str
    run_id: str
    sequence: int
    event_type: EventType
    payload: dict
    timestamp: datetime


class EventFactory:
    """事件工厂 — 为同一 task/run 生成递增序列号的事件。"""

    def __init__(self, task_id: str, run_id: str) -> None:
        self._task_id = task_id
        self._run_id = run_id
        self._counter = count(1)

    def create(self, event_type: EventType, payload: dict) -> TaskEvent:
        """创建一个带递增序列号和时间戳的事件。"""
        return TaskEvent(
            schema_version="1.0",
            task_id=self._task_id,
            run_id=self._run_id,
            sequence=next(self._counter),
            event_type=event_type,
            payload=payload,
            timestamp=datetime.now(timezone.utc),
        )
