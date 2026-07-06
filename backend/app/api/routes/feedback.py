"""用户反馈与修正接口。

支持用户对任务结果提供反馈、修正实体、重新触发特定阶段。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.storage.task_store import get_task_store

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/tasks/{task_id}/feedback", tags=["feedback"])


class FeedbackRequest(BaseModel):
    """用户反馈请求。"""
    feedback_type: str  # "refine_entities" | "retry_stage" | "general"
    message: str = ""
    extra_entities: dict[str, list[str]] | None = None
    retry_stage: str | None = None


@router.post("", summary="提交用户反馈")
async def submit_feedback(task_id: str, payload: FeedbackRequest) -> dict:
    """提交用户反馈。

    - refine_entities: 用户补充实体（化合物/基因/疾病/通路）
    - retry_stage: 请求重试特定阶段
    - general: 一般性反馈
    """
    store = get_task_store()
    task = store.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务不存在: {task_id}")

    # 记录反馈
    feedback_entry = {
        "type": payload.feedback_type,
        "message": payload.message,
        "extra_entities": payload.extra_entities,
        "retry_stage": payload.retry_stage,
    }
    # 暂存到任务 errors 旁的 feedback 字段（未来可扩展）
    if not hasattr(task, "feedbacks"):
        # Pydantic 模型动态字段处理
        task_feedbacks = getattr(task, "_feedbacks", [])
        task_feedbacks.append(feedback_entry)
        setattr(task, "_feedbacks", task_feedbacks)
    store.update_task(task)

    logger.info("收到任务 %s 反馈: %s", task_id, payload.feedback_type)

    return {
        "status": "received",
        "task_id": task_id,
        "feedback_type": payload.feedback_type,
        "note": "反馈已记录。如需重新执行，请调用 POST /tasks/{task_id}/start",
    }
