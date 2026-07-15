from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import AsyncIterator

import httpx
import pytest
from fastapi import FastAPI

from app.config import Settings
from app.domain.contracts import (
    EventEnvelope,
    MessagePage,
    RunCancelRequestedPayload,
    RunCancelledPayload,
    RunCompletedPayload,
    RunFinalizingPayload,
    RunQueuedPayload,
    RunRecord,
    RunStartedPayload,
    RunStatus,
    TaskMode,
    TaskRunAccepted,
    TaskSnapshot,
    TaskSummary,
    build_event,
)
from app.main import create_app


NOW = datetime(2026, 7, 14, tzinfo=timezone.utc)


@asynccontextmanager
async def api_client(
    tmp_path: Path,
    *,
    configured: Settings | None = None,
) -> AsyncIterator[tuple[FastAPI, httpx.AsyncClient]]:
    application = create_app(
        configured or Settings(output_dir=str(tmp_path / "output"))
    )
    async with application.router.lifespan_context(application):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://test",
        ) as client:
            yield application, client


def snapshot(
    task_id: str,
    *,
    status: RunStatus = RunStatus.COMPLETED,
    mode: TaskMode = TaskMode.AGENT,
    created_at: datetime = NOW,
) -> TaskSnapshot:
    active_run_id = (
        f"run_{task_id}"
        if status
        in {
            RunStatus.QUEUED,
            RunStatus.RUNNING,
            RunStatus.FINALIZING,
            RunStatus.CANCEL_REQUESTED,
        }
        else None
    )
    runs = (
        [
            RunRecord(
                run_id=active_run_id,
                task_id=task_id,
                request_id=f"req_{task_id}",
                status=status,
                input=task_id,
                created_at=created_at,
                updated_at=created_at,
                started_at=created_at if status is not RunStatus.QUEUED else None,
            )
        ]
        if active_run_id is not None
        else []
    )
    return TaskSnapshot(
        task=TaskSummary(
            task_id=task_id,
            mode=mode,
            title=task_id,
            status=status,
            active_run_id=active_run_id,
            created_at=created_at,
            updated_at=created_at,
        ),
        runs=runs,
    )


@pytest.mark.asyncio
async def test_list_tasks_uses_lifespan_repository_and_exact_page_wire(
    tmp_path: Path,
) -> None:
    async with api_client(tmp_path) as (_, client):
        response = await client.get("/api/v1/tasks")

    assert response.status_code == 200
    assert response.json() == {
        "schema_version": "1.0",
        "active_items": [],
        "items": [],
        "next_cursor": None,
    }


@pytest.mark.asyncio
async def test_task_runtime_without_lifespan_returns_stable_503(tmp_path: Path) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://test",
    ) as client:
        response = await client.get("/api/v1/tasks")

    assert response.status_code == 503
    assert response.json() == {"detail": "Task runtime is unavailable"}


@pytest.mark.asyncio
async def test_list_tasks_repeats_active_items_and_pages_only_history(
    tmp_path: Path,
) -> None:
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        for number in range(65):
            await repository.save_snapshot(
                snapshot(
                    f"task_history_{number:03d}",
                    created_at=NOW + timedelta(minutes=number),
                )
            )
        for number in range(2):
            await repository.save_snapshot(
                snapshot(
                    f"task_active_{number}",
                    status=RunStatus.RUNNING,
                    created_at=NOW + timedelta(days=1, minutes=number),
                )
            )

        first = (await client.get("/api/v1/tasks", params={"limit": 30})).json()
        second = (
            await client.get(
                "/api/v1/tasks",
                params={"limit": 30, "cursor": first["next_cursor"]},
            )
        ).json()
        third = (
            await client.get(
                "/api/v1/tasks",
                params={"limit": 30, "cursor": second["next_cursor"]},
            )
        ).json()

    active_ids = {"task_active_0", "task_active_1"}
    assert [len(page["items"]) for page in (first, second, third)] == [30, 30, 5]
    assert [
        {item["task_id"] for item in page["active_items"]}
        for page in (first, second, third)
    ] == [active_ids, active_ids, active_ids]
    history_ids = [
        item["task_id"] for page in (first, second, third) for item in page["items"]
    ]
    assert len(history_ids) == len(set(history_ids)) == 65
    assert first["next_cursor"] is not None
    assert second["next_cursor"] is not None
    assert third["next_cursor"] is None


