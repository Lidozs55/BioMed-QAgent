"""Agent-SDK-independent DatasetBuild service boundary tests."""

from __future__ import annotations

import ast
import json
import shutil
from pathlib import Path

import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.datasets.service import (
    execute_dataset_build as execute_dataset_build_service,
)
from app.datasets.service import (
    get_build_result,
)
from app.datasets.service import (
    validate_dataset_build_spec as validate_dataset_build_spec_service,
)
from app.pipeline.dataset_build_tool import (
    execute_dataset_build as execute_dataset_build_tool,
)
from app.pipeline.dataset_build_tool import (
    validate_dataset_build_spec as validate_dataset_build_spec_tool,
)
from app.tools.workdir import create_task_workdir

FIXTURES = Path(__file__).parent / "fixtures"
SERVICE_MODULE = Path(__file__).parents[1] / "app" / "datasets" / "service.py"


def _spec_json(
    *,
    build_id: str = "build_service_test",
    schema_ref: str = "gene_expression.long.v1",
) -> str:
    return json.dumps(
        {
            "build_id": build_id,
            "objective": "compare TP53 expression",
            "dataset_family": "gene_expression",
            "row_granularity": "gene_sample_measurement",
            "schema_ref": schema_ref,
            "source_bindings": [
                {
                    "binding_id": "binding_gdc",
                    "source": "gdc",
                    "acquisition": {
                        "mode": "builtin",
                        "provider_id": "gdc.v1",
                    },
                    "adapter_id": "gdc.expression.v1",
                }
            ],
            "merge_strategy": "append_by_canonical_row",
            "validation_profile_ref": "gene_expression.release.v1",
            "normalization_profile_ref": "gene_expression.normalization.v1",
        }
    )


def _make_run_context(tmp_path: Path, task_id: str) -> RunContext:
    run_context = RunContext(task_id=task_id)
    run_context._work_dir = create_task_workdir(task_id, base_dir=str(tmp_path))
    return run_context


def _make_tool_context(run_context: RunContext, tool_name: str) -> ToolContext:
    return ToolContext(
        context=run_context,
        tool_name=tool_name,
        tool_call_id="test_call",
        tool_arguments="{}",
    )


def _stage_fixture(run_context: RunContext, fixture_rel: str, dest_name: str) -> str:
    destination = run_context.work_dir.source_asset_file(dest_name)
    shutil.copy(FIXTURES / fixture_rel, destination)
    return f"source_assets/{dest_name}"


async def _invoke_execute_tool(
    run_context: RunContext,
    *,
    spec: str,
    source_files: dict[str, str],
) -> dict[str, object]:
    context = _make_tool_context(run_context, "execute_dataset_build")
    raw = await execute_dataset_build_tool.on_invoke_tool(
        context,
        json.dumps(
            {
                "spec": spec,
                "source_files": json.dumps(source_files),
                "mapping_files": "{}",
            }
        ),
    )
    return json.loads(raw)


async def _invoke_validate_tool(
    run_context: RunContext,
    spec: str,
) -> dict[str, object]:
    context = _make_tool_context(run_context, "validate_dataset_build_spec")
    raw = await validate_dataset_build_spec_tool.on_invoke_tool(
        context,
        json.dumps({"spec": spec}),
    )
    return json.loads(raw)


def _stable_build_fields(payload: dict[str, object]) -> dict[str, object]:
    result = payload["result"]
    assert isinstance(result, dict)
    return {
        key: result[key]
        for key in (
            "status",
            "valid_row_count",
            "successful_sources",
            "rejected_sources",
            "reason_codes",
        )
    }


def test_service_module_has_no_openai_agents_sdk_import() -> None:
    tree = ast.parse(SERVICE_MODULE.read_text("utf-8"))
    imported_roots = {
        alias.name.split(".", 1)[0]
        for node in ast.walk(tree)
        if isinstance(node, ast.Import)
        for alias in node.names
    }
    imported_roots.update(
        node.module.split(".", 1)[0]
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module is not None
    )
    assert "agents" not in imported_roots


def test_validate_service_accepts_valid_spec() -> None:
    result = validate_dataset_build_spec_service(_spec_json())

    assert result.status == "valid"
    assert result.valid is True
    assert result.reason_codes == []
    assert result.reasons == []


def test_validate_service_rejects_semantically_invalid_spec() -> None:
    result = validate_dataset_build_spec_service(
        _spec_json(schema_ref="unknown.schema.v1")
    )

    assert result.status == "invalid"
    assert result.valid is False
    assert "unknown_schema" in result.reason_codes


def test_validate_service_handles_malformed_spec() -> None:
    result = validate_dataset_build_spec_service("not json")

    assert result.status == "invalid_input"
    assert result.retryable is False
    assert "could not parse spec" in result.message


