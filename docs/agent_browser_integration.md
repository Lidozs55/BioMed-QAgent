# Stage 2 Acquire — 浏览器工具/爬虫对接规范

## 背景

流水线第 2 阶段 `acquire` 负责当数据源 API 不可用时，通过浏览器自动化或爬虫工具采集数据。

典型场景：TCMSP 等数据源的 Web 接口被封锁或限流，API 返回失败，此时数据源脚本会输出 `requires_crawl` 信号，由 acquire 阶段接管。

## 当前状态

**未实现，完全隔离。** acquire 阶段在流水线中作为占位存在：

- 识别 `requires_crawl` 信号 → 记录到 `task.errors`（非致命提示）
- 不执行任何实际爬取
- 返回原始 records 不变
- 任何异常被捕获，绝不影响后续 parse/clean/analyze 阶段

相关代码：[orchestrator.py `_stage_acquire`](../backend/app/agents/orchestrator.py)

## 信号传递链

```
数据源脚本 (tcmsp_client.py)
  ↓ stdout JSON: {"status": "requires_crawl", "reason": "..."}
script_tool.py ScriptResult
  ↓ signals 字段保留原始信号 dict
orchestrator._stage_search
  ↓ 收集到 context["crawl_targets"] = [{"source", "query", "reason"}]
orchestrator._stage_acquire
  ↓ 读取 crawl_targets，记录日志（当前止步于此）
```

## 数据形式关键约束

**爬虫采集的数据可能是纯文本描述性语料，而非标准结构化数据。** 这是 acquire 阶段与 search 阶段的核心差异：

| 数据来源 | 数据形式 | 处理方式 |
|----------|----------|----------|
| API 数据源（PubMed/STRING/KEGG） | 结构化 JSON | 直接转为 DataRecord |
| 爬虫采集（TCMSP 网页/文献全文） | 纯文本/HTML/混合 | **必须经 LLM 提取结构化字段** |
| PDF 解析（表格/caption） | 半结构化 | pdf_table_parser 提取 |

### LLM 介入的必要性

多源多形式数据整合**必须有 LLM 介入**，原因：

1. **字段对齐**：爬虫获取的纯文本中，化合物名称、靶点基因、活性值等字段需要 LLM 识别提取
2. **语义归一化**：不同来源对同一实体可能有不同命名（如"槲皮素" vs "Quercetin" vs "QUE"），需 LLM 对齐
3. **冲突处理**：多来源对同一数据点给出不同值时，需 LLM 判断置信度
4. **图表数据提取**：从图表截图提取坐标轴数据需要 LLM 视觉理解能力

### 爬虫输出数据规范

爬虫工具采集的原始数据应按以下格式输出，供后续 LLM 提取阶段使用：

```json
{
  "crawl_source": "tcmsp_web",
  "raw_type": "html | text | screenshot",
  "raw_content": "...原始 HTML 或文本...",
  "url": "https://old.tcmsp.com/tcmspsearch.php?term=...",
  "query": "黄芩",
  "crawled_at": "2026-07-07T12:00:00Z",
  "task_id": "Txxxxxx"
}
```

后续由 `parse` 阶段的 LLM 提取 agent 将 `raw_content` 转为标准 DataRecord：

```json
{
  "record_id": "tcmsp_web-xxxxxxxx",
  "task_id": "Txxxxxx",
  "fields": {
    "compound_name": "黄芩苷",
    "ob": 29.54,
    "dl": 0.31,
    "source_herb": "黄芩"
  },
  "source_ref": {
    "source_name": "tcmsp_web",
    "source_type": "crawl",
    "source_url": "https://old.tcmsp.com/...",
    "extraction_method": "llm_extract",
    "extraction_confidence": 0.85
  }
}
```

## 极简对接要求

实现 acquire 阶段只需在 `_stage_acquire` 方法中添加爬虫调用。以下是三种对接方式，按推荐度排序。

### 方式 A：内置 Python 爬虫（推荐）

在 `backend/app/tools/datasources/` 下新增 `web_crawler.py`，使用 `httpx` + `beautifulsoup4`（已在 requirements.txt 中）。

```python
# backend/app/tools/datasources/web_crawler.py
from app.tools.datasources.base_ds import BaseDataSource, make_record

class WebCrawlerSource(BaseDataSource):
    name = "web_crawler"
    description = "通用网页爬虫（fallback，输出原始文本供 LLM 提取）"
    default_rate = 2.0  # 礼貌限速

    def search(self, query: str, max_results: int = 20,
               task_id: str = "default", **kwargs) -> list[dict]:
        url = kwargs.get("url", "")
        if not url:
            return []
        # 爬虫输出原始 HTML/文本，不做字段提取
        # 字段提取由 parse 阶段的 LLM agent 完成
        resp = self.client.get(url)
        html = resp.text
        # 返回 raw_content 格式，供 LLM 提取
        return [{
            "crawl_source": self.name,
            "raw_type": "html",
            "raw_content": html[:50000],  # 截断避免超长
            "url": url,
            "query": query,
            "task_id": task_id,
        }]
```

