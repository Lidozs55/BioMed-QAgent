"""Parity checks for the shared TypeScript/Python wire fixture."""

from __future__ import annotations

import json
from pathlib import Path

from app.datasets.contracts import DatasetManifest, DatasetPublication
from app.domain.contracts import EventEnvelope, RunRecord, RunStatus, TaskMode, TaskSummary
from app.domain.contracts.dataset_state import BuildResult

FIXTURE_PATH = (
    Path(__file__).parents[2] / "tests" / "migration" / "contracts" / "wire-contracts.json"
)
FIXTURE = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def test_event_envelopes_preserve_schema_sequence_and_run_linkage() -> None:
    envelopes = [
        EventEnvelope.model_validate(item) for item in FIXTURE["event_envelopes"]
    ]

    assert [envelope.schema_version for envelope in envelopes] == ["1.0", "2.0"]
    assert [envelope.sequence for envelope in envelopes] == [41, 42]
    assert [envelope.run_id for envelope in envelopes] == [None, "run_fixture_001"]


def test_dataset_build_and_publication_contracts_accept_shared_fixture() -> None:
    build_results = [
        BuildResult.model_validate(item) for item in FIXTURE["build_results"]
    ]
    manifest = DatasetManifest.model_validate(FIXTURE["dataset_manifest"])
    publication = DatasetPublication.model_validate(FIXTURE["dataset_publication"])

    assert [result.status.value for result in build_results] == [
        "succeeded",
        "partial_success",
        "no_data",
        "spec_rejected",
    ]
    assert [artifact.role.value for artifact in manifest.artifacts] == [
        "primary_dataset",
        "supporting_dataset",
        "schema",
        "provenance",
        "audit_report",
    ]
    assert publication.supersedes_publication_id == "publication_fixture_000"


def test_task_and_run_status_values_accept_shared_fixture() -> None:
    task = TaskSummary.model_validate(FIXTURE["task_summary"])
    runs = [RunRecord.model_validate(item) for item in FIXTURE["run_records"]]

    assert FIXTURE["task_modes"] == [mode.value for mode in TaskMode]
    assert FIXTURE["run_statuses"] == [status.value for status in RunStatus]
    assert task.mode is TaskMode.AGENT
    assert [run.status for run in runs] == list(RunStatus)
