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


def test_tximport_counts_parse_failure_removes_partial_output(
    tmp_path: Path,
) -> None:
    """A midstream tximport parse failure must not leave a partial
    ``<dataset>_tximport_long.csv`` in the parsed workdir: the stage-level
    caller catches the exception and continues to the no-primary path, so a
    leftover partial file would otherwise survive into staging
    (phase 4b T1 review round 2)."""
    import pytest

    workdir = create_task_workdir(
        "task_partial", base_dir=str(tmp_path / "task_partial")
    )
    fixture_lines = (FIXTURE_DIR / "tximport_counts_slice.tsv").read_text(
        encoding="utf-8"
    ).splitlines()
    # Corrupt the third data row's counts.A1 value (field index 13) so the
    # parser raises ValueError mid-stream, AFTER the output file was created
    # and two rows were already written.
    bad_row = fixture_lines[3].split("\t")
    bad_row[13] = "not-a-number"
    content_lines = fixture_lines[:3] + ["\t".join(bad_row)]
    compressed = gzip.compress("\n".join(content_lines).encode("utf-8"), mtime=0)
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

    with pytest.raises(ValueError):
        process_geo_tximport_counts(
            source_asset=source_asset,
            dataset_id="ds_geo_gse178352",
            workdir=workdir,
            soft_gzip=(FIXTURE_DIR / "gse178352_family.soft.gz").read_bytes(),
            logical_file="GSE178352_tximportCounts.txt",
        )

    # The partial output file must not survive the failed parse.
    assert list(workdir.parsed.iterdir()) == []


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


# --- 无表达数据 → 无主数据（ADR-011 / phase 4b T1） -------------------------
#
# 当 GEO series_matrix 的表达矩阵为空（snRNAseq / RNA-seq 系列）且无
# supplementary 表达文件时，processing 不再生成 metadata-only 占位行
# （_build_minimal_parsed_dataset / geo_minimal_placeholder 已删除）：
# parsed_datasets=[] + no_primary_reason 记录原因，恢复出的 samples 保留在
# ProcessingOutput.samples 供 sample_metadata.csv 使用（T2 接线）。


def _make_no_expression_ctx(
    tmp_path: Path, task_id: str
) -> tuple[object, SourceAsset]:
    """Build a live-mode StageContext + series_matrix SourceAsset whose
    expression block is empty and which has no supplementary expression
    asset — the no-expression scenario of phase 4b T1."""
    from datetime import UTC, datetime

    from app.pipeline.stages.base import StageContext

    ctx, source_asset = _make_series_matrix_asset(
        tmp_path, SERIES_MATRIX_EMPTY_BLOCK, task_id=task_id
    )
    live_ctx = StageContext(
        task_id=task_id,
        workdir=ctx.workdir,
        fixture_dir=tmp_path,
        topic="live",
        databases=["geo"],
        started_at=datetime.now(tz=UTC),
        mode="live",
    )
    return live_ctx, source_asset


def test_no_expression_fallback_yields_no_primary_with_reason(
    tmp_path: Path,
) -> None:
    """A series_matrix with an empty expression block and no supplementary
    expression asset must yield NO parsed primary dataset: the metadata-only
    placeholder rows (geo_minimal_placeholder) are removed (ADR-011)."""
    from app.pipeline.stages.processing import (
        _try_series_matrix_expression_or_minimal,
    )

    ctx, source_asset = _make_no_expression_ctx(tmp_path, "task_md1")
    compressed = (
        ctx.workdir.source_assets / "GSE999999_series_matrix.txt.gz"
    ).read_bytes()
    samples = parse_geo_series_matrix_samples(compressed)
    assert len(samples) == 3

    parsed, reason = _try_series_matrix_expression_or_minimal(
        source_asset, "ds_geo_test", ctx, samples, suppl_asset=None
    )

    assert parsed is None
    assert reason == "series_matrix_expression_empty_and_no_supplementary"
    # No placeholder tximport_long.csv is written to the parsed workdir.
    assert list(ctx.workdir.parsed.iterdir()) == []


def test_no_expression_without_recoverable_samples_yields_no_primary(
    tmp_path: Path,
) -> None:
    """When no samples can be recovered from the series_matrix no expression
    data is available either: the fallback yields no parsed primary dataset
    (no schema-only placeholder file is written)."""
    from app.pipeline.stages.processing import (
        _try_series_matrix_expression_or_minimal,
    )

    ctx, source_asset = _make_no_expression_ctx(tmp_path, "task_md2")

    parsed, reason = _try_series_matrix_expression_or_minimal(
        source_asset, "ds_geo_test", ctx, [], suppl_asset=None
    )

    assert parsed is None
    assert reason == "series_matrix_samples_unavailable"
    assert list(ctx.workdir.parsed.iterdir()) == []


