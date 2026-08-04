# SeparateWeb Capture 技能集成规划

> 目的：将 SeparateWeb Capture（网页截图 + UI 元素裁剪 + JSON manifest）能力
> 接入 BioMedQAgent 的 Agent loop，作为图表数据提取与视觉模型降级链的视觉证据
> 采集通道。本文档仅为规划，不含实际代码改动。
>
> 上游技能位置：[separateweb-capture/](../separateweb-capture/)（已复制到仓库根目录）
> 上游 SKILL 说明：[separateweb-capture/skills/separateweb-capture/SKILL.md](../separateweb-capture/skills/separateweb-capture/SKILL.md)
> 项目架构权威：[ARCHITECTURE.md](ARCHITECTURE.md)
> Skill 接口规范：[skills_interface_spec.md](skills_interface_spec.md)

---

## 1. SeparateWeb Capture 技能技术细节

### 1.1 上游技能能力概览

| 维度 | 内容 |
|---|---|
| 名称 | separateweb-capture v1.1.2（MIT, AUN-PN） |
| 运行时 | Node.js ≥18，依赖 `playwright@1.60.0` + `sharp@0.34.5` |
| 入口脚本 | `scripts/capture.mjs`（CLI 子命令：`capture` / `patch` / `select` / `create`） |
| 二进制别名 | `separateweb` / `separateweb-capture` |
| 输出形态 | `captures/<jobId>/` 目录：`site-manifest.json` + 每页 `full-page.png` + `manifest.json` + `items/<kind>/*.png` |
| 产物分组 | 按元素类型组织：`button` / `card` / `badge` / `media` / `icon` / `navigation` / `panel` / `stat` / `price` / `card-large` 等 |
| 双版本产物 | `with-text/` 与 `without-text/` 两套裁剪图，manifest 同时记录两套路径 |
| 抓取策略 | 同源 crawl（默认） / 单页（`--single`） / 强制全站（`--all`） |
| 关键参数 | `--out <dir>` `--width <px>` `--height <px>` `--max-pages <n>`（1–200） |

### 1.2 输出目录结构（上游约定）

