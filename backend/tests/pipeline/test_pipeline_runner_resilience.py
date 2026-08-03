"""PipelineRunner resilience contract tests.

Covers P0 items: cancel requested -> cancelled, per-stage timeout,
total task timeout, no silent fallback to mock on failure.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import threading
import time
from pathlib import Path

import pytest
from app.domain.contracts import (
    AttemptStatus,
    ErrorCode,
    StageName,
    TaskState,
    UserInputRequiredPayload,
    UserInputResumedPayload,
)
from app.pipeline.runner import (
    DEFAULT_STAGE_TIMEOUTS,
    PipelineEventSinkError,
    PipelineRunner,
)
from app.pipeline.stages import DownloadError, PipelineCancelledError

FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"


def test_live_parameter_digest_does_not_read_missing_fixture_directory(
    tmp_path: Path,
) -> None:
    missing_fixture_dir = tmp_path / "packaged-app" / "tests" / "fixtures"
    runner = PipelineRunner(
        task_id="task_packaged_live_digest",
        base_dir=tmp_path / "tasks",
        fixture_dir=missing_fixture_dir,
        mode="live",
        databases=["gdc"],
    )

    assert not missing_fixture_dir.exists()
    digest = runner._compute_parameter_digest(StageName.DISCOVERY)
    assert len(digest) == 64


@pytest.mark.asyncio
async def test_user_input_submission_matches_request_and_is_one_shot(
    tmp_path: Path,
) -> None:
    required_visible = asyncio.Event()
    release_sink = asyncio.Event()
    runner: PipelineRunner

    async def event_sink(event) -> None:
        if isinstance(event.payload, UserInputRequiredPayload):
            required_visible.set()
            await release_sink.wait()

    runner = PipelineRunner(
        task_id="task_user_input_identity",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        mode="live",
        event_sink=event_sink,
    )
    waiting = asyncio.create_task(
        runner._await_user_input(  # noqa: SLF001
            request_id="plan-identity",
            prompt_kind="plan_confirmation",
            summary="confirm identity",
            timeout=1,
        )
    )
    await asyncio.wait_for(required_visible.wait(), timeout=1)

    assert not runner.submit_user_input(
        UserInputResumedPayload(
            request_id="wrong-id",
            decision="approve",
        )
    )
    accepted = UserInputResumedPayload(
        request_id="plan-identity",
        decision="approve",
        detail={"sequence": 1},
    )
    assert runner.submit_user_input(accepted)
    assert not runner.submit_user_input(
        UserInputResumedPayload(
            request_id="plan-identity",
            decision="reject",
            detail={"sequence": 2},
        )
    )

    release_sink.set()
    assert await asyncio.wait_for(waiting, timeout=1) == accepted


def test_fixture_plan_confirmation_emits_required_and_auto_resume_in_order(
    tmp_path: Path,
) -> None:
    runner = PipelineRunner(
        task_id="task_fixture_user_input_audit",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        mode="fixture",
    )

    manifest = asyncio.run(runner.run())

    assert manifest.task_state is TaskState.COMPLETED
    required = [
        event
        for event in runner.events
        if isinstance(event.payload, UserInputRequiredPayload)
    ]
    resumed = [
        event
        for event in runner.events
        if isinstance(event.payload, UserInputResumedPayload)
    ]
    assert len(required) == 1
    assert len(resumed) == 1
    assert required[0].payload.fixture_exempt
    assert resumed[0].payload.request_id == required[0].payload.request_id
    assert resumed[0].payload.decision == "approve"
    first_stage = next(
        index
        for index, event in enumerate(runner.events)
        if event.payload.type.value == "stage_started"
    )
    assert runner.events.index(required[0]) < runner.events.index(resumed[0])
    assert runner.events.index(resumed[0]) < first_stage


@pytest.mark.asyncio
async def test_user_input_timeout_is_distinct_and_populates_expiry(
    tmp_path: Path,
) -> None:
    runner = PipelineRunner(
        task_id="task_user_input_timeout",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        mode="live",
        total_timeout=1,
        user_input_timeout=0.02,
    )

    manifest = await runner.run()

    assert manifest.task_state is TaskState.FAILED
    required = next(
        event
        for event in runner.events
        if isinstance(event.payload, UserInputRequiredPayload)
    )
    assert required.payload.expires_at is not None
    assert required.payload.expires_at > required.timestamp
    failed = next(
        event for event in runner.events if event.payload.type.value == "task_failed"
    )
    assert "user input timeout" in failed.payload.error.message.lower()
    assert not any(
        event.payload.type.value == "stage_started" for event in runner.events
    )


@pytest.mark.asyncio
async def test_user_input_wait_does_not_consume_total_timeout_budget(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner: PipelineRunner

    async def event_sink(event) -> None:
        if isinstance(event.payload, UserInputRequiredPayload):
            await asyncio.sleep(0.08)
            assert runner.submit_user_input(
                UserInputResumedPayload(
                    request_id=event.payload.request_id,
                    decision="approve",
                )
            )

    runner = PipelineRunner(
        task_id="task_user_input_budget",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        mode="live",
        total_timeout=0.05,
        user_input_timeout=0.5,
        event_sink=event_sink,
    )
    expected = object()

    async def controlled_inner() -> object:
        await runner._await_user_input(  # noqa: SLF001
            request_id="plan-budget",
            prompt_kind="plan_confirmation",
            summary="confirm budget",
        )
        await asyncio.sleep(0.02)
        return expected

    monkeypatch.setattr(runner, "_run_inner", controlled_inner)

    assert await runner.run() is expected


def test_runner_cancels_when_requested_before_stage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.pipeline.runner as runner_module

    original_acquisition = runner_module.run_acquisition
    runner_holder: dict[str, PipelineRunner | None] = {"runner": None}

    def cancel_after_acquisition(ctx, retrieved_at):
        result = original_acquisition(ctx, retrieved_at)
        runner = runner_holder["runner"]
        assert runner is not None
        runner.request_cancel("test cancel")
        return result

    monkeypatch.setattr(runner_module, "run_acquisition", cancel_after_acquisition)

    runner = PipelineRunner(
        task_id="task_cancel",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    runner_holder["runner"] = runner
    manifest = asyncio.run(runner.run())

    assert manifest.task_state == TaskState.CANCELLED

    attempts = runner.state.stage_attempts
    stages = [a.stage for a in attempts]
    assert StageName.DISCOVERY in stages
    assert StageName.ACQUISITION in stages
    assert StageName.PROCESSING not in stages
    assert StageName.ARTIFACT_BUILD not in stages
    assert StageName.VALIDATION not in stages

    event_types = [e.payload.type for e in runner.events]
    assert "task_cancelled" in event_types


def test_runner_terminalizes_inflight_attempt_on_stage_cancellation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def cancelling_discovery(ctx):
        raise PipelineCancelledError("cancelled inside discovery")

    monkeypatch.setattr("app.pipeline.runner.run_discovery", cancelling_discovery)
    runner = PipelineRunner(
        task_id="task_cancel_inflight",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )

    manifest = asyncio.run(runner.run())

    assert manifest.task_state == TaskState.CANCELLED
    assert len(runner.state.stage_attempts) == 1
    cancelled = runner.state.stage_attempts[0]
    assert cancelled.stage is StageName.DISCOVERY
    assert cancelled.status is AttemptStatus.CANCELLED
    assert cancelled.attempt == 1
    started = next(
        event for event in runner.events if event.payload.type == "stage_started"
    )
    assert cancelled.stage_attempt_id == started.stage_attempt_id
    assert cancelled.attempt == started.payload.attempt
    assert runner.state.inflight_attempt is None
    attempts_path = runner.workdir.logs / "stage_attempts.jsonl"
    assert [
        json.loads(line) for line in attempts_path.read_text("utf-8").splitlines()
    ] == [attempt.model_dump(mode="json") for attempt in runner.state.stage_attempts]


def test_runner_terminalizes_inflight_attempt_on_stage_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def failing_discovery(ctx):
        raise RuntimeError("discovery failed")

    monkeypatch.setattr("app.pipeline.runner.run_discovery", failing_discovery)
    runner = PipelineRunner(
        task_id="task_fail_inflight",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )

    manifest = asyncio.run(runner.run())

    assert manifest.task_state == TaskState.FAILED
    assert len(runner.state.stage_attempts) == 1
    failed = runner.state.stage_attempts[0]
    assert failed.stage is StageName.DISCOVERY
    assert failed.status is AttemptStatus.FAILED
    assert failed.attempt == 1
    started = next(
        event for event in runner.events if event.payload.type == "stage_started"
    )
    assert failed.stage_attempt_id == started.stage_attempt_id
    assert failed.attempt == started.payload.attempt
    assert runner.state.inflight_attempt is None
    attempts_path = runner.workdir.logs / "stage_attempts.jsonl"
    assert [
        json.loads(line) for line in attempts_path.read_text("utf-8").splitlines()
    ] == [attempt.model_dump(mode="json") for attempt in runner.state.stage_attempts]


def test_download_failure_is_retryable_network_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A DownloadError in acquisition must surface as NETWORK_ERROR + retryable.

    When all download candidates fail, the Agent should see ``retryable=True``
    so it can retry with an alternative accession or request HIL — not a
    terminal ``INTERNAL_ERROR`` (RESEARCH_SYSTEM_REVIEW §9.2).
    """

    def failing_acquisition(ctx, retrieved_at):
        raise DownloadError("all candidate URLs failed")

    monkeypatch.setattr("app.pipeline.runner.run_acquisition", failing_acquisition)
    runner = PipelineRunner(
        task_id="task_download_fail",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )

    manifest = asyncio.run(runner.run())

    assert manifest.task_state is TaskState.FAILED
    # Discovery succeeds, then acquisition fails — two stage attempts.
    failed = next(
        attempt
        for attempt in runner.state.stage_attempts
        if attempt.status is AttemptStatus.FAILED
    )
    assert failed.stage is StageName.ACQUISITION
    assert failed.error is not None
    assert failed.error.code is ErrorCode.NETWORK_ERROR
    assert failed.error.retryable is True
    assert "all candidate URLs failed" in failed.error.message