@pytest.mark.asyncio
async def test_service_and_legacy_tool_match_succeeded_stable_fields(
    tmp_path: Path,
) -> None:
    service_context = _make_run_context(tmp_path, "service_succeeded")
    service_source = _stage_fixture(
        service_context,
        "gdc/gdc_expression.tsv",
        "gdc_expression.tsv",
    )
    service_response = await execute_dataset_build_service(
        service_context,
        _spec_json(),
        {"binding_gdc": service_source},
    )

    tool_context = _make_run_context(tmp_path, "tool_succeeded")
    tool_source = _stage_fixture(
        tool_context,
        "gdc/gdc_expression.tsv",
        "gdc_expression.tsv",
    )
    tool_payload = await _invoke_execute_tool(
        tool_context,
        spec=_spec_json(),
        source_files={"binding_gdc": tool_source},
    )

    assert service_response.status == "ok"
    service_payload = {
        "result": service_response.result.model_dump(mode="json")
    }
    assert _stable_build_fields(service_payload) == _stable_build_fields(tool_payload)


@pytest.mark.asyncio
async def test_service_and_legacy_tool_match_no_data_stable_fields(
    tmp_path: Path,
) -> None:
    service_context = _make_run_context(tmp_path, "service_no_data")
    service_file = service_context.work_dir.source_asset_file("header_only.tsv")
    service_file.write_text("gene_id\tS1\tS2\n", encoding="utf-8")
    service_response = await execute_dataset_build_service(
        service_context,
        _spec_json(),
        {"binding_gdc": "source_assets/header_only.tsv"},
    )

    tool_context = _make_run_context(tmp_path, "tool_no_data")
    tool_file = tool_context.work_dir.source_asset_file("header_only.tsv")
    tool_file.write_text("gene_id\tS1\tS2\n", encoding="utf-8")
    tool_payload = await _invoke_execute_tool(
        tool_context,
        spec=_spec_json(),
        source_files={"binding_gdc": "source_assets/header_only.tsv"},
    )

    assert service_response.status == "ok"
    service_payload = {
        "result": service_response.result.model_dump(mode="json")
    }
    assert _stable_build_fields(service_payload) == _stable_build_fields(tool_payload)


@pytest.mark.asyncio
async def test_service_and_legacy_tool_match_invalid_spec_stable_fields(
    tmp_path: Path,
) -> None:
    invalid_spec = _spec_json(schema_ref="unknown.schema.v1")
    service_result = validate_dataset_build_spec_service(invalid_spec)
    tool_result = await _invoke_validate_tool(
        _make_run_context(tmp_path, "tool_invalid_spec"),
        invalid_spec,
    )

    assert {
        "status": service_result.status,
        "valid": service_result.valid,
        "reason_codes": service_result.reason_codes,
        "reasons": service_result.reasons,
    } == tool_result


@pytest.mark.asyncio
async def test_get_build_result_is_task_scoped_and_returns_read_only_references(
    tmp_path: Path,
) -> None:
    context = _make_run_context(tmp_path, "lookup_task")
    source = _stage_fixture(
        context,
        "gdc/gdc_expression.tsv",
        "gdc_expression.tsv",
    )
    response = await execute_dataset_build_service(
        context,
        _spec_json(build_id="lookup_build"),
        {"binding_gdc": source},
    )
    assert response.status == "ok"

    lookup = get_build_result(context, "lookup_build")

    assert lookup is not None
    assert lookup.task_id == "lookup_task"
    assert lookup.build_id == "lookup_build"
    assert lookup.build_result.status == "succeeded"
    assert lookup.manifest_ref == "datasets_build/lookup_build/dataset_manifest.json"
    assert lookup.publication_ref is not None
    assert not Path(lookup.manifest_ref).is_absolute()
    assert not Path(lookup.publication_ref).is_absolute()
    assert all(not Path(item.relative_path).is_absolute() for item in lookup.artifacts)
    other_task = _make_run_context(tmp_path, "other_lookup_task")
    assert get_build_result(other_task, "lookup_build") is None


def test_get_build_result_returns_none_when_build_is_not_found(tmp_path: Path) -> None:
    context = _make_run_context(tmp_path, "missing_lookup_task")

    assert get_build_result(context, "missing_build") is None


@pytest.mark.parametrize("build_id", ["../escape", "nested/build", r"nested\\build"])
def test_get_build_result_rejects_path_like_build_id(
    tmp_path: Path,
    build_id: str,
) -> None:
    context = _make_run_context(tmp_path, "unsafe_lookup_task")

    with pytest.raises(ValueError, match="build_id"):
        get_build_result(context, build_id)
