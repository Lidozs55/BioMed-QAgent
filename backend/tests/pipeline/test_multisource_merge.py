"""Multi-source merge tests (TODO §1.2).

Covers the deterministic merge path: two data-type datasets (Xena + GDC)
parsed from separate assets are aligned via ``alignment.align_fields`` and
vertically merged via ``alignment.merge_datasets``, producing a
``merged_dataset`` the artifact build can publish as ``main_data.csv`` while
retaining per-source lineage.
"""

from __future__ import annotations

import csv
import hashlib
from datetime import UTC, datetime
from pathlib import Path

import pytest
from app.domain.contracts import (
    Database,
    DataLevel,
    DatasetSelection,
    SourceAsset,
    TaskSpecification,
    asset_id_from_sha256,
)
from app.pipeline.stages.base import StageContext
from app.pipeline.stages.processing import (
    merge_parsed_datasets,
    run_processing,
)
from app.tools.workdir import create_task_workdir

_XENA_PAYLOAD = b"gene_id\tS1\tS2\nTP53\t1.5\t2\nBRCA1\t3\t4.25\n"
_GDC_PAYLOAD = b"gene_id\tS3\tS4\nMYC\t2.5\t3\nEGFR\t1.25\t4.5\n"


def _asset(workdir, payload: bytes, filename: str, source_id: str) -> SourceAsset:
    path = workdir.source_assets / filename
    path.write_bytes(payload)
    checksum = hashlib.sha256(payload).hexdigest()
    return SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path=path.relative_to(workdir.root).as_posix(),
        sha256=checksum,
        size_bytes=len(payload),
        media_type="text/tab-separated-values",
        source_id=source_id,
        successful_attempt_id=f"attempt_{source_id}",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )


def _context(
    tmp_path: Path, specification: TaskSpecification, *, workdir=None
) -> StageContext:
    return StageContext(
        task_id="multisource_merge_test",
        workdir=workdir
        or create_task_workdir(
            "multisource_merge_test", base_dir=str(tmp_path / "tasks")
        ),
        fixture_dir=tmp_path / "fixtures",
        topic=specification.topic,
        started_at=datetime.now(UTC),
        mode="fixture",
        databases=["xena", "gdc"],
        specification=specification,
    )


def test_merge_parsed_datasets_aligns_and_merges_two_sources(tmp_path: Path) -> None:
    from app.pipeline.processing.gdc import parse_gdc_table
    from app.pipeline.processing.xena_matrix import parse_xena_matrix

    workdir = create_task_workdir(
        "merge_parser", base_dir=str(tmp_path / "tasks")
    )
    xena_asset = _asset(
        workdir, _XENA_PAYLOAD, "xena.tsv", "src_xena_test"
    )
    gdc_asset = _asset(workdir, _GDC_PAYLOAD, "gdc.tsv", "src_gdc_test")
    xena_dataset = parse_xena_matrix(xena_asset, "ds_xena", workdir)
    gdc_dataset = parse_gdc_table(
        gdc_asset, "ds_gdc", workdir, "gene-expression"
    )

    merged = merge_parsed_datasets(
        _context(tmp_path, TaskSpecification(topic="merge"), workdir=workdir),
        [xena_dataset, gdc_dataset],
        merged_dataset_id="ds_merged",
    )

    assert merged.parser_name == "alignment_merger"
    assert merged.dataset_id == "ds_merged"
    # 2 genes × 2 samples per source; distinct record_ids so no dedup collapse.
    assert merged.row_count == 8
    assert "_source" in merged.columns
    assert "expression_value" in merged.columns
    assert "sample_id" in merged.columns
    assert merged.source_id == "src_xena_test,src_gdc_test"
    with (workdir.root / merged.file_asset.relative_path).open(
        encoding="utf-8-sig", newline=""
    ) as handle:
        rows = list(csv.DictReader(handle))
    assert rows[0]["_source"] in {"ds_xena", "ds_gdc"}
    assert rows[0]["expression_value"]
    assert merged.file_asset.generated_by_step_id == "step_multi_source_merge_v1"


def test_merge_requires_at_least_two_datasets(tmp_path: Path) -> None:
    from app.pipeline.processing.xena_matrix import parse_xena_matrix

    workdir = create_task_workdir("merge_single", base_dir=str(tmp_path / "tasks"))
    xena_asset = _asset(workdir, _XENA_PAYLOAD, "xena.tsv", "src_xena_test")
    xena_dataset = parse_xena_matrix(xena_asset, "ds_xena", workdir)

    import pytest

    with pytest.raises(ValueError, match="at least two"):
        merge_parsed_datasets(
            _context(tmp_path, TaskSpecification(topic="merge")),
            [xena_dataset],
            merged_dataset_id="ds_merged",
        )


