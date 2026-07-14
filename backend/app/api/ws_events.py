"""Replayable durable-event WebSocket session adapter."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Literal

from fastapi import WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from app.domain.contracts import EventEnvelope
from app.runtime.hub import (
    EventHub,
    EventSubscription,
    SubscriberOverflowError,
    SubscriptionClosedError,
)
from app.runtime.repository import TaskRepository


logger = logging.getLogger(__name__)
_NO_MESSAGE = object()

_INVALID_JSON = {
    "type": "error",
    "code": "invalid_json",
    "message": "Invalid JSON",
}
_INVALID_COMMAND = {
    "type": "error",
    "code": "invalid_command",
    "message": "Invalid WebSocket command",
}
_UNSUPPORTED_COMMAND = {
    "type": "error",
    "code": "unsupported_command",
    "message": "Unsupported WebSocket command",
}
_INTERNAL_ERROR = {
    "type": "error",
    "code": "internal_error",
    "message": "WebSocket adapter failed",
}


class _CommandModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _TaskCommand(_CommandModel):
    task_id: str = Field(min_length=1, max_length=128)

    @field_validator("task_id")
    @classmethod
    def validate_task_id(cls, value: str) -> str:
        if re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value) is None:
            raise ValueError("task_id must be a safe path component")
        return value


class _SubscribeCommand(_TaskCommand):
    type: Literal["subscribe"]
    after_sequence: int = Field(ge=0)


class _UnsubscribeCommand(_TaskCommand):
    type: Literal["unsubscribe"]


class _PingCommand(_CommandModel):
    type: Literal["ping"]


_EventCommand = _SubscribeCommand | _UnsubscribeCommand | _PingCommand


class _SessionEnd(Enum):
    CLIENT_DISCONNECT = auto()
    SUBSCRIBER_OVERFLOW = auto()
    HUB_SHUTDOWN = auto()


@dataclass
class _EventConnection:
    websocket: WebSocket
    repository: TaskRepository
    subscription: EventSubscription
    send_lock: asyncio.Lock
    active_task_ids: set[str] = field(default_factory=set)
    last_sent: dict[str, int] = field(default_factory=dict)


async def _run_event_session(
    websocket: WebSocket,
    send_lock: asyncio.Lock,
    first_message: object,
) -> None:
    application = websocket.scope["app"]
    repository: TaskRepository = application.state.task_repository
    hub: EventHub = application.state.event_hub
    subscription = await hub.subscribe()
    connection = _EventConnection(
        websocket=websocket,
        repository=repository,
        subscription=subscription,
        send_lock=send_lock,
    )
    receiver = asyncio.create_task(
        _receive_event_commands(connection, first_message),
        name="task-event-ws-receiver",
    )
    sender = asyncio.create_task(
        _send_live_events(connection),
        name="task-event-ws-sender",
    )
    tasks = (receiver, sender)
    outcomes: list[_SessionEnd] = []
    failure: Exception | None = None
    try:
        done, pending = await asyncio.wait(
            tasks,
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in done:
            try:
                outcomes.append(task.result())
            except asyncio.CancelledError:
                raise
            except Exception as error:
                failure = error
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await subscription.close()

    if _SessionEnd.CLIENT_DISCONNECT in outcomes:
        return
    if _SessionEnd.SUBSCRIBER_OVERFLOW in outcomes:
        await _close_websocket(
            websocket,
            send_lock,
            code=1013,
            reason="subscriber overflow; reconnect and replay",
        )
        return
    if _SessionEnd.HUB_SHUTDOWN in outcomes:
        await _close_websocket(
            websocket,
            send_lock,
            code=1012,
            reason="event hub shutdown",
        )
        return
    if failure is not None:
        logger.error(
            "Durable event WebSocket session failed",
            exc_info=(type(failure), failure, failure.__traceback__),
        )
        await _send_internal_error_and_close(websocket, send_lock)


async def _receive_event_commands(
    connection: _EventConnection,
    first_message: object,
) -> _SessionEnd:
    message: object = first_message
    try:
        while True:
            if message is _NO_MESSAGE:
                raw = await connection.websocket.receive_text()
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    await _send_control(connection, _INVALID_JSON)
                    continue

            if isinstance(message, dict) and message.get("type") == "run":
                await _send_control(connection, _UNSUPPORTED_COMMAND)
                message = _NO_MESSAGE
                continue

            command = _parse_event_command(message)
            if command is None:
                await _send_control(connection, _INVALID_COMMAND)
            elif isinstance(command, _PingCommand):
                await _send_control(connection, {"type": "pong"})
            elif isinstance(command, _SubscribeCommand):
                outcome = await _subscribe(connection, command)
                if outcome is not None:
                    return outcome
            else:
                outcome = await _unsubscribe(connection, command.task_id)
                if outcome is not None:
                    return outcome
            message = _NO_MESSAGE
    except WebSocketDisconnect:
        return _SessionEnd.CLIENT_DISCONNECT


def _parse_event_command(message: object) -> _EventCommand | None:
    if not isinstance(message, dict):
        return None
    command_type = message.get("type")
    model: type[_EventCommand]
    if command_type == "subscribe":
        model = _SubscribeCommand
    elif command_type == "unsubscribe":
        model = _UnsubscribeCommand
    elif command_type == "ping":
        model = _PingCommand
    else:
        return None
    try:
        return model.model_validate(message)
    except ValidationError:
        return None


async def _subscribe(
    connection: _EventConnection,
    command: _SubscribeCommand,
) -> _SessionEnd | None:
    snapshot = await connection.repository.get_snapshot(command.task_id)
    if snapshot is None:
        await _send_control(
            connection,
            {
                "type": "error",
                "code": "task_not_found",
                "message": "Task not found",
                "task_id": command.task_id,
            },
        )
        return

    async with connection.send_lock:
        try:
            await connection.subscription.subscribe_task(command.task_id)
        except SubscriptionClosedError:
            return _closed_subscription_end(connection.subscription)
        connection.active_task_ids.add(command.task_id)
        watermark = max(
            connection.last_sent.get(command.task_id, 0),
            command.after_sequence,
        )
        connection.last_sent[command.task_id] = watermark
        events = await connection.repository.list_events(
            command.task_id,
            after_sequence=watermark,
        )
        for event in events:
            if event.sequence <= connection.last_sent[command.task_id]:
                continue
            await _send_event_locked(connection, event)
    return None


async def _unsubscribe(
    connection: _EventConnection,
    task_id: str,
) -> _SessionEnd | None:
    async with connection.send_lock:
        try:
            await connection.subscription.unsubscribe_task(task_id)
        except SubscriptionClosedError:
            return _closed_subscription_end(connection.subscription)
        connection.active_task_ids.discard(task_id)
    return None


def _closed_subscription_end(subscription: EventSubscription) -> _SessionEnd:
    if subscription.overflowed:
        return _SessionEnd.SUBSCRIBER_OVERFLOW
    return _SessionEnd.HUB_SHUTDOWN


async def _send_live_events(connection: _EventConnection) -> _SessionEnd:
    while True:
        try:
            event = await connection.subscription.receive()
        except SubscriberOverflowError:
            return _SessionEnd.SUBSCRIBER_OVERFLOW
        except SubscriptionClosedError:
            return _SessionEnd.HUB_SHUTDOWN

        try:
            async with connection.send_lock:
                if event.task_id not in connection.active_task_ids:
                    continue
                if event.sequence <= connection.last_sent.get(event.task_id, 0):
                    continue
                await _send_event_locked(connection, event)
        except WebSocketDisconnect:
            return _SessionEnd.CLIENT_DISCONNECT


async def _send_event_locked(
    connection: _EventConnection,
    event: EventEnvelope,
) -> None:
    await connection.websocket.send_json(event.model_dump(mode="json"))
    connection.last_sent[event.task_id] = event.sequence


async def _send_control(
    connection: _EventConnection,
    value: dict[str, object],
) -> None:
    await _send_json(connection.websocket, connection.send_lock, value)


async def _send_json(
    websocket: WebSocket,
    send_lock: asyncio.Lock,
    value: dict[str, object],
) -> None:
    async with send_lock:
        await websocket.send_json(value)


async def _close_websocket(
    websocket: WebSocket,
    send_lock: asyncio.Lock,
    *,
    code: int,
    reason: str,
) -> None:
    try:
        async with send_lock:
            await websocket.close(code=code, reason=reason)
    except asyncio.CancelledError:
        raise
    except Exception:
        pass


async def _send_internal_error_and_close(
    websocket: WebSocket,
    send_lock: asyncio.Lock,
) -> None:
    async with send_lock:
        try:
            await websocket.send_json(_INTERNAL_ERROR)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        try:
            await websocket.close(code=1011, reason="internal error")
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
