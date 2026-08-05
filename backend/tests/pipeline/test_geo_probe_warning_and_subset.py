"""Tests for P0-1d geo_probe_unmapped warning and P0-2 gene subset artifact.

0805 review (task_db204f6b) findings addressed here:
1. A series_matrix parsed at probe level whose platform annotation provides no
   probe→gene mapping yields a ``main_data.csv`` that cannot be queried by
   gene symbol. The builder must inject a ``geo_probe_unmapped`` warning so
   the Agent sees the reason and can switch datasets.
2. When the task topic names a gene symbol present in ``main_data.csv``, a
   filtered ``{gene}_expression.csv`` subset artifact must be shipped so the
   target gene is directly queryable.
"""
from __future__ import annotations

import csv
import hashlib
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
from app.pipeline.stages.artifact_build.builder import (
    _extract_target_gene,
    _write_target_gene_subset,
    run_artifact_build,
)
from app.pipeline.stages.base import StageContext
from app.tools.workdir import create_task_workdir

_MAIN_COLUMNS = [
    "record_id", "dataset_id", "source_id", "asset_id", "gene_id_raw",
    "gene_id", "gene_id_namespace", "gene_id_version", "sample_id",
    "source_sample_alias", "measurement_type", "value_semantics",
    "value_scale", "is_normalized", "is_integer_expected", "expression_value",
    "expression_unit", "source_logical_file", "source_line_number",
    "source_column_index", "source_column_name", "source_raw_value",
]


def _main_row(gene: str, sample_id: str, value: str) -> dict[str, str]:
    return {
        "record_id": f"rec_{gene}_{sample_id}",
        "dataset_id": "ds_gse_test",
        "source_id": "src_geo_gse_test",
        "asset_id": "asset_matrix",
        "gene_id_raw": gene,
        "gene_id": gene,
        "gene_id_namespace": "gene_symbol",
        "gene_id_version": "",
        "sample_id": sample_id,
        "source_sample_alias": sample_id,
        "measurement_type": "series_matrix_expression",
        "value_semantics": "normalized_expression_value",
        "value_scale": "log2",
        "is_normalized": "true",
        "is_integer_expected": "false",
        "expression_value": value,
        "expression_unit": "normalized_expression_value",
        "source_logical_file": "series_matrix_expression",
        "source_line_number": "2",
        "source_column_index": "1",
        "source_column_name": sample_id,
        "source_raw_value": value,
    }


def _primary(ctx: StageContext, probe_mapping: str) -> ParsedDataset:
    """A probe-level series_matrix ParsedDataset with rows in parsed dir."""
    rows = [
        _main_row("METTL5", "GSM9000100", "5.2"),
        _main_row("BRCA1", "GSM9000100", "8.7"),
        _main_row("METTL5", "GSM9000101", "3.1"),
    ]
    parsed_path = ctx.workdir.parsed / "ds_gse_test_series_matrix_long.csv"
    with parsed_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=_MAIN_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    checksum = hashlib.sha256(parsed_path.read_bytes()).hexdigest()
    return ParsedDataset(
        dataset_id="ds_gse_test",
        source_id="src_geo_gse_test",
        source_asset_id="asset_matrix",
        file_asset=FileAsset(
            asset_id=asset_id_from_sha256(checksum),
            kind="parsed",
            relative_path=parsed_path.relative_to(ctx.workdir.root).as_posix(),
            sha256=checksum,
            size_bytes=parsed_path.stat().st_size,
            media_type="text/csv",
            generated_by_step_id="step_geo_series_matrix_v1",
        ),
        columns=list(_MAIN_COLUMNS),
        row_count=3,
        parser_name="geo_series_matrix_expression",
        parser_version="1.0.0",
        source_row_count=2,
        processing_parameters={
            "measurement_type": "series_matrix_expression",
            "gene_id_namespace": "geo_id_ref",
            "probe_gene_mapping": probe_mapping,
        },
    )


def _stage_context(tmp_path: Path, topic: str) -> StageContext:
    ctx = StageContext(
        task_id="task_build_probe",
        workdir=create_task_workdir(
            "task_build_probe", base_dir=str(tmp_path / "tasks")
        ),
        fixture_dir=tmp_path,
        topic=topic,
        started_at=datetime.now(UTC),
        mode="fixture",
        databases=["geo"],
        specification=TaskSpecification(
            topic=topic,
            datasets=[
                DatasetSelection(
                    dataset_id="ds_gse_test",
                    database=Database.GEO,
                    accession="GSE999999",
                    reason="explicit",
                    source_id="src_geo_gse_test",
                )
            ],
        ),
    )
    return ctx