@pytest.mark.asyncio
async def test_task_detail_messages_and_events_are_authoritative_and_paginated(
    tmp_path: Path,
) -> None:
    configured = Settings(
        output_dir=str(tmp_path / "output"),
        task_message_page_size=2,
    )
    async with api_client(tmp_path, configured=configured) as (application, client):
        repository = application.state.task_repository
        await repository.save_snapshot(snapshot("task_read"))
        await repository.task_session("task_read").add_items(
            [{"role": "user", "content": f"message {number}"} for number in range(1, 6)]
        )
        payloads = [
            RunQueuedPayload(request_id="req_read", input="question"),
            RunStartedPayload(),
            RunFinalizingPayload(),
            RunCompletedPayload(),
        ]
        for sequence, payload in enumerate(payloads, start=1):
            await repository.append_event(
                build_event(
                    task_id="task_read",
                    run_id="run_read",
                    sequence=sequence,
                    timestamp=NOW + timedelta(seconds=sequence),
                    payload=payload,
                )
            )

        detail_response = await client.get("/api/v1/tasks/task_read")
        first_messages_response = await client.get("/api/v1/tasks/task_read/messages")
        first_messages = MessagePage.model_validate(first_messages_response.json())
        second_messages = MessagePage.model_validate(
            (
                await client.get(
                    "/api/v1/tasks/task_read/messages",
                    params={"cursor": first_messages.next_cursor},
                )
            ).json()
        )
        third_messages = MessagePage.model_validate(
            (
                await client.get(
                    "/api/v1/tasks/task_read/messages",
                    params={"cursor": second_messages.next_cursor},
                )
            ).json()
        )
        events_response = await client.get(
            "/api/v1/tasks/task_read/events",
            params={"after_sequence": 1, "limit": 2},
        )

    assert detail_response.status_code == 200
    detail = TaskSnapshot.model_validate(detail_response.json())
    assert detail.task.task_id == "task_read"
    assert detail.task.latest_sequence == 4
    assert [message.ordinal for message in detail.messages] == [4, 5]
    assert detail.older_messages_cursor == first_messages.next_cursor
    assert [message.ordinal for message in first_messages.messages] == [4, 5]
    assert [message.ordinal for message in second_messages.messages] == [2, 3]
    assert [message.ordinal for message in third_messages.messages] == [1]
    assert third_messages.next_cursor is None
    assert events_response.status_code == 200
    assert set(events_response.json()) == {"events"}
    events = [
        EventEnvelope.model_validate(item) for item in events_response.json()["events"]
    ]
    assert [event.sequence for event in events] == [2, 3]


@pytest.mark.asyncio
@pytest.mark.parametrize("task_id", ["task_missing", "bad.task"])
async def test_read_routes_hide_missing_and_unsafe_tasks(
    tmp_path: Path,
    task_id: str,
) -> None:
    async with api_client(tmp_path) as (_, client):
        responses = [
            await client.get(f"/api/v1/tasks/{task_id}"),
            await client.get(f"/api/v1/tasks/{task_id}/messages"),
            await client.get(f"/api/v1/tasks/{task_id}/events"),
        ]

    assert [response.status_code for response in responses] == [404, 404, 404]
    assert all(
        response.json() == {"detail": "Task not found"} for response in responses
    )


@pytest.mark.asyncio
async def test_read_route_cursor_and_limit_validation_returns_422(
    tmp_path: Path,
) -> None:
    configured = Settings(
        output_dir=str(tmp_path / "output"),
        task_page_max_size=100,
        task_message_page_size=2,
    )
    async with api_client(tmp_path, configured=configured) as (application, client):
        repository = application.state.task_repository
        await repository.save_snapshot(snapshot("task_a"))
        await repository.save_snapshot(snapshot("task_b"))
        await repository.task_session("task_a").add_items(
            [{"role": "user", "content": f"message {number}"} for number in range(3)]
        )
        cursor = (await client.get("/api/v1/tasks/task_a/messages")).json()[
            "next_cursor"
        ]

        responses = [
            await client.get("/api/v1/tasks", params={"cursor": "invalid"}),
            await client.get("/api/v1/tasks", params={"cursor": ""}),
            await client.get("/api/v1/tasks", params={"limit": 0}),
            await client.get("/api/v1/tasks", params={"limit": 101}),
            await client.get(
                "/api/v1/tasks/task_b/messages", params={"cursor": cursor}
            ),
            await client.get("/api/v1/tasks/task_a/messages", params={"cursor": ""}),
            await client.get("/api/v1/tasks/task_a/messages", params={"limit": 0}),
            await client.get("/api/v1/tasks/task_a/messages", params={"limit": 3}),
            await client.get(
                "/api/v1/tasks/task_a/events", params={"after_sequence": -1}
            ),
            await client.get("/api/v1/tasks/task_a/events", params={"limit": 0}),
            await client.get("/api/v1/tasks/task_a/events", params={"limit": 1001}),
        ]

    assert [response.status_code for response in responses] == [422] * len(responses)