def test_run_processing_no_expression_yields_empty_parsed_with_samples(
    tmp_path: Path,
) -> None:
    """run_processing on a series_matrix with no expression data must yield
    parsed_datasets=[], no_primary_reason, and keep the recovered samples on
    the output (they feed sample_metadata.csv in a later task)."""
    from app.pipeline.stages.processing import run_processing

    ctx, source_asset = _make_no_expression_ctx(tmp_path, "task_md3")

    result = run_processing(ctx, source_asset, "ds_geo_test")

    assert result.output.parsed_datasets == []
    assert (
        result.output.no_primary_reason
        == "series_matrix_expression_empty_and_no_supplementary"
    )
    # Recovered samples are preserved for the supporting sample_metadata.csv.
    assert {s.sample_id for s in result.output.samples} == {
        "GSM9000001", "GSM9000002", "GSM9000003",
    }
    # No placeholder tximport_long.csv is written.
    assert list(ctx.workdir.parsed.iterdir()) == []
    # Deterministic digest that does not touch a parsed file's sha256.
    assert len(result.output_digest) == 64
    int(result.output_digest, 16)


def test_no_primary_output_digest_is_deterministic(tmp_path: Path) -> None:
    """Same no-expression inputs must produce the same output_digest (the
    no-primary digest hashes the reason + canonical sample records — full
    serialized GeoSampleMetadata sorted by sample_id, not just the sample
    ids and not a parsed file's sha256)."""
    from app.pipeline.stages.processing import run_processing

    ctx_a, asset_a = _make_no_expression_ctx(tmp_path, "task_dig_a")
    ctx_b, asset_b = _make_no_expression_ctx(tmp_path, "task_dig_b")

    result_a = run_processing(ctx_a, asset_a, "ds_geo_test")
    result_b = run_processing(ctx_b, asset_b, "ds_geo_test")

    assert result_a.output.parsed_datasets == []
    assert result_a.output.no_primary_reason == result_b.output.no_primary_reason
    assert result_a.output_digest == result_b.output_digest


def test_no_primary_digest_covers_full_sample_metadata(tmp_path: Path) -> None:
    """The no-primary digest must cover the full sample records, not just the
    sample ids: same ids with different metadata produce different digests,
    list order must not matter, and changing the ids changes the digest
    (phase 4b T1 review MUST-FIX 4)."""
    from app.pipeline.processing.geo_tximport import GeoSampleMetadata
    from app.pipeline.stages.processing import _no_primary_digest

    def _sample(sample_id: str, treatment: str) -> GeoSampleMetadata:
        return GeoSampleMetadata(
            sample_id=sample_id,
            source_alias=sample_id,
            cell_line_raw="MCF7",
            cell_line_canonical="MCF7",
            normalization_rule="identity",
            treatment=treatment,
            replicate=1,
        )

    reason = "series_matrix_expression_empty_and_no_supplementary"
    samples_a = [_sample("GSM9000001", "DMSO"), _sample("GSM9000002", "DrugA")]
    samples_b = [_sample("GSM9000001", "DMSO"), _sample("GSM9000002", "DMSO")]

    digest_a = _no_primary_digest(reason, samples_a)
    digest_b = _no_primary_digest(reason, samples_b)

    # Same sample ids, different treatment metadata -> different digests.
    assert digest_a != digest_b
    # Sample list order must not matter (deterministic canonical sort).
    assert _no_primary_digest(reason, list(reversed(samples_a))) == digest_a
    # Changing the sample ids changes the digest too.
    samples_c = [_sample("GSM9000001", "DMSO"), _sample("GSM9000099", "DrugA")]
    assert _no_primary_digest(reason, samples_c) != digest_a


def test_validation_no_longer_skips_lineage_for_sample_metadata_rows(tmp_path: Path) -> None:
    """The source_value_lineage check must NOT skip measurement_type="sample_metadata"
    rows anymore: phase 4b T1 removed the metadata-only placeholder primary, so
    the check applies uniformly to every main_data row (phase 4b T6 D5). These
    placeholder-era rows point at a blank locator (source_line_number 0 / empty
    raw value), so the lineage check now FAILS them instead of silently
    skipping — the exemption is dead code and no longer masks hollow rows."""
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
    # Phase 4b T6: every sampled row is checked uniformly — the sample_metadata
    # skip and its counters/flags are gone. Both rows fail the locator check
    # (blank raw value at line 0), so the check reports them as failures.
    assert svl["status"] == "failed"
    assert int(svl["failed_count"]) == 2
    details = _json.loads(svl["details"])
    assert "skipped_metadata_rows" not in details
    assert "high_skip_ratio" not in details
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


