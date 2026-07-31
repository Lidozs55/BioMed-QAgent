from __future__ import annotations

import csv
import gzip
import hashlib
from pathlib import Path

import pytest
from app.domain.contracts import DataLevel, SourceAsset, asset_id_from_sha256
from app.pipeline.processing.reactome import parse_reactome_table
from app.pipeline.stages.base import StageContext
from app.pipeline.stages.processing import run_processing
from app.tools.workdir import create_task_workdir

_COLUMNS = [
    "pathway_id",
    "pathway_name",
    "participant_id",
    "participant_name",
    "participant_type",
    "species",
    "interaction_type",
]


def _asset(workdir, payload: bytes, filename: str) -> SourceAsset:
    path = workdir.source_assets / filename
    path.write_bytes(payload)
    checksum = hashlib.sha256(payload).hexdigest()
    return SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path=path.relative_to(workdir.root).as_posix(),
        sha256=checksum,
        size_bytes=len(payload),
        media_type="application/gzip" if filename.endswith(".gz") else "text/tab-separated-values",
        source_id="src_reactome_test",
        successful_attempt_id="attempt_reactome_test",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )


def _payload() -> bytes:
    return (
        "\t".join(_COLUMNS)
        + "\n"
        + "R-HSA-199420\tApoptosis\tCHEBI:15377\tHydrogen peroxide\tchemical\tHomo sapiens\tparticipant\n"
        + "R-HSA-199420\tApoptosis\tP04637\tp53\tprotein\tHomo sapiens\tinput\n"
    ).encode()


def test_parse_reactome_table_preserves_lineage_and_record_id(tmp_path: Path) -> None:
    workdir = create_task_workdir("reactome_parser", base_dir=str(tmp_path / "tasks"))
    result = parse_reactome_table(
        _asset(workdir, _payload(), "participants.tsv"), "ds_reactome_r-hsa-199420", workdir
    )

    assert result.parser_name == "reactome_pathway_participants"
    assert result.row_count == 2
    assert result.source_row_count == 2
    with (workdir.root / result.file_asset.relative_path).open(
        encoding="utf-8-sig", newline=""
    ) as handle:
        rows = list(csv.DictReader(handle))
    assert rows[0]["record_id"]
    assert rows[0]["dataset_id"] == "ds_reactome_r-hsa-199420"
    assert rows[0]["source_id"] == "src_reactome_test"
    assert rows[0]["source_logical_file"] == "participants.tsv"
    assert rows[0]["source_line_number"] == "2"
    assert rows[0]["source_column_index"] == "2"
    assert rows[0]["source_column_name"] == "participant_id"
    assert rows[0]["source_raw_value"] == "CHEBI:15377"


def test_parse_reactome_content_service_json_is_converted_to_internal_rows(tmp_path: Path) -> None:
    workdir = create_task_workdir("reactome_json", base_dir=str(tmp_path / "tasks"))
    payload = b'[{"stId":"R-HSA-109581","displayName":"Apoptosis signaling","schemaClass":"Pathway","speciesName":"Homo sapiens"}]'
    result = parse_reactome_table(
        _asset(workdir, payload, "participants.json"), "ds_reactome_json", workdir
    )
    with (workdir.root / result.file_asset.relative_path).open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert rows[0]["pathway_id"] == "ds_reactome_json"
    assert rows[0]["participant_id"] == "R-HSA-109581"
    assert rows[0]["participant_name"] == "Apoptosis signaling"
    assert rows[0]["participant_type"] == "Pathway"


def test_parse_reactome_table_supports_tsv_gz(tmp_path: Path) -> None:
    workdir = create_task_workdir("reactome_gz", base_dir=str(tmp_path / "tasks"))
    payload = gzip.compress(_payload(), mtime=0)
    result = parse_reactome_table(
        _asset(workdir, payload, "participants.tsv.gz"), "ds_reactome_gz", workdir
    )
    assert result.row_count == 2
    with (workdir.root / result.file_asset.relative_path).open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert rows[0]["source_logical_file"] == "participants.tsv"


