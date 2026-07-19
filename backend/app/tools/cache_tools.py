"""commit_to_cache function tool — 供 IMPORT Agent 将清洗后的数据写入缓存。

此工具不属于任何 skill（只供 IMPORT agent 使用），由
``build_attachment_parsing_agent`` 直接装载。设计要点（D3 决策）：
  - 原子写入：内部调用 ``CacheStore.commit_dataset``，先写 .tmp 再 os.replace
  - 列名校验：CSV 必须使用 22 列 schema 的子集，缺失列自动填空
  - 失败抛异常：写入失败时 IMPORT agent 会收到错误信息，可重试或换策略
  - provenance：自动记录 ``created_by_task_id`` 和原始上传文件名
"""

from __future__ import annotations

import csv
import io
import json
import logging
from typing import Any

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.tools.cache_store import CACHE_MAIN_DATA_COLUMNS, get_cache_store

logger = logging.getLogger(__name__)


def _parse_csv_to_rows(csv_content: str) -> list[dict[str, str]]:
    """将 CSV 文本解析为 list[dict]，缺失列填空字符串。

    自动剥离开头的 UTF-8 BOM（``\\ufeff``）—— sandbox 的 ``write_csv`` 用
    ``utf-8-sig`` 写文件，``read_file`` 读回时 BOM 会进入字符串，
    导致 ``csv.DictReader`` 把首列名识别为 ``\\ufeffrecord_id`` 而
    通不过 22 列 schema 校验。
    """
    if csv_content.startswith("\ufeff"):
        csv_content = csv_content[1:]
    reader = csv.DictReader(io.StringIO(csv_content))
    rows = list(reader)
    if not rows:
        raise ValueError("CSV 内容为空或无数据行")
    valid_cols = set(CACHE_MAIN_DATA_COLUMNS)
    for i, row in enumerate(rows):
        extra_keys = set(row.keys()) - valid_cols
        if extra_keys:
            raise ValueError(
                f"CSV 第 {i + 1} 行包含不在 schema 中的列: "
                f"{sorted(extra_keys)}。允许的列: {list(CACHE_MAIN_DATA_COLUMNS)}"
            )
    return rows


@function_tool(
    name_override="commit_to_cache",
    description_override=(
        "Commit cleaned data rows to the local cache as a new dataset. "
        "The data must be in the 22-column long format (same schema as "
        "main_data.csv). Missing columns are filled with empty strings. "
        "Once committed, the dataset is immediately queryable by "
        "search_local_cache/describe_local_cache/get_cache_dataset in "
        "subsequent Agent tasks. Use this after parsing/cleaning a "
        "user-uploaded file. Always provide keywords extracted from the "
        "data (gene names, drug names, diseases, pathways, sample types, "
        "etc.) to enable FTS5-based retrieval by arbitrary entities."
    ),
)
def commit_to_cache(
    ctx: RunContextWrapper[Any],
    csv_content: str,
    dataset_id: str,
    topic: str,
    description: str,
    source_files: str = "",
    keywords: str = "",
) -> str:
    """将清洗后的 CSV 数据写入本地缓存。

    Args:
        csv_content: CSV 文本（含表头）。表头必须是 22 列 schema 的子集，
            缺失列会被自动填空。每行一个数据记录。
        dataset_id: 数据集 ID（``^[a-z0-9][a-z0-9_-]*$``），如
            ``user_import_20260719_patients``。若已存在则覆盖。
        topic: 数据集主题/标题（供搜索）。
        description: 人类可读描述（供搜索和展示）。
        source_files: 原始上传文件名列表，用逗号分隔（如 ``patients.csv,meta.json``）。
        keywords: 关键实体标签，用逗号分隔（如 ``BRCA1,TP53,breast cancer,
            paclitaxel``）。支持任意实体（基因、药物、疾病、通路、样本类型等），
            由 FTS5 索引供后续 search_local_cache 检索。强烈建议提供。
    """
    run_ctx: RunContext = ctx.context
    try:
        store = get_cache_store()
    except RuntimeError as exc:
        return f"本地缓存未初始化: {exc}"

    try:
        rows = _parse_csv_to_rows(csv_content)
    except ValueError as exc:
        return f"CSV 解析失败: {exc}"

    files = [s.strip() for s in source_files.split(",") if s.strip()] if source_files else []
    kw_list = [k.strip() for k in keywords.split(",") if k.strip()] if keywords else []

    try:
        manifest = store.commit_dataset(
            dataset_id=dataset_id,
            source_namespace="user_import",
            topic=topic,
            description=description,
            csv_rows=rows,
            created_by_task_id=run_ctx.task_id,
            source_files=files,
            keywords=kw_list,
        )
    except ValueError as exc:
        return f"缓存写入失败（参数校验）: {exc}"
    except Exception as exc:  # noqa: BLE001 — 写入异常需返回给 LLM
        logger.exception("commit_to_cache failed for dataset=%s", dataset_id)
        return f"缓存写入失败: {exc}"

    return json.dumps(
        {
            "status": "ok",
            "dataset_id": manifest.dataset_id,
            "source_namespace": manifest.source_namespace,
            "row_count": manifest.row_count,
            "column_count": manifest.column_count,
            "keywords": manifest.keywords,
            "created_at": manifest.created_at,
            "created_by_task_id": manifest.created_by_task_id,
            "message": (
                f"已成功写入缓存（{len(manifest.keywords or [])} 个 keywords）。"
                f"其他 Agent 任务可通过 "
                f"search_local_cache('{topic}') 或按关键词 "
                f"search_local_cache('{(manifest.keywords or [''])[0]}') "
                f"查询，也可 get_cache_dataset('{manifest.source_namespace}', "
                f"'{manifest.dataset_id}')。"
            ),
        },
        ensure_ascii=False,
        indent=2,
    )
