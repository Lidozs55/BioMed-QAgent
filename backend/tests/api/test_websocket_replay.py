from __future__ import annotations

import asyncio
import copy
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI, WebSocketDisconnect

import app.api.ws as ws_module
import app.api.ws_events as ws_events_module
from app.domain.contracts import RunStatus, TaskMode, TaskSnapshot, TaskSummary
from app.domain.contracts import (
    AssistantDeltaPayload,
    RunCompletedPayload,
    RunRecord,
    StartTaskRequest,
    build_event,
)
from app.runtime.hub import EventHub
from app.runtime.manager import TaskManager
from app.runtime.repository import TaskRepository


NOW = datetime(2026, 7, 14, tzinfo=timezone.utc)
_DISCONNECT = object()


class ObservedLock(asyncio.Lock):
    def __init__(self) -> None:
        super().__init__()
        self.blocked_acquire_entered = asyncio.Event()

    async def acquire(self) -> bool:
        if self.locked():
            self.blocked_acquire_entered.set()
        return await super().acquire()


class FakeWebSocket:
    def __init__(
        self,
        application: FastAPI,
        *,
        block_next_event: bool = False,
    ) -> None:
        self.scope = {"app": application}
        self.inbound: asyncio.Queue[object] = asyncio.Queue()
        self.outbound: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        self.accepted = asyncio.Event()
        self.closed = asyncio.Event()
        self.close_code: int | None = None
        self.close_reason: str | None = None
        self.block_next_event = block_next_event
        self.event_send_entered = asyncio.Event()
        self.release_event_send = asyncio.Event()
        self.active_sends = 0
        self.maximum_active_sends = 0

    async def accept(self) -> None:
        self.accepted.set()

    async def receive_text(self) -> str:
        value = await self.inbound.get()
        if value is _DISCONNECT:
            raise WebSocketDisconnect(code=1000)
        assert isinstance(value, tuple)
        raw, received = value
        assert isinstance(raw, str)
        assert isinstance(received, asyncio.Event)
        received.set()
        return raw

    async def send_json(self, value: dict[str, object]) -> None:
        self.active_sends += 1
        self.maximum_active_sends = max(
            self.maximum_active_sends,
            self.active_sends,
        )
        try:
            if self.block_next_event and "sequence" in value:
                self.block_next_event = False
                self.event_send_entered.set()
                await self.release_event_send.wait()
            await self.outbound.put(copy.deepcopy(value))
        finally:
            self.active_sends -= 1

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        self.active_sends += 1
        self.maximum_active_sends = max(
            self.maximum_active_sends,
            self.active_sends,
        )
        try:
            self.close_code = code
            self.close_reason = reason
            self.closed.set()
        finally:
            self.active_sends -= 1

    async def send_command(self, value: object) -> asyncio.Event:
        received = asyncio.Event()
        await self.inbound.put((json.dumps(value), received))
        return received

    async def send_raw(self, value: str) -> asyncio.Event:
        received = asyncio.Event()
        await self.inbound.put((value, received))
        return received

    async def disconnect(self) -> None:
        await self.inbound.put(_DISCONNECT)

    async def receive_frame(self) -> dict[str, object]:
        return await asyncio.wait_for(self.outbound.get(), timeout=1)

    async def wait_until_closed(self) -> None:
        await asyncio.wait_for(self.closed.wait(), timeout=1)


@asynccontextmanager
async def websocket_runtime(
    tmp_path: Path,
    *,
    subscriber_queue_size: int = 1000,
) -> AsyncIterator[tuple[FastAPI, TaskRepository, EventHub]]:
    repository = TaskRepository(tmp_path / "output")
    await repository.initialize()
    hub = EventHub(subscriber_queue_size=subscriber_queue_size)
    application = FastAPI()
    application.state.task_repository = repository
    application.state.event_hub = hub
    try:
        yield application, repository, hub
    finally:
        await hub.close()
        await repository.close()


def empty_snapshot(task_id: str) -> TaskSnapshot:
    return TaskSnapshot(
        task=TaskSummary(
            task_id=task_id,
            mode=TaskMode.AGENT,
            title=task_id,
            status=RunStatus.COMPLETED,
            created_at=NOW,
            updated_at=NOW,
        )
    )


