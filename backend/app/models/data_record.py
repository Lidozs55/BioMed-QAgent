"""数据记录模型 — 与 biomed-data-agent-skill/schemas/data_record.schema.json 对齐。"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class SourceReference(BaseModel):
    """数据来源引用。"""
    source_name: str = ""
    url: str | None = None
    doi: str | None = None
    pmid: str | None = None
    query: str = ""
    retrieved_at: str = ""

    def to_dict(self) -> dict:
        return self.model_dump(exclude_none=True)


class DataRecord(BaseModel):
    """统一数据记录格式。"""
    record_id: str = ""
    task_id: str = ""
    fields: dict[str, Any] = Field(default_factory=dict)
    field_descriptions: dict[str, str] = Field(default_factory=dict)
    source_ref: dict = Field(default_factory=dict)
    extraction_method: str = ""       # "api" | "table" | "text" | "chart" | "crawl"
    extraction_confidence: float = 1.0
    quality_flags: list[str] = Field(default_factory=list)
    unit_info: dict[str, str] = Field(default_factory=dict)
    processing_log: list[dict] = Field(default_factory=list)

    @classmethod
    def from_dict(cls, d: dict) -> "DataRecord":
        """从字典构造，容忍缺失字段。"""
        return cls(
            record_id=d.get("record_id", ""),
            task_id=d.get("task_id", ""),
            fields=d.get("fields", {}),
            field_descriptions=d.get("field_descriptions", {}),
            source_ref=d.get("source_ref", {}),
            extraction_method=d.get("extraction_method", ""),
            extraction_confidence=d.get("extraction_confidence", 1.0),
            quality_flags=d.get("quality_flags", []),
            unit_info=d.get("unit_info", {}),
            processing_log=d.get("processing_log", []),
        )

    def to_dict(self) -> dict:
        return self.model_dump()
