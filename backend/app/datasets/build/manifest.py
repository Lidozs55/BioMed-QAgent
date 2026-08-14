"""Role-based DatasetManifest V2 builder (ARCHITECTURE §3.6-3.7).

The manifest is the only authoritative entry point for locating the primary
dataset and its supporting artifacts — programs never hard-code filenames.
Manifest digest is computed over the data artifacts (primary, supporting,
schema, provenance, audits) so it is stable and independent of the manifest JSON
itself and of the validation report.
"""

from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path

from app.datasets.build.canonicalizer import CanonicalizationResult
from app.datasets.build.hashing import sha256_file
from app.datasets.build.integrator import IntegrationResult
from app.datasets.contracts import (
    ArtifactRole,
    DatasetBuildSpec,
    DatasetManifest,
    DatasetSchema,
    ManifestArtifactEntry,
    ValidationResult,
)
from app.domain.contracts.source import SourceAsset

SCHEMA_FILE = "schema.json"
PROVENANCE_FILE = "provenance.json"
MANIFEST_FILE = "dataset_manifest.json"


def file_sha256(path: Path) -> str:
    return sha256_file(path)


def package_digest(entries: list[ManifestArtifactEntry]) -> str:
    """Deterministic digest over sorted (relative_path, sha256) artifact pairs."""
    hasher = hashlib.sha256()

    for entry in sorted(entries, key=lambda e: e.relative_path):
        hasher.update(entry.relative_path.encode("utf-8"))
        hasher.update(b"\0")
        hasher.update(entry.sha256.encode("utf-8"))
        hasher.update(b"\0")
    return hasher.hexdigest()


def _entry(
    role: ArtifactRole, path: Path, output_dir: Path, media_type: str = "text/csv"
) -> ManifestArtifactEntry:
    checksum = file_sha256(path)
    relative_path = path.relative_to(output_dir).as_posix()
    # C3a: content-addressed ids must not collide when identical bytes appear
    # at two relative paths — include the path in the digest. Wire shape
    # unchanged (``artifact_`` + 32 hex); digest is deterministic and
    # re-computed from the manifest file on every read (no migration needed
    # for previously written entries).
    artifact_id = (
        "artifact_"
        + hashlib.sha256(
            (relative_path + "\0" + checksum).encode("utf-8")
        ).hexdigest()[:32]
    )
    return ManifestArtifactEntry(
        artifact_id=artifact_id,
        role=role,
        relative_path=relative_path,
        media_type=media_type,
        size_bytes=path.stat().st_size,
        sha256=checksum,
    )