def _make_live_tximport_failure_assets(
    tmp_path: Path,
    task_id: str,
    counts_content: bytes,
    soft_bytes: bytes | None = None,
) -> tuple[object, list[SourceAsset]]:
    """Live-mode workdir matching the REAL acquisition topology: a
    'tximport counts' asset carrying *counts_content* (a file that fails the
    tximport parse) plus a family SOFT asset — there is NO series_matrix
    file in this topology. ``soft_bytes`` defaults to the GSE178352 fixture
    SOFT (12 samples); pass a malformed SOFT to exercise the
    no-usable-samples fallback."""
    from datetime import UTC, datetime

    from app.pipeline.stages.base import StageContext

    workdir = create_task_workdir(task_id, base_dir=str(tmp_path / task_id))
    counts_path = workdir.source_assets / "GSE999999_tximportCounts.txt.gz"
    counts_path.write_bytes(counts_content)
    counts_checksum = hashlib.sha256(counts_content).hexdigest()
    counts_asset = SourceAsset(
        asset_id=asset_id_from_sha256(counts_checksum),
        kind="source",
        relative_path="source_assets/GSE999999_tximportCounts.txt.gz",
        sha256=counts_checksum,
        size_bytes=len(counts_content),
        media_type="application/gzip",
        source_id="src_geo_gse999999",
        successful_attempt_id="attempt_counts",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    if soft_bytes is None:
        soft_bytes = (FIXTURE_DIR / "gse178352_family.soft.gz").read_bytes()
    soft_path = workdir.source_assets / "GSE999999_family.soft.gz"
    soft_path.write_bytes(soft_bytes)
    soft_checksum = hashlib.sha256(soft_bytes).hexdigest()
    soft_asset = SourceAsset(
        asset_id=asset_id_from_sha256(soft_checksum),
        kind="source",
        relative_path="source_assets/GSE999999_family.soft.gz",
        sha256=soft_checksum,
        size_bytes=len(soft_bytes),
        media_type="application/gzip",
        source_id="src_geo_gse999999",
        successful_attempt_id="attempt_soft",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    ctx = StageContext(
        task_id=task_id,
        workdir=workdir,
        fixture_dir=tmp_path,
        topic="live",
        databases=["geo"],
        started_at=datetime.now(tz=UTC),
        mode="live",
    )
    return ctx, [counts_asset, soft_asset]


def test_run_processing_live_tximport_failure_recovers_soft_samples_with_supplementary(
    tmp_path: Path,
) -> None:
    """A live-mode tximport counts parse failure must recover samples from
    the family SOFT asset (the REAL topology: tximport counts + family SOFT,
    no series_matrix file exists) and then attempt supplementary expression.
    With a supplementary asset present, the SOFT-recovered samples feed the
    supplementary parse and real expression rows are produced
    (phase 4b T1 review round 2)."""
    from app.pipeline.stages.processing import run_processing

    counts_content = gzip.compress(
        b"not-a-valid-tximport-matrix\trow\n", mtime=0
    )
    ctx, assets = _make_live_tximport_failure_assets(
        tmp_path, "task_live_txi_suppl", counts_content
    )
    suppl_content = gzip.compress(
        b'"gene"\t"GSM5388270"\t"GSM5388271"\n'
        b'"ENSG00000000003"\t"12.5"\t"3.2"\n'
        b'"ENSG00000000419"\t"0.8"\t"9.9"\n',
        mtime=0,
    )
    suppl_asset = _make_supplementary_asset(ctx.workdir, suppl_content)

    result = run_processing(ctx, assets + [suppl_asset], "ds_geo_gse999999")

    # Real expression success is not masked by the tximport failure.
    assert result.output.no_primary_reason is None
    parsed = result.output.parsed_datasets[0]
    assert parsed.row_count == 4  # 2 genes x 2 samples
    assert parsed.parser_name == "geo_supplementary_expression"
    assert parsed.processing_parameters["measurement_type"] == "supplementary_counts"
    # Samples recovered from the family SOFT are preserved on the output.
    assert len(result.output.samples) == 12
    assert "GSM5388270" in {s.sample_id for s in result.output.samples}


def test_run_processing_live_tximport_failure_raising_bytes_parses_supplementary(
    tmp_path: Path,
) -> None:
    """When the live tximport counts asset fails the parse with bytes that
    RAISE (garbage bytes -> gzip.BadGzipFile, an OSError subclass), the
    tximport asset must NEVER be routed through the series-matrix parser
    (it is tximport COUNTS format, not a series matrix). With a valid family
    SOFT (samples recovered) and a supplementary expression asset present,
    supplementary expression MUST be attempted and parsed regardless of how
    the failed tximport bytes fail (phase 4b T1 review round 3)."""
    from app.pipeline.stages.processing import run_processing

    # Bytes that raise gzip.BadGzipFile (an OSError) when read/decompressed:
    # the failure mode that previously short-circuited the supplementary
    # branch via "series_matrix_expression_parse_failed".
    counts_content = b"this is definitely not a gzip file at all"
    ctx, assets = _make_live_tximport_failure_assets(
        tmp_path, "task_live_txi_raise_suppl", counts_content
    )
    suppl_content = gzip.compress(
        b'"gene"\t"GSM5388270"\t"GSM5388271"\n'
        b'"ENSG00000000003"\t"12.5"\t"3.2"\n'
        b'"ENSG00000000419"\t"0.8"\t"9.9"\n',
        mtime=0,
    )
    suppl_asset = _make_supplementary_asset(ctx.workdir, suppl_content)

    result = run_processing(ctx, assets + [suppl_asset], "ds_geo_gse999999")

    # Real expression success is not masked by the raising tximport failure.
    assert result.output.no_primary_reason is None
    parsed = result.output.parsed_datasets[0]
    assert parsed.row_count == 4  # 2 genes x 2 samples
    assert parsed.parser_name == "geo_supplementary_expression"
    assert parsed.processing_parameters["measurement_type"] == "supplementary_counts"
    # Samples recovered from the family SOFT are preserved on the output.
    assert len(result.output.samples) == 12
    assert "GSM5388270" in {s.sample_id for s in result.output.samples}


def test_run_processing_live_tximport_failure_raising_bytes_no_supplementary(
    tmp_path: Path,
) -> None:
    """Sibling case: raising tximport bytes + valid family SOFT (samples
    recovered) but NO supplementary asset -> honest no-primary outcome with
    parsed_datasets=[] and the SOFT-recovered samples preserved. The
    raising-bytes failure must not leak an intermediate series-matrix reason
    (phase 4b T1 review round 3)."""
    from app.pipeline.stages.processing import run_processing

    counts_content = b"this is definitely not a gzip file at all"
    ctx, assets = _make_live_tximport_failure_assets(
        tmp_path, "task_live_txi_raise_none", counts_content
    )

    result = run_processing(ctx, assets, "ds_geo_gse999999")

    assert result.output.parsed_datasets == []
    assert result.output.no_primary_reason == "tximport_parse_failed_no_expression"
    # Samples recovered from the family SOFT are preserved.
    assert len(result.output.samples) == 12
    assert "GSM5388270" in {s.sample_id for s in result.output.samples}
    # No leftover files in the parsed workdir.
    assert list(ctx.workdir.parsed.iterdir()) == []


def test_run_processing_live_tximport_truncated_gzip_lands_no_primary(
    tmp_path: Path,
) -> None:
    """A TRUNCATED gzip counts file raises ``EOFError`` (NOT an ``OSError``)
    mid-stream. The live tximport fallback must treat it like any other parse
    failure: recover SOFT samples and land on the honest no-primary reason —
    never crash the stage (phase 4b T1 caveat, closed in T6)."""
    from app.pipeline.stages.processing import run_processing

    full = gzip.compress(
        (FIXTURE_DIR / "tximport_counts_slice.tsv").read_bytes(), mtime=0
    )
    truncated = full[: max(1, int(len(full) * 0.6))]
    ctx, assets = _make_live_tximport_failure_assets(
        tmp_path, "task_live_txi_trunc", truncated
    )

    result = run_processing(ctx, assets, "ds_geo_gse999999")

    assert result.output.parsed_datasets == []
    assert result.output.no_primary_reason == "tximport_parse_failed_no_expression"
    # Samples recovered from the family SOFT are preserved.
    assert len(result.output.samples) == 12
    assert "GSM5388270" in {s.sample_id for s in result.output.samples}
    # No leftover files in the parsed workdir.
    assert list(ctx.workdir.parsed.iterdir()) == []


def test_run_processing_live_tximport_failure_no_expression_keeps_soft_samples(
    tmp_path: Path,
) -> None:
    """When a live tximport parse fails and the family SOFT yields samples but
    no supplementary expression asset exists, the run must return a no-primary
    output with the honest root-cause reason and keep the SOFT-recovered
    samples on the output (phase 4b T1 review round 2)."""
    from app.pipeline.stages.processing import run_processing

    counts_content = gzip.compress(
        b"not-a-valid-tximport-matrix\trow\n", mtime=0
    )
    ctx, assets = _make_live_tximport_failure_assets(
        tmp_path, "task_live_txi_none", counts_content
    )

    result = run_processing(ctx, assets, "ds_geo_gse999999")

    assert result.output.parsed_datasets == []
    assert result.output.no_primary_reason == "tximport_parse_failed_no_expression"
    # Samples recovered from the family SOFT are preserved.
    assert len(result.output.samples) == 12
    assert "GSM5388270" in {s.sample_id for s in result.output.samples}
    # No leftover placeholder files in the parsed workdir.
    assert list(ctx.workdir.parsed.iterdir()) == []


def test_run_processing_live_tximport_failure_soft_without_samples_no_supplementary(
    tmp_path: Path,
) -> None:
    """When the family SOFT itself yields no usable samples (the SOFT parse
    fails) and no supplementary expression exists, the run must still return
    a no-primary output with the honest reason and no leftover files
    (phase 4b T1 review round 2)."""
    from app.pipeline.stages.processing import run_processing

    counts_content = gzip.compress(
        b"not-a-valid-tximport-matrix\trow\n", mtime=0
    )
    bad_soft = gzip.compress(b'!Series_title\t"no samples"\n', mtime=0)
    ctx, assets = _make_live_tximport_failure_assets(
        tmp_path, "task_live_txi_nosamples", counts_content,
        soft_bytes=bad_soft,
    )

    result = run_processing(ctx, assets, "ds_geo_gse999999")

    assert result.output.parsed_datasets == []
    assert result.output.no_primary_reason == "tximport_parse_failed_no_expression"
    assert result.output.samples == []
    assert list(ctx.workdir.parsed.iterdir()) == []


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
    # No expression data (empty matrix block, no supplementary file) → no
    # parsed primary dataset: parsed_datasets=[] with no_primary_reason
    # (phase 4b T1 — the metadata-only placeholder is gone).
    assert result.output.parsed_datasets == []
    assert (
        result.output.no_primary_reason
        == "series_matrix_expression_empty_and_no_supplementary"
    )
    # Sample metadata was recovered from the series_matrix, not the fixture.
    assert len(result.output.samples) == 2
    assert {s.sample_id for s in result.output.samples} == {
        "GSM9000100", "GSM9000101",
    }
    # No placeholder tximport_long.csv is written for the no-primary path.
    assert list(workdir.parsed.iterdir()) == []


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


# --- series_matrix expression matrix parsing (P0-1) -----------------------
#
# When tximport counts are unavailable (HTTP 404) and the pipeline falls back
# to the series_matrix file, the expression block between
# !series_matrix_table_begin and !series_matrix_table_end must be parsed into
# real expression rows — not just sample metadata.

SERIES_MATRIX_WITH_EXPRESSION = """\
!Series_title\t"Test series with expression data"
!Sample_geo_accession\t"GSM9000200"\t"GSM9000201"
!Sample_title\t"Control rep. 1"\t"Treatment rep. 2"
!Sample_organism_ch1\t"Homo sapiens"\t"Homo sapiens"
!Sample_characteristics_ch1\t"cell line: MCF7"\t"cell line: MCF7"
!Sample_characteristics_ch1\t"treatment: DMSO"\t"treatment: DrugA"
!series_matrix_table_begin
"ID_REF"\t"GSM9000200"\t"GSM9000201"
"BRCA1"\t"5.2"\t"3.1"
"TP53"\t"8.7"\t"6.4"
"GAPDH"\t"12.3"\t"11.9"
!series_matrix_table_end
"""


def _make_series_matrix_asset(
    tmp_path: Path, content: str, task_id: str = "task_expr"
) -> tuple[object, SourceAsset]:
    """Build a StageContext + series_matrix SourceAsset for expression tests."""
    from datetime import UTC, datetime

    from app.pipeline.stages.base import StageContext

    workdir = create_task_workdir(task_id, base_dir=str(tmp_path / task_id))
    matrix_bytes = gzip.compress(content.encode("utf-8"), mtime=0)
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
        successful_attempt_id="attempt_1",
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


def _make_supplementary_asset(
    workdir, content: bytes, *, mismatched_checksum: bool = False
) -> SourceAsset:
    """Build a supplementary expression SourceAsset in *workdir*.

    ``mismatched_checksum=True`` makes the parser raise ValueError (the
    source asset checksum guard) — the "supplementary present but unparsable"
    scenario of phase 4b T1 MUST-FIX 3.
    """
    path = workdir.source_assets / "GSE999999_counts.csv.gz"
    path.write_bytes(content)
    checksum = hashlib.sha256(content).hexdigest()
    if mismatched_checksum:
        checksum = "0" * 64
    return SourceAsset(
        asset_id=f"asset_{checksum}",
        kind="source",
        relative_path="source_assets/GSE999999_counts.csv.gz",
        sha256=checksum,
        size_bytes=len(content),
        media_type="application/gzip",
        source_id="src_geo_gse999999",
        successful_attempt_id="attempt_suppl",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )


def test_series_matrix_expression_parser_removes_file_when_all_values_invalid(
    tmp_path: Path,
) -> None:
    """When every expression value in the series_matrix block is NA/non-numeric
    the parser returns None and must NOT leave a schema-only
    ``<dataset>_series_matrix_long.csv`` on disk (phase 4b T1 MUST-FIX 1)."""
    from app.pipeline.processing.geo_tximport import (
        parse_geo_series_matrix_samples,
        process_geo_series_matrix_expression,
    )

    all_na_matrix = (
        '!Sample_geo_accession\t"GSM9000300"\t"GSM9000301"\n'
        '!Sample_title\t"Ctrl rep. 1"\t"Trt rep. 2"\n'
        '!Sample_organism_ch1\t"Homo sapiens"\t"Homo sapiens"\n'
        '!series_matrix_table_begin\n'
        '"ID_REF"\t"GSM9000300"\t"GSM9000301"\n'
        '"GENE_A"\t"NA"\t"NA"\n'
        '"GENE_B"\t"null"\t"NaN"\n'
        '!series_matrix_table_end\n'
    )
    ctx, source_asset = _make_series_matrix_asset(tmp_path, all_na_matrix, "task_allna")
    compressed = (
        ctx.workdir.source_assets / "GSE999999_series_matrix.txt.gz"
    ).read_bytes()
    samples = parse_geo_series_matrix_samples(compressed)

    result = process_geo_series_matrix_expression(
        source_asset=source_asset,
        dataset_id="ds_geo_allna",
        workdir=ctx.workdir,
        samples=samples,
    )

    assert result is None
    # No schema-only placeholder CSV may remain on disk.
    assert list(ctx.workdir.parsed.iterdir()) == []


def test_supplementary_parser_removes_file_when_all_values_invalid(
    tmp_path: Path,
) -> None:
    """A supplementary expression file whose values are all NA yields None and
    must NOT leave a schema-only ``<dataset>_suppl_expression_long.csv`` on
    disk (phase 4b T1 MUST-FIX 1)."""
    from app.pipeline.processing.geo_tximport import (
        parse_geo_series_matrix_samples,
        process_geo_supplementary_expression,
    )

    ctx, _ = _make_series_matrix_asset(
        tmp_path, SERIES_MATRIX_EMPTY_BLOCK, "task_suppl_clean"
    )
    samples = parse_geo_series_matrix_samples(
        (ctx.workdir.source_assets / "GSE999999_series_matrix.txt.gz").read_bytes()
    )
    suppl_content = gzip.compress(
        b'"gene"\t"GSM9000001"\t"GSM9000002"\n'
        b'"GENE_A"\t"NA"\t"NA"\n'
        b'"GENE_B"\t"null"\t"NaN"\n',
        mtime=0,
    )
    suppl_asset = _make_supplementary_asset(ctx.workdir, suppl_content)

    result = process_geo_supplementary_expression(
        source_asset=suppl_asset,
        dataset_id="ds_geo_suppl",
        workdir=ctx.workdir,
        samples=samples,
    )

    assert result is None
    assert list(ctx.workdir.parsed.iterdir()) == []


def test_supplementary_present_but_empty_yields_honest_reason(
    tmp_path: Path,
) -> None:
    """When a supplementary asset EXISTS but yields no rows the no-primary
    reason must NOT claim 'no supplementary file' (phase 4b T1 MUST-FIX 3)."""
    from app.pipeline.stages.processing import (
        _try_series_matrix_expression_or_minimal,
    )

    ctx, source_asset = _make_no_expression_ctx(tmp_path, "task_suppl_empty")
    compressed = (
        ctx.workdir.source_assets / "GSE999999_series_matrix.txt.gz"
    ).read_bytes()
    samples = parse_geo_series_matrix_samples(compressed)
    suppl_content = gzip.compress(
        b'"gene"\t"GSM9000001"\t"GSM9000002"\n"GENE_A"\t"NA"\t"NA"\n',
        mtime=0,
    )
    suppl_asset = _make_supplementary_asset(ctx.workdir, suppl_content)

    parsed, reason = _try_series_matrix_expression_or_minimal(
        source_asset, "ds_geo_test", ctx, samples, suppl_asset=suppl_asset
    )

    assert parsed is None
    assert reason == "series_matrix_expression_empty_and_supplementary_empty"
    # The empty supplementary file must not leave a schema-only CSV behind.
    assert list(ctx.workdir.parsed.iterdir()) == []


def test_supplementary_unparsable_yields_honest_reason(tmp_path: Path) -> None:
    """When a supplementary asset EXISTS but fails to parse the no-primary
    reason must distinguish it from both 'no supplementary file' and
    'supplementary present but empty' (phase 4b T1 MUST-FIX 3)."""
    from app.pipeline.stages.processing import (
        _try_series_matrix_expression_or_minimal,
    )

    ctx, source_asset = _make_no_expression_ctx(tmp_path, "task_suppl_bad")
    compressed = (
        ctx.workdir.source_assets / "GSE999999_series_matrix.txt.gz"
    ).read_bytes()
    samples = parse_geo_series_matrix_samples(compressed)
    suppl_content = gzip.compress(
        b'"gene"\t"GSM9000001"\n"GENE_A"\t"1.0"\n', mtime=0
    )
    suppl_asset = _make_supplementary_asset(
        ctx.workdir, suppl_content, mismatched_checksum=True
    )

    parsed, reason = _try_series_matrix_expression_or_minimal(
        source_asset, "ds_geo_test", ctx, samples, suppl_asset=suppl_asset
    )

    assert parsed is None
    assert reason == "series_matrix_expression_empty_and_supplementary_unparsable"


def test_supplementary_expression_attempted_without_samples(tmp_path: Path) -> None:
    """Supplementary expression recovery must be attempted even when NO
    samples are available: the supplementary parser maps GSM columns directly
    and does not require sample metadata, so the empty-samples early exit
    must not block it (phase 4b T1 review round 2)."""
    from app.pipeline.stages.processing import (
        _try_series_matrix_expression_or_minimal,
    )

    ctx, source_asset = _make_no_expression_ctx(tmp_path, "task_suppl_nosamples")
    suppl_content = gzip.compress(
        b'"gene"\t"GSM9000001"\t"GSM9000002"\n'
        b'"GENE_A"\t"5.0"\t"6.0"\n'
        b'"GENE_B"\t"7.0"\t"8.0"\n',
        mtime=0,
    )
    suppl_asset = _make_supplementary_asset(ctx.workdir, suppl_content)

    parsed, reason = _try_series_matrix_expression_or_minimal(
        source_asset, "ds_geo_test", ctx, [], suppl_asset=suppl_asset
    )

    assert parsed is not None
    assert reason is None
    assert parsed.row_count == 4  # 2 genes x 2 GSM columns, no samples needed
    assert parsed.parser_name == "geo_supplementary_expression"


def test_series_matrix_expression_parser_extracts_real_expression_rows(
    tmp_path: Path,
) -> None:
    """A non-empty expression block must yield real expression rows, not
    metadata-only placeholders."""
    from app.pipeline.processing.geo_tximport import (
        parse_geo_series_matrix_samples,
        process_geo_series_matrix_expression,
    )

    ctx, source_asset = _make_series_matrix_asset(
        tmp_path, SERIES_MATRIX_WITH_EXPRESSION
    )
    compressed = (ctx.workdir.source_assets / "GSE999999_series_matrix.txt.gz").read_bytes()
    samples = parse_geo_series_matrix_samples(compressed)

    result = process_geo_series_matrix_expression(
        source_asset=source_asset,
        dataset_id="ds_geo_test",
        workdir=ctx.workdir,
        samples=samples,
    )

    assert result is not None
    assert result.row_count == 6  # 3 genes × 2 samples
    assert result.parser_name == "geo_series_matrix_expression"
    assert result.source_row_count == 3  # 3 gene rows in the source

    output_path = ctx.workdir.root / result.file_asset.relative_path
    with output_path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))

    assert len(rows) == 6
    # All rows are expression rows, not sample_metadata
    assert all(r["measurement_type"] == "series_matrix_expression" for r in rows)
    # Expression values are populated
    assert all(r["expression_value"] != "" for r in rows)
    assert all(r["gene_id_raw"] != "" for r in rows)
    # Sample IDs are correct
    assert {r["sample_id"] for r in rows} == {"GSM9000200", "GSM9000201"}
    # Gene IDs are correct
    assert {r["gene_id_raw"] for r in rows} == {"BRCA1", "TP53", "GAPDH"}
    # Source coordinates are populated (not 0 sentinel)
    assert all(int(r["source_line_number"]) > 0 for r in rows)
    assert all(int(r["source_column_index"]) > 0 for r in rows)
    # source_raw_value matches expression_value
    assert all(r["source_raw_value"] == r["expression_value"] for r in rows)
    # First row: BRCA1 × GSM9000200 = 5.2
    first = rows[0]
    assert first["gene_id_raw"] == "BRCA1"
    assert first["sample_id"] == "GSM9000200"
    assert first["expression_value"] == "5.2"
    assert first["value_scale"] == "log2"
    assert first["is_normalized"] == "true"


