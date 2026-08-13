"""Agent-SDK-independent application service for V2 DatasetBuild operations."""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import ValidationError

from app.agent_loop.context import RunContext
from app.datasets.build.cache import DatasetCacheV2
from app.datasets.build.expression_runner import (
    _PUBLICATION_REFUSED_PREFIX,
    ExpressionBuildRunner,
)
from app.datasets.build.geo_relations import build_geo_source_relations
from app.datasets.build.invariants import PUBLISH_DIR, find_latest_publication
from app.datasets.build.profiles import VALIDATION_PROFILES, get_validation_profile
from app.datasets.contracts import (
    CHECK_ID_PROBE_COVERAGE_REQUIRED_GENE_LEVEL,
    REASON_PROBE_MAPPING_UNAVAILABLE_REQUIRED_GENE_LEVEL,
    AcquisitionMode,
    AdapterParams,
    BindingRejection,
    BindingRejectionKind,
    DatasetBuildSpec,
    DatasetManifest,
    DatasetPublication,
    ManifestArtifactEntry,
    SourceBinding,
)
from app.datasets.runtime import DatasetBuildExecutor, build_operation_plan
from app.datasets.schema_registry import (
    SchemaRegistry,
    build_gene_expression_schema,
    build_probe_expression_schema,
)
from app.datasets.spec_validator import SpecValidator
from app.domain.contracts import (
    DataLevel,
    DownloadAttempt,
    DownloadStatus,
    ErrorDetail,
    SourceAsset,
    SourceRecord,
    SourceRelation,
    asset_id_from_sha256,
    generate_prefixed_uuid,
)
from app.domain.contracts.base import ContractModel
from app.domain.contracts.dataset_state import (
    BindingFailureDetail,
    BuildResult,
    BuildResultStatus,
)
from app.tools.workdir import resolve_task_local_file

logger = logging.getLogger(__name__)

_NO_DATA_SUMMARY = "任务完成，但未产出可发布的主数据。"
_NO_DATA_NEXT_ACTION = "检查数据源可用性或调整查询后重试。"
_NO_DATA_NEXT_ACTION_EMPTY_SERIES_MATRIX = (
    "series matrix 为元数据-only（无表达表）：改用 "
    "download_geo(file_type='soft'/'suppl') 获取该系列的表达数据，"
    "或换用 series matrix 含表达表的可用数据集后重试。"
)
_REASON_NO_PRIMARY_DATA = "no_primary_data"
_MANIFEST_WRITING_OPERATIONS = frozenset({"validate_profile", "publish"})
_REASON_PROBE_MAPPING_UNAVAILABLE = (
    REASON_PROBE_MAPPING_UNAVAILABLE_REQUIRED_GENE_LEVEL
)
_PROBE_MAPPING_NO_DATA_SUMMARY = (
    "任务完成，但未产出满足 gene 级要求的主数据（probe→gene 映射不可用）。"
)
_PROBE_MAPPING_NO_DATA_NEXT_ACTION = "检查 GPL 注释资产可用性或改用 probe 级构建。"
_PENDING_MAIN_INPUT_MESSAGE = (
    "execute_dataset_build 被拒绝：当前 Run 正在等待人工修正"
    "（request_human_correction 尚未答复）。请等待修正完成后重试，"
    "或先处理待决的修正请求。"
)
_MEDIA_TYPES = {
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".txt": "text/plain",
    ".json": "application/json",
    ".xml": "application/xml",
}


def _geo_source_relations(
    run_ctx: RunContext,
    spec: DatasetBuildSpec,
    assets: Mapping[str, SourceAsset],
) -> list[SourceRelation]:
    """Build only relations backed by trusted GEO esummary metadata."""

    sources = [
        source for source in run_ctx.sources if isinstance(source, SourceRecord)
    ]
    relations: list[SourceRelation] = []
    for binding in spec.source_bindings:
        if binding.source.lower() != "geo" or binding.accession is None:
            continue
        record = run_ctx.geo_series_records.get(binding.accession.upper())
        asset = assets.get(binding.binding_id)
        if record is None or asset is None:
            continue
        relations.extend(
            build_geo_source_relations(
                geo_source_id=asset.source_id,
                geo=record,
                sources=sources,
            )
        )
    return relations
