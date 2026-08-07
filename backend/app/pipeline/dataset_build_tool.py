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
from app.datasets.build.expression_runner import (
    _PUBLICATION_REFUSED_PREFIX,
    ExpressionBuildRunner,
    _find_latest_publication,
)
from app.datasets.build.invariants import PUBLISH_DIR
from app.datasets.contracts import DatasetBuildSpec
from app.datasets.runtime import DatasetBuildExecutor, build_operation_plan
from app.datasets.schema_registry import SchemaRegistry, build_gene_expression_schema
from app.domain.contracts import (
    DataLevel,
    ErrorDetail,
    SourceAsset,
    asset_id_from_sha256,
    generate_prefixed_uuid,
)
from app.domain.contracts.dataset_state import BuildResult, BuildResultStatus
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

_PARTIAL_SUMMARY = "任务完成，但部分数据源为空；未发布主数据。"
_PARTIAL_NEXT_ACTION = "补充空数据源后重新构建，或确认仅使用非空数据源。"

# D1 (Phase 4 review): while a data-correction pause is pending, the build
# tool refuses so no publication can be produced from inputs under correction.
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
    runner = ExpressionBuildRunner(
        spec=build_spec,
        registry=SchemaRegistry([build_gene_expression_schema()]),
        source_assets=assets,
        source_paths=paths,
        output_dir=output_dir,
        cancellation_requested=run_ctx.cancellation_requested,
        pending_check=lambda: run_ctx.main_input_pending,
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


def _classify_failed_outcome(
    output_dir: Path,
    outcome_error: ErrorDetail | None,
    binding_ids: list[str],
    source_paths: dict[str, Path],
) -> BuildResult | None:
    """Map a failed build outcome to a structured BuildResult envelope (H3).

    Returns ``None`` for genuine execution failures (the caller keeps the
    generic retryable-error envelope).

    - NO_DATA: this attempt produced no publishable primary data — either the
      parse layer reported an empty source (structured ``reason_code``
      ``no_primary_data``, which is this attempt's by construction) or the
      integrated primary has zero rows (manifest written by THIS attempt) and
      no version was published for this build_id in this run.
    - PARTIAL_SUCCESS: a mixed-source build where at least one source had
      data rows but an empty source aborted the build — the usable sources
      are surfaced, never all-rejected as NO_DATA.
    """

    if outcome_error is None:
        return None
    details = outcome_error.details or {}
    reason_code = details.get("reason_code")
    failed_operation = details.get("failed_operation")

    if reason_code == _REASON_NO_PRIMARY_DATA:
        usable = [
            binding_id
            for binding_id in binding_ids
            if _source_has_data_rows(source_paths.get(binding_id))
        ]
        if usable:
            return BuildResult(
                status=BuildResultStatus.PARTIAL_SUCCESS,
                valid_row_count=0,
                successful_sources=sorted(usable),
                rejected_sources=sorted(
                    binding_id
                    for binding_id in binding_ids
                    if binding_id not in usable
                ),
                reason_codes=[_REASON_NO_PRIMARY_DATA],
                user_summary=_PARTIAL_SUMMARY,
                recommended_next_action=_PARTIAL_NEXT_ACTION,
            )
        return BuildResult(
            status=BuildResultStatus.NO_DATA,
            valid_row_count=0,
            successful_sources=[],
            rejected_sources=sorted(binding_ids),
            reason_codes=[_REASON_NO_PRIMARY_DATA],
            user_summary=_NO_DATA_SUMMARY,
            recommended_next_action=_NO_DATA_NEXT_ACTION,
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
    return BuildResult(
        status=BuildResultStatus.NO_DATA,
        valid_row_count=0,
        successful_sources=[],
        rejected_sources=sorted(binding_ids),
        reason_codes=[_REASON_NO_PRIMARY_DATA],
        user_summary=_NO_DATA_SUMMARY,
        recommended_next_action=_NO_DATA_NEXT_ACTION,
    )


def _source_has_data_rows(path: Path | None) -> bool:
    """True when a source file has at least one data row beyond its header.

    Adapter-agnostic emptiness probe used to scope mixed-source NO_DATA
    classification to the sources that actually produced rows (H3). The plan
    aborts at the first empty source's parse, so later bindings' parse
    operations never run — the source files are the authoritative signal for
    whether they had data.
    """

    if path is None or not path.is_file():
        return False
    seen_header = False
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            for line in handle:
                if not line.strip() or line.lstrip().startswith("#"):
                    continue
                if not seen_header:
                    seen_header = True
                    continue
                return True
    except (OSError, UnicodeDecodeError):
        return False
    return False


def _latest_publication_id(publish_dir: Path) -> str | None:
    """Read the newest version directory's publication_id (if any).

    Delegates to ``ExpressionBuildRunner._find_latest_publication`` so the
    tool and the supersedes chain agree: newest by ``published_at``, never by
    lexicographic publication_id order (B8).
    """

    return _find_latest_publication(publish_dir)
