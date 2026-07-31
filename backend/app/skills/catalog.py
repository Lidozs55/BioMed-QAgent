"""Validated skill descriptors and an atomically replaceable catalog."""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from threading import RLock
from types import MappingProxyType
from typing import Any, Literal

from agents import RunContextWrapper
from agents.tool_context import ToolContext
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.skills.registry import SkillCategory, SkillDef


class DuplicateSkillError(ValueError):
    """Raised when a catalog replacement contains duplicate skill names."""


class SkillManifest(BaseModel):
    """Serializable, validated metadata for one skill package."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["1.0"] = "1.0"
    name: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    display_name: str = Field(min_length=1)
    version: str = Field(min_length=1)
    category: SkillCategory
    description: str = Field(min_length=1)
    origin: Literal["builtin", "package"] = "builtin"
    supported_sources: tuple[str, ...] = ()
    operations: tuple[str, ...] = ()
    enabled: bool = True
    user_selectable: bool = True
    pipeline_supported: bool = False
    requirements: tuple[str, ...] = ()
    entrypoint: str | None = None
    package_hash: str | None = None

    @field_validator("supported_sources", "operations", "requirements")
    @classmethod
    def _unique_non_empty_values(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if any(not value.strip() for value in values):
            raise ValueError("values must not be empty")
        if len(values) != len(set(values)):
            raise ValueError("values must be unique")
        return values


class SkillOperation(BaseModel):
    """Runtime binding between an operation name and an SDK FunctionTool."""

    model_config = ConfigDict(arbitrary_types_allowed=True, extra="forbid", frozen=True)

    name: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    tool: Any
    access_requirement: Literal["public", "credential_required"] = "public"

    @model_validator(mode="after")
    def _validate_tool(self) -> SkillOperation:
        if getattr(self.tool, "name", None) != self.name:
            raise ValueError("operation name must match the SDK tool name")
        if not callable(getattr(self.tool, "on_invoke_tool", None)):
            raise ValueError("operation tool must expose on_invoke_tool")
        return self


class SkillDescriptor(BaseModel):
    """Immutable runtime descriptor containing metadata and operation bindings."""

    model_config = ConfigDict(arbitrary_types_allowed=True, extra="forbid", frozen=True)

    schema_version: Literal["1.0"] = "1.0"
    name: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    display_name: str = Field(min_length=1)
    version: str = Field(min_length=1)
    category: SkillCategory
    description: str = Field(min_length=1)
    origin: Literal["builtin", "package"] = "builtin"
    supported_sources: tuple[str, ...] = ()
    operations: tuple[SkillOperation, ...] = ()
    enabled: bool = True
    user_selectable: bool = True
    pipeline_supported: bool = False
    requirements: tuple[str, ...] = ()
    entrypoint: str | None = None
    package_hash: str | None = None

    @model_validator(mode="after")
    def _validate_unique_operations(self) -> SkillDescriptor:
        names = self.operation_names
        if len(names) != len(set(names)):
            raise ValueError("operation names must be unique")
        return self

    @property
    def operation_names(self) -> tuple[str, ...]:
        """Return operation names in manifest order."""
        return tuple(operation.name for operation in self.operations)

    @property
    def manifest(self) -> SkillManifest:
        """Return the serializable manifest view of this descriptor."""
        return SkillManifest(
            schema_version=self.schema_version,
            name=self.name,
            display_name=self.display_name,
            version=self.version,
            category=self.category,
            description=self.description,
            origin=self.origin,
            supported_sources=self.supported_sources,
            operations=self.operation_names,
            enabled=self.enabled,
            user_selectable=self.user_selectable,
            pipeline_supported=self.pipeline_supported,
            requirements=self.requirements,
            entrypoint=self.entrypoint,
            package_hash=self.package_hash,
        )

    def resolve_operation(self, name: str) -> Any | None:
        """Resolve an SDK FunctionTool by operation name."""
        for operation in self.operations:
            if operation.name == name:
                return operation.tool
        return None

    @classmethod
    def from_skill_def(
        cls,
        skill: SkillDef,
        *,
        display_name: str | None = None,
        origin: Literal["builtin", "package"] = "builtin",
        user_selectable: bool = True,
        pipeline_supported: bool = False,
        requirements: tuple[str, ...] = (),
        entrypoint: str | None = None,
        package_hash: str | None = None,
    ) -> SkillDescriptor:
        """Adapt an existing builtin ``SkillDef`` without changing its module."""
        operations = tuple(SkillOperation(name=tool.name, tool=tool) for tool in skill.tools)
        return cls(
            name=skill.name,
            display_name=display_name or skill.name,
            version=skill.version,
            category=skill.category,
            description=skill.description,
            origin=origin,
            supported_sources=tuple(skill.supported_sources),
            operations=operations,
            enabled=skill.enabled,
            user_selectable=user_selectable,
            pipeline_supported=pipeline_supported,
            requirements=requirements,
            entrypoint=entrypoint,
            package_hash=package_hash,
        )


@dataclass(frozen=True, slots=True)
class CatalogSnapshot:
    """Immutable point-in-time view published by ``SkillCatalog``."""

    generation: int
    skills: Mapping[str, SkillDescriptor]

    def resolve(self, skill: str, operation: str) -> ResolvedOperation | None:
        """Resolve an operation pinned to this snapshot."""
        descriptor = self.skills.get(skill)
        if descriptor is None:
            return None
        operation_binding = next(
            (item for item in descriptor.operations if item.name == operation),
            None,
        )
        if operation_binding is None:
            return None
        return ResolvedOperation(
            skill=descriptor.name,
            version=descriptor.version,
            operation=operation,
            tool=operation_binding.tool,
            access_requirement=operation_binding.access_requirement,
        )


@dataclass(frozen=True, slots=True)
class ResolvedOperation:
    """Operation handle pinned to the descriptor version that was resolved."""

    skill: str
    version: str
    operation: str
    tool: Any
    access_requirement: Literal["public", "credential_required"] = "public"

    async def invoke(
        self,
        context: RunContextWrapper[Any],
        arguments: Mapping[str, Any],
    ) -> Any:
        """Invoke the captured SDK tool using the current run context."""
        tool_context = context
        if not isinstance(context, ToolContext):
            tool_context = ToolContext(
                context=context.context,
                tool_name=self.operation,
                tool_call_id="skill-catalog",
                tool_arguments=json.dumps(dict(arguments)),
            )
        return await self.tool.on_invoke_tool(
            tool_context,
            json.dumps(dict(arguments)),
        )


class SkillCatalog:
    """Thread-safe catalog that publishes immutable snapshots atomically."""

    def __init__(self, descriptors: Iterable[SkillDescriptor] = ()) -> None:
        self._lock = RLock()
        self._snapshot = CatalogSnapshot(0, MappingProxyType({}))
        initial = tuple(descriptors)
        if initial:
            self.replace_all(initial)

    def snapshot(self) -> CatalogSnapshot:
        """Return the currently published immutable snapshot."""
        return self._snapshot

    def register(self, descriptor: SkillDescriptor) -> CatalogSnapshot:
        """Add one new skill without silently overwriting a duplicate."""
        with self._lock:
            current = self._snapshot
            if descriptor.name in current.skills:
                raise DuplicateSkillError(
                    f"skill '{descriptor.name}' is already registered",
                )
            skills = dict(current.skills)
            skills[descriptor.name] = descriptor
            return self._publish(skills)

    def replace_all(
        self,
        descriptors: Iterable[SkillDescriptor],
    ) -> CatalogSnapshot:
        """Atomically replace the complete catalog contents."""
        skills: dict[str, SkillDescriptor] = {}
        for descriptor in descriptors:
            if descriptor.name in skills:
                raise DuplicateSkillError(
                    f"skill '{descriptor.name}' appears more than once",
                )
            skills[descriptor.name] = descriptor
        with self._lock:
            return self._publish(skills)

    def remove(self, name: str) -> CatalogSnapshot:
        """Remove a skill and publish a new generation when it exists."""
        with self._lock:
            current = self._snapshot
            if name not in current.skills:
                return current
            skills = dict(current.skills)
            del skills[name]
            return self._publish(skills)

    def resolve(self, skill: str, operation: str) -> ResolvedOperation | None:
        """Resolve an operation against one consistent snapshot."""
        return self._snapshot.resolve(skill, operation)

    def _publish(self, skills: dict[str, SkillDescriptor]) -> CatalogSnapshot:
        snapshot = CatalogSnapshot(
            generation=self._snapshot.generation + 1,
            skills=MappingProxyType(dict(skills)),
        )
        self._snapshot = snapshot
        return snapshot