def build_provenance_document(
    *,
    schema: DatasetSchema,
    integration: IntegrationResult,
    canonical_results: list[CanonicalizationResult],
    source_assets: dict[str, SourceAsset],
    output_dir: Path,
) -> Path:
    """Write provenance.json: source inventory, mappings, rules, backtraces."""
    mappings = [
        {
            "mapping_id": mapping.mapping_id,
            "source_field": mapping.source_field,
            "target_field": mapping.target_field,
            "transform": mapping.transform,
            "mapping_method": mapping.mapping_method.value,
            "confidence_level": mapping.confidence_level.value,
            "evidence": mapping.evidence,
        }
        for result in canonical_results
        for mapping in result.batch.declared_mappings
    ]
    normalization_rules = [
        {
            "binding_id": result.batch.binding_id,
            "namespaces": list(result.namespaces),
            "normalization_log_file": _rel(
                output_dir, result.audit_paths[1]
            ),
        }
        for result in canonical_results
    ]
    document = {
        "schema_ref": schema.schema_id,
        "sources": [
            {
                "binding_id": binding_id,
                "asset_id": asset.asset_id,
                "source_id": asset.source_id,
                "logical_file": asset.relative_path.split("/")[-1],
                "sha256": asset.sha256,
                "successful_attempt_id": asset.successful_attempt_id,
            }
            for binding_id, asset in sorted(source_assets.items())
        ],
        "field_mappings": mappings,
        "normalization_rules": normalization_rules,
        "merge_strategy": integration.batch.statistics.get("merge_strategy"),
        "sample_backtraces": _sample_backtraces(integration.merged_path),
    }
    path = output_dir / PROVENANCE_FILE
    path.write_bytes((
        json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8"))
    return path


def _rel(output_dir: Path, path: Path) -> str:
    return path.relative_to(output_dir).as_posix()


def _sample_backtraces(primary_path: Path, limit: int = 5) -> list[dict[str, object]]:
    backtraces: list[dict[str, object]] = []
    with primary_path.open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            backtraces.append(
                {
                    "record_id": row.get("record_id", ""),
                    "gene_id": row.get("gene_id", ""),
                    "gene_id_namespace": row.get("gene_id_namespace", ""),
                    "sample_id": row.get("sample_id", ""),
                    "asset_id": row.get("asset_id", ""),
                    "source_logical_file": row.get("source_logical_file", ""),
                    "source_line_number": row.get("source_line_number", ""),
                    "source_column_name": row.get("source_column_name", ""),
                    "source_raw_value": row.get("source_raw_value", ""),
                    "transforms": [
                        {
                            "transform": "namespace_authorize",
                            "input": row.get("gene_id_raw", ""),
                            "output": row.get("gene_id", ""),
                        }
                    ],
                }
            )
            if len(backtraces) >= limit:
                break
    return backtraces


def compute_provenance_coverage(
    primary_path: Path,
    source_asset_ids: set[str],
) -> dict[str, object]:
    """Provenance coverage of the primary dataset (Design §16 Phase 6 P2).

    Counts how many primary rows carry an ``asset_id`` that belongs to the
    build's source asset set. Rows with a missing/unknown asset are
    ``untraced``. Returns a deterministic JSON-safe summary:

    ``{"traced_rows": N, "untraced_rows": N, "coverage_ratio": 0..1}``
    """
    traced = 0
    untraced = 0
    with primary_path.open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            asset_id = str(row.get("asset_id", "")).strip()
            if asset_id and asset_id in source_asset_ids:
                traced += 1
            else:
                untraced += 1
    total = traced + untraced
    ratio = (traced / total) if total else 0.0
    return {
        "traced_rows": traced,
        "untraced_rows": untraced,
        "coverage_ratio": round(ratio, 4),
    }


def build_confidence_summary(output_dir: Path) -> dict[str, object]:
    """Summarize the deterministic confidence detectors for the manifest.

    Reads ``confidence_report.csv`` (written by the validation profile) and
    returns ``{"detected_anomaly_count": N, "report_file": "..."}``, or an
    empty dict when no report exists (e.g. no primary dataset). This is the
    Confidence Contract's manifest-side surface (Design §16 Phase 6).
    """
    report_path = output_dir / "confidence_report.csv"
    if not report_path.is_file():
        return {}
    anomaly_count = 0
    with report_path.open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("anomaly", "").strip().lower() == "true":
                anomaly_count += 1
    return {
        "detected_anomaly_count": anomaly_count,
        "report_file": report_path.name,
    }


def assemble_manifest(
    *,
    task_id: str,
    build_id: str,
    spec: DatasetBuildSpec,
    schema: DatasetSchema,
    integration: IntegrationResult,
    canonical_results: list[CanonicalizationResult],
    provenance_path: Path,
    audit_paths: list[Path],
    supporting_paths: list[Path] | None = None,
    validation: ValidationResult,
    source_summary: dict[str, object],
    output_dir: Path,
) -> DatasetManifest:
    """Assemble the immutable role-based manifest (pure; no manifest file write).

    Writes the deterministic ``schema.json`` artifact (part of the digest
    inputs), computes the package digest over data artifacts, and returns the
    manifest object.  Callers write it exactly once via ``write_manifest`` so
    a crash can never leave a manifest with a stale validation summary.
    """
    schema_path = output_dir / SCHEMA_FILE
    schema_path.write_bytes((
        json.dumps(schema.model_dump(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8"))
    entries = [
        _entry(ArtifactRole.PRIMARY_DATASET, integration.merged_path, output_dir),
        _entry(ArtifactRole.SCHEMA, schema_path, output_dir, media_type="application/json"),
        _entry(ArtifactRole.PROVENANCE, provenance_path, output_dir, media_type="application/json"),
    ]
    entries.extend(
        _entry(ArtifactRole.SUPPORTING_DATASET, path, output_dir)
        for path in sorted(supporting_paths or [])
    )
    entries.extend(
        _entry(ArtifactRole.AUDIT_REPORT, path, output_dir)
        for path in sorted(audit_paths)
    )
    digest = package_digest(entries)
    # Provenance closure statistics: the coverage computation reads the source
    # asset ids from the provenance document (already written by the caller).
    try:
        provenance_document = json.loads(provenance_path.read_text("utf-8"))
        source_asset_ids = {
            str(source.get("asset_id", ""))
            for source in provenance_document.get("sources", [])
            if source.get("asset_id")
        }
    except (OSError, json.JSONDecodeError):
        source_asset_ids = set()
    coverage = compute_provenance_coverage(
        integration.merged_path, source_asset_ids
    )
    return DatasetManifest(
        manifest_id=f"manifest_{digest[:16]}",
        task_id=task_id,
        build_id=build_id,
        dataset_family=spec.dataset_family,
        row_granularity=spec.row_granularity,
        schema_ref=schema.schema_id,
        primary_key=list(schema.primary_key),
        row_count=integration.row_count,
        sha256=digest,
        artifacts=entries,
        source_summary=source_summary,
        validation_summary={
            "profile_ref": validation.profile_ref,
            "status": validation.status.value,
            "checked_count": validation.checked_count,
            "failed_count": validation.failed_count,
            "report_path": validation.report_path,
        },
        confidence_summary=build_confidence_summary(output_dir),
        provenance_summary={
            "source_count": len(source_summary),
            "field_mapping_count": sum(
                len(result.batch.declared_mappings)
                for result in canonical_results
            ),
            "normalization_log_entries": sum(
                result.row_count for result in canonical_results
            ),
            "rejected_count": sum(
                result.rejected_count for result in canonical_results
            ),
            "dedup_count": integration.dedup_count,
            "conflict_count": integration.conflict_count,
            "coverage": coverage,
        },
    )


def write_manifest(manifest: DatasetManifest, output_dir: Path) -> Path:
    """Write ``dataset_manifest.json`` for an assembled manifest."""
    manifest_path = output_dir / MANIFEST_FILE
    manifest_path.write_bytes((
        json.dumps(manifest.model_dump(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8"))
    return manifest_path


def build_manifest(
    *,
    task_id: str,
    build_id: str,
    spec: DatasetBuildSpec,
    schema: DatasetSchema,
    integration: IntegrationResult,
    canonical_results: list[CanonicalizationResult],
    provenance_path: Path,
    audit_paths: list[Path],
    supporting_paths: list[Path] | None = None,
    validation: ValidationResult,
    source_summary: dict[str, object],
    output_dir: Path,
) -> DatasetManifest:
    """Assemble and persist the manifest (convenience wrapper)."""
    manifest = assemble_manifest(
        task_id=task_id,
        build_id=build_id,
        spec=spec,
        schema=schema,
        integration=integration,
        canonical_results=canonical_results,
        provenance_path=provenance_path,
        audit_paths=audit_paths,
        supporting_paths=supporting_paths,
        validation=validation,
        source_summary=source_summary,
        output_dir=output_dir,
    )
    write_manifest(manifest, output_dir)
    return manifest