@pytest.mark.parametrize(
    "payload, message",
    [
        (b"", "empty"),
        (b"pathway_id\tpathway_name\nR\tName\n", "required"),
        ("\t".join(_COLUMNS).encode() + b"\n\tName\tP\tProtein\tprotein\tHuman\tinput\n", "blank"),
    ],
)
def test_parse_reactome_table_rejects_invalid_input(
    tmp_path: Path, payload: bytes, message: str
) -> None:
    workdir = create_task_workdir("reactome_invalid", base_dir=str(tmp_path / "tasks"))
    with pytest.raises(ValueError, match=message):
        parse_reactome_table(
            _asset(workdir, payload, "invalid.tsv"), "ds_reactome_invalid", workdir
        )


def test_parse_reactome_table_rejects_truncated_row(tmp_path: Path) -> None:
    workdir = create_task_workdir("reactome_truncated", base_dir=str(tmp_path / "tasks"))
    payload = ("\t".join(_COLUMNS) + "\nR\tName\tP\tProtein\tprotein\tHuman\n").encode()
    with pytest.raises(ValueError, match="truncated"):
        parse_reactome_table(_asset(workdir, payload, "invalid.tsv"), "ds_reactome_truncated", workdir)


def test_parse_reactome_table_rejects_checksum_mismatch(tmp_path: Path) -> None:
    workdir = create_task_workdir("reactome_checksum", base_dir=str(tmp_path / "tasks"))
    asset = _asset(workdir, _payload(), "participants.tsv")
    asset = asset.model_copy(update={"sha256": "0" * 64, "asset_id": asset_id_from_sha256("0" * 64)})
    with pytest.raises(ValueError, match="checksum mismatch"):
        parse_reactome_table(asset, "ds_reactome_checksum", workdir)


def test_processing_rejects_mixed_reactome_and_gdc_databases(tmp_path: Path) -> None:
    workdir = create_task_workdir("reactome_mixed", base_dir=str(tmp_path / "tasks"))
    asset = _asset(workdir, _payload(), "participants.tsv")
    ctx = StageContext(
        task_id="reactome_mixed", workdir=workdir, fixture_dir=tmp_path,
        topic="mixed", started_at=__import__("datetime").datetime.now(__import__("datetime").UTC),
        databases=["gdc", "reactome"],
    )
    with pytest.raises(ValueError, match="mixed|unsupported"):
        run_processing(ctx, asset, "ds_reactome_mixed")


def test_processing_rejects_unknown_or_empty_database(tmp_path: Path) -> None:
    workdir = create_task_workdir("unknown_db", base_dir=str(tmp_path / "tasks"))
    asset = _asset(workdir, _payload(), "participants.tsv")
    for databases in ([], ["unknown"]):
        ctx = StageContext(
            task_id="unknown_db", workdir=workdir, fixture_dir=tmp_path,
            topic="unknown", started_at=__import__("datetime").datetime.now(__import__("datetime").UTC),
            databases=databases,
        )
        with pytest.raises(ValueError, match="database"):
            run_processing(ctx, asset, "ds_unknown_db")


def test_processing_routes_reactome_dataset(tmp_path: Path) -> None:
    workdir = create_task_workdir("reactome_stage", base_dir=str(tmp_path / "tasks"))
    asset = _asset(workdir, _payload(), "participants.tsv")
    ctx = StageContext(
        task_id="reactome_stage",
        workdir=workdir,
        fixture_dir=tmp_path,
        topic="Reactome",
        started_at=__import__("datetime").datetime.now(__import__("datetime").UTC),
        databases=["reactome"],
    )
    result = run_processing(ctx, asset, "ds_reactome_stage")
    assert result.output.parsed_datasets[0].parser_name == "reactome_pathway_participants"
