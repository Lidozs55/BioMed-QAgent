"""Artifact builder orchestration: assemble and write the staging CSV package.

``run_artifact_build`` is the single entry point that delegates per-CSV row
building to the sibling modules (samples, warnings, relations, catalog,
field_mapping, cleaning) and writes the staging package (TODO §1.2).
"""
from __future__ import annotations

import hashlib
import json
import shutil
from datetime import UTC, datetime
from pathlib import Path

from app.domain.contracts import (
    DownloadAttempt,
    LiteratureRecord,
    ParsedDataset,
    SourceAsset,
    SourceRecord,
    TaskSpecification,
)
from app.domain.contracts.discovery import GeoSeriesRecord
from app.pipeline.processing.geo_tximport import GeoSampleMetadata
from app.pipeline.stages.artifact_build.catalog import (
    _build_dataset_catalog_rows,
    _build_multi_source_manifest_rows,
)
from app.pipeline.stages.artifact_build.cleaning import _build_cleaning_report_rows
from app.pipeline.stages.artifact_build.columns import (
    _ARTIFACT_COLUMNS,
    _MULTI_SOURCE_MANIFEST_COLUMNS,
)
from app.pipeline.stages.artifact_build.field_mapping import (
    _build_field_descriptions_rows,
    _build_field_mapping_rows,
)
from app.pipeline.stages.artifact_build.relations import _build_source_relations
from app.pipeline.stages.artifact_build.samples import _build_sample_metadata_rows
from app.pipeline.stages.artifact_build.warnings import (
    _build_cell_line_warnings,
    _build_warnings_rows,
)
from app.pipeline.stages.base import (
    ArtifactBuildOutput,
    CleaningReportModel,
    StageContext,
    StageResult,
    write_csv,
)


def _is_metadata_only(primary: ParsedDataset) -> bool:
    """True when the primary parsed dataset is a metadata-only fallback.

    The GEO minimal placeholder emits one row per sample with
    ``measurement_type="sample_metadata"`` and no expression values — the
    series_matrix expression block was empty and no supplementary expression
    file was found.
    """
    return primary.parser_name == "geo_minimal_placeholder"


def _build_processing_log_rows(
    *,
    primary: ParsedDataset,
    stage_attempt_id: str,
    all_warnings: list[dict[str, object]],
    ctx: StageContext,
    is_merged: bool,
    all_parsed: list[ParsedDataset],
    source_assets: list[SourceAsset],
) -> list[dict[str, object]]:
    """Build ``processing_log.csv`` rows.

    The primary parse step records the upstream source file as ``input_refs``
    and the parsed long-form CSV as ``output_refs`` (TODO §1.3). When a
    deterministic merge exists a second ``alignment.merge_datasets`` step is
    appended.
    """
    processing_log_warnings = json.dumps(
        [
            {
                "warning_id": row["warning_id"],
                "code": row["code"],
                "message": row["message"],
            }
            for row in all_warnings
        ],
        sort_keys=True,
    )
    processing_log_rows: list[dict[str, object]] = [
        {
            "step_id": asset.generated_by_step_id,
            "stage_attempt_id": stage_attempt_id,
            "stage": "processing",
            "operation": "reactome_json_to_tsv",
            "input_refs": json.dumps([asset.derived_from_asset_id]),
            "output_refs": json.dumps([asset.asset_id]),
            "tool_version": "1.0.0",
            "rows_before": primary.source_row_count,
            "rows_after": primary.source_row_count,
            "parameters": json.dumps(
                {"format": "reactome_participants_json_to_tsv"},
                sort_keys=True,
            ),
            "status": "succeeded",
            "started_at": ctx.started_at.isoformat(),
            "finished_at": datetime.now(UTC).isoformat(),
            "warnings": "[]",
        }
        for asset in source_assets
        if asset.derived_from_asset_id is not None
    ]
    processing_log_rows.extend(
        {
            "step_id": dataset.file_asset.generated_by_step_id,
            "stage_attempt_id": stage_attempt_id,
            "stage": "processing",
            "operation": dataset.parser_name,
            "input_refs": json.dumps([dataset.source_asset_id]),
            "output_refs": json.dumps([dataset.file_asset.asset_id]),
            "tool_version": dataset.parser_version,
            "rows_before": dataset.source_row_count,
            "rows_after": dataset.row_count,
            "parameters": json.dumps(dataset.processing_parameters, sort_keys=True),
            "status": "succeeded",
            "started_at": ctx.started_at.isoformat(),
            "finished_at": datetime.now(UTC).isoformat(),
            "warnings": "[]" if is_merged else processing_log_warnings,
        }
        for dataset in all_parsed
    )
    if is_merged:
        processing_log_rows.append(
            {
                "step_id": primary.file_asset.generated_by_step_id,
                "stage_attempt_id": stage_attempt_id,
                "stage": "processing",
                "operation": "alignment.merge_datasets",
                "input_refs": json.dumps(
                    [dataset.file_asset.asset_id for dataset in all_parsed]
                ),
                "output_refs": json.dumps([primary.file_asset.asset_id]),
                "tool_version": "0.1.0",
                "rows_before": sum(
                    dataset.row_count for dataset in all_parsed
                ),
                "rows_after": primary.row_count,
                "parameters": json.dumps(
                    {
                        "input_datasets": [
                            dataset.dataset_id for dataset in all_parsed
                        ],
                        "merged_dataset_id": primary.dataset_id,
                    },
                    sort_keys=True,
                ),
                "status": "succeeded",
                "started_at": ctx.started_at.isoformat(),
                "finished_at": datetime.now(UTC).isoformat(),
                "warnings": processing_log_warnings,
            }
        )
    return processing_log_rows


