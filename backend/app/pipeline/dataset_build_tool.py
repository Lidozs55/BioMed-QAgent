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
import logging
import re
from pathlib import Path

from agents import RunContextWrapper, function_tool
from pydantic import ValidationError

from app.agent_loop.context import RunContext
from app.config import settings
from app.datasets.build.cache import DatasetCacheV2
from app.datasets.build.expression_runner import (
    _PUBLICATION_REFUSED_PREFIX,
    ExpressionBuildRunner,
)
from app.datasets.build.invariants import PUBLISH_DIR, find_latest_publication
from app.datasets.build.profiles import VALIDATION_PROFILES, get_validation_profile
from app.datasets.contracts import (
    AdapterParams,
    BindingRejection,
    DatasetBuildSpec,
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
    ErrorDetail,
    SourceAsset,
    asset_id_from_sha256,
    generate_prefixed_uuid,
)
from app.domain.contracts.dataset_state import (
    BuildResult,
    BuildResultStatus,
)
from app.tools.workdir import resolve_task_local_file

_NO_DATA_SUMMARY = "任务完成，但未产出可发布的主数据。"
_NO_DATA_NEXT_ACTION = "检查数据源可用性或调整查询后重试。"

#: H3 (Phase 4 review): structured reason code carried by the parse layer for
#: an empty source and propagated through the outcome error details.
_REASON_NO_PRIMARY_DATA = "no_primary_data"

#: H3: operation ids that persist the manifest for the current attempt — only
#: a failure at/after these may use the persisted manifest as this attempt's
#: zero-row evidence (validate_profile writes it; publish runs right after).
_MANIFEST_WRITING_OPERATIONS = frozenset({"validate_profile", "publish"})

#: Phase 5 T7 (D5): stable reason code for a gene-required build that could
#: not produce any publishable gene rows (probe->gene coverage zero or a
#: partial mapping that leaves residual probe rows).
_REASON_PROBE_MAPPING_UNAVAILABLE = "probe_mapping_unavailable_required_gene_level"

#: Phase 5 T7 (D5 row 3): NO_DATA copy for a gene-required build that could
#: not produce any publishable gene rows (probe->gene mapping unavailable).
_PROBE_MAPPING_NO_DATA_SUMMARY = (
    "任务完成，但未产出满足 gene 级要求的主数据（probe→gene 映射不可用）。"
)
_PROBE_MAPPING_NO_DATA_NEXT_ACTION = (
    "检查 GPL 注释资产可用性或改用 probe 级构建。"
)

# D1 (Phase 4 review): while a data-correction pause is pending, the build
# tool refuses so no publication can be produced from inputs under correction.
_PENDING_MAIN_INPUT_MESSAGE = (
    "execute_dataset_build 被拒绝：当前 Run 正在等待人工修正"
    "（request_human_correction 尚未答复）。请等待修正完成后重试，"
    "或先处理待决的修正请求。"
)
logger = logging.getLogger(__name__)

_MEDIA_TYPES = {
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".txt": "text/plain",
    ".json": "application/json",
    ".xml": "application/xml",
}

#: build_id becomes a directory name under the task root (output_dir,
#: state_dir, version dirs) so it must be a safe path segment. Agent-supplied
#: values are validated before any file system access.
_BUILD_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]*$")


def _infer_media_type(path: Path) -> str:
    return _MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")


