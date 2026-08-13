"""Legacy OpenAI FunctionTool adapters for the V2 DatasetBuild service."""

from __future__ import annotations

import json
import logging
from pathlib import Path

from agents import RunContextWrapper, function_tool
from pydantic import ValidationError

from app.agent_loop.context import PendingDatasetBuild, RunContext
from app.datasets import service as dataset_build_service
from app.datasets.build.v1_bridge import mirror_build_to_legacy_artifacts
from app.datasets.contracts import DatasetManifest, DatasetPublication
from app.domain.contracts.dataset_state import BuildResult

logger = logging.getLogger(__name__)

# Preserve the legacy module's private test/debug seams during the adapter
# extraction. Production orchestration lives in ``app.datasets.service``.
_ensure_build_output_inside = dataset_build_service._ensure_build_output_inside
_latest_publication_id = dataset_build_service._latest_publication_id
_no_data_envelope = dataset_build_service._no_data_envelope
_workflow_recipe_fetcher = dataset_build_service._workflow_recipe_fetcher


@function_tool(
    name_override="validate_dataset_build_spec",
    description_override=(
        "Validate a V2 DatasetBuildSpec JSON without starting a build. "
        "Runs the same server-side SpecValidator (schema registry, entity-level "
        "compatibility, per-binding adapter params, validation-profile "
        "allowlist) that execute_dataset_build applies before any source file "
        "is touched. Returns structured reason codes so the spec can be fixed "
        "and retried instead of burning a build attempt on an invalid spec."
    ),
)
async def validate_dataset_build_spec(
    ctx: RunContextWrapper[RunContext],
    spec: str,
) -> str:
    """Validate a V2 DatasetBuildSpec JSON without starting a build."""

    del ctx
    response = dataset_build_service.validate_dataset_build_spec(spec)
    return json.dumps(
        response.model_dump(mode="json", exclude={"schema_version"}),
        ensure_ascii=False,
    )


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
        "have already been downloaded (e.g. GDC/Xena matrices). "
        "For probe-platform (microarray) GEO bindings, pass the GPL platform "
        "annotation file downloaded by download_geo_platform_annotation via "
        "the optional mapping_files parameter (JSON {binding_id: annotation "
        "path}) so probe rows map to genes. For GEO tximport/supplementary "
        "expression, optional metadata_files (JSON {binding_id: family SOFT "
        "path}) publishes structured sample_metadata alongside the primary."
    ),
)
async def execute_dataset_build(
    ctx: RunContextWrapper[RunContext],
    spec: str,
    source_files: str,
    mapping_files: str = "{}",
    metadata_files: str = "{}",
) -> str:
    """Delegate one legacy FunctionTool call to the typed DatasetBuild service."""

    response = await dataset_build_service.execute_dataset_build(
        ctx.context,
        spec,
        source_files,
        mapping_files,
        metadata_files,
        workflow_recipe_fetcher=_workflow_recipe_fetcher,
    )
    if not isinstance(response, dataset_build_service.DatasetBuildCompleted):
        return json.dumps(
            response.model_dump(mode="json", exclude={"schema_version"}),
            ensure_ascii=False,
        )

    _install_dataset_build_outcome(
        ctx,
        build_id=response.build_id,
        result=response.result,
        output_dir=response.output_dir,
        manifest_path=response.manifest_path,
    )
    if (
        isinstance(response, dataset_build_service.DatasetBuildPublished)
        and ctx.context.managed_run_id is not None
    ):
        try:
            mirror_build_to_legacy_artifacts(
                task_id=ctx.context.task_id,
                task_root=ctx.context.work_dir.root,
                build_dir=response.output_dir,
                objective=json.loads(spec)["objective"],
            )
        except (OSError, ValueError, ValidationError) as exc:
            logger.warning(
                "V1 artifact bridge failed for build %s: %s",
                response.build_id,
                exc,
            )

    payload: dict[str, object] = {
        "status": "ok",
        "build_id": response.build_id,
        "result": response.result.model_dump(mode="json"),
        "output_dir": response.output_dir.as_posix(),
        "manifest_file": (
            response.manifest_path.as_posix()
            if response.manifest_path.is_file()
            else None
        ),
    }
    if isinstance(response, dataset_build_service.DatasetBuildPublished):
        payload["cache_entry"] = (
            response.cache_entry.model_dump(
                mode="json", exclude={"schema_version"}
            )
            if response.cache_entry is not None
            else None
        )
    return json.dumps(payload, ensure_ascii=False)


def _install_dataset_build_outcome(
    ctx: RunContextWrapper[RunContext],
    *,
    build_id: str,
    result: BuildResult,
    output_dir: Path,
    manifest_path: Path,
) -> None:
    """Install the managed-run handoff owned by the legacy Agent runtime."""

    managed_run_id = ctx.context.managed_run_id
    if managed_run_id is None:
        return
    manifest: DatasetManifest | None = None
    manifest_sha256: str | None = None
    if manifest_path.is_file():
        try:
            manifest = DatasetManifest.model_validate_json(
                manifest_path.read_text("utf-8")
            )
        except (ValidationError, OSError, json.JSONDecodeError):
            manifest = None
        else:
            manifest_sha256 = manifest.sha256
    publication = (
        _load_publication(output_dir, result.publication_id)
        if result.publication_id is not None
        else None
    )
    ctx.context.install_dataset_build_outcome(
        PendingDatasetBuild(
            run_id=managed_run_id,
            build_id=build_id,
            build_result=result.model_copy(update={"build_id": build_id}),
            publication=publication,
            manifest_sha256=manifest_sha256,
            manifest_artifacts=(
                tuple(manifest.artifacts) if manifest is not None else ()
            ),
        )
    )


def _load_publication(
    output_dir: Path,
    publication_id: str,
) -> DatasetPublication | None:
    """Read one immutable DatasetPublication for the managed-run handoff."""

    publish_dir = output_dir / "publish"
    if not publish_dir.is_dir():
        return None
    for child in publish_dir.iterdir():
        if not child.is_dir() or child.name.startswith("."):
            continue
        publication_path = child / "publication.json"
        if not publication_path.is_file():
            continue
        try:
            publication = DatasetPublication.model_validate_json(
                publication_path.read_text("utf-8")
            )
        except (ValidationError, OSError, json.JSONDecodeError):
            continue
        if publication.publication_id == publication_id:
            return publication
    return None
