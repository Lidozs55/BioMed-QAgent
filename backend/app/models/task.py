"""任务模型与状态枚举。"""
from __future__ import annotations

import uuid
from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class TaskStatus(str, Enum):
    CREATED = "created"
    PLANNING = "planning"
    SEARCHING = "searching"
    ACQUIRING = "acquiring"
    PARSING = "parsing"
    CLEANING = "cleaning"
    ANALYZING = "analyzing"
    REVIEWING = "reviewing"
    AWAITING_CONFIRMATION = "awaiting_confirmation"
    COMPLETED = "completed"
    FAILED = "failed"


class StageStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    SKIPPED = "skipped"
    FAILED = "failed"


class StageInfo(BaseModel):
    """单个阶段的状态信息。"""
    name: str
    status: StageStatus = StageStatus.PENDING
    records_count: int = 0
    message: str = ""
    started_at: str | None = None
    completed_at: str | None = None
    iterations: int = 0  # Darwinian 迭代次数


class TaskCreate(BaseModel):
    """创建任务的请求。"""
    research_goal: str = Field(..., description="研究目标，自然语言描述")
    domain_hint: str | None = Field(None, description="领域提示（如中医药/肿瘤学）")
    max_sources: int = Field(20, description="最大数据源数")
    enable_analysis: bool = Field(True, description="是否运行分析阶段")


class Task(BaseModel):
    """任务完整信息。"""
    task_id: str = Field(default_factory=lambda: f"T{uuid.uuid4().hex[:8]}")
    research_goal: str
    domain_hint: str | None = None
    max_sources: int = 20
    enable_analysis: bool = True
    status: TaskStatus = TaskStatus.CREATED
    stages: dict[str, StageInfo] = Field(default_factory=lambda: {
        s: StageInfo(name=s) for s in [
            "planning", "search", "acquire", "parse", "clean", "analyze", "review", "export"
        ]
    })
    # 分析结果
    entities: dict[str, list[str]] = Field(default_factory=lambda: {
        "compounds": [], "genes": [], "diseases": [], "pathways": []
    })
    domain: str = ""
    # 统计
    total_records: int = 0
    avg_confidence: float = 0.0
    source_count: int = 0
    # 输出路径
    output_dir: str = ""
    report_html: str = ""
    # 错误
    errors: list[str] = Field(default_factory=list)
    # 人工确认点（TASK-014 人在回路）
    pending_checkpoint: str | None = None
    checkpoint_payload: dict = Field(default_factory=dict)
    # 时间戳
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    completed_at: str | None = None

    def touch(self):
        self.updated_at = datetime.now().isoformat()

    def set_stage(self, name: str, status: StageStatus, message: str = "", **kwargs):
        if name not in self.stages:
            self.stages[name] = StageInfo(name=name)
        s = self.stages[name]
        s.status = status
        s.message = message
        now = datetime.now().isoformat()
        if status == StageStatus.RUNNING and not s.started_at:
            s.started_at = now
        if status in (StageStatus.DONE, StageStatus.FAILED):
            s.completed_at = now
        for k, v in kwargs.items():
            if hasattr(s, k):
                setattr(s, k, v)
        self.touch()

    def to_summary(self) -> dict:
        return {
            "task_id": self.task_id,
            "research_goal": self.research_goal,
            "status": self.status.value,
            "total_records": self.total_records,
            "avg_confidence": round(self.avg_confidence, 3),
            "source_count": self.source_count,
            "stages": {k: v.model_dump() for k, v in self.stages.items()},
            "entities": self.entities,
            "domain": self.domain,
            "errors": self.errors,
            "pending_checkpoint": self.pending_checkpoint,
            "created_at": self.created_at,
            "completed_at": self.completed_at,
        }
