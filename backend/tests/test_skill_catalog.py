"""Focused tests for the hot-reloadable skill catalog."""

from __future__ import annotations

from typing import Any

import pytest
from agents import RunContextWrapper, function_tool
from app.agent_loop.context import RunContext
from app.skills.catalog import (
    DuplicateSkillError,
    SkillCatalog,
    SkillDescriptor,
    SkillManifest,
    SkillOperation,
)
from app.skills.registry import SkillCategory, SkillDef
from pydantic import ValidationError


@function_tool
async def echo_operation(
    ctx: RunContextWrapper[RunContext],
    value: str,
) -> dict[str, str]:
    """Echo a value."""
    return {"task_id": ctx.context.task_id, "value": value}


def _descriptor(
    *,
    name: str = "echo",
    version: str = "1.0.0",
    enabled: bool = True,
) -> SkillDescriptor:
    return SkillDescriptor.from_skill_def(
        SkillDef(
            name=name,
            category=SkillCategory.ACQUISITION,
            description="Echo values from GEO.",
            supported_sources=["geo"],
            version=version,
            enabled=enabled,
            tools=[echo_operation],
        ),
    )


def test_manifest_rejects_invalid_names_and_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        SkillManifest(
            name="Invalid Name",
            display_name="Invalid",
            version="1.0.0",
            category=SkillCategory.DISCOVERY,
            description="invalid",
            origin="builtin",
            operations=("search",),
            unexpected=True,
        )


def test_skilldef_adapter_preserves_builtin_metadata_and_tools() -> None:
    descriptor = _descriptor()

    assert descriptor.name == "echo"
    assert descriptor.display_name == "echo"
    assert descriptor.origin == "builtin"
    assert descriptor.supported_sources == ("geo",)
    assert descriptor.operation_names == ("echo_operation",)
    assert descriptor.resolve_operation("echo_operation") is echo_operation
    assert descriptor.operations[0].access_requirement == "public"


def test_catalog_rejects_duplicate_registration() -> None:
    catalog = SkillCatalog([_descriptor()])

    with pytest.raises(DuplicateSkillError, match="echo"):
        catalog.register(_descriptor(version="2.0.0"))


def test_catalog_generation_is_monotonic_for_atomic_replacements() -> None:
    catalog = SkillCatalog()
    assert catalog.snapshot().generation == 0

    catalog.replace_all([_descriptor(version="1.0.0")])
    first = catalog.snapshot()
    catalog.replace_all([_descriptor(version="2.0.0")])
    second = catalog.snapshot()
    catalog.remove("echo")
    third = catalog.snapshot()

    assert (first.generation, second.generation, third.generation) == (1, 2, 3)
    assert first.skills["echo"].version == "1.0.0"
    assert second.skills["echo"].version == "2.0.0"
    assert "echo" not in third.skills


@pytest.mark.asyncio
async def test_resolved_handle_survives_later_update_and_delete() -> None:
    protected = _descriptor(version="1.0.0").model_copy(
        update={
            "operations": (
                SkillOperation(
                    name="echo_operation",
                    tool=echo_operation,
                    access_requirement="credential_required",
                ),
            )
        }
    )
    catalog = SkillCatalog([protected])
    handle = catalog.resolve("echo", "echo_operation")
    assert handle is not None

    catalog.replace_all([_descriptor(version="2.0.0")])
    latest = catalog.resolve("echo", "echo_operation")
    catalog.remove("echo")

    context = RunContextWrapper(RunContext(task_id="stable_handle"))
    result: Any = await handle.invoke(context, {"value": "kept"})

    assert handle.version == "1.0.0"
    assert handle.access_requirement == "credential_required"
    assert latest is not None and latest.version == "2.0.0"
    assert latest.access_requirement == "public"
    assert result == {"task_id": "stable_handle", "value": "kept"}
    assert catalog.resolve("echo", "echo_operation") is None
