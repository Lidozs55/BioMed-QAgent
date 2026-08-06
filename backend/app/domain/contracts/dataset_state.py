"""Dataset build outcome contracts shared by the runtime and datasets packages.

``BuildResult`` and its enums live here (not in ``app.datasets.contracts``)
so that ``app.domain.contracts.runtime`` can reference them without importing
the ``app.datasets`` package: ``app/datasets/__init__.py`` eagerly imports
``schema_registry`` -> the pipeline -> ``app.domain.contracts``, so a
module-level import in either direction between ``runtime`` and ``datasets``
would deadlock a partially-initialized package. ``app.datasets.contracts``
re-exports these names, keeping existing import sites unchanged.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import Field, model_validator

from app.domain.contracts.base import ContractModel


class BuildResultStatus(StrEnum):
    SUCCEEDED = "succeeded"
    PARTIAL_SUCCESS = "partial_success"
    NO_DATA = "no_data"
    SPEC_REJECTED = "spec_rejected"


class ArtifactRole(StrEnum):
    PRIMARY_DATASET = "primary_dataset"
    SUPPORTING_DATASET = "supporting_dataset"
    SCHEMA = "schema"
    PROVENANCE = "provenance"
    AUDIT_REPORT = "audit_report"


class BuildResult(ContractModel):
    """Business outcome of a normally completed build (ARCHITECTURE §9.1).

    Only produced when ``RunStatus == COMPLETED``; execution failures and
    user cancellation are expressed by RunStatus, not by this enum.
    """

    status: BuildResultStatus
    valid_row_count: int = Field(ge=0)
    successful_sources: list[str] = Field(default_factory=list)
    rejected_sources: list[str] = Field(default_factory=list)
    available_artifact_roles: list[ArtifactRole] = Field(default_factory=list)
    publication_id: str | None = None
    reason_codes: list[str] = Field(default_factory=list)
    user_summary: str = ""
    recommended_next_action: str = ""

    @model_validator(mode="after")
    def validate_state(self) -> BuildResult:
        if self.status is BuildResultStatus.SUCCEEDED:
            if not self.successful_sources:
                raise ValueError("succeeded build requires successful_sources")
            if self.publication_id is None:
                raise ValueError("succeeded build requires publication_id")
        if self.status is BuildResultStatus.NO_DATA and self.valid_row_count != 0:
            raise ValueError("no_data build must have zero valid rows")
        if (
            self.status is BuildResultStatus.SPEC_REJECTED
            and not self.reason_codes
        ):
            raise ValueError("spec_rejected build requires reason_codes")
        if (
            self.publication_id is not None
            and self.status
            not in (BuildResultStatus.SUCCEEDED, BuildResultStatus.PARTIAL_SUCCESS)
        ):
            raise ValueError(
                "publication_id is only valid for succeeded or partial_success"
            )
        return self
