from __future__ import annotations

import csv
import gzip
from pathlib import Path

import pytest
from app.domain.contracts import DataLevel, SourceAsset, asset_id_from_sha256
from app.pipeline.processing.gdc import parse_gdc_table
from app.tools.workdir import create_task_workdir


def _asset(workdir, payload: bytes, filename: str) -> SourceAsset:
    path = workdir.source_assets / filename
    path.write_bytes(payload)
    checksum = __import__("hashlib").sha256(payload).hexdigest()
    return SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path=path.relative_to(workdir.root).as_posix(),
        sha256=checksum,
        size_bytes=len(payload),
        media_type="application/gzip" if filename.endswith(".gz") else "text/tab-separated-values",
        source_id="src_gdc_test",
        successful_attempt_id="attempt_gdc_test",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )


def test_parse_gdc_expression_tsv_gz_to_long_form(tmp_path: Path) -> None:
    workdir = create_task_workdir("gdc_parser", base_dir=str(tmp_path / "tasks"))
    payload = gzip.compress(b"gene_id\tS1\tS2\nTP53\t1.5\t2\nBRCA1\t3\t4.25\n", mtime=0)
    result = parse_gdc_table(
        _asset(workdir, payload, "expression.tsv.gz"), "ds_gdc_tcga", workdir, "gene-expression"
    )
    assert result.parser_name == "gdc_gene_expression"
    assert result.row_count == 4
    with (workdir.root / result.file_asset.relative_path).open(
        encoding="utf-8-sig", newline=""
    ) as handle:
        rows = list(csv.DictReader(handle))
    assert [(row["gene_id"], row["sample_id"], row["expression_value"]) for row in rows] == [
        ("TP53", "S1", "1.5"),
        ("TP53", "S2", "2"),
        ("BRCA1", "S1", "3"),
        ("BRCA1", "S2", "4.25"),
    ]
    assert rows[0]["source_line_number"] == "2"


def test_parse_gdc_clinical_preserves_sample_locator(tmp_path: Path) -> None:
    workdir = create_task_workdir(
        "gdc_clinical_parser", base_dir=str(tmp_path / "tasks")
    )
    payload = b"sample_id\tproject_id\tdiagnosis\nS1\tTCGA-BRCA\tcarcinoma\n"

    result = parse_gdc_table(
        _asset(workdir, payload, "clinical.tsv"),
        "ds_gdc_clinical",
        workdir,
        "clinical",
    )

    with (workdir.root / result.file_asset.relative_path).open(
        encoding="utf-8-sig", newline=""
    ) as handle:
        row = next(csv.DictReader(handle))
    assert row["source_line_number"] == "2"
    assert row["source_column_index"] == "0"
    assert row["source_column_name"] == "sample_id"
    assert row["source_raw_value"] == "S1"


@pytest.mark.parametrize("payload", [b"sample\tvalue\nS1\tbad\n", b"gene_id\tS1\n"])
def test_parse_gdc_rejects_unsupported_layout(tmp_path: Path, payload: bytes) -> None:
    workdir = create_task_workdir("gdc_bad", base_dir=str(tmp_path / "tasks"))
    with pytest.raises(ValueError):
        parse_gdc_table(
            _asset(workdir, payload, "bad.tsv"), "ds_gdc_bad", workdir, "gene-expression"
        )


@pytest.mark.asyncio
async def test_gdc_expression_fixture_pipeline_reaches_validation(tmp_path: Path) -> None:
    from app.domain.contracts import (
        Database,
        DatasetSelection,
        QuerySpecification,
        RequestedOutput,
        TaskSpecification,
    )
    from app.pipeline.runner import PipelineRunner

    fixture_dir = Path(__file__).parents[1] / "fixtures" / "gdc"
    specification = TaskSpecification(
        topic="fixture GDC expression",
        queries=[QuerySpecification(
            query_id="query_gdc_1",
            database=Database.GDC,
            query="TCGA-BRCA",
            generated_by="pipeline",
            purpose="fixture project",
            order=1,
        )],
        datasets=[DatasetSelection(
            dataset_id="ds_gdc_tcga_brca",
            database=Database.GDC,
            accession="TCGA-BRCA",
            source_id="",
            reason="fixture project",
            data_type="gene-expression",
        )],
        requested_outputs=[RequestedOutput.MAIN_DATA],
    )
    manifest = await PipelineRunner(
        task_id="gdc_pipeline_fixture",
        base_dir=tmp_path / "tasks",
        fixture_dir=fixture_dir,
        topic=specification.topic,
        databases=["gdc"],
        specification=specification,
    ).run()

    assert manifest.task_state.value == "completed"
    assert manifest.validation.status == "valid"
    assert (tmp_path / "tasks" / "gdc_pipeline_fixture" / "artifacts" / "main_data.csv").is_file()


@pytest.mark.asyncio
async def test_gdc_clinical_fixture_pipeline_reaches_validation(tmp_path: Path) -> None:
    from app.domain.contracts import Database, DatasetSelection, RequestedOutput, TaskSpecification
    from app.pipeline.runner import PipelineRunner

    specification = TaskSpecification(
        topic="fixture GDC clinical",
        datasets=[DatasetSelection(
            dataset_id="ds_gdc_clinical",
            database=Database.GDC,
            accession="TCGA-BRCA",
            source_id="",
            reason="fixture project",
            data_type="clinical",
        )],
        requested_outputs=[RequestedOutput.MAIN_DATA],
    )
    manifest = await PipelineRunner(
        task_id="gdc_clinical_fixture",
        base_dir=tmp_path / "tasks",
        fixture_dir=Path(__file__).parents[1] / "fixtures" / "gdc",
        topic=specification.topic,
        databases=["gdc"],
        specification=specification,
    ).run()
    assert manifest.task_state.value == "completed"
    assert manifest.validation.status == "valid"
