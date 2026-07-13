# Skill 数据接口规范

> 面向 skill 编写者。定义 Skill 注册、Tool 函数签名、数据传输格式和错误处理的统一约定。
>
> 参考实现：[backend/app/skills/builtin/acquisition/geo.py](../backend/app/skills/builtin/acquisition/geo.py)

---

## 1. 架构定位

```text
用户主题
    │
    ▼
Main Agent (OpenAI Agents SDK)
    │  加载 enabled Skill → 合并 instructions + tools
    │  LLM 自主决定调用顺序
    ▼
@function_tool 工具函数
    │  通过 RunContextWrapper[RunContext] 访问任务状态
    │  返回 JSON 字符串
    ▼
确定性 Pipeline (run_research_pipeline)
    │  正式产物必须走 Pipeline + Validation Gate
    ▼
validated artifacts/
```

**核心原则**：
- Skill 是 `instructions 片段 + 工具组合 + 支持的数据源` 的能力包
- Tool 由 SDK 直接执行，无额外引擎
- 正式产物必须通过 `run_research_pipeline` 进入 Pipeline，Skill 不直接拼装最终 CSV

---

## 2. 目录结构

```text
backend/app/skills/
├── __init__.py
├── registry.py              # SkillDef + SkillRegistry + build_agent_config
├── evolution.py             # learned skill 保存/加载引擎
├── builtin/                 # 内置 Skill（随代码发布）
│   ├── discovery/
│   │   ├── pubmed.py        # search_pubmed, download_supplementary
│   │   └── understanding.py # analyze_papers
│   ├── acquisition/
│   │   ├── geo.py           # search_geo, describe_geo, download_geo
│   │   ├── gdc.py
│   │   ├── pdb.py
│   │   ├── xena.py
│   │   ├── reactome.py      # search_reactome, get_pathway（三级降级链）
│   │   ├── pubchem.py       # search_pubchem, get_compound（三级降级链）
│   │   └── browser.py       # browser_fallback（兜底，委托 crawler 层）
│   ├── processing/
│   │   ├── extract_tables.py
│   │   └── self_evolution.py # 元能力（强制加载）
│   └── analysis/
│       └── stats.py
└── learned/                  # Agent 运行中生成的 Skill（默认空）
    ├── discovery/
    ├── acquisition/
    ├── processing/
    └── analysis/
```

### 命名规范

| 项 | 规范 | 示例 |
|---|---|---|
| 文件名 | 小写蛇形，与数据源或能力同名 | `pubmed.py`, `extract_tables.py` |
| SkillDef 实例名 | `<name>_skill` | `pubmed_skill`, `geo_skill` |
| Tool 函数名 | 动词_对象，小写蛇形 | `search_pubmed`, `download_geo` |
| `supported_sources` | 小写，含数据源全称与缩写 | `["geo", "ncbi_geo"]` |

---

## 3. SkillDef 注册规范

### 3.1 SkillDef 字段

定义在 [registry.py](../backend/app/skills/registry.py) L28-72：

```python
@dataclass
class SkillDef:
    name: str                          # 唯一名称
    category: SkillCategory            # DISCOVERY | ACQUISITION | PROCESSING | ANALYSIS
    description: str                   # 供 Agent 判断何时使用
    instructions: str = ""             # 加载时附加给 Agent 的说明片段
    tools: list = field(default_factory=list)  # SDK FunctionTool 实例列表
    supported_sources: list[str] = field(default_factory=list)
    version: str = "0.1.0"
    enabled: bool = True
    input_model: type | None = None    # 可选 pydantic BaseModel
    output_model: type | None = None
    examples: list[dict] = field(default_factory=list)
```

### 3.2 工具数量限制

| 阈值 | 值 | 行为 |
|---|---|---|
| `SUGGESTED_MAX_TOOLS` | 20 | 超过时 logger.warning |
| `HARD_MAX_TOOLS` | 30 | 超过时抛 `ValueError`，注册失败 |

