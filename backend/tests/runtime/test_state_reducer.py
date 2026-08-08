from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from app.datasets.contracts import BuildResult, BuildResultStatus
from app.domain.contracts import (
    ArtifactManifestEntry,
    ArtifactProducedPayload,
    AssistantDeltaPayload,
    EventEnvelope,
    PublicationCreatedPayload,
    RunCancelledPayload,
    RunCancelRequestedPayload,
    RunCompletedPayload,
    RunFailedPayload,
    RunFinalizingPayload,
    RunInterruptedPayload,
    RunQueuedPayload,
    RunRecord,
    RunStartedPayload,
    RunStatus,
    TaskMode,
    TaskSnapshot,
    TaskSummary,
    build_event,
)
from app.domain.contracts.dataset_state import ArtifactRole
from app.domain.contracts.enums import ErrorCode, StageName
from app.runtime.state import reduce_task_event

NOW = datetime(2026, 7, 13, tzinfo=UTC)


def empty_snapshot() -> TaskSnapshot:
    return TaskSnapshot(
        task=TaskSummary(
            task_id="task_123",
            mode=TaskMode.AGENT,
            title="TP53 datasets",
            status=RunStatus.COMPLETED,
            created_at=NOW,
            updated_at=NOW,
        )
    )


def test_reducer_projects_legal_run_lifecycle_without_mutating_input() -> None:
    original = empty_snapshot()
    payloads = [
        RunQueuedPayload(request_id="req_123", input="compare TP53 datasets"),
        RunStartedPayload(),
        RunFinalizingPayload(),
        RunCompletedPayload(),
    ]

    snapshot = original
    for sequence, payload in enumerate(payloads, start=1):
        snapshot = reduce_task_event(
            snapshot,
            build_event(
                task_id="task_123",
                run_id="run_123",
                sequence=sequence,
                timestamp=NOW + timedelta(seconds=sequence),
                payload=payload,
            ),
        )

    assert original.runs == []
    assert original.task.latest_sequence == 0
    assert snapshot.runs[0].status is RunStatus.COMPLETED
    assert snapshot.runs[0].started_at == NOW + timedelta(seconds=2)
    assert snapshot.runs[0].finished_at == NOW + timedelta(seconds=4)
    assert snapshot.task.status is RunStatus.COMPLETED
    assert snapshot.task.active_run_id is None
    assert snapshot.task.latest_sequence == 4


def test_reducer_counts_artifact_produced_events() -> None:
    snapshot = queued_snapshot()
    snapshot = reduce_task_event(
        snapshot,
        runtime_event(
            2,
            RunStartedPayload(),
        ),
    )
    snapshot = reduce_task_event(
        snapshot,
        runtime_event(
            3,
            ArtifactProducedPayload(
                artifact=ArtifactManifestEntry(
                    artifact_id="artifact_123",
                    role=ArtifactRole.AUDIT_REPORT,
                    name="result.csv",
                    relative_path="artifacts/result.csv",
                    media_type="text/csv",
                    size_bytes=42,
                    sha256="0" * 64,
                    generated_by_step_id="stage_123",
                )
            ),
        ),
    )
    snapshot = reduce_task_event(
        snapshot,
        runtime_event(
            4,
            RunFinalizingPayload(),
        ),
    )
    snapshot = reduce_task_event(
        snapshot,
        runtime_event(
            5,
            RunCompletedPayload(),
        ),
    )

    assert snapshot.task.artifact_count == 1


def runtime_event(
    sequence: int,
    payload: object,
    *,
    task_id: str = "task_123",
    run_id: str = "run_123",
):
    return build_event(
        task_id=task_id,
        run_id=run_id,
        sequence=sequence,
        timestamp=NOW + timedelta(seconds=sequence),
        payload=payload,
    )


def queued_snapshot() -> TaskSnapshot:
    return reduce_task_event(
        empty_snapshot(),
        runtime_event(
            1,
            RunQueuedPayload(request_id="req_123", input="question"),
        ),
    )


def test_reducer_rejects_illegal_run_transition() -> None:
    with pytest.raises(ValueError, match="transition"):
        reduce_task_event(
            queued_snapshot(),
            runtime_event(2, RunCompletedPayload()),
        )


def test_reducer_rejects_duplicate_or_stale_task_sequence() -> None:
    snapshot = queued_snapshot()

    with pytest.raises(ValueError, match="sequence"):
        reduce_task_event(snapshot, runtime_event(1, RunStartedPayload()))


