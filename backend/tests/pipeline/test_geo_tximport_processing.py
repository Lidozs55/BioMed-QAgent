from __future__ import annotations

import csv
import gzip
import hashlib
from pathlib import Path

from app.domain.contracts import DataLevel, SourceAsset, asset_id_from_sha256
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
    with output_path.open("r", encoding="utf-8-sig", newline="") as handle:
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


# --- main_data.csv 始终含样本元数据行 (§17.5) -------------------------------
#
# 当 GEO series_matrix 的表达矩阵为空（snRNAseq / RNA-seq 系列）时，
# _build_minimal_parsed_dataset 必须为每个恢复出的样本生成一行
# measurement_type="sample_metadata" 的元数据行写入 main_data.csv，
# 保证 main_data.csv 始终有数据。表达相关字段留空，source_line_number=0
# 标识"无源行号"，validation 的 source_value_lineage 检查会跳过这些行。


def _make_geo_sample(sample_id: str, alias: str = "", treatment: str = "Control"):
    from app.pipeline.processing.geo_tximport import GeoSampleMetadata

    return GeoSampleMetadata(
        sample_id=sample_id,
        source_alias=alias or sample_id,
        cell_line_raw="MDA-MB-231",
        cell_line_canonical="MDA-MB-231",
        normalization_rule="identity",
        treatment=treatment,
        replicate=1,
    )


def _make_minimal_ctx(
    tmp_path: Path, task_id: str
) -> tuple[object, SourceAsset]:
    """Build a StageContext + placeholder SourceAsset for processing tests."""
    from datetime import UTC, datetime

    from app.pipeline.stages.base import StageContext

    workdir = create_task_workdir(task_id, base_dir=str(tmp_path / task_id))
    placeholder = workdir.source_assets / "series_matrix.txt.gz"
    placeholder.write_bytes(b"placeholder")
    checksum = hashlib.sha256(b"placeholder").hexdigest()
    source_asset = SourceAsset(
        asset_id=f"asset_{checksum}",
        kind="source",
        relative_path="source_assets/series_matrix.txt.gz",
        sha256=checksum,
        size_bytes=len(b"placeholder"),
        media_type="application/gzip",
        source_id="src_geo_gse_test",
        successful_attempt_id="download_attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    ctx = StageContext(
        task_id=task_id,
        workdir=workdir,
        fixture_dir=tmp_path,
        topic="test",
        started_at=datetime.now(tz=UTC),
    )
    return ctx, source_asset


def test_minimal_dataset_with_samples_writes_one_metadata_row_per_sample(
    tmp_path: Path,
) -> None:
    """When samples are provided, _build_minimal_parsed_dataset must write
    one sample_metadata row per sample into main_data.csv (not 0 rows)."""
    from app.pipeline.stages.processing import _build_minimal_parsed_dataset

    ctx, source_asset = _make_minimal_ctx(tmp_path, "task_md1")

    samples = [
        _make_geo_sample("GSM9000001", treatment="DMSO"),
        _make_geo_sample("GSM9000002", treatment="DrugA"),
        _make_geo_sample("GSM9000003", treatment="DMSO"),
    ]
    parsed = _build_minimal_parsed_dataset(
        source_asset, "ds_geo_test", ctx, samples=samples
    )

    # row_count must equal the number of samples (not 0)
    assert parsed.row_count == 3

    output_path = ctx.workdir.root / parsed.file_asset.relative_path
    with output_path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))

    assert len(rows) == 3
    # Every row is a sample_metadata row
    assert all(r["measurement_type"] == "sample_metadata" for r in rows)
    # Sample IDs are preserved
    assert {r["sample_id"] for r in rows} == {
        "GSM9000001", "GSM9000002", "GSM9000003",
    }
    # Expression-related fields are blank
    for r in rows:
        assert r["gene_id_raw"] == ""
        assert r["gene_id"] == ""
        assert r["expression_value"] == ""
        assert r["source_raw_value"] == ""
        # source_line_number=0 is the "no source locator" sentinel
        assert r["source_line_number"] == "0"
        assert r["source_column_index"] == "0"
    # source_sample_alias is preserved
    assert {r["source_sample_alias"] for r in rows} == {
        "GSM9000001", "GSM9000002", "GSM9000003",
    }
    # record_id is deterministic per (dataset_id, "sample_metadata", sample_id)
    assert all(r["record_id"].startswith("rec_") for r in rows)
    assert len({r["record_id"] for r in rows}) == 3