def test_series_matrix_expression_parser_returns_none_for_empty_block(
    tmp_path: Path,
) -> None:
    """An empty expression block (only header, no data rows) must return None
    so the caller falls back to sample_metadata rows."""
    from app.pipeline.processing.geo_tximport import (
        parse_geo_series_matrix_samples,
        process_geo_series_matrix_expression,
    )

    ctx, source_asset = _make_series_matrix_asset(
        tmp_path, SERIES_MATRIX_EMPTY_BLOCK
    )
    compressed = (ctx.workdir.source_assets / "GSE999999_series_matrix.txt.gz").read_bytes()
    samples = parse_geo_series_matrix_samples(compressed)

    result = process_geo_series_matrix_expression(
        source_asset=source_asset,
        dataset_id="ds_geo_test",
        workdir=ctx.workdir,
        samples=samples,
    )

    assert result is None


def test_series_matrix_expression_parser_skips_na_values(
    tmp_path: Path,
) -> None:
    """NA/null/NaN values in the expression matrix must be skipped, not
    written as expression rows."""
    from app.pipeline.processing.geo_tximport import (
        parse_geo_series_matrix_samples,
        process_geo_series_matrix_expression,
    )

    matrix_with_na = (
        '!Sample_geo_accession\t"GSM9000300"\t"GSM9000301"\n'
        '!Sample_title\t"Ctrl rep. 1"\t"Trt rep. 2"\n'
        '!Sample_organism_ch1\t"Homo sapiens"\t"Homo sapiens"\n'
        '!series_matrix_table_begin\n'
        '"ID_REF"\t"GSM9000300"\t"GSM9000301"\n'
        '"GENE_A"\t"5.0"\t"NA"\n'
        '"GENE_B"\t"null"\t"3.0"\n'
        '!series_matrix_table_end\n'
    )
    ctx, source_asset = _make_series_matrix_asset(tmp_path, matrix_with_na, "task_na")
    compressed = (ctx.workdir.source_assets / "GSE999999_series_matrix.txt.gz").read_bytes()
    samples = parse_geo_series_matrix_samples(compressed)

    result = process_geo_series_matrix_expression(
        source_asset=source_asset,
        dataset_id="ds_geo_na",
        workdir=ctx.workdir,
        samples=samples,
    )

    assert result is not None
    # 2 genes × 2 samples = 4, but 2 are NA/null → 2 real rows
    assert result.row_count == 2
    output_path = ctx.workdir.root / result.file_asset.relative_path
    with output_path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    # Only non-NA values
    assert {r["expression_value"] for r in rows} == {"5.0", "3.0"}


