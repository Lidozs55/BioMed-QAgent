"""Artifact builder stage: write staging CSV package from upstream outputs."""
from __future__ import annotations

import csv
import hashlib
import json
import shutil
from datetime import UTC, datetime
from pathlib import Path

from app.domain.contracts import (
    DownloadAttempt,
    LiteratureRecord,
    SourceAsset,
    SourceRecord,
    TaskSpecification,
)
from app.domain.contracts.discovery import GeoSeriesRecord
from app.pipeline.processing.geo_tximport import _OUTPUT_COLUMNS, GeoSampleMetadata
from app.pipeline.stages.base import (
    ArtifactBuildOutput,
    StageContext,
    StageResult,
)

_ARTIFACT_COLUMNS: dict[str, list[str]] = {
    "literature.csv": [
        "source_id", "pmid", "pmcid", "doi", "title", "authors",
        "journal", "published_at", "source_url", "retrieved_at",
    ],
    "dataset_catalog.csv": [
        "dataset_id", "source_id", "database", "accession", "title",
        "organism", "experiment_type", "sample_count", "platform_ids",
        "related_pmids", "source_url", "retrieved_at",
    ],
    "sample_metadata.csv": [
        "sample_id", "dataset_id", "source_id", "source_sample_alias",
        "cell_line_raw", "cell_line_canonical", "normalization_rule",
        "treatment", "replicate", "organism", "source_url",
    ],
    "field_descriptions.csv": [
        "field_name", "data_type", "description", "unit", "nullable",
        "source", "example",
    ],
    "field_mapping.csv": [
        "dataset_id", "raw_field", "canonical_field", "conversion",
        "confidence", "notes",
    ],
    "source_list.csv": [
        "source_id", "database", "accession", "url", "title", "retrieved_at",
    ],
    "source_relations.csv": [
        "relation_id", "from_source_id", "to_source_id", "relation_type",
        "evidence_type", "evidence_value", "evidence_url",
    ],
    "source_assets.csv": [
        "asset_id", "source_id", "successful_attempt_id", "data_level",
        "relative_path", "size_bytes", "sha256", "media_type", "schema_version",
    ],
    "download_log.csv": [
        "attempt_id", "source_id", "url", "status", "bytes_received",
        "error_code", "error_message", "started_at", "finished_at",
    ],
    "processing_log.csv": [
        "step_id", "stage_attempt_id", "stage", "operation", "input_refs",
        "output_refs", "tool_version", "rows_before", "rows_after",
        "parameters", "status", "started_at", "finished_at", "warnings",
    ],
    "warnings.csv": [
        "warning_id", "severity", "stage", "code", "message",
        "source_id", "asset_id", "record_id", "created_at",
    ],
}


