"""LLM 数据提取器 — 从爬虫原始文本提取结构化 DataRecord。

职责（对齐 docs/agent_browser_integration.md §LLM 提取 Agent）：
- 接收 acquire 阶段产出的 raw crawl record（含 raw_content）
- 调用 LLM 识别并提取结构化字段
- 输出标准 DataRecord（含 source_ref.source_type=crawl, extraction_method=llm_extract）

LLM 介入的必要性：
1. 字段对齐：爬虫获取的纯文本中字段需 LLM 识别提取
2. 语义归一化：不同来源对同一实体命名不同，需 LLM 对齐
3. 冲突处理：多来源对同一数据点给出不同值时，需 LLM 判断置信度
"""
from __future__ import annotations

import hashlib
import json
import logging

from app.llm.client import DashScopeClient
from app.tools.datasources.base_ds import utc_now

logger = logging.getLogger(__name__)

# LLM 提取的置信度（低于 API 直取的 0.9，高于纯爬虫的 0.5）
_EXTRACT_CONFIDENCE = 0.75

# 单次 LLM 提取输入内容截断（避免超长 token）
_MAX_CONTENT_LEN = 3000


class LLMExtractor:
    """LLM 数据提取器 — 从爬虫原始文本提取结构化字段。"""

    def __init__(self, llm: DashScopeClient | None = None):
        self.llm = llm or DashScopeClient()

    def extract(self, raw_record: dict) -> list[dict]:
        """从 raw crawl record 提取结构化 DataRecord 列表。

        Args:
            raw_record: 爬虫输出，含 raw_content/query/crawl_source/url/schema_hint
        Returns:
            DataRecord 列表（符合 data_record.schema.json）；无数据时返回空列表
        """
        if not self.llm.is_available():
            logger.warning("LLMExtractor: API Key 未配置，跳过提取")
            return []

        raw_content = raw_record.get("raw_content", "")
        query = raw_record.get("query", "")
        source = raw_record.get("crawl_source", "web_crawler")
        url = raw_record.get("url", "")
        schema_hint = raw_record.get("schema_hint", {}) or {}

        if not raw_content.strip():
            return []

        prompt = self._build_prompt(raw_content, query, schema_hint)

        try:
            result = self.llm.chat_json(
                [{"role": "user", "content": prompt}],
                temperature=0.1,
            )
        except Exception as e:
            logger.warning("LLMExtractor 提取失败（source=%s）: %s", source, e)
            return []

        # LLM 返回 {"records": [...]} 或直接返回 list
        items = result.get("records") if isinstance(result, dict) else result
        if not isinstance(items, list):
            items = [items] if items else []

        records: list[dict] = []
        for item in items:
            if not isinstance(item, dict) or not item:
                continue
            rec = self._to_data_record(item, source, query, url,
                                        raw_record.get("task_id", "default"))
            records.append(rec)

        logger.info("LLMExtractor: 从 %s 提取 %d 条记录", source, len(records))
        return records

    @staticmethod
    def _build_prompt(raw_content: str, query: str,
                       schema_hint: dict) -> str:
        """构造 LLM 提取 prompt。"""
        content = raw_content[:_MAX_CONTENT_LEN]
        schema_text = json.dumps(schema_hint, ensure_ascii=False) if schema_hint \
            else "化合物名、靶点基因、活性值、疾病名等（自由提取）"

        return f"""从以下网页内容中提取结构化数据。

检索查询：{query}
期望字段结构（字段名→类型）：{schema_text}

网页内容：
{content}

提取要求：
1. 严格基于网页内容提取，不要编造数据
2. 返回 JSON 对象，格式：{{"records": [{{字段1: 值1, 字段2: 值2}}, ...]}}
3. 数值字段转为数字（float/int），无法解析设为 null
4. 列表字段用数组表示
5. 若整页无相关数据，返回 {{"records": []}}
6. 实体名称保持原文，不要翻译

请返回纯 JSON："""

    @staticmethod
    def _to_data_record(fields: dict, source: str, query: str,
                         url: str, task_id: str) -> dict:
        """将 LLM 提取的字段封装为标准 DataRecord。"""
        raw = f"{source}|{query}|{json.dumps(fields, sort_keys=True, default=str)}"
        h8 = hashlib.md5(raw.encode("utf-8")).hexdigest()[:8]
        return {
            "record_id": f"{source}_crawl-{h8}",
            "task_id": task_id,
            "fields": fields,
            "source_ref": {
                "source_name": source,
                "source_type": "crawl",
                "source_url": url,
                "query": query,
                "extraction_method": "llm_extract",
                "retrieved_at": utc_now(),
            },
            "extraction_method": "llm_extract",
            "extraction_confidence": _EXTRACT_CONFIDENCE,
            "quality_flags": ["llm_extracted"],
            "created_at": utc_now(),
        }


def is_raw_crawl_record(record: dict) -> bool:
    """判断记录是否为未提取的爬虫原始记录（供 ParserAgent 识别）。

    raw crawl record 含 raw_content 且无 fields/record_id（尚未结构化）。
    """
    return ("raw_content" in record
            and "fields" not in record
            and "record_id" not in record)
