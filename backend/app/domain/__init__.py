"""domain 包 — 任务领域模型。

权威模型统一在 ``app.domain.contracts``（pydantic v2 ContractModel 体系，
extra=forbid，schema_version）。旧 MVP in-memory dataclass 层
（``ParsedDataset`` / ``app.domain.processing``）已随 V1 确定性 pipeline
退役删除。

新代码应直接从 ``app.domain.contracts`` 导入，不要使用本包的顶层导出。
"""
