from __future__ import annotations

import asyncio
import csv
import hashlib
import shutil
from pathlib import Path

import httpx
import pytest
from app.domain.contracts import (
    Database,
    DatasetSelection,
    TaskSpecification,
    TaskState,
)
from app.pipeline.runner import PipelineRunner

_FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "reactome"


def _specification() -> TaskSpecification:
    return TaskSpecification(
        topic="Reactome apoptosis",
        datasets=[
            DatasetSelection(
                dataset_id="ds_reactome_r-hsa-199420",
                database=Database.REACTOME,
                accession="R-HSA-199420",
                reason="explicit pathway",
                data_type="pathway-participants",
            )
        ],
    )


def test_reactome_live_json_pipeline_normalizes_source_before_validation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = b'[{"stId":"R-HSA-109581","displayName":"Apoptosis signaling","schemaClass":"Pathway","speciesName":"Homo sapiens"}]'
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200, content=payload, headers={"Content-Type": "application/json"}
            )
        )
    )
    monkeypatch.setattr("app.pipeline.stages.acquisition.httpx.AsyncClient", lambda: client)
    runner = PipelineRunner(
        task_id="task_reactome_live_format",
        base_dir=tmp_path / "tasks",
        fixture_dir=_FIXTURE_DIR,
        topic="Reactome apoptosis",
        databases=["reactome"],
        specification=_specification(),
        mode="live",
    )
    runner.state.task_state = TaskState.PLANNING
    try:
        manifest = asyncio.run(runner.run())
    finally:
        asyncio.run(client.aclose())

    assert manifest.task_state is TaskState.COMPLETED, manifest.model_dump_json(indent=2)
    assert manifest.validation.status == "valid"
    root = tmp_path / "tasks" / "task_reactome_live_format"
    with (root / "artifacts" / "source_assets.csv").open(
        encoding="utf-8-sig", newline=""
    ) as handle:
        assets = list(csv.DictReader(handle))
    raw_asset = next(row for row in assets if row["media_type"] == "application/json")
    normalized_asset = next(
        row for row in assets if row["media_type"] == "text/tab-separated-values"
    )
    assert normalized_asset["successful_attempt_id"] == ""
    assert normalized_asset["derived_from_asset_id"] == raw_asset["asset_id"]
    with (root / "artifacts" / "processing_log.csv").open(
        encoding="utf-8-sig", newline=""
    ) as handle:
        operations = {row["operation"] for row in csv.DictReader(handle)}
    assert "reactome_json_to_tsv" in operations
    assert "reactome_pathway_participants" in operations
    assert (root / "artifacts" / "pathway_members.csv").is_file()


def test_reactome_pipeline_builds_pathway_artifact_with_lineage_and_valid_gate(
    tmp_path: Path,
) -> None:
    runner = PipelineRunner(
        task_id="task_reactome_e2e",
        base_dir=tmp_path / "tasks",
        fixture_dir=_FIXTURE_DIR,
        topic="Reactome apoptosis",
        databases=["reactome"],
        specification=_specification(),
    )

    manifest = asyncio.run(runner.run())

    assert manifest.task_state is TaskState.COMPLETED
    assert manifest.validation.status == "valid"
    artifacts_dir = tmp_path / "tasks" / "task_reactome_e2e" / "artifacts"
    assert (artifacts_dir / "pathway_members.csv").is_file()
    main_path = artifacts_dir / "pathway_members.csv"
    with main_path.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert len(rows) == 1
    assert rows[0]["pathway_id"] == "R-HSA-199420"
    assert rows[0]["source_column_name"] == "participant_id"
    assert rows[0]["source_raw_value"] == rows[0]["participant_id"]
    assert rows[0]["source_line_number"] == "2"
    with (artifacts_dir / "quality_report.csv").open(encoding="utf-8-sig", newline="") as handle:
        quality_rows = list(csv.DictReader(handle))
    assert quality_rows
    assert all(row["status"] == "passed" for row in quality_rows)
    quality_by_id = {row["check_id"]: row for row in quality_rows}
    assert {
        "reactome_pathway_fields",
        "reactome_participant_fields",
        "reactome_source_foreign_keys",
        "reactome_asset_foreign_keys",
        "reactome_source_locator",
    } <= quality_by_id.keys()
    assert all(
        quality_by_id[check_id]["status"] == "passed"
        for check_id in {
            "reactome_pathway_fields",
            "reactome_participant_fields",
            "reactome_source_foreign_keys",
            "reactome_asset_foreign_keys",
            "reactome_source_locator",
        }
    )
    with (artifacts_dir / "literature.csv").open(encoding="utf-8-sig", newline="") as handle:
        assert list(csv.DictReader(handle)) == []
    with (artifacts_dir / "sample_metadata.csv").open(encoding="utf-8-sig", newline="") as handle:
        assert list(csv.DictReader(handle)) == []
    with (artifacts_dir / "source_list.csv").open(encoding="utf-8-sig", newline="") as handle:
        source_rows = list(csv.DictReader(handle))
    assert len(source_rows) == 1
    assert source_rows[0]["database"] == "reactome"
    assert source_rows[0]["source_id"] == rows[0]["source_id"]


