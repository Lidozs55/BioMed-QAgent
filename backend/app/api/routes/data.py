"""数据查询、预览、导出接口。

提供任务产生的数据记录查询、分页预览、CSV/JSON 导出能力。
"""
from __future__ import annotations

import csv
import json
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse, Response

from app.storage.task_store import get_task_store

logger = logging.getLogger(__name__)
router = APIRouter(tags=["data"])


@router.get("/tasks/{task_id}/data", summary="查询任务数据记录")
async def get_task_data(
    task_id: str,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    source: str | None = Query(None, description="按数据源过滤"),
) -> dict:
    """查询任务产生的数据记录（分页）。"""
    store = get_task_store()
    task = store.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务不存在: {task_id}")

    records = store._records.get(task_id, [])
    if source:
        records = [r for r in records
                   if r.get("source_ref", {}).get("source_name") == source]

    total = len(records)
    page = records[offset:offset + limit]

    # 数据源分布统计
    sources: dict[str, int] = {}
    for r in records:
        src = r.get("source_ref", {}).get("source_name", "unknown")
        sources[src] = sources.get(src, 0) + 1

    return {
        "task_id": task_id,
        "total": total,
        "limit": limit,
        "offset": offset,
        "sources": sources,
        "records": page,
    }


@router.get("/tasks/{task_id}/export/{fmt}", summary="导出数据")
async def export_data(task_id: str, fmt: str) -> Response:
    """导出任务数据为 CSV 或 JSON。

    - csv: 逗号分隔值，含所有字段
    - json: 完整 JSON 数组
    """
    store = get_task_store()
    task = store.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务不存在: {task_id}")

    records = store._records.get(task_id, [])

    # 优先返回已生成的文件
    if task.output_dir:
        out_dir = Path(task.output_dir)
        if fmt == "csv" and (out_dir / "data.csv").exists():
            with open(out_dir / "data.csv", "rb") as f:
                return Response(
                    content=f.read(),
                    media_type="text/csv",
                    headers={"Content-Disposition": f"attachment; filename={task_id}.csv"},
                )
        if fmt == "json" and (out_dir / "final_data.json").exists():
            with open(out_dir / "final_data.json", "rb") as f:
                return Response(
                    content=f.read(),
                    media_type="application/json",
                    headers={"Content-Disposition": f"attachment; filename={task_id}.json"},
                )

    # 兜底：实时生成
    if fmt == "csv":
        if not records:
            return PlainTextResponse("", media_type="text/csv")
        # 收集所有字段
        fieldnames = ["record_id", "source_name", "extraction_method",
                       "extraction_confidence", "quality_flags"]
        seen = set(fieldnames)
        for r in records:
            for k in r.get("fields", {}):
                if k not in seen:
                    fieldnames.append(k)
                    seen.add(k)
        fieldnames.extend(["source_url", "doi", "pmid"])

        output = []
        writer = csv.DictWriter(output, fieldnames=fieldnames, extrasaction="ignore")
        output.append(writer.writerow(fieldnames))
        for r in records:
            row = {
                "record_id": r.get("record_id", ""),
                "source_name": r.get("source_ref", {}).get("source_name", ""),
                "extraction_method": r.get("extraction_method", ""),
                "extraction_confidence": r.get("extraction_confidence", ""),
                "quality_flags": ", ".join(r.get("quality_flags", [])),
            }
            row.update(r.get("fields", {}))
            row["source_url"] = r.get("source_ref", {}).get("url", "")
            row["doi"] = r.get("source_ref", {}).get("doi", "")
            row["pmid"] = r.get("source_ref", {}).get("pmid", "")
            output.append(writer.writerow(row))

        csv_text = "".join(output)
        return Response(
            content=csv_text,
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename={task_id}.csv"},
        )

    elif fmt == "json":
        return Response(
            content=json.dumps(records, ensure_ascii=False, indent=2),
            media_type="application/json",
            headers={"Content-Disposition": f"attachment; filename={task_id}.json"},
        )
    else:
        raise HTTPException(status_code=400, detail=f"不支持的格式: {fmt}（仅支持 csv/json/merged_csv）")


@router.get("/tasks/{task_id}/export/merged/csv", summary="导出多源整合CSV")
async def export_merged_csv(task_id: str) -> Response:
    """导出多源整合 CSV — 按实体类型分组，字段对齐，便于研究分析。

    与普通 CSV 的区别：
    - 普通 CSV: 所有记录平铺，字段稀疏（适合溯源审计）
    - 整合 CSV: 按实体类型分组（literature/compound/gene/interaction/pathway），
      字段对齐，每个分组有独立的列头，便于后续统计分析
    """
    store = get_task_store()
    task = store.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务不存在: {task_id}")

    # 优先返回已生成的文件
    if task.output_dir:
        merged_path = Path(task.output_dir) / "merged_data.csv"
        if merged_path.exists():
            with open(merged_path, "rb") as f:
                return Response(
                    content=f.read(),
                    media_type="text/csv",
                    headers={"Content-Disposition": f"attachment; filename={task_id}_merged.csv"},
                )

    raise HTTPException(status_code=404, detail="整合CSV尚未生成，请等待任务完成")
