"""WebSocket mode selection and temporary legacy Agent streaming."""

from __future__ import annotations

import asyncio
import json
import logging
import re

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.agent_loop.runner import run_agent_stream
from app.api.ws_events import (
    _INVALID_JSON,
    _run_event_session,
    _send_internal_error_and_close,
)
from app.domain.contracts import generate_prefixed_uuid


router = APIRouter()
logger = logging.getLogger(__name__)

_EVENT_COMMAND_TYPES = frozenset({"subscribe", "unsubscribe", "ping"})


@router.websocket("/api/v1/ws")
async def agent_ws(websocket: WebSocket) -> None:
    """Select an isolated legacy or durable-event session from the first frame."""

    await websocket.accept()
    send_lock = asyncio.Lock()
    try:
        first_message = await _receive_mode_message(websocket, send_lock)
        if _is_legacy_run(first_message):
            await _run_legacy_session(websocket, send_lock, first_message)
        else:
            await _run_event_session(websocket, send_lock, first_message)
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("WebSocket adapter failed before session startup")
        await _send_internal_error_and_close(websocket, send_lock)


async def _receive_mode_message(
    websocket: WebSocket,
    send_lock: asyncio.Lock,
) -> object:
    while True:
        raw = await websocket.receive_text()
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            await _send_json(websocket, send_lock, _INVALID_JSON)


def _is_legacy_run(message: object) -> bool:
    return isinstance(message, dict) and message.get("type") == "run"


async def _run_legacy_session(
    websocket: WebSocket,
    send_lock: asyncio.Lock,
    first_message: object,
) -> None:
    """Preserve the current frontend's legacy-only inline streaming protocol."""

    message: object = first_message
    try:
        while True:
            if (
                isinstance(message, dict)
                and message.get("type") in _EVENT_COMMAND_TYPES
            ):
                await _close_websocket(
                    websocket,
                    send_lock,
                    code=1008,
                    reason="WebSocket protocol mode cannot be changed",
                )
                return
            if not isinstance(message, dict):
                raise TypeError("WebSocket command must be a JSON object")
            if message.get("type") == "run":
                await _run_legacy_command(websocket, send_lock, message)
            message = await _receive_legacy_message(websocket, send_lock)
    except WebSocketDisconnect:
        logger.info("Legacy WebSocket client disconnected")
    except asyncio.CancelledError:
        raise
    except Exception as error:
        logger.exception("Legacy WebSocket session failed")
        try:
            await _send_json(
                websocket,
                send_lock,
                {"type": "error", "message": str(error)},
            )
        except Exception:
            pass


async def _run_legacy_command(
    websocket: WebSocket,
    send_lock: asyncio.Lock,
    message: dict[str, object],
) -> None:
    user_input = message.get("input", "").strip()
    if not user_input:
        await _send_json(
            websocket,
            send_lock,
            {"type": "error", "message": "输入为空"},
        )
        return

    task_id = message.get("task_id") or generate_prefixed_uuid("task")
    if (
        not isinstance(task_id, str)
        or re.fullmatch(
            r"[A-Za-z0-9_-]{1,128}",
            task_id,
        )
        is None
    ):
        await _send_json(
            websocket,
            send_lock,
            {"type": "error", "message": "无效 task_id"},
        )
        return

    await _send_json(
        websocket,
        send_lock,
        {"type": "task_started", "task_id": task_id},
    )
    async for event in run_agent_stream(
        user_input,
        task_id,
        databases=message.get("databases", None),
    ):
        await _send_json(websocket, send_lock, event)


async def _receive_legacy_message(
    websocket: WebSocket,
    send_lock: asyncio.Lock,
) -> object:
    while True:
        raw = await websocket.receive_text()
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            await _send_json(
                websocket,
                send_lock,
                {"type": "error", "message": "无效 JSON"},
            )


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