def test_malformed_reactome_fixture_fails_validation_and_publishes_no_artifact(
    tmp_path: Path,
) -> None:
    fixture_dir = tmp_path / "reactome_fixture"
    fixture_dir.mkdir()
    shutil.copy2(_FIXTURE_DIR / "pathway_participants.tsv", fixture_dir / "pathway_participants.tsv")
    fixture_path = fixture_dir / "pathway_participants.tsv"
    fixture_path.write_text(
        "pathway_id\tpathway_name\tparticipant_id\tparticipant_name\tparticipant_type\tspecies\tinteraction_type\n"
        "R-HSA-199420\tApoptosis\t\tHydrogen peroxide\tchemical\tHomo sapiens\tparticipant\n",
        encoding="utf-8",
    )
    runner = PipelineRunner(
        task_id="task_reactome_malformed",
        base_dir=tmp_path / "tasks",
        fixture_dir=fixture_dir,
        topic="Reactome apoptosis",
        databases=["reactome"],
        specification=_specification(),
    )

    manifest = asyncio.run(runner.run())

    assert manifest.task_state is TaskState.FAILED
    assert manifest.validation.status == "invalid"
    artifacts_dir = tmp_path / "tasks" / "task_reactome_malformed" / "artifacts"
    assert not artifacts_dir.exists() or not any(artifacts_dir.iterdir())


def test_reactome_second_pathway_fails_validation_and_publishes_no_artifact(
    tmp_path: Path,
) -> None:
    fixture_dir = tmp_path / "reactome_multiple_pathways"
    fixture_dir.mkdir()
    fixture_path = fixture_dir / "pathway_participants.tsv"
    fixture_path.write_text(
        (_FIXTURE_DIR / "pathway_participants.tsv").read_text(encoding="utf-8")
        + "R-HSA-999999\tOther pathway\tR-HSA-000001\tOther participant\tpathway\tHomo sapiens\tparticipant\n",
        encoding="utf-8",
    )
    runner = PipelineRunner(
        task_id="task_reactome_multiple_pathways",
        base_dir=tmp_path / "tasks",
        fixture_dir=fixture_dir,
        topic="Reactome apoptosis",
        databases=["reactome"],
        specification=_specification(),
    )

    manifest = asyncio.run(runner.run())

    assert manifest.task_state is TaskState.FAILED
    assert manifest.validation.status == "invalid"
    artifacts_dir = tmp_path / "tasks" / "task_reactome_multiple_pathways" / "artifacts"
    assert not artifacts_dir.exists() or not (artifacts_dir / "pathway_members.csv").exists()


