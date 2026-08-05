"""Regression tests: metadata-only GEO packages (GSE339404 case, 0805).

A GEO series whose series_matrix expression block is empty and whose
supplementary files carry no expression matrix legitimately produces a
metadata-only ``main_data.csv``: one row per sample with
``value_semantics="metadata_only"``. 0805 fixes two defects exposed by
GSE339404:

1. ``check_core_data_existence`` rejected such packages because the fixed
   22-column schema still declares empty ``expression_value`` / ``gene_id``
   columns (non-empty rate 0% < 10%) — the check now accepts packages that
   explicitly declare ``value_semantics="metadata_only"`` on every row while
   still rejecting packages that *claim* expression but are 100% blank.
2. The artifact builder emitted no signal telling the Agent *why* the
   artifact is metadata-only, so the Agent kept retrying the same dataset.
   A ``no_expression_data`` warning is now injected into ``warnings.csv``
   (and folded into ``processing_log.csv`` so
   ``warnings_metrics_consistency`` stays satisfied).
"""
from __future__ import annotations

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
from app.pipeline.stages.artifact_build.builder import run_artifact_build
from app.pipeline.stages.base import StageContext
from app.pipeline.stages.validation.checks.main_data import (
    check_core_data_existence,
)
from app.pipeline.stages.validation.checks_common import ValidationContext
from app.tools.workdir import create_task_workdir


def _metadata_only_row(**overrides: str) -> dict[str, str]:
    row = {
        "dataset_id": "ds_gse339404",
        "sample_id": "GSM1234567",
        "source_id": "src_geo_gse339404",
        "asset_id": "asset_series_matrix",
        "value_semantics": "metadata_only",
        "measurement_type": "sample_metadata",
        "expression_value": "",
        "gene_id": "",
    }
    row.update(overrides)
    return row


def _ctx_with_main_rows(
    main_rows: list[dict[str, str]],
    tmp_path: Path,
) -> ValidationContext:
    return ValidationContext(
        staging=tmp_path / "staging",
        source_path=tmp_path / "src",
        report_path=tmp_path / "report.json",
        max_lineage_checks=50,
        main_path=tmp_path / "main_data.csv",
        main_rows=main_rows,
        dataset_rows=[],
        dataset_ids=set(),
        datasets_by_id={},
        sample_rows=[],
        sample_ids=set(),
        samples_by_id={},
        source_list_rows=[],
        source_ids=set(),
        sources_by_id={},
        asset_rows=[],
        asset_ids=set(),
        assets_by_id={},
        download_rows=[],
        attempts_by_id={},
        described=set(),
        reactome_rows=False,
        source_rel_base=tmp_path,
    )


def test_core_data_existence_accepts_metadata_only_rows(tmp_path: Path) -> None:
    """A package whose rows all declare ``value_semantics="metadata_only"``
    must pass — the blank ``expression_value``/``gene_id`` cells are by
    design (GSE339404 regression).
    """
    rows = [
        _metadata_only_row(sample_id="GSM1234567"),
        _metadata_only_row(sample_id="GSM1234568"),
    ]
    result = check_core_data_existence(_ctx_with_main_rows(rows, tmp_path))
    assert result["status"] == "passed"
    assert "metadata-only" in str(result["details"])
    assert result["failed_count"] == 0


def test_core_data_existence_still_rejects_blank_expression_package(
    tmp_path: Path,
) -> None:
    """The 0803 gate must keep rejecting packages that claim expression but
    ship 100% blank values (download-failure placeholders).
    """
    rows = [
        _metadata_only_row(sample_id="GSM1234567", value_semantics="estimated_count"),
        _metadata_only_row(sample_id="GSM1234568", value_semantics="estimated_count"),
    ]
    result = check_core_data_existence(_ctx_with_main_rows(rows, tmp_path))
    assert result["status"] == "failed"
    assert result["failed_count"] == 1


def test_core_data_existence_rejects_partial_expression_package(
    tmp_path: Path,
) -> None:
    """A package mixing metadata-only rows with expression rows that leave
    ``gene_id`` blank still fails: it claims expression data but cannot
    satisfy the gene-id non-empty rate.
    """
    rows = [
        _metadata_only_row(
            sample_id="GSM1234567",
            value_semantics="estimated_count",
            expression_value="1.5",
        ),
        _metadata_only_row(sample_id="GSM1234568"),
    ]
    result = check_core_data_existence(_ctx_with_main_rows(rows, tmp_path))
    assert result["status"] == "failed"