### 3.3 SkillCategory 枚举

```python
class SkillCategory(str, Enum):
    DISCOVERY = "discovery"      # 检索论文、识别数据线索
    ACQUISITION = "acquisition"  # 下载数据文件
    PROCESSING = "processing"    # 解析、清洗、字段对齐
    ANALYSIS = "analysis"        # 统计、可视化（加分项）
```

### 3.4 注册模式

**无装饰器**。模块末尾调用 `skill_registry.register(skill_def)` 触发注册：

```python
from app.skills.registry import SkillCategory, SkillDef, skill_registry

my_skill = SkillDef(
    name="my_source",
    category=SkillCategory.ACQUISITION,
    description="Search and download from MySource database...",
    instructions="Use `search_my_source` to find datasets...",
    tools=[search_my_source, download_my_source],
    supported_sources=["my_source", "ms"],
    version="0.1.0",
)
skill_registry.register(my_skill)
```

### 3.5 agent.py 接入

新 Skill 必须在 [agent.py](../backend/app/agent_loop/agent.py) 的 `_import_skill_modules()` 模块列表中追加：

```python
modules = [
    ...
    "app.skills.builtin.acquisition.my_source",  # 新增
]
```

`_import_skill_modules()` 在 `create_agent()` 调用时触发 import，从而执行模块级 `register()` 副作用。加载失败会 `logger.warning` 但不阻塞 Agent 启动。

---

## 4. Tool 函数签名规范

### 4.1 基本签名

```python
from agents import RunContextWrapper, function_tool
from app.agent_loop.context import RunContext

@function_tool
async def search_my_source(
    ctx: RunContextWrapper[RunContext],
    term: str,
    max_results: int = 20,
) -> str:
    """搜索 MySource 数据库。

    Args:
        term: 检索词。
        max_results: 最大返回条数。

    Returns:
        JSON 字符串，包含 records 列表。
    """
    run_ctx: RunContext = ctx.context
    run_ctx.log_query(term, "my_source", "running", 0)
    # ... 业务逻辑 ...
    return json.dumps({"source": "my_source", "records": [...]}, ensure_ascii=False)
```

### 4.2 硬性约定

| 约定 | 说明 |
|---|---|
| 第一个参数 | 必须是 `ctx: RunContextWrapper[RunContext]`（推荐）或 `RunContextWrapper[Any]` |
| ctx 对 LLM 不可见 | SDK 自动注入，只有后续参数进入工具 schema |
| 返回值类型 | 必须是 `str`（JSON 字符串），`ensure_ascii=False` |
| 异步 | 网络密集型用 `async def`，CPU 密集型用 `def` |
| docstring | 必须有，SDK 据此生成 LLM 可见的工具说明 |

### 4.3 获取 RunContext

```python
run_ctx: RunContext = ctx.context
```

---

## 5. RunContext 访问规范

定义在 [context.py](../backend/app/agent_loop/context.py)。

### 5.1 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `task_id` | `str` | 任务 ID，用于产物目录隔离 |
| `topic` | `str` | 用户研究主题 |
| `preferred_sources` | `list[str]` | 用户允许的数据库列表 |
| `plan` | `str` | Agent 制定的执行计划 |
| `sources` | `list` | 已使用的 SourceRecord 列表 |
| `raw_assets` | `list[str]` | source_assets 目录下的本地文件路径 |
| `parsed_datasets` | `list[str]` | parsed 目录下的解析产物路径 |
| `records` | `list[dict]` | 已采集的 DataRecord 列表 |
| `artifacts` | `list[str]` | 产出物文件路径 |
| `warnings` | `list[dict]` | 警告列表 |
| `query_log` | `list[dict]` | 每次检索的 query/source/status/records_count |

### 5.2 work_dir（任务工作目录）

```python
run_ctx.work_dir  # -> TaskWorkDir
```