def test_run_processing_multi_dataset_path_produces_merged_output(
    tmp_path: Path,
) -> None:
    """Two data-type datasets in the specification trigger the merge path."""
    specification = TaskSpecification(
        topic="multi",
        datasets=[
            DatasetSelection(
                dataset_id="ds_xena",
                database=Database.UCSC_XENA,
                accession="xena.tsv",
                source_id="src_xena_test",
                reason="test",
            ),
            DatasetSelection(
                dataset_id="ds_gdc",
                database=Database.GDC,
                accession="TCGA-TEST",
                source_id="src_gdc_test",
                reason="test",
                data_type="gene-expression",
            ),
        ],
    )
    ctx = _context(tmp_path, specification)
    xena_asset = _asset(ctx.workdir, _XENA_PAYLOAD, "xena.tsv", "src_xena_test")
    gdc_asset = _asset(ctx.workdir, _GDC_PAYLOAD, "gdc.tsv", "src_gdc_test")

    result = run_processing(ctx, [xena_asset, gdc_asset], "ds_xena")

    assert result.output.merged_dataset is not None
    assert result.output.merged_dataset.row_count == 8
    assert len(result.output.parsed_datasets) == 2
    assert result.output.field_alignment, "real align_fields mapping must exist"
    # field_alignment maps one slot per dataset (2 slots for 2 datasets).
    assert all(len(originals) == 2 for originals in result.output.field_alignment.values())
    merged_path = (
        ctx.workdir.root / result.output.merged_dataset.file_asset.relative_path
    )
    assert merged_path.is_file()


def test_artifact_build_publishes_merged_dataset_as_main_data(tmp_path: Path) -> None:
    """The merged ParsedDataset becomes main_data.csv (TODO §1.2)."""
    import csv as _csv

    from app.domain.contracts import (
        DownloadAttempt,
        DownloadStatus,
        SourceRecord,
    )
    from app.pipeline.stages.artifact_build import run_artifact_build

    specification = TaskSpecification(
        topic="multi",
        datasets=[
            DatasetSelection(
                dataset_id="ds_xena",
                database=Database.UCSC_XENA,
                accession="xena.tsv",
                source_id="src_xena_test",
                reason="test",
            ),
            DatasetSelection(
                dataset_id="ds_gdc",
                database=Database.GDC,
                accession="TCGA-TEST",
                source_id="src_gdc_test",
                reason="test",
                data_type="gene-expression",
            ),
        ],
    )
    ctx = _context(tmp_path, specification)
    xena_asset = _asset(ctx.workdir, _XENA_PAYLOAD, "xena.tsv", "src_xena_test")
    gdc_asset = _asset(ctx.workdir, _GDC_PAYLOAD, "gdc.tsv", "src_gdc_test")
    processing_result = run_processing(ctx, [xena_asset, gdc_asset], "ds_xena")
    merged = processing_result.output.merged_dataset
    assert merged is not None

    sources = [
        SourceRecord(
            source_id="src_xena_test",
            database=Database.UCSC_XENA,
            accession="xena.tsv",
            url="https://xenabrowser.net/datapages/?dataset=xena.tsv",
            title="xena",
            retrieved_at=datetime.now(UTC),
        ),
        SourceRecord(
            source_id="src_gdc_test",
            database=Database.GDC,
            accession="TCGA-TEST",
            url="https://api.gdc.cancer.gov/projects/TCGA-TEST",
            title="gdc",
            retrieved_at=datetime.now(UTC),
        ),
    ]
    attempts = [
        DownloadAttempt(
            attempt_id=f"attempt_{source_id}",
            source_id=source_id,
            url="https://example.test/download",
            status=DownloadStatus.SUCCEEDED,
            bytes_received=len(_XENA_PAYLOAD),
            started_at=datetime.now(UTC),
            finished_at=datetime.now(UTC),
        )
        for source_id in ("src_xena_test", "src_gdc_test")
    ]
    result = run_artifact_build(
        ctx,
        sources=sources,
        source_assets=[xena_asset, gdc_asset],
        download_attempts=attempts,
        parsed_dataset=processing_result.output.parsed_datasets[0],
        parsed_datasets=processing_result.output.parsed_datasets,
        merged_dataset=merged,
        samples=[],
        literature=None,
        geo=None,
        specification=specification,
        retrieved_at=datetime.now(UTC),
        stage_attempt_id="stage_attempt_multisource",
        cleaning_report=processing_result.output.cleaning_report,
        field_alignment=processing_result.output.field_alignment,
    )
    staging = result.output.staging_dir
    main_path = staging / "main_data.csv"
    assert main_path.is_file()
    with main_path.open("r", encoding="utf-8-sig", newline="") as handle:
        main_rows = list(_csv.DictReader(handle))
    assert len(main_rows) == merged.row_count == 8
    assert "_source" in main_rows[0]
    # field_mapping.csv must carry one group per source dataset (2 groups).
    with (staging / "field_mapping.csv").open(
        "r", encoding="utf-8-sig", newline=""
    ) as handle:
        mapping_rows = list(_csv.DictReader(handle))
    assert {row["source_id"] for row in mapping_rows} == {
        "src_xena_test",
        "src_gdc_test",
    }
    # processing_log.csv records both the per-source parse and the merge step.
    with (staging / "processing_log.csv").open(
        "r", encoding="utf-8-sig", newline=""
    ) as handle:
        log_rows = list(_csv.DictReader(handle))
    assert any("merge_datasets" in row["operation"] for row in log_rows)
    # Multi-source manifest lists one row per input dataset (TODO §1.5.4).
    with (staging / "multi_source_manifest.csv").open(
        "r", encoding="utf-8-sig", newline=""
    ) as handle:
        manifest_rows = list(_csv.DictReader(handle))
    assert {row["dataset_id"] for row in manifest_rows} == {
        "ds_xena",
        "ds_gdc",
    }
    by_dataset = {row["dataset_id"]: row for row in manifest_rows}
    assert by_dataset["ds_xena"]["database"] == "ucsc_xena"
    assert by_dataset["ds_gdc"]["database"] == "gdc"
    assert int(by_dataset["ds_xena"]["row_count"]) == 4
    assert int(by_dataset["ds_gdc"]["row_count"]) == 4
    # dataset_catalog.csv must carry one row per input dataset so every
    # dataset_id referenced by the merged main_data.csv closes.
    with (staging / "dataset_catalog.csv").open(
        "r", encoding="utf-8-sig", newline=""
    ) as handle:
        catalog_rows = list(_csv.DictReader(handle))
    assert {row["dataset_id"] for row in catalog_rows} == {"ds_xena", "ds_gdc"}
    # download_log.csv must record every source's attempt (not only the first).
    with (staging / "download_log.csv").open(
        "r", encoding="utf-8-sig", newline=""
    ) as handle:
        log_attempts = list(_csv.DictReader(handle))
    assert {row["attempt_id"] for row in log_attempts} == {
        "attempt_src_xena_test",
        "attempt_src_gdc_test",
    }