def test_minimal_dataset_without_samples_is_schema_only(tmp_path: Path) -> None:
    """When samples is None or empty, _build_minimal_parsed_dataset writes a
    schema-only CSV (0 rows) for backward compatibility."""
    from app.pipeline.stages.processing import _build_minimal_parsed_dataset

    ctx, source_asset = _make_minimal_ctx(tmp_path, "task_md2")

    parsed_none = _build_minimal_parsed_dataset(
        source_asset, "ds_geo_test", ctx, samples=None
    )
    assert parsed_none.row_count == 0

    parsed_empty = _build_minimal_parsed_dataset(
        source_asset, "ds_geo_test", ctx, samples=[]
    )
    assert parsed_empty.row_count == 0


def test_validation_skips_lineage_for_sample_metadata_rows(tmp_path: Path) -> None:
    """The source_value_lineage check must skip measurement_type="sample_metadata"
    rows (they have no expression value to verify against)."""
    import gzip as _gzip
    import json as _json

    from app.pipeline.stages.validation import _validate_package

    staging = tmp_path / "tasks" / "task_val" / "staging"
    source_path = tmp_path / "tasks" / "task_val" / "source_assets" / "src.tsv.gz"
    staging.mkdir(parents=True, exist_ok=True)
    source_path.parent.mkdir(parents=True, exist_ok=True)

    # Source file is a minimal series_matrix-like file (won't be touched
    # because all main_data rows are sample_metadata).
    source_path.write_bytes(
        _gzip.compress(b'"ID_REF"\t"GSM1"\n1.0\t2.0\n', mtime=0)
    )

    main_columns = [
        "record_id", "dataset_id", "source_id", "asset_id", "gene_id_raw",
        "gene_id", "gene_id_namespace", "gene_id_version", "sample_id",
        "source_sample_alias", "measurement_type", "value_semantics",
        "value_scale", "is_normalized", "is_integer_expected",
        "expression_value", "expression_unit", "source_logical_file",
        "source_line_number", "source_column_index", "source_column_name",
        "source_raw_value",
    ]
    main_rows = [
        {
            "record_id": "rec_md_1", "dataset_id": "ds1", "source_id": "src1",
            "asset_id": "asset1", "gene_id_raw": "", "gene_id": "",
            "gene_id_namespace": "", "gene_id_version": "",
            "sample_id": "GSM9000001", "source_sample_alias": "GSM9000001",
            "measurement_type": "sample_metadata",
            "value_semantics": "metadata_only", "value_scale": "na",
            "is_normalized": "false", "is_integer_expected": "false",
            "expression_value": "", "expression_unit": "na",
            "source_logical_file": "series_matrix_metadata",
            "source_line_number": "0", "source_column_index": "0",
            "source_column_name": "sample_metadata", "source_raw_value": "",
        },
        {
            "record_id": "rec_md_2", "dataset_id": "ds1", "source_id": "src1",
            "asset_id": "asset1", "gene_id_raw": "", "gene_id": "",
            "gene_id_namespace": "", "gene_id_version": "",
            "sample_id": "GSM9000002", "source_sample_alias": "GSM9000002",
            "measurement_type": "sample_metadata",
            "value_semantics": "metadata_only", "value_scale": "na",
            "is_normalized": "false", "is_integer_expected": "false",
            "expression_value": "", "expression_unit": "na",
            "source_logical_file": "series_matrix_metadata",
            "source_line_number": "0", "source_column_index": "0",
            "source_column_name": "sample_metadata", "source_raw_value": "",
        },
    ]
    with (staging / "main_data.csv").open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=main_columns)
        writer.writeheader()
        writer.writerows(main_rows)

    # Build minimal companion CSVs required by _validate_package
    def _write(name: str, columns: list[str], rows: list[dict[str, object]]) -> None:
        with (staging / name).open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)

    _write("dataset_catalog.csv", [
        "dataset_id", "source_id", "database", "accession", "title",
        "organism", "experiment_type", "sample_count", "platform_ids",
        "related_pmids", "source_url", "retrieved_at",
    ], [{
        "dataset_id": "ds1", "source_id": "src1", "database": "geo",
        "accession": "GSE999999", "title": "Test", "organism": "Homo sapiens",
        "experiment_type": "RNA-Seq", "sample_count": "2",
        "platform_ids": "[]", "related_pmids": "[]",
        "source_url": "https://example.test", "retrieved_at": "2026-01-01T00:00:00",
    }])
    _write("sample_metadata.csv", [
        "sample_id", "dataset_id", "source_id", "source_sample_alias",
        "cell_line_raw", "cell_line_canonical", "normalization_rule",
        "treatment", "replicate", "organism", "source_url",
    ], [
        {"sample_id": "GSM9000001", "dataset_id": "ds1", "source_id": "src1",
         "source_sample_alias": "GSM9000001", "cell_line_raw": "",
         "cell_line_canonical": "", "normalization_rule": "",
         "treatment": "", "replicate": "1", "organism": "Homo sapiens",
         "source_url": "https://example.test"},
        {"sample_id": "GSM9000002", "dataset_id": "ds1", "source_id": "src1",
         "source_sample_alias": "GSM9000002", "cell_line_raw": "",
         "cell_line_canonical": "", "normalization_rule": "",
         "treatment": "", "replicate": "1", "organism": "Homo sapiens",
         "source_url": "https://example.test"},
    ])
    _write("source_list.csv", [
        "source_id", "database", "accession", "url", "title", "retrieved_at",
    ], [{"source_id": "src1", "database": "geo", "accession": "GSE999999",
         "url": "https://example.test", "title": "Test",
         "retrieved_at": "2026-01-01T00:00:00"}])
    # source_assets: size/sha must match source_path — use real values
    source_bytes = source_path.read_bytes()
    _write("source_assets.csv", [
        "asset_id", "source_id", "successful_attempt_id", "data_level",
        "relative_path", "size_bytes", "sha256", "media_type",
        "schema_version",
    ], [{
        "asset_id": "asset1", "source_id": "src1",
        "successful_attempt_id": "attempt_1",
        "data_level": "repository_processed",
        "relative_path": "source_assets/src.tsv.gz",
        "size_bytes": str(len(source_bytes)),
        "sha256": hashlib.sha256(source_bytes).hexdigest(),
        "media_type": "application/gzip",
        "schema_version": "1.0",
    }])
    _write("download_log.csv", [
        "attempt_id", "source_id", "url", "status", "bytes_received",
        "error_code", "error_message", "started_at", "finished_at",
    ], [{"attempt_id": "attempt_1", "source_id": "src1",
         "url": "https://example.test/file.gz", "status": "succeeded",
         "bytes_received": str(len(source_bytes)), "error_code": "",
         "error_message": "", "started_at": "2026-01-01T00:00:00",
         "finished_at": "2026-01-01T00:00:01"}])
    _write("field_descriptions.csv", [
        "field_name", "data_type", "description", "unit", "nullable",
        "source", "example",
    ], [{"field_name": col, "data_type": "string", "description": col,
         "unit": "", "nullable": "true", "source": "test", "example": ""}
        for col in main_columns])
    _write("processing_log.csv", [
        "step_id", "stage_attempt_id", "stage", "operation", "input_refs",
        "output_refs", "tool_version", "rows_before", "rows_after",
        "parameters", "status", "started_at", "finished_at", "warnings",
    ], [{"step_id": "step_test_v1", "stage_attempt_id": "attempt_test",
         "stage": "processing", "operation": "parse_counts",
         "input_refs": "[]", "output_refs": "[]", "tool_version": "1.0.0",
         "rows_before": 0, "rows_after": 2,
         "parameters": "{}", "status": "succeeded",
         "started_at": "2026-01-01T00:00:00",
         "finished_at": "2026-01-01T00:00:01",
         "warnings": _json.dumps([])}])
    _write("warnings.csv", [
        "warning_id", "severity", "stage", "code", "message",
        "source_id", "asset_id", "record_id", "created_at",
    ], [])

    summary, checks = _validate_package(
        staging, source_path, tmp_path / "tasks" / "task_val" / "logs" / "r.json"
    )
    svl = next(c for c in checks if c["check_id"] == "source_value_lineage")
    # No lineage failures — sample_metadata rows were skipped
    assert svl["status"] == "passed"
    assert int(svl["failed_count"]) == 0
    details = _json.loads(svl["details"])
    assert details["skipped_metadata_rows"] == 2
    assert details["total_rows"] == 2
    assert details["sampled"] == 2