_BUILD_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]*$")


class DatasetBuildValidation(ContractModel):
    """Structured semantic validation result."""

    status: Literal["valid", "invalid"]
    valid: bool
    reason_codes: list[str]
    reasons: list[str]


class DatasetBuildInputError(ContractModel):
    """A stable non-retryable input rejection."""

    status: Literal["invalid_input"] = "invalid_input"
    message: str
    retryable: Literal[False] = False


class DatasetBuildExecutionError(ContractModel):
    """A stable execution/refusal response."""

    status: Literal["error"] = "error"
    message: str
    retryable: bool


class DatasetCacheReference(ContractModel):
    """Read-only identity of a committed V2 cache entry."""

    namespace: str
    dataset_id: str
    dataset_family: str
    row_count: int


class DatasetBuildCompleted(ContractModel):
    """A normally completed build, including structured business outcome."""

    status: Literal["ok"] = "ok"
    build_id: str
    result: BuildResult
    output_dir: Path
    manifest_path: Path


class DatasetBuildPublished(DatasetBuildCompleted):
    """A completed build that reached the cache/mirroring adapter handoff."""

    cache_entry: DatasetCacheReference | None


class DatasetBuildLookup(ContractModel):
    """Task-scoped read model with relative, non-writable references only."""

    task_id: str
    build_id: str
    build_result: BuildResult
    manifest: DatasetManifest
    publication: DatasetPublication | None = None
    artifacts: list[ManifestArtifactEntry]
    manifest_ref: str
    publication_ref: str | None = None


type DatasetBuildValidationResponse = (
    DatasetBuildValidation | DatasetBuildInputError
)
type DatasetBuildExecutionResponse = (
    DatasetBuildCompleted
    | DatasetBuildPublished
    | DatasetBuildInputError
    | DatasetBuildExecutionError
)


def validate_dataset_build_spec(spec: str) -> DatasetBuildValidationResponse:
    """Validate a V2 spec without touching source files or build workspaces."""

    try:
        build_spec = DatasetBuildSpec.model_validate_json(spec)
    except (ValueError, json.JSONDecodeError) as exc:
        return DatasetBuildInputError(message=f"could not parse spec: {exc}")
    result = _build_spec_validator().validate(build_spec)
    return DatasetBuildValidation(
        status="valid" if result.valid else "invalid",
        valid=result.valid,
        reason_codes=list(result.reason_codes),
        reasons=list(result.reasons),
    )


