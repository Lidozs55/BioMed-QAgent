"""缓存导出与 round-trip 导入工具。

D6 决策：
  - ``GET /api/v1/cache/export`` 返回 ZIP，结构为
    ``cache_export/<namespace>/<dataset_id>/{main_data.csv, manifest.json}``
    + 顶层 ``index.json``
  - ``parse_cache_export_zip`` function tool 供附件解析 Agent 调用，
    解析 ZIP 格式的缓存导出文件，直接还原每个 dataset 到缓存

D7 决策：仅预置 ``parse_cache_export_zip``，不预置其他通用解析脚本。
"""

from __future__ import annotations

import io
import json
import logging
import zipfile
from datetime import UTC, datetime
from typing import Any

from agents import RunContextWrapper, function_tool
from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from app.agent_loop.context import RunContext
from app.tools.cache_store import get_cache_store

logger = logging.getLogger(__name__)


def build_cache_export_zip() -> bytes:
    """构建缓存导出 ZIP（内存中）。

    ZIP 结构::
        cache_export/
        ├── index.json              # 所有 dataset 的 manifest 汇总
        └── <namespace>/
            └── <dataset_id>/
                ├── main_data.csv
                └── manifest.json
    """
    store = get_cache_store()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        index_entries: list[dict[str, Any]] = []
        for manifest in store.list_datasets():
            ns = manifest.source_namespace
            ds = manifest.dataset_id
            arc_prefix = f"cache_export/{ns}/{ds}"
            # main_data.csv
            result = store.get_dataset(ns, ds)
            if result is None:
                continue
            _, rows = result
            import csv

            csv_buf = io.StringIO()
            if rows:
                writer = csv.DictWriter(
                    csv_buf,
                    fieldnames=list(rows[0].keys()),
                    extrasaction="raise",
                )
                writer.writeheader()
                for row in rows:
                    writer.writerow(row)
            zf.writestr(f"{arc_prefix}/main_data.csv", csv_buf.getvalue())
            # manifest.json
            manifest_dict = manifest.__dict__
            zf.writestr(
                f"{arc_prefix}/manifest.json",
                json.dumps(manifest_dict, ensure_ascii=False, indent=2) + "\n",
            )
            index_entries.append(manifest_dict)

        index = {
            "exported_at": datetime.now(UTC).isoformat(),
            "dataset_count": len(index_entries),
            "datasets": index_entries,
        }
        zf.writestr(
            "cache_export/index.json",
            json.dumps(index, ensure_ascii=False, indent=2) + "\n",
        )
    return buf.getvalue()


async def stream_cache_export() -> StreamingResponse:
    """返回缓存导出 ZIP 的 StreamingResponse。"""
    try:
        zip_bytes = build_cache_export_zip()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    timestamp = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
    filename = f"cache_export_{timestamp}.zip"
    return StreamingResponse(
        io.BytesIO(zip_bytes),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@function_tool(
    name_override="parse_cache_export_zip",
    description_override=(
        "Parse a cache export ZIP file (produced by GET /api/v1/cache/export) "
        "and return the list of datasets inside. Use this ONLY for cache "
        "export ZIPs — for any other format, write a custom script via "
        "run_python_script. After parsing, commit each dataset to cache via "
        "commit_to_cache using the original manifest's topic/description."
    ),
)
def parse_cache_export_zip(
    ctx: RunContextWrapper[Any],
    input_relative_path: str,
) -> str:
    """解析缓存导出 ZIP，返回数据集列表。

    Args:
        input_relative_path: ZIP 文件在任务目录内的相对路径
            （如 ``source_assets/cache_export_20260719.zip``）。

    Returns:
        JSON 字符串，结构::
            {
              "datasets": [
                {
                  "source_namespace": "...",
                  "dataset_id": "...",
                  "topic": "...",
                  "description": "...",
                  "row_count": N,
                  "manifest": {...},
                  "csv_content": "..."  # main_data.csv 文本
                },
                ...
              ],
              "total": N
            }
    """
    run_ctx: RunContext = ctx.context
    task_root = run_ctx.work_dir.root.resolve()
    zip_path = (task_root / input_relative_path).resolve()
    try:
        zip_path.relative_to(task_root)
    except ValueError as exc:
        return f"路径错误: {exc}（必须在任务目录内）"

    if not zip_path.is_file():
        return f"ZIP 文件不存在: {input_relative_path}"

    datasets: list[dict[str, Any]] = []
    try:
        with zipfile.ZipFile(str(zip_path), "r") as zf:
            # 读 index.json
            try:
                with zf.open("cache_export/index.json") as f:
                    index = json.loads(f.read().decode("utf-8"))
            except KeyError:
                return "无效的缓存导出 ZIP：缺少 cache_export/index.json"

            # 遍历每个 dataset
            for entry in index.get("datasets", []):
                ns = entry["source_namespace"]
                ds = entry["dataset_id"]
                arc_prefix = f"cache_export/{ns}/{ds}"
                try:
                    csv_bytes = zf.read(f"{arc_prefix}/main_data.csv")
                    csv_content = csv_bytes.decode("utf-8-sig")
                except KeyError:
                    continue
                datasets.append(
                    {
                        "source_namespace": ns,
                        "dataset_id": ds,
                        "topic": entry.get("topic", ""),
                        "description": entry.get("description", ""),
                        "row_count": entry.get("row_count", 0),
                        "manifest": entry,
                        "csv_content": csv_content,
                    }
                )
    except zipfile.BadZipFile as exc:
        return f"ZIP 文件损坏: {exc}"
    except Exception as exc:  # noqa: BLE001
        return f"解析 ZIP 失败: {exc}"

    return json.dumps(
        {"datasets": datasets, "total": len(datasets)},
        ensure_ascii=False,
    )