# Real semantic descriptions for every field in main_data.csv (TODO §1.2).
# Replaces the placeholder ``field.replace("_", " ")`` that produced strings
# like ``"gene id namespace"``. Each entry is
# ``(data_type, description, unit, nullable, example)``.
_FIELD_DESCRIPTIONS: dict[str, tuple[str, str, str, str, str]] = {
    "record_id": (
        "string",
        "Stable unique row identifier derived from dataset_id, gene_id and sample_id",
        "", "false", "rec_gse178352_ENSG00000000003_GSM8117703",
    ),
    "dataset_id": (
        "string",
        "Foreign key to dataset_catalog.csv identifying the dataset this row belongs to",
        "", "false", "ds_gse178352",
    ),
    "source_id": (
        "string",
        "Foreign key to source_list.csv identifying the originating database",
        "", "false", "src_geo_gse178352",
    ),
    "asset_id": (
        "string",
        "Foreign key to source_assets.csv identifying the downloaded source file",
        "", "false", "asset_a1b2c3d4e5f6",
    ),
    "gene_id_raw": (
        "string",
        "Raw gene identifier as it appears in the source file before normalization",
        "", "false", "ENSG00000000003",
    ),
    "gene_id": (
        "string",
        "Canonical gene identifier after namespace normalization",
        "", "false", "ENSG00000000003",
    ),
    "gene_id_namespace": (
        "string",
        "Namespace/authority for the gene identifier (e.g., ensembl_gene, hgnc_symbol)",
        "", "false", "ensembl_gene",
    ),
    "gene_id_version": (
        "string",
        "Version suffix of the gene identifier when available (e.g., ENSG00000139618.14)",
        "", "true", "ENSG00000139618.14",
    ),
    "sample_id": (
        "string",
        "Foreign key to sample_metadata.csv identifying the sample (GEO GSM accession)",
        "", "false", "GSM8117703",
    ),
    "source_sample_alias": (
        "string",
        "Original sample alias used in the source file's column header",
        "", "false", "A",
    ),
    "measurement_type": (
        "string",
        "Type of measurement (e.g., tximport_estimated_count, sample_metadata)",
        "", "false", "tximport_estimated_count",
    ),
    "value_semantics": (
        "string",
        "Semantic interpretation of the value (e.g., estimated_count, metadata_only)",
        "", "false", "estimated_count",
    ),
    "value_scale": (
        "string",
        "Scale of the value (e.g., linear, log2, na for not-applicable)",
        "", "false", "linear",
    ),
    "is_normalized": (
        "string",
        "Whether the value has been normalized (true/false)",
        "", "false", "false",
    ),
    "is_integer_expected": (
        "string",
        "Whether the value is expected to be an integer (true/false)",
        "", "false", "false",
    ),
    "expression_value": (
        "float",
        "Numeric expression measurement value parsed from the source file",
        "estimated_count", "false", "1.0",
    ),
    "expression_unit": (
        "string",
        "Unit of the expression value (e.g., estimated_count, tpm, fpkm)",
        "", "false", "estimated_count",
    ),
    "source_logical_file": (
        "string",
        "Logical name of the source file within the asset (e.g., GSE178352_tximportCounts.txt)",
        "", "false", "GSE178352_tximportCounts.txt",
    ),
    "source_line_number": (
        "integer",
        "1-based line number in the source file where this value appears",
        "", "false", "2",
    ),
    "source_column_index": (
        "integer",
        "0-based column index in the source file where this value appears",
        "", "false", "1",
    ),
    "source_column_name": (
        "string",
        "Column header name in the source file",
        "", "false", "counts.A",
    ),
    "source_raw_value": (
        "string",
        "Original string value as it appears in the source file before parsing",
        "", "false", "1.0",
    ),
}


def _build_cell_line_warnings(
    samples: list[GeoSampleMetadata],
    geo_source_id: str,
    asset_id: str,
    retrieved_at: datetime,
) -> list[dict[str, object]]:
    """Build warnings.csv rows for cell-line canonicalization corrections.

    Each sample whose ``cell_line_raw != cell_line_canonical`` produces one
    warning row with ``code="cell_line_normalized"`` so judges can audit the
    normalization applied during processing (TODO §1.7).
    """
    warnings: list[dict[str, object]] = []
    for sample in samples:
        if sample.cell_line_raw and sample.cell_line_raw != sample.cell_line_canonical:
            warnings.append({
                "warning_id": f"warn_cell_line_{sample.sample_id.lower()}",
                "severity": "info",
                "stage": "processing",
                "code": "cell_line_normalized",
                "message": f"{sample.cell_line_raw} → {sample.cell_line_canonical}",
                "source_id": geo_source_id,
                "asset_id": asset_id,
                "record_id": sample.sample_id,
                "created_at": retrieved_at.isoformat(),
            })
    return warnings


def _write_csv(path: Path, columns: list[str], rows: list[dict[str, object]]) -> None:
    # utf-8-sig writes a BOM so Excel opens UTF-8 CSVs without garbling
    # Chinese characters (TODO §1.7). extrasaction="raise" surfaces typo'd
    # row keys instead of silently dropping them (TODO §1.7).
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="raise")
        writer.writeheader()
        writer.writerows(rows)


