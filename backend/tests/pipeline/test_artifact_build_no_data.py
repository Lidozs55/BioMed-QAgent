"""Phase 4b T2: artifact build NO_DATA branch.

A processing output with no primary parsed dataset (``parsed_datasets=[]`` +
``no_primary_reason``, T1) must build a supporting/audit package instead of a
fake metadata-only ``main_data.csv`` (ADR-011): NO ``main_data.csv`` is
written, ``sample_metadata.csv`` derives from the recovered samples list,
the audit CSVs are still built, and a ``warn_no_expression_data`` warning
whose copy carries the recorded reason lands in ``warnings.csv`` (folded
into ``processing_log.csv`` so ``warnings_metrics_consistency`` stays
satisfied). Normal expression packages must keep the historic artifact set
byte-identical — no ``no_expression_data`` warning, ``main_data.csv``
present.
"""
from __future__ import annotations

import csv
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

from app.domain.contracts import (
    Database,
    DataLevel,
    DatasetSelection,
    FileAsset,
    ParsedDataset,
    SourceAsset,
    SourceRecord,
    TaskSpecification,
    asset_id_from_sha256,
)
from app.pipeline.processing.geo_tximport import GeoSampleMetadata
from app.pipeline.stages.artifact_build.builder import run_artifact_build
from app.pipeline.stages.base import CleaningReportModel, StageContext
from app.tools.workdir import create_task_workdir

_NO_DATA_REASON = "series_matrix_expression_empty_and_no_supplementary"


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def _stage_context(tmp_path: Path) -> StageContext:
    return StageContext(
        task_id="task_no_data_build",
        workdir=create_task_workdir(
            "task_no_data_build", base_dir=str(tmp_path / "tasks")
        ),
        fixture_dir=tmp_path,
        topic="GSE999999",
        started_at=datetime.now(UTC),
        mode="fixture",
        databases=["geo"],
        specification=TaskSpecification(
            topic="GSE999999",
            datasets=[
                DatasetSelection(
                    dataset_id="ds_gse999999",
                    database=Database.GEO,
                    accession="GSE999999",
                    reason="explicit",
                    source_id="src_geo_gse999999",
                )
            ],
        ),
    )