# --- §1.1 hardcoded-count removal in parse_geo_soft_samples -----------------
#
# The previous ``len(samples) != 12`` check hardcoded GSE178352's twelve-sample
# shape and rejected every other GEO series. The generalized validation now
# only requires (a) at least one sample and (b) unique source_alias values.


def _make_soft_bytes(samples: list[dict[str, str]]) -> bytes:
    """Build a minimal SOFT gzipped payload from sample dicts.

    Each sample dict must carry: sample_id, alias, title (containing
    ``rep. N``), and optional ``cell_line`` / ``treatment`` characteristics.
    """
    lines: list[str] = []
    for s in samples:
        lines.append(f"^SAMPLE = {s['sample_id']}")
        lines.append(f"!Sample_description = Sample {s['alias']}")
        lines.append(f"!Sample_title = {s['title']}")
        if s.get("cell_line"):
            lines.append(f"!Sample_characteristics_ch1 = cell line: {s['cell_line']}")
        if s.get("treatment"):
            lines.append(f"!Sample_characteristics_ch1 = treatment: {s['treatment']}")
    return gzip.compress("\n".join(lines).encode("utf-8"), mtime=0)


def test_parse_geo_soft_samples_accepts_non_twelve_sample_count() -> None:
    """A 2-sample SOFT must parse successfully — the previous hardcoded
    ``len(samples) != 12`` check rejected any non-GSE178352 series (TODO §1.1).
    """
    soft = _make_soft_bytes([
        {"sample_id": "GSM9000001", "alias": "C1",
         "title": "Control rep. 1", "cell_line": "MCF7", "treatment": "DMSO"},
        {"sample_id": "GSM9000002", "alias": "C2",
         "title": "Control rep. 2", "cell_line": "MCF7", "treatment": "DMSO"},
    ])
    samples = parse_geo_soft_samples(soft)
    assert len(samples) == 2
    assert {s.sample_id for s in samples} == {"GSM9000001", "GSM9000002"}
    assert {s.source_alias for s in samples} == {"C1", "C2"}


