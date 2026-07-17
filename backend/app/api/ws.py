"""Durable event WebSocket endpoint."""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.api.ws_events import (
    _run_event_session,
    _send_internal_error_and_close,
)

router = APIRouter()
logger = logging.getLogger(__name__)


@router.websocket("/api/v1/ws")
async def agent_ws(websocket: WebSocket) -> None:
    """Serve one durable-event WebSocket session."""
    await websocket.accept()
    send_lock = asyncio.Lock()
    try:
        await _run_event_session(websocket, send_lock)
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("WebSocket adapter failed before session startup")
        await _send_internal_error_and_close(websocket, send_lock)