提供 8 个固定子目录（定义在 [workdir.py](../backend/app/tools/workdir.py)）：

| 属性 | 路径 | 用途 |
|---|---|---|
| `root` | `data/output/tasks/<task_id>/` | 任务根目录 |
| `source_assets` | `.../source_assets/` | **不可变**来源文件 |
| `download_tmp` | `.../download_tmp/` | 不完整下载 |
| `parsed` | `.../parsed/` | 解析结果 |
| `normalized` | `.../normalized/` | 清洗和字段对齐结果 |
| `staging` | `.../staging/` | 按 run_id 隔离的候选产物 |
| `artifacts` | `.../artifacts/` | 已通过验证的交付物 |
| `state` | `.../state/` | 任务锁和恢复状态 |
| `logs` | `.../logs/` | stage attempts、事件、验证日志 |

安全方法：
- `work_dir.source_asset_file(filename)` — source_assets/ 下的安全子路径
- `work_dir.raw_file(filename)` — `source_assets` 的 deprecated alias

### 5.3 方法

```python
# 记录数据来源
run_ctx.add_source(source_record)

# 记录下载的本地文件
run_ctx.add_raw_asset("/path/to/file")

# 记录警告
run_ctx.add_warning(severity="warning", message="...", source="geo")

# 记录查询日志（每次检索必须调用）
run_ctx.log_query(query="GSE178352[Accession]", source="geo", status="succeeded", records_count=1)
```

---

## 6. 数据传输规范（按类别）

### 6.1 discovery 类 Tool

**职责**：检索论文、识别数据集线索。不生成最终科研数据行。

**返回 JSON 结构**：

```json
{
  "source": "pubmed",
  "query": "breast cancer Hsp70",
  "query_translation": "breast cancer[Title] AND Hsp70[All Fields]",
  "total_count": 14,
  "records": [
    {
      "pmid": "34180400",
      "title": "...",
      "abstract": "...",
      "authors": ["..."],
      "journal": "...",
      "pub_date": "2021-01-15",
      "doi": "10.1234/...",
      "pmcid": "PMC...",
      "is_open_access": true,
      "source_url": "https://pubmed.ncbi.nlm.nih.gov/34180400/"
    }
  ]
}
```

**必填字段**：`source`、`query`/`term`、`records[]`
**可选字段**：`total_count`、`query_translation`、`accessions[]`（顶层汇总）、`error`

### 6.2 acquisition 类 Tool

**职责**：下载和校验数据文件。下载与解析严格分离。

**返回 JSON 结构（标准模式）**：

```json
{
  "source": "pdb",
  "accession": "1AFT",
  "source_url": "https://files.rcsb.org/download/1AFT.pdb",
  "local_files": ["/path/to/1AFT.pdb"],
  "format_hint": "pdb",
  "retrieved_at": "2026-07-13T12:00:00+00:00"
}
```

**返回 JSON 结构（完整 provenance 模式，仅 geo.py 采用）**：

```json
{
  "source": "geo",
  "accession": "GSE178352",
  "source_url": "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE178352",
  "attempt": { "attempt_id": "...", "status": "succeeded", "bytes_received": 4597797, ... },
  "asset": { "asset_id": "asset_...", "sha256": "...", "data_level": "repository_processed", ... },
  "local_files": ["..."],
  "format_hint": "geo_tximport_counts"
}
```

**必填字段**：`source`、`source_url`、`local_files`
**失败时**：追加 `"error": "..."` 字段

**三级降级链扩展字段**（reactome/pubchem 等使用 `fetch_with_fallback()` 的 skill）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `method_used` | `string` | 实际成功的获取方式：`"api"` \| `"httpx"` \| `"crawl"` |
| `tried_methods` | `string[]` | 已尝试的获取方式列表（用于 requires_crawl 信号） |
| `target_url` | `string` | 当返回 requires_crawl 信号时，建议浏览器兜底访问的 URL |

