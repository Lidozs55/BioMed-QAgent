"""数据溯源查询接口。

提供完整溯源图和单条记录溯源链查询。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from app.storage.task_store import get_task_store

logger = logging.getLogger(__name__)
router = APIRouter(tags=["lineage"])


@router.get("/tasks/{task_id}/lineage", summary="获取完整溯源图")
async def get_lineage_graph(task_id: str) -> dict:
    """获取任务的完整数据溯源图（DAG）。"""
    store = get_task_store()
    task = store.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务不存在: {task_id}")

    prov = store.get_provenance(task_id)
    if not prov or not prov.nodes:
        return {
            "task_id": task_id,
            "nodes": [],
            "edges": [],
            "stats": {"total_nodes": 0, "total_records_tracked": 0},
        }

    return prov.to_graph()


@router.get("/tasks/{task_id}/lineage/{record_id}", summary="查询单条记录溯源链")
async def get_record_lineage(task_id: str, record_id: str) -> dict:
    """获取指定数据记录的完整处理链路（从原始来源到当前记录）。"""
    store = get_task_store()
    task = store.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务不存在: {task_id}")

    prov = store.get_provenance(task_id)
    if not prov:
        raise HTTPException(status_code=404, detail="无溯源数据")

    chain = prov.get_lineage(record_id)
    if not chain:
        raise HTTPException(status_code=404, detail=f"未找到记录 {record_id} 的溯源链")

    return {
        "task_id": task_id,
        "record_id": record_id,
        "lineage": chain,
        "depth": len(chain),
    }
