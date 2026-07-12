"""任务领域模型 — 用户输入、任务记录、状态机。

对应 TODO.md Section 4.1（用户输入）与任务生命周期。
"""
from __future__ import annotations

import re
from enum import Enum

from pydantic import BaseModel, field_validator, model_validator


# ---------------------------------------------------------------------------
# 用户输入
# ---------------------------------------------------------------------------


class TaskRequest(BaseModel):
    """用户研究请求 — topic 是唯一必填字段。

    Attributes:
        topic: 研究主题（自动 strip，拒绝空白）。
        preferred_sources: 允许检索的数据库列表。空表示加载默认集合。
        keywords: 可选关键词。
        target_fields: 可选目标字段。
        time_range: 可选时间范围。
    """

    topic: str
    preferred_sources: list[str] = []
    keywords: list[str] = []
    target_fields: list[str] = []
    time_range: str | None = None

    @field_validator("topic")
    @classmethod
    def _topic_must_be_non_empty(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("topic 不能为空")
        return stripped


# ---------------------------------------------------------------------------
# 任务记录
# ---------------------------------------------------------------------------

# task_id 安全约束：非空、≤64 字符、无路径分隔符、无 ".."、无空格
_TASK_ID_PATTERN = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")


class TaskRecord(BaseModel):
    """任务记录 — 包含 task_id 和用户请求。

    task_id 必须安全：非空、≤64 字符、仅字母数字下划线短横线。
    拒绝路径穿越（../）、绝对路径（C:/）、空格和超长字符串。
    """

    task_id: str
    request: TaskRequest

    @field_validator("task_id")
    @classmethod
    def _task_id_must_be_safe(cls, v: str) -> str:
        if not _TASK_ID_PATTERN.match(v):
            raise ValueError(
                "task_id 必须为 1-64 个字母数字、下划线或短横线，"
                "拒绝路径穿越、绝对路径和空格"
            )
        return v


# ---------------------------------------------------------------------------
# 状态机
# ---------------------------------------------------------------------------


class TaskStatus(str, Enum):
    """任务生命周期状态。"""

    CREATED = "created"
    PLANNING = "planning"
    DISCOVERY = "discovery"
    ACQUISITION = "acquisition"
    PROCESSING = "processing"
    ANALYSIS = "analysis"
    COMPLETED = "completed"
    FAILED = "failed"


class InvalidTaskTransition(Exception):
    """非法状态转换。"""


class TaskStateMachine:
    """任务状态机 — 校验状态转换合法性。

    合法转换：
        CREATED     -> PLANNING, FAILED
        PLANNING    -> DISCOVERY, FAILED
        DISCOVERY   -> ACQUISITION, FAILED
        ACQUISITION -> PROCESSING, FAILED
        PROCESSING  -> ANALYSIS, COMPLETED, FAILED
        ANALYSIS    -> COMPLETED, FAILED
        COMPLETED   -> （终态）
        FAILED      -> （终态）
    """

    _TRANSITIONS: dict[TaskStatus, frozenset[TaskStatus]] = {
        TaskStatus.CREATED: frozenset({TaskStatus.PLANNING, TaskStatus.FAILED}),
        TaskStatus.PLANNING: frozenset({TaskStatus.DISCOVERY, TaskStatus.FAILED}),
        TaskStatus.DISCOVERY: frozenset({TaskStatus.ACQUISITION, TaskStatus.FAILED}),
        TaskStatus.ACQUISITION: frozenset({TaskStatus.PROCESSING, TaskStatus.FAILED}),
        TaskStatus.PROCESSING: frozenset({
            TaskStatus.ANALYSIS, TaskStatus.COMPLETED, TaskStatus.FAILED,
        }),
        TaskStatus.ANALYSIS: frozenset({TaskStatus.COMPLETED, TaskStatus.FAILED}),
        TaskStatus.COMPLETED: frozenset(),
        TaskStatus.FAILED: frozenset(),
    }

    @classmethod
    def transition(cls, current: TaskStatus, target: TaskStatus) -> TaskStatus:
        """校验并执行状态转换。非法转换抛出 InvalidTaskTransition。"""
        allowed = cls._TRANSITIONS.get(current, frozenset())
        if target not in allowed:
            raise InvalidTaskTransition(
                f"{current.value} -> {target.value} 不是合法转换"
            )
        return target
