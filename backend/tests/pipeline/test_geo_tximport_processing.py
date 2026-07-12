from __future__ import annotations

import csv
import gzip
import hashlib
from pathlib import Path

from app.domain.contracts import DataLevel, SourceAsset
from app.pipeline.processing.geo_tximport import (
    parse_geo_soft_samples,
    process_geo_tximport_counts,
)
from app.tools.workdir import create_task_workdir


FIXTURE_DIR = (
    Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"
)


def test_soft_sample_parser_maps_all_source_aliases_to_gsm_accessions() -> None:
    samples = parse_geo_soft_samples(
        (FIXTURE_DIR / "gse178352_family.soft.gz").read_bytes()
    )

    assert len(samples) == 12
    by_alias = {sample.source_alias: sample for sample in samples}
    assert by_alias["A1"].sample_id == "GSM5388270"
    assert by_alias["A7"].sample_id == "GSM5388272"
    assert by_alias["B7"].sample_id == "GSM5388281"
    assert by_alias["A1"].cell_line_raw == "MD-MBA-231"
    assert by_alias["A1"].cell_line_canonical == "MDA-MB-231"
    assert by_alias["A1"].normalization_rule == "cell-line-name-correction-v1"
    assert by_alias["B7"].treatment == "MAL3-101"
    assert by_alias["B7"].replicate == 3


def test_counts_processor_writes_long_form_rows_with_exact_source_locators(
    tmp_path: Path,
) -> None:
    workdir = create_task_workdir("task_process", base_dir=str(tmp_path / "tasks"))
    fixture_bytes = (FIXTURE_DIR / "tximport_counts_slice.tsv").read_bytes()
    compressed = gzip.compress(fixture_bytes, mtime=0)
    checksum = hashlib.sha256(compressed).hexdigest()
    source_path = workdir.source_assets / "counts.gz"
    source_path.write_bytes(compressed)
    source_asset = SourceAsset(
        asset_id=f"asset_{checksum}",
        kind="source",
        relative_path="source_assets/counts.gz",
        sha256=checksum,
        size_bytes=len(compressed),
        media_type="application/gzip",
        source_id="src_geo_gse178352",
        successful_attempt_id="download_attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )

    result = process_geo_tximport_counts(
        source_asset=source_asset,
        dataset_id="ds_geo_gse178352",
        workdir=workdir,
        soft_gzip=(FIXTURE_DIR / "gse178352_family.soft.gz").read_bytes(),
        logical_file="GSE178352_tximportCounts.txt",
    )

    output_path = workdir.root / result.file_asset.relative_path
    with output_path.open("r", encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))

    assert result.row_count == 48
    assert len(rows) == 48
    first = rows[0]
    assert first["gene_id_raw"] == "ENSG00000000003"
    assert first["gene_id"] == "ENSG00000000003"
    assert first["gene_id_namespace"] == "ensembl_gene"
    assert first["sample_id"] == "GSM5388270"
    assert first["source_sample_alias"] == "A1"
    assert first["measurement_type"] == "tximport_estimated_count"
    assert first["expression_value"] == "0"
    assert first["source_logical_file"] == "GSE178352_tximportCounts.txt"
    assert first["source_line_number"] == "2"
    assert first["source_column_index"] == "13"
    assert first["source_column_name"] == "counts.A1"
    assert first["source_raw_value"] == "0"
    assert {row["sample_id"] for row in rows} == {
        "GSM5388270", "GSM5388271", "GSM5388272", "GSM5388273",
        "GSM5388274", "GSM5388275", "GSM5388276", "GSM5388277",
        "GSM5388278", "GSM5388279", "GSM5388280", "GSM5388281",
    }
