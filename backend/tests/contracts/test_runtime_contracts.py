from __future__ import annotations

from datetime import UTC, datetime

import pytest
from app.domain.contracts import (
    AssistantDeltaPayload,
    AssistantReasoningDeltaPayload,
    ConversationCompactedPayload,
    EventEnvelope,
    MessagePage,
    MessageRecord,
    MessageRole,
    PipelineEventType,
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
    RuntimeEventType,
    StartRunRequest,
    StartTaskRequest,
    TaskCreatedPayload,
    TaskMode,
    TaskPage,
    TaskRunAccepted,
    TaskSnapshot,
    TaskSummary,
    ToolCompletedPayload,
    ToolStartedPayload,
    WarningPayload,
    generate_message_id,
    generate_run_id,
    generate_task_id,
)
from pydantic import ValidationError

NOW = datetime(2026, 7, 13, tzinfo=UTC)

RUNTIME_PAYLOADS = [
    RunQueuedPayload(request_id="req_123", input="question"),
    RunStartedPayload(),
    RunFinalizingPayload(),
    RunCompletedPayload(),
    RunFailedPayload(error="model unavailable"),
    RunCancelRequestedPayload(reason="user requested"),
    RunCancelledPayload(reason="user requested"),
    RunInterruptedPayload(reason="process restarted"),
    AssistantDeltaPayload(delta="partial answer"),
    AssistantReasoningDeltaPayload(delta="internal reasoning"),
    ToolStartedPayload(tool_call_id="call_123", tool_name="search_literature"),
    ToolCompletedPayload(
        tool_call_id="call_123",
        tool_name="search_literature",
        output="3 results",
    ),
    ConversationCompactedPayload(
        covered_through_run_id="run_122",
        summary_digest="ab" * 32,
    ),
    WarningPayload(message="compaction failed", code="compaction_failed"),
]


def test_event_envelope_accepts_v2_run_linkage() -> None:
    event = EventEnvelope.model_validate(
        {
            "schema_version": "2.0",
            "event_id": "event_123",
            "type": "task_created",
            "task_id": "task_123",
            "run_id": "run_123",
            "sequence": 1,
            "timestamp": NOW,
            "payload": {"type": "task_created", "topic": "breast cancer"},
        }
    )

    assert event.schema_version == "2.0"
    assert event.run_id == "run_123"


def test_event_envelope_keeps_legacy_fixture_json_valid() -> None:
    event = EventEnvelope.model_validate(
        {
            "event_id": "event_legacy",
            "type": "task_created",
            "task_id": "task_legacy",
            "sequence": 1,
            "timestamp": NOW,
            "payload": {"type": "task_created", "topic": "legacy fixture"},
        }
    )

    assert event.schema_version == "1.0"
    assert event.run_id is None


def test_fixture_stage_events_still_require_stage_attempt_id() -> None:
    with pytest.raises(ValidationError, match="stage_attempt_id"):
        EventEnvelope.model_validate(
            {
                "event_id": "event_stage",
                "type": PipelineEventType.STAGE_STARTED,
                "task_id": "task_fixture",
                "sequence": 2,
                "timestamp": NOW,
                "payload": {
                    "type": PipelineEventType.STAGE_STARTED,
                    "stage": "discovery",
                    "attempt": 1,
                },
            }
        )


def test_runtime_enums_are_stable_wire_values() -> None:
    assert {status.value for status in RunStatus} == {
        "queued",
        "running",
        "finalizing",
        "cancel_requested",
        "awaiting_user_input",
        "completed",
        "failed",
        "cancelled",
        "interrupted",
    }
    assert {mode.value for mode in TaskMode} == {"agent", "fixture", "import"}
    assert {role.value for role in MessageRole} == {
        "system",
        "user",
        "assistant",
        "tool",
    }


def test_start_requests_trim_input_and_acceptance_is_queued() -> None:
    start_task = StartTaskRequest(
        request_id="req_123",
        input="  compare TP53 datasets  ",
    )
    start_run = StartRunRequest(
        request_id="req_456",
        input="  narrow to breast cancer  ",
    )
    accepted = TaskRunAccepted(
        request_id=start_task.request_id,
        task_id="task_123",
        run_id="run_123",
    )

    assert start_task.mode is TaskMode.AGENT
    assert start_task.databases == []
    assert start_task.input == "compare TP53 datasets"
    assert start_run.input == "narrow to breast cancer"
    assert accepted.status is RunStatus.QUEUED

    with pytest.raises(ValidationError, match="input"):
        StartRunRequest(request_id="req_blank", input="   ")


def test_fixture_start_request_requires_exact_pubmed_geo_selection() -> None:
    request = StartTaskRequest(
        request_id="req_fixture",
        input="fixture topic",
        databases=["geo", "pubmed"],
        mode=TaskMode.FIXTURE,
    )

    assert request.databases == ["geo", "pubmed"]