def running_snapshot(task_id: str) -> TaskSnapshot:
    run_id = f"run_{task_id}"
    return TaskSnapshot(
        task=TaskSummary(
            task_id=task_id,
            mode=TaskMode.AGENT,
            title=task_id,
            status=RunStatus.RUNNING,
            active_run_id=run_id,
            created_at=NOW,
            updated_at=NOW,
        ),
        runs=[
            RunRecord(
                run_id=run_id,
                task_id=task_id,
                request_id=f"req_{task_id}",
                status=RunStatus.RUNNING,
                input=task_id,
                created_at=NOW,
                updated_at=NOW,
                started_at=NOW,
            )
        ],
    )


async def append_delta(
    repository: TaskRepository,
    task_id: str,
    sequence: int,
):
    event = build_event(
        task_id=task_id,
        run_id=f"run_{task_id}",
        sequence=sequence,
        timestamp=NOW,
        payload=AssistantDeltaPayload(delta=f"{task_id}:{sequence}"),
    )
    await repository.append_event(event)
    return event


async def start_socket(
    application: FastAPI,
    *,
    block_next_event: bool = False,
) -> tuple[FakeWebSocket, asyncio.Task[None]]:
    websocket = FakeWebSocket(
        application,
        block_next_event=block_next_event,
    )
    endpoint = asyncio.create_task(ws_module.agent_ws(websocket))
    await asyncio.wait_for(websocket.accepted.wait(), timeout=1)
    return websocket, endpoint


async def start_event_socket(
    application: FastAPI,
    send_lock: ObservedLock,
    first_message: object,
) -> tuple[FakeWebSocket, asyncio.Task[None]]:
    websocket = FakeWebSocket(application)
    endpoint = asyncio.create_task(
        ws_events_module._run_event_session(
            websocket,
            send_lock,
            first_message,
        )
    )
    return websocket, endpoint


async def stop_socket(
    websocket: FakeWebSocket,
    endpoint: asyncio.Task[None],
) -> None:
    if not endpoint.done():
        await websocket.disconnect()
    try:
        await asyncio.wait_for(endpoint, timeout=1)
    except TimeoutError:
        endpoint.cancel()
        await asyncio.gather(endpoint, return_exceptions=True)


@pytest.mark.asyncio
async def test_event_session_ping_is_fifo_and_run_is_rejected(tmp_path: Path) -> None:
    async with websocket_runtime(tmp_path) as (application, _, hub):
        websocket, endpoint = await start_socket(application)
        try:
            await websocket.send_command({"type": "ping"})
            assert await websocket.receive_frame() == {"type": "pong"}

            await websocket.send_command({"type": "run", "input": "legacy"})
            assert await websocket.receive_frame() == {
                "type": "error",
                "code": "unsupported_command",
                "message": "Unsupported WebSocket command",
            }

            await websocket.send_command({"type": "ping"})
            assert await websocket.receive_frame() == {"type": "pong"}
        finally:
            await stop_socket(websocket, endpoint)

        assert hub.subscriber_count == 0


@pytest.mark.asyncio
async def test_event_session_rejects_invalid_commands_strictly(
    tmp_path: Path,
) -> None:
    invalid_commands = [
        [],
        {"type": "subscribe", "task_id": "task_valid"},
        {
            "type": "subscribe",
            "task_id": "task_valid",
            "after_sequence": 0,
            "extra": True,
        },
        {
            "type": "subscribe",
            "task_id": "task_valid",
            "after_sequence": True,
        },
        {
            "type": "subscribe",
            "task_id": "task_valid",
            "after_sequence": "0",
        },
        {
            "type": "subscribe",
            "task_id": "task_valid",
            "after_sequence": -1,
        },
        {
            "type": "subscribe",
            "task_id": "../unsafe",
            "after_sequence": 0,
        },
        {"type": "unknown"},
    ]
    expected = {
        "type": "error",
        "code": "invalid_command",
        "message": "Invalid WebSocket command",
    }

    async with websocket_runtime(tmp_path) as (application, _, _):
        websocket, endpoint = await start_socket(application)
        try:
            for command in invalid_commands:
                await websocket.send_command(command)
                assert await websocket.receive_frame() == expected

            await websocket.send_command({"type": "ping"})
            assert await websocket.receive_frame() == {"type": "pong"}
        finally:
            await stop_socket(websocket, endpoint)


