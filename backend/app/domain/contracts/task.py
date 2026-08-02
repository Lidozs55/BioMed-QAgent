"""User request and Agent-produced data requirement contracts."""

from __future__ import annotations

from typing import Literal

from pydantic import Field, field_validator

from app.domain.contracts.base import ContractModel
from app.domain.contracts.enums import (
    DATABASE_IDENTIFIER_ALIASES,
    SOURCE_CAPABILITIES,
    Database,
    RequestedOutput,
    SourceCapability,
)


class TaskRequest(ContractModel):
    topic: str
    databases: list[Database] = Field(default_factory=lambda: [Database.PUBMED, Database.GEO])
    keywords: list[str] = Field(default_factory=list)
    target_fields: list[str] = Field(default_factory=list)
    time_range: tuple[str, str] | None = None
    mode: Literal["fixture", "live"] = "fixture"
    reactome_pathway_id: str | None = None

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
    data_type: str | None = None


class SourceCapabilityDeclaration(ContractModel):
    """Pipeline input-level capability declaration for one source (TODO §1.4).

    ``database`` is the canonical ``Database`` member; ``identifier`` records
    the user-facing identifier that was selected (e.g. ``xena`` for
    ``ucsc_xena``) so the declaration stays truthful to what was requested.
    """

    database: Database | None
    capability: SourceCapability
    identifier: str = ""
    note: str = ""


class TaskSpecification(ContractModel):
    topic: str = Field(min_length=1)
    queries: list[QuerySpecification] = Field(default_factory=list)
    datasets: list[DatasetSelection] = Field(default_factory=list)
    requested_outputs: list[RequestedOutput] = Field(default_factory=list)
    # Pipeline input-level capability declarations for the selected sources.
    # Agent-only sources are declared ``research_only`` / ``pending`` so they
    # can only be used for investigation, never routed into the Pipeline as
    # verified data sources (TODO §1.4).
    source_capabilities: list[SourceCapabilityDeclaration] = Field(
        default_factory=list
    )

    @classmethod
    def declare_sources(
        cls,
        *,
        topic: str,
        identifiers: list[str],
        queries: list[QuerySpecification] | None = None,
        datasets: list[DatasetSelection] | None = None,
        requested_outputs: list[RequestedOutput] | None = None,
    ) -> TaskSpecification:
        """Build a specification that declares each selected source's capability.

        Unknown identifiers resolve to ``SourceCapability.PENDING`` so an
        explicit declaration always exists for every selected source; the
        Pipeline tool performs the authoritative rejection before running.
        """
        declarations: list[SourceCapabilityDeclaration] = []
        seen: set[Database] = set()
        for identifier in identifiers:
            normalized = identifier.strip().lower()
            database = DATABASE_IDENTIFIER_ALIASES.get(normalized)
            if database is None:
                declarations.append(
                    SourceCapabilityDeclaration(
                        database=None,
                        capability=SourceCapability.PENDING,
                        identifier=normalized,
                        note="unknown source; awaiting integration",
                    )
                )
                continue
            if database in seen:
                continue
            seen.add(database)
            capability = SOURCE_CAPABILITIES[database]
            declarations.append(
                SourceCapabilityDeclaration(
                    database=database,
                    capability=capability,
                    identifier=normalized,
                    note=(
                        ""
                        if capability == SourceCapability.PIPELINE_SUPPORTED
                        else "Agent-only investigation source; not accepted by the Pipeline"
                    ),
                )
            )
        return cls(
            topic=topic,
            queries=queries or [],
            datasets=datasets or [],
            requested_outputs=requested_outputs or [],
            source_capabilities=declarations,
        )
