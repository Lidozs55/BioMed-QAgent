"""domain 包 — 任务领域模型。

注意：本包存在新旧两套模型，正在迁移中：

- ``app.domain.contracts``：权威的 pydantic v2 契约体系（ContractModel，
  extra=forbid，schema_version）。所有 acquisition skill 和 Pipeline 使用此体系。
- ``app.domain.processing``：旧 MVP dataclass 模型（仅 ``ParsedDataset``）。
  它不再供通用解析工具使用（``app.tools.parse_*`` / ``cleaning`` 已随
  REVIEW 2026-08-05 B2 删除），仅保留为 deterministic merge 路径的内存行模型：
  ``pipeline.stages.processing`` 经 ``_to_legacy_parsed_datasets`` 适配后交给
  ``app.tools.alignment`` 对齐合并（GDC+Xena 多数据集路径）。

新代码应直接从 ``app.domain.contracts`` 导入，不要使用本包的顶层导出。

REVIEW 2026-08-05: 已删除生产零引用的 ``domain.task`` / ``domain.events``
（旧 TaskStateMachine / EventFactory 已由 ``contracts`` 运行时体系取代）；
同时删除 legacy ``CleaningReport`` 与其唯一使用者 ``app.tools.cleaning``。
"""

__all__ = [
    "ParsedDataset",
]