@pytest.mark.asyncio
async def test_event_session_reports_missing_task_without_closing(
    tmp_path: Path,
) -> None:
    async with websocket_runtime(tmp_path) as (application, _, _):
        websocket, endpoint = await start_socket(application)
        try:
            await websocket.send_command(
                {
                    "type": "subscribe",
                    "task_id": "task_missing",
                    "after_sequence": 0,
                }
            )
            assert await websocket.receive_frame() == {
                "type": "error",
                "code": "task_not_found",
                "message": "Task not found",
                "task_id": "task_missing",
            }

            await websocket.send_command({"type": "ping"})
            assert await websocket.receive_frame() == {"type": "pong"}
        finally:
            await stop_socket(websocket, endpoint)


@pytest.mark.asyncio
async def test_invalid_json_before_mode_selection_preserves_legacy_run(
    tmp_path: Path,
    monkeypatch,
) -> None:
    observed: list[tuple[str, str, object]] = []

    async def fake_stream(user_input: str, task_id: str, databases=None):
        observed.append((user_input, task_id, databases))
        yield {"type": "done", "final_output": user_input}

    monkeypatch.setattr(ws_module, "run_agent_stream", fake_stream)
    async with websocket_runtime(tmp_path) as (application, _, hub):
        websocket, endpoint = await start_socket(application)
        try:
            await websocket.send_raw("{")
            assert await websocket.receive_frame() == {
                "type": "error",
                "code": "invalid_json",
                "message": "Invalid JSON",
            }

            await websocket.send_command(
                {
                    "type": "run",
                    "input": "legacy input",
                    "task_id": "task_legacy",
                    "databases": ["pubmed", "geo"],
                }
            )
            assert await websocket.receive_frame() == {
                "type": "task_started",
                "task_id": "task_legacy",
            }
            assert await websocket.receive_frame() == {
                "type": "done",
                "final_output": "legacy input",
            }
        finally:
            await stop_socket(websocket, endpoint)

        assert observed == [
            ("legacy input", "task_legacy", ["pubmed", "geo"]),
        ]
        assert hub.subscriber_count == 0


@pytest.mark.asyncio
async def test_subscribe_replays_raw_events_for_multiple_tasks(
    tmp_path: Path,
) -> None:
    async with websocket_runtime(tmp_path) as (application, repository, _):
        task_events: dict[str, list[object]] = {}
        for task_id, count in (("task_first", 3), ("task_second", 2)):
            await repository.save_snapshot(running_snapshot(task_id))
            task_events[task_id] = [
                await append_delta(repository, task_id, sequence)
                for sequence in range(1, count + 1)
            ]

        websocket, endpoint = await start_socket(application)
        try:
            await websocket.send_command(
                {
                    "type": "subscribe",
                    "task_id": "task_first",
                    "after_sequence": 1,
                }
            )
            first_frames = [
                await websocket.receive_frame(),
                await websocket.receive_frame(),
            ]
            assert first_frames == [
                event.model_dump(mode="json") for event in task_events["task_first"][1:]
            ]

            await websocket.send_command(
                {
                    "type": "subscribe",
                    "task_id": "task_second",
                    "after_sequence": 0,
                }
            )
            second_frames = [
                await websocket.receive_frame(),
                await websocket.receive_frame(),
            ]
            assert second_frames == [
                event.model_dump(mode="json") for event in task_events["task_second"]
            ]

            await websocket.send_command({"type": "ping"})
            assert await websocket.receive_frame() == {"type": "pong"}
        finally:
            await stop_socket(websocket, endpoint)