def test_merged_package_passes_validation_gate(tmp_path: Path) -> None:
    """A merged multi-source package must pass the full Validation Gate.

    TODO §1.5.4: the merged result is re-validated like any single-source
    package — lineage rows route to their own source file, dataset_catalog
    carries every input dataset, sample_metadata derives per-dataset rows,
    and the multi_source_manifest artifact is produced.
    """
    from app.domain.contracts import (
        DownloadAttempt,
        DownloadStatus,
        SourceRecord,
    )
    from app.pipeline.stages.artifact_build import run_artifact_build
    from app.pipeline.stages.validation import _validate_package

    specification = TaskSpecification(
        topic="multi",
        datasets=[
            DatasetSelection(
                dataset_id="ds_xena",
                database=Database.UCSC_XENA,
                accession="xena.tsv",
                source_id="src_xena_test",
                reason="test",
            ),
            DatasetSelection(
                dataset_id="ds_gdc",
                database=Database.GDC,
                accession="TCGA-TEST",
                source_id="src_gdc_test",
                reason="test",
                data_type="gene-expression",
            ),
        ],
    )
    ctx = _context(tmp_path, specification)
    xena_asset = _asset(ctx.workdir, _XENA_PAYLOAD, "xena.tsv", "src_xena_test")
    gdc_asset = _asset(ctx.workdir, _GDC_PAYLOAD, "gdc.tsv", "src_gdc_test")
    processing_result = run_processing(ctx, [xena_asset, gdc_asset], "ds_xena")
    merged = processing_result.output.merged_dataset
    assert merged is not None

    sources = [
        SourceRecord(
            source_id="src_xena_test",
            database=Database.UCSC_XENA,
            accession="xena.tsv",
            url="https://xenabrowser.net/datapages/?dataset=xena.tsv",
            title="xena",
            retrieved_at=datetime.now(UTC),
        ),
        SourceRecord(
            source_id="src_gdc_test",
            database=Database.GDC,
            accession="TCGA-TEST",
            url="https://api.gdc.cancer.gov/projects/TCGA-TEST",
            title="gdc",
            retrieved_at=datetime.now(UTC),
        ),
    ]
    attempts = [
        DownloadAttempt(
            attempt_id=f"attempt_{source_id}",
            source_id=source_id,
            url="https://example.test/download",
            status=DownloadStatus.SUCCEEDED,
            bytes_received=len(_XENA_PAYLOAD),
            started_at=datetime.now(UTC),
            finished_at=datetime.now(UTC),
        )
        for source_id in ("src_xena_test", "src_gdc_test")
    ]
    build_result = run_artifact_build(
        ctx,
        sources=sources,
        source_assets=[xena_asset, gdc_asset],
        download_attempts=attempts,
        parsed_dataset=processing_result.output.parsed_datasets[0],
        parsed_datasets=processing_result.output.parsed_datasets,
        merged_dataset=merged,
        samples=[],
        literature=None,
        geo=None,
        specification=specification,
        retrieved_at=datetime.now(UTC),
        stage_attempt_id="stage_attempt_multisource",
        cleaning_report=processing_result.output.cleaning_report,
        field_alignment=processing_result.output.field_alignment,
    )
    summary, checks = _validate_package(
        build_result.output.staging_dir,
        build_result.output.source_path,
        ctx.workdir.logs / "validation_report.json",
    )
    assert summary.status == "valid", [
        check for check in checks if check["status"] != "passed"
    ]
    assert summary.failed_count == 0
    assert (build_result.output.staging_dir / "multi_source_manifest.csv").is_file()


