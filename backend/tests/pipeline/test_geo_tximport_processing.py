from __future__ import annotations

import csv
import gzip
import hashlib
from pathlib import Path

from app.domain.contracts import DataLevel, SourceAsset
from app.pipeline.processing.geo_tximport import (
    parse_geo_series_matrix_samples,
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


# --- series_matrix sample recovery (§15.4 / §17) ---------------------------
#
# Modern GEO series (snRNAseq, RNA-seq) frequently ship a series_matrix file
# whose expression-matrix block is empty. The parser must still recover
# per-sample metadata from the !Sample_* lines so sample_metadata.csv is
# populated even when main_data.csv is schema-only.

SERIES_MATRIX_EMPTY_BLOCK = """!Series_title\t"Test series"
!Sample_geo_accession\t"GSM9000001"\t"GSM9000002"\t"GSM9000003"
!Sample_title\t"Control rep. 1"\t"Treatment rep. 2"\t"Control rep. 3"
!Sample_organism_ch1\t"Homo sapiens"\t"Homo sapiens"\t"Homo sapiens"
!Sample_characteristics_ch1\t"cell line: MDA-MB-231"\t"cell line: MCF7"\t"cell line: MDA-MB-231"
!Sample_characteristics_ch1\t"treatment: DMSO"\t"treatment: DrugA"\t"treatment: DMSO"
!series_matrix_table_begin
"ID_REF"\t"GSM9000001"\t"GSM9000002"\t"GSM9000003"
!series_matrix_table_end
"""


def test_series_matrix_parser_recovers_samples_from_empty_matrix_block() -> None:
    """An empty matrix block (only header between begin/end) must still yield
    per-sample metadata so sample_metadata.csv has rows."""
    compressed = gzip.compress(
        SERIES_MATRIX_EMPTY_BLOCK.encode("utf-8"), mtime=0
    )
    samples = parse_geo_series_matrix_samples(compressed)

    assert len(samples) == 3
    by_gsm = {s.sample_id: s for s in samples}
    assert set(by_gsm) == {"GSM9000001", "GSM9000002", "GSM9000003"}

    # source_alias falls back to the GSM accession itself
    assert samples[0].source_alias == "GSM9000001"

    # organism populated from !Sample_organism_ch1
    assert all(s.organism == "Homo sapiens" for s in samples)

    # cell_line canonical correction still applies
    assert by_gsm["GSM9000001"].cell_line_raw == "MDA-MB-231"
    assert by_gsm["GSM9000001"].cell_line_canonical == "MDA-MB-231"
    assert by_gsm["GSM9000001"].normalization_rule == "identity"
    assert by_gsm["GSM9000002"].cell_line_raw == "MCF7"
    assert by_gsm["GSM9000002"].cell_line_canonical == "MCF7"

    # treatment falls back to sample title when no treatment characteristic
    # is present; here we have treatment characteristics so that wins
    assert by_gsm["GSM9000001"].treatment == "DMSO"
    assert by_gsm["GSM9000002"].treatment == "DrugA"

    # replicate parsed from "rep. N" in the title
    assert by_gsm["GSM9000001"].replicate == 1
    assert by_gsm["GSM9000002"].replicate == 2
    assert by_gsm["GSM9000003"].replicate == 3


def test_series_matrix_parser_treatment_falls_back_to_title() -> None:
    """When the series_matrix has no `treatment` characteristic, the parser
    should fall back to using the sample title as the treatment field."""
    matrix = (
        '!Sample_geo_accession\t"GSM9000010"\n'
        '!Sample_title\t"HD A1 (25172XR-01-04)"\n'
        '!Sample_organism_ch1\t"Homo sapiens"\n'
        '!series_matrix_table_begin\n'
        '"ID_REF"\t"GSM9000010"\n'
        '!series_matrix_table_end\n'
    )
    compressed = gzip.compress(matrix.encode("utf-8"), mtime=0)
    samples = parse_geo_series_matrix_samples(compressed)
    assert len(samples) == 1
    # No rep. token in the title -> replicate defaults to 1
    assert samples[0].replicate == 1
    # treatment falls back to the title
    assert samples[0].treatment == "HD A1 (25172XR-01-04)"


def test_series_matrix_parser_raises_on_missing_accession_row() -> None:
    """A series_matrix without !Sample_geo_accession is malformed; the parser
    must raise so the processing stage can log a warning and fall back."""
    matrix = (
        '!Series_title\t"Empty"\n'
        '!series_matrix_table_begin\n'
        '"ID_REF"\t"GSM1"\n'
        '!series_matrix_table_end\n'
    )
    compressed = gzip.compress(matrix.encode("utf-8"), mtime=0)
    import pytest

    with pytest.raises(ValueError, match="no !Sample_geo_accession"):
        parse_geo_series_matrix_samples(compressed)


def test_geo_sample_metadata_accepts_gsm_accession_as_source_alias() -> None:
    """The relaxed source_alias pattern must accept GSM accessions so the
    series_matrix parser can construct GeoSampleMetadata instances."""
    from app.pipeline.processing.geo_tximport import GeoSampleMetadata

    sample = GeoSampleMetadata(
        sample_id="GSM9000001",
        source_alias="GSM9000001",
        cell_line_raw="",
        cell_line_canonical="",
        normalization_rule="identity",
        treatment="Control",
        replicate=1,
    )
    assert sample.source_alias == "GSM9000001"