def _build(
    ctx: StageContext, primary: ParsedDataset, now: datetime
) -> object:
    source_asset = SourceAsset(
        asset_id=asset_id_from_sha256("c" * 64),
        kind="source",
        relative_path="source_assets/GSE999999_series_matrix.txt.gz",
        sha256="c" * 64,
        size_bytes=2316,
        media_type="application/gzip",
        source_id="src_geo_gse_test",
        successful_attempt_id="attempt_matrix",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    source_record = SourceRecord(
        source_id="src_geo_gse_test",
        database=Database.GEO,
        accession="GSE999999",
        url="https://ftp.ncbi.nlm.nih.gov/geo/series/GSE999nnn/GSE999999/matrix/GSE999999_series_matrix.txt.gz",
        title="GSE999999 series matrix",
        retrieved_at=now,
    )
    return run_artifact_build(
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
        dataset_id="ds_gse_test",
        dataset_source_id="src_geo_gse_test",
        dataset_accession="GSE999999",
    )


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


# --- P0-1d: geo_probe_unmapped warning -------------------------------------


def test_builder_adds_geo_probe_unmapped_warning_for_unmapped_platform(
    tmp_path: Path,
) -> None:
    ctx = _stage_context(tmp_path, "METTL5 在胰腺癌中的表达")
    primary = _primary(ctx, "unmapped")
    result = _build(ctx, primary, datetime.now(UTC))
    staging = result.output.staging_dir

    warnings_rows = _read_csv(staging / "warnings.csv")
    unmapped = [
        w for w in warnings_rows if w.get("code") == "probe_gene_mapping_unavailable"
    ]
    assert len(unmapped) == 1
    assert unmapped[0]["warning_id"] == "geo_probe_unmapped"
    assert "GSE999999" in unmapped[0]["message"]
    assert "unmapped" in unmapped[0]["message"]

    # warnings_metrics_consistency: every warning is folded into processing_log.
    proc_rows = _read_csv(staging / "processing_log.csv")
    import json

    logged = sum(len(json.loads(p.get("warnings", "[]"))) for p in proc_rows)
    assert logged == len(warnings_rows)


def test_builder_does_not_warn_when_mapping_available(tmp_path: Path) -> None:
    ctx = _stage_context(tmp_path, "METTL5 在胰腺癌中的表达")
    primary = _primary(ctx, "mapped")
    result = _build(ctx, primary, datetime.now(UTC))
    staging = result.output.staging_dir

    warnings_rows = _read_csv(staging / "warnings.csv")
    assert not any(
        w.get("code") == "probe_gene_mapping_unavailable" for w in warnings_rows
    )


# --- P0-2: target-gene subset artifact -------------------------------------


def test_extract_target_gene_finds_symbol_in_chinese_topic() -> None:
    assert _extract_target_gene("METTL5 在胰腺癌癌组织与癌旁组织的转录组学差异") == "METTL5"
    assert _extract_target_gene("BRCA1 mutation in breast cancer") == "BRCA1"


def test_extract_target_gene_returns_none_without_symbol() -> None:
    assert _extract_target_gene("GSE178352 转录组差异分析") is None
    assert _extract_target_gene("胰腺癌的转录组学差异研究") is None


def test_write_target_gene_subset_filters_main_data(tmp_path: Path) -> None:
    ctx = _stage_context(tmp_path, "METTL5 在胰腺癌中的表达")
    primary = _primary(ctx, "mapped")
    result = _build(ctx, primary, datetime.now(UTC))
    staging = result.output.staging_dir

    subset = staging / "METTL5_expression.csv"
    assert subset.is_file()
    rows = _read_csv(subset)
    assert len(rows) == 2  # METTL5 × 2 samples
    assert {row["gene_id"] for row in rows} == {"METTL5"}
    assert {row["sample_id"] for row in rows} == {"GSM9000100", "GSM9000101"}
    # Subset ships as part of the staging package.
    assert subset.name in {p.name for p in result.output.artifact_paths}


def test_write_target_gene_subset_skips_when_gene_absent(tmp_path: Path) -> None:
    ctx = _stage_context(tmp_path, "TP53 在胰腺癌中的表达")
    primary = _primary(ctx, "mapped")
    result = _build(ctx, primary, datetime.now(UTC))
    staging = result.output.staging_dir

    assert not (staging / "TP53_expression.csv").exists()
    # No stray subset for metadata-only rows either.
    assert not any(p.name.endswith("_expression.csv") for p in staging.iterdir())


def test_write_target_gene_subset_matches_gene_id_raw_fallback(
    tmp_path: Path,
) -> None:
    """When ``gene_id`` is blank but ``gene_id_raw`` carries the target token
    (probe-level rows), matching must fall back to ``gene_id_raw``."""
    rows = [
        {
            **_main_row("A_19_P00000001", "GSM9000100", "5.2"),
            "gene_id": "",
            "gene_id_namespace": "geo_id_ref",
        }
    ]
    ctx = _stage_context(tmp_path, "METTL5 在胰腺癌中的表达")
    staging = ctx.workdir.staging_run(ctx.run_id)
    staging.mkdir(parents=True, exist_ok=True)
    with (staging / "main_data.csv").open("w", encoding="utf-8", newline="") as h:
        w = csv.DictWriter(h, fieldnames=_MAIN_COLUMNS)
        w.writeheader()
        w.writerows(rows)

    assert _write_target_gene_subset(staging, "main_data.csv", ctx.topic) is None
    # Matching is case-insensitive; METTL5 also exists in raw probe form.
    rows[0]["gene_id_raw"] = "METTL5"
    with (staging / "main_data.csv").open("w", encoding="utf-8", newline="") as h:
        w = csv.DictWriter(h, fieldnames=_MAIN_COLUMNS)
        w.writeheader()
        w.writerows(rows)
    written = _write_target_gene_subset(staging, "main_data.csv", ctx.topic)
    assert written == "METTL5_expression.csv"
    assert (staging / written).is_file()
