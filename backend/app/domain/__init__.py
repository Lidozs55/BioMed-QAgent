"""domain 包 — 任务领域模型。

注意：本包存在新旧两套模型，正在迁移中：

- ``app.domain.contracts``：权威的 pydantic v2 契约体系（ContractModel，
  extra=forbid，schema_version）。所有 acquisition skill 和 Pipeline 使用此体系。
- ``app.domain.output`` / ``app.domain.processing``：旧 MVP dataclass 模型，
  仍被 ``app.tools.export``、``app.tools.parse_*``、``app.tools.cleaning`` 等
  通用解析工具使用。这些工具是 MVP 遗留，已被 Pipeline 的专用 processor
  （如 ``geo_tximport.py``）取代，待后续清理。

新代码应直接从 ``app.domain.contracts`` 导入，不要使用本包的顶层导出。
"""
from app.domain.events import EventFactory, EventType, TaskEvent
from app.domain.output import (
    DataRecord,
    FieldDescription,
    OutputBundle,
    ProcessingStep,
    SourceRecord,
    WarningEntry,
)
from app.domain.processing import CleaningReport, ParsedDataset
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
    "DataRecord",
    "FieldDescription",
    "OutputBundle",
    "ProcessingStep",
    "SourceRecord",
    "WarningEntry",
    "CleaningReport",
    "ParsedDataset",
]
