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


def _write_csv(path: Path, columns: list[str], rows: list[dict[str, object]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
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
                "data_type": "string",
                "description": field.replace("_", " "),
                "unit": "estimated_count" if field == "expression_value" else "",
                "nullable": "true" if field == "gene_id_version" else "false",
                "source": "GSE178352_tximportCounts.txt",
                "example": "",
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
                "warnings": "[]",
            }
        ],
        "warnings.csv": [],
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