async def execute_dataset_build(
    run_ctx: RunContext,
    spec: str,
    source_files: Mapping[str, str] | str,
    mapping_files: Mapping[str, str] | str = "{}",
    metadata_files: Mapping[str, str] | str = "{}",
    *,
    workflow_recipe_fetcher: Callable[[RunContext], object | None] | None = None,
) -> DatasetBuildExecutionResponse:
    """Execute one V2 build without an OpenAI Agents SDK context wrapper."""

    if run_ctx.main_input_pending:
        return DatasetBuildExecutionError(
            message=_PENDING_MAIN_INPUT_MESSAGE,
            retryable=False,
        )
    try:
        build_spec = DatasetBuildSpec.model_validate_json(spec)
        files_mapping = (
            json.loads(source_files)
            if isinstance(source_files, str)
            else dict(source_files)
        )
    except (ValueError, json.JSONDecodeError) as exc:
        return DatasetBuildInputError(
            message=f"could not parse spec/source_files: {exc}"
        )
    try:
        mapping_mapping = (
            json.loads(mapping_files)
            if isinstance(mapping_files, str)
            else dict(mapping_files)
        )
    except (ValueError, json.JSONDecodeError) as exc:
        return DatasetBuildInputError(message=f"could not parse mapping_files: {exc}")
    try:
        metadata_mapping = (
            json.loads(metadata_files)
            if isinstance(metadata_files, str)
            else dict(metadata_files)
        )
    except (ValueError, json.JSONDecodeError) as exc:
        return DatasetBuildInputError(message=f"could not parse metadata_files: {exc}")
    if not _BUILD_ID_RE.fullmatch(build_spec.build_id):
        return DatasetBuildInputError(
            message=(
                "build_id must match "
                r"[a-zA-Z0-9][a-zA-Z0-9_-]* (no path separators, "
                "dots, or whitespace)"
            )
        )

    spec_validation = _build_spec_validator().validate(build_spec)
    if not spec_validation.valid:
        return DatasetBuildInputError(
            message=(
                "spec validation failed ["
                + ", ".join(spec_validation.reason_codes)
                + "]: "
                + "; ".join(spec_validation.reasons)
            )
        )
    if not isinstance(files_mapping, dict):
        return DatasetBuildInputError(
            message="source_files must be a JSON object {binding_id: path}"
        )

    binding_ids = {binding.binding_id for binding in build_spec.source_bindings}
    recipe_binding_ids = {
        binding.binding_id
        for binding in build_spec.source_bindings
        if binding.acquisition.mode is AcquisitionMode.WORKFLOW_RECIPE
    }
    missing = sorted((binding_ids - recipe_binding_ids) - set(files_mapping))
    if missing:
        return DatasetBuildInputError(
            message="source_files missing bindings: " + ", ".join(missing)
        )

    per_binding_outcomes: dict[str, BindingRejection] = {}
    bindings_by_id = {
        binding.binding_id: binding for binding in build_spec.source_bindings
    }
    if not isinstance(mapping_mapping, dict):
        return DatasetBuildInputError(
            message="mapping_files must be a JSON object {binding_id: path}"
        )
    unknown_mapping_bindings = sorted(set(mapping_mapping) - binding_ids)
    if unknown_mapping_bindings:
        return DatasetBuildInputError(
            message=(
                "mapping_files reference unknown bindings: "
                + ", ".join(unknown_mapping_bindings)
            )
        )
    if not isinstance(metadata_mapping, dict):
        return DatasetBuildInputError(
            message="metadata_files must be a JSON object {binding_id: path}"
        )
    unknown_metadata_bindings = sorted(set(metadata_mapping) - binding_ids)
    if unknown_metadata_bindings:
        return DatasetBuildInputError(
            message=(
                "metadata_files reference unknown bindings: "
                + ", ".join(unknown_metadata_bindings)
            )
        )
    non_geo_metadata_bindings = sorted(
        binding_id
        for binding_id in metadata_mapping
        if bindings_by_id[binding_id].adapter_id != "geo.expression.v1"
    )
    if non_geo_metadata_bindings:
        return DatasetBuildInputError(
            message=(
                "metadata_files are supported only for geo.expression.v1 "
                "bindings: " + ", ".join(non_geo_metadata_bindings)
            )
        )
    try:
        assets, paths = _resolve_local_assets(
            run_ctx,
            files_mapping,
            bindings_by_id,
        )
        mapping_assets, mapping_paths = _resolve_local_assets(
            run_ctx,
            mapping_mapping,
            bindings_by_id,
        )
        metadata_assets, metadata_paths = _resolve_local_assets(
            run_ctx,
            metadata_mapping,
            bindings_by_id,
        )
    except (FileNotFoundError, OSError) as exc:
        return DatasetBuildExecutionError(
            message=f"could not resolve a file: {exc}",
            retryable=True,
        )
    await _acquire_workflow_recipe_bindings(
        run_ctx,
        build_spec,
        assets,
        paths,
        per_binding_outcomes,
        fetcher_factory=workflow_recipe_fetcher or _workflow_recipe_fetcher,
    )

    build_root = run_ctx.work_dir.root / "datasets_build"
    build_root.mkdir(parents=True, exist_ok=True)
    try:
        output_dir = _ensure_build_output_inside(build_root, build_spec.build_id)
    except ValueError as exc:
        return DatasetBuildInputError(message=str(exc))

    runner = ExpressionBuildRunner(
        spec=build_spec,
        registry=_build_schema_registry(),
        source_assets=assets,
        source_paths=paths,
        mapping_assets=mapping_assets,
        mapping_paths=mapping_paths,
        metadata_paths=metadata_paths,
        metadata_assets=metadata_assets,
        source_relations=_geo_source_relations(run_ctx, build_spec, assets),
        output_dir=output_dir,
        cancellation_requested=run_ctx.cancellation_requested,
        pending_check=lambda: run_ctx.main_input_pending,
    )
    try:
        parameter_scope = {
            binding.binding_id: AdapterParams.model_validate(
                binding.parameters
            ).model_dump(mode="json")
            for binding in build_spec.source_bindings
            if binding.parameters
        }
    except ValidationError as exc:
        return DatasetBuildInputError(
            message=f"binding adapter parameters are invalid: {exc}"
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
        source_assets=assets,
        mapping_assets=mapping_assets,
        metadata_assets=metadata_assets,
        parameter_scope=parameter_scope,
        per_binding_outcomes=per_binding_outcomes,
        cancellation_requested=run_ctx.cancellation_requested,
        implementation_versions={
            op.operation_id: (
                "1.1.0"
                if op.kind.value in {"parse", "canonicalize", "validate_profile"}
                else "1.0.0"
            )
            for op in plan
        },
    )
    outcome = await executor.run()
    manifest_path = output_dir / "dataset_manifest.json"
    if outcome.status != "completed":
        if outcome.status == "failed" and outcome.error is not None:
            if outcome.error.message.startswith(_PUBLICATION_REFUSED_PREFIX):
                return DatasetBuildExecutionError(
                    message=_PENDING_MAIN_INPUT_MESSAGE,
                    retryable=False,
                )
            classified = _classify_failed_outcome(
                output_dir,
                outcome.error,
                sorted(binding_ids),
                paths,
                per_binding_outcomes=per_binding_outcomes,
                profile_required_entity_level=get_validation_profile(
                    build_spec.validation_profile_ref
                ).required_entity_level,
            )
            if classified is not None:
                return DatasetBuildCompleted(
                    build_id=build_spec.build_id,
                    result=classified,
                    output_dir=output_dir,
                    manifest_path=manifest_path,
                )
        return DatasetBuildExecutionError(
            message=(
                f"build {build_spec.build_id} ended with status {outcome.status}: "
                + (
                    outcome.error.message
                    if outcome.error is not None
                    else "unknown error"
                )
            ),
            retryable=True,
        )

    publication_id = find_latest_publication(output_dir / PUBLISH_DIR)
    valid_row_count = 0
    manifest: DatasetManifest | None = None
    if manifest_path.is_file():
        manifest = DatasetManifest.model_validate_json(
            manifest_path.read_text("utf-8")
        )
        valid_row_count = manifest.row_count
    rejected_sources = sorted(per_binding_outcomes)
    successful_sources = [
        binding_id
        for binding_id in sorted(binding_ids)
        if binding_id not in rejected_sources
    ]
    result = BuildResult(
        status=(
            BuildResultStatus.PARTIAL_SUCCESS
            if rejected_sources
            else BuildResultStatus.SUCCEEDED
        ),
        valid_row_count=valid_row_count,
        successful_sources=successful_sources,
        rejected_sources=rejected_sources,
        available_artifact_roles=(
            list(dict.fromkeys(artifact.role for artifact in manifest.artifacts))
            if manifest is not None
            else []
        ),
        publication_id=publication_id,
        reason_codes=[],
        user_summary=(
            f"build {build_spec.build_id} published {valid_row_count} valid row(s)"
            if not rejected_sources
            else (
                f"build {build_spec.build_id} partially published: "
                f"{len(successful_sources)} source(s) published, "
                f"{len(rejected_sources)} rejected"
            )
        ),
    )
    cache_entry = None
    try:
        cache = DatasetCacheV2(run_ctx.work_dir.root.parents[2] / "cache")
        committed = cache.commit(
            namespace="build",
            output_dir=output_dir,
            spec=build_spec,
            source_assets=assets,
            keywords=[build_spec.dataset_family, build_spec.objective],
        )
        cache_entry = DatasetCacheReference(
            namespace=committed.namespace,
            dataset_id=committed.dataset_id,
            dataset_family=committed.dataset_family,
            row_count=committed.row_count,
        )
    except (OSError, ValueError, FileNotFoundError) as exc:
        logger.warning(
            "dataset cache commit failed for build %s: %s",
            build_spec.build_id,
            exc,
        )
    return DatasetBuildPublished(
        build_id=build_spec.build_id,
        result=result,
        output_dir=output_dir,
        manifest_path=manifest_path,
        cache_entry=cache_entry,
    )