def test_reducer_rejects_event_for_another_task() -> None:
    with pytest.raises(ValueError, match="task_id"):
        reduce_task_event(
            empty_snapshot(),
            runtime_event(
                1,
                RunQueuedPayload(request_id="req_123", input="question"),
                task_id="task_other",
            ),
        )


def test_reducer_rejects_duplicate_and_unknown_runs() -> None:
    snapshot = queued_snapshot()

    with pytest.raises(ValueError, match="already exists"):
        reduce_task_event(
            snapshot,
            runtime_event(
                2,
                RunQueuedPayload(request_id="req_other", input="duplicate"),
            ),
        )

    with pytest.raises(ValueError, match="unknown run_id"):
        reduce_task_event(
            snapshot,
            runtime_event(
                2,
                AssistantDeltaPayload(delta="orphan"),
                run_id="run_other",
            ),
        )


def test_reducer_rejects_second_run_while_first_is_active() -> None:
    with pytest.raises(ValueError, match="active run"):
        reduce_task_event(
            queued_snapshot(),
            runtime_event(
                2,
                RunQueuedPayload(request_id="req_456", input="second turn"),
                run_id="run_456",
            ),
        )


def test_reducer_accepts_new_run_after_prior_run_is_terminal() -> None:
    snapshot = queued_snapshot()
    for sequence, payload in enumerate(
        [RunStartedPayload(), RunFinalizingPayload(), RunCompletedPayload()],
        start=2,
    ):
        snapshot = reduce_task_event(snapshot, runtime_event(sequence, payload))

    snapshot = reduce_task_event(
        snapshot,
        runtime_event(
            5,
            RunQueuedPayload(request_id="req_456", input="second turn"),
            run_id="run_456",
        ),
    )

    assert len(snapshot.runs) == 2
    assert snapshot.task.active_run_id == "run_456"
    assert snapshot.task.status is RunStatus.QUEUED


def test_terminal_run_is_immutable() -> None:
    snapshot = queued_snapshot()
    for sequence, payload in enumerate(
        [RunStartedPayload(), RunFinalizingPayload(), RunCompletedPayload()],
        start=2,
    ):
        snapshot = reduce_task_event(snapshot, runtime_event(sequence, payload))

    with pytest.raises(ValueError, match="terminal"):
        reduce_task_event(
            snapshot,
            runtime_event(5, AssistantDeltaPayload(delta="too late")),
        )


def test_queued_run_can_be_cancelled_without_starting() -> None:
    snapshot = reduce_task_event(
        queued_snapshot(),
        runtime_event(2, RunCancelRequestedPayload(reason="user requested")),
    )
    snapshot = reduce_task_event(
        snapshot,
        runtime_event(3, RunCancelledPayload(reason="user requested")),
    )

    assert snapshot.runs[0].status is RunStatus.CANCELLED
    assert snapshot.runs[0].started_at is None
    assert snapshot.runs[0].finished_at == NOW + timedelta(seconds=3)


def _envelope(
    sequence: int,
    payload: object,
    *,
    task_id: str = "task_1",
    run_id: str = "run_1",
) -> EventEnvelope:
    return build_event(
        task_id=task_id,
        run_id=run_id,
        sequence=sequence,
        timestamp=NOW + timedelta(seconds=sequence),
        payload=payload,
    )


def _snapshot_fixture() -> TaskSnapshot:
    """Two COMPLETED runs; publication events may reference either."""
    return TaskSnapshot(
        task=TaskSummary(
            task_id="task_1",
            mode=TaskMode.AGENT,
            title="TP53 datasets",
            status=RunStatus.COMPLETED,
            created_at=NOW,
            updated_at=NOW,
        ),
        runs=[
            RunRecord(
                run_id="run_1",
                task_id="task_1",
                request_id="req_1",
                status=RunStatus.COMPLETED,
                input="first question",
                created_at=NOW,
                updated_at=NOW,
            ),
            RunRecord(
                run_id="run_2",
                task_id="task_1",
                request_id="req_2",
                status=RunStatus.COMPLETED,
                input="second question",
                created_at=NOW,
                updated_at=NOW,
            ),
        ],
    )


def _queued_run_fixture() -> TaskSnapshot:
    """One QUEUED run that can legally reach any terminal status."""
    return TaskSnapshot(
        task=TaskSummary(
            task_id="task_1",
            mode=TaskMode.AGENT,
            title="TP53 datasets",
            status=RunStatus.QUEUED,
            active_run_id="run_1",
            created_at=NOW,
            updated_at=NOW,
        ),
        runs=[
            RunRecord(
                run_id="run_1",
                task_id="task_1",
                request_id="req_1",
                status=RunStatus.QUEUED,
                input="first question",
                created_at=NOW,
                updated_at=NOW,
            )
        ],
    )