**requires_crawl 信号**（API 和 httpx 均失败时返回）：

```json
{
  "status": "requires_crawl",
  "source": "reactome",
  "reason": "API and httpx both failed",
  "tried_methods": ["api", "httpx"],
  "target_url": "https://reactome.org/ContentService/..."
}
```

LLM 收到此信号后应调用 browser skill 的 `navigate_page` 或 `download_from_page` 进行 Playwright 兜底（见第 12 节 crawler 工具层）。

### 6.3 processing 类 Tool

**职责**：解析、清洗、字段对齐。只接受本地文件路径，不接受 SourceAsset 对象。

**入参约定**：

```python
@function_tool
def extract_my_format(ctx: RunContextWrapper[RunContext], file_path: str) -> str:
    """解析本地文件。"""
```

**返回 JSON 结构**：

```json
{
  "status": "ok",
  "source_file": "/path/to/input",
  "outputs": ["/path/to/parsed/output.csv"],
  "summary": {
    "total_tables": 3,
    "rows_parsed": 1500
  }
}
```

**必填字段**：`status`（`"ok"` | `"error"`）、`source_file`、`outputs[]`
**失败时**：`status` 设为 `"error"`，追加 `"error": "..."`

### 6.4 analysis 类 Tool

**职责**：统计、可视化。输出到 `run_ctx.work_dir.artifacts`。

**入参约定**：接受 `csv_path: str`，不接受 ParsedDataset 对象。

**返回 JSON 结构**：

```json
{
  "status": "ok",
  "source_file": "/path/to/input.csv",
  "outputs": ["/path/to/heatmap.png"],
  "genes_plotted": 50,
  "method": "pearson"
}
```

---

## 7. 错误处理规范

### 7.1 统一原则

**所有错误转 JSON 返回，不抛异常给 SDK。**

Tool 函数体内必须 try/except，捕获所有异常后返回带 `error` 字段的 JSON。

### 7.2 两种错误格式

| 类别 | 格式 | 示例 |
|---|---|---|
| discovery / acquisition | 顶层 `error` 字段 | `{"source": "geo", "accession": "GSE...", "error": "404 not found"}` |
| processing / analysis | `status: "error"` + `error` 字段 | `{"status": "error", "source_file": "...", "error": "invalid PDF"}` |

### 7.3 标准模板

```python
@function_tool
async def download_my_source(ctx: RunContextWrapper[RunContext], accession: str) -> str:
    run_ctx: RunContext = ctx.context
    try:
        # ... 业务逻辑 ...
        run_ctx.log_query(accession, "my_source", "succeeded", 1)
        return json.dumps({
            "source": "my_source",
            "accession": accession,
            "source_url": url,
            "local_files": [str(path)],
            "format_hint": "my_format",
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
        }, ensure_ascii=False)
    except Exception as exc:
        run_ctx.log_query(accession, "my_source", "failed", 0)
        return json.dumps({
            "source": "my_source",
            "accession": accession,
            "error": str(exc),
        }, ensure_ascii=False)
```

### 7.4 副作用要求

| Tool 类别 | 必须调用的 RunContext 方法 |
|---|---|
| discovery（搜索） | `log_query(query, source, status, count)` |
| acquisition（下载） | `log_query(accession, source, status, 0)` + `add_source(record)` + `add_raw_asset(path)` |
| processing（解析） | `parsed_datasets.append(str(output_path))` |
| analysis（分析） | `artifacts.append(str(output_path))` |

---

## 8. 契约层类型速查

### 8.1 两套 SourceRecord

项目中存在两套 SourceRecord，适用场景不同：

| 版本 | 位置 | 类型 | 字段 | 适用场景 |
|---|---|---|---|---|
| 宽松版 | [domain/output.py](../backend/app/domain/output.py) L17-32 | dataclass | `source, accession, source_url, local_files, checksum, mime_type, format_hint, retrieved_at, warnings` | 简单 skill，快速接入 |
| 严格版 | [domain/contracts/source.py](../backend/app/domain/contracts/source.py) L29-35 | pydantic ContractModel | `source_id, database, accession, url, title, retrieved_at` | 完整 provenance 链路，Pipeline 集成 |