def test_run_processing_live_mode_uses_series_matrix_expression(
    tmp_path: Path,
) -> None:
    """In live mode, when tximport counts are unavailable and the pipeline
    falls back to a series_matrix with a non-empty expression block, the
    parsed dataset must contain real expression rows (not sample_metadata)."""
    import gzip as _gzip
    from datetime import UTC, datetime

    from app.pipeline.stages.base import StageContext
    from app.pipeline.stages.processing import run_processing

    workdir = create_task_workdir(
        "task_live_expr", base_dir=str(tmp_path / "task_live_expr")
    )

    matrix = (
        '!Series_title\t"Live series with expression"\n'
        '!Sample_geo_accession\t"GSM9000400"\t"GSM9000401"\n'
        '!Sample_title\t"Control rep. 1"\t"Treatment rep. 2"\n'
        '!Sample_organism_ch1\t"Homo sapiens"\t"Homo sapiens"\n'
        '!Sample_characteristics_ch1\t"cell line: MCF7"\t"cell line: MCF7"\n'
        '!Sample_characteristics_ch1\t"treatment: DMSO"\t"treatment: DrugA"\n'
        '!series_matrix_table_begin\n'
        '"ID_REF"\t"GSM9000400"\t"GSM9000401"\n'
        '"BRCA1"\t"5.2"\t"3.1"\n'
        '"TP53"\t"8.7"\t"6.4"\n'
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

    ctx = StageContext(
        task_id="task_live_expr",
        workdir=workdir,
        fixture_dir=tmp_path,
        topic="live",
        databases=["geo"],
        started_at=datetime.now(tz=UTC),
        mode="live",
    )

    result = run_processing(ctx, source_asset, "ds_geo_live_expr")

    parsed = result.output.parsed_datasets[0]
    # Real expression rows, not sample_metadata
    assert parsed.row_count == 4  # 2 genes × 2 samples
    assert parsed.parser_name == "geo_series_matrix_expression"
    assert parsed.processing_parameters["measurement_type"] == "series_matrix_expression"
    assert parsed.source_row_count == 2  # 2 gene rows in source

    output_path = workdir.root / parsed.file_asset.relative_path
    with output_path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))

    assert len(rows) == 4
    assert all(r["measurement_type"] == "series_matrix_expression" for r in rows)
    assert all(r["expression_value"] != "" for r in rows)
    assert {r["gene_id_raw"] for r in rows} == {"BRCA1", "TP53"}
    assert {r["sample_id"] for r in rows} == {"GSM9000400", "GSM9000401"}


