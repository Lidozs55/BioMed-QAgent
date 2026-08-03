"""PipelineRunner idempotent recovery contract tests.

Covers P0 items: digest-matched output reuse, process-restart recovery
from last successful stage, independent skipped status identifier.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest
from app.domain.contracts import (
    AttemptStatus,
    Database,
    DatasetSelection,
    EventEnvelope,
    QuerySpecification,
    RunManifest,
    StageName,
    TaskSpecification,
    TaskState,
)
from app.pipeline.runner import PipelineRunner
from app.pipeline.stages import StageResult, ValidationOutput
from app.pipeline.state import StageOutputEnvelope

FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"


class HardPipelineInterruption(BaseException):
    """Simulate process death without runner-owned terminalization."""


def _gdc_specification(*, data_type: str) -> TaskSpecification:
    return TaskSpecification(
        topic="lung cancer",
        queries=[
            QuerySpecification(
                query_id="query_gdc_1",
                database=Database.GDC,
                query="TCGA-LUAD",
                generated_by="agent",
                purpose="explicit GDC project",
                order=1,
            )
        ],
        datasets=[
            DatasetSelection(
                dataset_id="ds_gdc_tcga_luad",
                database=Database.GDC,
                accession="TCGA-LUAD",
                reason="agent-selected project",
                data_type=data_type,
            )
        ],
    )


def test_parameter_digest_changes_with_selected_databases(tmp_path: Path) -> None:
    pubmed_geo = PipelineRunner(
        task_id="task_database_digest",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        databases=["pubmed", "geo"],
    )
    geo_only = PipelineRunner(
        task_id="task_database_digest",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        databases=["geo"],
    )

    assert pubmed_geo._compute_parameter_digest(
        StageName.DISCOVERY
    ) != geo_only._compute_parameter_digest(StageName.DISCOVERY)


def test_parameter_digest_changes_with_task_specification(tmp_path: Path) -> None:
    expression = PipelineRunner(
        task_id="task_specification_digest",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        databases=["gdc"],
        specification=_gdc_specification(data_type="gene-expression"),
    )
    clinical = PipelineRunner(
        task_id="task_specification_digest",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        databases=["gdc"],
        specification=_gdc_specification(data_type="clinical"),
    )

    assert expression._compute_parameter_digest(
        StageName.DISCOVERY
    ) != clinical._compute_parameter_digest(StageName.DISCOVERY)


def _canonical_json_sha256(payload: object) -> str:
    serialized = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(serialized).hexdigest()


def _make_artifact_checkpoint_match_validated_staging(task_root: Path) -> None:
    staging = task_root / "staging" / "run_standalone"
    checkpoint_path = task_root / "state" / "artifact_build_output.json"
    checkpoint = json.loads(checkpoint_path.read_text("utf-8"))
    for name in ("quality_report.csv", "run_manifest.json"):
        path = staging / name
        checkpoint["output"]["artifact_paths"].append(str(path))
        checkpoint["files"].append(
            {
                "schema_version": "1.0",
                "relative_path": path.relative_to(task_root).as_posix(),
                "size_bytes": path.stat().st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
        )
    checkpoint["files"].sort(key=lambda item: item["relative_path"])
    checkpoint["output_sha256"] = _canonical_json_sha256(checkpoint["output"])
    StageOutputEnvelope.model_validate(checkpoint)
    checkpoint_path.write_text(
        json.dumps(checkpoint, indent=2) + "\n",
        "utf-8",
    )


def test_runner_reruns_validation_when_envelope_artifacts_diverge_from_manifest(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    base_dir = tmp_path / "tasks"
    task_id = "task_validation_envelope_divergence"
    task_root = base_dir / task_id
    runner1 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
        defer_publication=True,
    )
    manifest1 = asyncio.run(runner1.run())
    assert manifest1.task_state is TaskState.COMPLETED

    staging = task_root / "staging" / "run_standalone"
    _make_artifact_checkpoint_match_validated_staging(task_root)

    validation_checkpoint_path = task_root / "state" / "validation_output.json"
    validation_checkpoint = json.loads(
        validation_checkpoint_path.read_text("utf-8")
    )
    original_output = ValidationOutput.model_validate(
        validation_checkpoint["output"]
    )
    physical_manifest_before = (staging / "run_manifest.json").read_bytes()
    removed = validation_checkpoint["output"]["artifacts"].pop()
    removed_path = f"staging/run_standalone/{removed['name']}"
    validation_checkpoint["files"] = [
        item
        for item in validation_checkpoint["files"]
        if item["relative_path"] != removed_path
    ]
    validation_checkpoint["output_sha256"] = _canonical_json_sha256(
        validation_checkpoint["output"]
    )
    StageOutputEnvelope.model_validate(validation_checkpoint)
    validation_checkpoint_path.write_text(
        json.dumps(validation_checkpoint, indent=2) + "\n",
        "utf-8",
    )
    assert (staging / "run_manifest.json").read_bytes() == physical_manifest_before

    validation_attempt = next(
        attempt
        for attempt in runner1.state.stage_attempts
        if attempt.stage is StageName.VALIDATION
        and attempt.status is AttemptStatus.SUCCEEDED
    )
    calls = 0

    def observed_validation(*args, **kwargs) -> StageResult:
        nonlocal calls
        calls += 1
        return StageResult(
            output_digest=validation_attempt.output_digest,
            output=original_output,
        )

    monkeypatch.setattr("app.pipeline.runner.run_validation", observed_validation)
    runner2 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    manifest2 = asyncio.run(runner2.run())

    assert manifest2.task_state is TaskState.COMPLETED
    assert calls == 1
    validation_attempts = [
        attempt
        for attempt in runner2.state.stage_attempts
        if attempt.stage is StageName.VALIDATION
    ]
    assert [attempt.status for attempt in validation_attempts] == [
        AttemptStatus.SUCCEEDED,
        AttemptStatus.SUCCEEDED,
    ]


def test_runner_reruns_validation_when_physical_run_manifest_diverges(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    base_dir = tmp_path / "tasks"
    task_id = "task_physical_manifest_divergence"
    task_root = base_dir / task_id
    staging = task_root / "staging" / "run_standalone"
    runner1 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
        defer_publication=True,
    )
    manifest1 = asyncio.run(runner1.run())
    assert manifest1.task_state is TaskState.COMPLETED
    _make_artifact_checkpoint_match_validated_staging(task_root)

    checkpoint_path = task_root / "state" / "validation_output.json"
    checkpoint = json.loads(checkpoint_path.read_text("utf-8"))
    original_output = ValidationOutput.model_validate(checkpoint["output"])
    run_manifest_path = staging / "run_manifest.json"
    physical_manifest = json.loads(run_manifest_path.read_text("utf-8"))
    physical_manifest["pipeline_version"] = "tampered-but-schema-valid"
    RunManifest.model_validate(physical_manifest)
    run_manifest_path.write_text(
        json.dumps(physical_manifest, indent=2) + "\n",
        "utf-8",
    )
    run_manifest_relative_path = run_manifest_path.relative_to(task_root).as_posix()
    run_manifest_file = next(
        item
        for item in checkpoint["files"]
        if item["relative_path"] == run_manifest_relative_path
    )
    run_manifest_file["size_bytes"] = run_manifest_path.stat().st_size
    run_manifest_file["sha256"] = hashlib.sha256(
        run_manifest_path.read_bytes()
    ).hexdigest()
    StageOutputEnvelope.model_validate(checkpoint)
    checkpoint_path.write_text(
        json.dumps(checkpoint, indent=2) + "\n",
        "utf-8",
    )
    artifact_checkpoint_path = task_root / "state" / "artifact_build_output.json"
    artifact_checkpoint = json.loads(
        artifact_checkpoint_path.read_text("utf-8")
    )
    artifact_run_manifest_file = next(
        item
        for item in artifact_checkpoint["files"]
        if item["relative_path"] == run_manifest_relative_path
    )
    artifact_run_manifest_file["size_bytes"] = run_manifest_path.stat().st_size
    artifact_run_manifest_file["sha256"] = hashlib.sha256(
        run_manifest_path.read_bytes()
    ).hexdigest()
    StageOutputEnvelope.model_validate(artifact_checkpoint)
    artifact_checkpoint_path.write_text(
        json.dumps(artifact_checkpoint, indent=2) + "\n",
        "utf-8",
    )

    validation_attempt = next(
        attempt
        for attempt in runner1.state.stage_attempts
        if attempt.stage is StageName.VALIDATION
        and attempt.status is AttemptStatus.SUCCEEDED
    )
    calls = 0

    def observed_validation(*args, **kwargs) -> StageResult:
        nonlocal calls
        calls += 1
        run_manifest_path.write_text(
            original_output.manifest.model_dump_json(indent=2) + "\n",
            "utf-8",
        )
        return StageResult(
            output_digest=validation_attempt.output_digest,
            output=original_output,
        )

    monkeypatch.setattr("app.pipeline.runner.run_validation", observed_validation)
    runner2 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    manifest2 = asyncio.run(runner2.run())

    assert manifest2.task_state is TaskState.COMPLETED
    assert calls == 1
    validation_attempts = [
        attempt
        for attempt in runner2.state.stage_attempts
        if attempt.stage is StageName.VALIDATION
    ]
    assert [attempt.status for attempt in validation_attempts] == [
        AttemptStatus.SUCCEEDED,
        AttemptStatus.SUCCEEDED,
    ]


@pytest.mark.parametrize(
    "checkpoint_corruption",
    [
        "invalid_json",
        "old_raw",
        "missing_schema_version",
        "wrong_schema_version",
        "wrong_output_digest",
        "wrong_output_sha256",
    ],
)
def test_runner_reruns_stage_when_persisted_output_checkpoint_is_invalid(
    tmp_path: Path,
    checkpoint_corruption: str,
) -> None:
    base_dir = tmp_path / "tasks"
    task_id = f"task_invalid_checkpoint_{checkpoint_corruption}"
    runner1 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    manifest1 = asyncio.run(runner1.run())
    assert manifest1.task_state is TaskState.COMPLETED

    checkpoint_path = (
        base_dir / task_id / "state" / "discovery_output.json"
    )
    if checkpoint_corruption == "invalid_json":
        checkpoint_path.write_text("{", "utf-8")
    else:
        checkpoint = json.loads(checkpoint_path.read_text("utf-8"))
        raw_output = checkpoint.get("output", checkpoint)
        if checkpoint_corruption == "old_raw":
            checkpoint_path.write_text(
                json.dumps(raw_output, indent=2) + "\n",
                "utf-8",
            )
        else:
            serialized = json.dumps(
                raw_output,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
            first_attempt = next(
                attempt
                for attempt in runner1.state.stage_attempts
                if attempt.stage is StageName.DISCOVERY
                and attempt.status is AttemptStatus.SUCCEEDED
            )
            checkpoint = {
                "schema_version": "1.0",
                "task_id": task_id,
                "stage": StageName.DISCOVERY.value,
                "stage_attempt_id": first_attempt.stage_attempt_id,
                "output_digest": first_attempt.output_digest,
                "output_sha256": hashlib.sha256(serialized).hexdigest(),
                "output": raw_output,
                "files": [],
            }
            if checkpoint_corruption == "missing_schema_version":
                checkpoint.pop("schema_version")
            elif checkpoint_corruption == "wrong_schema_version":
                checkpoint["schema_version"] = "9.9"
            else:
                field = (
                    "output_digest"
                    if checkpoint_corruption == "wrong_output_digest"
                    else "output_sha256"
                )
                checkpoint[field] = "0" * 64
            checkpoint_path.write_text(
                json.dumps(checkpoint, indent=2) + "\n",
                "utf-8",
            )

    runner2 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    manifest2 = asyncio.run(runner2.run())

    assert manifest2.task_state is TaskState.COMPLETED
    discovery_attempts = [
        attempt
        for attempt in runner2.state.stage_attempts
        if attempt.stage is StageName.DISCOVERY
    ]
    assert [attempt.attempt for attempt in discovery_attempts] == [1, 2]
    assert [attempt.status for attempt in discovery_attempts] == [
        AttemptStatus.SUCCEEDED,
        AttemptStatus.SUCCEEDED,
    ]


@pytest.mark.parametrize("file_corruption", ["deleted", "size", "sha256"])
def test_runner_reruns_processing_when_referenced_file_is_corrupt(
    tmp_path: Path,
    file_corruption: str,
) -> None:
    base_dir = tmp_path / "tasks"
    task_id = f"task_processing_file_{file_corruption}"
    runner1 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    manifest1 = asyncio.run(runner1.run())
    assert manifest1.task_state is TaskState.COMPLETED

    checkpoint_path = base_dir / task_id / "state" / "processing_output.json"
    checkpoint = json.loads(checkpoint_path.read_text("utf-8"))
    parsed_relative_path = checkpoint["output"]["parsed_datasets"][0][
        "file_asset"
    ]["relative_path"]
    parsed_path = base_dir / task_id / Path(parsed_relative_path)
    if file_corruption == "deleted":
        parsed_path.unlink()
    elif file_corruption == "size":
        parsed_path.write_bytes(parsed_path.read_bytes() + b"x")
    else:
        original = parsed_path.read_bytes()
        replacement = bytes([original[0] ^ 1]) + original[1:]
        assert len(replacement) == len(original)
        parsed_path.write_bytes(replacement)

    runner2 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    manifest2 = asyncio.run(runner2.run())

    assert manifest2.task_state is TaskState.COMPLETED
    processing_attempts = [
        attempt
        for attempt in runner2.state.stage_attempts
        if attempt.stage is StageName.PROCESSING
    ]
    assert [attempt.attempt for attempt in processing_attempts] == [1, 2]
    assert [attempt.status for attempt in processing_attempts] == [
        AttemptStatus.SUCCEEDED,
        AttemptStatus.SUCCEEDED,
    ]


def test_runner_recovers_durable_inflight_attempt_after_hard_interruption(
    tmp_path: Path,
) -> None:
    base_dir = tmp_path / "tasks"
    task_id = "task_hard_interruption"
    state_path = base_dir / task_id / "state" / "pipeline_state.json"
    attempts_path = base_dir / task_id / "logs" / "stage_attempts.jsonl"

    async def interrupt_after_durable_stage_start(event: EventEnvelope) -> None:
        payload = event.payload
        if payload.type != "stage_started":
            return
        durable_state = json.loads(state_path.read_text("utf-8"))
        inflight = durable_state.get("inflight_attempt")
        assert inflight is not None
        assert inflight["status"] == AttemptStatus.RUNNING.value
        assert inflight["stage"] == payload.stage.value
        assert inflight["attempt"] == payload.attempt
        assert inflight["stage_attempt_id"] == event.stage_attempt_id
        raise HardPipelineInterruption

    runner1 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
        event_sink=interrupt_after_durable_stage_start,
    )
    with pytest.raises(HardPipelineInterruption):
        asyncio.run(runner1.run())

    runner2 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner2.run())

    assert manifest.task_state == TaskState.COMPLETED
    assert runner2.events[0].payload.type == "task_recovered"
    discovery_attempts = [
        attempt
        for attempt in runner2.state.stage_attempts
        if attempt.stage is StageName.DISCOVERY
    ]
    assert [attempt.attempt for attempt in discovery_attempts] == [1, 2]
    assert [attempt.status for attempt in discovery_attempts] == [
        AttemptStatus.CANCELLED,
        AttemptStatus.SUCCEEDED,
    ]
    assert (
        discovery_attempts[0].stage_attempt_id
        != discovery_attempts[1].stage_attempt_id
    )
    assert runner2.state.inflight_attempt is None
    assert [
        json.loads(line) for line in attempts_path.read_text("utf-8").splitlines()
    ] == [attempt.model_dump(mode="json") for attempt in runner2.state.stage_attempts]


def test_runner_recovers_after_process_death_releases_task_lock(
    tmp_path: Path,
) -> None:
    base_dir = tmp_path / "tasks"
    task_id = "task_process_death_lock"
    child_code = textwrap.dedent(
        """
        import asyncio
        import os
        import sys
        from pathlib import Path

        from app.pipeline.runner import PipelineRunner

        async def exit_on_stage_started(event):
            if event.payload.type == "stage_started":
                os._exit(73)

        runner = PipelineRunner(
            task_id=sys.argv[1],
            base_dir=Path(sys.argv[2]),
            fixture_dir=Path(sys.argv[3]),
            event_sink=exit_on_stage_started,
        )
        asyncio.run(runner.run())
        """
    )
    crashed = subprocess.run(
        [
            sys.executable,
            "-c",
            child_code,
            task_id,
            str(base_dir),
            str(FIXTURE_DIR),
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert crashed.returncode == 73, crashed.stderr
    state_path = base_dir / task_id / "state" / "pipeline_state.json"
    crashed_state = json.loads(state_path.read_text("utf-8"))
    assert crashed_state["inflight_attempt"]["status"] == AttemptStatus.RUNNING.value
    lock_path = base_dir / task_id / "state" / "task_running.lock"
    assert lock_path.is_file()

    runner = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())

    assert manifest.task_state is TaskState.COMPLETED
    discovery_attempts = [
        attempt
        for attempt in runner.state.stage_attempts
        if attempt.stage is StageName.DISCOVERY
    ]
    assert [attempt.attempt for attempt in discovery_attempts] == [1, 2]
    assert [attempt.status for attempt in discovery_attempts] == [
        AttemptStatus.CANCELLED,
        AttemptStatus.SUCCEEDED,
    ]
    assert runner.state.inflight_attempt is None


def test_stage_attempt_numbers_remain_monotonic_across_reuse_and_parameter_change(
    tmp_path: Path,
) -> None:
    base_dir = tmp_path / "tasks"
    task_id = "task_monotonic_attempts"

    runner1 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner1.run())

    runner2 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner2.run())

    runner3 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
        topic="changed topic forces new parameters",
    )
    asyncio.run(runner3.run())

    for stage in StageName:
        attempts = [
            attempt
            for attempt in runner3.state.stage_attempts
            if attempt.stage is stage
        ]
        assert [attempt.attempt for attempt in attempts] == [1, 2, 3]
        expected_second = (
            AttemptStatus.SKIPPED
            if stage
            in {
                StageName.DISCOVERY,
                StageName.ACQUISITION,
                StageName.PROCESSING,
            }
            else AttemptStatus.SUCCEEDED
        )
        assert [attempt.status for attempt in attempts] == [
            AttemptStatus.SUCCEEDED,
            expected_second,
            AttemptStatus.SUCCEEDED,
        ]

    started_attempts = {
        event.payload.stage: event.payload.attempt
        for event in runner3.events
        if event.payload.type == "stage_started"
    }
    assert started_attempts == dict.fromkeys(StageName, 3)


def test_runner_reuses_only_durable_outputs_after_publication(tmp_path: Path) -> None:
    base_dir = tmp_path / "tasks"

    runner1 = PipelineRunner(
        task_id="task_reuse",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    manifest1 = asyncio.run(runner1.run())
    assert manifest1.task_state == TaskState.COMPLETED

    runner2 = PipelineRunner(
        task_id="task_reuse",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    manifest2 = asyncio.run(runner2.run())
    assert manifest2.task_state == TaskState.COMPLETED

    skipped = [
        a for a in runner2.state.stage_attempts
        if a.status == AttemptStatus.SKIPPED
    ]
    assert [attempt.stage for attempt in skipped] == [
        StageName.DISCOVERY,
        StageName.ACQUISITION,
        StageName.PROCESSING,
    ]

    completed = [
        event.payload.stage
        for event in runner2.events
        if event.payload.type == "stage_completed"
    ]
    assert completed == [StageName.ARTIFACT_BUILD, StageName.VALIDATION]


def test_runner_recovers_from_last_successful_stage(tmp_path: Path) -> None:
    base_dir = tmp_path / "tasks"

    runner1 = PipelineRunner(
        task_id="task_recover",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner1.run())

    runner2 = PipelineRunner(
        task_id="task_recover",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    manifest2 = asyncio.run(runner2.run())

    assert manifest2.task_state == TaskState.COMPLETED

    event_types = [e.payload.type for e in runner2.events]
    assert "task_recovered" in event_types


def test_runner_appends_recovery_events_without_overwriting_audit_history(
    tmp_path: Path,
) -> None:
    base_dir = tmp_path / "tasks"
    task_id = "task_append_only_events"

    runner1 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner1.run())

    runner2 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner2.run())

    # Cross-run event durability is handled by the runtime EventStore; the
    # runner's in-memory events list only reflects the current run. The second
    # run emits task_recovered as its first event with recovered_from_sequence=0
    # (sequence now always starts from 1 since _load_last_sequence was removed).
    assert runner2.events[0].payload.type == "task_recovered"
    assert runner2.events[0].payload.recovered_from_sequence == 0


def test_runner_repairs_stage_attempt_log_from_durable_state_before_appending(
    tmp_path: Path,
) -> None:
    base_dir = tmp_path / "tasks"
    task_id = "task_attempt_log_repair"
    attempts_path = base_dir / task_id / "logs" / "stage_attempts.jsonl"
    runner1 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner1.run())
    persisted = attempts_path.read_text("utf-8").splitlines()
    attempts_path.write_text("\n".join(persisted[:-1]) + "\n", "utf-8")

    runner2 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner2.run())

    repaired = [json.loads(line) for line in attempts_path.read_text("utf-8").splitlines()]
    assert repaired == [
        attempt.model_dump(mode="json") for attempt in runner2.state.stage_attempts
    ]


def test_runner_skipped_status_independent(tmp_path: Path) -> None:
    base_dir = tmp_path / "tasks"

    runner1 = PipelineRunner(
        task_id="task_skip",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner1.run())

    runner2 = PipelineRunner(
        task_id="task_skip",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner2.run())

    skipped = [
        a for a in runner2.state.stage_attempts
        if a.status == AttemptStatus.SKIPPED
    ]
    succeeded_first = [
        a for a in runner1.state.stage_attempts
        if a.status == AttemptStatus.SUCCEEDED
    ]

    assert [attempt.stage for attempt in skipped] == [
        StageName.DISCOVERY,
        StageName.ACQUISITION,
        StageName.PROCESSING,
    ]
    assert len(succeeded_first) == 5

    reusable_successes = [
        attempt
        for attempt in succeeded_first
        if attempt.stage
        in {
            StageName.DISCOVERY,
            StageName.ACQUISITION,
            StageName.PROCESSING,
        }
    ]
    for skip, succ in zip(skipped, reusable_successes, strict=True):
        assert skip.input_digest == succ.input_digest
        assert skip.parameter_digest == succ.parameter_digest
        assert skip.stage_attempt_id != succ.stage_attempt_id

    skipped_event = runner2.events
    skipped_payloads = [
        e for e in skipped_event if e.payload.type == "stage_skipped"
    ]
    assert len(skipped_payloads) == 3
