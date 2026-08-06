from __future__ import annotations

from datetime import UTC, datetime

import pytest
from app.datasets.contracts import BuildResult, BuildResultStatus
from app.domain.contracts import (
    AssistantDeltaPayload,
    AssistantReasoningDeltaPayload,
    ConversationCompactedPayload,
    ErrorCode,
    ErrorDetail,
    EventEnvelope,
    MessagePage,
    MessageRecord,
    MessageRole,
    OperationCompletedPayload,
    OperationFailedPayload,
    OperationProgressPayload,
    OperationStartedPayload,
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
    SubagentCancelledPayload,
    SubagentCancelRequestedPayload,
    SubagentCompletedPayload,
    SubagentErrorCode,
    SubagentFailedPayload,
    SubagentInputRequiredPayload,
    SubagentInputResumedPayload,
    SubagentInterruptedPayload,
    SubagentProgressPayload,
    SubagentQueuedPayload,
    SubagentRecord,
    SubagentRequest,
    SubagentResult,
    SubagentStartedPayload,
    SubagentStatus,
    SubagentType,
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
from app.domain.contracts.enums import AttemptStatus
from app.domain.contracts.runtime import PublicationSummary, RunSummary
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
    OperationStartedPayload(
        operation_id="acquire:srcbind_gdc", label="获取 gdc", attempt=1
    ),
    OperationProgressPayload(
        operation_id="acquire:srcbind_gdc", kind="download", current=1, total=2
    ),
    OperationCompletedPayload(operation_id="acquire:srcbind_gdc", output_digest="ab" * 32),
    OperationFailedPayload(
        operation_id="acquire:srcbind_gdc",
        status=AttemptStatus.FAILED,
        error=ErrorDetail(
            code=ErrorCode.INTERNAL_ERROR,
            message="boom",
            retryable=False,
        ),
    ),
    WarningPayload(message="compaction failed", code="compaction_failed"),
]