```text
captures/<jobId>/
|-- site-manifest.json              # 全站元数据
|-- page-001-<slug>/
|   |-- full-page.png               # 全页截图
|   |-- manifest.json               # 本页元素清单
|   |-- with-text/
|   |   |-- items/<kind>/*.png      # 带文字裁剪
|   `-- without-text/
|       `-- items/<kind>/*.png      # 无文字裁剪
`-- page-002-<slug>/ ...
```

单页模式（`--single`）下，`full-page.png` / `manifest.json` / `items/<kind>/*.png` 直接置于 `<jobId>/` 下，无 `page-NNN-<slug>/` 中间层。

### 1.3 上游 SKILL.md 的调用契约

```bash
npx separateweb-capture capture <url> [--single|--all] [--out <dir>] \
  [--width <px>] [--height <px>] [--max-pages <n>]
npx separateweb-capture patch <dir>          # 设置默认输出根
npx separateweb-capture select <manifest>    # 交互式选择
npx separateweb-capture create <manifest> --items 1,3,5 --path <dir>
```

执行后必须报告：`Captured` / `Manifest` / `Blocks` / 失败原因。

### 1.4 上游技能的局限

1. **Node.js 运行时**：BioMedQAgent 后端为 Python 3.12+，无 Node.js 依赖；
2. **目录约定与任务隔离冲突**：上游用 `captures/<jobId>/`，需映射到 `data/output/tasks/<task_id>/source_assets/figures/`；
3. **元素裁剪偏 UI 设计参考**：`button/card/badge` 等分类对生物医学数据抽取价值有限，**全页截图 + 图表区域裁剪** 才是核心价值；
4. **无 provenance 写入**：上游只产 PNG + manifest，不写 `SourceRecord` / `SourceAsset` / `download_log`；
5. **无限速/无 stealth**：上游 Playwright 配置未包含项目硬约束（`BROWSER_UA` + `Referer` + 2s 限速 + `STEALTH_JS`，见 project_memory L11）。

---

## 2. BioMedQAgent 当前架构关键点

### 2.1 Agent loop 与 Skill 接入路径

```text
build_agent(databases)                      # app/agent_loop/agent.py:177
  → _import_skill_modules()                # app/tools/_registry.py:31
      → 触发 builtin 模块级 skill_registry.register(SkillDef)
  → skill_registry.get_acquisition_skills(databases)
  → build_agent_config(skills)             # 合并 instructions + tools
  → tools.extend([run_research_pipeline, read_file, write_file, list_files])
  → Agent(instructions=..., tools=unique_tools, model=LazyDashScopeModel)
```

- 所有 Skill 通过模块级副作用注册到全局 `skill_registry`；
- Skill 模块必须在 [app/tools/_registry.py](../backend/app/tools/_registry.py) 的 `BUILTIN_SKILL_MODULES` 列表中显式追加才会被加载；
- Skill 通过 `@function_tool` 装饰器暴露工具，第一个参数必须是 `ctx: RunContextWrapper[RunContext]`，返回 `str`（JSON）。

### 2.2 RunContext 共享状态

[app/agent_loop/context.py](../backend/app/agent_loop/context.py) 定义任务级共享状态，工具通过 `ctx.context` 访问：

- `task_id` / `work_dir`：任务隔离目录，提供 8 个固定子目录（`source_assets/` / `download_tmp/` / `parsed/` / `normalized/` / `staging/` / `artifacts/` / `state/` / `logs/`）；
- `sources` / `raw_assets` / `parsed_datasets` / `artifacts`：路径列表，工具必须显式注册；
- `query_log`：所有检索必须调用 `log_query()`；
- `add_source()` / `add_raw_asset()` / `add_warning()`：副作用注册方法；
- `emit_progress()`：发射 `StageProgressPayload`，前端实时可见（docs/REVIEW_2026-07-18.md §4）。

### 2.3 已有的视觉相关基础设施

| 能力 | 位置 | 与本技能的关联 |
|---|---|---|
| Playwright Python 绑定 | [app/tools/crawler.py](../backend/app/tools/crawler.py) `playwright_fetch` | 已有 Chromium + stealth + networkidle + 2s 限速，可直接复用 |
| 真实浏览器 UA + Referer + Accept | `BROWSER_HEADERS` | 必须复用以满足 project_memory L11 硬约束 |
| 三级降级链 | `fetch_with_fallback` | 抓页面时优先 API → httpx → Playwright，避免无谓截图 |
| DashScope OpenAI 兼容端点 | [app/agent_loop/model.py](../backend/app/agent_loop/model.py) | 可调用 `qwen-vl-max` 做图表数据提取 |
| 任务目录隔离 | `TaskWorkDir.source_asset_file()` | 截图必须落在 `source_assets/figures/` 子目录 |
| SourceAsset 契约 | `domain/contracts/source.py` | 截图必须注册为 `SourceAsset(data_level=METADATA)` |
| 图表数据提取 TODO | [TODO.md](TODO.md) §5.2 | 本技能是 §5.2 视觉模型降级链的输入采集通道 |

### 2.4 Pipeline 与 Agent 的边界

- **正式 CSV 产物必须经 Pipeline + Validation Gate**（[ARCHITECTURE.md](ARCHITECTURE.md) §2.1）；
- Agent **不能直接拼装** `main_data.csv`，但可以使用任意 Skill 工具采集证据；
- 本技能定位为 **采集通道**（产出 `SourceAsset`），不直接产 CSV；CSV 由后续 processing skill（如 `extract_chart_data_vlm`，TODO §5.2）消费 `SourceAsset` 后产 `chart_data.csv` + `chart_data_points.csv`。

---

## 3. 集成方案对比

### 3.1 Option A：subprocess 包裹上游 Node.js 脚本

**思路**：保留 `separateweb-capture/scripts/capture.mjs` 原样，Python 侧用 `subprocess.run(["node", ...])` 调用，解析 stdout 与 `manifest.json`。

| 优点 | 缺点 |
|---|---|
| 复用上游元素检测启发式与裁剪逻辑 | 引入 Node.js 运行时依赖，破坏 Python-only 后端约定 |
| 上游升级时可直接同步 | `sharp` 与 `playwright` 同时安装两套（Node + Python），磁盘与 CI 复杂度上升 |
| 工作量最小 | 任务隔离需要把 `captures/<jobId>/` 重定向到 `task_workdir/source_assets/figures/`，需要 patch 上游 `--out` 行为 |
| | 上游无 stealth/限速/UA/Referer，违反 project_memory L11 硬约束 |
| | subprocess 启动开销大，与 BrowserPool（TODO §8.6）冲突 |

### 3.2 Option B：Python 原生实现（推荐）

**思路**：用项目已有的 `playwright` Python 绑定做全页截图与元素裁剪，用 `Pillow` 替代 `sharp`，复用 `BROWSER_HEADERS` / `STEALTH_JS` / `RateLimiter`。

| 优点 | 缺点 |
|---|---|
| 与 Python-only 后端约定一致 | 需重新实现上游的元素检测启发式（`<button>` / `<card>` / `<badge>` 等分类规则） |
| 复用 `crawler.py` 的 stealth/限速/UA | 工作量略高于 Option A |
| 与未来 BrowserPool（TODO §8.6）天然兼容 | |
| 与 `acquire_source()` / `SourceAsset` 契约直接对接 | |
| 与 Qwen-VL 视觉模型调用同语言（Python） | |

### 3.3 推荐：Option B

理由：
1. **架构一致性**：BioMedQAgent 后端为 Python-only，AGENTS.md §1 明确"Package Manager (BE): uv"，未提及 Node.js；
2. **依赖收敛**：项目已用 `playwright` Python 绑定（[pyproject.toml](../backend/pyproject.toml) + `crawler.py`），仅需新增 `Pillow` 做图像裁剪；
3. **硬约束满足**：可直接复用 `BROWSER_HEADERS` / `STEALTH_JS` / `_rate_limiter`，无需在 Node 侧重新实现；
4. **未来扩展**：TODO §8.6 已规划 `BrowserPool`，Python 原生实现可直接受益；
5. **生物医学场景聚焦**：上游的 UI 元素分类（button/card/badge）对生物医学价值有限，**全页截图 + 图表区域裁剪** 才是核心需求，Python 重实现时可裁剪这部分能力。

---

## 4. 推荐方案：Python 原生实现

### 4.1 Skill 定位

- **名称**：`web_visual_capture`
- **类别**：`SkillCategory.ACQUISITION`（产出图像 `SourceAsset`，与 `browser_fallback` 同类）
- **supported_sources**：`["web", "browser_fallback", "visual_capture"]`
- **tools**：`capture_web_page`（单页截图）+ `capture_page_section`（DOM 选择器裁剪，可选）

### 4.2 Skill 文件位置

```text
backend/app/skills/builtin/acquisition/web_visual_capture.py
```

并在 [app/tools/_registry.py](../backend/app/tools/_registry.py) 的 `BUILTIN_SKILL_MODULES` 追加：

```python
"app.skills.builtin.acquisition.web_visual_capture",
```

### 4.3 Function Tool 签名（规划）

```python
@function_tool
async def capture_web_page(
    ctx: RunContextWrapper[RunContext],
    url: str,
    *,
    full_page: bool = True,
    viewport_width: int = 1920,
    viewport_height: int = 1080,
    wait_until: str = "networkidle",
    selector: str | None = None,        # CSS 选择器，仅截该元素
    label: str | None = None,           # 文件命名标签（如 "pubmed_34180400"）
) -> str:
    """Capture a web page (or a sub-section) into a PNG screenshot registered
    as a SourceAsset under task_workdir/source_assets/figures/.

    Use this tool when:
    - A biomedical database page contains figures/tables you need to extract
      visually (the image will be passed to extract_chart_data_vlm).
    - API-based acquisition failed and you need a visual fallback for
      structural data (e.g., JS-rendered tables).
    - You need visual evidence for provenance (e.g., screenshot of the
      accession page for a dataset).

    The screenshot is registered as SourceAsset(data_level=METADATA) with
    mime_type=image/png, and added to RunContext.raw_assets + sources.
    """
```

### 4.4 RunContext 扩展（可选）

当前 `RunContext` 无专门的"图像资产"字段。复用现有字段即可：
- `raw_assets`：截图 PNG 绝对路径
- `sources`：`SourceRecord(database=Database.BROWSER, accession=label, url=url, ...)`
- `query_log`：`log_query(url, "web_visual_capture", "succeeded"|"failed", 1|0)`

无需扩展 RunContext 字段。**保持最小改动**（AGENTS.md §6 最小实现原则）。

### 4.5 任务目录布局

截图落在 `source_assets/figures/` 子目录，与 TODO §5.2 要求一致：

```text
data/output/tasks/<task_id>/
|-- source_assets/
|   |-- figures/                         # 本技能产出
|   |   |-- fig_<sha256[:12]>.png       # 内容寻址命名（避免重名）
|   |   `-- fig_<sha256[:12]>_meta.json # 单图元数据（url/viewport/label/captured_at）
|   `-- ...                              # 其他 acquire_source 产物
|-- parsed/
|   `-- chart_data/                      # extract_chart_data_vlm 产出
|       |-- chart_data.csv
|       `-- chart_data_points.csv
`-- ...
```

### 4.6 数据流

```text
Agent 调用 capture_web_page(url="https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE178352")
   │
   ▼
web_visual_capture.py
   │  1. 调用 crawler._rate_limiter.wait()                # 2s 限速
   │  2. playwright_fetch(url, wait_until="networkidle")   # 复用 stealth/UA
   │  3. page.screenshot(full_page=True, path=tmp_path)    # Python Playwright API
   │  4. 计算 sha256，重命名为 fig_<sha256[:12]>.png
   │  5. 原子 publish 到 source_assets/figures/
   │  6. acquire_source() 注册 SourceAsset(data_level=METADATA, media_type="image/png")
   │  7. run_ctx.add_source(SourceRecord(database=Database.BROWSER, ...))
   │  8. run_ctx.add_raw_asset(str(final_path))
   │  9. run_ctx.log_query(url, "web_visual_capture", "succeeded", 1)
   │ 10. await run_ctx.emit_progress(StageName.ACQUISITION,
   │                                 kind="captured_screenshot",
   │                                 current=1, total=1,
   │                                 detail={"url": url, "label": label})
   ▼
返回 JSON:
{
  "source": "web_visual_capture",
  "url": "https://...",
  "local_files": [".../source_assets/figures/fig_abc123def456.png"],
  "asset_id": "asset_<sha256>",
  "sha256": "<sha256>",
  "size_bytes": <int>,
  "viewport": {"width": 1920, "height": 1080},
  "captured_at": "<ISO 8601 UTC>",
  "label": "geo_GSE178352"
}
   │
   ▼
Agent 决策：
   - 若 URL 是 GEO/PubMed 等已有结构化 API 的来源 → 优先用 API；截图仅作 provenance
   - 若 URL 是 JS-heavy 页面（如 Reactome pathway viewer）→ 截图作为主要数据源
   - 若页含图表 → 后续调用 extract_chart_data_vlm(image_path=...)
```

---

## 5. 视觉模型集成路径

### 5.1 Qwen-VL 调用契约

参考 TODO §5.2 与 [docs/legacy_skill_reference.md](legacy_skill_reference.md) §21（v0 已有可参考实现）：

- 模型：`qwen-vl-max`（DashScope OpenAI 兼容端点）
- 输入：图片 base64 编码 + 提示词
- 输出：严格 JSON（`chart_type` / `axes` / `data_points` / `legend`）
- 调用方式：复用 [app/agent_loop/model.py](../backend/app/agent_loop/model.py) 的 `AsyncOpenAI` 客户端，但需新增第二个模型实例（`model_name="qwen-vl-max"`）

### 5.2 图片 → JSON → CSV 转换链

```text
[web_visual_capture]                  [extract_chart_data_vlm]              [Pipeline artifact_build]
   │                                       │                                      │
   ▼                                       ▼                                      ▼
source_assets/figures/                 读取 PNG → base64                       chart_data.csv
  fig_abc.png                          → qwen-vl-max                          chart_data_points.csv
                                       → 严格 JSON
                                       → 写入 parsed/chart_data/
                                       → 注册为 ParsedDataset
```

### 5.3 extract_chart_data_vlm 工具签名（规划，待 TODO §5.2 落地）

```python
@function_tool
async def extract_chart_data_vlm(
    ctx: RunContextWrapper[RunContext],
    image_path: str,                    # capture_web_page 返回的 local_files[*]
    hint: str = "",                     # 可选提示（如 "scatter plot, log scale"）
) -> str:
    """Extract structured chart data from an image using Qwen-VL.

    Returns JSON with chart_type / axes / data_points / legend.
    Saves chart_data.csv + chart_data_points.csv to task_workdir/parsed/chart_data/.
    """
```

### 5.4 视觉模型的多种消费场景

| 场景 | 输入 | 输出 | 后续处理 |
|---|---|---|---|
| 论文图表数据提取 | 论文 PDF 中提取的图片 / 网页截图 | `chart_data.csv` + `chart_data_points.csv` | 进入 `main_data.csv` 或独立 artifact |
| JS-heavy 表格识别 | Reactome/UniProt 等动态渲染页面截图 | 表格 JSON | 转 `parsed/*.csv` |
| 数据库页面元数据补全 | GEO accession 页面截图 | 文本摘要（标题/摘要/平台等） | 补全 `dataset_catalog.csv` |
| 来源 provenance 证据 | 任意 URL 截图 | 仅作 SourceAsset 保存 | 写入 `source_assets.csv` 与 `download_log.csv` |

---

## 6. 接口设计细节

### 6.1 与 Agent loop 的交互

- **何时调用**：Agent 在 INSTRUCTIONS 中获得指导，当 API 失败、需要视觉证据、或目标 URL 是 JS-heavy 页面时调用 `capture_web_page`；
- **调用频率**：受 `_rate_limiter` 全局限速（2s），与 `browser_fallback` / `reactome` / `pubchem` 等共享；
- **失败重试**：本技能不重试（避免触发反爬），失败时返回 `{"error": "..."}` JSON，由 Agent 决策；
- **与 Pipeline 的关系**：本技能 **不进入 Pipeline 五阶段**，仅作为 Agent 自由调用的采集工具；产出的 `SourceAsset` 在 Pipeline `acquisition` 阶段被识别并纳入 `source_assets.csv`。

### 6.2 Agent INSTRUCTIONS 增补段落（规划）

在 [app/agent_loop/agent.py](../backend/app/agent_loop/agent.py) 的 `INSTRUCTIONS` 末尾追加：

```text
## 视觉证据采集策略
- 当目标 URL 是 JS-heavy 页面（Reactome pathway viewer / UniProt feature viewer /
  OpenTargets / ChEMBL）且 API 失败时，调用 `capture_web_page` 截图作为视觉证据。
- 当需要从论文图表中提取结构化数据时：
  1. 调用 `capture_web_page` 或 `download_supplementary` 获取图片
  2. 调用 `extract_chart_data_vlm` 用 Qwen-VL 提取 chart_type / data_points
- 截图会注册为 SourceAsset(data_level=METADATA)，进入 source_assets.csv 与
  download_log.csv，作为来源追溯证据。
- 不要为已经有结构化 API 的来源（如 PubMed E-utilities / GEO ESummary）截图，
  除非用户明确要求视觉 provenance。
```

### 6.3 与 browser_fallback 的边界

| 工具 | 主要产出 | 适用场景 |
|---|---|---|
| `navigate_page` (browser_fallback) | HTML 文本（BeautifulSoup 解析） | 需要从页面提取文本/链接，作为 API 失败的语义降级 |
| `download_from_page` (browser_fallback) | 二进制文件（PDF/SDF/TSV） | 已知 URL 的文件下载 |
| `capture_web_page` (web_visual_capture, 新增) | PNG 截图 | 需要视觉证据、图表提取、JS-heavy 表格识别 |

三者**互补**，不互相替代。`browser_fallback` 关注文本/文件，`web_visual_capture` 关注视觉。

---

## 7. 并发与资源管理

### 7.1 BrowserPool 复用

本技能的 Playwright 调用必须复用 [app/tools/crawler.py](../backend/app/tools/crawler.py) 的浏览器实例。当前 `playwright_fetch` 每次调用新建 browser + context，已规划在 TODO §8.6 引入 `BrowserPool`：

- 短期：本技能沿用 `playwright_fetch` 模式，每次新建 browser，通过 `_rate_limiter` 串行；
- 中期：随 TODO §8.6 落地 `BrowserPool`，本技能自动受益；
- 限制：同一 task 内的截图调用串行（受 `_rate_limiter` 限制），跨 task 并发由 `RUNTIME_MAX_ACTIVE_RUNS=4` 控制。

### 7.2 截图大小限制

- `viewport_width` / `viewport_height` 上限 1920×1080，禁止超过（避免内存爆炸）；
- `full_page=True` 时无高度上限，但单图大小超过 10MB 时发射 `WarningPayload(code="screenshot_oversize")`；
- 失败模式：Playwright 超时（默认 60s）→ 返回 JSON `{"error": "timeout"}`，不抛异常给 SDK。

### 7.3 路径安全

- 截图文件名必须为 `fig_<sha256[:12]>.png`，不接受用户控制的文件名；
- 落地路径必须通过 `work_dir.source_asset_file(f"figures/fig_{sha[:12]}.png")` 校验，禁止 `..` 路径逃逸（[app/tools/workdir.py](../backend/app/tools/workdir.py) 的 `_safe_child` 已实现）。

---

## 8. 错误处理与 provenance

### 8.1 错误处理模板（遵循 skills_interface_spec.md §7）

```python
@function_tool
async def capture_web_page(ctx, url, ...):
    run_ctx: RunContext = ctx.context
    try:
        # ... playwright_fetch + screenshot + sha256 + acquire_source ...
        run_ctx.log_query(url, "web_visual_capture", "succeeded", 1)
        return json.dumps({...}, ensure_ascii=False)
    except Exception as exc:
        run_ctx.log_query(url, "web_visual_capture", "failed", 0)
        run_ctx.add_warning(
            severity="warning",
            message=f"capture failed for {url}: {exc}",
            source="web_visual_capture",
        )
        return json.dumps({
            "source": "web_visual_capture",
            "url": url,
            "error": str(exc),
        }, ensure_ascii=False)
```

### 8.2 Provenance 写入

每次成功截图必须完成以下副作用（顺序不可颠倒）：

1. **`acquire_source()`** 调用 → 产出 `SourceAsset(data_level=DataLevel.METADATA, media_type="image/png")`，写入 `download_log.csv` 与 `source_assets.csv`；
2. **`run_ctx.add_source(SourceRecord(database=Database.BROWSER, accession=label or url, url=url, ...))`**；
3. **`run_ctx.add_raw_asset(str(final_path))`**；
4. **`run_ctx.log_query(url, "web_visual_capture", "succeeded", 1)`**；
5. **`await run_ctx.emit_progress(StageName.ACQUISITION, kind="captured_screenshot", ...)`**。

### 8.3 与 download_log.csv 的关系

本技能产出的截图不是"原始数据下载"，而是"派生视觉证据"，因此：
- 在 `download_log.csv` 中标注 `attempt_type="screenshot"`（需要扩展 DownloadAttempt 字段，或在 `error_message` 中标注）；
- `data_level=METADATA` 明确区分于 `RAW_SEQUENCE` / `SUBMITTER_PROCESSED`；
- `bytes_received` 字段填写 PNG 文件大小。

---

## 9. 测试策略

### 9.1 单元测试

文件：`backend/tests/test_skill_web_visual_capture.py`

| 测试 | 验证点 |
|---|---|
| `test_capture_web_page_success` | mock `playwright_fetch`，验证 PNG 写入、SourceAsset 注册、JSON 返回 |
| `test_capture_web_page_failure` | mock 抛 `CrawlError`，验证返回 `{"error": ...}` + `log_query(status="failed")` |
| `test_capture_web_page_oversize_warning` | mock PNG >10MB，验证发射 `WarningPayload(code="screenshot_oversize")` |
| `test_capture_web_page_path_safety` | 验证 `label` 含 `..` / `/` / `\` 时被拒绝 |
| `test_capture_web_page_rate_limit` | 验证调用 `_rate_limiter.wait()` |
| `test_capture_web_page_progress_event` | 验证 `emit_progress` 被调用，前端 reducer 可见 |

### 9.2 集成测试

文件：`backend/tests/integration/test_web_visual_capture_pipeline.py`

- 验证 `acquire_source()` 完整链路：截图 → SourceAsset → `source_assets.csv` → `download_log.csv`；
- 验证 `RunContext.raw_assets` 包含截图路径；
- 验证后续 `extract_chart_data_vlm` 可读取该路径。

### 9.3 Live 测试

文件：`backend/tests/live/test_web_visual_capture_live.py`（标记 `@pytest.mark.live`）

- 对 `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE178352` 真实截图；
- 验证 PNG 可被 Pillow 打开、尺寸 > 100×100、SHA-256 稳定；
- 不在默认 pytest 中运行（`-m live`）。

### 9.4 质量门禁

按 AGENTS.md §7.3：
- `uv run pytest` 全绿；
- `uv run ruff check app/ tests/ launcher.py` 0 错；
- `uv run uvicorn app.main:app --reload` 启动正常；
- 前端无改动（本技能为纯后端）。

---

## 10. 分阶段实施

### 阶段 1：MVP（Python 原生 capture_web_page）

- [ ] 新增 `backend/app/skills/builtin/acquisition/web_visual_capture.py`
- [ ] 实现 `capture_web_page` function_tool（单页截图，无 DOM 裁剪）
- [ ] 复用 `playwright_fetch` + `BROWSER_HEADERS` + `_rate_limiter`
- [ ] 调用 `acquire_source()` 注册 SourceAsset
- [ ] 在 `_registry.py` 的 `BUILTIN_SKILL_MODULES` 追加模块
- [ ] 在 `agent.py` 的 `INSTRUCTIONS` 追加视觉证据采集策略段落
- [ ] 单元测试 + live 测试
- [ ] 质量门禁通过 + 合并到 main

### 阶段 2：DOM 选择器裁剪（capture_page_section）

- [ ] 扩展 `capture_web_page` 支持 `selector` 参数，仅截该元素
- [ ] 用于精确截取论文图表区域（`<figure>` / `<img>` / `<table>`）
- [ ] 单元测试覆盖 selector 不存在 / 多个匹配 / 跨域 iframe 等边界

### 阶段 3：与 extract_chart_data_vlm 联调（依赖 TODO §5.2）

- [ ] `extract_chart_data_vlm` 接受 `capture_web_page` 返回的 `image_path`
- [ ] 集成测试：capture → VLM → CSV 完整链路
- [ ] 新增 `chart_data.csv` / `chart_data_points.csv` artifact（由 Pipeline `artifact_build` 阶段产出，不由本技能产出）

### 阶段 4：BrowserPool 接入（依赖 TODO §8.6）

- [ ] 随 `crawler.py` 的 `BrowserPool` 落地，本技能切换为 `pool.acquire_context()`
- [ ] 验证 4 并发 task 共享单 Chromium 实例
- [ ] 监控内存峰值与截图延迟

### 阶段 5：可选 - 元素裁剪（对标上游 items/<kind>/*.png）

- [ ] 评估是否需要复刻上游的 `button/card/badge` 元素分类
- [ ] 若需要，用 BeautifulSoup + getBoundingClientRect 实现等价能力
- [ ] 仅在确实有 UI 参考需求时实施（生物医学场景优先级低）

---

## 11. 风险与开放问题

### 11.1 已识别风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| Playwright 在 CI 无 Chromium | 测试无法运行 | 已有处理（crawler.py 的 `CrawlError`），单测全 mock |
| 截图文件过大污染 git | 仓库膨胀 | `.gitignore` 排除 `data/output/tasks/`；fixture 测试用小图 |
| 反爬识别 headless | 截图被拒 | 已有 `STEALTH_JS` + `BROWSER_UA` + `Referer` + 2s 限速 |
| Qwen-VL 配额耗尽 | 图表提取失败 | 三级降级链（TODO §5.2）：VL → pdfplumber OCR → caption 文本 |
| 截图不属于"原始数据"被 validation 拒绝 | SourceAsset 注册失败 | `data_level=METADATA` 明确标注；validation.py 不应拒绝 METADATA 资产 |
| 任务超时（TOTAL_TIMEOUT=300s） | 截图挤占 pipeline 预算 | 单截图 60s 上限；Agent 控制调用次数（INSTRUCTIONS 指导） |

### 11.2 待用户决策的开放问题

1. **是否复刻上游元素裁剪能力（button/card/badge 分类）**？
   - 推荐答案：**否**。生物医学场景核心需求是全页截图 + 图表区域裁剪，UI 元素分类价值低。
2. **截图是否计入 `main_data.csv` 的 `source_id` 外键**？
   - 推荐答案：**不计入**。截图是 `METADATA` 资产，仅作 provenance 与图表提取输入；`main_data.csv` 仅引用 `RAW_SEQUENCE` / `SUBMITTER_PROCESSED` / `REPOSITORY_PROCESSED` 资产。
3. **是否需要在前端展示截图**？
   - 推荐答案：**阶段 1 不做**。截图通过 Artifact API 已可下载；前端展示待 TODO §4.1 字段说明视图落地后一并考虑。
4. **`extract_chart_data_vlm` 是否与本技能同步落地**？
   - 推荐答案：**否**。本技能先落地，提供 `SourceAsset`；`extract_chart_data_vlm` 按 TODO §5.2 节奏独立推进。
5. **是否同时保留 Option A（subprocess 包裹 Node 脚本）作为后备**？
   - 推荐答案：**否**。维护两套实现成本高；若 Python 实现遭遇无法解决的上游启发式缺失，再评估。

---

## 12. 与现有文档的同步

本规划落地后需同步更新：

- [ ] [docs/ARCHITECTURE.md](ARCHITECTURE.md) §2.3 Skill 仓库表追加 `web_visual_capture`
- [ ] [docs/skills_interface_spec.md](skills_interface_spec.md) §11 特殊 Skill 说明追加 `web_visual_capture`
- [ ] [docs/TODO.md](TODO.md) §5.2 图表数据提取条目关联本技能
- [ ] [AGENTS.md](../AGENTS.md) §2 不变（Skill 仓库结构未变）
- [ ] [backend/app/agent_loop/agent.py](../backend/app/agent_loop/agent.py) INSTRUCTIONS 段落增补
- [ ] [backend/app/tools/_registry.py](../backend/app/tools/_registry.py) `BUILTIN_SKILL_MODULES` 追加

---

## 13. 总结

本规划的核心结论：

1. **采用 Option B（Python 原生实现）**，新增 `web_visual_capture` skill，工具 `capture_web_page`；
2. **复用 `crawler.py` 的 Playwright + stealth + 限速**，新增 `Pillow` 做图像处理（仅阶段 2/5 需要）；
3. **产出 `SourceAsset(data_level=METADATA)`**，与 `acquire_source()` 契约对齐，进入 `source_assets.csv` 与 `download_log.csv`；
4. **不进入 Pipeline 五阶段**，仅作为 Agent 自由调用的采集工具；
5. **与 `extract_chart_data_vlm`（TODO §5.2）解耦**，本技能先落地，VLM 提取按 TODO 节奏推进；
6. **分 5 阶段实施**，阶段 1 即可提供 MVP 价值（视觉 provenance + JS-heavy 页面证据）。

待用户确认本规划后，再进入实施阶段。

---

## 14. 独立性核验（移除上游 skill 后的运行能力）

> 目的：确认移除 `separateweb-capture/` 目录后，BioMedQAgent 后端可独立运行，
> 不依赖任何 Node.js 运行时或上游脚本。

### 14.1 上游 skill 实际状态

| 检查项 | 结果 |
|---|---|
| `package.json` 引用 `./scripts/capture.mjs` | ✅ 引用存在 |
| `scripts/capture.mjs` 实际存在 | ❌ **缺失**（`Glob separateweb-capture/**/*.mjs` 返回 0 文件） |
| `scripts/lib/*.mjs` 实际存在 | ❌ **缺失** |
| `package.json` 的 `files` 字段声明含 `scripts` | ✅ 声明但未实际打包 |
| 上游 skill 可运行性 | ❌ **本工作区中无法运行**（即使有 Node.js） |

**结论**：上游 skill 在当前工作区本就不可执行，移除它对运行能力零影响。

### 14.2 上游依赖 vs Python 端能力对照

| 上游依赖 | 用途 | Python 端能力 | 状态 |
|---|---|---|---|
| `playwright@1.60.0` (Node) | 浏览器自动化 | `playwright>=1.40.0` (Python) 已在 `pyproject.toml` | ✅ 已具备 |
| `sharp@0.34.5` (Node) | 图像裁剪/缩放 | `Pillow`（可选，阶段 2+ 引入） | ⚠️ 阶段 1 不需要 |

### 14.3 上游功能 vs Python 端实现对照

| 上游功能 | 实现位置 | Python 端实现 | 状态 |
|---|---|---|---|
| 打开网页 | `capture.mjs` Playwright | `crawler.py:playwright_fetch` | ✅ 已具备 |
| 真实浏览器 UA | 上游未配置 | `BROWSER_UA` (Chrome 131) | ✅ 已具备（且优于上游） |
| Referer + Accept 头 | 上游未配置 | `BROWSER_HEADERS` | ✅ 已具备（且优于上游） |
| 反爬 stealth | 上游未配置 | `STEALTH_JS` (webdriver 隐藏) | ✅ 已具备（且优于上游） |
| 2s 限速 | 上游未配置 | `_rate_limiter` (2.0s) | ✅ 已具备（且优于上游） |
| DOM 渲染等待 | 上游 networkidle | `wait_until="networkidle"` | ✅ 已具备 |
| 全页截图 | `page.screenshot` | Playwright Python `page.screenshot()` 原生支持 | ✅ 原生支持（阶段 1 调用） |
| DOM 选择器裁剪 | 上游启发式 | `page.locator(selector).screenshot()` | ✅ 原生支持（阶段 2 调用） |
| 元素分类（button/card） | 上游启发式 | 不复刻（生物医学场景无价值） | ➖ 主动放弃 |
| 双版本产物（with/without text） | 上游 sharp 处理 | 不复刻（无业务需求） | ➖ 主动放弃 |
| site-manifest.json | 上游约定 | 改为 `fig_<sha>.png` + 单图 `_meta.json` | 🔄 重新设计 |
| 路径安全 | 上游无 | `workdir._safe_child` + sha256 命名 | ✅ 已具备（且优于上游） |
| Provenance（SourceAsset） | 上游无 | `acquire_source()` + `download_log.csv` | ✅ 已具备（且优于上游） |

### 14.4 移除上游 skill 的执行清单

实施阶段 1 落地后，可安全执行：

```bash
# 1. 移除上游 skill 目录
rm -rf separateweb-capture/

# 2. 移除 skills-lock.json 中的 separateweb-capture 条目（如有）
# 3. 验证后端独立启动
cd backend
uv run uvicorn app.main:app --reload
curl http://127.0.0.1:8000/api/v1/health  # 应返回 {"status":"ok"}

# 4. 验证 web_visual_capture skill 可用
uv run pytest tests/test_skill_web_visual_capture.py -v
```

### 14.5 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 上游启发式缺失导致元素裁剪能力下降 | 中 | 低 | 阶段 2 用 `page.locator(selector)` 替代，能力等价 |
| `Pillow` 未安装导致阶段 2 失败 | 低 | 低 | 阶段 2 落地时同步更新 `pyproject.toml` |
| 移除上游后 `skills-lock.json` 残留引用 | 低 | 低 | 同步清理 `skills-lock.json` |
| 上游未来版本提供更高价值能力 | 低 | 低 | 规划文档已保留 Option A 评估路径 |

### 14.6 最终结论

**移除 separateweb-capture 后，Python 后端可完全独立运行**：

1. 上游 `scripts/` 目录本就缺失，移除无功能损失；
2. 上游所有运行时依赖（Playwright）Python 端已具备；
3. 上游缺失的硬约束（UA/Referer/stealth/限速/provenance）Python 端已补齐且更优；
4. 阶段 1 MVP 零新依赖（Playwright Python 原生 `page.screenshot()`）；
5. 阶段 2+ 仅需可选 `Pillow` 依赖，明确写入 `pyproject.toml`；
6. 主动放弃的能力（UI 元素分类、双版本产物）对生物医学场景无价值。
