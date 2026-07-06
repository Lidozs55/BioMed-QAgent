"""WebSocket 实时进度推送。

订阅任务执行期间的阶段进度、日志、错误等实时消息。

消息类型：
- task_start: 任务开始
- stage_start: 阶段开始
- stage_progress: 阶段进度更新
- stage_complete: 阶段完成
- task_complete: 任务完成
- error: 错误
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.storage.task_store import get_task_store

logger = logging.getLogger(__name__)
router = APIRouter(tags=["websocket"])

# 全局连接管理：task_id -> set[WebSocket]
_connections: dict[str, set[WebSocket]] = {}
_lock = asyncio.Lock()


async def broadcast(task_id: str, message: dict):
    """向指定任务的所有 WebSocket 连接广播消息。"""
    conns = _connections.get(task_id, set()).copy()
    dead: list[WebSocket] = []
    for ws in conns:
        try:
            await ws.send_json(message)
        except Exception:
            dead.append(ws)
    # 清理失效连接
    if dead and task_id in _connections:
        async with _lock:
            _connections[task_id] = _connections[task_id] - set(dead)


def broadcast_sync(task_id: str, message: dict):
    """同步广播（供非 async 上下文调用）。

    通过创建任务在事件循环中执行广播。
    """
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.run_coroutine_threadsafe(broadcast(task_id, message), loop)
        else:
            loop.run_until_complete(broadcast(task_id, message))
    except RuntimeError:
        # 无事件循环，跳过
        pass


@router.websocket("/ws/tasks/{task_id}")
async def task_websocket(websocket: WebSocket, task_id: str):
    """订阅任务实时进度。

    连接后立即推送当前任务状态快照，之后推送增量更新。
    """
    await websocket.accept()
    logger.info("WebSocket 连接: task_id=%s", task_id)

    store = get_task_store()
    task = store.get_task(task_id)
    if not task:
        await websocket.send_json({"type": "error", "message": f"任务不存在: {task_id}"})
        await websocket.close()
        return

    # 注册连接
    async with _lock:
        if task_id not in _connections:
            _connections[task_id] = set()
        _connections[task_id].add(websocket)

    # 发送当前状态快照
    try:
        await websocket.send_json({
            "type": "snapshot",
            "task_id": task_id,
            "status": task.status.value,
            "stages": {k: v.model_dump() for k, v in task.stages.items()},
            "total_records": task.total_records,
        })
    except Exception:
        pass

    # 保持连接，等待广播消息
    try:
        while True:
            # 接收客户端心跳/消息
            data = await websocket.receive_text()
            # 可选：处理客户端命令（如取消任务）
            if data == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        logger.info("WebSocket 断开: task_id=%s", task_id)
    except Exception as e:
        logger.warning("WebSocket 异常: %s", e)
    finally:
        async with _lock:
            if task_id in _connections:
                _connections[task_id].discard(websocket)
                if not _connections[task_id]:
                    _connections.pop(task_id, None)
