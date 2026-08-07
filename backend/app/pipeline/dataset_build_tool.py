"""V2 Dataset Build Agent-facing tool (Phase 2: PipelineRunner -> Legacy facade).

``run_research_pipeline`` remains the V1 deterministic pipeline entry point;
``execute_dataset_build`` is the V2 entry point that drives the same fixed
skeleton through the Phase 2 execution kernel (ExpressionBuildRunner +
DatasetBuildExecutor) with the Phase 6 release invariants gate and the
Publication supersedes chain.

The Agent supplies a self-contained ``DatasetBuildSpec`` (JSON) plus a
mapping of already-acquired source files (workdir-relative paths). The tool
wraps each file into a content-addressed SourceAsset and returns the build
outcome as structured JSON.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.datasets.build.expression_runner import ExpressionBuildRunner
from app.datasets.build.invariants import PUBLISH_DIR
from app.datasets.contracts import DatasetBuildSpec
from app.datasets.runtime import DatasetBuildExecutor, build_operation_plan
from app.datasets.schema_registry import SchemaRegistry, build_gene_expression_schema
from app.domain.contracts import (
    DataLevel,
    SourceAsset,
    asset_id_from_sha256,
    generate_prefixed_uuid,
)
from app.domain.contracts.dataset_state import BuildResult, BuildResultStatus
from app.tools.workdir import resolve_task_local_file

_MEDIA_TYPES = {
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".txt": "text/plain",
    ".json": "application/json",
    ".xml": "application/xml",
}


def _infer_media_type(path: Path) -> str:
    return _MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")


@function_tool(
    name_override="execute_dataset_build",
    description_override=(
        "Execute a V2 dataset build: given a self-contained DatasetBuildSpec "
        "JSON and a JSON mapping of binding_id to already-acquired source file "
        "(workdir-relative path), runs the server-side fixed skeleton "
        "(parse -> canonicalize -> compatibility gate -> integrate -> "
        "validate profile -> publish) through the execution kernel and "
        "publishes an immutable version with a supersedes chain. "
        "Prefer this for expression-data builds when the required source files "
        "have already been downloaded (e.g. GDC/Xena matrices); otherwise use "
        "run_research_pipeline for full discovery-driven runs."
    ),
)
async def execute_dataset_build(
    ctx: RunContextWrapper[RunContext],
    spec: str,
    source_files: str,
) -> str:
    """Run one V2 dataset build over already-acquired source files.

    Args:
        spec: DatasetBuildSpec as JSON (build_id, dataset_family,
            row_granularity, schema_ref, source_bindings with adapter_id,
            merge_strategy, validation_profile_ref, ...).
        source_files: JSON object mapping binding_id to a workdir-relative
            file path for every source binding.

    Returns:
        JSON string with status, build outcome, publication_id, row counts
        and output locations, or a structured error when the input is
        invalid or the build fails.
    """
    run_ctx = ctx.context
    try:
        build_spec = DatasetBuildSpec.model_validate_json(spec)
        files_mapping = json.loads(source_files)
    except (ValueError, json.JSONDecodeError) as exc:
        return json.dumps(
            {
                "status": "invalid_input",
                "message": f"could not parse spec/source_files: {exc}",
                "retryable": False,
            },
            ensure_ascii=False,
        )
    if not isinstance(files_mapping, dict):
        return json.dumps(
            {
                "status": "invalid_input",
                "message": "source_files must be a JSON object {binding_id: path}",
                "retryable": False,
            },
            ensure_ascii=False,
        )

    binding_ids = {binding.binding_id for binding in build_spec.source_bindings}
    missing = sorted(binding_ids - set(files_mapping))
    if missing:
        return json.dumps(
            {
                "status": "invalid_input",
                "message": (
                    "source_files missing bindings: "
                    + ", ".join(missing)
                ),
                "retryable": False,
            },
            ensure_ascii=False,
        )

    # Resolve files and build content-addressed SourceAssets.
    assets: dict[str, SourceAsset] = {}
    paths: dict[str, Path] = {}
    try:
        for binding_id, relative in files_mapping.items():
            path = resolve_task_local_file(run_ctx.work_dir, str(relative))
            checksum = hashlib.sha256(path.read_bytes()).hexdigest()
            assets[binding_id] = SourceAsset(
                asset_id=asset_id_from_sha256(checksum),
                kind="source",
                relative_path=str(relative),
                sha256=checksum,
                size_bytes=path.stat().st_size,
                media_type=_infer_media_type(path),
                source_id=binding_id,
                successful_attempt_id=generate_prefixed_uuid("download_attempt"),
                data_level=DataLevel.REPOSITORY_PROCESSED,
            )
            paths[binding_id] = path
    except (FileNotFoundError, OSError) as exc:
        return json.dumps(
            {
                "status": "error",
                "message": f"could not resolve a source file: {exc}",
                "retryable": True,
            },
            ensure_ascii=False,
        )

    build_root = run_ctx.work_dir.root / "datasets_build"
    build_root.mkdir(parents=True, exist_ok=True)
    output_dir = build_root / build_spec.build_id
    runner = ExpressionBuildRunner(
        spec=build_spec,
        registry=SchemaRegistry([build_gene_expression_schema()]),
        source_assets=assets,
        source_paths=paths,
        output_dir=output_dir,
    )
    plan = build_operation_plan(build_spec)
    executor = DatasetBuildExecutor(
        task_id=run_ctx.task_id,
        build_id=build_spec.build_id,
        run_id=generate_prefixed_uuid("run"),
        state_dir=build_root / "state" / build_spec.build_id,
        lock_path=build_root / "build.lock",
        task_root=build_root,
        plan=plan,
        run_operation=runner,
        implementation_versions={op.operation_id: "1.0.0" for op in plan},
    )
    outcome = await executor.run()
    if outcome.status != "completed":
        return json.dumps(
            {
                "status": "error",
                "message": (
                    f"build {build_spec.build_id} ended with status "
                    f"{outcome.status}: "
                    + (
                        outcome.error.message
                        if outcome.error is not None
                        else "unknown error"
                    )
                ),
                "retryable": True,
            },
            ensure_ascii=False,
        )

    publication_id = _latest_publication_id(output_dir / PUBLISH_DIR)
    manifest_path = output_dir / "dataset_manifest.json"
    valid_row_count = 0
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text("utf-8"))
        valid_row_count = int(manifest.get("row_count", 0))
    result = BuildResult(
        status=BuildResultStatus.SUCCEEDED,
        valid_row_count=valid_row_count,
        successful_sources=sorted(binding_ids),
        rejected_sources=[],
        publication_id=publication_id,
        reason_codes=[],
        user_summary=f"build {build_spec.build_id} published "
        f"{valid_row_count} valid row(s)",
    )
    return json.dumps(
        {
            "status": "ok",
            "build_id": build_spec.build_id,
            "result": result.model_dump(mode="json"),
            "output_dir": output_dir.as_posix(),
            "manifest_file": manifest_path.as_posix(),
        },
        ensure_ascii=False,
    )


def _latest_publication_id(publish_dir: Path) -> str | None:
    """Read the newest version directory's publication_id (if any)."""
    if not publish_dir.is_dir():
        return None
    candidates: list[str] = []
    for child in publish_dir.iterdir():
        if not child.is_dir() or child.name.startswith("."):
            continue
        publication_path = child / "publication.json"
        if not publication_path.is_file():
            continue
        try:
            record = json.loads(publication_path.read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        publication_id = record.get("publication_id")
        if isinstance(publication_id, str) and publication_id:
            candidates.append(publication_id)
    return sorted(candidates)[-1] if candidates else None