@pytest.mark.asyncio
async def test_repeated_subscribe_never_rewinds_a_task_watermark(
    tmp_path: Path,
) -> None:
    async with websocket_runtime(tmp_path) as (application, repository, hub):
        task_id = "task_repeat"
        await repository.save_snapshot(running_snapshot(task_id))
        events = [
            await append_delta(repository, task_id, sequence)
            for sequence in range(1, 4)
        ]
        websocket, endpoint = await start_socket(application)
        try:
            await websocket.send_command(
                {
                    "type": "subscribe",
                    "task_id": task_id,
                    "after_sequence": 1,
                }
            )
            assert await websocket.receive_frame() == events[1].model_dump(mode="json")
            assert await websocket.receive_frame() == events[2].model_dump(mode="json")

            await websocket.send_command(
                {
                    "type": "subscribe",
                    "task_id": task_id,
                    "after_sequence": 0,
                }
            )
            await websocket.send_command({"type": "ping"})
            assert await websocket.receive_frame() == {"type": "pong"}

            await websocket.send_command(
                {
                    "type": "subscribe",
                    "task_id": task_id,
                    "after_sequence": 5,
                }
            )
            await websocket.send_command({"type": "ping"})
            assert await websocket.receive_frame() == {"type": "pong"}

            await websocket.send_command(
                {
                    "type": "subscribe",
                    "task_id": task_id,
                    "after_sequence": 2,
                }
            )
            await websocket.send_command({"type": "ping"})
            assert await websocket.receive_frame() == {"type": "pong"}

            fourth = await append_delta(repository, task_id, 4)
            await hub.publish(fourth)
            await websocket.send_command({"type": "ping"})
            assert await websocket.receive_frame() == {"type": "pong"}
        finally:
            await stop_socket(websocket, endpoint)


@pytest.mark.asyncio
async def test_unsubscribe_ping_barrier_drops_already_queued_events(
    tmp_path: Path,
) -> None:
    async with websocket_runtime(tmp_path) as (application, repository, hub):
        task_id = "task_unsubscribe"
        await repository.save_snapshot(running_snapshot(task_id))
        websocket, endpoint = await start_socket(application)
        try:
            await websocket.send_command(
                {
                    "type": "subscribe",
                    "task_id": task_id,
                    "after_sequence": 0,
                }
            )
            await websocket.send_command({"type": "ping"})
            assert await websocket.receive_frame() == {"type": "pong"}

            websocket.block_next_event = True
            first = await append_delta(repository, task_id, 1)
            await hub.publish(first)
            await asyncio.wait_for(websocket.event_send_entered.wait(), timeout=1)

            for sequence in (2, 3):
                event = await append_delta(repository, task_id, sequence)
                await hub.publish(event)

            unsubscribe_received = await websocket.send_command(
                {"type": "unsubscribe", "task_id": task_id}
            )
            await asyncio.wait_for(unsubscribe_received.wait(), timeout=1)
            await websocket.send_command({"type": "ping"})
            websocket.release_event_send.set()

            assert await websocket.receive_frame() == first.model_dump(mode="json")
            assert await websocket.receive_frame() == {"type": "pong"}

            fourth = await append_delta(repository, task_id, 4)
            await hub.publish(fourth)
            await websocket.send_command({"type": "ping"})
            assert await websocket.receive_frame() == {"type": "pong"}
        finally:
            websocket.release_event_send.set()
            await stop_socket(websocket, endpoint)


@pytest.mark.asyncio
async def test_snapshot_to_subscribe_handoff_has_no_gap_or_duplicate(
    tmp_path: Path,
    monkeypatch,
) -> None:
    async with websocket_runtime(tmp_path) as (application, repository, hub):
        task_id = "task_handoff"
        await repository.save_snapshot(running_snapshot(task_id))
        await append_delta(repository, task_id, 1)
        snapshot = await repository.get_snapshot(task_id)
        assert snapshot is not None
        assert snapshot.task.latest_sequence == 1

        replay_entered = asyncio.Event()
        release_replay = asyncio.Event()
        real_list_events = repository.list_events

        async def gated_list_events(*args, **kwargs):
            replay_entered.set()
            await release_replay.wait()
            return await real_list_events(*args, **kwargs)

        monkeypatch.setattr(repository, "list_events", gated_list_events)
        websocket, endpoint = await start_socket(application)
        try:
            await websocket.send_command(
                {
                    "type": "subscribe",
                    "task_id": task_id,
                    "after_sequence": snapshot.task.latest_sequence,
                }
            )
            await asyncio.wait_for(replay_entered.wait(), timeout=1)
            subscription = next(iter(hub._subscribers))
            assert subscription.task_ids == frozenset({task_id})

            second = await append_delta(repository, task_id, 2)
            await hub.publish(second)
            release_replay.set()
            first_frame = await websocket.receive_frame()

            third = await append_delta(repository, task_id, 3)
            await hub.publish(third)
            second_frame = await websocket.receive_frame()
            await websocket.send_command({"type": "ping"})
            assert await websocket.receive_frame() == {"type": "pong"}

            assert [first_frame, second_frame] == [
                second.model_dump(mode="json"),
                third.model_dump(mode="json"),
            ]
        finally:
            release_replay.set()
            await stop_socket(websocket, endpoint)