# --- probe → gene mapping (P0-1, 0805) ------------------------------------
#
# A GEO platform annotation (geo_annotation.parse_platform_annotation) can
# rewrite probe IDs to gene symbols. The expression parser must:
#   * write gene_id = mapped symbol + gene_id_namespace="gene_symbol" for
#     probes found in the map,
#   * keep gene_id = raw probe + "geo_id_ref" for unmatched probes,
#   * record the annotation status in processing_parameters.probe_gene_mapping.

PROBE_MATRIX = """\
!Series_title\t"Probe-level series"
!Sample_geo_accession\t"GSM9000500"\t"GSM9000501"
!Sample_title\t"Control rep. 1"\t"Treatment rep. 2"
!Sample_organism_ch1\t"Homo sapiens"\t"Homo sapiens"
!series_matrix_table_begin
"ID_REF"\t"GSM9000500"\t"GSM9000501"
"A_19_P00000001"\t"5.2"\t"3.1"
"A_19_P00000002"\t"8.7"\t"6.4"
"A_19_P00000009"\t"1.1"\t"2.2"
!series_matrix_table_end
"""


def test_series_matrix_expression_rewrites_mapped_probes_to_gene_symbols(
    tmp_path: Path,
) -> None:
    from app.pipeline.processing.geo_tximport import (
        parse_geo_series_matrix_samples,
        process_geo_series_matrix_expression,
    )

    ctx, source_asset = _make_series_matrix_asset(tmp_path, PROBE_MATRIX, "task_probe")
    compressed = (ctx.workdir.source_assets / "GSE999999_series_matrix.txt.gz").read_bytes()
    samples = parse_geo_series_matrix_samples(compressed)
    gene_map = {"A_19_P00000001": "METTL5", "A_19_P00000002": "BRCA1"}

    result = process_geo_series_matrix_expression(
        source_asset=source_asset,
        dataset_id="ds_geo_probe",
        workdir=ctx.workdir,
        samples=samples,
        gene_map=gene_map,
        probe_gene_mapping="mapped",
    )

    assert result is not None
    assert result.processing_parameters["probe_gene_mapping"] == "mapped"
    assert result.processing_parameters["gene_id_namespace"] == (
        "mixed_geo_probe_gene_symbol"
    )
    output_path = ctx.workdir.root / result.file_asset.relative_path
    with output_path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    by_probe = {row["gene_id_raw"]: row for row in rows}
    # Mapped probes keep their raw ID in gene_id_raw but expose the symbol.
    assert by_probe["A_19_P00000001"]["gene_id"] == "METTL5"
    assert by_probe["A_19_P00000001"]["gene_id_namespace"] == "gene_symbol"
    assert by_probe["A_19_P00000002"]["gene_id"] == "BRCA1"
    assert by_probe["A_19_P00000002"]["gene_id_namespace"] == "gene_symbol"
    # Unmatched probe stays probe-level.
    assert by_probe["A_19_P00000009"]["gene_id"] == "A_19_P00000009"
    assert by_probe["A_19_P00000009"]["gene_id_namespace"] == "geo_id_ref"


def test_series_matrix_expression_keeps_probes_without_gene_map(
    tmp_path: Path,
) -> None:
    from app.pipeline.processing.geo_tximport import (
        parse_geo_series_matrix_samples,
        process_geo_series_matrix_expression,
    )

    ctx, source_asset = _make_series_matrix_asset(tmp_path, PROBE_MATRIX, "task_nomap")
    compressed = (ctx.workdir.source_assets / "GSE999999_series_matrix.txt.gz").read_bytes()
    samples = parse_geo_series_matrix_samples(compressed)

    result = process_geo_series_matrix_expression(
        source_asset=source_asset,
        dataset_id="ds_geo_nomap",
        workdir=ctx.workdir,
        samples=samples,
        gene_map=None,
        probe_gene_mapping="unmapped",
    )

    assert result is not None
    assert result.processing_parameters["probe_gene_mapping"] == "unmapped"
    assert result.processing_parameters["gene_id_namespace"] == "geo_id_ref"
    output_path = ctx.workdir.root / result.file_asset.relative_path
    with output_path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert all(r["gene_id"] == r["gene_id_raw"] for r in rows)
    assert all(r["gene_id_namespace"] == "geo_id_ref" for r in rows)