@pytest.mark.parametrize(
    "databases",
    [
        [],
        ["pubmed"],
        ["geo"],
        ["pubmed", "pubmed", "geo"],
        ["pubmed", "geo", "pdb"],
        ["PubMed", "geo"],
    ],
)
def test_fixture_start_request_rejects_inexact_database_selection(
    databases: list[str],
) -> None:
    with pytest.raises(ValidationError, match="exactly pubmed and geo"):
        StartTaskRequest(
            request_id="req_fixture_invalid",
            input="fixture topic",
            databases=databases,
            mode=TaskMode.FIXTURE,
        )


def test_task_summary_defaults_databases_for_legacy_snapshots() -> None:
    summary = TaskSummary.model_validate(
        {
            "task_id": "task_legacy",
            "mode": "agent",
            "title": "Legacy task",
            "status": "completed",
            "created_at": NOW,
            "updated_at": NOW,
        }
    )

    assert summary.databases == []


def test_runtime_snapshot_and_pages_are_typed() -> None:
    run = RunRecord(
        run_id="run_123",
        task_id="task_123",
        request_id="req_123",
        status=RunStatus.RUNNING,
        input="compare TP53 datasets",
        created_at=NOW,
        updated_at=NOW,
        started_at=NOW,
    )
    summary = TaskSummary(
        task_id="task_123",
        mode=TaskMode.AGENT,
        title="TP53 datasets",
        status=RunStatus.RUNNING,
        active_run_id=run.run_id,
        created_at=NOW,
        updated_at=NOW,
        latest_sequence=2,
    )
    message = MessageRecord(
        message_id="message_123",
        task_id=summary.task_id,
        run_id=run.run_id,
        ordinal=1,
        role=MessageRole.USER,
        content=run.input,
        created_at=NOW,
    )
    snapshot = TaskSnapshot(task=summary, runs=[run], messages=[message])

    page = TaskPage(active_items=[summary], items=[])

    assert page.tasks == [summary]
    assert page.model_dump(mode="json") == {
        "schema_version": "1.0",
        "active_items": [summary.model_dump(mode="json")],
        "items": [],
        "next_cursor": None,
    }
    assert MessagePage(messages=[message]).messages == [message]
    assert snapshot.older_messages_cursor is None


def test_all_runtime_payloads_are_discriminated_and_require_run_id() -> None:
    assert {payload.type for payload in RUNTIME_PAYLOADS} == set(RuntimeEventType) | {
        PipelineEventType.TOOL_COMPLETED,
        PipelineEventType.WARNING,
    }

    for sequence, payload in enumerate(RUNTIME_PAYLOADS, start=1):
        envelope = EventEnvelope(
            schema_version="2.0",
            event_id=f"event_{sequence}",
            type=payload.type,
            task_id="task_123",
            run_id="run_123",
            sequence=sequence,
            timestamp=NOW,
            payload=payload,
        )
        parsed = EventEnvelope.model_validate_json(envelope.model_dump_json())
        assert type(parsed.payload) is type(payload)


@pytest.mark.parametrize(
    "payload",
    RUNTIME_PAYLOADS,
    ids=lambda payload: payload.type.value,
)
def test_every_runtime_scoped_payload_requires_run_id(payload: object) -> None:
    with pytest.raises(ValidationError, match="run_id"):
        EventEnvelope(
            schema_version="2.0",
            event_id="event_missing_run",
            type=payload.type,
            task_id="task_123",
            sequence=20,
            timestamp=NOW,
            payload=payload,
        )


@pytest.mark.parametrize(
    "payload",
    RUNTIME_PAYLOADS,
    ids=lambda payload: payload.type.value,
)
@pytest.mark.parametrize("schema_version", [None, "1.0"], ids=["omitted", "v1"])
def test_every_runtime_scoped_payload_requires_schema_v2(
    payload: object,
    schema_version: str | None,
) -> None:
    envelope = {
        "event_id": "event_wrong_schema",
        "type": payload.type,
        "task_id": "task_123",
        "run_id": "run_123",
        "sequence": 20,
        "timestamp": NOW,
        "payload": payload,
    }
    if schema_version is not None:
        envelope["schema_version"] = schema_version

    with pytest.raises(ValidationError, match="schema_version 2.0"):
        EventEnvelope.model_validate(envelope)


@pytest.mark.parametrize("schema_version", [None, "1.0"], ids=["omitted", "v1"])
def test_any_run_linkage_requires_schema_v2(schema_version: str | None) -> None:
    envelope = {
        "event_id": "event_wrong_schema",
        "type": PipelineEventType.TASK_CREATED,
        "task_id": "task_123",
        "run_id": "run_123",
        "sequence": 1,
        "timestamp": NOW,
        "payload": TaskCreatedPayload(topic="breast cancer"),
    }
    if schema_version is not None:
        envelope["schema_version"] = schema_version

    with pytest.raises(ValidationError, match="schema_version 2.0"):
        EventEnvelope.model_validate(envelope)


def test_runtime_id_helpers_use_canonical_prefixes() -> None:
    assert generate_task_id().startswith("task_")
    assert generate_run_id().startswith("run_")
    assert generate_message_id().startswith("message_")
