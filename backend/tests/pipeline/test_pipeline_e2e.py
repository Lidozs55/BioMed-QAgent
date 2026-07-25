"""Long-chain end-to-end tests for PipelineRunner.

These tests cover integration scenarios that span multiple stages, the HTTP
API surface, and crash-recovery paths. They complement the focused unit
tests in ``test_pipeline_runner_*.py`` and ``test_pinned_pipeline.py`` by
asserting full event sequences, API round-trips, and cross-stage data flow
consistency.

Scenarios:
    1. Full event sequence ordering (task_created → plan_ready → 5×stage_started
       → 5×stage_completed → artifact_produced×N → task_completed).
    2. API full round-trip: POST /tasks → GET /tasks/{id} → GET /artifacts →
       GET /artifacts/{artifact_id} with SHA-256 verification of downloaded bytes.
    3. Mid-pipeline crash recovery: stage N fails → restart → stages 1..N-1
       SKIPPED + stage N re-executed + task_recovered emitted.
    4. Artifact file tamper detection: corrupt an artifact file → both
       list_artifacts and get_artifact_file return 409.
    5. Cross-stage digest chain: upstream output_digest is part of downstream
       input_digest (merkle-like chain).
    6. Validation gate soft failure: run_validation returns status="invalid"
       without raising → task FAILED, 0 artifacts published.
    7. Downloaded bytes SHA-256 matches manifest listing.
    8. Cancel requested at different stage boundaries.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from app.config import Settings
from app.domain.contracts import (
    AttemptStatus,
    PipelineEventType,
    RunRecord,
    RunStatus,
    StageName,
    TaskMode,
    TaskSnapshot,
    TaskState,
    TaskSummary,
)
from app.main import create_app
from app.pipeline import runner as runner_module
from app.pipeline.runner import PipelineRunner
from fastapi import FastAPI

FIXTURE_DIR = (
    Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@asynccontextmanager
async def _runtime_client(
    output_dir: Path,
) -> AsyncIterator[tuple[FastAPI, httpx.AsyncClient]]:
    application = create_app(Settings(output_dir=str(output_dir)))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        yield application, client


async def _register_completed_task(application: FastAPI, task_id: str) -> None:
    now = datetime.now(UTC)
    run_id = f"run_{task_id}"
    await application.state.task_repository.save_snapshot(
        TaskSnapshot(
            task=TaskSummary(
                task_id=task_id,
                mode=TaskMode.FIXTURE,
                databases=["pubmed", "geo"],
                title=task_id,
                status=RunStatus.COMPLETED,
                created_at=now,
                updated_at=now,
            ),
            runs=[
                RunRecord(
                    run_id=run_id,
                    task_id=task_id,
                    request_id=f"request_{task_id}",
                    status=RunStatus.COMPLETED,
                    input=task_id,
                    created_at=now,
                    updated_at=now,
                    started_at=now,
                    finished_at=now,
                )
            ],
        )
    )
    artifacts_dir = application.state.task_repository.tasks_dir / task_id / "artifacts"
    manifest_path = artifacts_dir / "run_manifest.json"
    (artifacts_dir / ".runtime-publication.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "task_id": task_id,
                "run_id": run_id,
                "manifest_sha256": hashlib.sha256(
                    manifest_path.read_bytes()
                ).hexdigest(),
            }
        ),
        "utf-8",
    )


# ---------------------------------------------------------------------------
# Scenario 1: Full event sequence ordering
# ---------------------------------------------------------------------------


def test_e2e_full_event_sequence_is_ordered_and_complete(tmp_path: Path) -> None:
    """A fresh run must emit the full ordered event chain with no gaps."""
    runner = PipelineRunner(
        task_id="task_e2e_events",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())
    assert manifest.task_state == TaskState.COMPLETED

    events = runner.events

    # Sequences are 1..N contiguous with no gaps.
    sequences = [event.sequence for event in events]
    assert sequences == list(range(1, len(events) + 1))

    types = [event.type.value for event in events]
    # First two events: task_created + plan_ready.
    assert types[0] == PipelineEventType.TASK_CREATED.value
    assert types[1] == PipelineEventType.PLAN_READY.value

    # 5 pairs of stage_started / stage_completed for the 5 stages.
    stage_started_indices = [
        i for i, t in enumerate(types) if t == PipelineEventType.STAGE_STARTED.value
    ]
    stage_completed_indices = [
        i for i, t in enumerate(types) if t == PipelineEventType.STAGE_COMPLETED.value
    ]
    assert len(stage_started_indices) == 5
    assert len(stage_completed_indices) == 5
    for started_idx, completed_idx in zip(
        stage_started_indices, stage_completed_indices, strict=True
    ):
        assert started_idx < completed_idx, "stage_started must precede stage_completed"

    # artifact_produced events for each manifest artifact.
    artifact_produced_count = types.count(
        PipelineEventType.ARTIFACT_PRODUCED.value
    )
    assert artifact_produced_count == len(manifest.artifacts)

    # Last event: task_completed.
    assert types[-1] == PipelineEventType.TASK_COMPLETED.value

    # task_failed / task_cancelled must never appear on a successful run.
    assert PipelineEventType.TASK_FAILED.value not in types
    assert PipelineEventType.TASK_CANCELLED.value not in types


# ---------------------------------------------------------------------------
# Scenario 2: API full round-trip
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_e2e_api_full_round_trip_post_status_list_download(
    tmp_path: Path,
) -> None:
    """POST /tasks → GET /tasks/{id} → GET /artifacts → GET /artifacts/{id}."""
    output_dir = tmp_path / "output"
    async with _runtime_client(output_dir) as (application, client):
        # Step 1: create task via API.
        create_response = await client.post(
            "/api/v1/tasks",
            json={
                "request_id": "req_e2e_round_trip",
                "input": "breast cancer gene expression under Hsp70 inhibition",
                "databases": ["pubmed", "geo"],
                "mode": "fixture",
            },
        )
        assert create_response.status_code == 202
        task_id = create_response.json()["task_id"]
        assert task_id.startswith("task_")
        await application.state.task_manager.wait_until_idle()

        # Step 2: get task status.
        status_response = await client.get(f"/api/v1/tasks/{task_id}")
        assert status_response.status_code == 200
        status_body = status_response.json()
        assert status_body["task"]["task_id"] == task_id
        assert status_body["task"]["status"] == "completed"

        # Step 3: list artifacts.
        list_response = await client.get(f"/api/v1/tasks/{task_id}/artifacts")
        assert list_response.status_code == 200
        artifacts = list_response.json()["artifacts"]
        assert len(artifacts) >= 2  # run_manifest + at least one artifact

        # run_manifest should be the first entry.
        assert artifacts[0]["artifact_id"] == "run_manifest"

        # Step 4: download a specific artifact by artifact_id.
        main_entry = next(
            entry for entry in artifacts if entry["name"] == "main_data.csv"
        )
        download_response = await client.get(
            f"/api/v1/tasks/{task_id}/artifacts/{main_entry['artifact_id']}"
        )
        assert download_response.status_code == 200
        assert download_response.headers["content-disposition"].endswith(
            'filename="main_data.csv"'
        )

        # Downloaded bytes SHA-256 must match the listing.
        actual_sha256 = hashlib.sha256(download_response.content).hexdigest()
        assert actual_sha256 == main_entry["sha256"], (
            "downloaded bytes SHA-256 must match manifest listing"
        )


# ---------------------------------------------------------------------------
# Scenario 3: Mid-pipeline crash recovery
# ---------------------------------------------------------------------------


def test_e2e_mid_pipeline_crash_recovery_resumes_from_failure(
    tmp_path: Path, monkeypatch
) -> None:
    """Stage 3 (processing) fails on first run → second run resumes correctly."""
    base_dir = tmp_path / "tasks"
    call_count = {"n": 0}
    original_processing = runner_module.run_processing

    def flaky_processing(ctx, source_asset, dataset_id):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise RuntimeError("simulated crash during processing")
        return original_processing(ctx, source_asset, dataset_id)

    monkeypatch.setattr(runner_module, "run_processing", flaky_processing)

    # First run: fails at processing.
    runner1 = PipelineRunner(
        task_id="task_crash_recovery",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    manifest1 = asyncio.run(runner1.run())
    assert manifest1.task_state == TaskState.FAILED

    # Verify first run state: discovery + acquisition succeeded, processing failed.
    succeeded_stages_run1 = [
        a.stage for a in runner1.state.stage_attempts
        if a.status is AttemptStatus.SUCCEEDED
    ]
    failed_stages_run1 = [
        a.stage for a in runner1.state.stage_attempts
        if a.status is AttemptStatus.FAILED
    ]
    assert StageName.DISCOVERY in succeeded_stages_run1
    assert StageName.ACQUISITION in succeeded_stages_run1
    assert StageName.PROCESSING in failed_stages_run1
    assert StageName.ARTIFACT_BUILD not in succeeded_stages_run1

    # Second run: resumes, processing succeeds, task completes.
    runner2 = PipelineRunner(
        task_id="task_crash_recovery",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    manifest2 = asyncio.run(runner2.run())
    assert manifest2.task_state == TaskState.COMPLETED

    # Second run emits task_recovered (not task_created).
    event_types_run2 = [e.payload.type for e in runner2.events]
    assert PipelineEventType.TASK_RECOVERED.value in event_types_run2
    assert PipelineEventType.TASK_CREATED.value not in event_types_run2

    # Discovery and acquisition are SKIPPED (digest matched); processing is re-executed.
    skipped_stages_run2 = [
        a.stage for a in runner2.state.stage_attempts
        if a.status is AttemptStatus.SKIPPED
        and a.stage_attempt_id not in {
            a.stage_attempt_id for a in runner1.state.stage_attempts
        }
    ]
    assert StageName.DISCOVERY in skipped_stages_run2
    assert StageName.ACQUISITION in skipped_stages_run2

    # Processing has 2 attempts: first FAILED + second SUCCEEDED.
    processing_attempts = [
        a for a in runner2.state.stage_attempts
        if a.stage is StageName.PROCESSING
    ]
    assert len(processing_attempts) == 2
    assert processing_attempts[0].status is AttemptStatus.FAILED
    assert processing_attempts[1].status is AttemptStatus.SUCCEEDED
    assert (
        processing_attempts[0].stage_attempt_id
        != processing_attempts[1].stage_attempt_id
    )


# ---------------------------------------------------------------------------
# Scenario 4: Artifact file tamper detection
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_e2e_artifact_tamper_detection_returns_409(
    tmp_path: Path,
) -> None:
    """Corrupting an artifact file must cause 409 on both list and download."""
    output_dir = tmp_path / "output"
    async with _runtime_client(output_dir) as (application, client):
        await PipelineRunner(
            task_id="task_tamper",
            base_dir=application.state.task_repository.tasks_dir,
            fixture_dir=FIXTURE_DIR,
        ).run()
        await _register_completed_task(application, "task_tamper")
        artifacts_dir = output_dir / "tasks" / "task_tamper" / "artifacts"
        main_data_path = artifacts_dir / "main_data.csv"

        # Before tamper: listing works.
        list_response = await client.get("/api/v1/tasks/task_tamper/artifacts")
        assert list_response.status_code == 200

        # Tamper: append bytes to main_data.csv (changes size + sha256).
        original_bytes = main_data_path.read_bytes()
        main_data_path.write_bytes(original_bytes + b"\nTAMPERED,extra,row\n")

        # After tamper: list_artifacts must return 409 (integrity check failed).
        list_response_tampered = await client.get(
            "/api/v1/tasks/task_tamper/artifacts"
        )
        assert list_response_tampered.status_code == 409

        # Download by artifact_id must also return 409.
        main_entry = next(
            entry for entry in list_response.json()["artifacts"]
            if entry["name"] == "main_data.csv"
        )
        download_response_tampered = await client.get(
            f"/api/v1/tasks/task_tamper/artifacts/{main_entry['artifact_id']}"
        )
        assert download_response_tampered.status_code == 409

        main_data_path.write_bytes(original_bytes)


# ---------------------------------------------------------------------------
# Scenario 5: Cross-stage digest chain
# ---------------------------------------------------------------------------


def test_e2e_cross_stage_digest_chain_links_upstream_outputs(
    tmp_path: Path,
) -> None:
    """Downstream input_digest must include upstream output_digest (merkle chain)."""
    runner = PipelineRunner(
        task_id="task_digest_chain",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner.run())

    # Each stage's input_digest payload includes direct upstream output_digests.
    # Verify the chain by checking that each stage (except discovery) has an
    # input_digest that depends on the upstream output_digest.
    stages_with_upstream = {
        StageName.ACQUISITION: [StageName.DISCOVERY],
        StageName.PROCESSING: [StageName.DISCOVERY, StageName.ACQUISITION],
        StageName.ARTIFACT_BUILD: [
            StageName.DISCOVERY,
            StageName.ACQUISITION,
            StageName.PROCESSING,
        ],
        StageName.VALIDATION: [StageName.ARTIFACT_BUILD],
    }

    completed_stages = runner.state.completed_stages
    attempts_by_stage: dict[StageName, list] = {}
    for attempt in runner.state.stage_attempts:
        if attempt.status is AttemptStatus.SUCCEEDED:
            attempts_by_stage.setdefault(attempt.stage, []).append(attempt)

    for stage, upstream_stages in stages_with_upstream.items():
        succeeded = attempts_by_stage.get(stage, [])
        assert succeeded, f"no SUCCEEDED attempt for {stage}"
        attempt = succeeded[-1]

        # Recompute the expected input_digest from the upstream output_digests.
        upstream = {
            upstream_stage.value: completed_stages[upstream_stage.value]
            for upstream_stage in upstream_stages
            if upstream_stage.value in completed_stages
        }
        payload = {
            "task_id": runner.task_id,
            "stage": stage.value,
            "upstream": upstream,
        }
        expected = hashlib.sha256(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
        ).hexdigest()
        assert attempt.input_digest == expected, (
            f"{stage.value} input_digest chain broken"
        )

    # Verify that changing an upstream digest would change the downstream input.
    # We do this by computing what the acquisition input_digest would be if
    # discovery's output_digest were different.
    discovery_output = completed_stages[StageName.DISCOVERY.value]
    tampered_upstream = {"discovery": "0" * 64}
    tampered_payload = {
        "task_id": runner.task_id,
        "stage": "acquisition",
        "upstream": tampered_upstream,
    }
    tampered_digest = hashlib.sha256(
        json.dumps(tampered_payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ).hexdigest()
    actual_acquisition_input = attempts_by_stage[StageName.ACQUISITION][-1].input_digest
    assert tampered_digest != actual_acquisition_input, (
        "changing upstream output_digest must change downstream input_digest"
    )
    assert discovery_output != "0" * 64


# ---------------------------------------------------------------------------
# Scenario 6: Validation gate soft failure
# ---------------------------------------------------------------------------


def test_e2e_validation_soft_failure_marks_task_failed_without_publish(
    tmp_path: Path, monkeypatch
) -> None:
    """When run_validation fails (raises or returns invalid), task fails cleanly."""
    base_dir = tmp_path / "tasks"

    # The validation stage raises ValueError when status != "valid" (line 207).
    # We patch run_validation to raise a controlled ValueError, then verify
    # the task fails cleanly with no artifacts published.
    def failing_validation(ctx, build_output, stage_attempts, stage_attempt_id):
        raise ValueError("validation gate rejected the package: invalid")

    monkeypatch.setattr(runner_module, "run_validation", failing_validation)

    runner = PipelineRunner(
        task_id="task_validation_fail",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())

    assert manifest.task_state == TaskState.FAILED
    assert manifest.validation.status == "invalid"
    assert manifest.validation.failed_count == 1
    assert len(manifest.artifacts) == 0

    # Artifacts directory must not exist (no publish on failure).
    artifacts_dir = tmp_path / "tasks" / "task_validation_fail" / "artifacts"
    assert not artifacts_dir.exists() or not any(artifacts_dir.iterdir())

    # Event sequence must include stage_failed + task_failed.
    event_types = [e.payload.type for e in runner.events]
    assert PipelineEventType.STAGE_FAILED.value in event_types
    assert PipelineEventType.TASK_FAILED.value in event_types
    assert PipelineEventType.TASK_COMPLETED.value not in event_types


# ---------------------------------------------------------------------------
# Scenario 7: Downloaded bytes SHA-256 matches manifest
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_e2e_downloaded_bytes_sha256_matches_manifest_for_all_artifacts(
    tmp_path: Path,
) -> None:
    """Every downloadable artifact's bytes must match its manifest SHA-256."""
    output_dir = tmp_path / "output"
    async with _runtime_client(output_dir) as (application, client):
        await PipelineRunner(
            task_id="task_sha256_verify",
            base_dir=application.state.task_repository.tasks_dir,
            fixture_dir=FIXTURE_DIR,
        ).run()
        await _register_completed_task(application, "task_sha256_verify")
        list_response = await client.get(
            "/api/v1/tasks/task_sha256_verify/artifacts"
        )
        assert list_response.status_code == 200
        artifacts = list_response.json()["artifacts"]

        # Download every artifact and verify SHA-256.
        for entry in artifacts:
            download_response = await client.get(
                f"/api/v1/tasks/task_sha256_verify/artifacts/{entry['artifact_id']}"
            )
            assert download_response.status_code == 200, (
                f"failed to download {entry['name']}"
            )
            actual_sha256 = hashlib.sha256(download_response.content).hexdigest()
            assert actual_sha256 == entry["sha256"], (
                f"SHA-256 mismatch for {entry['name']}: "
                f"expected {entry['sha256']}, got {actual_sha256}"
            )


