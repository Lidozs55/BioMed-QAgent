"""Shared primitives for serialized pipeline boundary contracts."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict


class ContractModel(BaseModel):
    """Strict base for versioned data exchanged across pipeline stages."""

    model_config = ConfigDict(extra="forbid", validate_default=True)

    schema_version: Literal["1.0"] = "1.0"