def test_publication_events_build_chain() -> None:
    snapshot = _snapshot_fixture()
    first = reduce_task_event(
        snapshot,
        _envelope(
            2,
            PublicationCreatedPayload(
                publication_id="pub-run_1",
                run_id="run_1",
                manifest_sha256="a" * 64,
                published_at=NOW + timedelta(seconds=2),
            ),
        ),
    )
    assert first.current_publication_id == "pub-run_1"
    assert first.publications[0].supersedes_publication_id is None
    second = reduce_task_event(
        first,
        _envelope(
            3,
            PublicationCreatedPayload(
                publication_id="pub-run_2",
                run_id="run_2",
                manifest_sha256="b" * 64,
                published_at=NOW + timedelta(seconds=3),
            ),
            run_id="run_2",
        ),
    )
    assert second.current_publication_id == "pub-run_2"
    assert second.publications[1].supersedes_publication_id == "pub-run_1"
    # Publication events never touch run or task status.
    assert second.task.status is RunStatus.COMPLETED
    assert [run.status for run in second.runs] == [
        RunStatus.COMPLETED,
        RunStatus.COMPLETED,
    ]


def test_publication_events_honor_explicit_supersedes() -> None:
    reduced = reduce_task_event(
        _snapshot_fixture(),
        _envelope(
            2,
            PublicationCreatedPayload(
                publication_id="pub-latest",
                run_id="run_1",
                manifest_sha256="c" * 64,
                supersedes_publication_id="pub-earlier",
                published_at=NOW + timedelta(seconds=2),
            ),
        ),
    )
    assert reduced.current_publication_id == "pub-latest"
    assert reduced.publications[0].supersedes_publication_id == "pub-earlier"


def test_duplicate_publication_event_is_a_no_op() -> None:
    # A re-delivered publication_created event for the same publication_id must
    # not append a second entry; bookkeeping (latest_sequence) still advances.
    # Identical duplicates (same sha256, same published_at, same supersedes)
    # are a no-op; conflicting duplicates raise ValueError.
    published_at = NOW + timedelta(seconds=2)
    snapshot = _snapshot_fixture()
    first = reduce_task_event(
        snapshot,
        _envelope(
            2,
            PublicationCreatedPayload(
                publication_id="pub-run_1",
                run_id="run_1",
                manifest_sha256="a" * 64,
                published_at=published_at,
            ),
        ),
    )
    second = reduce_task_event(
        first,
        _envelope(
            3,
            PublicationCreatedPayload(
                publication_id="pub-run_1",
                run_id="run_1",
                manifest_sha256="a" * 64,
                published_at=published_at,
            ),
        ),
    )
    assert len(second.publications) == 1
    assert second.publications[0].publication_id == "pub-run_1"
    assert second.publications[0].published_at == published_at
    assert second.current_publication_id == "pub-run_1"
    assert second.task.latest_sequence == 3


def test_duplicate_publication_event_with_different_fields_raises() -> None:
    # A re-delivered publication_created event with different immutable fields
    # (manifest_sha256, published_at, or supersedes) must raise ValueError.
    snapshot = _snapshot_fixture()
    first = reduce_task_event(
        snapshot,
        _envelope(
            2,
            PublicationCreatedPayload(
                publication_id="pub-run_1",
                run_id="run_1",
                manifest_sha256="a" * 64,
                published_at=NOW + timedelta(seconds=2),
            ),
        ),
    )
    with pytest.raises(ValueError, match="conflicting duplicate publication"):
        reduce_task_event(
            first,
            _envelope(
                3,
                PublicationCreatedPayload(
                    publication_id="pub-run_1",
                    run_id="run_1",
                    manifest_sha256="b" * 64,
                    published_at=NOW + timedelta(seconds=3),
                ),
            ),
        )


def test_publication_event_rejects_payload_envelope_run_id_mismatch() -> None:
    with pytest.raises(ValueError, match="run_id must match"):
        reduce_task_event(
            _snapshot_fixture(),
            _envelope(
                2,
                PublicationCreatedPayload(
                    publication_id="pub-run_1",
                    run_id="run_2",
                    manifest_sha256="a" * 64,
                    published_at=NOW + timedelta(seconds=2),
                ),
            ),
        )