def _minimal_primary(ctx: StageContext) -> ParsedDataset:
    parsed_path = ctx.workdir.parsed / "ds_gse_minimal_tximport_long.csv"
    parsed_path.write_text("record_id\nr1\n", encoding="utf-8")
    checksum = hashlib.sha256(parsed_path.read_bytes()).hexdigest()
    return ParsedDataset(
        dataset_id="ds_gse_minimal",
        source_id="src_geo_gse339404",
        source_asset_id="asset_series_matrix",
        file_asset=FileAsset(
            asset_id=asset_id_from_sha256(checksum),
            kind="parsed",
            relative_path=parsed_path.relative_to(ctx.workdir.root).as_posix(),
            sha256=checksum,
            size_bytes=parsed_path.stat().st_size,
            media_type="text/csv",
            generated_by_step_id="step_geo_minimal_v1",
        ),
        columns=["record_id"],
        row_count=1,
        parser_name="geo_minimal_placeholder",
        parser_version="1.0.0",
        source_row_count=0,
        processing_parameters={"measurement_type": "sample_metadata"},
    )


def _minimal_specification() -> TaskSpecification:
    return TaskSpecification(
        topic="GSE339404",
        datasets=[
            DatasetSelection(
                dataset_id="ds_gse_minimal",
                database=Database.GEO,
                accession="GSE339404",
                reason="explicit",
                source_id="src_geo_gse339404",
            )
        ],
    )


def _minimal_stage_context(tmp_path: Path) -> StageContext:
    return StageContext(
        task_id="task_minimal_build",
        workdir=create_task_workdir(
            "task_minimal_build", base_dir=str(tmp_path / "tasks")
        ),
        fixture_dir=tmp_path,
        topic="GSE339404",
        started_at=datetime.now(UTC),
        mode="fixture",
        databases=["geo"],
        specification=_minimal_specification(),
    )


def test_builder_adds_no_expression_data_warning_for_metadata_only_package(
    tmp_path: Path,
) -> None:
    """The artifact builder must inject a ``no_expression_data`` warning for a
    metadata-only package, and processing_log must fold it in so
    ``warnings_metrics_consistency`` stays satisfied.
    """
    ctx = _minimal_stage_context(tmp_path)
    primary = _minimal_primary(ctx)
    now = datetime.now(UTC)
    source_asset = SourceAsset(
        asset_id=asset_id_from_sha256("b" * 64),
        kind="source",
        relative_path="source_assets/series_matrix.txt.gz",
        sha256="b" * 64,
        size_bytes=2316,
        media_type="application/gzip",
        source_id="src_geo_gse339404",
        successful_attempt_id="attempt_series_matrix",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    source_record = SourceRecord(
        source_id="src_geo_gse339404",
        database=Database.GEO,
        accession="GSE339404",
        url="https://ftp.ncbi.nlm.nih.gov/geo/series/GSE339nnn/GSE339404/matrix/GSE339404_series_matrix.txt.gz",
        title="GSE339404 series matrix",
        retrieved_at=now,
    )
    result = run_artifact_build(
        ctx=ctx,
        sources=[source_record],
        source_assets=[source_asset],
        download_attempts=[],
        parsed_dataset=primary,
        samples=[],
        literature=None,
        geo=None,
        specification=ctx.specification,
        retrieved_at=now,
        stage_attempt_id="attempt_build",
        dataset_id="ds_gse_minimal",
        dataset_source_id="src_geo_gse339404",
        dataset_accession="GSE339404",
    )
    staging = result.output.staging_dir
    warnings_rows = _read_csv(staging / "warnings.csv")
    no_expr = [w for w in warnings_rows if w.get("code") == "no_expression_data"]
    assert len(no_expr) == 1
    assert no_expr[0]["severity"] == "warning"
    assert "GSE339404" in no_expr[0]["message"]

    proc_rows = _read_csv(staging / "processing_log.csv")
    logged = sum(len(json.loads(p.get("warnings", "[]"))) for p in proc_rows)
    assert logged == len(warnings_rows)


def _read_csv(path: Path) -> list[dict[str, str]]:
    import csv

    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))