**建议**：新 skill 优先用宽松版（`app.domain.output.SourceRecord`）。需要完整 provenance 时用严格版 + `AcquisitionResult`。

### 8.2 宽松版 SourceRecord（推荐新 skill 使用）

```python
from app.domain.output import SourceRecord
from datetime import datetime, timezone

record = SourceRecord(
    source="my_source",
    accession="ABC123",
    source_url="https://...",
    local_files=["/path/to/file"],
    format_hint="my_format",
    retrieved_at=datetime.now(timezone.utc),
)
run_ctx.add_source(record)
```

### 8.3 严格版契约类型（Pipeline 集成时使用）

| 类型 | 关键字段 | 校验规则 |
|---|---|---|
| `SourceRecord` | `source_id, database, accession, url, title, retrieved_at` | 全部必填 |
| `DownloadAttempt` | `attempt_id, source_id, url, status, bytes_received, started_at, finished_at` | SUCCEEDED 不能带 error；非 SUCCEEDED 必须带 error |
| `FileAsset` | `asset_id, kind, relative_path, sha256, size_bytes, media_type` | `asset_id` 必须等于 `asset_{sha256}`；`relative_path` 禁止 `..` 和绝对路径 |
| `SourceAsset` | 继承 FileAsset + `source_id, successful_attempt_id, data_level` | `relative_path` 必须以 `source_assets/` 开头 |
| `AcquisitionResult` | `attempt: DownloadAttempt, asset: SourceAsset \| None` | 成功时必须有 asset，失败时禁止有 asset |
| `SourceLocator` | `asset_id, logical_file, source_line_number, source_column_index, source_column_name, raw_value` | 行号 ≥1，列索引 ≥0 |

### 8.4 关键枚举

```python
from app.domain.contracts import Database, DataLevel, StageName

Database:        PUBMED | GEO | GDC | UCSC_XENA | PDB | REACTOME | PUBCHEM
DataLevel:       RAW_SEQUENCE | SUBMITTER_PROCESSED | REPOSITORY_PROCESSED | METADATA
StageName:       DISCOVERY | ACQUISITION | PROCESSING | ARTIFACT_BUILD | VALIDATION
DownloadStatus:  SUCCEEDED | FAILED | CANCELLED
TaskState:       CREATED | PLANNING | DISCOVERY | ACQUISITION | PROCESSING | BUILDING_ARTIFACTS | VALIDATING | COMPLETED | FAILED | CANCELLED
```

---

## 9. 新 Skill 接入清单

编写一个新 acquisition skill（以 `my_source` 为例）需要完成以下步骤：

- [ ] 1. 创建文件 `backend/app/skills/builtin/acquisition/my_source.py`
- [ ] 2. 实现**一个或多个** `@function_tool` 函数（典型：search + get/download；工具数量取决于数据源特性，不强制为三个。参考 reactome.py/pubchem.py 各 2 个工具）
- [ ] 3. 函数签名第一个参数为 `ctx: RunContextWrapper[RunContext]`，返回 `str`
- [ ] 4. 函数体内 `run_ctx = ctx.context` 获取上下文
- [ ] 5. 搜索类调用 `run_ctx.log_query(...)`，下载类调用 `run_ctx.add_source(...)` + `run_ctx.add_raw_asset(...)`
- [ ] 6. 所有异常 try/except 后返回带 `error` 字段的 JSON
- [ ] 7. 模块末尾定义 `my_source_skill = SkillDef(...)` 并 `skill_registry.register(my_source_skill)`
- [ ] 8. 在 [agent.py](../backend/app/agent_loop/agent.py) 的 `_import_skill_modules()` 模块列表中追加 `"app.skills.builtin.acquisition.my_source"`
- [ ] 9. `uv run pytest` 确认无回归
- [ ] 10. 编写单元测试（可参考 [tests/integration/test_ncbi_skill_adapters.py](../backend/tests/integration/test_ncbi_skill_adapters.py)）

