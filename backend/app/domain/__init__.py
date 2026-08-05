"""domain 包 — 任务领域模型。

注意：本包存在新旧两套模型，正在迁移中：

- ``app.domain.contracts``：权威的 pydantic v2 契约体系（ContractModel，
  extra=forbid，schema_version）。所有 acquisition skill 和 Pipeline 使用此体系。
- ``app.domain.processing``：旧 MVP dataclass 模型，仍被 ``app.tools.parse_*``、
  ``app.tools.cleaning``、``app.tools.alignment`` 等通用解析工具使用。
  这些工具是 MVP 遗留，已被 Pipeline 的专用 processor（如 ``geo_tximport.py``）
  取代，待后续清理。

新代码应直接从 ``app.domain.contracts`` 导入，不要使用本包的顶层导出。

REVIEW 2026-08-05: 已删除生产零引用的 ``domain.task`` / ``domain.events``
（旧 TaskStateMachine / EventFactory 已由 ``contracts`` 运行时体系取代）。
"""
from app.domain.processing import CleaningReport, ParsedDataset

__all__ = [
    "CleaningReport",
    "ParsedDataset",
]