def _geo_source(
    ctx: StageContext, now: datetime
) -> tuple[SourceRecord, SourceAsset]:
    source_asset = SourceAsset(
        asset_id=asset_id_from_sha256("d" * 64),
        kind="source",
        relative_path="source_assets/GSE999999_series_matrix.txt.gz",
        sha256="d" * 64,
        size_bytes=2316,
        media_type="application/gzip",
        source_id="src_geo_gse999999",
        successful_attempt_id="attempt_matrix",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    source_record = SourceRecord(
        source_id="src_geo_gse999999",
        database=Database.GEO,
        accession="GSE999999",
        url="https://ftp.ncbi.nlm.nih.gov/geo/series/GSE999nnn/GSE999999/matrix/GSE999999_series_matrix.txt.gz",
        title="GSE999999 series matrix",
        retrieved_at=now,
    )
    return source_record, source_asset


def _samples() -> list[GeoSampleMetadata]:
    return [
        GeoSampleMetadata(
            sample_id="GSM9999991",
            source_alias="S1",
            cell_line_raw="",
            cell_line_canonical="",
            normalization_rule="",
            treatment="control",
            replicate=1,
            organism="Homo sapiens",
        ),
        GeoSampleMetadata(
            sample_id="GSM9999992",
            source_alias="S2",
            cell_line_raw="",
            cell_line_canonical="",
            normalization_rule="",
            treatment="treated",
            replicate=1,
            organism="Homo sapiens",
        ),
    ]


def _build_no_data(
    ctx: StageContext,
    now: datetime,
    *,
    samples: list[GeoSampleMetadata] | None = None,
    cleaning_report: CleaningReportModel | None = None,
    no_primary_reason: str | None = _NO_DATA_REASON,
) -> object:
    source_record, source_asset = _geo_source(ctx, now)
    return run_artifact_build(
        ctx=ctx,
        sources=[source_record],
        source_assets=[source_asset],
        download_attempts=[],
        parsed_dataset=None,
        parsed_datasets=[],
        no_primary_reason=no_primary_reason,
        samples=samples if samples is not None else _samples(),
        literature=None,
        geo=None,
        specification=ctx.specification,
        retrieved_at=now,
        stage_attempt_id="attempt_build",
        dataset_id="ds_gse999999",
        dataset_source_id="src_geo_gse999999",
        dataset_accession="GSE999999",
        cleaning_report=cleaning_report,
    )


def test_no_primary_build_writes_no_main_data_and_supporting_package(
    tmp_path: Path,
) -> None:
    """A no-primary input must NOT write ``main_data.csv`` (ADR-011) and must
    still build the supporting + audit package (sample_metadata.csv from the
    recovered samples, source/audit CSVs, warnings.csv with the reason)."""
    ctx = _stage_context(tmp_path)
    result = _build_no_data(ctx, datetime.now(UTC))
    staging = result.output.staging_dir

    # No fake primary table: an empty-table package must never publish one.
    assert not (staging / "main_data.csv").exists()

    # Supporting + audit artifact set is still built.
    for name in (
        "sample_metadata.csv",
        "dataset_catalog.csv",
        "source_list.csv",
        "source_assets.csv",
        "source_relations.csv",
        "field_descriptions.csv",
        "field_mapping.csv",
        "cleaning_report.csv",
        "processing_log.csv",
        "download_log.csv",
        "warnings.csv",
    ):
        assert (staging / name).is_file(), f"missing artifact: {name}"

    # sample_metadata.csv derives from the recovered samples list.
    sample_rows = _read_csv(staging / "sample_metadata.csv")
    assert {row["sample_id"] for row in sample_rows} == {
        "GSM9999991",
        "GSM9999992",
    }
    assert {row["source_sample_alias"] for row in sample_rows} == {"S1", "S2"}
    assert all(row["dataset_id"] == "ds_gse999999" for row in sample_rows)
    assert all(row["source_id"] == "src_geo_gse999999" for row in sample_rows)

    # warnings.csv carries warn_no_expression_data with the recorded reason.
    warnings_rows = _read_csv(staging / "warnings.csv")
    no_expr = [w for w in warnings_rows if w.get("code") == "no_expression_data"]
    assert len(no_expr) == 1
    assert no_expr[0]["severity"] == "warning"
    assert _NO_DATA_REASON in no_expr[0]["message"]

    # The ArtifactBuildOutput signals the NO_DATA package + reason.
    assert result.output.no_primary_reason == _NO_DATA_REASON

    # No target-gene subset artifact can exist without a main table.
    assert not [
        p for p in staging.iterdir() if p.name.endswith("_expression.csv")
    ]


def test_no_primary_sample_metadata_uses_recovered_samples_not_parsed_rows(
    tmp_path: Path,
) -> None:
    """With no primary there is no parsed long-form file at all — the
    sample_metadata rows can only come from the samples list (the parsed-rows
    fallback must not be attempted)."""
    ctx = _stage_context(tmp_path)
    result = _build_no_data(ctx, datetime.now(UTC))
    staging = result.output.staging_dir
    # Nothing was parsed by processing: no parsed file exists anywhere.
    assert list(ctx.workdir.parsed.iterdir()) == []

    sample_rows = _read_csv(staging / "sample_metadata.csv")
    by_id = {row["sample_id"]: row for row in sample_rows}
    assert by_id["GSM9999991"]["treatment"] == "control"
    assert by_id["GSM9999992"]["treatment"] == "treated"
    assert by_id["GSM9999991"]["organism"] == "Homo sapiens"
    assert by_id["GSM9999991"]["replicate"] == "1"


def test_no_primary_build_without_samples_still_builds_package(
    tmp_path: Path,
) -> None:
    """samples=[] must not crash: the parsed-rows fallback needs a parsed file
    which does not exist in NO_DATA mode, so sample_metadata.csv is
    header-only."""
    ctx = _stage_context(tmp_path)
    result = _build_no_data(ctx, datetime.now(UTC), samples=[])
    staging = result.output.staging_dir
    assert (staging / "sample_metadata.csv").is_file()
    assert _read_csv(staging / "sample_metadata.csv") == []
    assert not (staging / "main_data.csv").exists()


def test_no_primary_warning_does_not_fire_for_normal_package(
    tmp_path: Path,
) -> None:
    """A real-expression package keeps the historic artifact set: main_data.csv
    is written and no ``no_expression_data`` warning appears."""
    ctx = _stage_context(tmp_path)
    now = datetime.now(UTC)
    primary = _normal_primary(ctx)
    source_record, source_asset = _geo_source(ctx, now)
    result = run_artifact_build(
        ctx=ctx,
        sources=[source_record],
        source_assets=[source_asset],
        download_attempts=[],
        parsed_dataset=primary,
        parsed_datasets=[],
        samples=[],
        literature=None,
        geo=None,
        specification=ctx.specification,
        retrieved_at=now,
        stage_attempt_id="attempt_build",
        dataset_id="ds_gse999999",
        dataset_source_id="src_geo_gse999999",
        dataset_accession="GSE999999",
    )
    staging = result.output.staging_dir
    assert (staging / "main_data.csv").is_file()
    warnings_rows = _read_csv(staging / "warnings.csv")
    assert not [w for w in warnings_rows if w.get("code") == "no_expression_data"]
    assert result.output.no_primary_reason is None


def test_no_primary_build_folds_warning_into_processing_log(tmp_path: Path) -> None:
    """The no_expression_data warning must be folded into processing_log.csv
    (plus cleaning entries) so ``warnings_metrics_consistency`` stays
    satisfied, exactly like the historic metadata-only package did."""
    ctx = _stage_context(tmp_path)
    result = _build_no_data(
        ctx,
        datetime.now(UTC),
        cleaning_report=CleaningReportModel(missing_stats={"gene_id": 2}),
    )
    staging = result.output.staging_dir

    cleaning_rows = _read_csv(staging / "cleaning_report.csv")
    assert any("gene_id" in row.get("message", "") for row in cleaning_rows)

    warnings_rows = _read_csv(staging / "warnings.csv")
    assert any(w.get("code") == "missing_values" for w in warnings_rows)

    proc_rows = _read_csv(staging / "processing_log.csv")
    assert any(row.get("operation") == "no_primary" for row in proc_rows)
    logged = sum(len(json.loads(p.get("warnings", "[]"))) for p in proc_rows)
    assert logged == len(warnings_rows)


def test_no_primary_build_with_derived_source_asset_does_not_crash(
    tmp_path: Path,
) -> None:
    """T2 MUST-FIX 1: ``_build_processing_log_rows`` builds one audit row per
    derived source asset and dereferences ``primary.source_row_count`` for
    every such row before the ``primary is None`` branch — a NO_DATA package
    with a ``derived_from_asset_id`` source asset crashes. The derived-asset
    (reactome) rows cannot exist without a primary, so they must be skipped
    cleanly: the synthetic ``no_primary`` row is the ONLY processing_log row,
    no ``main_data.csv`` is written, and the build succeeds."""
    ctx = _stage_context(tmp_path)
    now = datetime.now(UTC)
    source_record, _ = _geo_source(ctx, now)
    derived_asset = SourceAsset(
        asset_id=asset_id_from_sha256("e" * 64),
        kind="source",
        relative_path="source_assets/GSE999999_reactome_participants.json",
        sha256="e" * 64,
        size_bytes=1024,
        media_type="application/json",
        source_id="src_geo_gse999999",
        derived_from_asset_id=asset_id_from_sha256("d" * 64),
        generated_by_step_id="step_reactome_json_to_tsv",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    result = run_artifact_build(
        ctx=ctx,
        sources=[source_record],
        source_assets=[derived_asset],
        download_attempts=[],
        parsed_dataset=None,
        parsed_datasets=[],
        no_primary_reason=_NO_DATA_REASON,
        samples=_samples(),
        literature=None,
        geo=None,
        specification=ctx.specification,
        retrieved_at=now,
        stage_attempt_id="attempt_build",
        dataset_id="ds_gse999999",
        dataset_source_id="src_geo_gse999999",
        dataset_accession="GSE999999",
    )
    staging = result.output.staging_dir
    assert not (staging / "main_data.csv").exists()
    proc_rows = _read_csv(staging / "processing_log.csv")
    # The reactome derived-step row must not appear (it is primary-dependent
    # and no primary exists): the no_primary row is the only row.
    assert [row["operation"] for row in proc_rows] == ["no_primary"]
    assert result.output.no_primary_reason == _NO_DATA_REASON


def test_no_primary_reason_defaults_to_no_expression_data(tmp_path: Path) -> None:
    """T2 MUST-FIX 3: the ``ArtifactBuildOutput.no_primary_reason`` contract is
    non-None iff NO_DATA. When a NO_DATA call omits the explicit reason the
    output must default to ``"no_expression_data"`` (the same fallback the
    warning copy uses), never None."""
    ctx = _stage_context(tmp_path)
    result = _build_no_data(ctx, datetime.now(UTC), no_primary_reason=None)
    assert result.output.no_primary_reason == "no_expression_data"
    # The warning copy uses the same fallback.
    staging = result.output.staging_dir
    warnings_rows = _read_csv(staging / "warnings.csv")
    no_expr = [w for w in warnings_rows if w.get("code") == "no_expression_data"]
    assert len(no_expr) == 1
    assert "no_expression_data" in no_expr[0]["message"]


def _normal_primary(ctx: StageContext) -> ParsedDataset:
    """A minimal real-expression parsed dataset with its long-form file."""
    parsed_path = ctx.workdir.parsed / "ds_gse999999_tximport_long.csv"
    parsed_path.write_text(
        "record_id,dataset_id,source_id,asset_id,gene_id,sample_id,expression_value\n"
        "r1,ds_gse999999,src_geo_gse999999,asset_a,GENE1,GSM9999991,1.0\n",
        encoding="utf-8",
    )
    checksum = hashlib.sha256(parsed_path.read_bytes()).hexdigest()
    return ParsedDataset(
        dataset_id="ds_gse999999",
        source_id="src_geo_gse999999",
        source_asset_id="asset_series_matrix",
        file_asset=FileAsset(
            asset_id=asset_id_from_sha256(checksum),
            kind="parsed",
            relative_path=parsed_path.relative_to(ctx.workdir.root).as_posix(),
            sha256=checksum,
            size_bytes=parsed_path.stat().st_size,
            media_type="text/csv",
            generated_by_step_id="step_geo_series_matrix_v1",
        ),
        columns=[
            "record_id", "dataset_id", "source_id", "asset_id",
            "gene_id", "sample_id", "expression_value",
        ],
        row_count=1,
        parser_name="geo_series_matrix_expression",
        parser_version="1.0.0",
        source_row_count=1,
        processing_parameters={"measurement_type": "series_matrix_expression"},
    )