@pytest.mark.asyncio
async def test_connection_serializes_live_events_controls_and_close(
    tmp_path: Path,
) -> None:
    async with websocket_runtime(tmp_path) as (application, repository, hub):
        task_id = "task_serial_send"
        await repository.save_snapshot(running_snapshot(task_id))
        websocket, endpoint = await start_socket(application)
        try:
            await websocket.send_command(
                {
                    "type": "subscribe",
                    "task_id": task_id,
                    "after_sequence": 0,
                }
            )
            await websocket.send_command({"type": "ping"})
            assert await websocket.receive_frame() == {"type": "pong"}

            websocket.block_next_event = True
            event = await append_delta(repository, task_id, 1)
            await hub.publish(event)
            await asyncio.wait_for(websocket.event_send_entered.wait(), timeout=1)

            ping_received = await websocket.send_command({"type": "ping"})
            await asyncio.wait_for(ping_received.wait(), timeout=1)
            assert websocket.active_sends == 1
            assert websocket.maximum_active_sends == 1

            websocket.release_event_send.set()
            assert await websocket.receive_frame() == event.model_dump(mode="json")
            assert await websocket.receive_frame() == {"type": "pong"}
            assert websocket.maximum_active_sends == 1
        finally:
            websocket.release_event_send.set()
            await stop_socket(websocket, endpoint)


@pytest.mark.parametrize("command_type", ["subscribe", "unsubscribe"])
@pytest.mark.asyncio
async def test_queued_control_command_preserves_overflow_close(
    tmp_path: Path,
    command_type: str,
) -> None:
    async with websocket_runtime(
        tmp_path,
        subscriber_queue_size=1,
    ) as (application, repository, hub):
        active_task_id = "task_overflow_control"
        target_task_id = (
            "task_overflow_target" if command_type == "subscribe" else active_task_id
        )
        await repository.save_snapshot(running_snapshot(active_task_id))
        if target_task_id != active_task_id:
            await repository.save_snapshot(running_snapshot(target_task_id))

        send_lock = ObservedLock()
        websocket, endpoint = await start_event_socket(
            application,
            send_lock,
            {
                "type": "subscribe",
                "task_id": active_task_id,
                "after_sequence": 0,
            },
        )
        try:
            await websocket.send_command({"type": "ping"})
            assert await websocket.receive_frame() == {"type": "pong"}

            websocket.block_next_event = True
            first = await append_delta(repository, active_task_id, 1)
            await hub.publish(first)
            await asyncio.wait_for(websocket.event_send_entered.wait(), timeout=1)

            command: dict[str, object]
            if command_type == "subscribe":
                command = {
                    "type": "subscribe",
                    "task_id": target_task_id,
                    "after_sequence": 0,
                }
            else:
                command = {
                    "type": "unsubscribe",
                    "task_id": target_task_id,
                }
            command_received = await websocket.send_command(command)
            await asyncio.wait_for(command_received.wait(), timeout=1)
            await asyncio.wait_for(
                send_lock.blocked_acquire_entered.wait(),
                timeout=1,
            )

            for sequence in (2, 3):
                event = await append_delta(repository, active_task_id, sequence)
                await hub.publish(event)
            assert hub.subscriber_count == 0

            websocket.release_event_send.set()
            await websocket.wait_until_closed()
            await asyncio.wait_for(endpoint, timeout=1)

            frames = []
            while not websocket.outbound.empty():
                frames.append(websocket.outbound.get_nowait())
            assert websocket.close_code == 1013
            assert all(frame.get("code") != "internal_error" for frame in frames)
        finally:
            websocket.release_event_send.set()
            await stop_socket(websocket, endpoint)