def test_terminal_events_populate_run_summary() -> None:
    snapshot = _queued_run_fixture()
    for sequence, payload in enumerate(
        [RunStartedPayload(), RunFinalizingPayload()], start=2
    ):
        snapshot = reduce_task_event(snapshot, _envelope(sequence, payload))
    snapshot = reduce_task_event(
        snapshot,
        _envelope(
            4,
            RunCompletedPayload(
                build_result=BuildResult(
                    status=BuildResultStatus.NO_DATA,
                    valid_row_count=0,
                    reason_codes=["no_primary_data"],
                    user_summary="No primary dataset found",
                )
            ),
        ),
    )
    run = next(r for r in snapshot.runs if r.run_id == "run_1")
    assert run.summary is not None
    assert run.summary.run_status is RunStatus.COMPLETED
    assert run.summary.build_result is not None
    assert run.summary.build_result.status is BuildResultStatus.NO_DATA
    assert run.summary.user_message == "No primary dataset found"


def test_terminal_events_populate_run_summary_failed() -> None:
    snapshot = _queued_run_fixture()
    snapshot = reduce_task_event(snapshot, _envelope(2, RunStartedPayload()))
    snapshot = reduce_task_event(
        snapshot,
        _envelope(
            3,
            RunFailedPayload(
                error="network unreachable",
                error_code=ErrorCode.NETWORK_ERROR,
            ),
        ),
    )
    run = next(r for r in snapshot.runs if r.run_id == "run_1")
    assert run.summary is not None
    assert run.summary.run_status is RunStatus.FAILED
    assert run.summary.error_code is ErrorCode.NETWORK_ERROR
    assert run.summary.user_message == "network unreachable"
    assert run.summary.build_result is None


def test_terminal_events_populate_run_summary_cancelled() -> None:
    snapshot = _queued_run_fixture()
    snapshot = reduce_task_event(
        snapshot,
        _envelope(2, RunCancelRequestedPayload(reason="user requested")),
    )
    snapshot = reduce_task_event(
        snapshot,
        _envelope(
            3,
            RunCancelledPayload(
                reason="user requested",
                cancelled_at_stage=StageName.ACQUISITION,
            ),
        ),
    )
    run = next(r for r in snapshot.runs if r.run_id == "run_1")
    assert run.summary is not None
    assert run.summary.run_status is RunStatus.CANCELLED
    assert run.summary.cancelled_at_stage is StageName.ACQUISITION
    assert run.summary.user_message == "user requested"


def test_terminal_events_populate_run_summary_interrupted() -> None:
    snapshot = _queued_run_fixture()
    snapshot = reduce_task_event(snapshot, _envelope(2, RunStartedPayload()))
    snapshot = reduce_task_event(
        snapshot,
        _envelope(3, RunInterruptedPayload(reason="agent stopped")),
    )
    run = next(r for r in snapshot.runs if r.run_id == "run_1")
    assert run.summary is not None
    assert run.summary.run_status is RunStatus.INTERRUPTED
    assert run.summary.user_message == "agent stopped"


def test_reducer_dedups_identical_artifact_produced_events() -> None:
    """A8: the same (run_id, artifact_id) payload at two sequences counts once."""
    snapshot = queued_snapshot()
    snapshot = reduce_task_event(
        snapshot,
        runtime_event(
            2,
            RunStartedPayload(),
        ),
    )
    artifact = ArtifactManifestEntry(
        artifact_id="artifact_dup",
        role=ArtifactRole.AUDIT_REPORT,
        name="result.csv",
        relative_path="artifacts/result.csv",
        media_type="text/csv",
        size_bytes=42,
        sha256="0" * 64,
        generated_by_step_id="stage_123",
    )
    snapshot = reduce_task_event(
        snapshot,
        runtime_event(3, ArtifactProducedPayload(artifact=artifact)),
    )
    snapshot = reduce_task_event(
        snapshot,
        runtime_event(4, ArtifactProducedPayload(artifact=artifact)),
    )

    assert snapshot.task.artifact_count == 1