---

## 10. 完整示例

以下是一个最小可运行的 acquisition skill 模板：

```python
"""MySource database integration — search, describe, download."""

from __future__ import annotations

import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.domain.output import SourceRecord
from app.skills.registry import SkillCategory, SkillDef, skill_registry


@function_tool
async def search_my_source(
    ctx: RunContextWrapper[RunContext],
    term: str,
    max_results: int = 20,
) -> str:
    """Search MySource database for datasets matching the term.

    Args:
        term: Search keyword or accession.
        max_results: Maximum number of results to return.

    Returns:
        JSON string with records list.
    """
    run_ctx: RunContext = ctx.context
    try:
        # ... 调用 API ...
        records = [...]  # 业务逻辑
        run_ctx.log_query(term, "my_source", "succeeded", len(records))
        return json.dumps({
            "source": "my_source",
            "term": term,
            "total_count": len(records),
            "records": records,
        }, ensure_ascii=False)
    except Exception as exc:
        run_ctx.log_query(term, "my_source", "failed", 0)
        return json.dumps({
            "source": "my_source",
            "term": term,
            "error": str(exc),
        }, ensure_ascii=False)


@function_tool
async def download_my_source(
    ctx: RunContextWrapper[RunContext],
    accession: str,
    file_type: str = "default",
) -> str:
    """Download a dataset file from MySource.

    Args:
        accession: Dataset accession ID.
        file_type: File type to download.

    Returns:
        JSON string with local file path and metadata.
    """
    run_ctx: RunContext = ctx.context
    try:
        url = f"https://api.mysource.org/{accession}/{file_type}"
        dest = run_ctx.work_dir.source_asset_file(f"{accession}_{file_type}.bin")
        # ... 流式下载 + SHA-256 校验 ...
        urllib.request.urlretrieve(url, dest)

        record = SourceRecord(
            source="my_source",
            accession=accession,
            source_url=url,
            local_files=[str(dest)],
            format_hint=f"my_source_{file_type}",
            retrieved_at=datetime.now(timezone.utc),
        )
        run_ctx.add_source(record)
        run_ctx.add_raw_asset(str(dest))
        run_ctx.log_query(accession, "my_source", "succeeded", 1)

        return json.dumps({
            "source": "my_source",
            "accession": accession,
            "source_url": url,
            "local_files": [str(dest)],
            "format_hint": f"my_source_{file_type}",
            "retrieved_at": record.retrieved_at.isoformat(),
        }, ensure_ascii=False)
    except Exception as exc:
        run_ctx.log_query(accession, "my_source", "failed", 0)
        return json.dumps({
            "source": "my_source",
            "accession": accession,
            "error": str(exc),
        }, ensure_ascii=False)


my_source_skill = SkillDef(
    name="my_source",
    category=SkillCategory.ACQUISITION,
    description="Search, describe, and download datasets from MySource database.",
    instructions=(
        "Use `search_my_source` to find datasets by keyword. "
        "Use `download_my_source` to download files by accession."
    ),
    tools=[search_my_source, download_my_source],
    supported_sources=["my_source", "ms"],
    version="0.1.0",
)
skill_registry.register(my_source_skill)
```

---

## 11. 特殊 Skill 说明

### browser_fallback

- 位置：[builtin/acquisition/browser.py](../backend/app/skills/builtin/acquisition/browser.py)
- 加载方式：在 [agent.py](../backend/app/agent_loop/agent.py) 的 `_import_skill_modules()` 模块列表中与其他 skill 走相同导入路径，无单独强制加载逻辑
- 职责：当所有 API-based acquisition skill 失败时的兜底 HTTP 抓取通道
- 工具：`navigate_page`（浏览页面）、`download_from_page`（流式下载）
- 实现细节：已重构为委托 [app/tools/crawler.py](../backend/app/tools/crawler.py) 层的 `BROWSER_HEADERS`（真实浏览器 UA + Referer + Accept）、`_rate_limiter`（2s 限速）和 `BeautifulSoup`（HTML 解析）。版本 0.2.0