def _ensure_build_output_inside(build_root: Path, build_id: str) -> Path:
    """Resolve the build output dir and prove it stays inside the workspace.

    Defense in depth for B1 (Phase 4 review): ``DatasetBuildSpec`` rejects
    path-like ``build_id`` values at model construction, but the tool must
    never trust a value that slips through — ``build_root / build_id`` is
    only used when the resolved path remains under ``build_root``.
    """

    output_dir = build_root / build_id
    try:
        output_dir.resolve().relative_to(build_root.resolve())
    except ValueError as exc:
        raise ValueError(
            f"build_id must remain inside the build workspace: {build_id!r}"
        ) from exc
    return output_dir


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
    if run_ctx.main_input_pending:
        # D1 (Phase 4 review): a correction pause is an exclusivity boundary.
        # The SDK may run sibling FunctionTools concurrently; refuse to build
        # while the Run is waiting on request_human_correction so the build
        # never publishes from inputs under correction.
        return json.dumps(
            {
                "status": "error",
                "message": _PENDING_MAIN_INPUT_MESSAGE,
                "retryable": False,
            },
            ensure_ascii=False,
        )
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
    if not _BUILD_ID_RE.fullmatch(build_spec.build_id):
        return json.dumps(
            {
                "status": "invalid_input",
                "message": (
                    "build_id must match "
                    r"[a-zA-Z0-9][a-zA-Z0-9_-]* (no path separators, "
                    "dots, or whitespace)"
                ),
                "retryable": False,
            },
            ensure_ascii=False,
        )
    # Phase 5 final review (F1): the SpecValidator's registry + entity-level
    # compatibility checks are wired into the production entry here, before
    # any source file is touched or any build workspace is created. A gene
    # build under a probe schema (or a probe build under the gene profile) is
    # invalid_input with the validator's structured reasons — never a build
    # that could publish probe rows under the gene release gate.
    spec_validation = SpecValidator(
        registry=SchemaRegistry(
            [build_gene_expression_schema(), build_probe_expression_schema()]
        ),
        allowed_validation_profiles=frozenset(VALIDATION_PROFILES),
    ).validate(build_spec)
    if not spec_validation.valid:
        return json.dumps(
            {
                "status": "invalid_input",
                "message": (
                    "spec validation failed ["
                    + ", ".join(spec_validation.reason_codes)
                    + "]: "
                    + "; ".join(spec_validation.reasons)
                ),
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
    try:
        output_dir = _ensure_build_output_inside(build_root, build_spec.build_id)
    except ValueError as exc:
        return json.dumps(
            {
                "status": "invalid_input",
                "message": str(exc),
                "retryable": False,
            },
            ensure_ascii=False,
        )
    # Phase 5 T7: the per-binding fan-out outcomes map is shared by the
    # runner (records rejections), the executor (skips phase B when every
    # binding is rejected) and this tool (classification).
    per_binding_outcomes: dict[str, BindingRejection] = {}
    runner = ExpressionBuildRunner(
        spec=build_spec,
        registry=SchemaRegistry(
            [build_gene_expression_schema(), build_probe_expression_schema()]
        ),
        source_assets=assets,
        source_paths=paths,
        output_dir=output_dir,
        cancellation_requested=run_ctx.cancellation_requested,
        pending_check=lambda: run_ctx.main_input_pending,
    )
    # Phase 5 D1: per-binding parameter scope — each binding's normalized
    # AdapterParams JSON enters the operation digest, so changing a binding's
    # format/scale/unit/platform_ids invalidates every checkpoint.  Invalid
    # declared parameters are rejected as invalid input before any operation
    # runs (the SpecValidator at the tool entry already rejects
    # missing/invalid AdapterParams for geo bindings — final review F1 —
    # this block additionally rejects binding-level parameter errors that
    # only surface at model validation time, e.g. an invalid scale).
    try:
        parameter_scope = {
            binding.binding_id: AdapterParams.model_validate(
                binding.parameters
            ).model_dump(mode="json")
            for binding in build_spec.source_bindings
            if binding.parameters
        }
    except ValidationError as exc:
        return json.dumps(
            {
                "status": "invalid_input",
                "message": f"binding adapter parameters are invalid: {exc}",
                "retryable": False,
            },
            ensure_ascii=False,
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
        parameter_scope=parameter_scope,
        per_binding_outcomes=per_binding_outcomes,
        cancellation_requested=run_ctx.cancellation_requested,
        implementation_versions={op.operation_id: "1.0.0" for op in plan},
    )
    outcome = await executor.run()
    if outcome.status != "completed":
        if outcome.status == "failed" and outcome.error is not None:
            # H2 (Phase 4 review): a correction that became pending between
            # validation and publication refuses the immutable promotion —
            # same agent-facing text family as the entry gate, never a
            # retryable error.
            if outcome.error.message.startswith(_PUBLICATION_REFUSED_PREFIX):
                return json.dumps(
                    {
                        "status": "error",
                        "message": _PENDING_MAIN_INPUT_MESSAGE,
                        "retryable": False,
                    },
                    ensure_ascii=False,
                )
            classified = _classify_failed_outcome(
                output_dir,
                outcome.error,
                sorted(binding_ids),
                paths,
                per_binding_outcomes=per_binding_outcomes,
                profile_required_entity_level=(
                    get_validation_profile(
                        build_spec.validation_profile_ref
                    ).required_entity_level
                ),
            )
            if classified is not None:
                return json.dumps(
                    {
                        "status": "ok",
                        "build_id": build_spec.build_id,
                        "result": classified.model_dump(mode="json"),
                        "output_dir": output_dir.as_posix(),
                        "manifest_file": (
                            (output_dir / "dataset_manifest.json").as_posix()
                            if (output_dir / "dataset_manifest.json").is_file()
                            else None
                        ),
                    },
                    ensure_ascii=False,
                )
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

    publication_id = find_latest_publication(output_dir / PUBLISH_DIR)
    manifest_path = output_dir / "dataset_manifest.json"
    valid_row_count = 0
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text("utf-8"))
        valid_row_count = int(manifest.get("row_count", 0))
    # Phase 5 T7 D5: per-binding fan-out — only the phase-A-successful
    # bindings contributed to the published primary; a build with one or more
    # rejected bindings is PARTIAL_SUCCESS (a genuinely publishable surviving
    # source), never a silent success that counts rejected sources.
    rejected_sources = sorted(per_binding_outcomes)
    successful_sources = [
        binding_id for binding_id in sorted(binding_ids)
        if binding_id not in rejected_sources
    ]
    status = (
        BuildResultStatus.PARTIAL_SUCCESS
        if rejected_sources
        else BuildResultStatus.SUCCEEDED
    )
    result = BuildResult(
        status=status,
        valid_row_count=valid_row_count,
        successful_sources=successful_sources,
        rejected_sources=rejected_sources,
        publication_id=publication_id,
        reason_codes=[],
        user_summary=(
            f"build {build_spec.build_id} published "
            f"{valid_row_count} valid row(s)"
            if not rejected_sources
            else (
                f"build {build_spec.build_id} partially published: "
                f"{len(successful_sources)} source(s) published, "
                f"{len(rejected_sources)} rejected"
            )
        ),
    )
    # Phase 7 P0: commit the immutable version to the content-addressed V2
    # dataset cache so later tasks can discover/reuse it by keyword.
    cache_entry = None
    try:
        cache = DatasetCacheV2(Path(settings.output_dir).parent / "cache")
        cache_entry = cache.commit(
            namespace="build",
            output_dir=output_dir,
            spec=build_spec,
            source_assets=assets,
            keywords=[build_spec.dataset_family, build_spec.objective],
        )
    except (OSError, ValueError, FileNotFoundError) as exc:
        logger.warning("dataset cache commit failed for build %s: %s", build_spec.build_id, exc)
    return json.dumps(
        {
            "status": "ok",
            "build_id": build_spec.build_id,
            "result": result.model_dump(mode="json"),
            "output_dir": output_dir.as_posix(),
            "manifest_file": manifest_path.as_posix(),
            "cache_entry": (
                {
                    "namespace": cache_entry.namespace,
                    "dataset_id": cache_entry.dataset_id,
                    "dataset_family": cache_entry.dataset_family,
                    "row_count": cache_entry.row_count,
                }
                if cache_entry is not None
                else None
            ),
        },
        ensure_ascii=False,
    )



def _classify_failed_outcome(
    output_dir: Path,
    outcome_error: ErrorDetail | None,
    binding_ids: list[str],
    source_paths: dict[str, Path],
    *,
    per_binding_outcomes: dict[str, BindingRejection] | None = None,
    profile_required_entity_level: str | None = None,
) -> BuildResult | None:
    """Map a failed build outcome to a structured BuildResult envelope (H3).

    Returns ``None`` for genuine execution failures (the caller keeps the
    generic retryable-error envelope).

    - NO_DATA (all bindings rejected, Phase 5 T7 fan-out): phase A rejected
      every binding, so phase B never ran and nothing was published.  The
      reason codes follow the per-binding rejections: all-empty builds keep
      the generic ``no_primary_data``; a gene-required build whose sources
      produced zero publishable gene rows keeps the stable
      ``probe_mapping_unavailable_required_gene_level``; mixed reasons are
      binding-scoped (``no_primary_data:<id>`` / ``parse_error:<id>``).
    - NO_DATA (empty source, D5 row 1): the parse layer reported a typed
      ``no_primary_data``.
    - NO_DATA (gene-required + probe coverage failed, D5 row 3): the build
      had rows but the gene release gate failed on residual probe rows — no
      publishable gene rows, nothing published, supporting/audit survive.
    - NO_DATA (manifest signal): the integrated primary has zero rows
      (manifest written by THIS attempt) and no version was published.
    """

    if outcome_error is None:
        return None
    details = outcome_error.details or {}
    reason_code = details.get("reason_code")
    failed_operation = details.get("failed_operation")

    per_binding = per_binding_outcomes or {}
    # Phase 5 T7 D5: phase A rejected every binding -> NO_DATA with per-binding
    # reason codes (phase B never ran; nothing was published).
    if binding_ids and set(per_binding) >= set(binding_ids):
        return _no_data_envelope(
            binding_ids,
            _reason_codes_for_all_rejected(per_binding),
        )

    if reason_code == _REASON_NO_PRIMARY_DATA:
        return _no_data_envelope(binding_ids, [_REASON_NO_PRIMARY_DATA])

    # Phase 5 T7 D5 row 3 (tool layer): a gene-required build whose release
    # gate failed on the probe-coverage check produced no publishable gene
    # rows — the classifier unifies the 4b NO_DATA path (zero publishable
    # gene rows) and the Profile-FAILED path (rows exist, coverage < 1.0)
    # into NO_DATA with the stable reason code.  Probe-level builds never
    # take this branch (they publish the honest probe primary, D5 row 2).
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
                check.get("check_id") == "probe_coverage_required_gene_level"
                and check.get("passed") is False
                for check in report.get("checks", [])
            ):
                return _no_data_envelope(
                    binding_ids,
                    [_REASON_PROBE_MAPPING_UNAVAILABLE],
                    summary=_PROBE_MAPPING_NO_DATA_SUMMARY,
                    next_action=_PROBE_MAPPING_NO_DATA_NEXT_ACTION,
                )

    # Manifest signal: only trust a persisted manifest when THIS attempt wrote
    # it (validate_profile persists it; publish runs immediately after). A
    # stale zero-row manifest from an earlier attempt must never drive the
    # NO_DATA classification for a build that failed before validation.
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


