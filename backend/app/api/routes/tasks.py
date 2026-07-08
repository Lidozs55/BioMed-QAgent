"""任务 CRUD 与生命周期管理。

提供任务创建、查询、启动、删除接口。
启动后任务异步执行，通过 WebSocket 推送实时进度。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, UploadFile, File

from app.agents.orchestrator import Orchestrator
from app.api.routes.ws import broadcast
from app.config import UPLOADS_DIR
from app.llm.client import DashScopeClient
from app.models.task import TaskCreate
from app.storage.task_store import get_task_store
from app.tools.registry import get_registry

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/tasks", tags=["tasks"])

# 允许上传的文件扩展名（PDF + 图表图片）
_ALLOWED_EXTS = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}


@router.get("/{task_id}/analysis", summary="获取任务分析结果")
async def get_task_analysis(task_id: str) -> dict:
    """获取任务的分析结果（PPI/Enrichment/Drug Target 等）。"""
    store = get_task_store()
    task = store.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务不存在: {task_id}")
    analysis = store.get_analysis(task_id)
    return {
        "task_id": task_id,
        "analysis_types": list(analysis.keys()),
        "analysis": analysis,
        "has_results": len(analysis) > 0,
    }

# 全局 Orchestrator 单例（懒加载）
_orchestrator: Orchestrator | None = None
# 运行中的任务（task_id -> asyncio.Task）
_running_tasks: dict[str, asyncio.Task] = {}


def _get_orchestrator() -> Orchestrator:
    global _orchestrator
    if _orchestrator is None:
        _orchestrator = Orchestrator(
            llm=DashScopeClient(),
            tools=get_registry(),
            store=get_task_store(),
        )
    return _orchestrator


@router.post("", summary="创建任务")
async def create_task(payload: TaskCreate) -> dict:
    """创建新的研究任务。

    请求体：
    - research_goal: 研究目标（自然语言描述）
    - domain_hint: 领域提示（可选，如 "tcm"/"oncology"）
    - max_sources: 最大数据源返回数（默认 20）
    - enable_analysis: 是否运行分析阶段（默认 true）
    """
    store = get_task_store()
    task = store.create_task(
        research_goal=payload.research_goal,
        domain_hint=payload.domain_hint,
        max_sources=payload.max_sources,
        enable_analysis=payload.enable_analysis,
    )
    logger.info("创建任务 %s: %s", task.task_id, task.research_goal[:50])
    return task.to_summary()


@router.get("", summary="列出所有任务")
async def list_tasks() -> dict:
    """列出所有任务，按创建时间倒序。"""
    store = get_task_store()
    tasks = store.list_tasks()
    return {
        "tasks": [t.to_summary() for t in tasks],
        "total": len(tasks),
    }


@router.post("/{task_id}/upload", summary="上传 PDF 或图表图片")
async def upload_file(task_id: str, file: UploadFile = File(...)) -> dict:
    """上传文件到全局 uploads 目录，供 parse 阶段处理。

    支持 PDF（表格/caption 提取）和图表图片（Qwen-VL 图表数据提取）。
    文件保存到 data/uploads/，parse 阶段会自动扫描该目录。
    """
    store = get_task_store()
    task = store.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务不存在: {task_id}")

    import os
    suffix = os.path.splitext(file.filename or "")[1].lower()
    if suffix not in _ALLOWED_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的文件类型: {suffix}（仅支持 {', '.join(sorted(_ALLOWED_EXTS))}）",
        )

    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    dest = UPLOADS_DIR / (file.filename or f"upload_{task_id}{suffix}")
    content = await file.read()
    with open(dest, "wb") as f:
        f.write(content)
    logger.info("任务 %s 上传文件: %s (%d bytes)", task_id, dest.name, len(content))
    return {
        "task_id": task_id,
        "filename": dest.name,
        "size": len(content),
        "path": str(dest),
    }


@router.get("/{task_id}", summary="获取任务详情")
async def get_task(task_id: str) -> dict:
    """获取指定任务的详细信息。"""
    store = get_task_store()
    task = store.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务不存在: {task_id}")
    return task.to_summary()


@router.delete("/{task_id}", summary="删除任务")
async def delete_task(task_id: str) -> dict:
    """删除指定任务及其所有数据。"""
    store = get_task_store()
    # 取消运行中的任务
    if task_id in _running_tasks:
        _running_tasks[task_id].cancel()
        _running_tasks.pop(task_id, None)
    store.delete_task(task_id)
    return {"status": "deleted", "task_id": task_id}


@router.post("/{task_id}/start", summary="启动任务执行")
async def start_task(task_id: str) -> dict:
    """异步启动任务执行。

    任务将在后台运行 6+1 阶段流水线。
    通过 WebSocket /api/v1/ws/tasks/{task_id} 订阅实时进度。
    """
    store = get_task_store()
    task = store.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务不存在: {task_id}")

    if task.status.value not in ("created", "failed"):
        raise HTTPException(
            status_code=400,
            detail=f"任务状态为 {task.status.value}，无法启动（仅 created/failed 可启动）",
        )

    # 取消已有运行
    if task_id in _running_tasks and not _running_tasks[task_id].done():
        _running_tasks[task_id].cancel()

    orchestrator = _get_orchestrator()

    async def _run():
        # 进度回调：通过 WebSocket 广播（同一事件循环内调度）
        def progress_cb(msg: dict):
            try:
                asyncio.ensure_future(broadcast(task_id, msg))
            except RuntimeError:
                pass

        try:
            await orchestrator.run(task, progress=progress_cb)
        except Exception as e:
            logger.exception("任务执行失败 %s", task_id)
            task.errors.append(str(e))
            store.update_task(task)
            await broadcast(task_id, {"type": "error", "task_id": task_id, "message": str(e)})
        finally:
            _running_tasks.pop(task_id, None)

    loop = asyncio.get_running_loop()
    _running_tasks[task_id] = loop.create_task(_run())

    logger.info("启动任务 %s", task_id)
    return {
        "status": "started",
        "task_id": task_id,
        "websocket": f"/api/v1/ws/tasks/{task_id}",
    }


@router.get("/{task_id}/status", summary="查询任务状态")
async def get_task_status(task_id: str) -> dict:
    """查询任务当前状态和各阶段进度。"""
    store = get_task_store()
    task = store.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务不存在: {task_id}")
    is_running = task_id in _running_tasks and not _running_tasks[task_id].done()
    return {
        "task_id": task_id,
        "status": task.status.value,
        "is_running": is_running,
        "stages": {k: v.model_dump() for k, v in task.stages.items()},
        "total_records": task.total_records,
        "errors": task.errors,
    }