### self_evolution

- 位置：[builtin/processing/self_evolution.py](../backend/app/skills/builtin/processing/self_evolution.py)
- 加载方式：在 `_import_skill_modules()` 模块列表中，无单独强制加载逻辑
- 职责：把成功的浏览器工作流保存为 learned skill，是 self-evolution 闭环入口
- 工具：`save_workflow_as_skill`、`list_my_learned_skills`

### reactome

- 位置：[builtin/acquisition/reactome.py](../backend/app/skills/builtin/acquisition/reactome.py)
- 职责：Reactome 通路数据库的检索与详情查询（非 JS 网站）
- 工具：`search_reactome(term, max_results)`、`get_pathway(pathway_id)`
- 三级降级链：`Reactome ContentService REST API → httpx 页面抓取 → requires_crawl 信号`
- `supported_sources=["reactome"]`，使用 `fetch_with_fallback()` 编排降级

### pubchem

- 位置：[builtin/acquisition/pubchem.py](../backend/app/skills/builtin/acquisition/pubchem.py)
- 职责：PubChem 化合物数据库的检索与详情查询（JS-heavy 网站）
- 工具：`search_pubchem(term, max_results)`、`get_compound(cid)`
- 三级降级链：`PUG-REST API → httpx 页面抓取 → requires_crawl 信号`
- `supported_sources=["pubchem"]`，使用 `fetch_with_fallback()` 编排降级

### learned skill

- 位置：`backend/app/skills/learned/<category>/<name>/`
- 默认禁用，不能绕过 Pipeline 和 Validation Gate
- 通过 [evolution.py](../backend/app/skills/evolution.py) 的 `save_learned_skill()` 自动生成
- 当前未接入 `create_agent()` 的自动加载流程

---

## 12. Crawler 工具层

> 位置：[backend/app/tools/crawler.py](../backend/app/tools/crawler.py)

统一爬虫层,为所有 acquisition skill 提供一致的反爬行为(真实浏览器 UA、Referer、Accept、2s 限速)和三级降级链编排。遵守 project_memory L11 硬约束。

### 12.1 三级降级链

```
api_fetch  →  httpx_fetch  →  playwright_fetch  →  CrawlError
(Tier 1)      (Tier 2)        (Tier 3)
httpx +       httpx +         Playwright Chromium
Accept:       BROWSER_        + STEALTH_JS +
application/  HEADERS         networkidle
json
```

由 `fetch_with_fallback(api_url, page_url, source_name, use_crawl_fallback)` 编排:依次尝试三级,任一成功即返回;全失败抛 `CrawlError`。

### 12.2 核心组件

| 组件 | 说明 |
|---|---|
| `BROWSER_UA` | 真实 Chrome 131 User-Agent 字符串 |
| `BROWSER_HEADERS` | User-Agent + Accept + Accept-Language + Referer 的完整 header dict |
| `STEALTH_JS` | 隐藏 `navigator.webdriver`、`plugins`、`languages` 的 stealth 脚本,注入 Playwright context |
| `RateLimiter` | 2s 限速器,`wait()` 方法保证请求间隔 ≥ 2s(测试中由 conftest.py 全局禁用) |
| `FetchResult` | dataclass,字段:`url, content, status_code, elapsed_ms, method_used, error` |
| `CrawlError` | 所有三级均失败时抛出的异常 |

### 12.3 四个获取函数