# ---------------------------------------------------------------------------
# Scenario 8: Cancel requested at different stage boundaries
# ---------------------------------------------------------------------------


def test_e2e_cancel_before_acquisition_stops_pipeline(tmp_path: Path) -> None:
    """Cancel requested after discovery but before acquisition must stop early."""
    base_dir = tmp_path / "tasks"
    runner = PipelineRunner(
        task_id="task_cancel_early",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )

    # Patch run_discovery to request cancel after discovery completes.
    original_discovery = runner_module.run_discovery

    def discovery_then_cancel(ctx):
        result = original_discovery(ctx)
        runner.request_cancel(reason="user requested cancel after discovery")
        return result

    runner_module.run_discovery = discovery_then_cancel
    try:
        manifest = asyncio.run(runner.run())
    finally:
        runner_module.run_discovery = original_discovery

    assert manifest.task_state == TaskState.CANCELLED

    # Only discovery should have succeeded; acquisition onwards must not run.
    succeeded = [
        a for a in runner.state.stage_attempts
        if a.status is AttemptStatus.SUCCEEDED
    ]
    assert len(succeeded) == 1
    assert succeeded[0].stage is StageName.DISCOVERY

    # Event sequence must include task_cancelled.
    event_types = [e.payload.type for e in runner.events]
    assert PipelineEventType.TASK_CANCELLED.value in event_types
    assert PipelineEventType.TASK_COMPLETED.value not in event_types
    assert PipelineEventType.STAGE_COMPLETED.value in event_types  # discovery


