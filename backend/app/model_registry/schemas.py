"""Provider and managed-model schemas for the model registry."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

ParameterType = Literal["integer", "number", "boolean", "string", "select"]
ModelSource = Literal["api", "manual", "catalog"]


def utc_now_iso() -> str:
    """Return the current UTC timestamp in ISO-8601 format."""

    return datetime.now(UTC).isoformat()


class ParameterSpec(BaseModel):
    """Definition of one selectable model parameter."""

    model_config = ConfigDict(extra="forbid")

    key: str
    label: str
    type: ParameterType
    default: Any = None
    description: str = ""
    min: float | None = None
    max: float | None = None
    options: list[dict[str, str]] = Field(default_factory=list)
    required: bool = False
    advanced: bool = False


class ProviderRecord(BaseModel):
    """Persisted provider row (API key stored raw, masked on the wire)."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    name: str
    base_url: str
    api_key: str = ""
    preset_id: str | None = None
    description: str = ""
    enabled: bool = True
    created_at: str
    updated_at: str


class ProviderCreate(BaseModel):
    """Payload for creating a provider alias."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=64)
    base_url: str = Field(min_length=1)
    api_key: str = ""
    preset_id: str | None = None
    description: str = ""


class ProviderUpdate(BaseModel):
    """Payload for updating a provider (``None`` means "leave unchanged")."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=64)
    base_url: str | None = Field(default=None, min_length=1)
    api_key: str | None = None
    preset_id: str | None = None
    description: str | None = None
    enabled: bool | None = None


class ProviderPublic(BaseModel):
    """Provider view served to the client with a masked API key."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    name: str
    base_url: str
    api_key: str
    api_key_configured: bool
    preset_id: str | None
    description: str
    enabled: bool
    created_at: str
    updated_at: str


class Capabilities(BaseModel):
    """Modality flags for a managed model."""

    model_config = ConfigDict(extra="forbid")

    text: bool = True
    image: bool = False
    video: bool = False
    audio: bool = False


class ManagedModelRecord(BaseModel):
    """Persisted managed-model row."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    provider_id: str
    model_id: str
    name: str = ""
    description: str = ""
    context_window: int | None = None
    max_output_tokens: int | None = None
    suggested_max_tokens: int | None = None
    capabilities: Capabilities = Field(default_factory=Capabilities)
    params: dict[str, Any] = Field(default_factory=dict)
    param_specs: list[ParameterSpec] = Field(default_factory=list)
    source: ModelSource = "manual"
    active: bool = False
    created_at: str
    updated_at: str


class ManagedModelCreate(BaseModel):
    """Payload for adding a managed model.

    ``extra="allow"`` is intentional: unknown top-level keys are folded into
    ``params`` so provider-specific extras never fail validation.
    """

    model_config = ConfigDict(extra="allow")

    provider_id: str
    model_id: str = Field(min_length=1)
    name: str | None = None
    description: str | None = None
    context_window: int | None = Field(default=None, ge=1)
    max_output_tokens: int | None = Field(default=None, ge=1)
    suggested_max_tokens: int | None = Field(default=None, ge=1)
    capabilities: Capabilities | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    source: ModelSource = "manual"


class ManagedModelUpdate(BaseModel):
    """Payload for updating a managed model (tolerant of extra keys)."""

    model_config = ConfigDict(extra="allow")

    name: str | None = None
    description: str | None = None
    context_window: int | None = Field(default=None, ge=1)
    max_output_tokens: int | None = Field(default=None, ge=1)
    suggested_max_tokens: int | None = Field(default=None, ge=1)
    capabilities: Capabilities | None = None
    params: dict[str, Any] | None = None


class ManagedModelPublic(BaseModel):
    """Managed-model view served to the client."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    provider_id: str
    provider_name: str
    provider_base_url: str
    provider_api_key_configured: bool
    model_id: str
    name: str
    description: str
    context_window: int | None
    max_output_tokens: int | None
    suggested_max_tokens: int | None
    capabilities: Capabilities
    params: dict[str, Any]
    param_specs: list[ParameterSpec]
    source: ModelSource
    active: bool
    created_at: str
    updated_at: str


class DiscoveredModel(BaseModel):
    """One model returned by provider discovery, enriched with catalog data."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    description: str = ""
    context_window: int | None = None
    max_output_tokens: int | None = None
    suggested_max_tokens: int | None = None
    capabilities: Capabilities = Field(default_factory=Capabilities)
    recommended: bool = False
    param_specs: list[ParameterSpec] = Field(default_factory=list)
    capability_source: Literal["catalog", "api"] = "api"


__all__ = [
    "Capabilities",
    "DiscoveredModel",
    "ManagedModelCreate",
    "ManagedModelPublic",
    "ManagedModelRecord",
    "ManagedModelUpdate",
    "ModelSource",
    "ParameterSpec",
    "ProviderCreate",
    "ProviderPublic",
    "ProviderRecord",
    "ProviderUpdate",
    "utc_now_iso",
]