def test_stage_failure_is_durable_before_stage_failed_event_is_awaited(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def failing_discovery(ctx):
        raise RuntimeError("discovery failed before event sink")

    async def fail_on_stage_failed(event) -> None:
        if event.payload.type == "stage_failed":
            raise OSError("runtime rejected stage_failed")

    monkeypatch.setattr("app.pipeline.runner.run_discovery", failing_discovery)
    runner = PipelineRunner(
        task_id="task_failed_event_sink",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        event_sink=fail_on_stage_failed,
    )

    with pytest.raises(PipelineEventSinkError, match="runtime rejected stage_failed"):
        asyncio.run(runner.run())

    started = next(
        event for event in runner.events if event.payload.type == "stage_started"
    )
    state_path = runner.workdir.state / "pipeline_state.json"
    durable_state = json.loads(state_path.read_text("utf-8"))
    assert durable_state["inflight_attempt"] is None
    assert len(durable_state["stage_attempts"]) == 1
    failed = durable_state["stage_attempts"][0]
    assert failed["status"] == AttemptStatus.FAILED.value
    assert failed["stage_attempt_id"] == started.stage_attempt_id
    assert failed["attempt"] == started.payload.attempt


def test_runner_per_stage_timeout_marks_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def slow_discovery(ctx):
        time.sleep(0.3)

    monkeypatch.setattr("app.pipeline.runner.run_discovery", slow_discovery)

    runner = PipelineRunner(
        task_id="task_stage_timeout",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        stage_timeouts={**DEFAULT_STAGE_TIMEOUTS, StageName.DISCOVERY: 0.05},
    )
    manifest = asyncio.run(runner.run())

    assert manifest.task_state == TaskState.FAILED

    failed = [
        a for a in runner.state.stage_attempts
        if a.status == AttemptStatus.FAILED
    ]
    assert len(failed) == 1
    assert failed[0].stage == StageName.DISCOVERY
    assert failed[0].error is not None
    assert "timeout" in failed[0].error.message.lower()


def test_runner_total_timeout_marks_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def slow_discovery(ctx):
        time.sleep(0.3)

    monkeypatch.setattr("app.pipeline.runner.run_discovery", slow_discovery)

    runner = PipelineRunner(
        task_id="task_total_timeout",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        total_timeout=0.05,
    )
    manifest = asyncio.run(runner.run())

    assert manifest.task_state == TaskState.FAILED
    assert runner.state.inflight_attempt is None
    assert runner.state.stage_attempts
    assert all(
        attempt.status is not AttemptStatus.RUNNING
        for attempt in runner.state.stage_attempts
    )


def test_runner_no_silent_fallback_on_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def failing_validation(ctx, build_output, stage_attempts, stage_attempt_id):
        raise RuntimeError("validation failed")

    monkeypatch.setattr("app.pipeline.runner.run_validation", failing_validation)

    runner = PipelineRunner(
        task_id="task_no_fallback",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())

    assert manifest.task_state == TaskState.FAILED
    assert manifest.validation.status == "invalid"
    assert len(manifest.artifacts) == 0

    failed = [
        a for a in runner.state.stage_attempts
        if a.status == AttemptStatus.FAILED
    ]
    assert len(failed) == 1
    assert failed[0].stage == StageName.VALIDATION


def test_runner_cancellation_token_stops_before_atomic_publication(
    tmp_path: Path,
) -> None:
    task_id = "task_cancel_before_publish"
    task_root = tmp_path / "tasks" / task_id
    staged_manifest = (
        task_root / "staging" / "run_standalone" / "run_manifest.json"
    )

    class CancelAtPublication:
        def is_set(self) -> bool:
            return staged_manifest.is_file()

    runner = PipelineRunner(
        task_id=task_id,
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        cancellation_requested=CancelAtPublication(),
    )
    manifest = asyncio.run(runner.run())

    assert manifest.task_state == TaskState.CANCELLED
    assert not (task_root / "artifacts" / "run_manifest.json").exists()
    assert not any(event.type == "artifact_produced" for event in runner.events)


def test_managed_runner_defers_formal_publication_until_runtime_commit(
    tmp_path: Path,
) -> None:
    task_id = "task_deferred_publication"
    run_id = "run_deferred_publication"
    task_root = tmp_path / "tasks" / task_id
    runner = PipelineRunner(
        task_id=task_id,
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        defer_publication=True,
        run_id=run_id,
    )

    manifest = asyncio.run(runner.run())

    assert manifest.task_state == TaskState.COMPLETED
    assert not (task_root / "artifacts" / "run_manifest.json").exists()
    runner.publish(run_id)
    marker = json.loads(
        (task_root / "artifacts" / ".runtime-publication.json").read_text("utf-8")
    )
    assert marker == {
        "schema_version": 1,
        "task_id": task_id,
        "run_id": run_id,
        "manifest_sha256": hashlib.sha256(
            (task_root / "artifacts" / "run_manifest.json").read_bytes()
        ).hexdigest(),
    }


def test_deferred_runner_exposes_run_bound_abortable_publication(
    tmp_path: Path,
) -> None:
    task_id = "task_abortable_publication"
    run_id = "run_abortable_publication"
    task_root = tmp_path / "tasks" / task_id
    artifacts = task_root / "artifacts"
    state = task_root / "state"
    artifacts.mkdir(parents=True)
    state.mkdir(parents=True)
    old_artifact = artifacts / "old-result.csv"
    old_marker = state / "publish_completed.json"
    old_artifact.write_bytes(b"old artifact bytes\n")
    old_marker.write_bytes(b'{"old":true}\n')
    cancellation = threading.Event()
    runner = PipelineRunner(
        task_id=task_id,
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        defer_publication=True,
        run_id=run_id,
        cancellation_requested=cancellation,
    )

    manifest = asyncio.run(runner.run())
    pending = runner.pending_publication()

    assert pending.run_id == run_id
    assert pending.manifest == manifest
    assert pending.manifest_entry.name == "run_manifest.json"
    assert pending.manifest_entry.sha256 == hashlib.sha256(
        (task_root / "staging" / run_id / "run_manifest.json").read_bytes()
    ).hexdigest()

    cancellation.set()
    pending.abort()
    pending.abort()

    assert not (task_root / "staging" / run_id).exists()
    assert old_artifact.read_bytes() == b"old artifact bytes\n"
    assert old_marker.read_bytes() == b'{"old":true}\n'


def test_standalone_runner_uses_explicit_safe_staging_id(tmp_path: Path) -> None:
    """Standalone callers use a named safe ID, never a shared managed-Run ID."""
    task_id = "task_standalone_staging"
    task_root = tmp_path / "tasks" / task_id
    runner = PipelineRunner(
        task_id=task_id,
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        defer_publication=True,
    )

    manifest = asyncio.run(runner.run())

    assert manifest.task_state is TaskState.COMPLETED
    assert (task_root / "staging" / "run_standalone" / "run_manifest.json").is_file()
    assert not (task_root / "staging" / "run_pinned_fixture").exists()


def test_distinct_deferred_run_ids_use_isolated_staging(
    tmp_path: Path,
) -> None:
    """A recovered second Run must build in its own staging/<run_id>."""
    task_id = "task_distinct_run_staging"
    first_run_id = "run_distinct_staging_one"
    second_run_id = "run_distinct_staging_two"
    base_dir = tmp_path / "tasks"
    task_root = base_dir / task_id

    runner1 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
        defer_publication=True,
        run_id=first_run_id,
    )
    manifest1 = asyncio.run(runner1.run())
    assert manifest1.task_state is TaskState.COMPLETED
    first_staging = task_root / "staging" / first_run_id
    first_manifest_bytes = (first_staging / "run_manifest.json").read_bytes()

    runner2 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
        defer_publication=True,
        run_id=second_run_id,
    )
    manifest2 = asyncio.run(runner2.run())

    second_staging = task_root / "staging" / second_run_id
    assert manifest2.task_state is TaskState.COMPLETED
    assert first_staging != second_staging
    assert (first_staging / "run_manifest.json").read_bytes() == first_manifest_bytes
    assert (second_staging / "run_manifest.json").is_file()