def test_parse_geo_soft_samples_rejects_zero_samples() -> None:
    """An empty SOFT (no ^SAMPLE lines) must raise ValueError (TODO §1.1)."""
    soft = gzip.compress(b"!Series_title\t\"Empty\"\n", mtime=0)
    import pytest

    with pytest.raises(ValueError, match="no samples"):
        parse_geo_soft_samples(soft)


def test_parse_geo_soft_samples_rejects_duplicate_aliases() -> None:
    """Two samples sharing the same source_alias must raise ValueError
    (downstream code keys samples by alias) (TODO §1.1)."""
    soft = _make_soft_bytes([
        {"sample_id": "GSM9000001", "alias": "DUP",
         "title": "Control rep. 1"},
        {"sample_id": "GSM9000002", "alias": "DUP",
         "title": "Control rep. 2"},
    ])
    import pytest

    with pytest.raises(ValueError, match="unique"):
        parse_geo_soft_samples(soft)


# --- live mode uses acquired SOFT for tximport counts -----------------------


def test_run_processing_live_mode_uses_acquired_soft_for_tximport_counts(
    tmp_path: Path,
) -> None:
    from datetime import UTC, datetime

    from app.pipeline.stages.base import StageContext
    from app.pipeline.stages.processing import run_processing

    workdir = create_task_workdir("task_live_counts", base_dir=str(tmp_path))
    counts_bytes = gzip.compress(
        (FIXTURE_DIR / "tximport_counts_slice.tsv").read_bytes(), mtime=0
    )
    counts_path = workdir.source_assets / "GSE178352_tximportCounts.txt.gz"
    counts_path.write_bytes(counts_bytes)
    soft_path = workdir.source_assets / "GSE178352_family.soft.gz"
    soft_bytes = (FIXTURE_DIR / "gse178352_family.soft.gz").read_bytes()
    soft_path.write_bytes(soft_bytes)
    counts_asset = SourceAsset(
        asset_id=asset_id_from_sha256(hashlib.sha256(counts_bytes).hexdigest()),
        kind="source",
        relative_path="source_assets/GSE178352_tximportCounts.txt.gz",
        sha256=hashlib.sha256(counts_bytes).hexdigest(),
        size_bytes=len(counts_bytes),
        media_type="application/gzip",
        source_id="src_geo_gse178352",
        successful_attempt_id="attempt_counts",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    soft_asset = SourceAsset(
        asset_id=asset_id_from_sha256(hashlib.sha256(soft_bytes).hexdigest()),
        kind="source",
        relative_path="source_assets/GSE178352_family.soft.gz",
        sha256=hashlib.sha256(soft_bytes).hexdigest(),
        size_bytes=len(soft_bytes),
        media_type="application/gzip",
        source_id="src_geo_gse178352",
        successful_attempt_id="attempt_soft",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    ctx = StageContext(
        task_id="task_live_counts", workdir=workdir, fixture_dir=tmp_path,
        topic="live", databases=["geo"], started_at=datetime.now(tz=UTC), mode="live",
    )

    result = run_processing(ctx, [counts_asset, soft_asset], "ds_geo_gse178352")

    parsed = result.output.parsed_datasets[0]
    assert parsed.row_count == 48
    assert parsed.processing_parameters["measurement_type"] == "tximport_estimated_count"
    output_path = workdir.root / parsed.file_asset.relative_path
    with output_path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert rows
    assert {row["measurement_type"] for row in rows} == {"tximport_estimated_count"}


# --- §1.1 run_processing live mode skips fixture SOFT ----------------------
#
#

def test_run_processing_live_mode_does_not_read_fixture_soft(
    tmp_path: Path,
) -> None:
    """In live mode, ``run_processing`` must NOT read the fixture SOFT file
    even when it exists on disk (TODO §1.1).

    Previously the live path called ``process_geo_tximport_counts`` with
    ``ctx.fixture_dir / "gse178352_family.soft.gz"`` bytes, contaminating
    live data with fixture SOFT. After §1.1, live mode skips the tximport
    parser entirely and goes straight to series_matrix recovery.
    """
    import gzip as _gzip
    from datetime import UTC, datetime

    from app.pipeline.stages.base import StageContext
    from app.pipeline.stages.processing import run_processing

    workdir = create_task_workdir(
        "task_live", base_dir=str(tmp_path / "task_live")
    )

    # Build a real series_matrix file as the live-acquired source asset.
    matrix = (
        '!Series_title\t"Live series"\n'
        '!Sample_geo_accession\t"GSM9000100"\t"GSM9000101"\n'
        '!Sample_title\t"Control rep. 1"\t"Treatment rep. 2"\n'
        '!Sample_organism_ch1\t"Homo sapiens"\t"Homo sapiens"\n'
        '!Sample_characteristics_ch1\t"cell line: MCF7"\t"cell line: MCF7"\n'
        '!Sample_characteristics_ch1\t"treatment: DMSO"\t"treatment: DrugA"\n'
        '!series_matrix_table_begin\n'
        '"ID_REF"\t"GSM9000100"\t"GSM9000101"\n'
        '!series_matrix_table_end\n'
    )
    matrix_bytes = _gzip.compress(matrix.encode("utf-8"), mtime=0)
    source_path = workdir.source_assets / "GSE999999_series_matrix.txt.gz"
    source_path.write_bytes(matrix_bytes)
    checksum = hashlib.sha256(matrix_bytes).hexdigest()
    source_asset = SourceAsset(
        asset_id=f"asset_{checksum}",
        kind="source",
        relative_path="source_assets/GSE999999_series_matrix.txt.gz",
        sha256=checksum,
        size_bytes=len(matrix_bytes),
        media_type="application/gzip",
        source_id="src_geo_gse999999",
        successful_attempt_id="attempt_live",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )

    # Place a fixture SOFT at fixture_dir to prove live mode doesn't read it.
    # If run_processing tried to read this file, it would get garbage bytes
    # (not a valid gzip) and crash with a gzip BadGzipFile error.
    fixture_dir = tmp_path / "fixtures"
    fixture_dir.mkdir()
    fake_soft = fixture_dir / "gse178352_family.soft.gz"
    fake_soft.write_bytes(b"NOT A VALID GZIP - live mode must not read this")

    ctx = StageContext(
        task_id="task_live",
        workdir=workdir,
        fixture_dir=fixture_dir,
        topic="live",
        databases=["geo"],
        started_at=datetime.now(tz=UTC),
        mode="live",
    )

    result = run_processing(ctx, source_asset, "ds_geo_live")

    # Live mode succeeded without reading the fixture SOFT.
    assert result.output is not None
    parsed = result.output.parsed_datasets[0]
    # Sample metadata was recovered from the series_matrix, not the fixture.
    assert len(result.output.samples) == 2
    assert {s.sample_id for s in result.output.samples} == {
        "GSM9000100", "GSM9000101",
    }
    # main_data.csv carries one sample_metadata row per sample (no expression
    # matrix in live mode — see architectural note in run_processing).
    assert parsed.row_count == 2
    assert parsed.source_row_count == 0
    assert parsed.processing_parameters["measurement_type"] == "sample_metadata"
    assert parsed.processing_parameters["sample_count"] == 2


def test_run_processing_fixture_mode_still_uses_fixture_soft() -> None:
    """Fixture mode must keep calling ``process_geo_tximport_counts`` with
    the fixture SOFT (TODO §1.1 regression guard).

    The §1.1 fix only short-circuits live mode; fixture mode preserves the
    existing behavior so pinned-pipeline E2E tests keep producing the real
    4-gene × 12-sample expression matrix.
    """
    # Indirectly verified by every pinned_pipeline / artifact_metadata test
    # that asserts ``rows_after == 48`` and ``measurement_type ==
    # "tximport_estimated_count"``. This test exists as a focused regression
    # marker so a future refactor can't silently switch fixture mode to the
    # minimal path.
    # The function must still branch on ctx.mode == "fixture"; if a future
    # refactor removes the fixture branch, the pinned E2E tests will fail.
    # We assert the source code still carries the fixture-mode branch.
    import inspect

    from app.pipeline.stages.processing import run_processing

    source = inspect.getsource(run_processing)
    assert 'ctx.mode == "fixture"' in source, (
        "run_processing must still branch on ctx.mode == 'fixture' so "
        "fixture mode keeps using process_geo_tximport_counts"
    )
