"""WebSocket 端点 — 接收用户输入，流式推送 Agent loop 与 Pipeline 事件。

支持两种消息类型：
    {"type": "run", "input": "...", "task_id": "...", "databases": [...]}
        → 运行 Agent loop，推送 ad-hoc 事件字典
    {"type": "run_pipeline", "topic": "...", "task_id": "optional"}
        → 运行确定性 Pipeline，推送 EventEnvelope 事件
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.agent_loop.runner import run_agent_stream
from app.config import settings
from app.domain.contracts import generate_prefixed_uuid
from app.pipeline.runner import PipelineRunner

router = APIRouter()
logger = logging.getLogger(__name__)

_FIXTURE_DIR = (
    Path(__file__).parents[2] / "tests" / "fixtures" / "ncbi" / "gse178352"
)


@router.websocket("/api/v1/ws")
async def agent_ws(websocket: WebSocket) -> None:
    """Agent loop + Pipeline WebSocket 端点。

    客户端 → 服务端消息格式：
        {"type": "run", "input": "研究目标文本",
         "task_id": "optional-task-id", "databases": ["geo", "gdc"]}
        {"type": "run_pipeline", "topic": "...", "task_id": "optional"}

    服务端 → 客户端事件格式：
        Agent loop (ad-hoc dict):
        {"type": "task_started", "task_id": "..."}
        {"type": "text", "delta": "..."}
        {"type": "tool_call", "name": "...", "arguments": "..."}
        {"type": "tool_output", "output": "..."}
        {"type": "done", "final_output": "..."}
        {"type": "error", "message": "..."}

        Pipeline (EventEnvelope):
        {"schema_version": "1.0", "event_id": "...", "type": "task_created",
         "task_id": "...", "sequence": 1, "timestamp": "...", "payload": {...}}
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

            msg_type = msg.get("type")
            if msg_type == "run":
                await _handle_run_agent(websocket, msg)
            elif msg_type == "run_pipeline":
                await _handle_run_pipeline(websocket, msg)
            # Unknown types are ignored silently.

    except WebSocketDisconnect:
        logger.info("WebSocket 客户端断开")
    except Exception as e:
        logger.exception("WebSocket 异常")
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            logger.debug("WebSocket 发送错误事件时连接已断开", exc_info=True)


async def _handle_run_agent(websocket: WebSocket, msg: dict) -> None:
    """Dispatch an agent-loop run, forwarding ad-hoc event dicts."""
    user_input = msg.get("input", "").strip()
    if not user_input:
        await websocket.send_json({"type": "error", "message": "输入为空"})
        return

    task_id = msg.get("task_id") or generate_prefixed_uuid("task")
    if not isinstance(task_id, str) or not re.fullmatch(
        r"[A-Za-z0-9_-]{1,128}", task_id
    ):
        await websocket.send_json({"type": "error", "message": "无效 task_id"})
        return
    databases = msg.get("databases")
    await websocket.send_json({"type": "task_started", "task_id": task_id})
    async for event in run_agent_stream(
        user_input, task_id, databases=databases
    ):
        await websocket.send_json(event)


async def _handle_run_pipeline(websocket: WebSocket, msg: dict) -> None:
    """Dispatch a deterministic pipeline run, forwarding EventEnvelope dicts.

    Each EventEnvelope is persisted to events.jsonl before being pushed over
    the WebSocket (persist-then-push invariant, §11 line 340).
    """
    topic = (msg.get("topic") or "").strip()
    if not topic:
        await websocket.send_json(
            {"type": "error", "message": "pipeline run requires non-empty topic"}
        )
        return

    task_id = msg.get("task_id") or generate_prefixed_uuid("task")
    if not isinstance(task_id, str) or not re.fullmatch(
        r"[A-Za-z0-9_-]{1,128}", task_id
    ):
        await websocket.send_json({"type": "error", "message": "无效 task_id"})
        return

    base_dir = Path(settings.output_dir) / "tasks"
    runner = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=_FIXTURE_DIR,
        topic=topic,
    )
    try:
        async for event in runner.run_streamed():
            await websocket.send_json(event.model_dump(mode="json"))
    except Exception as e:
        logger.exception("Pipeline run_streamed failed")
        await websocket.send_json({"type": "error", "message": str(e)})
