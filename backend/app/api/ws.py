"""WebSocket 端点 — 接收用户输入，流式推送 Agent loop 事件。"""

from __future__ import annotations

import json
import logging
import re

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.agent_loop.runner import run_agent_stream
from app.domain.contracts import generate_prefixed_uuid

router = APIRouter()
logger = logging.getLogger(__name__)


@router.websocket("/api/v1/ws")
async def agent_ws(websocket: WebSocket) -> None:
    """Agent loop WebSocket 端点。

    客户端 → 服务端消息格式：
        {"type": "run", "input": "研究目标文本", "task_id": "optional-task-id", "databases": ["geo", "gdc"]}

    服务端 → 客户端事件格式：
        {"type": "skill_loaded", "name": "...", "category": "..."}
        {"type": "text", "delta": "..."}
        {"type": "tool_call", "name": "...", "arguments": "..."}
        {"type": "tool_output", "output": "..."}
        {"type": "done", "final_output": "..."}
        {"type": "file_downloaded", "name": "...", "path": "...", "size": N}
        {"type": "artifact_produced", "name": "...", "path": "...", "size": N}
        {"type": "error", "message": "..."}
    """
    await websocket.accept()
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "message": "无效 JSON"})
                continue

            if msg.get("type") != "run":
                continue

            user_input = msg.get("input", "").strip()
            if not user_input:
                await websocket.send_json({"type": "error", "message": "输入为空"})
                continue

            task_id = msg.get("task_id") or generate_prefixed_uuid("task")
            if not isinstance(task_id, str) or not re.fullmatch(
                r"[A-Za-z0-9_-]{1,128}", task_id
            ):
                await websocket.send_json({"type": "error", "message": "无效 task_id"})
                continue
            databases = msg.get("databases", None)
            await websocket.send_json({"type": "task_started", "task_id": task_id})
            async for event in run_agent_stream(
                user_input, task_id, databases=databases
            ):
                await websocket.send_json(event)

    except WebSocketDisconnect:
        logger.info("WebSocket 客户端断开")
    except Exception as e:
        logger.exception("WebSocket 异常")
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