def get_build_result(
    run_ctx: RunContext,
    build_id: str,
) -> DatasetBuildLookup | None:
    """Load one build inside the supplied task context using read-only refs."""

    if _BUILD_ID_RE.fullmatch(build_id) is None:
        raise ValueError(
            "build_id must be a safe identifier, not a path"
        )
    task_root = run_ctx.work_dir.root.resolve()
    build_dir = (task_root / "datasets_build" / build_id).resolve()
    try:
        build_dir.relative_to(task_root)
    except ValueError as exc:
        raise ValueError("build_id must remain inside the task workspace") from exc
    manifest_path = build_dir / "dataset_manifest.json"
    if not manifest_path.is_file():
        return None
    try:
        manifest = DatasetManifest.model_validate_json(
            manifest_path.read_text("utf-8")
        )
    except (ValidationError, OSError, json.JSONDecodeError) as exc:
        raise ValueError("build manifest is invalid") from exc
    # The legacy expression runner stamps ``manifest.task_id`` with build_id.
    # Task authority therefore comes from the already-scoped task workdir;
    # build identity is still checked against the immutable manifest.
    if manifest.build_id != build_id:
        raise ValueError("build manifest identity does not match the build lookup")
    for artifact in manifest.artifacts:
        _ensure_read_reference_inside(build_dir, artifact.relative_path)
    publication, publication_ref = _load_latest_publication(build_dir, task_root)
    result = _derive_build_result(manifest, publication).model_copy(
        update={"build_id": build_id}
    )
    return DatasetBuildLookup(
        task_id=run_ctx.task_id,
        build_id=build_id,
        build_result=result,
        manifest=manifest,
        publication=publication,
        artifacts=list(manifest.artifacts),
        manifest_ref=manifest_path.relative_to(task_root).as_posix(),
        publication_ref=publication_ref,
    )


