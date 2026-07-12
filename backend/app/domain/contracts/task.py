"""User request and Agent-produced data requirement contracts."""

from __future__ import annotations

from typing import Literal

from pydantic import Field, field_validator

from app.domain.contracts.base import ContractModel
from app.domain.contracts.enums import Database, RequestedOutput


class TaskRequest(ContractModel):
    topic: str
    databases: list[Database] = Field(
        default_factory=lambda: [Database.PUBMED, Database.GEO]
    )
    keywords: list[str] = Field(default_factory=list)
    target_fields: list[str] = Field(default_factory=list)
    time_range: tuple[str, str] | None = None

    @field_validator("topic")
    @classmethod
    def validate_topic(cls, value: str) -> str:
        topic = value.strip()
        if not topic:
            raise ValueError("topic must not be blank")
        return topic


class QuerySpecification(ContractModel):
    query_id: str = Field(min_length=1)
    database: Database
    query: str = Field(min_length=1)
    generated_by: Literal["user", "agent", "pipeline"]
    purpose: str = Field(min_length=1)
    order: int = Field(gt=0)
    page_size: int | None = Field(default=None, gt=0)
    max_results: int | None = Field(default=None, gt=0)


class DatasetSelection(ContractModel):
    dataset_id: str = Field(min_length=1)
    database: Database
    accession: str = Field(min_length=1)
    source_id: str | None = None
    reason: str = Field(min_length=1)


class TaskSpecification(ContractModel):
    topic: str = Field(min_length=1)
    queries: list[QuerySpecification] = Field(default_factory=list)
    datasets: list[DatasetSelection] = Field(default_factory=list)
    requested_outputs: list[RequestedOutput] = Field(default_factory=list)
