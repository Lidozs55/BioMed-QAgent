"""Declarative, non-executable workflow recipe contracts."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from datetime import datetime
from enum import StrEnum
from typing import Annotated, Any, Literal, Self

from pydantic import Field, JsonValue, field_validator, model_validator

from app.domain.contracts.base import ContractModel

_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_EXECUTABLE_FIELD_NAMES = {"code", "javascript", "python", "script", "shell"}


class RecipeStatus(StrEnum):
    DRAFT = "draft"
    VERIFIED = "verified"
    PROMOTED = "promoted"
    REJECTED = "rejected"


class ApiRequestStep(ContractModel):
    type: Literal["api_request"] = "api_request"
    method: Literal["GET", "POST"] = "GET"
    url_template: str = Field(min_length=1)
    request_headers: dict[str, str] = Field(default_factory=dict)
    query_params: dict[str, str] = Field(default_factory=dict)
    timeout_seconds: float = Field(default=30.0, gt=0, le=300)
    output_name: str | None = Field(default=None, min_length=1)


class HtmlExtractStep(ContractModel):
    type: Literal["html_extract"] = "html_extract"
    url_template: str = Field(min_length=1)
    selectors: dict[str, str] = Field(min_length=1)
    timeout_seconds: float = Field(default=30.0, gt=0, le=300)
    output_name: str | None = Field(default=None, min_length=1)


class BrowserActionStep(ContractModel):
    type: Literal["browser_action"] = "browser_action"
    action: Literal["navigate", "click", "fill", "select", "wait_for", "extract"]
    target: str | None = Field(default=None, min_length=1)
    value: str | None = Field(default=None, min_length=1)
    timeout_seconds: float = Field(default=30.0, gt=0, le=300)
    output_name: str | None = Field(default=None, min_length=1)


RecipeStep = Annotated[
    ApiRequestStep | HtmlExtractStep | BrowserActionStep,
    Field(discriminator="type"),
]


class RecipeAttempt(ContractModel):
    method: Literal["api", "html", "browser"]
    url: str = Field(min_length=1)
    status: Literal["succeeded", "failed", "skipped"]
    started_at: datetime
    finished_at: datetime
    status_code: int | None = Field(default=None, ge=100, le=599)
    reason: str | None = Field(default=None, min_length=1)
    fallback_reason: str | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def validate_timestamps(self) -> Self:
        if self.finished_at < self.started_at:
            raise ValueError("finished_at must not precede started_at")
        return self


class WorkflowRecipe(ContractModel):
    recipe_id: str = Field(min_length=1)
    version: int = Field(default=0, ge=0)
    digest: str = ""
    status: RecipeStatus = RecipeStatus.DRAFT
    created_at: datetime
    verified_at: datetime | None = None
    promoted_at: datetime | None = None
    rejected_at: datetime | None = None
    generated_by_model: str = Field(min_length=1)
    domain: str = Field(min_length=1)
    capability: str = Field(min_length=1)
    allowed_hosts: list[str] = Field(default_factory=list)
    url_patterns: list[str] = Field(default_factory=list)
    input_schema: dict[str, JsonValue] = Field(default_factory=dict)
    steps: list[RecipeStep] = Field(min_length=1)
    attempts: list[RecipeAttempt] = Field(default_factory=list)
    output_extraction: dict[str, JsonValue] = Field(default_factory=dict)
    source_asset_mapping: dict[str, JsonValue] = Field(default_factory=dict)
    security_requirements: list[str] = Field(default_factory=list)
    hil_requirements: list[str] = Field(default_factory=list)
    rate_limit_seconds: float = Field(default=0.0, ge=0)
    timeout_seconds: float = Field(default=900.0, gt=0, le=900)
    verification_evidence: list[str] = Field(default_factory=list)
    last_succeeded_at: datetime | None = None
    rejection_reason: str | None = Field(default=None, min_length=1)

    @model_validator(mode="before")
    @classmethod
    def reject_executable_fields(cls, value: Any) -> Any:
        if _contains_executable_field(value):
            raise ValueError("WorkflowRecipe cannot contain executable fields")
        return value

    @field_validator("digest")
    @classmethod
    def validate_digest(cls, value: str) -> str:
        normalized = value.lower()
        if normalized and not _SHA256_PATTERN.fullmatch(normalized):
            raise ValueError("digest must contain 64 hexadecimal characters")
        return normalized

    @field_validator("allowed_hosts")
    @classmethod
    def normalize_hosts(cls, value: list[str]) -> list[str]:
        normalized = [host.strip().lower().rstrip(".") for host in value]
        if any(not host or "/" in host or "\\" in host for host in normalized):
            raise ValueError("allowed_hosts must contain host names only")
        if len(set(normalized)) != len(normalized):
            raise ValueError("allowed_hosts must be unique")
        return normalized

    @model_validator(mode="after")
    def validate_lifecycle_fields(self) -> Self:
        if self.status is RecipeStatus.DRAFT and any(
            value is not None for value in (self.verified_at, self.promoted_at, self.rejected_at)
        ):
            raise ValueError("draft recipe cannot contain terminal lifecycle timestamps")
        if self.status is RecipeStatus.VERIFIED and self.verified_at is None:
            raise ValueError("verified recipe requires verified_at")
        if self.status is RecipeStatus.PROMOTED and (
            self.verified_at is None or self.promoted_at is None
        ):
            raise ValueError("promoted recipe requires verified_at and promoted_at")
        if self.status is RecipeStatus.REJECTED and (
            self.rejected_at is None or self.rejection_reason is None
        ):
            raise ValueError("rejected recipe requires rejected_at and rejection_reason")
        return self


def _contains_executable_field(value: object) -> bool:
    if isinstance(value, Mapping):
        return any(
            str(key).lower() in _EXECUTABLE_FIELD_NAMES or _contains_executable_field(item)
            for key, item in value.items()
        )
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return any(_contains_executable_field(item) for item in value)
    return False