def _build_schema_registry() -> SchemaRegistry:
    return SchemaRegistry(
        [build_gene_expression_schema(), build_probe_expression_schema()]
    )


def _build_spec_validator() -> SpecValidator:
    return SpecValidator(
        registry=_build_schema_registry(),
        allowed_validation_profiles=frozenset(VALIDATION_PROFILES),
    )


def _infer_media_type(path: Path) -> str:
    return _MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")


def _ensure_build_output_inside(build_root: Path, build_id: str) -> Path:
    output_dir = build_root / build_id
    try:
        output_dir.resolve().relative_to(build_root.resolve())
    except ValueError as exc:
        raise ValueError(
            f"build_id must remain inside the build workspace: {build_id!r}"
        ) from exc
    return output_dir


def _workflow_recipe_fetcher(run_ctx: RunContext) -> object | None:
    from app.recipes.source_fetcher import WorkflowRecipeSourceFetcher

    try:
        runtime = run_ctx.create_skill_runtime
    except RuntimeError:
        return None
    if runtime.executor is None:
        return None
    return WorkflowRecipeSourceFetcher(executor=runtime.executor, store=runtime.store)


async def _acquire_workflow_recipe_bindings(
    run_ctx: RunContext,
    build_spec: DatasetBuildSpec,
    assets: dict[str, SourceAsset],
    paths: dict[str, Path],
    per_binding_outcomes: dict[str, BindingRejection],
    *,
    fetcher_factory: Callable[[RunContext], object | None],
) -> None:
    fetcher = fetcher_factory(run_ctx)
    for binding in build_spec.source_bindings:
        if binding.acquisition.mode is not AcquisitionMode.WORKFLOW_RECIPE:
            continue
        if fetcher is None:
            per_binding_outcomes[binding.binding_id] = BindingRejection(
                binding_id=binding.binding_id,
                kind=BindingRejectionKind.ERROR,
                reason_code="build_error",
                message=(
                    "workflow_recipe acquisition is not available in this run "
                    "(no trusted Recipe runtime)"
                ),
            )
            continue
        try:
            fetched = await fetcher.fetch(
                binding=binding,
                workspace=run_ctx.source_asset_workspace(),
            )
        except Exception as exc:  # noqa: BLE001 - binding-local acquisition failure
            per_binding_outcomes[binding.binding_id] = BindingRejection(
                binding_id=binding.binding_id,
                kind=BindingRejectionKind.ERROR,
                reason_code="build_error",
                message=f"workflow recipe acquisition failed: {exc}",
            )
            continue
        run_ctx.record_download_attempt(fetched.download_attempt)
        asset = fetched.source_asset
        assets[binding.binding_id] = asset
        paths[binding.binding_id] = run_ctx.work_dir.root / asset.relative_path


