"""通用网页爬虫 — API 不可用时的 fallback 采集层。

设计要点（对齐 docs/agent_browser_integration.md）：
- 输出原始 HTML/文本（raw_content），不做字段提取
- 字段提取由 parse 阶段的 LLMExtractor 完成（职责分离）
- 限速 ≥2s、设置 UA、单页超时 ≤60s
- 失败不阻塞流水线（异常由 AcquireAgent 捕获）

输出格式（raw crawl record，非 DataRecord）：
    {
        "crawl_source": "tcmsp_web",
        "raw_type": "html",
        "raw_content": "...",
        "url": "...",
        "query": "...",
        "crawled_at": "ISO8601",
        "task_id": "...",
        "schema_hint": {...}   # 供 LLMExtractor 使用的字段提示
    }
"""
from __future__ import annotations

import logging
from urllib.parse import quote

from .base_ds import BaseDataSource, utc_now

logger = logging.getLogger(__name__)

# 各数据源 → 爬虫 URL 构造器（query → 完整 URL）
# 仅收录已知需爬虫的数据源；其余由调用方通过 url kwarg 显式传入
_SOURCE_URL_BUILDERS: dict[str, callable] = {
    "tcmsp": lambda q: f"https://old.tcmsp.com/tcmspsearch.php?term={quote(q)}",
    "drugbank": lambda q: f"https://go.drugbank.com/unearth/q?searcher=drugs&query={quote(q)}",
    "disgenet": lambda q: f"https://www.disgenet.org/search?term={quote(q)}",
}

# 各数据源 → 期望提取的字段结构（供 LLMExtractor 使用）
_SOURCE_SCHEMA_HINTS: dict[str, dict] = {
    "tcmsp": {"compound_name": "str", "ob": "float", "dl": "float",
              "source_herb": "str", "targets": "list[str]"},
    "drugbank": {"drug_name": "str", "target_gene": "str",
                 "action": "str", "mechanism": "str"},
    "disgenet": {"gene_symbol": "str", "disease": "str",
                 "score": "float", "source_db": "str"},
}

# 原始内容截断长度，避免 LLM 输入过长
_MAX_RAW_LEN = 50000


class WebCrawlerSource(BaseDataSource):
    """通用网页爬虫（fallback，输出原始文本供 LLM 提取）。

    与 API 数据源的区别：输出 raw_content 而非结构化 DataRecord，
    后续由 parse 阶段的 LLMExtractor 转换为 DataRecord。
    """

    name = "web_crawler"
    description = "通用网页爬虫（fallback，输出原始文本供 LLM 提取）"
    default_rate = 2.0  # 礼貌限速：≥2s/次

    def search(self, query: str, max_results: int = 20,
               task_id: str = "default", **kwargs) -> list[dict]:
        """爬取指定 URL，返回 raw crawl record 列表。

        Args:
            query: 检索词（用于构造 URL 与溯源）
            max_results: 未使用（爬虫单页采集，保留接口一致性）
            task_id: 任务 ID
            kwargs:
                url: 显式指定爬取 URL（优先于 source 构造）
                source: 数据源名（如 tcmsp），用于构造 URL 与 schema_hint
        Returns:
            raw crawl record 列表（长度 0 或 1）；失败时返回空列表
        """
        source = kwargs.get("source", "web_crawler")
        url = kwargs.get("url") or self._build_url(source, query)
        if not url:
            logger.warning("web_crawler: 无可用 URL（source=%s, query=%s）",
                           source, query)
            return []

        self.limiter.wait()
        try:
            resp = self.client.get(url)
            resp.raise_for_status()
            html = resp.text
        except Exception as e:
            logger.warning("web_crawler 爬取失败 %s: %s", url, e)
            return []

        # 用 BeautifulSoup 清洗 HTML：去脚本/样式，保留表格与文本
        raw_content, raw_type = self._clean_html(html)

        if not raw_content.strip():
            logger.info("web_crawler: %s 页面内容为空", url)
            return []

        record = {
            "crawl_source": source,
            "raw_type": raw_type,
            "raw_content": raw_content[:_MAX_RAW_LEN],
            "url": url,
            "query": query,
            "crawled_at": utc_now(),
            "task_id": task_id,
            "schema_hint": _SOURCE_SCHEMA_HINTS.get(source, {}),
        }
        logger.info("web_crawler: 成功爬取 %s（%d 字符，source=%s）",
                    url, len(raw_content), source)
        return [record]

    @staticmethod
    def _build_url(source: str, query: str) -> str:
        """根据数据源名构造爬虫 URL。"""
        builder = _SOURCE_URL_BUILDERS.get(source)
        return builder(query) if builder else ""

    @staticmethod
    def _clean_html(html: str) -> tuple[str, str]:
        """清洗 HTML：去除 script/style，保留结构化文本与表格。

        Returns:
            (cleaned_content, raw_type) — raw_type 为 "html" 或 "text"
        """
        try:
            from bs4 import BeautifulSoup
        except ImportError:
            # 无 bs4 时退化为纯文本截取
            return html[:_MAX_RAW_LEN], "text"

        soup = BeautifulSoup(html, "lxml")
        # 移除脚本、样式、注释
        for tag in soup(["script", "style", "noscript", "iframe"]):
            tag.decompose()

        # 优先保留表格（结构化数据通常在表格中）
        tables = soup.find_all("table")
        if tables:
            # 含表格时保留 HTML 结构，便于 LLM 解析行列关系
            content = "\n".join(str(t) for t in tables[:10])
            # 附加页面可见文本（截断）
            text = soup.get_text(separator="\n", strip=True)
            if text:
                content += "\n\n" + text[:5000]
            return content[:_MAX_RAW_LEN], "html"

        # 无表格时返回纯文本
        text = soup.get_text(separator="\n", strip=True)
        return text[:_MAX_RAW_LEN], "text"


def build_crawl_url(source: str, query: str) -> str:
    """模块级便捷函数：根据数据源名构造爬虫 URL。"""
    builder = _SOURCE_URL_BUILDERS.get(source)
    return builder(query) if builder else ""


def get_schema_hint(source: str) -> dict:
    """模块级便捷函数：获取数据源的字段提取提示。"""
    return _SOURCE_SCHEMA_HINTS.get(source, {})