def test_reducer_counts_distinct_artifact_ids() -> None:
    """A8: a different artifact_id in the same run still increments."""
    snapshot = queued_snapshot()
    snapshot = reduce_task_event(
        snapshot,
        runtime_event(2, RunStartedPayload()),
    )

    def entry(artifact_id: str) -> ArtifactManifestEntry:
        return ArtifactManifestEntry(
            artifact_id=artifact_id,
            role=ArtifactRole.AUDIT_REPORT,
            name=f"{artifact_id}.csv",
            relative_path=f"artifacts/{artifact_id}.csv",
            media_type="text/csv",
            size_bytes=42,
            sha256="0" * 64,
            generated_by_step_id="stage_123",
        )

    snapshot = reduce_task_event(
        snapshot,
        runtime_event(3, ArtifactProducedPayload(artifact=entry("a1"))),
    )
    snapshot = reduce_task_event(
        snapshot,
        runtime_event(4, ArtifactProducedPayload(artifact=entry("a2"))),
    )
    snapshot = reduce_task_event(
        snapshot,
        runtime_event(5, ArtifactProducedPayload(artifact=entry("a1"))),
    )

    assert snapshot.task.artifact_count == 2


def test_reducer_dedup_survives_run_boundary() -> None:
    """A8: the same artifact_id under a different run_id is a new artifact."""
    snapshot = queued_snapshot()
    snapshot = reduce_task_event(
        snapshot,
        runtime_event(2, RunStartedPayload()),
    )
    artifact = ArtifactManifestEntry(
        artifact_id="artifact_shared",
        role=ArtifactRole.AUDIT_REPORT,
        name="result.csv",
        relative_path="artifacts/result.csv",
        media_type="text/csv",
        size_bytes=42,
        sha256="0" * 64,
        generated_by_step_id="stage_123",
    )
    snapshot = reduce_task_event(
        snapshot,
        runtime_event(3, ArtifactProducedPayload(artifact=artifact)),
    )
    # First run finishes so a second run can be queued.
    snapshot = reduce_task_event(snapshot, runtime_event(4, RunFinalizingPayload()))
    snapshot = reduce_task_event(snapshot, runtime_event(5, RunCompletedPayload()))
    snapshot = reduce_task_event(
        snapshot,
        build_event(
            task_id="task_123",
            run_id="run_456",
            sequence=6,
            timestamp=NOW + timedelta(seconds=6),
            payload=RunQueuedPayload(request_id="req_456", input="question"),
        ),
    )
    snapshot = reduce_task_event(
        snapshot,
        build_event(
            task_id="task_123",
            run_id="run_456",
            sequence=7,
            timestamp=NOW + timedelta(seconds=7),
            payload=RunStartedPayload(),
        ),
    )
    snapshot = reduce_task_event(
        snapshot,
        build_event(
            task_id="task_123",
            run_id="run_456",
            sequence=8,
            timestamp=NOW + timedelta(seconds=8),
            payload=ArtifactProducedPayload(artifact=artifact),
        ),
    )

    assert snapshot.task.artifact_count == 2


def test_reducer_rejects_conflicting_duplicate_artifact_event() -> None:
    """H6/A8: a duplicate artifact_id whose digest/path conflicts with the
    first occurrence is a conflicting duplicate and must be rejected with a
    ValueError (mirroring the publication duplicate handling) — an identical
    replay stays a no-op.
    """
    snapshot = queued_snapshot()
    snapshot = reduce_task_event(
        snapshot,
        runtime_event(2, RunStartedPayload()),
    )
    first = ArtifactManifestEntry(
        artifact_id="artifact_x",
        role=ArtifactRole.AUDIT_REPORT,
        name="result.csv",
        relative_path="artifacts/result.csv",
        media_type="text/csv",
        size_bytes=42,
        sha256="0" * 64,
        generated_by_step_id="stage_123",
    )
    snapshot = reduce_task_event(
        snapshot,
        runtime_event(3, ArtifactProducedPayload(artifact=first)),
    )
    # Identical replay stays a no-op (existing dedup semantics).
    snapshot = reduce_task_event(
        snapshot,
        runtime_event(4, ArtifactProducedPayload(artifact=first)),
    )
    assert snapshot.task.artifact_count == 1

    # Same artifact_id with a different digest/path is a conflicting duplicate.
    conflicting = first.model_copy(update={"sha256": "f" * 64})
    with pytest.raises(ValueError, match="conflicting duplicate artifact"):
        reduce_task_event(
            snapshot,
            runtime_event(5, ArtifactProducedPayload(artifact=conflicting)),
        )
    conflicting_path = first.model_copy(update={"relative_path": "artifacts/other.csv"})
    with pytest.raises(ValueError, match="conflicting duplicate artifact"):
        reduce_task_event(
            snapshot,
            runtime_event(6, ArtifactProducedPayload(artifact=conflicting_path)),
        )
