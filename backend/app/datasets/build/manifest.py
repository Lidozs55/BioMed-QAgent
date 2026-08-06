"""Role-based DatasetManifest V2 builder (ARCHITECTURE §3.6-3.7).

The manifest is the only authoritative entry point for locating the primary
dataset and its supporting artifacts — programs never hard-code filenames.
Manifest digest is computed over the data artifacts (primary, schema,
provenance, audits) so it is stable and independent of the manifest JSON
itself and of the validation report.
"""

from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path

from app.datasets.build.canonicalizer import CanonicalizationResult
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
    return hashlib.sha256(path.read_bytes()).hexdigest()


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
    return ManifestArtifactEntry(
        artifact_id=f"artifact_{checksum[:32]}",
        role=role,
        relative_path=path.relative_to(output_dir).as_posix(),
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
            }
            for binding_id, asset in sorted(source_assets.items())
        ],
        "field_mappings": mappings,
        "normalization_rules": normalization_rules,
        "merge_strategy": integration.batch.statistics.get("merge_strategy"),
        "sample_backtraces": _sample_backtraces(integration.merged_path),
    }
    path = output_dir / PROVENANCE_FILE
    path.write_text(
        json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        "utf-8",
    )
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
    validation: ValidationResult,
    source_summary: dict[str, object],
    output_dir: Path,
) -> DatasetManifest:
    """Build the immutable role-based manifest and write dataset_manifest.json."""
    schema_path = output_dir / SCHEMA_FILE
    schema_path.write_text(
        json.dumps(schema.model_dump(), ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        "utf-8",
    )
    entries = [
        _entry(ArtifactRole.PRIMARY_DATASET, integration.merged_path, output_dir),
        _entry(ArtifactRole.SCHEMA, schema_path, output_dir, media_type="application/json"),
        _entry(ArtifactRole.PROVENANCE, provenance_path, output_dir, media_type="application/json"),
    ]
    entries.extend(
        _entry(ArtifactRole.AUDIT_REPORT, path, output_dir)
        for path in sorted(audit_paths)
    )
    digest = package_digest(entries)
    manifest = DatasetManifest(
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
        confidence_summary={},
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
        },
    )
    manifest_path = output_dir / MANIFEST_FILE
    manifest_path.write_text(
        json.dumps(manifest.model_dump(), ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        "utf-8",
    )
    return manifest
