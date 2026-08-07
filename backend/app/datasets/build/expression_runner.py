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

import json
from collections.abc import Mapping
from pathlib import Path

from app.datasets.build.adapters import get_adapter
from app.datasets.build.canonicalizer import (
    CanonicalizationResult,
    canonicalize,
)
from app.datasets.build.compat_gate import check_expression_compatibility
from app.datasets.build.errors import BuildError
from app.datasets.build.gene_maps import SYMBOL_TO_ENSEMBL
from app.datasets.build.hashing import sha256_file
from app.datasets.build.integrator import IntegrationResult, integrate
from app.datasets.build.invariants import check_release_invariants
from app.datasets.build.manifest import (
    MANIFEST_FILE,
    assemble_manifest,
    build_provenance_document,
    write_manifest,
)
from app.datasets.build.profiles import (
    get_normalization_profile,
    get_validation_profile,
)
from app.datasets.contracts import (
    DatasetBuildSpec,
    DatasetManifest,
    ValidationResult,
    ValidationResultStatus,
)
from app.datasets.runtime import OperationKind, OperationOutput, OperationSpec
from app.datasets.schema_registry import SchemaRegistry
from app.domain.contracts.source import SourceAsset
from app.pipeline.state import StageOutputFile

#: Synthetic validation used only to seed the manifest digest before the real
#: profile run; the authoritative manifest is re-assembled after validation.
_PLACEHOLDER_DIGEST = "0" * 64


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
    ) -> None:
        self._spec = spec
        self._registry = registry
        self._source_assets = source_assets
        self._source_paths = source_paths
        self._output_dir = Path(output_dir)
        self._gene_symbol_map = gene_symbol_map
        self._schema = registry.get(spec.schema_ref)
        self._normalization_profile = get_normalization_profile(
            spec.normalization_profile_ref
        )
        self._validation_profile = get_validation_profile(
            spec.validation_profile_ref
        )
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
        batch = adapter.parse(
            asset,
            source_path,
            build_id=self._spec.build_id,
            binding_id=binding.binding_id,
            schema_ref=self._spec.schema_ref,
            output_dir=self._output_dir,
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
        result = canonicalize(
            batch=batch,  # type: ignore[arg-type]
            schema=self._schema,
            profile=self._normalization_profile,
            output_dir=self._output_dir,
            gene_symbol_map=self._gene_symbol_map,
        )
        self._canonical_results[binding_id] = result
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
        integration = integrate(
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
        provenance_path = build_provenance_document(
            schema=self._schema,
            integration=integration,
            canonical_results=self._canonical_results_for_bindings(),
            source_assets=self._source_assets,
            output_dir=self._output_dir,
        )
        audit_paths = _collect_audit_paths(
            self._output_dir,
            list(self._canonical_results.values()),
            integration,
        )
        source_summary = self._source_summary()
        manifest = assemble_manifest(
            task_id=self._spec.build_id,
            build_id=self._spec.build_id,
            spec=self._spec,
            schema=self._schema,
            integration=integration,
            canonical_results=self._canonical_results_for_bindings(),
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
            canonical_results=self._canonical_results_for_bindings(),
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
        manifest = self._require_manifest()
        validation = self._require_validation()
        invariants = check_release_invariants(
            manifest=manifest,
            validation=validation,
            output_dir=self._output_dir,
        )
        if not invariants.passed:
            raise BuildError(
                "release invariants failed: " + "; ".join(invariants.violations)
            )
        # Atomic promotion: copy the immutable version directory via a temp
        # directory + rename so a crash never leaves a half-written
        # publication and a prior version is never mutated.
        import shutil
        from datetime import UTC, datetime

        from app.datasets.contracts import DatasetPublication

        publish_dir = self._output_dir / "publish"
        publish_dir.mkdir(parents=True, exist_ok=True)
        version_dir = publish_dir / f"{manifest.build_id}_{manifest.sha256[:16]}"
        if version_dir.exists():
            raise BuildError(
                f"atomic promotion: version directory already exists: "
                f"{version_dir.name}"
            )
        superseded = _find_latest_publication(publish_dir)
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
            for artifact in manifest.artifacts:
                src = self._output_dir / artifact.relative_path
                if src.is_file():
                    shutil.copy2(src, staged_dir / src.name)
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
            staged_dir.rename(version_dir)
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
                },
            }
        )

    # -------------------------------------------------------------- helpers

    def _binding(self, binding_id: str) -> object:
        for binding in self._spec.source_bindings:
            if binding.binding_id == binding_id:
                return binding
        raise BuildError(f"binding {binding_id!r} is not part of the spec")

    def _canonical_results_for_bindings(self) -> list[CanonicalizationResult]:
        missing = [
            binding.binding_id
            for binding in self._spec.source_bindings
            if binding.binding_id not in self._canonical_results
        ]
        if missing:
            raise BuildError(
                "missing canonical results for binding(s): " + ", ".join(missing)
            )
        return [self._canonical_results[b.binding_id] for b in self._spec.source_bindings]

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
            }
        return summary


def _find_latest_publication(publish_dir: Path) -> str | None:
    """Return the publication_id of the newest existing version directory.

    Version directories are named ``<build_id>_<manifest_digest16>``; the
    newest is the lexicographically last directory carrying a
    ``publication.json``. Returns None when no prior publication exists.
    """
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
