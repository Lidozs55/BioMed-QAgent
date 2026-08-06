"""Demo build chain orchestration (Phase 3).

``build_expression_dataset`` runs the fixed skeleton for one build:

    parse[*] -> canonicalize[*] -> compatibility gate -> integrate
    -> validate profile -> manifest

It is deterministic and content-addressed; the Phase 2 runtime will drive
this same chain behind Operation attempts and reuse.  Source assets and their
on-disk paths are supplied by the caller (the Acquisition layer), so the
chain stays pure and testable.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from app.datasets.build import adapters
from app.datasets.build.canonicalizer import canonicalize
from app.datasets.build.compat_gate import CompatibilityReport, check_expression_compatibility
from app.datasets.build.errors import BuildError
from app.datasets.build.integrator import integrate
from app.datasets.build.manifest import build_manifest, build_provenance_document
from app.datasets.build.profiles import get_normalization_profile, get_validation_profile
from app.datasets.contracts import (
    DatasetBuildSpec,
    DatasetManifest,
    ValidationResult,
)
from app.datasets.schema_registry import SchemaRegistry
from app.domain.contracts.source import SourceAsset


@dataclass(frozen=True)
class SourceBuildSummary:
    """Per-source outcome after canonicalization."""

    binding_id: str
    source_id: str
    asset_id: str
    adapter_id: str
    row_count: int
    rejected_count: int
    unit: str
    namespace: str


@dataclass(frozen=True)
class BuildChainResult:
    """Outcome of one demo build chain run.

    ``status`` is one of ``"succeeded"`` or ``"rejected"``; the Phase 4
    runtime maps these (plus execution failures) onto ``BuildResultStatus``.
    """

    status: str
    manifest: DatasetManifest | None
    validation: ValidationResult | None
    compatibility: CompatibilityReport | None
    reason_codes: tuple[str, ...]
    output_dir: Path
    sources: tuple[SourceBuildSummary, ...]


def build_expression_dataset(
    *,
    spec: DatasetBuildSpec,
    registry: SchemaRegistry,
    source_assets: dict[str, SourceAsset],
    source_paths: dict[str, Path],
    output_dir: Path,
    task_id: str = "task_demo",
) -> BuildChainResult:
    """Run the expression build chain; raises BuildError on execution failure."""
    output_dir.mkdir(parents=True, exist_ok=True)
    schema = registry.get(spec.schema_ref)
    normalization_profile = get_normalization_profile(spec.normalization_profile_ref)
    validation_profile = get_validation_profile(spec.validation_profile_ref)

    canonical_results = []
    source_summaries: list[SourceBuildSummary] = []
    for binding in spec.source_bindings:
        asset = source_assets[binding.binding_id]
        adapter = adapters.get_adapter(binding.adapter_id)
        batch = adapter.parse(
            asset,
            source_paths[binding.binding_id],
            build_id=spec.build_id,
            binding_id=binding.binding_id,
            schema_ref=spec.schema_ref,
            output_dir=output_dir,
        )
        result = canonicalize(
            batch=batch,
            schema=schema,
            profile=normalization_profile,
            output_dir=output_dir,
        )
        canonical_results.append(result)
        statistics = result.batch.statistics
        source_summaries.append(
            SourceBuildSummary(
                binding_id=binding.binding_id,
                source_id=asset.source_id,
                asset_id=asset.asset_id,
                adapter_id=binding.adapter_id,
                row_count=result.row_count,
                rejected_count=result.rejected_count,
                unit=", ".join(statistics.get("expression_units", [])),
                namespace=", ".join(statistics.get("gene_id_namespaces", [])),
            )
        )

    gate = check_expression_compatibility(spec=spec, results=canonical_results)
    if not gate.compatible:
        return BuildChainResult(
            status="rejected",
            manifest=None,
            validation=None,
            compatibility=gate,
            reason_codes=gate.reasons,
            output_dir=output_dir,
            sources=tuple(source_summaries),
        )

    integration = integrate(
        results=canonical_results,
        merge_strategy=spec.merge_strategy,
        schema=schema,
        build_id=spec.build_id,
        output_dir=output_dir,
    )

    provenance_path = build_provenance_document(
        schema=schema,
        integration=integration,
        canonical_results=canonical_results,
        source_assets=source_assets,
        output_dir=output_dir,
    )
    audit_paths = _collect_audit_paths(output_dir, canonical_results, integration)
    source_summary = {
        summary.binding_id: {
            "source_id": summary.source_id,
            "adapter_id": summary.adapter_id,
            "row_count": summary.row_count,
            "rejected_count": summary.rejected_count,
            "unit": summary.unit,
            "namespace": summary.namespace,
        }
        for summary in source_summaries
    }
    manifest = build_manifest(
        task_id=task_id,
        build_id=spec.build_id,
        spec=spec,
        schema=schema,
        integration=integration,
        canonical_results=canonical_results,
        provenance_path=provenance_path,
        audit_paths=audit_paths,
        validation=_placeholder_validation(),  # replaced after the real run
        source_summary=source_summary,
        output_dir=output_dir,
    )
    validation = validation_profile.validate(
        manifest=manifest,
        primary_path=integration.merged_path,
        schema=schema,
        manifest_digest=manifest.sha256,
        output_dir=output_dir,
    )
    # Rebuild the manifest with the authoritative validation summary; the
    # manifest digest is content-based and does not include the summary.
    manifest = build_manifest(
        task_id=task_id,
        build_id=spec.build_id,
        spec=spec,
        schema=schema,
        integration=integration,
        canonical_results=canonical_results,
        provenance_path=provenance_path,
        audit_paths=audit_paths,
        validation=validation,
        source_summary=source_summary,
        output_dir=output_dir,
    )
    if validation.status.value != "passed":
        return BuildChainResult(
            status="rejected",
            manifest=manifest,
            validation=validation,
            compatibility=gate,
            reason_codes=("validation_failed",),
            output_dir=output_dir,
            sources=tuple(source_summaries),
        )
    return BuildChainResult(
        status="succeeded",
        manifest=manifest,
        validation=validation,
        compatibility=gate,
        reason_codes=(),
        output_dir=output_dir,
        sources=tuple(source_summaries),
    )


def _collect_audit_paths(
    output_dir: Path,
    canonical_results,
    integration,
) -> list[Path]:
    paths: list[Path] = []
    for result in canonical_results:
        for path in result.audit_paths:
            if path.is_file():
                paths.append(path)
        parse_rejected = output_dir / "batches" / f"{result.batch.binding_id}_rejected.csv"
        if parse_rejected.is_file():
            paths.append(parse_rejected)
    if integration.conflicts_path is not None and integration.conflict_count > 0:
        paths.append(integration.conflicts_path)
    return paths


def _placeholder_validation() -> ValidationResult:
    from app.datasets.contracts import ValidationResultStatus

    return ValidationResult(
        manifest_digest="0" * 64,
        profile_ref="gene_expression.release.v1",
        status=ValidationResultStatus.PASSED,
        checked_count=0,
        failed_count=0,
    )