def _no_data_envelope(
    binding_ids: list[str],
    reason_codes: list[str],
    *,
    rejected_sources: list[str] | None = None,
    summary: str = _NO_DATA_SUMMARY,
    next_action: str = _NO_DATA_NEXT_ACTION,
) -> BuildResult:
    """A NO_DATA BuildResult with zero valid rows and no publication."""
    return BuildResult(
        status=BuildResultStatus.NO_DATA,
        valid_row_count=0,
        successful_sources=[],
        rejected_sources=(
            sorted(rejected_sources) if rejected_sources is not None else sorted(binding_ids)
        ),
        reason_codes=reason_codes,
        user_summary=summary,
        recommended_next_action=next_action,
    )


def _reason_codes_for_all_rejected(
    per_binding: dict[str, BindingRejection],
) -> list[str]:
    """Reason codes for an all-rejected phase A (D5).

    All-empty keeps the generic ``no_primary_data``; a gene-required build
    where every binding yielded zero publishable gene rows keeps the stable
    probe-mapping code; mixed reasons are binding-scoped.
    """
    rejections = [per_binding[binding_id] for binding_id in sorted(per_binding)]
    codes = {rejection.reason_code for rejection in rejections}
    if codes == {_REASON_NO_PRIMARY_DATA}:
        return [_REASON_NO_PRIMARY_DATA]
    if codes == {_REASON_PROBE_MAPPING_UNAVAILABLE}:
        return [_REASON_PROBE_MAPPING_UNAVAILABLE]
    return [f"{rejection.reason_code}:{rejection.binding_id}" for rejection in rejections]





def _latest_publication_id(publish_dir: Path) -> str | None:
    """Read the newest version directory's publication_id (if any).

    Delegates to ``ExpressionBuildRunner._find_latest_publication`` so the
    tool and the supersedes chain agree: newest by ``published_at``, never by
    lexicographic publication_id order (B8).
    """

    return find_latest_publication(publish_dir)
