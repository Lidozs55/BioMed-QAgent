"""Real operation runner wiring the expression build components into the
Phase 2 execution kernel (Phase 3 P2; Design §16 Phase 3).

``build_expression_dataset`` (``chain.py``) runs the whole skeleton as one
function; this runner splits the same fixed skeleton into per-operation
handlers so the ``DatasetBuildExecutor`` can execute and checkpoint each
Operation (acquire/parse/canonicalize/compatibility_gate/integrate/
validate_profile/publish) with digest reuse and crash recovery.

The runner delegates to the same server-side components as the chain
(adapters, canonicalizer, compatibility gate, integrator, validation
profile, manifest) and adds the Phase 6 architecture-level release
invariants gate on the ``publish`` operation.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import functools
import json
import shutil
import threading
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TypeVar

from app.datasets.build.adapters import adapter_params_for_binding, get_adapter
from app.datasets.build.canonicalizer import (
    CanonicalizationResult,
    canonicalize,
)
from app.datasets.build.compat_gate import check_expression_compatibility
from app.datasets.build.errors import BindingRejectedError, BuildError
from app.datasets.build.gene_maps import SYMBOL_TO_ENSEMBL
from app.datasets.build.hashing import sha256_file
from app.datasets.build.integrator import IntegrationResult, integrate
from app.datasets.build.invariants import (
    check_release_invariants,
    find_latest_publication,
)
from app.datasets.build.manifest import (
    MANIFEST_FILE,
    assemble_manifest,
    build_provenance_document,
    write_manifest,
)
from app.datasets.build.probe_mapping import build_probe_mapping
from app.datasets.build.profiles import (
    get_normalization_profile,
    get_validation_profile,
)
from app.datasets.contracts import (
    BindingRejection,
    BindingRejectionKind,
    DatasetBuildSpec,
    DatasetManifest,
    ProbeMappingStatus,
    ProbeMappingSummary,
    ValidationResult,
    ValidationResultStatus,
)
from app.datasets.runtime import OperationKind, OperationOutput, OperationSpec
from app.datasets.runtime.executor import BuildCancelledError, CancellationToken
from app.datasets.schema_registry import SchemaRegistry
from app.domain.contracts.source import SourceAsset
from app.pipeline.state import StageOutputFile

#: Type variable for the worker-thread offload helper (the caller's expected
#: return type is the wrapped function's return type).
_OffloadT = TypeVar("_OffloadT")

#: Synthetic validation used only to seed the manifest digest before the real
#: profile run; the authoritative manifest is re-assembled after validation.
_PLACEHOLDER_DIGEST = "0" * 64

#: H2 (Phase 4 review): marker prefix for the publish-time refusal when a
#: main-run data-correction pause became pending mid-build. The tool maps any
#: failed outcome whose message starts with this prefix to the agent-facing
#: refusal envelope (same text family as the entry gate).
_PUBLICATION_REFUSED_PREFIX = "publication refused: main input pending"


class PublicationRefusedError(BuildError):
    """The build reached publication while a correction pause is pending.

    D1/H2 (Phase 4 review): the tool's entry gate is point-in-time; the
    publish operation rechecks immediately before the immutable rename so a
    correction that became pending mid-build can never promote a version.
    """


class _WorkerCompletionFuture(concurrent.futures.Future[Any]):
    """A worker-completion future tagged with its worker's identity.

    K1 residual (wave 10): ``worker_id`` is set when the future is created
    and read from the SAME object by the executor (which records it in the
    ``.worker_unfinished`` marker) and by the worker's ``finally`` (which
    read-compares before unlinking), so both sides agree by construction.
    """

    worker_id: str


def _complete_worker_future(completion: concurrent.futures.Future[Any]) -> None:
    """Set a worker-completion signal exactly once, race-safely.

    K1 residual (Phase 4 review wave 9): the executor's straggler grace may
    cancel the completion future while the worker thread is mid-``finally``
    — a cancellation landing between a ``done()`` check and ``set_result``
    would raise ``InvalidStateError`` in the worker's tail (check-then-act
    race). ``set_result`` is the single authoritative state transition; any
    non-pending future (already finished or cancelled) raises and is
    suppressed, so the worker's finally can never raise here.
    """
    with contextlib.suppress(concurrent.futures.InvalidStateError):
        completion.set_result(None)


class ExpressionBuildRunner:
    """Executes the expression skeleton operations against real components."""

    def __init__(
        self,
        *,
        spec: DatasetBuildSpec,
        registry: SchemaRegistry,
        source_assets: dict[str, SourceAsset],
        source_paths: dict[str, Path],
        output_dir: Path,
        gene_symbol_map: Mapping[str, str] | None = SYMBOL_TO_ENSEMBL,
        cancellation_requested: CancellationToken | None = None,
        pending_check: Callable[[], bool] | None = None,
        per_binding_outcomes: dict[str, BindingRejection] | None = None,
        mapping_assets: Mapping[str, SourceAsset] | None = None,
        mapping_paths: Mapping[str, Path] | None = None,
    ) -> None:
        self._spec = spec
        self._registry = registry
        self._source_assets = source_assets
        self._source_paths = source_paths
        self._output_dir = Path(output_dir)
        self._gene_symbol_map = gene_symbol_map
        self._cancellation_requested = cancellation_requested
        # H2 (Phase 4 review): rechecked immediately before the immutable
        # publication rename so a correction that became pending mid-build
        # refuses promotion (the tool's entry gate is point-in-time only).
        self._pending_check = pending_check
        # Phase 5 T7: the per-binding fan-out outcomes map.  The caller (the
        # dataset-build tool) may pass its own dict so the runner, executor
        # and tool share one outcome map.
        self._per_binding_outcomes = (
            per_binding_outcomes if per_binding_outcomes is not None else {}
        )
        # Phase 5 T7 D3: optional per-binding GPL annotation assets used to
        # map probes to genes; the mapping assets and their on-disk paths.
        self._mapping_assets = dict(mapping_assets or {})
        self._mapping_paths = dict(mapping_paths or {})
        # Per-binding ProbeMappingSummary objects + mapping-detail audit paths
        # produced during canonicalization (D3), fed to the validation profile
        # and the manifest audit list.
        self._probe_mapping_summaries: dict[str, ProbeMappingSummary] = {}
        self._mapping_detail_paths: list[Path] = []
        self._schema = registry.get(spec.schema_ref)
        self._normalization_profile = get_normalization_profile(
            spec.normalization_profile_ref
        )
        self._validation_profile = get_validation_profile(
            spec.validation_profile_ref
        )
        # K1 residual (Phase 4 review): worker-thread futures started by this
        # runner whose threads may still be running after the executor's
        # operation timeout cancelled only the await. The executor awaits
        # these (bounded) before finalizing the failure and releasing the
        # build lock. ``_worker_done`` discards completed futures (the set is
        # touched from worker threads, so it is guarded by a lock).
        self._worker_futures: set[concurrent.futures.Future[Any]] = set()
        self._worker_futures_lock = threading.Lock()
        # K1 residual (wave 9): the executor registers the per-build
        # ``.worker_unfinished`` marker path here at run start; a worker
        # thread's ``finally`` removes the marker best-effort so a retry
        # polling the marker observes the workspace stabilizing exactly
        # when the straggler thread truly finishes (the marker is the
        # exclusion; threads share the filesystem).
        self._worker_marker_path: Path | None = None
        # Per-operation state accumulated across the plan run. A digest-reused
        # (SKIPPED) operation simply reports the cached output again.
        self._batches: dict[str, object] = {}
        self._canonical_results: dict[str, CanonicalizationResult] = {}
        self._integration: IntegrationResult | None = None
        self._manifest: DatasetManifest | None = None
        self._validation: ValidationResult | None = None

    async def __call__(
        self, op: OperationSpec, upstream: dict[str, object]
    ) -> OperationOutput:
        return await self.run_operation(op, upstream)

    def in_flight_workers(self) -> tuple[concurrent.futures.Future[Any], ...]:
        """Return the operation worker futures whose threads may still run.

        K1 residual (Phase 4 review): a ``to_thread`` worker cannot be
        interrupted — ``asyncio.timeout`` cancels only the await (and the
        executor's wrapped future), never the thread. Each worker's
        completion future is set from inside the worker itself (``finally``),
        so it stays pending exactly while the thread may still be writing.
        The executor awaits these stragglers (bounded) before finalizing a
        timed-out/cancelled/failed operation and releasing the build lock,
        so a same-build_id retry never overlaps a live late worker writing
        the same deterministic output paths.
        """
        with self._worker_futures_lock:
            return tuple(
                future
                for future in self._worker_futures
                if not future.done()
            )

    def _worker_done(
        self, future: concurrent.futures.Future[Any]
    ) -> None:
        """Drop a completed worker future (runs in the completing thread)."""
        with self._worker_futures_lock:
            self._worker_futures.discard(future)

    def set_worker_marker_path(self, marker_path: Path | None) -> None:
        """Register the state-dir worker marker for best-effort cleanup.

        K1 residual (wave 9): the executor calls this at run start with
        ``state/<build_id>/.worker_unfinished``; every worker thread's
        ``finally`` removes the marker (best-effort, OSError suppressed) so
        a same-build_id retry that polls the marker proceeds exactly when
        the straggler thread truly finishes. Runners constructed directly
        (without an executor) keep ``None`` and never clean a marker.
        """
        self._worker_marker_path = marker_path

    def _cleanup_worker_marker(self, own_worker_id: str) -> None:
        """Read-compare-unlink the state-dir worker marker for THIS worker.

        K1 residual (wave 10): a worker's ``finally`` removes the
        ``.worker_unfinished`` marker only when it owns it
        (``marker.worker_id == own_worker_id``). A marker that is absent or
        written for another worker is left untouched — the executor
        re-checks process ownership on the retry side, so a marker for a
        still-live straggler must survive until that straggler's finally
        runs. Best-effort: OSError / JSONDecodeError suppressed (a vanished
        or corrupt marker is nothing to clean).
        """
        marker = self._worker_marker_path
        if marker is None:
            return
        try:
            payload = json.loads(marker.read_text("utf-8"))
            if payload.get("worker_id") != own_worker_id:
                return
            marker.unlink(missing_ok=True)
        except (OSError, json.JSONDecodeError):
            return

    async def _offload(
        self,
        func: Callable[..., _OffloadT],
        *args: object,
        **kwargs: object,
    ) -> _OffloadT:
        """Run heavy synchronous work in a worker thread, tracking completion.

        D2/H1 + K1 residual: same offload semantics as ``asyncio.to_thread``
        (default executor), plus a completion signal that survives
        ``asyncio.timeout``. ``loop.run_in_executor`` returns a wrapped
        asyncio future that the timeout CANCELLES — its ``done()`` state
        says nothing about the thread. So thread completion is tracked by a
        separate raw ``concurrent.futures.Future`` set from inside the
        worker's ``finally``; that future is never cancelled by the timeout,
        which lets ``in_flight_workers()`` report a straggler whose thread is
        still writing after its await was cancelled.
        """
        loop = asyncio.get_running_loop()
        completion = _WorkerCompletionFuture()
        # K1 residual (wave 10): tag the completion future with its worker's
        # identity so the executor can record it in the marker and this
        # worker's finally can read-compare before unlinking.
        completion.worker_id = f"w{id(completion):x}"
        with self._worker_futures_lock:
            self._worker_futures.add(completion)
        completion.add_done_callback(self._worker_done)

        def tracked(*tracked_args: object, **tracked_kwargs: object) -> object:
            try:
                return func(*tracked_args, **tracked_kwargs)
            finally:
                _complete_worker_future(completion)
                # K1 residual (wave 10): the worker thread truly finished —
                # read-compare-unlink the state-dir worker marker: this
                # worker removes ONLY its own marker, so a marker written
                # for a still-live straggler survives until THAT straggler's
                # finally runs (threads share the filesystem; the marker is
                # the exclusion).
                self._cleanup_worker_marker(completion.worker_id)

        worker = loop.run_in_executor(
            None, functools.partial(tracked, *args, **kwargs)
        )
        return await worker

    async def run_operation(
        self, op: OperationSpec, upstream: dict[str, object]
    ) -> OperationOutput:
        handler = {
            OperationKind.ACQUIRE: self._acquire,
            OperationKind.PARSE: self._parse,
            OperationKind.CANONICALIZE: self._canonicalize,
            OperationKind.COMPATIBILITY_GATE: self._compatibility_gate,
            OperationKind.INTEGRATE: self._integrate,
            OperationKind.VALIDATE_PROFILE: self._validate_profile,
            OperationKind.PUBLISH: self._publish,
        }.get(op.kind)
        if handler is None:
            raise BuildError(f"no operation handler for kind {op.kind!r}")
        return await handler(op, upstream)

    # ------------------------------------------------------------------ ops

    async def _acquire(
        self, op: OperationSpec, upstream: dict[str, object]
    ) -> OperationOutput:
        binding_id = op.category
        try:
            asset = self._source_assets[binding_id]
        except KeyError as exc:
            raise BuildError(f"no source asset supplied for binding {binding_id!r}") from exc
        return OperationOutput(
            output={
                "binding_id": binding_id,
                "source_id": asset.source_id,
                "asset_id": asset.asset_id,
            }
        )

    async def _parse(
        self, op: OperationSpec, upstream: dict[str, object]
    ) -> OperationOutput:
        binding = self._binding(op.category)
        asset = self._source_assets[binding.binding_id]
        source_path = self._source_paths[binding.binding_id]
        adapter = get_adapter(binding.adapter_id)
        # Phase 5 D1: the binding's typed AdapterParams flow into the parse.
        parameters = adapter_params_for_binding(binding)
        # D2/H1 (Phase 4 review): full-file parsing is heavy synchronous work;
        # run it in a worker thread so the event loop stays responsive (the
        # manager can process a cancel request while the parse runs) and the
        # executor's operation-boundary cancellation checks can interrupt.
        batch = await self._offload(
            adapter.parse,
            asset,
            source_path,
            build_id=self._spec.build_id,
            binding_id=binding.binding_id,
            schema_ref=self._spec.schema_ref,
            output_dir=self._output_dir,
            parameters=parameters,
        )
        self._batches[binding.binding_id] = batch
        file_outputs = _file_outputs(
            self._output_dir, [batch.file_asset.relative_path]
        )
        return OperationOutput(
            output={
                "binding_id": binding.binding_id,
                "batch_id": batch.batch_id,
                "schema_ref": batch.schema_ref,
                "row_count": batch.row_count,
                "column_count": batch.column_count,
                "file": batch.file_asset.relative_path,
            },
            files=file_outputs,
        )

    async def _canonicalize(
        self, op: OperationSpec, upstream: dict[str, object]
    ) -> OperationOutput:
        binding_id = op.category
        batch = self._batches.get(binding_id)
        if batch is None:
            raise BuildError(f"no parsed batch cached for binding {binding_id!r}")
        # Phase 5 T7 D3: when a GPL annotation asset is supplied for this
        # binding, build the probe→gene map + ProbeMappingSummary before
        # canonicalizing so mapped rows are re-namespaced and the coverage
        # policy consumes the real summary.  Without an asset, a binding
        # whose batch declares probes gets an honest not_attempted summary.
        probe_map: Mapping[str, str] | None = None
        probe_target_namespace = "gene_symbol"
        mapping_result = None
        annotation_path = self._mapping_paths.get(binding_id)
        if annotation_path is not None and annotation_path.is_file():
            mapping_asset = self._mapping_assets.get(binding_id)
            platform_ids = [
                str(platform_id)
                for platform_id in batch.statistics.get("platform_ids", [])
            ]
            mapping_result = await self._offload(
                build_probe_mapping,
                annotation_path=annotation_path,
                batch_path=self._output_dir / batch.file_asset.relative_path,
                binding_id=binding_id,
                platform_id=platform_ids[0] if platform_ids else None,
                source_asset_id=(
                    mapping_asset.asset_id if mapping_asset is not None else None
                ),
                output_dir=self._output_dir,
            )
            probe_map = mapping_result.probe_to_gene
            probe_target_namespace = mapping_result.target_namespace
        elif "geo_probe" in str(batch.statistics.get("source_gene_id_namespace", "")):
            platform_ids = [
                str(platform_id)
                for platform_id in batch.statistics.get("platform_ids", [])
            ]
            self._probe_mapping_summaries[binding_id] = ProbeMappingSummary(
                binding_id=binding_id,
                platform_id=platform_ids[0] if platform_ids else None,
                source_namespace="geo_probe",
                target_namespace=None,
                mapping_status=ProbeMappingStatus.NOT_ATTEMPTED,
                total_probe_count=0,
                mapped_probe_count=0,
                unmapped_probe_count=0,
                ambiguous_probe_count=0,
                coverage_ratio=0.0,
                mapping_asset_id=None,
                mapping_rule_id=None,
            )
        # D2/H1: canonicalization is heavy synchronous work; offload it to a
        # worker thread so cancellation stays responsive during the operation.
        result = await self._offload(
            canonicalize,
            batch=batch,
            schema=self._schema,
            profile=self._normalization_profile,
            output_dir=self._output_dir,
            gene_symbol_map=self._gene_symbol_map,
            probe_map=probe_map,
            probe_target_namespace=probe_target_namespace,
        )
        # Phase 5 T7 D5: per-binding rejection for a binding that produced no
        # usable rows (parsed-but-zero-valid) or — for gene-required builds —
        # no publishable gene rows.  The binding is recorded as a per-binding
        # rejection; its canonical audits stay on disk (4b audit survival) and
        # phase B ignores it.
        if result.row_count == 0:
            raise BindingRejectedError(
                BindingRejection(
                    binding_id=binding_id,
                    kind=BindingRejectionKind.NO_PRIMARY,
                    reason_code="no_primary_data",
                    message="source yielded zero valid rows after canonicalization",
                )
            )
        if (
            self._validation_profile.required_entity_level == "gene"
            and not _has_gene_namespace(result.namespaces)
        ):
            raise BindingRejectedError(
                BindingRejection(
                    binding_id=binding_id,
                    kind=BindingRejectionKind.NO_PRIMARY,
                    reason_code="probe_mapping_unavailable_required_gene_level",
                    message=(
                        "gene-required build: binding produced no publishable "
                        "gene rows (probe->gene coverage is zero)"
                    ),
                )
            )
        self._canonical_results[binding_id] = result
        if mapping_result is not None:
            self._probe_mapping_summaries[binding_id] = mapping_result.summary
            self._mapping_detail_paths.append(mapping_result.detail_path)
        relative_paths = [
            result.canonical_path.relative_to(self._output_dir).as_posix(),
            *[p.relative_to(self._output_dir).as_posix() for p in result.audit_paths],
        ]
        return OperationOutput(
            output={
                "binding_id": binding_id,
                "row_count": result.row_count,
                "rejected_count": result.rejected_count,
                "namespaces": list(result.namespaces),
            },
            files=_file_outputs(self._output_dir, relative_paths),
        )

    async def _compatibility_gate(
        self, op: OperationSpec, upstream: dict[str, object]
    ) -> OperationOutput:
        results = self._canonical_results_for_bindings()
        gate = check_expression_compatibility(spec=self._spec, results=results)
        if not gate.compatible:
            raise BuildError(
                "compatibility gate failed: " + "; ".join(gate.reasons)
            )
        return OperationOutput(
            output={
                "compatible": True,
                "reasons": list(gate.reasons),
            }
        )

    async def _integrate(
        self, op: OperationSpec, upstream: dict[str, object]
    ) -> OperationOutput:
        results = self._canonical_results_for_bindings()
        # D2/H1: integration is heavy synchronous work; offload it to a worker
        # thread so the event loop stays responsive during the operation.
        integration = await self._offload(
            integrate,
            results=results,
            merge_strategy=self._spec.merge_strategy,
            schema=self._schema,
            build_id=self._spec.build_id,
            output_dir=self._output_dir,
        )
        self._integration = integration
        relative_paths = [
            integration.merged_path.relative_to(self._output_dir).as_posix()
        ]
        if (
            integration.conflicts_path is not None
            and integration.conflict_count > 0
        ):
            relative_paths.append(
                integration.conflicts_path.relative_to(self._output_dir).as_posix()
            )
        return OperationOutput(
            output={
                "row_count": integration.row_count,
                "dedup_count": integration.dedup_count,
                "conflict_count": integration.conflict_count,
                "merged_file": integration.merged_path.relative_to(
                    self._output_dir
                ).as_posix(),
            },
            files=_file_outputs(self._output_dir, relative_paths),
        )

    async def _validate_profile(
        self, op: OperationSpec, upstream: dict[str, object]
    ) -> OperationOutput:
        integration = self._require_integration()
        successful_results = self._canonical_results_for_bindings()
        # Phase 5 T7: provenance covers only the phase-A-successful bindings
        # (rejected bindings have no canonical rows in the primary).
        successful_assets = {
            binding_id: asset
            for binding_id, asset in self._source_assets.items()
            if binding_id not in self._per_binding_outcomes
        }
        provenance_path = build_provenance_document(
            schema=self._schema,
            integration=integration,
            canonical_results=successful_results,
            source_assets=successful_assets,
            output_dir=self._output_dir,
        )
        audit_paths = _collect_audit_paths(
            self._output_dir,
            successful_results,
            integration,
        )
        # Phase 5 T7 D3: publish the ProbeMappingSummary + mapping-detail
        # audits with the build (supporting/audit survive even when the
        # release gate fails and no primary is published).
        summaries = [
            self._probe_mapping_summaries[binding_id]
            for binding_id in sorted(self._probe_mapping_summaries)
        ]
        if summaries:
            summaries_path = self._output_dir / "probe_mapping_summaries.csv"
            _write_probe_mapping_summaries(summaries_path, summaries)
            audit_paths.append(summaries_path)
        audit_paths.extend(self._mapping_detail_paths)
        source_summary = self._source_summary()
        manifest = assemble_manifest(
            task_id=self._spec.build_id,
            build_id=self._spec.build_id,
            spec=self._spec,
            schema=self._schema,
            integration=integration,
            canonical_results=successful_results,
            provenance_path=provenance_path,
            audit_paths=audit_paths,
            validation=_placeholder_validation(),
            source_summary=source_summary,
            output_dir=self._output_dir,
        )
        validation = self._validation_profile.validate(
            manifest=manifest,
            primary_path=integration.merged_path,
            schema=self._schema,
            manifest_digest=manifest.sha256,
            output_dir=self._output_dir,
            probe_mapping_summaries=summaries or None,
        )
        self._validation = validation
        # Re-assemble with the authoritative validation summary and persist
        # the manifest exactly once (never a fail-open manifest on disk).
        manifest = assemble_manifest(
            task_id=self._spec.build_id,
            build_id=self._spec.build_id,
            spec=self._spec,
            schema=self._schema,
            integration=integration,
            canonical_results=successful_results,
            provenance_path=provenance_path,
            audit_paths=audit_paths,
            validation=validation,
            source_summary=source_summary,
            output_dir=self._output_dir,
        )
        write_manifest(manifest, self._output_dir)
        self._manifest = manifest
        report_path = self._output_dir / validation.report_path
        relative_paths = [MANIFEST_FILE, validation.report_path]
        return OperationOutput(
            output={
                "status": validation.status.value,
                "checked_count": validation.checked_count,
                "failed_count": validation.failed_count,
                "manifest_digest": manifest.sha256,
            },
            files=_file_outputs(self._output_dir, relative_paths)
            if report_path.is_file()
            else _file_outputs(self._output_dir, [MANIFEST_FILE]),
        )

    async def _publish(
        self, op: OperationSpec, upstream: dict[str, object]
    ) -> OperationOutput:
        # D2 (Phase 4 review): the publish operation must never promote a
        # version after cancellation was requested — the executor also checks
        # around every operation, this is defense in depth for direct runs.
        if (
            self._cancellation_requested is not None
            and self._cancellation_requested.is_set()
        ):
            raise BuildCancelledError(
                "build was cancelled before publish"
            )
        manifest = self._require_manifest()
        validation = self._require_validation()
        invariants = check_release_invariants(
            manifest=manifest,
            validation=validation,
            output_dir=self._output_dir,
            # Phase 5 T7: provenance closure covers only the phase-A-successful
            # bindings (the provenance document lists their assets; rejected
            # bindings have no rows in the primary).
            expected_source_asset_ids={
                asset.asset_id
                for binding_id, asset in self._source_assets.items()
                if binding_id not in self._per_binding_outcomes
            },
        )
        if not invariants.passed:
            raise BuildError(
                "release invariants failed: " + "; ".join(invariants.violations)
            )
        # Atomic promotion: copy the immutable version directory via a temp
        # directory + rename so a crash never leaves a half-written
        # publication and a prior version is never mutated.
        import shutil

        from app.datasets.contracts import DatasetPublication

        publish_dir = self._output_dir / "publish"
        publish_dir.mkdir(parents=True, exist_ok=True)
        version_dir = publish_dir / f"{manifest.build_id}_{manifest.sha256[:16]}"
        if version_dir.exists():
            raise BuildError(
                f"atomic promotion: version directory already exists: "
                f"{version_dir.name}"
            )
        # Phase 5 T6 (D6): the supersede lookup is build-scoped — a
        # publication of one build_id must never supersede a publication of
        # another build_id even when both share this publish directory
        # (e.g. two distinct GSE builds orchestrated by MultiBuildOrchestrator).
        superseded = find_latest_publication(
            publish_dir, build_id=self._spec.build_id
        )
        publication_id = f"pub_{manifest.build_id}_{manifest.sha256[:16]}"
        publication = DatasetPublication(
            publication_id=publication_id,
            manifest_ref=manifest.manifest_id,
            validation_result_ref=(
                "validation_report.json"
                if validation.report_path is None
                else str(validation.report_path)
            ),
            published_at=datetime.now(UTC),
            supersedes_publication_id=superseded,
        )
        staged_dir = publish_dir / f".{version_dir.name}.tmp"
        if staged_dir.exists():
            shutil.rmtree(staged_dir)
        staged_dir.mkdir(parents=True)
        try:
            # B3 (Phase 4 review): preserve each artifact's relative_path
            # under the version directory so the manifest's references resolve
            # inside the immutable publication. A vanished file raises OSError
            # (never a silent skip) and aborts the promotion.
            for artifact in manifest.artifacts:
                src = self._output_dir / artifact.relative_path
                dest = staged_dir / artifact.relative_path
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest)
            manifest_src = self._output_dir / MANIFEST_FILE
            if manifest_src.is_file():
                shutil.copy2(manifest_src, staged_dir / MANIFEST_FILE)
            (staged_dir / "publication.json").write_text(
                json.dumps(
                    publication.model_dump(mode="json"), ensure_ascii=False, indent=2
                )
                + "\n",
                "utf-8",
            )
            # H2 (Phase 4 review): recheck the pending-input gate immediately
            # before the immutable rename — the entry gate is point-in-time
            # and the broker may set pending later, mid-build. Refusal raises
            # before any version directory exists.
            if self._pending_check is not None and self._pending_check():
                raise PublicationRefusedError(
                    _PUBLICATION_REFUSED_PREFIX
                )
            staged_dir.rename(version_dir)
        except PublicationRefusedError:
            shutil.rmtree(staged_dir, ignore_errors=True)
            raise
        except OSError as exc:
            shutil.rmtree(staged_dir, ignore_errors=True)
            raise BuildError(f"atomic promotion failed: {exc}") from exc
        return OperationOutput(
            output={
                "publication_id": publication_id,
                "version_dir": version_dir.relative_to(self._output_dir).as_posix(),
                "supersedes_publication_id": superseded,
                "invariants": {
                    "provenance_closed": invariants.provenance_closed,
                    "profile_passed": invariants.profile_passed,
                    "atomic_promotion_ready": invariants.atomic_promotion_ready,
                    "artifacts_intact": invariants.artifacts_intact,
                },
            }
        )

    # -------------------------------------------------------------- helpers

    def discard_operation_outputs(self, op: OperationSpec) -> None:
        """Delete the outputs a (cancelled) operation would have written.

        D2/K1 (Phase 4 review): the operation-boundary cancellation check
        runs only after the worker thread's await completed, so the thread's
        files are finished but must not become part of the build state — a
        completed-too-late parse/canonicalize/integrate would otherwise leave
        intermediates that a retry (or an inspection) could mistake for valid
        state or overlap with. Discarding at the boundary is safe (never
        mid-write); the in-flight sync work itself is not preemptable, that
        residual is documented.
        """

        output_dir = self._output_dir
        if op.kind is OperationKind.PARSE or op.kind is OperationKind.CANONICALIZE:
            binding_id = op.category
            if op.kind is OperationKind.PARSE:
                targets = [
                    output_dir / "batches" / f"{binding_id}.csv",
                    output_dir / "batches" / f"{binding_id}_rejected.csv",
                ]
            else:
                targets = list(
                    (output_dir / "canonical").glob(f"{binding_id}.*")
                )
        elif op.kind is OperationKind.INTEGRATE:
            targets = [
                output_dir / "merged" / "primary.csv",
                output_dir / "merged" / "conflicts.csv",
            ]
        elif op.kind is OperationKind.VALIDATE_PROFILE:
            targets = [
                output_dir / "dataset_manifest.json",
                output_dir / "validation_report.json",
                output_dir / "provenance.json",
            ]
        elif op.kind is OperationKind.PUBLISH:
            targets = [
                staged
                for staged in (output_dir / "publish").glob(".*.tmp")
                if staged.is_dir()
            ]
        else:
            targets = []
        for target in targets:
            try:
                if target.is_dir():
                    shutil.rmtree(target)
                else:
                    target.unlink(missing_ok=True)
            except OSError:
                # Best-effort hygiene: a file held open by a dying worker
                # thread may refuse deletion; the retry re-runs the operation
                # and rewrites the same paths anyway.
                continue

    def _binding(self, binding_id: str) -> object:
        for binding in self._spec.source_bindings:
            if binding.binding_id == binding_id:
                return binding
        raise BuildError(f"binding {binding_id!r} is not part of the spec")

    def _canonical_results_for_bindings(self) -> list[CanonicalizationResult]:
        """Canonical results of the phase-A-successful bindings only.

        Phase 5 T7: rejected bindings never enter ``_canonical_results``, so
        phase B (gate/integrate/validate/publish) only sees the bindings that
        survived the per-binding fan-out.
        """
        return [
            self._canonical_results[b.binding_id]
            for b in self._spec.source_bindings
            if b.binding_id in self._canonical_results
        ]

    def _require_integration(self) -> IntegrationResult:
        if self._integration is None:
            raise BuildError("integrate operation must run before validation")
        return self._integration

    def _require_manifest(self) -> DatasetManifest:
        if self._manifest is None:
            raise BuildError("validate_profile operation must run before publish")
        return self._manifest

    def _require_validation(self) -> ValidationResult:
        if self._validation is None:
            raise BuildError("validate_profile operation must run before publish")
        return self._validation

    def _source_summary(self) -> dict[str, object]:
        summary: dict[str, object] = {}
        for binding_id, result in self._canonical_results.items():
            asset = self._source_assets.get(binding_id)
            summary[binding_id] = {
                "source_id": asset.source_id if asset is not None else "",
                "asset_id": asset.asset_id if asset is not None else "",
                "adapter_id": next(
                    (
                        binding.adapter_id
                        for binding in self._spec.source_bindings
                        if binding.binding_id == binding_id
                    ),
                    "",
                ),
                "row_count": result.row_count,
                "rejected_count": result.rejected_count,
                "unit": ", ".join(result.batch.statistics.get("expression_units", [])),
                "namespace": ", ".join(result.namespaces),
                # Phase 5 D2: the entity level of the published rows — probe
                # when any geo_probe namespace is present, otherwise gene.
                "entity_level": (
                    "probe" if "geo_probe" in result.namespaces else "gene"
                ),
            }
        return summary


def _has_gene_namespace(namespaces: tuple[str, ...]) -> bool:
    """True when any canonical namespace is a gene-level namespace.

    Phase 5 T7 D5: a gene-required build needs at least one binding with
    publishable gene rows (ensembl_gene/gene_symbol); a binding whose rows
    are all ``geo_probe`` yields zero publishable gene rows and is rejected
    per-binding.
    """
    return any(
        namespace in ("ensembl_gene", "gene_symbol") for namespace in namespaces
    )


#: ProbeMappingSummary audit CSV columns (Phase 5 D3).
_PROBE_MAPPING_SUMMARY_COLUMNS = (
    "binding_id",
    "platform_id",
    "source_namespace",
    "target_namespace",
    "mapping_status",
    "total_probe_count",
    "mapped_probe_count",
    "unmapped_probe_count",
    "ambiguous_probe_count",
    "coverage_ratio",
    "mapping_asset_id",
    "mapping_rule_id",
)


def _write_probe_mapping_summaries(
    path: Path, summaries: list[ProbeMappingSummary]
) -> None:
    """Write the per-binding/platform ProbeMappingSummary audit CSV."""
    import csv as csv_module

    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv_module.DictWriter(handle, fieldnames=_PROBE_MAPPING_SUMMARY_COLUMNS)
        writer.writeheader()
        for summary in summaries:
            writer.writerow(
                {
                    "binding_id": summary.binding_id,
                    "platform_id": summary.platform_id or "",
                    "source_namespace": summary.source_namespace,
                    "target_namespace": summary.target_namespace or "",
                    "mapping_status": summary.mapping_status.value,
                    "total_probe_count": summary.total_probe_count,
                    "mapped_probe_count": summary.mapped_probe_count,
                    "unmapped_probe_count": summary.unmapped_probe_count,
                    "ambiguous_probe_count": summary.ambiguous_probe_count,
                    "coverage_ratio": f"{summary.coverage_ratio:.4f}",
                    "mapping_asset_id": summary.mapping_asset_id or "",
                    "mapping_rule_id": summary.mapping_rule_id or "",
                }
            )


def _placeholder_validation() -> ValidationResult:
    return ValidationResult(
        manifest_digest=_PLACEHOLDER_DIGEST,
        profile_ref="gene_expression.release.v1",
        status=ValidationResultStatus.PASSED,
        checked_count=0,
        failed_count=0,
    )


def _collect_audit_paths(
    output_dir: Path,
    canonical_results: list[CanonicalizationResult],
    integration: IntegrationResult,
) -> list[Path]:
    paths: list[Path] = []
    for result in canonical_results:
        for path in result.audit_paths:
            if path.is_file():
                paths.append(path)
        parse_rejected = (
            output_dir / "batches" / f"{result.batch.binding_id}_rejected.csv"
        )
        if parse_rejected.is_file():
            paths.append(parse_rejected)
    if integration.conflicts_path is not None and integration.conflict_count > 0:
        paths.append(integration.conflicts_path)
    return paths


def _file_outputs(output_dir: Path, relative_paths: list[str]) -> tuple[StageOutputFile, ...]:
    files: list[StageOutputFile] = []
    seen: set[str] = set()
    for relative in sorted(relative_paths):
        if relative in seen:
            continue
        seen.add(relative)
        path = output_dir / relative
        if not path.is_file():
            continue
        files.append(
            StageOutputFile(
                relative_path=relative,
                size_bytes=path.stat().st_size,
                sha256=sha256_file(path),
            )
        )
    return tuple(files)