class BlockingExecutor:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.executions: list[object] = []

    async def __call__(self, execution: object) -> None:
        self.executions.append(execution)
        self.started.set()
        await self.release.wait()


@pytest.mark.asyncio
async def test_concurrent_duplicate_create_returns_one_acceptance_without_orphan(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    executor = BlockingExecutor()
    async with api_client(tmp_path) as (application, client):
        manager = application.state.task_manager
        repository = application.state.task_repository
        manager.run_executor = executor
        real_create = manager.create_task
        callers = 0
        callers_lock = asyncio.Lock()
        both_ready = asyncio.Event()

        async def create_after_barrier(request):
            nonlocal callers
            async with callers_lock:
                callers += 1
                if callers == 2:
                    both_ready.set()
            await both_ready.wait()
            return await real_create(request)

        monkeypatch.setattr(manager, "create_task", create_after_barrier)
        body = {
            "request_id": "req_api_duplicate",
            "input": "create exactly once",
            "databases": [],
            "mode": "agent",
        }
        try:
            first, duplicate = await asyncio.gather(
                client.post("/api/v1/tasks", json=body),
                client.post("/api/v1/tasks", json=body),
            )
            await asyncio.wait_for(executor.started.wait(), timeout=1)

            assert first.status_code == duplicate.status_code == 202
            assert first.json() == duplicate.json()
            accepted = TaskRunAccepted.model_validate(first.json())
            page = await repository.list_tasks()
            stored = await repository.get_snapshot(accepted.task_id)
            events = await repository.list_events(accepted.task_id)
            task_directories = [
                path for path in repository.tasks_dir.iterdir() if path.is_dir()
            ]

            assert [task.task_id for task in page.active_items] == [accepted.task_id]
            assert page.items == []
            assert stored is not None
            assert [run.run_id for run in stored.runs] == [accepted.run_id]
            assert await repository.find_request(body["request_id"]) == accepted
            assert (
                sum(isinstance(event.payload, RunQueuedPayload) for event in events)
                == 1
            )
            assert task_directories == [repository.tasks_dir / accepted.task_id]
        finally:
            executor.release.set()
            await manager.wait_until_idle()


@pytest.mark.asyncio
async def test_create_queue_full_returns_429_without_orphan_and_retry_stays_202(
    tmp_path: Path,
) -> None:
    configured = Settings(
        output_dir=str(tmp_path / "output"),
        runtime_max_active_runs=1,
        runtime_run_queue_size=1,
    )
    executor = BlockingExecutor()
    async with api_client(tmp_path, configured=configured) as (application, client):
        manager = application.state.task_manager
        repository = application.state.task_repository
        manager.run_executor = executor
        active_body = {"request_id": "req_active", "input": "active"}
        waiting_body = {"request_id": "req_waiting", "input": "waiting"}
        rejected_body = {"request_id": "req_rejected", "input": "rejected"}
        try:
            active = await client.post("/api/v1/tasks", json=active_body)
            await asyncio.wait_for(executor.started.wait(), timeout=1)
            waiting = await client.post("/api/v1/tasks", json=waiting_body)
            rejected = await client.post("/api/v1/tasks", json=rejected_body)
            retry = await client.post("/api/v1/tasks", json=active_body)

            assert active.status_code == waiting.status_code == retry.status_code == 202
            assert retry.json() == active.json()
            assert rejected.status_code == 429
            assert rejected.json() == {"detail": "Run queue is full"}
            page = await repository.list_tasks()
            assert len(page.active_items) == 2
            assert page.items == []
            assert await repository.find_request("req_rejected") is None
            assert (
                len([path for path in repository.tasks_dir.iterdir() if path.is_dir()])
                == 2
            )
        finally:
            executor.release.set()
            await manager.wait_until_idle()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "manager_state",
    [
        None,
        {"_started": False, "_closing": False, "_closed": False},
        {"_started": True, "_closing": True, "_closed": False},
    ],
)
async def test_create_returns_stable_503_when_manager_is_unavailable(
    tmp_path: Path,
    manager_state: dict[str, bool] | None,
) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    if manager_state is not None:
        application.state.task_manager = SimpleNamespace(**manager_state)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://test",
    ) as client:
        response = await client.post(
            "/api/v1/tasks",
            json={"request_id": "req_unavailable", "input": "question"},
        )

    assert response.status_code == 503
    assert response.json() == {"detail": "Task runtime is unavailable"}