@pytest.mark.parametrize("command_type", ["subscribe", "unsubscribe"])
@pytest.mark.asyncio
async def test_queued_control_command_preserves_hub_shutdown_close(
    tmp_path: Path,
    command_type: str,
) -> None:
    async with websocket_runtime(tmp_path) as (application, repository, hub):
        active_task_id = "task_shutdown_control"
        target_task_id = (
            "task_shutdown_target" if command_type == "subscribe" else active_task_id
        )
        await repository.save_snapshot(running_snapshot(active_task_id))
        if target_task_id != active_task_id:
            await repository.save_snapshot(running_snapshot(target_task_id))

        send_lock = ObservedLock()
        websocket, endpoint = await start_event_socket(
            application,
            send_lock,
            {
                "type": "subscribe",
                "task_id": active_task_id,
                "after_sequence": 0,
            },
        )
        try:
            await websocket.send_command({"type": "ping"})
            assert await websocket.receive_frame() == {"type": "pong"}

            websocket.block_next_event = True
            first = await append_delta(repository, active_task_id, 1)
            await hub.publish(first)
            await asyncio.wait_for(websocket.event_send_entered.wait(), timeout=1)

            command: dict[str, object]
            if command_type == "subscribe":
                command = {
                    "type": "subscribe",
                    "task_id": target_task_id,
                    "after_sequence": 0,
                }
            else:
                command = {
                    "type": "unsubscribe",
                    "task_id": target_task_id,
                }
            command_received = await websocket.send_command(command)
            await asyncio.wait_for(command_received.wait(), timeout=1)
            await asyncio.wait_for(
                send_lock.blocked_acquire_entered.wait(),
                timeout=1,
            )

            await hub.close()
            websocket.release_event_send.set()
            await websocket.wait_until_closed()
            await asyncio.wait_for(endpoint, timeout=1)

            frames = []
            while not websocket.outbound.empty():
                frames.append(websocket.outbound.get_nowait())
            assert websocket.close_code == 1012
            assert all(frame.get("code") != "internal_error" for frame in frames)
        finally:
            websocket.release_event_send.set()
            await stop_socket(websocket, endpoint)


@pytest.mark.asyncio
async def test_disconnect_does_not_cancel_an_active_manager_run(tmp_path: Path) -> None:
    repository = TaskRepository(tmp_path / "output")
    hub = EventHub()
    executor_started = asyncio.Event()
    release_executor = asyncio.Event()
    execution_seen = None

    async def run(execution) -> None:
        nonlocal execution_seen
        execution_seen = execution
        executor_started.set()
        await release_executor.wait()

    manager = TaskManager(repository, run_executor=run, event_hub=hub)
    await manager.start()
    application = FastAPI()
    application.state.task_repository = repository
    application.state.event_hub = hub
    application.state.task_manager = manager
    websocket = None
    endpoint = None
    try:
        accepted = await manager.create_task(
            StartTaskRequest(request_id="req_disconnect", input="keep running")
        )
        await asyncio.wait_for(executor_started.wait(), timeout=1)

        websocket, endpoint = await start_socket(application)
        await websocket.send_command(
            {
                "type": "subscribe",
                "task_id": accepted.task_id,
                "after_sequence": 0,
            }
        )
        replay = [await websocket.receive_frame(), await websocket.receive_frame()]
        assert [frame["sequence"] for frame in replay] == [1, 2]

        await websocket.disconnect()
        await asyncio.wait_for(endpoint, timeout=1)
        assert hub.subscriber_count == 0
        assert execution_seen is not None
        assert not execution_seen.context.cancellation_requested.is_set()

        release_executor.set()
        await manager.wait_until_idle()
        completed = await repository.get_snapshot(accepted.task_id)
        assert completed is not None
        assert completed.task.status is RunStatus.COMPLETED
        events = await repository.list_events(accepted.task_id)
        assert isinstance(events[-1].payload, RunCompletedPayload)
    finally:
        release_executor.set()
        if websocket is not None and endpoint is not None:
            await stop_socket(websocket, endpoint)
        await manager.close()
        await hub.close()


