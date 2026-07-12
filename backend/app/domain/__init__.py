"""domain 包 — 任务领域模型（用户输入、任务记录、状态机、事件）。"""
from app.domain.events import EventFactory, EventType, TaskEvent
from app.domain.task import (
    InvalidTaskTransition,
    TaskRecord,
    TaskRequest,
    TaskStateMachine,
    TaskStatus,
)

__all__ = [
    "EventFactory",
    "EventType",
    "TaskEvent",
    "InvalidTaskTransition",
    "TaskRecord",
    "TaskRequest",
    "TaskStateMachine",
    "TaskStatus",
]