@pytest.mark.asyncio
async def test_create_validation_rejects_blank_fixture_and_extra_fields_without_admission(
    tmp_path: Path,
) -> None:
    executor = BlockingExecutor()
    cases = [
        (
            {"request_id": "   ", "input": "question"},
            "request_id",
        ),
        (
            {
                "request_id": "req_blank_input",
                "input": "   ",
                "databases": [],
                "mode": "agent",
            },
            "input",
        ),
        (
            {
                "request_id": "req_fixture_missing",
                "input": "question",
                "databases": ["pubmed"],
                "mode": "fixture",
            },
            "body",
        ),
        (
            {
                "request_id": "req_fixture_duplicate",
                "input": "question",
                "databases": ["pubmed", "pubmed", "geo"],
                "mode": "fixture",
            },
            "body",
        ),
        (
            {
                "request_id": "req_fixture_extra_database",
                "input": "question",
                "databases": ["pubmed", "geo", "gdc"],
                "mode": "fixture",
            },
            "body",
        ),
        (
            {
                "request_id": "req_invalid_mode",
                "input": "question",
                "mode": "unsupported",
            },
            "mode",
        ),
        (
            {
                "request_id": "req_extra_field",
                "input": "question",
                "unexpected": True,
            },
            "unexpected",
        ),
    ]
    async with api_client(tmp_path) as (application, client):
        manager = application.state.task_manager
        repository = application.state.task_repository
        manager.run_executor = executor
        try:
            for body, expected_location in cases:
                response = await client.post("/api/v1/tasks", json=body)
                assert response.status_code == 422
                locations = [item["loc"][-1] for item in response.json()["detail"]]
                assert expected_location in locations

            page = await repository.list_tasks()
            assert page.active_items == page.items == []
            for body, _ in cases:
                assert await repository.find_request(body["request_id"]) is None
        finally:
            executor.release.set()
            await manager.wait_until_idle()


@pytest.mark.asyncio
async def test_fixture_create_returns_202_then_completes_with_durable_bridge(
    tmp_path: Path,
) -> None:
    topic = "  user supplied acceptance topic  "
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        manager = application.state.task_manager
        created = await client.post(
            "/api/v1/tasks",
            json={
                "request_id": "req_fixture_api",
                "input": topic,
                "databases": ["geo", "pubmed"],
                "mode": "fixture",
            },
        )

        assert created.status_code == 202
        accepted = TaskRunAccepted.model_validate(created.json())
        assert accepted.status is RunStatus.QUEUED
        assert accepted.task_id.startswith("task_")
        assert accepted.run_id.startswith("run_")

        await manager.wait_until_idle()
        detail = TaskSnapshot.model_validate(
            (await client.get(f"/api/v1/tasks/{accepted.task_id}")).json()
        )
        events_response = await client.get(
            f"/api/v1/tasks/{accepted.task_id}/events",
            params={"limit": 1000},
        )
        artifact_response = await client.get(
            f"/api/v1/tasks/{accepted.task_id}/artifacts"
        )
        manifest_response = await client.get(
            f"/api/v1/tasks/{accepted.task_id}/artifacts/run_manifest"
        )
        new_continuation = await client.post(
            f"/api/v1/tasks/{accepted.task_id}/runs",
            json={"request_id": "req_fixture_continue", "input": "continue"},
        )
        retried_request_id = await client.post(
            f"/api/v1/tasks/{accepted.task_id}/runs",
            json={"request_id": accepted.request_id, "input": "continue"},
        )

    assert detail.task.mode is TaskMode.FIXTURE
    assert detail.task.status is RunStatus.COMPLETED
    assert detail.task.active_run_id is None
    assert [run.run_id for run in detail.runs] == [accepted.run_id]
    assert detail.runs[0].status is RunStatus.COMPLETED
    events = [
        EventEnvelope.model_validate(item) for item in events_response.json()["events"]
    ]
    assert [event.sequence for event in events] == list(range(1, len(events) + 1))
    assert events[0].type == "run_queued"
    assert events[1].type == "run_started"
    assert events[-2].type == "run_finalizing"
    assert events[-1].type == "run_completed"
    legacy_events = [
        EventEnvelope.model_validate_json(line)
        for line in (repository.tasks_dir / accepted.task_id / "logs" / "events.jsonl")
        .read_text("utf-8")
        .splitlines()
        if line.strip()
    ]
    bridged = events[2:-2]
    assert len(bridged) == len(legacy_events)
    assert [
        (
            event.type,
            event.payload.model_dump(mode="json"),
            event.stage_attempt_id,
            event.timestamp,
        )
        for event in bridged
    ] == [
        (
            event.type,
            event.payload.model_dump(mode="json"),
            event.stage_attempt_id,
            event.timestamp,
        )
        for event in legacy_events
    ]
    assert all(event.schema_version == "2.0" for event in bridged)
    assert all(event.run_id == accepted.run_id for event in bridged)
    assert artifact_response.status_code == 200
    assert artifact_response.json()["artifacts"][0]["artifact_id"] == "run_manifest"
    assert manifest_response.status_code == 200
    assert manifest_response.json()["request"]["topic"] == topic.strip()
    assert new_continuation.status_code == retried_request_id.status_code == 409
    assert (
        new_continuation.json()
        == retried_request_id.json()
        == {"detail": "Fixture tasks cannot be continued"}
    )