def _validated_reactome_staging(tmp_path: Path) -> tuple[Path, Path]:
    runner = PipelineRunner(
        task_id="task_reactome_provenance_negative",
        base_dir=tmp_path / "tasks",
        fixture_dir=_FIXTURE_DIR,
        topic="Reactome apoptosis",
        databases=["reactome"],
        specification=_specification(),
        defer_publication=True,
    )
    manifest = asyncio.run(runner.run())
    assert manifest.task_state is TaskState.COMPLETED
    root = tmp_path / "tasks" / "task_reactome_provenance_negative"
    source_path = next((root / "source_assets").glob("*"))
    return root / "staging" / runner.ctx.run_id, source_path


def _reactome_validation(staging: Path, source_path: Path, tmp_path: Path) -> tuple[str, dict[str, dict[str, str]]]:
    from app.pipeline.stages.validation import _validate_package

    summary, checks = _validate_package(
        staging, source_path, tmp_path / "logs" / "validation.json"
    )
    return summary.status, {str(check["check_id"]): check for check in checks}


def test_reactome_validation_rejects_locator_header_mismatch(tmp_path: Path) -> None:
    staging, source_path = _validated_reactome_staging(tmp_path)
    with (staging / "pathway_members.csv").open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    rows[0]["source_column_name"] = "pathway_id"
    with (staging / "pathway_members.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)

    status, checks = _reactome_validation(staging, source_path, tmp_path)
    assert status == "invalid"
    assert checks["reactome_source_locator"]["status"] == "failed"


def test_reactome_validation_rejects_asset_source_mismatch(tmp_path: Path) -> None:
    staging, source_path = _validated_reactome_staging(tmp_path)
    with (staging / "source_assets.csv").open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    rows[0]["source_id"] = "src_other"
    with (staging / "source_assets.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)

    status, checks = _reactome_validation(staging, source_path, tmp_path)
    assert status == "invalid"
    assert checks["reactome_asset_source_consistency"]["status"] == "failed"


def test_reactome_validation_rejects_source_list_dataset_mismatch(tmp_path: Path) -> None:
    staging, source_path = _validated_reactome_staging(tmp_path)
    with (staging / "source_list.csv").open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    rows[0]["accession"] = "R-HSA-999999"
    with (staging / "source_list.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)

    status, checks = _reactome_validation(staging, source_path, tmp_path)
    assert status == "invalid"
    assert checks["reactome_dataset_source_consistency"]["status"] == "failed"


def test_reactome_validation_rejects_pathway_dataset_mismatch(tmp_path: Path) -> None:
    staging, source_path = _validated_reactome_staging(tmp_path)
    with (staging / "pathway_members.csv").open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    rows[0]["pathway_id"] = "R-HSA-999999"
    with (staging / "pathway_members.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)

    status, checks = _reactome_validation(staging, source_path, tmp_path)
    assert status == "invalid"
    assert checks["reactome_pathway_dataset_consistency"]["status"] == "failed"


def test_reactome_validation_rejects_second_legal_source_pathway(tmp_path: Path) -> None:
    staging, source_path = _validated_reactome_staging(tmp_path)
    source_lines = source_path.read_text(encoding="utf-8").splitlines()
    source_lines.append(
        "R-HSA-999999\\tOther pathway\\tR-HSA-000001\\tOther participant\\tpathway\\tHomo sapiens\\tparticipant"
    )
    source_path.write_text("\\n".join(source_lines) + "\\n", encoding="utf-8")
    with (staging / "source_assets.csv").open(encoding="utf-8-sig", newline="") as handle:
        asset_rows = list(csv.DictReader(handle))
    asset_rows[0]["size_bytes"] = str(source_path.stat().st_size)
    asset_rows[0]["sha256"] = hashlib.sha256(source_path.read_bytes()).hexdigest()
    with (staging / "source_assets.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=asset_rows[0].keys())
        writer.writeheader()
        writer.writerows(asset_rows)
    with (staging / "pathway_members.csv").open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    rows[0]["pathway_id"] = "R-HSA-999999"
    with (staging / "pathway_members.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)

    status, checks = _reactome_validation(staging, source_path, tmp_path)
    assert status == "invalid"
    assert checks["reactome_pathway_dataset_consistency"]["status"] == "failed"