@pytest.mark.asyncio
async def test_slow_consumer_closes_1013_and_replays_the_suffix_once(
    tmp_path: Path,
) -> None:
    async with websocket_runtime(
        tmp_path,
        subscriber_queue_size=1,
    ) as (application, repository, hub):
        task_id = "task_overflow"
        await repository.save_snapshot(running_snapshot(task_id))
        first = await append_delta(repository, task_id, 1)
        websocket, endpoint = await start_socket(
            application,
            block_next_event=True,
        )
        try:
            await websocket.send_command(
                {
                    "type": "subscribe",
                    "task_id": task_id,
                    "after_sequence": 0,
                }
            )
            await asyncio.wait_for(websocket.event_send_entered.wait(), timeout=1)

            later_events = []
            for sequence in (2, 3, 4):
                event = await append_delta(repository, task_id, sequence)
                later_events.append(event)
                await hub.publish(event)

            websocket.release_event_send.set()
            await websocket.wait_until_closed()
            await asyncio.wait_for(endpoint, timeout=1)
            assert websocket.close_code == 1013
            assert websocket.close_reason == "subscriber overflow; reconnect and replay"
            assert websocket.maximum_active_sends == 1

            first_connection_frames = []
            while not websocket.outbound.empty():
                first_connection_frames.append(websocket.outbound.get_nowait())
            assert first_connection_frames[0] == first.model_dump(mode="json")
            last_received = max(
                int(frame["sequence"]) for frame in first_connection_frames
            )

            reconnected, reconnect_endpoint = await start_socket(application)
            try:
                await reconnected.send_command(
                    {
                        "type": "subscribe",
                        "task_id": task_id,
                        "after_sequence": last_received,
                    }
                )
                recovered = [
                    await reconnected.receive_frame() for _ in range(4 - last_received)
                ]
                await reconnected.send_command({"type": "ping"})
                assert await reconnected.receive_frame() == {"type": "pong"}

                combined_sequences = [
                    int(frame["sequence"])
                    for frame in [*first_connection_frames, *recovered]
                ]
                assert combined_sequences == [1, 2, 3, 4]
                assert reconnected.maximum_active_sends == 1
            finally:
                await stop_socket(reconnected, reconnect_endpoint)
        finally:
            websocket.release_event_send.set()
            await stop_socket(websocket, endpoint)


@pytest.mark.asyncio
async def test_hub_shutdown_closes_event_session_with_1012(tmp_path: Path) -> None:
    async with websocket_runtime(tmp_path) as (application, _, hub):
        websocket, endpoint = await start_socket(application)
        try:
            await websocket.send_command({"type": "ping"})
            assert await websocket.receive_frame() == {"type": "pong"}
            assert hub.subscriber_count == 1

            await hub.close()
            await websocket.wait_until_closed()
            await asyncio.wait_for(endpoint, timeout=1)
            assert websocket.close_code == 1012
            assert websocket.maximum_active_sends == 1
            assert hub.subscriber_count == 0
        finally:
            await stop_socket(websocket, endpoint)


@pytest.mark.asyncio
async def test_unexpected_event_adapter_failure_is_stable_and_closes_1011(
    tmp_path: Path,
    monkeypatch,
) -> None:
    async with websocket_runtime(tmp_path) as (application, repository, hub):

        async def fail_snapshot(_task_id: str):
            raise RuntimeError("sensitive internal detail")

        monkeypatch.setattr(repository, "get_snapshot", fail_snapshot)
        websocket, endpoint = await start_socket(application)
        try:
            await websocket.send_command(
                {
                    "type": "subscribe",
                    "task_id": "task_failure",
                    "after_sequence": 0,
                }
            )
            assert await websocket.receive_frame() == {
                "type": "error",
                "code": "internal_error",
                "message": "WebSocket adapter failed",
            }
            await websocket.wait_until_closed()
            await asyncio.wait_for(endpoint, timeout=1)
            assert websocket.close_code == 1011
            assert websocket.maximum_active_sends == 1
            assert hub.subscriber_count == 0
        finally:
            await stop_socket(websocket, endpoint)


@pytest.mark.asyncio
async def test_legacy_session_closes_on_event_protocol_mixing(
    tmp_path: Path,
    monkeypatch,
) -> None:
    async def fake_stream(user_input: str, task_id: str, databases=None):
        yield {"type": "done", "final_output": user_input}

    monkeypatch.setattr(ws_module, "run_agent_stream", fake_stream)
    async with websocket_runtime(tmp_path) as (application, _, hub):
        websocket, endpoint = await start_socket(application)
        try:
            await websocket.send_command(
                {"type": "run", "input": "legacy", "task_id": "task_legacy"}
            )
            assert (await websocket.receive_frame())["type"] == "task_started"
            assert await websocket.receive_frame() == {
                "type": "done",
                "final_output": "legacy",
            }

            await websocket.send_command({"type": "ping"})
            await websocket.wait_until_closed()
            assert websocket.close_code == 1008
        finally:
            await stop_socket(websocket, endpoint)

        assert hub.subscriber_count == 0
