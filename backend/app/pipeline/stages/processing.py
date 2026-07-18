"""Processing stage: parse GEO tximport counts into ParsedDataset."""
from __future__ import annotations

import hashlib

from app.domain.contracts import ParsedDataset, SourceAsset, StageName
from app.pipeline.processing.geo_tximport import (
    parse_geo_soft_samples,
    process_geo_tximport_counts,
)
from app.pipeline.stages.base import ProcessingOutput, StageContext, StageResult


def run_processing(
    ctx: StageContext,
    source_asset: SourceAsset,
    dataset_id: str,
) -> StageResult:
    """Parse the GEO tximport counts file into a long-form ParsedDataset.

    Reads the fixture SOFT file for sample metadata and invokes
    ``process_geo_tximport_counts`` to produce the normalized CSV.
    """
    parsed: ParsedDataset = process_geo_tximport_counts(
        source_asset=source_asset,
        dataset_id=dataset_id,
        workdir=ctx.workdir,
        soft_gzip=(ctx.fixture_dir / "gse178352_family.soft.gz").read_bytes(),
        logical_file="GSE178352_tximportCounts.txt",
    )
    samples = parse_geo_soft_samples(
        (ctx.fixture_dir / "gse178352_family.soft.gz").read_bytes()
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