class ContinueExecutor:
    def __init__(self) -> None:
        self.calls = 0
        self.continuation_started = asyncio.Event()
        self.release_continuation = asyncio.Event()

    async def __call__(self, execution: object) -> None:
        self.calls += 1
        if self.calls == 2:
            self.continuation_started.set()
            await self.release_continuation.wait()


@pytest.mark.asyncio
async def test_agent_continuation_is_202_idempotent_and_rejects_new_active_request(
    tmp_path: Path,
) -> None:
    executor = ContinueExecutor()
    async with api_client(tmp_path) as (application, client):
        manager = application.state.task_manager
        repository = application.state.task_repository
        manager.run_executor = executor
        created = await client.post(
            "/api/v1/tasks",
            json={"request_id": "req_first", "input": "first"},
        )
        accepted_task = TaskRunAccepted.model_validate(created.json())
        await manager.wait_until_idle()
        try:
            continuation = await client.post(
                f"/api/v1/tasks/{accepted_task.task_id}/runs",
                json={"request_id": "req_second", "input": "second"},
            )
            await asyncio.wait_for(executor.continuation_started.wait(), timeout=1)
            retry = await client.post(
                f"/api/v1/tasks/{accepted_task.task_id}/runs",
                json={"request_id": "req_second", "input": "second"},
            )
            conflict = await client.post(
                f"/api/v1/tasks/{accepted_task.task_id}/runs",
                json={"request_id": "req_third", "input": "third"},
            )

            assert continuation.status_code == retry.status_code == 202
            assert continuation.json() == retry.json()
            assert conflict.status_code == 409
            assert conflict.json() == {"detail": "Task already has an active run"}
            stored = await repository.get_snapshot(accepted_task.task_id)
            assert stored is not None
            assert len(stored.runs) == 2
        finally:
            executor.release_continuation.set()
            await manager.wait_until_idle()


@pytest.mark.asyncio
@pytest.mark.parametrize("task_id", ["task_missing", "bad.task"])
async def test_continuation_hides_missing_and_unsafe_tasks(
    tmp_path: Path,
    task_id: str,
) -> None:
    async with api_client(tmp_path) as (_, client):
        response = await client.post(
            f"/api/v1/tasks/{task_id}/runs",
            json={"request_id": "req_continue_missing", "input": "continue"},
        )

    assert response.status_code == 404
    assert response.json() == {"detail": "Task not found"}


@pytest.mark.asyncio
async def test_cancel_queued_run_is_202_and_retry_does_not_duplicate_events(
    tmp_path: Path,
) -> None:
    configured = Settings(
        output_dir=str(tmp_path / "output"),
        runtime_max_active_runs=1,
        runtime_run_queue_size=2,
    )
    executor = BlockingExecutor()
    async with api_client(tmp_path, configured=configured) as (application, client):
        manager = application.state.task_manager
        repository = application.state.task_repository
        manager.run_executor = executor
        try:
            active = TaskRunAccepted.model_validate(
                (
                    await client.post(
                        "/api/v1/tasks",
                        json={"request_id": "req_cancel_active", "input": "active"},
                    )
                ).json()
            )
            await asyncio.wait_for(executor.started.wait(), timeout=1)
            queued = TaskRunAccepted.model_validate(
                (
                    await client.post(
                        "/api/v1/tasks",
                        json={"request_id": "req_cancel_queued", "input": "queued"},
                    )
                ).json()
            )

            cancelled = await client.post(
                f"/api/v1/tasks/{queued.task_id}/runs/{queued.run_id}/cancel"
            )
            retried = await client.post(
                f"/api/v1/tasks/{queued.task_id}/runs/{queued.run_id}/cancel"
            )

            assert cancelled.status_code == retried.status_code == 202
            assert cancelled.json() == retried.json()
            snapshot_value = TaskSnapshot.model_validate(cancelled.json())
            assert snapshot_value.runs[-1].status is RunStatus.CANCELLED
            assert snapshot_value.task.active_run_id is None
            events = await repository.list_events(queued.task_id)
            assert (
                sum(
                    isinstance(event.payload, RunCancelRequestedPayload)
                    for event in events
                )
                == 1
            )
            assert (
                sum(isinstance(event.payload, RunCancelledPayload) for event in events)
                == 1
            )
            active_snapshot = await repository.get_snapshot(active.task_id)
            assert active_snapshot is not None
            assert active_snapshot.task.active_run_id == active.run_id
        finally:
            executor.release.set()
            await manager.wait_until_idle()


