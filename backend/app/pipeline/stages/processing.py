"""Processing stage: parse GEO tximport counts into ParsedDataset."""
from __future__ import annotations

import hashlib
import logging

from app.domain.contracts import ParsedDataset, SourceAsset, StageName
from app.pipeline.processing.geo_tximport import (
    _OUTPUT_COLUMNS,
    GeoSampleMetadata,
    parse_geo_series_matrix_samples,
    parse_geo_soft_samples,
    process_geo_tximport_counts,
)
from app.pipeline.stages.base import ProcessingOutput, StageContext, StageResult

logger = logging.getLogger(__name__)


def _build_minimal_parsed_dataset(
    source_asset: SourceAsset,
    dataset_id: str,
    ctx: StageContext,
    samples: list[GeoSampleMetadata] | None = None,
) -> ParsedDataset:
    """Produce a ParsedDataset for cases where tximport parsing fails.

    When ``samples`` is provided (e.g. recovered from a series_matrix file
    whose expression block is empty), one row per sample is written with
    ``measurement_type="sample_metadata"`` so that ``main_data.csv`` always
    carries the per-sample metadata even when no expression matrix is
    available. Expression-related fields (``gene_id_raw``, ``expression_value``,
    etc.) are left blank, and ``source_line_number``/``source_column_index``
    are set to ``0`` to signal "no source locator" — the validation gate
    skips lineage checks for these rows.

    When ``samples`` is empty or None, the file is schema-only (0 rows) for
    backward compatibility with callers that have no sample metadata to
    recover (e.g. fixture-mode tests that don't exercise live mode).
    """
    import csv

    from app.domain.contracts import FileAsset, asset_id_from_sha256, make_record_id

    output_path = ctx.workdir.parsed / f"{dataset_id}_tximport_long.csv"
    row_count = 0
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=_OUTPUT_COLUMNS)
        writer.writeheader()
        if samples:
            for sample in samples:
                writer.writerow({
                    "record_id": make_record_id(
                        dataset_id, "sample_metadata", sample.sample_id
                    ),
                    "dataset_id": dataset_id,
                    "source_id": source_asset.source_id,
                    "asset_id": source_asset.asset_id,
                    "gene_id_raw": "",
                    "gene_id": "",
                    "gene_id_namespace": "",
                    "gene_id_version": "",
                    "sample_id": sample.sample_id,
                    "source_sample_alias": sample.source_alias,
                    "measurement_type": "sample_metadata",
                    "value_semantics": "metadata_only",
                    "value_scale": "na",
                    "is_normalized": "false",
                    "is_integer_expected": "false",
                    "expression_value": "",
                    "expression_unit": "na",
                    "source_logical_file": "series_matrix_metadata",
                    "source_line_number": 0,
                    "source_column_index": 0,
                    "source_column_name": "sample_metadata",
                    "source_raw_value": "",
                })
                row_count += 1
    file_bytes = output_path.read_bytes()
    checksum = hashlib.sha256(file_bytes).hexdigest()
    file_asset = FileAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="parsed",
        relative_path=output_path.relative_to(ctx.workdir.root).as_posix(),
        sha256=checksum,
        size_bytes=len(file_bytes),
        media_type="text/csv",
        generated_by_step_id="step_geo_minimal_v1",
    )
    return ParsedDataset(
        dataset_id=dataset_id,
        source_id=source_asset.source_id,
        source_asset_id=source_asset.asset_id,
        file_asset=file_asset,
        columns=list(_OUTPUT_COLUMNS),
        row_count=row_count,
        parser_name="geo_minimal_placeholder",
        parser_version="1.0.0",
    )


def _recover_samples_from_series_matrix(
    source_asset: SourceAsset,
    ctx: StageContext,
) -> list[GeoSampleMetadata]:
    """Try to parse the downloaded series_matrix file for sample metadata.

    Returns an empty list when the downloaded file is not a series_matrix
    (e.g. fixture mode) or when parsing fails. The caller (``run_processing``)
    uses the result to populate ``sample_metadata.csv`` even when the
    expression-matrix block is empty.
    """
    source_path = ctx.workdir.root / source_asset.relative_path
    if not source_path.is_file():
        logger.warning("processing: source asset not found at %s", source_path)
        return []
    try:
        compressed = source_path.read_bytes()
    except OSError as exc:
        logger.warning("processing: cannot read source asset: %s", exc)
        return []
    try:
        return parse_geo_series_matrix_samples(compressed)
    except (ValueError, OSError) as exc:
        logger.warning(
            "processing: series_matrix sample recovery failed: %s", exc
        )
        return []


def run_processing(
    ctx: StageContext,
    source_asset: SourceAsset,
    dataset_id: str,
) -> StageResult:
    """Parse the GEO tximport counts file into a long-form ParsedDataset.

    In fixture mode, reads the fixture SOFT file for sample metadata. In live
    mode with arbitrary GEO series, the tximport counts format may not be
    available — in that case we attempt to recover per-sample metadata from
    the downloaded ``series_matrix.txt.gz`` so both ``sample_metadata.csv``
    and ``main_data.csv`` are populated. ``main_data.csv`` will contain one
    ``measurement_type="sample_metadata"`` row per sample when the
    series_matrix's expression-matrix block is empty (the norm for modern
    snRNAseq/RNA-seq series), so users always see real data in main_data.csv
    regardless of the GEO series type.
    """
    samples: list[GeoSampleMetadata] = []
    parsed: ParsedDataset
    try:
        parsed = process_geo_tximport_counts(
            source_asset=source_asset,
            dataset_id=dataset_id,
            workdir=ctx.workdir,
            soft_gzip=(ctx.fixture_dir / "gse178352_family.soft.gz").read_bytes(),
            logical_file="GSE178352_tximportCounts.txt",
        )
        samples = parse_geo_soft_samples(
            (ctx.fixture_dir / "gse178352_family.soft.gz").read_bytes()
        )
        logger.info(
            "processing: parsed tximport counts (%d rows, %d samples)",
            parsed.row_count,
            len(samples),
        )
    except (ValueError, FileNotFoundError, OSError) as exc:
        # Live mode with a non-tximport file (e.g. series_matrix.txt.gz):
        # recover per-sample metadata and write one sample_metadata row per
        # sample into main_data.csv so it always carries real data even when
        # the series_matrix expression block is empty.
        logger.warning(
            "processing: tximport parse failed (%s); attempting series_matrix "
            "sample recovery",
            exc,
        )
        samples = _recover_samples_from_series_matrix(source_asset, ctx)
        parsed = _build_minimal_parsed_dataset(
            source_asset, dataset_id, ctx, samples=samples
        )
        if samples:
            logger.info(
                "processing: recovered %d samples from series_matrix; "
                "main_data.csv will contain %d sample_metadata rows "
                "(expression block is empty)",
                len(samples),
                parsed.row_count,
            )
        else:
            logger.warning(
                "processing: series_matrix recovery yielded no samples; "
                "main_data.csv will be schema-only (0 rows)"
            )

    # Surface processing progress: "Processing: cleaned N rows".
    # See docs/REVIEW_2026-07-18.md §4.
    ctx.emit_progress_sync(
        stage=StageName.PROCESSING,
        kind="cleaned_rows",
        current=parsed.row_count,
        total=None,
        detail={
            "dataset_id": parsed.dataset_id,
            "file_asset": parsed.file_asset.relative_path,
        },
    )

    output = ProcessingOutput(parsed_datasets=[parsed], samples=samples)
    digest = hashlib.sha256(parsed.file_asset.sha256.encode("utf-8")).hexdigest()
    return StageResult(output_digest=digest, output=output)