def _resolve_local_assets(
    run_ctx: RunContext,
    files_mapping: Mapping[str, str],
    bindings_by_id: dict[str, SourceBinding],
) -> tuple[dict[str, SourceAsset], dict[str, Path]]:
    assets: dict[str, SourceAsset] = {}
    paths: dict[str, Path] = {}
    for binding_id, relative in files_mapping.items():
        path = resolve_task_local_file(run_ctx.work_dir, str(relative))
        checksum = hashlib.sha256(path.read_bytes()).hexdigest()
        binding = bindings_by_id.get(binding_id)
        now = datetime.now(UTC)
        attempt = DownloadAttempt(
            attempt_id=generate_prefixed_uuid("download_attempt"),
            source_id=binding.source if binding else binding_id,
            url=f"local://{relative}",
            status=DownloadStatus.SUCCEEDED,
            bytes_received=path.stat().st_size,
            started_at=now,
            finished_at=now,
        )
        run_ctx.record_download_attempt(attempt)
        assets[binding_id] = SourceAsset(
            asset_id=asset_id_from_sha256(checksum),
            kind="source",
            relative_path=str(relative),
            sha256=checksum,
            size_bytes=path.stat().st_size,
            media_type=_infer_media_type(path),
            source_id=binding_id,
            successful_attempt_id=attempt.attempt_id,
            data_level=DataLevel.REPOSITORY_PROCESSED,
        )
        paths[binding_id] = path
    return assets, paths