@pytest.mark.asyncio
async def test_pipeline_runner_completes_gdc_xena_fixture_from_public_entry(
    tmp_path: Path,
) -> None:
    """The public runner must preserve both selected sources through validation."""
    from app.domain.contracts import RequestedOutput
    from app.pipeline.runner import PipelineRunner

    fixture_dir = tmp_path / "fixtures"
    fixture_dir.mkdir()
    (fixture_dir / "xena_matrix.tsv").write_bytes(_XENA_PAYLOAD)
    (fixture_dir / "gdc_expression.tsv").write_bytes(_GDC_PAYLOAD)
    specification = TaskSpecification(
        topic="GDC and Xena fixture entry",
        datasets=[
            DatasetSelection(
                dataset_id="ds_xena_entry",
                database=Database.UCSC_XENA,
                accession="xena.tsv",
                source_id="",
                reason="test public entry",
            ),
            DatasetSelection(
                dataset_id="ds_gdc_entry",
                database=Database.GDC,
                accession="TCGA-TEST",
                source_id="",
                reason="test public entry",
                data_type="gene-expression",
            ),
        ],
        requested_outputs=[RequestedOutput.MAIN_DATA],
    )

    manifest = await PipelineRunner(
        task_id="multisource_public_entry",
        base_dir=tmp_path / "tasks",
        fixture_dir=fixture_dir,
        topic=specification.topic,
        databases=["ucsc_xena", "gdc"],
        specification=specification,
    ).run()

    assert manifest.task_state.value == "completed", manifest.model_dump_json(indent=2)
    artifacts = tmp_path / "tasks" / "multisource_public_entry" / "artifacts"
    with (artifacts / "source_list.csv").open(
        encoding="utf-8-sig", newline=""
    ) as handle:
        sources = list(csv.DictReader(handle))
    with (artifacts / "source_assets.csv").open(
        encoding="utf-8-sig", newline=""
    ) as handle:
        assets = list(csv.DictReader(handle))
    with (artifacts / "download_log.csv").open(
        encoding="utf-8-sig", newline=""
    ) as handle:
        attempts = list(csv.DictReader(handle))
    with (artifacts / "multi_source_manifest.csv").open(
        encoding="utf-8-sig", newline=""
    ) as handle:
        source_manifest = list(csv.DictReader(handle))
    with (artifacts / "main_data.csv").open(
        encoding="utf-8-sig", newline=""
    ) as handle:
        main_rows = list(csv.DictReader(handle))

    source_ids = {row["source_id"] for row in sources}
    assert len(source_ids) == 2
    assert {row["source_id"] for row in assets} == source_ids
    assert {row["source_id"] for row in attempts} == source_ids
    assert {row["dataset_id"] for row in source_manifest} == {
        "ds_xena_entry",
        "ds_gdc_entry",
    }
    assert len(main_rows) == 8
