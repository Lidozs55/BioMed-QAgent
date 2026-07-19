from __future__ import annotations

import asyncio
import csv
import json
from pathlib import Path

from app.pipeline.runner import PipelineRunner

FIXTURE_DIR = (
    Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"
)
MANDATORY_ARTIFACTS = {
    "run_manifest.json",
    "main_data.csv",
    "literature.csv",
    "dataset_catalog.csv",
    "sample_metadata.csv",
    "field_descriptions.csv",
    "field_mapping.csv",
    "source_list.csv",
    "source_relations.csv",
    "source_assets.csv",
    "download_log.csv",
    "processing_log.csv",
    "quality_report.csv",
    "warnings.csv",
}


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def test_pinned_fixture_pipeline_builds_validated_traceable_package(
    tmp_path: Path,
) -> None:
    runner = PipelineRunner(
        task_id="task_pinned",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())
    artifacts = tmp_path / "tasks" / "task_pinned" / "artifacts"

    assert {path.name for path in artifacts.iterdir()} == MANDATORY_ARTIFACTS
    assert manifest.validation.status == "valid"
    assert manifest.task_state.value == "completed"
    assert manifest.validation.failed_count == 0

    main_rows = read_csv(artifacts / "main_data.csv")
    datasets = {row["dataset_id"] for row in read_csv(artifacts / "dataset_catalog.csv")}
    samples = {row["sample_id"] for row in read_csv(artifacts / "sample_metadata.csv")}
    sources = {row["source_id"] for row in read_csv(artifacts / "source_list.csv")}
    assets = {row["asset_id"] for row in read_csv(artifacts / "source_assets.csv")}
    descriptions = {
        row["field_name"] for row in read_csv(artifacts / "field_descriptions.csv")
    }

    assert len(main_rows) == 48
    assert {row["dataset_id"] for row in main_rows} <= datasets
    assert {row["sample_id"] for row in main_rows} <= samples
    assert {row["source_id"] for row in main_rows} <= sources
    assert {row["asset_id"] for row in main_rows} <= assets
    assert set(main_rows[0]) == descriptions

    quality = read_csv(artifacts / "quality_report.csv")
    lineage = next(row for row in quality if row["check_id"] == "source_value_lineage")
    assert lineage["status"] == "passed"
    assert lineage["checked_count"] == "48"
    assert lineage["failed_count"] == "0"

    manifest_json = json.loads((artifacts / "run_manifest.json").read_text("utf-8"))
    assert manifest_json["validation"]["status"] == "valid"
    assert all(
        entry["relative_path"].startswith("artifacts/")
        for entry in manifest_json["artifacts"]
    )


def test_pinned_pipeline_persists_stage_attempts_and_replayable_events(
    tmp_path: Path,
) -> None:
    runner = PipelineRunner(
        task_id="task_events",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())
    logs = tmp_path / "tasks" / "task_events" / "logs"

    attempts = [
        json.loads(line)
        for line in (logs / "stage_attempts.jsonl").read_text("utf-8").splitlines()
    ]
    events = runner.events

    assert len(attempts) == 5
    assert manifest.stage_attempt_ids == sorted(
        attempt["stage_attempt_id"] for attempt in attempts
    )
    assert all(attempt["status"] == "succeeded" for attempt in attempts)
    assert [event.sequence for event in events] == list(range(1, len(events) + 1))
    assert events[0].type.value == "task_created"
    assert events[-1].type.value == "task_completed"
    assert any(event.type.value == "artifact_produced" for event in events)