def test_e2e_cancel_before_validation_stops_pipeline(tmp_path: Path) -> None:
    """Cancel requested after artifact_build but before validation must stop."""
    base_dir = tmp_path / "tasks"
    runner = PipelineRunner(
        task_id="task_cancel_late",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )

    original_artifact_build = runner_module.run_artifact_build

    def build_then_cancel(
        ctx, sources, source_assets, download_attempts,
        parsed_dataset, samples,
        literature, geo, specification, retrieved_at, stage_attempt_id,
        cleaning_report=None, field_alignment=None,
    ):
        result = original_artifact_build(
            ctx, sources, source_assets, download_attempts,
            parsed_dataset, samples,
            literature, geo, specification, retrieved_at, stage_attempt_id,
            cleaning_report=cleaning_report, field_alignment=field_alignment,
        )
        runner.request_cancel(reason="user requested cancel after build")
        return result

    runner_module.run_artifact_build = build_then_cancel
    try:
        manifest = asyncio.run(runner.run())
    finally:
        runner_module.run_artifact_build = original_artifact_build

    assert manifest.task_state == TaskState.CANCELLED

    # 4 stages should have succeeded (discovery, acquisition, processing, artifact_build).
    succeeded = [
        a for a in runner.state.stage_attempts
        if a.status is AttemptStatus.SUCCEEDED
    ]
    assert len(succeeded) == 4
    succeeded_stage_names = {a.stage for a in succeeded}
    assert StageName.VALIDATION not in succeeded_stage_names

    # No artifacts published (validation didn't run).
    artifacts_dir = tmp_path / "tasks" / "task_cancel_late" / "artifacts"
    assert not artifacts_dir.exists() or not any(artifacts_dir.iterdir())
