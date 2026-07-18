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
) -> ParsedDataset:
    """Produce a schema-only ParsedDataset (0 rows) when tximport parsing fails.

    This keeps the pipeline producing a valid artifact package (literature,
    dataset catalog, source list) even when the downloaded GEO file is not in
    the tximport counts format. main_data.csv will contain only headers.
    """
    import csv

    from app.domain.contracts import FileAsset, asset_id_from_sha256

    output_path = ctx.workdir.parsed / f"{dataset_id}_tximport_long.csv"
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=_OUTPUT_COLUMNS)
        writer.writeheader()
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
        row_count=0,
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
    the downloaded ``series_matrix.txt.gz`` so ``sample_metadata.csv`` is
    still populated. ``main_data.csv`` will be schema-only (0 rows) when the
    series_matrix's expression-matrix block is empty, which is the norm for
    modern snRNAseq/RNA-seq series.
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
        # try to recover per-sample metadata so sample_metadata.csv still has
        # real data, even though main_data.csv will be schema-only.
        logger.warning(
            "processing: tximport parse failed (%s); attempting series_matrix "
            "sample recovery",
            exc,
        )
        samples = _recover_samples_from_series_matrix(source_asset, ctx)
        parsed = _build_minimal_parsed_dataset(source_asset, dataset_id, ctx)
        if samples:
            logger.info(
                "processing: recovered %d samples from series_matrix; "
                "main_data.csv will be schema-only (0 rows) because the "
                "series_matrix expression block is empty",
                len(samples),
            )
        else:
            logger.warning(
                "processing: series_matrix recovery yielded no samples; "
                "main_data.csv and sample_metadata.csv will both be schema-only"
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