def _compute_package_digest(staging: Path) -> str:
    """Compute a content-hash digest from all staging files (sorted by name).

    Using only directory size would cause collisions between packages with
    identical byte counts but different content; the combined content hash
    avoids that.
    """
    hasher = hashlib.sha256()
    for path in sorted(staging.iterdir(), key=lambda p: p.name):
        if path.is_file():
            rel = path.relative_to(staging).as_posix()
            file_hash = hashlib.sha256(path.read_bytes()).hexdigest()
            hasher.update(rel.encode("utf-8"))
            hasher.update(b"\0")
            hasher.update(file_hash.encode("utf-8"))
            hasher.update(b"\0")
    return hasher.hexdigest()


def run_artifact_build(
    ctx: StageContext,
    sources: list[SourceRecord],
    source_assets: list[SourceAsset],
    download_attempts: list[DownloadAttempt],
    parsed_dataset: ParsedDataset,
    samples: list[GeoSampleMetadata],
    literature: LiteratureRecord | None,
    geo: GeoSeriesRecord | None,
    specification: TaskSpecification,
    retrieved_at: datetime,
    stage_attempt_id: str,
    cleaning_report: CleaningReportModel | None = None,
    field_alignment: dict[str, list[str]] | None = None,
    parsed_datasets: list[ParsedDataset] | None = None,
    merged_dataset: ParsedDataset | None = None,
    dataset_source_id: str | None = None,
    dataset_accession: str | None = None,
    dataset_title: str | None = None,
    dataset_url: str | None = None,
    dataset_id: str | None = None,
) -> StageResult:
    """Build the staging CSV package from upstream stage outputs.

    Writes all CSVs except ``quality_report.csv`` (which is written by the
    validation stage). Returns the staging directory and artifact paths.

    ``parsed_datasets`` carries every parsed dataset produced by processing;
    when a deterministic multi-source merge exists (TODO §1.2) it is passed
    as ``merged_dataset`` and becomes the ``main_data.csv`` source instead of
    the first parsed dataset.
    """
    staging = ctx.workdir.staging_run(ctx.run_id)
    if any(staging.iterdir()):
        shutil.rmtree(staging)
        staging.mkdir(parents=True)

    all_parsed = parsed_datasets if parsed_datasets else [parsed_dataset]
    primary = merged_dataset if merged_dataset is not None else parsed_dataset
    parsed_path = ctx.workdir.root / primary.file_asset.relative_path
    if not parsed_path.is_file():
        raise FileNotFoundError(f"Parsed dataset not found: {parsed_path}")
    is_reactome = primary.parser_name == "reactome_pathway_participants"
    is_merged = merged_dataset is not None
    main_name = "pathway_members.csv" if is_reactome else "main_data.csv"
    shutil.copy2(parsed_path, staging / main_name)

    pubmed_source_id = next(
        (s.source_id for s in sources if s.database.value == "pubmed"), None
    )
    geo_source_id = next(
        (s.source_id for s in sources if s.database.value == "geo"), None
    )
    geo_url = dataset_url or (
        f"https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc={geo.accession}"
        if geo else ""
    )
    dataset_id = dataset_id or specification.datasets[0].dataset_id
    dataset_source_id = dataset_source_id or geo_source_id or sources[0].source_id
    dataset_url = dataset_url or geo_url
    primary_source_id = dataset_source_id
    dataset_url_value = dataset_url
    dataset_accession = dataset_accession or (
        geo.accession if geo else specification.datasets[0].accession
    )
    dataset_title = dataset_title or (geo.title if geo else dataset_accession)
    source_asset = next(
        (
            asset for asset in source_assets
            if is_reactome and asset.media_type == "text/tab-separated-values"
        ),
        source_assets[0],
    )

    # Build cell-line normalization warnings (TODO §1.7). Each sample whose
    # cell_line_raw was canonicalized produces one warning row.
    cell_line_warnings = [] if is_reactome else _build_cell_line_warnings(
        samples=samples,
        geo_source_id=geo_source_id or primary_source_id,
        asset_id=source_asset.asset_id,
        retrieved_at=retrieved_at,
    )
    # Merge cleaning anomalies into the warnings list so
    # warnings_metrics_consistency validation stays satisfied.
    all_warnings = _build_warnings_rows(
        cell_line_warnings=cell_line_warnings,
        cleaning_report=cleaning_report,
        geo_source_id=geo_source_id,
        asset_id=source_asset.asset_id,
        retrieved_at=retrieved_at,
    )
    # A metadata-only package has no downloadable expression data (empty
    # series_matrix block and no supplementary expression file). Surface a
    # warning so the Agent sees why the artifact is metadata-only and can
    # switch datasets instead of retrying the same download. The warning is
    # folded into processing_log by _build_processing_log_rows, keeping
    # warnings_metrics_consistency satisfied. (GSE339404 regression, 0805.)
    if _is_metadata_only(primary):
        all_warnings.append(
            {
                "warning_id": "warn_no_expression_data",
                "severity": "warning",
                "stage": "processing",
                "code": "no_expression_data",
                "message": (
                    f"{dataset_accession} series_matrix 表达块为空且未找到 "
                    "supplementary 表达文件，产物仅含样本元数据；如需表达数据 "
                    "请更换数据集或检查数据集相关性"
                ),
                "source_id": geo_source_id or primary_source_id,
                "asset_id": source_asset.asset_id,
                "record_id": "",
                "created_at": retrieved_at.isoformat(),
            }
        )

    sample_rows = _build_sample_metadata_rows(
        samples=samples,
        dataset_id=dataset_id,
        primary_source_id=primary_source_id,
        geo_url=geo_url,
        is_reactome=is_reactome,
        parsed_path=parsed_path,
        dataset_url_value=dataset_url_value,
    )
    field_descriptions = _build_field_descriptions_rows(primary)
    processing_log_rows = _build_processing_log_rows(
        primary=primary,
        stage_attempt_id=stage_attempt_id,
        all_warnings=all_warnings,
        ctx=ctx,
        is_merged=is_merged,
        all_parsed=all_parsed,
        source_assets=source_assets,
    )

    rows_by_file: dict[str, list[dict[str, object]]] = {
        "literature.csv": [] if is_reactome else [
            {
                "source_id": pubmed_source_id or "",
                "pmid": literature.pmid if literature else "",
                "pmcid": literature.pmcid if literature else "",
                "doi": literature.doi if literature else "",
                "title": literature.title if literature else "",
                "authors": json.dumps(literature.authors if literature else []),
                "journal": literature.journal if literature else "",
                "published_at": literature.published_at.isoformat()
                if literature and literature.published_at
                else "",
                "source_url": literature.source_url if literature else "",
                "retrieved_at": retrieved_at.isoformat(),
            }
        ],
        "dataset_catalog.csv": _build_dataset_catalog_rows(
            is_merged=is_merged,
            all_parsed=all_parsed,
            specification=specification,
            dataset_id=dataset_id,
            primary_source_id=primary_source_id,
            dataset_accession=dataset_accession,
            dataset_title=dataset_title,
            geo=geo,
            is_reactome=is_reactome,
            dataset_url_value=dataset_url_value,
            retrieved_at=retrieved_at,
            workdir_root=ctx.workdir.root,
            parsed_path=parsed_path,
            sources=sources,
        ),
        "sample_metadata.csv": [] if is_reactome else sample_rows,
        "field_descriptions.csv": field_descriptions,
        "field_mapping.csv": _build_field_mapping_rows(
            dataset_id=dataset_id,
            source_id=dataset_source_id,
            field_alignment=field_alignment,
            samples=samples,
            parsed_datasets=all_parsed if len(all_parsed) > 1 else None,
        ),
        "cleaning_report.csv": _build_cleaning_report_rows(cleaning_report),
        "source_list.csv": [
            record.model_dump(mode="json", exclude={"schema_version"})
            for record in sources
        ],
        "source_relations.csv": [] if is_reactome else _build_source_relations(
            sources=sources,
            literature=literature,
            geo=geo,
            geo_url=geo_url,
        ) if literature is not None and geo is not None else [],
        "source_assets.csv": [
            {
                "asset_id": asset.asset_id,
                "source_id": asset.source_id,
                "successful_attempt_id": asset.successful_attempt_id or "",
                "derived_from_asset_id": asset.derived_from_asset_id or "",
                "data_level": asset.data_level.value,
                "relative_path": asset.relative_path,
                "size_bytes": asset.size_bytes,
                "sha256": asset.sha256,
                "media_type": asset.media_type,
                "schema_version": asset.schema_version,
            }
            for asset in source_assets
        ],
        "download_log.csv": [
            {
                "attempt_id": attempt.attempt_id,
                "source_id": attempt.source_id,
                "url": attempt.url,
                "status": attempt.status.value,
                "bytes_received": attempt.bytes_received,
                "error_code": (
                    attempt.error_code.value
                    if attempt.error_code is not None
                    else ""
                ),
                "error_message": attempt.error_message or "",
                "started_at": attempt.started_at.isoformat(),
                "finished_at": attempt.finished_at.isoformat(),
            }
            for attempt in download_attempts
        ],
        "processing_log.csv": processing_log_rows,
        "warnings.csv": all_warnings,
    }

    for name, columns in _ARTIFACT_COLUMNS.items():
        write_csv(staging / name, columns, rows_by_file.get(name, []))

    # Multi-source manifest (TODO §1.5.4): produced only when a deterministic
    # multi-source merge exists, so single-source runs keep the historic
    # artifact set unchanged.
    if is_merged:
        write_csv(
            staging / "multi_source_manifest.csv",
            _MULTI_SOURCE_MANIFEST_COLUMNS,
            _build_multi_source_manifest_rows(all_parsed, specification),
        )
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
        dataset_source_id=dataset_source_id,
        dataset_accession=dataset_accession,
        dataset_title=dataset_title,
        dataset_url=dataset_url,
        dataset_id=dataset_id,
        specification=specification,
        sources=sources,
        parsed_datasets=[],
        samples=samples,
        download_attempts=download_attempts,
        retrieved_at=retrieved_at,
        started_at=ctx.started_at,
    )

    digest = _compute_package_digest(staging)
    return StageResult(output_digest=digest, output=output)
