from __future__ import annotations

import csv
import gzip
import hashlib
from pathlib import Path

import pytest
from app.domain.contracts import (
    Database,
    DataLevel,
    DatasetSelection,
    DownloadAttempt,
    DownloadStatus,
    SourceAsset,
    TaskSpecification,
    asset_id_from_sha256,
)
from app.pipeline.processing.xena_matrix import parse_xena_matrix
from app.tools.workdir import TaskWorkDir, create_task_workdir


def _source_asset(workdir: TaskWorkDir, payload: bytes, filename: str = "matrix.tsv.gz") -> SourceAsset:
    source_path = workdir.source_assets / filename
    source_path.write_bytes(payload)
    checksum = hashlib.sha256(payload).hexdigest()
    return SourceAsset(
        asset_id=f"asset_{checksum}",
        kind="source",
        relative_path=f"source_assets/{filename}",
        sha256=checksum,
        size_bytes=len(payload),
        media_type="application/gzip" if filename.endswith(".gz") else "text/tab-separated-values",
        source_id="src_xena_test",
        successful_attempt_id="attempt_xena_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )


@pytest.mark.asyncio
async def test_xena_live_acquisition_publishes_downloaded_asset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from datetime import UTC, datetime

    from app.integrations.acquisition import AcquisitionResult
    from app.pipeline.stages.acquisition import _run_xena_acquisition_live
    from app.pipeline.stages.base import StageContext

    workdir = create_task_workdir("task_xena_live", base_dir=str(tmp_path / "tasks"))
    fixture_dir = tmp_path / "fixture"
    fixture_dir.mkdir()
    specification = TaskSpecification(
        topic="live Xena expression",
        queries=[],
        datasets=[DatasetSelection(
            dataset_id="ds_xena_tcga",
            database=Database.UCSC_XENA,
            accession="TCGA.BRCA.sampleMap/HiSeqV2",
            source_id="",
            reason="live dataset",
        )],
        requested_outputs=[],
    )
    ctx = StageContext(
        task_id="task_xena_live",
        workdir=workdir,
        fixture_dir=fixture_dir,
        topic=specification.topic,
        started_at=datetime.now(UTC),
        mode="live",
        databases=["xena"],
        specification=specification,
    )
    calls: list[dict[str, object]] = []

    async def fake_acquire(**kwargs: object) -> AcquisitionResult:
        calls.append(kwargs)
        asset = SourceAsset(
            asset_id=asset_id_from_sha256("aa" * 32),
            kind="source",
            relative_path="source_assets/TCGA.BRCA.sampleMap_HiSeqV2.gz",
            sha256="aa" * 32,
            size_bytes=42,
            media_type="application/gzip",
            source_id=kwargs["source"].source_id,
            successful_attempt_id="attempt_xena_live",
            data_level=DataLevel.REPOSITORY_PROCESSED,
        )
        attempt = DownloadAttempt(
            attempt_id="attempt_xena_live",
            source_id=asset.source_id,
            url=kwargs["source"].url,
            status=DownloadStatus.SUCCEEDED,
            bytes_received=42,
            started_at=datetime.now(UTC),
            finished_at=datetime.now(UTC),
        )
        return AcquisitionResult(asset=asset, attempt=attempt)

    monkeypatch.setattr("app.pipeline.stages.acquisition.acquire_source", fake_acquire)
    result = await _run_xena_acquisition_live(ctx, datetime.now(UTC), specification.datasets[0])

    assert len(calls) == 1
    assert calls[0]["data_level"] is DataLevel.REPOSITORY_PROCESSED
    assert result.output.source_assets[0].source_id == calls[0]["source"].source_id
    assert result.output.download_attempts[0].status is DownloadStatus.SUCCEEDED


def test_parse_xena_gzip_matrix_writes_long_form_with_source_lineage(tmp_path: Path) -> None:
    workdir = create_task_workdir("task_xena", base_dir=str(tmp_path / "tasks"))
    payload = gzip.compress(
        b"gene_id\tTCGA-A\tTCGA-B\nTP53\t1.5\t2\nBRCA1\t3\t4.25\n", mtime=0
    )
    result = parse_xena_matrix(
        _source_asset(workdir, payload), "ds_xena_tcga", workdir
    )

    assert result.dataset_id == "ds_xena_tcga"
    assert result.source_id == "src_xena_test"
    assert result.source_asset_id == _source_asset(workdir, payload).asset_id
    assert result.row_count == 4
    assert result.parser_name == "xena_gene_expression"
    assert result.processing_parameters == {
        "source_database": "ucsc_xena",
        "dataset_type": "gene_expression",
    }

    output_path = workdir.root / result.file_asset.relative_path
    assert result.file_asset.relative_path.startswith("parsed/")
    with output_path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert [(row["gene_id"], row["sample_id"], row["expression_value"]) for row in rows] == [
        ("TP53", "TCGA-A", "1.5"),
        ("TP53", "TCGA-B", "2"),
        ("BRCA1", "TCGA-A", "3"),
        ("BRCA1", "TCGA-B", "4.25"),
    ]
    assert rows[0]["source_line_number"] == "2"
    assert rows[0]["source_column_index"] == "1"
    assert rows[0]["source_raw_value"] == "1.5"
    assert rows[1]["source_column_index"] == "2"


@pytest.mark.parametrize(
    "payload, message",
    [
        (b"gene_id\tS1\n", "empty matrix"),
        (b"gene_id\tS1\tS1\nG1\t1\t2\n", "duplicate sample"),
        (b"gene_id\tS1\nG1\tnot-a-number\n", "non-numeric"),
    ],
)
def test_parse_xena_matrix_rejects_malformed_input(
    tmp_path: Path, payload: bytes, message: str
) -> None:
    workdir = create_task_workdir(
        f"task_xena_{message.replace(' ', '_')}", base_dir=str(tmp_path / "tasks")
    )
    asset = _source_asset(workdir, payload, "matrix.tsv")
    with pytest.raises(ValueError):
        parse_xena_matrix(asset, "ds_xena_test", workdir)


@pytest.mark.asyncio
async def test_xena_fixture_pipeline_reaches_validation(tmp_path: Path) -> None:
    from app.domain.contracts import (
        Database,
        DatasetSelection,
        QuerySpecification,
        RequestedOutput,
        TaskSpecification,
    )
    from app.pipeline.runner import PipelineRunner

    fixture_dir = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"
    specification = TaskSpecification(
        topic="fixture Xena expression",
        queries=[QuerySpecification(
            query_id="query_xena_1",
            database=Database.UCSC_XENA,
            query="TCGA_GBM",
            generated_by="pipeline",
            purpose="fixture dataset",
            order=1,
        )],
        datasets=[DatasetSelection(
            dataset_id="ds_xena_tcga_gbm",
            database=Database.UCSC_XENA,
            accession="TCGA_GBM",
            source_id="",
            reason="fixture dataset",
        )],
        requested_outputs=[RequestedOutput.MAIN_DATA],
    )
    manifest = await PipelineRunner(
        task_id="xena_pipeline_fixture",
        base_dir=tmp_path / "tasks",
        fixture_dir=fixture_dir,
        topic=specification.topic,
        databases=["xena"],
        specification=specification,
    ).run()

    assert manifest.task_state.value == "completed"
    assert manifest.validation.status == "valid"
    assert (tmp_path / "tasks" / "xena_pipeline_fixture" / "artifacts" / "main_data.csv").is_file()