class CooperativeCancellationExecutor:
    class StreamingResult:
        def __init__(self) -> None:
            self.cancel_calls: list[str] = []
            self.cancel_called = asyncio.Event()

        def cancel(self, mode: str) -> None:
            self.cancel_calls.append(mode)
            self.cancel_called.set()

    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.execution = None
        self.streaming_result = self.StreamingResult()

    async def __call__(self, execution) -> None:
        self.execution = execution
        execution.set_streaming_result(self.streaming_result)
        self.started.set()
        await self.streaming_result.cancel_called.wait()


@pytest.mark.asyncio
async def test_cancel_running_run_drains_and_retry_is_idempotent(
    tmp_path: Path,
) -> None:
    executor = CooperativeCancellationExecutor()
    async with api_client(tmp_path) as (application, client):
        manager = application.state.task_manager
        repository = application.state.task_repository
        manager.run_executor = executor
        accepted = TaskRunAccepted.model_validate(
            (
                await client.post(
                    "/api/v1/tasks",
                    json={"request_id": "req_cancel_running", "input": "running"},
                )
            ).json()
        )
        await asyncio.wait_for(executor.started.wait(), timeout=1)

        cancelled = await client.post(
            f"/api/v1/tasks/{accepted.task_id}/runs/{accepted.run_id}/cancel"
        )
        retried = await client.post(
            f"/api/v1/tasks/{accepted.task_id}/runs/{accepted.run_id}/cancel"
        )

        assert cancelled.status_code == retried.status_code == 202
        assert cancelled.json() == retried.json()
        assert executor.execution is not None
        assert executor.execution.context.cancellation_requested.is_set()
        assert executor.streaming_result.cancel_calls == ["after_turn"]
        events = await repository.list_events(accepted.task_id)
        assert [
            event.payload.type.value
            for event in events
            if isinstance(
                event.payload,
                (RunCancelRequestedPayload, RunCancelledPayload),
            )
        ] == ["run_cancel_requested", "run_cancelled"]


@pytest.mark.asyncio
async def test_cancel_missing_run_and_terminal_run_use_404_and_409(
    tmp_path: Path,
) -> None:
    async def complete(_execution: object) -> None:
        return None

    async with api_client(tmp_path) as (application, client):
        manager = application.state.task_manager
        manager.run_executor = complete
        accepted = TaskRunAccepted.model_validate(
            (
                await client.post(
                    "/api/v1/tasks",
                    json={"request_id": "req_cancel_terminal", "input": "done"},
                )
            ).json()
        )
        await manager.wait_until_idle()

        missing_task = await client.post(
            "/api/v1/tasks/task_missing/runs/run_missing/cancel"
        )
        unsafe_task = await client.post(
            "/api/v1/tasks/bad.task/runs/run_missing/cancel"
        )
        missing_run = await client.post(
            f"/api/v1/tasks/{accepted.task_id}/runs/run_missing/cancel"
        )
        unsafe_run = await client.post(
            f"/api/v1/tasks/{accepted.task_id}/runs/bad.run/cancel"
        )
        terminal = await client.post(
            f"/api/v1/tasks/{accepted.task_id}/runs/{accepted.run_id}/cancel"
        )

    assert missing_task.status_code == unsafe_task.status_code == 404
    assert missing_task.json() == unsafe_task.json() == {"detail": "Task not found"}
    assert missing_run.status_code == unsafe_run.status_code == 404
    assert missing_run.json() == unsafe_run.json() == {"detail": "Run not found"}
    assert terminal.status_code == 409
    assert terminal.json() == {"detail": "Run is not cancellable"}