在 `_stage_acquire` 中调用：

```python
from app.tools.datasources.web_crawler import WebCrawlerSource
crawler = WebCrawlerSource()
crawl_records = []
for target in crawl_targets:
    raw_records = crawler.search(
        query=target["query"],
        url=f"https://old.tcmsp.com/tcmspsearch.php?term={target['query']}",
        task_id=task.task_id,
    )
    crawl_records.extend(raw_records)
# 爬虫记录传递给 parse 阶段，由 LLM 提取结构化字段
records.extend(crawl_records)
```

### 方式 B：Playwright 浏览器自动化

适用于需要 JS 渲染或登录的站点。

```bash
pip install playwright
playwright install chromium
```

```python
# backend/app/tools/browser_agent.py
from playwright.async_api import async_playwright

async def crawl_with_browser(url: str, query: str) -> list[dict]:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.goto(url)
        # 等待动态内容加载
        await page.wait_for_selector(".result-item")
        # 截图（供 LLM 视觉理解）或提取 HTML
        html = await page.content()
        screenshot = await page.screenshot()
        await browser.close()
        # 输出 raw 格式，供 LLM 提取
        return [{
            "crawl_source": "browser",
            "raw_type": "screenshot",
            "raw_content": screenshot,  # base64
            "url": url,
            "query": query,
        }]
```

### 方式 C：外部 MCP/Agent Browser 服务

适用于已有浏览器 MCP 工具的场景。通过 HTTP/WebSocket 调用外部服务。

```python
# backend/app/tools/browser_mcp.py
import httpx

async def crawl_via_mcp(url: str, query: str) -> list[dict]:
    async with httpx.AsyncClient() as client:
        resp = await client.post("http://localhost:9222/crawl", json={
            "url": url,
            "query": query,
            "max_results": 20,
        }, timeout=60)
        return resp.json().get("records", [])
```

## LLM 提取 Agent 对接

爬虫输出的 `raw_content` 需要在 parse 阶段经 LLM 提取为结构化 DataRecord。建议实现：

```python
# backend/app/agents/llm_extractor.py（待实现）
from app.llm.dashscope import DashScopeClient

class LLMExtractor:
    """LLM 数据提取器 — 从爬虫原始文本提取结构化字段。"""

    async def extract(self, raw_record: dict, schema_hint: dict) -> list[dict]:
        """从 raw_content 提取结构化记录。

        Args:
            raw_record: 爬虫输出的 {"raw_content": "...", "query": "...", ...}
            schema_hint: 期望的字段结构，如 {"compound_name": str, "ob": float, ...}
        """
        prompt = f"""从以下网页内容中提取结构化数据。

查询：{raw_record['query']}
网页内容：{raw_record['raw_content'][:3000]}

请提取以下字段，返回 JSON 数组：
{schema_hint}

如果无法提取某字段，设为 null。如果整页无相关数据，返回空数组 []。
"""
        result = await self.llm.chat_json([{"role": "user", "content": prompt}])
        return result if isinstance(result, list) else [result]
```

## 对接检查清单

实现 acquire 阶段时需确保：

- [ ] **隔离性**：爬虫失败不阻塞流水线，异常被 try/except 捕获
- [ ] **限速**：请求间隔 ≥ 2 秒，避免被反爬
- [ ] **User-Agent**：设置合理的 UA，遵循 robots.txt
- [ ] **输出格式**：爬虫输出 `raw_content` 格式（非结构化），由 LLM 后续提取
- [ ] **LLM 提取**：parse 阶段增加 LLM 提取 agent，将 raw_content 转为 DataRecord
- [ ] **溯源**：`source_ref.source_type` 标记为 `crawl`，`extraction_method` 标记为 `llm_extract`
- [ ] **超时**：单次爬取超时 ≤ 60 秒，总阶段超时 ≤ 180 秒

## 已知需要爬虫的数据源

| 数据源 | 原因 | 数据形式 | 备选 API |
|--------|------|----------|----------|
| TCMSP | 接口经常被封禁 | 网页 HTML（化合物/靶点表格） | 无公开 API |
| DrugBank | 需付费账号 | 药物详情页 HTML | OpenTargets (已实现) |
| DisGeNET | v7+ 需 API key | 疾病-基因关联表格 | OpenTargets (已实现) |
| 中医方剂库 | 无 API | 纯文本描述 | 无 |

## 测试

```bash
# 单独测试 web_crawler（实现后）
cd backend
python -c "from app.tools.datasources.web_crawler import WebCrawlerSource; s = WebCrawlerSource(); print(s.search('test', url='https://example.com'))"

# 集成测试：创建任务并观察 acquire 阶段日志
curl -X POST http://localhost:8000/api/v1/tasks \
  -H "Content-Type: application/json" \
  -d '{"research_goal": "黄芩的主要成分"}'
```
