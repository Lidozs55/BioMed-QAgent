"""Legacy processing domain model — ParsedDataset only.

Kept solely as the in-memory row model consumed by the deterministic merge
path: ``pipeline.stages.processing`` adapts Pipeline ``contracts.ParsedDataset``
entries through ``_to_legacy_parsed_datasets`` into this dataclass so
``app.tools.alignment`` can align and vertically merge them (REVIEW
2026-08-05 B2). The ``CleaningReport`` counterpart was removed together with
the legacy ``app.tools.cleaning`` module.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime


@dataclass
class ParsedDataset:
    """解析结果 — 从一个原始文件中解析出的结构化数据集。

    解析结果写入 task/parsed/，不覆盖 raw 文件。
    """

    dataset_id: str  # 数据集 ID（如 "GSE12345_matrix" 或文件名）
    source_file: str  # 原始文件路径（raw 目录下）
    table_name: str  # 表/Sheet/区块名称
    field_names: list[str]  # 字段名
    field_types: dict[str, str]  # 字段名 → 推断类型 (string/int/float/date/bool)
    rows: list[dict]  # 数据行（每行为字段名到值的映射）
    # 来源定位
    source_locator: str = ""  # 如 "sheet1!A1:D100" 或 "page 5, table 2"
    # 解析器元信息
    parser_name: str = ""
    parser_version: str = "0.1.0"
    parsed_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    warnings: list[str] = field(default_factory=list)

    @property
    def row_count(self) -> int:
        return len(self.rows)

    @property
    def col_count(self) -> int:
        return len(self.field_names)