| 函数 | 层级 | 实现 | 适用场景 |
|---|---|---|---|
| `api_fetch(url, headers, timeout)` | Tier 1 | httpx + `Accept: application/json`,无 Referer | REST API 端点(Reactome ContentService、PUG-REST) |
| `httpx_fetch(url, headers, timeout)` | Tier 2 | httpx + `BROWSER_HEADERS`(UA/Referer/Accept) | 非 JS 网页抓取,API 不可用时的降级 |
| `playwright_fetch(url, wait_until, timeout)` | Tier 3 | Playwright Chromium + `STEALTH_JS` + `networkidle` | JS-heavy 网站(pubchem/uniprot/chembl),httpx 无法渲染时 |
| `fetch_with_fallback(api_url, page_url, source_name, use_crawl_fallback)` | 编排 | 依次尝试 api → httpx → crawl | skill 工具内部调用,封装降级逻辑 |

### 12.4 project_memory 硬约束遵守

- ✅ 真实浏览器 UA + Referer + Accept + 2s 限速
- ✅ JS-heavy 网站(pubchem/uniprot/chembl/opentargets/cnki/wanfang)用 Playwright + stealth + networkidle
- ✅ 非 JS 网站(reactome/tcmsp/drugbank/disgenet)用 httpx + BeautifulSoup
- ✅ `STEALTH_JS` 隐藏 webdriver 标识

---

## 13. requires_crawl 信号机制

> 位置：[backend/app/tools/crawl_signal.py](../backend/app/tools/crawl_signal.py)

当 API 和 httpx 均失败时,skill 工具返回 `requires_crawl` 信号 JSON,LLM 收到后应调用 browser skill 的 Playwright 兜底。

### 13.1 四个函数

| 函数 | 签名 | 用途 |
|---|---|---|
| `requires_crawl` | `(source, reason, tried_methods, target_url) -> dict` | 生成信号 dict |
| `requires_crawl_json` | `(source, reason, tried_methods, target_url) -> str` | 生成 JSON 字符串(直接 return from @function_tool) |
| `check_requires_crawl` | `(result) -> bool` | 检测结果(dict 或 JSON 字符串)是否为 requires_crawl 信号 |
| `extract_crawl_target` | `(result) -> tuple[str \| None, str \| None]` | 从信号中提取 `(target_url, source)` |

### 13.2 信号 JSON 格式

```json
{
  "status": "requires_crawl",
  "source": "reactome",
  "reason": "API and httpx both failed",
  "tried_methods": ["api", "httpx"],
  "target_url": "https://reactome.org/ContentService/..."
}
```

### 13.3 LLM 兜底流程

1. skill 工具(如 `search_reactome`)调用 `fetch_with_fallback()`,API 和 httpx 均失败
2. skill 工具调用 `requires_crawl_json()` 生成信号并 return
3. LLM 收到 JSON,识别 `status: "requires_crawl"`
4. LLM 调用 browser skill 的 `navigate_page(url=target_url)` 或 `download_from_page(url=target_url, filename=...)`
5. browser skill 内部委托 crawler 层的 `BROWSER_HEADERS` + `_rate_limiter` 完成 Playwright 兜底

### 13.4 使用示例

```python
from app.tools.crawler import fetch_with_fallback, CrawlError
from app.tools.crawl_signal import requires_crawl_json

@function_tool
async def search_my_source(ctx: RunContextWrapper[RunContext], term: str) -> str:
    run_ctx: RunContext = ctx.context
    api_url = f"https://api.mysource.org/search?q={term}"
    page_url = f"https://www.mysource.org/search?q={term}"
    try:
        result = fetch_with_fallback(api_url, page_url, source_name="my_source")
        # ... 解析 result.content ...
        return json.dumps({"source": "my_source", "records": [...]}, ensure_ascii=False)
    except CrawlError:
        run_ctx.log_query(term, "my_source", "failed", 0)
        return requires_crawl_json(
            source="my_source",
            reason="API and httpx both failed",
            tried_methods=["api", "httpx"],
            target_url=page_url,
        )
```