def make_subagent_runtime_payloads() -> list[object]:
    return [
        SubagentQueuedPayload(
            subagent_id="subagent_123",
            request=SubagentRequest(
                agent_type=SubagentType.SOURCE_RESEARCH,
                objective="Find datasets",
                domain="bioinformatics",
                capability="source_research",
                inputs={},
            ),
        ),
        SubagentStartedPayload(subagent_id="subagent_123"),
        SubagentProgressPayload(subagent_id="subagent_123", current=1, total=2),
        SubagentCompletedPayload(
            subagent_id="subagent_123",
            result=SubagentResult(
                subagent_id="subagent_123",
                status=SubagentStatus.COMPLETED,
                summary="Found datasets",
            ),
        ),
        SubagentFailedPayload(
            subagent_id="subagent_123",
            result=SubagentResult(
                subagent_id="subagent_123",
                status=SubagentStatus.FAILED,
                summary="Search failed",
            ),
        ),
        SubagentCancelRequestedPayload(subagent_id="subagent_123"),
        SubagentCancelledPayload(
            subagent_id="subagent_123",
            result=SubagentResult(
                subagent_id="subagent_123",
                status=SubagentStatus.CANCELLED,
                summary="Cancelled",
            ),
        ),
        SubagentInterruptedPayload(
            subagent_id="subagent_123",
            result=SubagentResult(
                subagent_id="subagent_123",
                status=SubagentStatus.INTERRUPTED,
                summary="Interrupted",
            ),
        ),
        SubagentInputRequiredPayload(
            subagent_id="subagent_123",
            request_id="request_123",
            summary="Credentials required",
            prompt_kind="api_key_or_credential",
        ),
        SubagentInputResumedPayload(
            subagent_id="subagent_123",
            request_id="request_123",
            decision="approve",
        ),
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


def test_fixture_start_request_preserves_database_selection() -> None:
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
def test_fixture_start_request_accepts_and_preserves_database_selection(
    databases: list[str],
) -> None:
    request = StartTaskRequest(
        request_id="req_fixture",
        input="fixture topic",
        databases=databases,
        mode=TaskMode.FIXTURE,
    )

    assert request.databases == databases


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
    assert {payload.type for payload in RUNTIME_PAYLOADS}.issubset(
        set(RuntimeEventType)
        | {
            PipelineEventType.TOOL_COMPLETED,
            PipelineEventType.WARNING,
        }
    )

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


def test_runtime_payload_fixtures_cover_every_runtime_event_type() -> None:
    payload_types = {
        payload.type
        for payload in [*RUNTIME_PAYLOADS, *make_subagent_runtime_payloads()]
        if isinstance(payload.type, RuntimeEventType)
    }

    assert payload_types == set(RuntimeEventType)


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


def test_subagent_enums_keep_stable_wire_values() -> None:
    assert {agent_type.value for agent_type in SubagentType} == {
        "source_research",
        "skill_builder",
    }
    assert {status.value for status in SubagentStatus} == {
        "queued",
        "running",
        "completed",
        "failed",
        "cancel_requested",
        "cancelled",
        "interrupted",
    }
    assert {code.value for code in SubagentErrorCode} == {
        "not_found",
        "capability_gap",
        "extraction_failed",
        "auth_required",
        "captcha_required",
        "credential_required",
        "payment_required",
        "policy_denied",
        "rate_limited",
        "timed_out",
        "cancelled",
        "internal_error",
        "max_turns_exceeded",
    }


def test_subagent_runtime_contracts_validate_terminal_results_and_snapshot() -> None:
    record = SubagentRecord(
        subagent_id="subagent_123",
        task_id="task_123",
        run_id="run_123",
        agent_type=SubagentType.SOURCE_RESEARCH,
        objective="Find TP53 datasets",
        status=SubagentStatus.QUEUED,
        parent_tool_call_id="call_123",
        created_at=NOW,
        progress_current=0,
        source_asset_ids=[],
    )
    request = SubagentRequest(
        agent_type=SubagentType.SOURCE_RESEARCH,
        objective="Find TP53 datasets",
        domain="bioinformatics",
        capability="source_research",
        inputs={"gene": "TP53"},
    )
    result = SubagentResult(
        subagent_id=record.subagent_id,
        status=SubagentStatus.COMPLETED,
        summary="Found two datasets",
        source_asset_ids=["asset_1"],
        warnings=["One source needs credentials"],
    )

    summary = TaskSummary(
        task_id="task_123",
        mode=TaskMode.AGENT,
        title="TP53 datasets",
        status=RunStatus.RUNNING,
        created_at=NOW,
        updated_at=NOW,
    )
    snapshot = TaskSnapshot(task=summary, subagents=[record])

    assert request.target_source is None
    assert result.status is SubagentStatus.COMPLETED
    assert snapshot.subagents == [record]
    with pytest.raises(ValidationError, match="terminal"):
        SubagentResult(
            subagent_id="subagent_123",
            status=SubagentStatus.RUNNING,
            summary="Still working",
        )


def test_run_summary_partial_projection_allowed() -> None:
    # 旧事件重放：COMPLETED 无 build_result / FAILED 无 error_code 均合法（投影可部分）。
    assert RunSummary(run_status="completed").build_result is None
    assert RunSummary(run_status="failed").error_code is None
    summary = RunSummary(
        run_status="completed",
        build_result=BuildResult(
            status=BuildResultStatus.NO_DATA,
            valid_row_count=0,
            reason_codes=["no_primary_data"],
        ),
        user_message="任务完成但未产出可发布的主数据。",
    )
    assert summary.build_result.reason_codes == ["no_primary_data"]


def test_publication_summary_chain_links() -> None:
    first = PublicationSummary(
        publication_id="pub-run_1", manifest_sha256="a" * 64, published_at=datetime.now(UTC)
    )
    second = PublicationSummary(
        publication_id="pub-run_2",
        manifest_sha256="b" * 64,
        supersedes_publication_id=first.publication_id,
        published_at=datetime.now(UTC),
    )
    assert second.supersedes_publication_id == "pub-run_1"


def test_run_record_summary_and_snapshot_publications() -> None:
    run = RunRecord(
        run_id="run_1", task_id="task_1", request_id="req_1", status="completed",
        input="topic", created_at=datetime.now(UTC), updated_at=datetime.now(UTC),
        summary=RunSummary(run_status="completed"),
    )
    assert run.summary is not None
    snapshot = TaskSnapshot(
        task=TaskSummary(
            task_id="task_1",
            mode=TaskMode.AGENT,
            title="t",
            status="completed",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        ),
        runs=[run],
        current_publication_id="pub-run_1",
        publications=[
            PublicationSummary(
                publication_id="pub-run_1",
                manifest_sha256="a" * 64,
                published_at=datetime.now(UTC),
            )
        ],
    )
    assert snapshot.current_publication_id == "pub-run_1"
    assert snapshot.publications[0].manifest_sha256 == "a" * 64


def test_task_summary_has_no_no_artifact_failure_field() -> None:
    from app.domain.contracts.runtime import TaskSummary

    task = TaskSummary(
        task_id="task_1", mode="agent", databases=[], title="t",
        status="completed", created_at=datetime.now(UTC), updated_at=datetime.now(UTC),
    )
    assert not hasattr(task, "no_artifact_failure")