def _classify_failed_outcome(
    output_dir: Path,
    outcome_error: ErrorDetail | None,
    binding_ids: list[str],
    source_paths: dict[str, Path],
    *,
    per_binding_outcomes: dict[str, BindingRejection] | None = None,
    profile_required_entity_level: str | None = None,
) -> BuildResult | None:
    del source_paths
    if outcome_error is None:
        return None
    details = outcome_error.details or {}
    reason_code = details.get("reason_code")
    failed_operation = details.get("failed_operation")
    per_binding = per_binding_outcomes or {}
    if binding_ids and set(per_binding) >= set(binding_ids):
        return _no_data_envelope(
            binding_ids,
            _reason_codes_for_all_rejected(per_binding),
            binding_failures=_binding_failures_from(per_binding),
        )
    if reason_code == _REASON_NO_PRIMARY_DATA:
        return _no_data_envelope(binding_ids, [_REASON_NO_PRIMARY_DATA])
    if (
        profile_required_entity_level == "gene"
        and isinstance(failed_operation, str)
        and failed_operation in _MANIFEST_WRITING_OPERATIONS
    ):
        report_path = output_dir / "validation_report.json"
        if report_path.is_file():
            try:
                report = json.loads(report_path.read_text("utf-8"))
            except (OSError, json.JSONDecodeError):
                report = None
            if report is not None and any(
                check.get("check_id")
                == CHECK_ID_PROBE_COVERAGE_REQUIRED_GENE_LEVEL
                and check.get("passed") is False
                for check in report.get("checks", [])
            ):
                return _no_data_envelope(
                    binding_ids,
                    [_REASON_PROBE_MAPPING_UNAVAILABLE],
                    summary=_PROBE_MAPPING_NO_DATA_SUMMARY,
                    next_action=_PROBE_MAPPING_NO_DATA_NEXT_ACTION,
                )
    if (
        not isinstance(failed_operation, str)
        or failed_operation not in _MANIFEST_WRITING_OPERATIONS
    ):
        return None
    manifest_path = output_dir / "dataset_manifest.json"
    if not manifest_path.is_file():
        return None
    try:
        manifest = json.loads(manifest_path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if int(manifest.get("row_count", 1)) != 0:
        return None
    publish_dir = output_dir / PUBLISH_DIR
    if publish_dir.is_dir() and any(
        child.is_dir() and not child.name.startswith(".")
        for child in publish_dir.iterdir()
    ):
        return None
    return _no_data_envelope(binding_ids, [_REASON_NO_PRIMARY_DATA])


def _binding_failures_from(
    per_binding: dict[str, BindingRejection],
) -> list[BindingFailureDetail]:
    return [
        BindingFailureDetail(
            binding_id=rejection.binding_id,
            reason_code=rejection.reason_code,
            message=rejection.message,
        )
        for rejection in sorted(
            per_binding.values(), key=lambda rejection: rejection.binding_id
        )
    ]


def _next_action_for_failures(failures: list[BindingFailureDetail]) -> str:
    for detail in failures:
        if "series matrix" in detail.message and "no data rows" in detail.message:
            return _NO_DATA_NEXT_ACTION_EMPTY_SERIES_MATRIX
    return _NO_DATA_NEXT_ACTION


def _no_data_envelope(
    binding_ids: list[str],
    reason_codes: list[str],
    *,
    rejected_sources: list[str] | None = None,
    summary: str = _NO_DATA_SUMMARY,
    next_action: str | None = None,
    binding_failures: list[BindingFailureDetail] | None = None,
) -> BuildResult:
    failures = binding_failures or []
    if next_action is None:
        next_action = _next_action_for_failures(failures)
    return BuildResult(
        status=BuildResultStatus.NO_DATA,
        valid_row_count=0,
        successful_sources=[],
        rejected_sources=(
            sorted(rejected_sources)
            if rejected_sources is not None
            else sorted(binding_ids)
        ),
        reason_codes=reason_codes,
        user_summary=summary,
        recommended_next_action=next_action,
        binding_failures=failures,
    )


def _reason_codes_for_all_rejected(
    per_binding: dict[str, BindingRejection],
) -> list[str]:
    rejections = [per_binding[binding_id] for binding_id in sorted(per_binding)]
    codes = {rejection.reason_code for rejection in rejections}
    if codes == {_REASON_NO_PRIMARY_DATA}:
        return [_REASON_NO_PRIMARY_DATA]
    if codes == {_REASON_PROBE_MAPPING_UNAVAILABLE}:
        return [_REASON_PROBE_MAPPING_UNAVAILABLE]
    return [
        f"{rejection.reason_code}:{rejection.binding_id}"
        for rejection in rejections
    ]


def _ensure_read_reference_inside(build_dir: Path, relative_path: str) -> None:
    candidate = (build_dir / relative_path).resolve()
    try:
        candidate.relative_to(build_dir.resolve())
    except ValueError as exc:
        raise ValueError("build artifact reference escapes the build directory") from exc


def _load_latest_publication(
    build_dir: Path,
    task_root: Path,
) -> tuple[DatasetPublication | None, str | None]:
    publish_dir = build_dir / PUBLISH_DIR
    if not publish_dir.is_dir():
        return None, None
    newest: tuple[str, DatasetPublication, Path] | None = None
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
        key = publication.published_at.isoformat()
        if newest is None or key > newest[0]:
            newest = (key, publication, publication_path)
    if newest is None:
        return None, None
    return newest[1], newest[2].relative_to(task_root).as_posix()


def _derive_build_result(
    manifest: DatasetManifest,
    publication: DatasetPublication | None,
) -> BuildResult:
    if publication is None or manifest.row_count == 0:
        return BuildResult(
            status=BuildResultStatus.NO_DATA,
            valid_row_count=0,
            rejected_sources=[],
            reason_codes=[_REASON_NO_PRIMARY_DATA],
            user_summary=f"build {manifest.build_id} produced no publishable data",
        )
    return BuildResult(
        status=BuildResultStatus.SUCCEEDED,
        valid_row_count=manifest.row_count,
        successful_sources=sorted(manifest.source_summary),
        available_artifact_roles=list(
            dict.fromkeys(artifact.role for artifact in manifest.artifacts)
        ),
        publication_id=publication.publication_id,
        user_summary=(
            f"build {manifest.build_id} published {manifest.row_count} valid row(s)"
        ),
    )


def _latest_publication_id(publish_dir: Path) -> str | None:
    return find_latest_publication(publish_dir)