def test_deferred_publish_rejects_a_different_run_identity(tmp_path: Path) -> None:
    """staging/run_A must never be committed with a run_B marker."""
    task_id = "task_publish_run_identity"
    run_id = "run_publish_identity_expected"
    task_root = tmp_path / "tasks" / task_id
    runner = PipelineRunner(
        task_id=task_id,
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        defer_publication=True,
        run_id=run_id,
    )
    manifest = asyncio.run(runner.run())
    assert manifest.task_state is TaskState.COMPLETED

    with pytest.raises(ValueError, match="must match the PipelineRunner run_id"):
        runner.publish("run_publish_identity_other")

    assert (task_root / "staging" / run_id / "run_manifest.json").is_file()
    assert not (task_root / "artifacts" / "run_manifest.json").exists()


def test_recovered_deferred_runner_revalidates_and_rebuilds_publication(
    tmp_path: Path,
) -> None:
    task_id = "task_recovered_deferred_publication"
    run_id = "run_recovered_deferred_publication"
    base_dir = tmp_path / "tasks"
    task_root = base_dir / task_id
    published_runner = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    published_manifest = asyncio.run(published_runner.run())
    assert published_manifest.task_state is TaskState.COMPLETED

    runner1 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
        defer_publication=True,
        run_id=run_id,
    )

    manifest1 = asyncio.run(runner1.run())

    assert manifest1.task_state is TaskState.COMPLETED
    checkpoint = json.loads(
        (task_root / "state" / "validation_output.json").read_text("utf-8")
    )
    expected_files = sorted(
        {
            *(f"staging/{run_id}/{entry.name}" for entry in manifest1.artifacts),
            f"staging/{run_id}/run_manifest.json",
            "logs/validation_report.json",
        }
    )
    assert [item["relative_path"] for item in checkpoint["files"]] == expected_files
    assert all(".runtime-publication.json" not in path for path in expected_files)
    assert all("publish_completed" not in path for path in expected_files)

    runner2 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
        defer_publication=True,
        run_id=run_id,
    )
    manifest2 = asyncio.run(runner2.run())

    assert manifest2.task_state is TaskState.COMPLETED
    validation_attempts = [
        attempt
        for attempt in runner2.state.stage_attempts
        if attempt.stage is StageName.VALIDATION
    ]
    assert [attempt.status for attempt in validation_attempts] == [
        AttemptStatus.SUCCEEDED,
        AttemptStatus.SUCCEEDED,
        AttemptStatus.SUCCEEDED,
    ]
    runner2.publish(run_id)
    marker = json.loads(
        (task_root / "artifacts" / ".runtime-publication.json").read_text("utf-8")
    )
    assert marker["run_id"] == run_id


@pytest.mark.asyncio
async def test_stage_timeout_drains_worker_before_terminal_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker_exited = threading.Event()

    def slow_discovery(ctx):
        try:
            time.sleep(0.2)
        finally:
            worker_exited.set()

    monkeypatch.setattr("app.pipeline.runner.run_discovery", slow_discovery)
    runner = PipelineRunner(
        task_id="task_timeout_drain",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        stage_timeouts={**DEFAULT_STAGE_TIMEOUTS, StageName.DISCOVERY: 0.01},
    )

    manifest = await runner.run()

    assert manifest.task_state == TaskState.FAILED
    assert worker_exited.is_set()