@pytest.mark.asyncio
async def test_cancel_maps_manager_shutdown_race_to_503(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with api_client(tmp_path) as (application, _):
        manager = application.state.task_manager
        repository = application.state.task_repository
        task_id = "task_cancel_shutdown_race"
        run_id = f"run_{task_id}"
        await repository.save_snapshot(snapshot(task_id, status=RunStatus.QUEUED))
        cancel_entered = asyncio.Event()
        release_cancel = asyncio.Event()
        real_cancel = manager.cancel_run

        async def delayed_cancel(*args, **kwargs):
            cancel_entered.set()
            await release_cancel.wait()
            return await real_cancel(*args, **kwargs)

        monkeypatch.setattr(manager, "cancel_run", delayed_cancel)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(
                app=application,
                raise_app_exceptions=False,
            ),
            base_url="http://test",
        ) as client:
            request_task = asyncio.create_task(
                client.post(f"/api/v1/tasks/{task_id}/runs/{run_id}/cancel")
            )
            try:
                await asyncio.wait_for(cancel_entered.wait(), timeout=1)
                await manager.close()
                release_cancel.set()
                response = await asyncio.wait_for(request_task, timeout=1)
            finally:
                release_cancel.set()
                await asyncio.gather(request_task, return_exceptions=True)

    assert response.status_code == 503
    assert response.json() == {"detail": "Task runtime is unavailable"}


@pytest.mark.asyncio
async def test_delete_terminal_task_returns_empty_204_and_removes_all_read_surfaces(
    tmp_path: Path,
) -> None:
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        task_id = "task_delete_api"
        sibling_id = "task_delete_sibling"
        await repository.save_snapshot(snapshot(task_id))
        await repository.save_snapshot(snapshot(sibling_id))
        await repository.task_session(task_id).add_items(
            [{"role": "user", "content": "delete me"}]
        )
        payloads = [
            RunQueuedPayload(request_id="req_delete_api", input="delete me"),
            RunStartedPayload(),
            RunFinalizingPayload(),
            RunCompletedPayload(),
        ]
        for sequence, payload in enumerate(payloads, start=1):
            await repository.append_event(
                build_event(
                    task_id=task_id,
                    run_id="run_delete_api",
                    sequence=sequence,
                    timestamp=NOW + timedelta(seconds=sequence),
                    payload=payload,
                )
            )
        artifact = repository.tasks_dir / task_id / "artifacts" / "result.txt"
        artifact.parent.mkdir(parents=True)
        artifact.write_text("delete me", "utf-8")

        deleted = await client.delete(f"/api/v1/tasks/{task_id}")
        listed = await client.get("/api/v1/tasks")
        reads = [
            await client.get(f"/api/v1/tasks/{task_id}"),
            await client.get(f"/api/v1/tasks/{task_id}/messages"),
            await client.get(f"/api/v1/tasks/{task_id}/events"),
            await client.get(f"/api/v1/tasks/{task_id}/artifacts"),
            await client.get(f"/api/v1/tasks/{task_id}/artifacts/artifact_missing"),
        ]
        sibling = await client.get(f"/api/v1/tasks/{sibling_id}")
        repeated = await client.delete(f"/api/v1/tasks/{task_id}")

    assert deleted.status_code == 204
    assert deleted.content == b""
    listed_ids = {
        item["task_id"]
        for key in ("active_items", "items")
        for item in listed.json()[key]
    }
    assert task_id not in listed_ids
    assert sibling_id in listed_ids
    assert [response.status_code for response in reads] == [404] * len(reads)
    assert all(response.json() == {"detail": "Task not found"} for response in reads)
    assert sibling.status_code == 200
    assert repeated.status_code == 404
    assert repeated.json() == {"detail": "Task not found"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status",
    [
        RunStatus.QUEUED,
        RunStatus.RUNNING,
        RunStatus.FINALIZING,
        RunStatus.CANCEL_REQUESTED,
    ],
)
async def test_delete_active_task_returns_stable_409_without_mutation(
    tmp_path: Path,
    status: RunStatus,
) -> None:
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        task_id = f"task_delete_{status.value}"
        await repository.save_snapshot(snapshot(task_id, status=status))

        response = await client.delete(f"/api/v1/tasks/{task_id}")
        stored = await repository.get_snapshot(task_id)

    assert response.status_code == 409
    assert response.json() == {"detail": "Only terminal tasks can be deleted"}
    assert stored is not None
    assert stored.task.status is status


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "task_id",
    ["task_missing", "bad.task", "bad%5Ctask"],
)
async def test_delete_missing_and_unsafe_tasks_returns_stable_404(
    tmp_path: Path,
    task_id: str,
) -> None:
    async with api_client(tmp_path) as (_, client):
        response = await client.delete(f"/api/v1/tasks/{task_id}")

    assert response.status_code == 404
    assert response.json() == {"detail": "Task not found"}