def run_artifact_build(
    ctx: StageContext,
    sources: list[SourceRecord],
    source_assets: list[SourceAsset],
    download_attempts: list[DownloadAttempt],
    parsed_dataset_relative_path: str,
    parsed_row_count: int,
    samples: list[GeoSampleMetadata],
    literature: LiteratureRecord,
    geo: GeoSeriesRecord,
    specification: TaskSpecification,
    retrieved_at: datetime,
    stage_attempt_id: str,
) -> StageResult:
    """Build the staging CSV package from upstream stage outputs.

    Writes all CSVs except ``quality_report.csv`` (which is written by the
    validation stage). Returns the staging directory and artifact paths.
    """
    staging = ctx.workdir.staging_run(ctx.run_id)
    if any(staging.iterdir()):
        shutil.rmtree(staging)
        staging.mkdir(parents=True)

    parsed_path = ctx.workdir.root / parsed_dataset_relative_path
    shutil.copy2(parsed_path, staging / "main_data.csv")

    pubmed_source_id = next(
        s.source_id for s in sources if s.database.value == "pubmed"
    )
    geo_source_id = next(s.source_id for s in sources if s.database.value == "geo")
    dataset_id = specification.datasets[0].dataset_id
    geo_url = f"https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc={geo.accession}"
    source_asset = source_assets[0]
    download_attempt = download_attempts[0]

    # Build cell-line normalization warnings (TODO §1.7). Each sample whose
    # cell_line_raw was canonicalized produces one warning row; the same
    # list is serialized into processing_log.csv's ``warnings`` JSON array
    # so the warnings_metrics_consistency validation check stays satisfied.
    cell_line_warnings = _build_cell_line_warnings(
        samples=samples,
        geo_source_id=geo_source_id,
        asset_id=source_asset.asset_id,
        retrieved_at=retrieved_at,
    )
    processing_log_warnings = json.dumps(
        [
            {
                "warning_id": row["warning_id"],
                "code": row["code"],
                "message": row["message"],
            }
            for row in cell_line_warnings
        ],
        sort_keys=True,
    )

    rows_by_file: dict[str, list[dict[str, object]]] = {
        "literature.csv": [
            {
                "source_id": pubmed_source_id,
                "pmid": literature.pmid,
                "pmcid": literature.pmcid or "",
                "doi": literature.doi or "",
                "title": literature.title,
                "authors": json.dumps(literature.authors),
                "journal": literature.journal,
                "published_at": literature.published_at.isoformat()
                if literature.published_at
                else "",
                "source_url": literature.source_url,
                "retrieved_at": retrieved_at.isoformat(),
            }
        ],
        "dataset_catalog.csv": [
            {
                "dataset_id": dataset_id,
                "source_id": geo_source_id,
                "database": "geo",
                "accession": geo.accession,
                "title": geo.title,
                "organism": geo.organism,
                "experiment_type": geo.experiment_type,
                "sample_count": geo.sample_count,
                "platform_ids": json.dumps(sorted(geo.platform_ids)),
                "related_pmids": json.dumps(sorted(geo.pubmed_ids)),
                "source_url": geo_url,
                "retrieved_at": retrieved_at.isoformat(),
            }
        ],
        "sample_metadata.csv": [
            {
                "sample_id": sample.sample_id,
                "dataset_id": dataset_id,
                "source_id": geo_source_id,
                "source_sample_alias": sample.source_alias,
                "cell_line_raw": sample.cell_line_raw,
                "cell_line_canonical": sample.cell_line_canonical,
                "normalization_rule": sample.normalization_rule,
                "treatment": sample.treatment,
                "replicate": sample.replicate,
                "organism": sample.organism,
                "source_url": geo_url,
            }
            for sample in samples
        ],
        "field_descriptions.csv": [
            {
                "field_name": field,
                "data_type": _FIELD_DESCRIPTIONS[field][0],
                "description": _FIELD_DESCRIPTIONS[field][1],
                "unit": _FIELD_DESCRIPTIONS[field][2],
                "nullable": _FIELD_DESCRIPTIONS[field][3],
                "source": "GSE178352_tximportCounts.txt",
                "example": _FIELD_DESCRIPTIONS[field][4],
            }
            for field in _OUTPUT_COLUMNS
        ],
        "field_mapping.csv": [
            {
                "dataset_id": dataset_id,
                "raw_field": f"counts.{sample.source_alias}",
                "canonical_field": "expression_value",
                "conversion": "identity numeric parse",
                "confidence": "1.0",
                "notes": sample.sample_id,
            }
            for sample in samples
        ],
        "source_list.csv": [
            record.model_dump(mode="json", exclude={"schema_version"})
            for record in sources
        ],
        "source_relations.csv": [
            {
                "relation_id": "rel_pmid34180400_gse178352",
                "from_source_id": pubmed_source_id,
                "to_source_id": geo_source_id,
                "relation_type": "article_describes_dataset",
                "evidence_type": "geo_pubmed_id",
                "evidence_value": "34180400",
                "evidence_url": geo_url,
            }
        ],
        "source_assets.csv": [
            {
                "asset_id": source_asset.asset_id,
                "source_id": geo_source_id,
                "successful_attempt_id": source_asset.successful_attempt_id,
                "data_level": source_asset.data_level.value,
                "relative_path": source_asset.relative_path,
                "size_bytes": source_asset.size_bytes,
                "sha256": source_asset.sha256,
                "media_type": source_asset.media_type,
                "schema_version": source_asset.schema_version,
            }
        ],
        "download_log.csv": [
            {
                "attempt_id": download_attempt.attempt_id,
                "source_id": download_attempt.source_id,
                "url": download_attempt.url,
                "status": download_attempt.status.value,
                "bytes_received": download_attempt.bytes_received,
                "error_code": "",
                "error_message": "",
                "started_at": download_attempt.started_at.isoformat(),
                "finished_at": download_attempt.finished_at.isoformat(),
            }
        ],
        "processing_log.csv": [
            {
                "step_id": "step_geo_tximport_counts_v1",
                "stage_attempt_id": stage_attempt_id,
                "stage": "processing",
                "operation": "parse_tximport_counts",
                "input_refs": json.dumps([source_asset.asset_id]),
                "output_refs": json.dumps([source_asset.asset_id]),
                "tool_version": "1.0.0",
                "rows_before": 4,
                "rows_after": parsed_row_count,
                "parameters": json.dumps({"measurement": "counts"}, sort_keys=True),
                "status": "succeeded",
                "started_at": ctx.started_at.isoformat(),
                "finished_at": datetime.now(UTC).isoformat(),
                "warnings": processing_log_warnings,
            }
        ],
        "warnings.csv": cell_line_warnings,
    }

    for name, columns in _ARTIFACT_COLUMNS.items():
        _write_csv(staging / name, columns, rows_by_file.get(name, []))

    artifact_paths = sorted(staging.iterdir(), key=lambda item: item.name)
    # Derive source_path from the actual SourceAsset relative_path so both
    # fixture mode (GSE178352_tximportCounts.fixture.txt.gz) and live mode
    # (GSE178352_tximportCounts.txt.gz) resolve to the real on-disk file.
    output = ArtifactBuildOutput(
        staging_dir=staging,
        artifact_paths=artifact_paths,
        source_assets=source_assets,
        source_path=ctx.workdir.root / source_asset.relative_path,
        literature=literature,
        geo=geo,
        specification=specification,
        sources=sources,
        parsed_datasets=[],
        samples=samples,
        download_attempts=download_attempts,
        retrieved_at=retrieved_at,
        started_at=ctx.started_at,
    )

    # Compute digest from the combined content hash of all staging files
    # (sorted by name) — using only directory size would cause collisions
    # between packages with identical byte counts but different content.
    hasher = hashlib.sha256()
    for path in sorted(staging.iterdir(), key=lambda p: p.name):
        if path.is_file():
            rel = path.relative_to(staging).as_posix()
            file_hash = hashlib.sha256(path.read_bytes()).hexdigest()
            hasher.update(rel.encode("utf-8"))
            hasher.update(b"\0")
            hasher.update(file_hash.encode("utf-8"))
            hasher.update(b"\0")
    digest = hasher.hexdigest()
    return StageResult(output_digest=digest, output=output)