@pytest.mark.asyncio
async def test_delete_uses_manager_only_and_returns_empty_204(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with api_client(tmp_path) as (application, client):
        manager = application.state.task_manager
        repository = application.state.task_repository
        deleted_ids: list[str] = []

        async def record_delete(task_id: str) -> None:
            deleted_ids.append(task_id)

        async def fail_repository_read(_task_id: str):
            raise AssertionError("DELETE route must not read the repository")

        monkeypatch.setattr(manager, "delete_task", record_delete)
        monkeypatch.setattr(repository, "get_snapshot", fail_repository_read)

        response = await client.delete("/api/v1/tasks/task_manager_only")

    assert response.status_code == 204
    assert response.content == b""
    assert deleted_ids == ["task_manager_only"]


@pytest.mark.asyncio
async def test_delete_returns_stable_503_when_runtime_is_unavailable(
    tmp_path: Path,
) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://test",
    ) as client:
        response = await client.delete("/api/v1/tasks/task_unavailable")

    assert response.status_code == 503
    assert response.json() == {"detail": "Task runtime is unavailable"}


@pytest.mark.asyncio
async def test_delete_maps_manager_shutdown_race_to_503(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with api_client(tmp_path) as (application, client):
        manager = application.state.task_manager

        async def fail_delete(_task_id: str) -> None:
            raise RuntimeError("task manager is not running")

        monkeypatch.setattr(manager, "delete_task", fail_delete)
        response = await client.delete("/api/v1/tasks/task_shutdown_race")

    assert response.status_code == 503
    assert response.json() == {"detail": "Task runtime is unavailable"}


@pytest.mark.asyncio
async def test_delete_unexpected_storage_error_remains_500(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with api_client(tmp_path) as (application, _):
        manager = application.state.task_manager

        async def fail_delete(_task_id: str) -> None:
            raise OSError("simulated delete failure")

        monkeypatch.setattr(manager, "delete_task", fail_delete)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(
                app=application,
                raise_app_exceptions=False,
            ),
            base_url="http://test",
        ) as client:
            response = await client.delete("/api/v1/tasks/task_storage_error")

    assert response.status_code == 500


@pytest.mark.asyncio
async def test_continuation_queue_full_returns_429_without_new_run_or_request(
    tmp_path: Path,
) -> None:
    configured = Settings(
        output_dir=str(tmp_path / "output"),
        runtime_max_active_runs=1,
        runtime_run_queue_size=1,
    )

    async def complete(_execution: object) -> None:
        return None

    executor = BlockingExecutor()
    async with api_client(tmp_path, configured=configured) as (application, client):
        manager = application.state.task_manager
        repository = application.state.task_repository
        manager.run_executor = complete
        target = TaskRunAccepted.model_validate(
            (
                await client.post(
                    "/api/v1/tasks",
                    json={"request_id": "req_continue_target", "input": "target"},
                )
            ).json()
        )
        await manager.wait_until_idle()

        manager.run_executor = executor
        try:
            await client.post(
                "/api/v1/tasks",
                json={"request_id": "req_continue_active", "input": "active"},
            )
            await asyncio.wait_for(executor.started.wait(), timeout=1)
            await client.post(
                "/api/v1/tasks",
                json={"request_id": "req_continue_waiting", "input": "waiting"},
            )

            rejected = await client.post(
                f"/api/v1/tasks/{target.task_id}/runs",
                json={"request_id": "req_continue_rejected", "input": "continue"},
            )

            assert rejected.status_code == 429
            assert rejected.json() == {"detail": "Run queue is full"}
            stored = await repository.get_snapshot(target.task_id)
            assert stored is not None
            assert [run.run_id for run in stored.runs] == [target.run_id]
            assert await repository.find_request("req_continue_rejected") is None
        finally:
            executor.release.set()
            await manager.wait_until_idle()


@pytest.mark.asyncio
async def test_unexpected_storage_and_manager_errors_remain_500(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with api_client(tmp_path) as (application, _):
        repository = application.state.task_repository
        manager = application.state.task_manager

        async def fail_list_tasks(*, limit=None, cursor=None):
            raise OSError("simulated index failure")

        async def fail_create(_request):
            raise RuntimeError("unexpected manager failure")

        monkeypatch.setattr(repository, "list_tasks", fail_list_tasks)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(
                app=application,
                raise_app_exceptions=False,
            ),
            base_url="http://test",
        ) as client:
            storage_response = await client.get("/api/v1/tasks")
            monkeypatch.setattr(manager, "create_task", fail_create)
            manager_response = await client.post(
                "/api/v1/tasks",
                json={"request_id": "req_unexpected", "input": "question"},
            )

    assert storage_response.status_code == manager_response.status_code == 500
