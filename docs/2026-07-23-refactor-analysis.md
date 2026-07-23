# BioMed-QAgent 重构分析报告（完整版）

> **日期**: 2026-07-23
> **状态**: 本地落后 origin/main 76 commits（无法 pull，网络不通），以下分析基于 diff 统计推断上游变更。
> **本地 HEAD**: `c029efc` | **远程 HEAD**: `37d5d66` (merge: improve find_skill discovery)
> **工作区状态**: 干净（仅 README.md 有未提交修改）

---

## 0. 上游变更同步（76 commits ahead）

> 本节记录 origin/main 相对于本地 HEAD 的变更对审查结论的影响。
> 所有结论基于 `git diff --stat HEAD..origin/main` + commit message 推断。

### 0.1 已在上游解决的审查发现

| 原审查编号 | 问题 | 解决方式 | 证据 |
|-----------|------|---------|------|
| **P0.4** | `SettingsPanel.tsx` 1051 行超大组件 | 已拆分为聚焦子组件 | `SettingsPanel.tsx`: **-997 / +110** 行（从 1051 → ~164） |
| **P1.3** (部分) | `compaction.py` 超长函数 `prepare` (114行) | 已拆分为 6 个子模块 | `compaction.py`: **-511** 行；新增 `compaction_execution.py`, `compaction_fallback.py`, `compaction_history.py`, `compaction_planning.py`, `compaction_reduction.py`, `compaction_summary.py`, `compaction_types.py`（共 +855 行） |
| **P2.2** (部分) | SettingsPanel 硬编码 DEFAULTS | 前端新增 `contextBudget.ts` + `databaseDraft.ts` 专用模块 | 默认值已外提到独立 lib 模块 |

### 0.2 仍存在的审查发现（上游未变更）

| 原审查编号 | 问题 | 状态 |
|-----------|------|------|
| P0.1 | `runner.py:_run_inner` 192 行 | 未变更 |
| P0.2 | `manager.py:333` 静默吞错 | `manager.py` 仅 `+24` 行（admission 新增），未触及异常处理 |
| P0.3 | 前端 `reducer.ts` 1983 行 | 未变更 |
| P0.5 | `tools/io.py` 循环依赖 | 未变更 |
| P1.1 | `gdc/pdb/xena` `_rate_limit` 三份重复 | 未变更 |
| P1.2 | `gdc/pdb/xena` `urllib.request` 封装重复 | 未变更 |
| P1.3 | `_write_csv` 两份重复 | `artifact_build.py` 和 `validation.py` 未变更 |
| P1.6 | `settings_router.py` 死代码 | 未变更 |
| P1.7 | `domain/` 新旧模型并存 | `output.py` / `processing.py` 未变更 |
| P2.1 | 超时值散布 | 未集中化 |
| P2.3 | 前端 `agentSelectors.ts` 未使用导出 | 未变更 |

### 0.3 上游新增模块与潜在关注点

#### 前端新增（`frontend/src/lib/`，+1466 行）

| 新文件 | 行数 | 用途 | 审查状态 |
|--------|------|------|---------|
| `apiResponseParsers.ts` | 251 | API 响应验证与解析器路由 | 新代码，未审查 |
| `apiDeclarativeParsers.ts` | 198 | 声明式 API 解析器拆分 | 新代码，未审查 |
| `apiEnvelopeParsers.ts` | 112 | API 信封解析器 | 新代码，未审查 |
| `contextBudget.ts` | 166 | Context budget 计算 | 新代码，未审查 |
| `databaseDraft.ts` | 163 | 数据库设置 draft 校验 | 新代码，未审查 |
| `eventParsersPipeline.ts` | 156 | Pipeline 事件解析器 | 新代码，未审查 |
| `eventValidatorHelpers.ts` | 120 | 事件校验辅助函数 | 新代码，未审查 |
| `eventParsersRuntime.ts` | 68 | Runtime 事件解析器 | 新代码，未审查 |
| `eventParsers.ts` | 30 | 事件解析器入口 | 新代码，未审查 |

**总计**: 前端新增 1466 行解析/校验代码 + 997 行 SettingsPanel 裁剪 = +469 行净增长。

**关注点**: 10 个新的 lib 模块引入了 API 响应契约校验层。这是架构增强（运行时校验 API 契约），但 `apiResponseParsers.ts` (251行) 和 `apiDeclarativeParsers.ts` (198行) 的模块边界需进一步审查是否清晰。

#### 后端新增

| 新文件 | 行数 | 用途 |
|--------|------|------|
| `runtime/compaction_*.py` (6 files) | +855 | compaction 模块拆分（正面重构） |
| `skills/search.py` | 136 | 确定性 Skill 搜索排序 |
| `model_config/context_budget.py` | 170 | Context budget 模型 |
| `model_config/token_estimation.py` | 231 | Token 用量估算 |

#### 后端变更

| 文件 | 变更 | 说明 |
|------|------|------|
| `catalog_qwen.py` | +545 | 新增 Qwen35/36/37/VL/Coder 等 10+ 模型目录条目 |
| `model_settings.py` | +137 | 扩展 context budget / run readiness |
| `settings.py` (API) | +112 | 新增 context-budget REST 端点 |
| `manager.py` | +24 | admission gating: 拒绝 unresolved model runs |
| `gateway.py` | +58 | find_skill 搜索增强 |

### 0.4 新增潜在审查条目

| # | 文件 | 关注点 |
|---|------|--------|
| N01 | `frontend/src/lib/apiResponseParsers.ts` (251行) | 新模块是否充分单元测试？解析器路由是否覆盖所有 API 端点？ |
| N02 | `frontend/src/lib/apiDeclarativeParsers.ts` (198行) | 声明式 schema 是否与后端 Pydantic 契约保持同步？漂移检测机制？ |
| N03 | `backend/app/skills/search.py` (136行) | 确定性搜索排序算法是否需要独立基准测试？与 `gateway.py` 职责划分是否清晰？ |
| N04 | `backend/app/model_config/catalog_qwen.py` (+545行) | 10+ 新的模型目录条目：每个条目是否都有对应的 live 测试？ |
| N05 | `backend/app/runtime/compaction.py` (-511行) | 拆分后各子模块是否有独立单元测试？拆分是否完整（无残留逻辑在父模块）？ |

### 0.5 上游变更总体评价

**正面**: 上游团队在 76 个提交中完成了两个重要重构（SettingsPanel 拆分、compaction 拆分），直接解决了两项 P0 级发现。前端新增的 API 响应契约校验层也是架构增强，降低了 P1.8（契约漂移风险）的影响。

**仍待处理**: 13 项原审查发现未被触及，5 项新模块需要纳入后续审查。7 个 Phase 的执行计划可缩减到 6 个（Phase 4 不再需要 SettingsPanel 拆分）。

---

## 1. 质量基线

| 检查项 | 结果 |
|--------|------|
| Backend `uv run pytest` | 1386 passed, 1 skipped, 26 deselected; 全部通过 |
| Backend `uv run ruff check` | 零告警 |
| Frontend `pnpm lint` | 通过 |
| Frontend `pnpm tsc` | 通过 |
| Frontend `pnpm test` | 339 passed, **2 failed** (共 21 test files) |
| Frontend `pnpm build` | 通过 |

### 1.1 前端预存失败测试

| 测试文件 | 描述 |
|---------|------|
| `chat-panel.test.tsx` | 期望错误原因以 `role="alert"` 显示，但当前渲染仅出现顶部 `role="status"` 的"任务执行失败" |
| `ConversationStep.test.tsx` | 期望 warning code `partial_results` 可见，但当前 `WarningStep` 仅显示"部分记录不可用" |

**处理策略**: 属于重构前基线问题，不能通过修改测试断言来消除。应先确认产品语义（正确行为是什么），再决定修前端渲染还是修测试。独立于重构任务处理。

---

## 2. 项目结构与功能清单

### 2.1 模块分层

```text
backend/app/
├── api/           — REST + WebSocket 入口边界
├── runtime/       — 持久化 Task/Run 生命周期、事件日志、快照、索引、实时 Hub
├── agent_loop/    — Main Agent、模型适配、Reviewer、Import executor、运行入口
├── pipeline/      — 五阶段确定性 Pipeline (Discovery→Acquisition→Processing→ArtifactBuild→Validation)
├── skills/        — Builtin/User Skill Catalog、Gateway、包管理、运行时存储
├── domain/        — 权威 Pydantic v2 契约体系 (contracts/) + 旧 MVP dataclass 模型 (待迁移)
├── integrations/  — 外部数据访问 (NCBI、Unpaywall、EuropePMC 等)
├── tools/         — 文件、缓存、解析、安全工具
├── model_config/  — 模型目录、供应商发现、LazyDashScopeModel
└── core/          — MetricsTracker

frontend/src/
├── runtime/       — REST/WebSocket 编排、事件归约、任务投影
├── components/    — 研究会话、产物、设置、历史任务、人在回路界面
├── stores/        — Zustand store + selectors
├── hooks/         — useAPI、useAgentStream、useTheme、use-mobile
├── lib/           — fileUtils、通用工具函数
└── styles/        — Tailwind CSS v4
```

### 2.2 核心功能清单

| # | 功能模块 | 核心API/函数 | 依赖 |
|---|---------|-------------|------|
| F01 | 任务创建与生命周期 | `POST /api/v1/tasks`, `DELETE /tasks/{id}` | TaskManager, TaskRepository |
| F02 | Run 生命周期管理 | `POST /tasks/{id}/runs`, `/runs/{id}/cancel`, `/runs/{id}/resume` | TaskManager, EventStore |
| F03 | 人在回路暂停-恢复 | `UserInputRequiredPayload`, `_await_user_input()` | PipelineRunner, POST /resume |
| F04 | Agent 对话与检索 | `BioMedResearcher` Agent (OpenAI Agents SDK) | build_agent(), RunContext |
| F05 | 动态 Skill 网关 | `find_skill` / `invoke_skill` | SkillCatalog, SkillGateway |
| F06 | Pipeline 确定性执行 | `PipelineRunner.run()` 五阶段 | Discovery→Acquisition→Processing→ArtifactBuild→Validation |
| F07 | Discovery 阶段 | `run_discovery()`, PubMed/GEO 检索 | NcbiEutilsClient, pubmed.py, geo.py |
| F08 | Acquisition 阶段 | `run_acquisition()`, streamed download + SHA-256 | acquisition.py, SourceAsset |
| F09 | Processing 阶段 | `run_processing()`, counts parser | processing.py, geo_tximport.py |
| F10 | Artifact Build 阶段 | `run_artifact_build()` → 14 CSV/JSON | artifact_build.py, _write_csv(utf-8-sig) |
| F11 | Validation Gate | `run_validation()` → 7 项校验 → 原子发布 | validation.py, TaskLock |
| F12 | Durable 事件系统 | `EventEnvelope` v2, `EventStore`, `EventHub` | events.jsonl, WebSocket fan-out |
| F13 | WebSocket 实时推送 | `/api/v1/ws` subscribe/unsubscribe/ping | ws_events.py, transport.ts |
| F14 | Realtime 文本流 | `assistant_stream_delta`, durable buffer 100ms/1KB batch | AssistantStreamHub |
| F15 | 对话压缩与摘要 | `ConversationCompactor`, `compress_query_log` | compaction.py, ReviewerAgent |
| F16 | 模型配置管理 | `GET/POST /api/v1/settings`, `/models`, `/vendors` | settings_manager.py, model_config/ |
| F17 | 前端任务工作台 | ChatPanel + ResultsViewer + SettingsPanel | React 19, shadcn/ui, Zustand |
| F18 | 对话流展示 | ConversationItem 联合投影 (8 种 item 类型) | reducer.ts, ConversationList |
| F19 | Artifact 查看与下载 | `GET /artifacts`, `/artifacts/{id}` | ArtifactWorkspace, ResultsViewer |
| F20 | 固定真实验收案例 | GSE178352 + PMID 34180400 (48 gene×sample rows) | fixture pipeline, live tests |
| F21 | 多数据库接入 | GEO/GDC/PDB/PubChem/Reactome/Xena + browser | skills/builtin/acquisition/ |
| F22 | 图表数据 VLM 提取 | `extract_chart_data_vlm` (Qwen-VL 三级降级) | extract_chart_data_vlm.py, vl_model.py |
| F23 | 视觉证据采集 | `capture_web_page`, `capture_page_section` | web_visual_capture.py, Playwright |
| F24 | PDF 三级 Fallback | pdf_url → Unpaywall → EuropePMC | acquisition.py, unpaywall.py, europepmc.py |
| F25 | Skill 自进化安全校验 | AST 白名单 + 路径白名单 | self_evolution.py |
| F26 | 用户自定义 Skill 包 | JSON/YAML 数据库包, Python ZIP Skill 包 | packages.py, store.py, skills.py API |
| F27 | 导入任务模式 | `POST /api/v1/import/tasks` with attachment + clinical note | import_agent.py |
| F28 | 本地缓存导出 | `GET /api/v1/cache/export` | cache_export.py |

### 2.3 HTTP API 路由清单（完整）

| Method | Path | 功能 |
|--------|------|------|
| GET | `/api/v1/health` | 健康检查 |
| GET | `/api/v1/databases` | 列出可用数据库 |
| GET | `/api/v1/settings` | 获取用户模型设置 |
| POST | `/api/v1/settings` | 更新用户模型设置 |
| GET | `/api/v1/vendors` | 列出已知模型供应商 |
| GET | `/api/v1/models` | 发现可用模型 |
| GET | `/api/v1/models/{model_id}` | 获取模型详情 |
| GET | `/api/v1/skills` | 列出 Skill 目录 |
| POST | `/api/v1/skills` | 上传/注册 Skill 包 |
| DELETE | `/api/v1/skills/{id}` | 删除 Skill 包 |
| GET | `/api/v1/tasks` | 列出任务（active + paginated history） |
| POST | `/api/v1/tasks` | 创建任务 |
| GET | `/api/v1/tasks/{task_id}` | 获取任务快照 |
| DELETE | `/api/v1/tasks/{task_id}` | 删除终端任务 |
| POST | `/api/v1/tasks/{task_id}/runs` | 创建新 Run |
| POST | `/api/v1/tasks/{task_id}/runs/{run_id}/cancel` | 取消 Run |
| POST | `/api/v1/tasks/{task_id}/runs/{run_id}/resume` | 提交 HIL 决定 |
| GET | `/api/v1/tasks/{task_id}/messages` | 分页获取消息 |
| GET | `/api/v1/tasks/{task_id}/events` | 重放 durable 事件 |
| GET | `/api/v1/tasks/{task_id}/artifacts` | 列出产物 |
| GET | `/api/v1/tasks/{task_id}/artifacts/{artifact_id}` | 下载产物 |
| POST | `/api/v1/import/tasks` | 上传文件创建 Import Task |
| GET | `/api/v1/cache/export` | 导出本地缓存 |

---

## 3. 结构化审查（按 P0→P3 分级）

### P0 级：架构与正确性问题

#### P0.1 超长函数 `_run_inner`（192 行，`runner.py:566-757`）

Pipeline 核心主循环职责集中：阶段跳过/恢复决策、超时处理、状态持久化、结果收集、warning 事件触发全在一个方法中。圈复杂度极高，单测困难。

#### P0.2 `manager.py:331-334` 静默吞错 `_commit_task` 失败

```python
# runtime/manager.py:331-334
except Exception:
    pass
```

`_commit_task` 发生 I/O 错误时静默丢弃，可能导致终端状态不一致——run 既未标记 completed 也未标记 failed。赛题"证据完整性"评分存在潜在漏洞。

#### P0.3 前端 `reducer.ts` 1983 行超大文件

包含所有事件类型的投影逻辑、ConversationItem 生成、HIL 状态管理、实时流处理。文件大小本身成为维护障碍。

#### P0.4 前端 `SettingsPanel.tsx` 1051 行超大组件

Model / Databases / Skills 三个标签页全部逻辑混合在一个组件中。

#### P0.5 已知循环依赖：`tools/io.py` → `agent_loop/context.py`

```python
# tools/io.py:117
from app.agent_loop.context import RunContext  # noqa: E402
```

代码库中**唯一**明确标记为循环依赖的延迟导入。循环链：`agent_loop/agent.py → tools/io.py → agent_loop/context.py → tools/workdir.py`。`io.py` 中的函数需要 `RunContext`（用于路径解析），但将整个 context 模块作为依赖是不恰当的耦合方向。

### P1 级：代码重复与模块边界

#### P1.1 `_rate_limit` 三份完全相同的实现

`gdc.py:41-48`, `pdb.py:42-49`, `xena.py:41-48` 各自实现了完全相同的限流函数（`global _last_request_ts` + 速率检查）。`app/tools/crawler.py` 中已存在 `RateLimiter` 类但未被复用。

#### P1.2 `urllib.request` HTTP 封装三份重复实现

`gdc.py`, `pdb.py`, `xena.py` 各自实现 `_fetch_json`, `_download_file`, `_post_json`, `_get_json` 等 HTTP 客户端封装（基于 `urllib.request.urlopen`），未复用 `crawler.py` 的统一 `httpx_fetch`/`api_fetch`。同时违反项目记忆硬约束"使用真实浏览器 UA"（`BROWSER_HEADERS`）。

**对比**: `browser.py` 已正确使用 `from app.tools.crawler import BROWSER_HEADERS, _rate_limiter, playwright_fetch`。

#### P1.3 `_write_csv` 两份重复实现

`artifact_build.py` 和 `validation.py` 各有一份 `_write_csv`（`utf-8-sig` + `extrasaction="raise"`），逻辑一致。

#### P1.4 前端 `errorDescription` 五份重复实现

```typescript
error instanceof Error ? error.message : "请求失败"
```

出现在 `App.tsx:25`, `BackgroundTaskNotifications.tsx:7`, `controller.ts:34`, `SessionSidebar.tsx:89`, `SettingsPanel.tsx:56` 五个位置。

#### P1.5 前端 `formatSize` 三份不一致的变体

`fileUtils.ts` (B/KB/MB)、`AgentComposer.tsx` (B/KiB/MiB)、`ArtifactStep.tsx` (B/KB/MB/GB) 三个函数行为不同。应统一到 `fileUtils.ts`。

#### P1.6 `api/settings.py` 与 `api/settings_router.py` 双实现并存

**证据**:
- `app/main.py:19` → `from app.api.settings import router as settings_router`（使用 `settings.py`）
- `test_settings_api.py` → `import app.api.settings_router as settings_router`（使用旧 `settings_router.py`）
- `settings_router.py` 未被任何生产代码导入，在 `app/` 中无引用

`settings_router.py` 为死代码，但 `test_settings_api.py` 仍通过它来测试旧路由行为。需确认测试覆盖迁移后移除旧模块。

#### P1.7 `app.domain/` 与 `app.domain/contracts/` 新旧模型并存

`app/domain/__init__.py` 明确说明此为"正在迁移中"，但迁移速度缓慢：

**旧模型（dataclass）**：`output.py` (SourceRecord/DataRecord), `processing.py` (ParsedDataset/CleaningReport), `events.py` (EventType/TaskEvent), `task.py` (TaskRequest/TaskStateMachine)

**新模型（Pydantic v2 ContractModel）**：`contracts/source.py`, `contracts/pipeline.py`, `contracts/events.py`, `contracts/task.py`

**仍使用旧模型的文件（8 个）**：
`tools/alignment.py`, `tools/parse_pdb.py`, `tools/cleaning.py`, `tools/parse_excel.py`, `tools/parse_geo.py`, `tools/processing.py`, `tools/export.py`, `scripts/demo_workflow.py`

TODO §3.6 已记录此迁移但未执行。

#### P1.8 前端 REST/WebSocket/事件映射存在契约漂移风险

后端事件类型、前端 `contracts.ts`、`reducer.ts` 各自维护事件/状态映射，缺乏自动同步机制。当前虽无已知不一致，但长期维护风险高。

### P2 级：硬编码与可维护性

#### P2.1 超时值散布 15+ 处

`main.py` (10s), `settings_router.py` (10s), `gdc.py` (30s/60s), `pdb.py` (30s/60s), `xena.py` (60s), `browser.py` (120s), `pubmed.py` (30s/60s), `base.py` (5s) 等均硬编码超时值。TODO §8.8 已识别但未实施。

#### P2.2 前端硬编码值

- SettingsPanel: `dashscope.aliyuncs.com` URL（2 处）、默认 max_tokens (8192)、temperature (0.7)、top_p (1)
- SessionSidebar: 并发槽位数 (4) 硬编码
- AgentComposer: 导入文件大小限制 (500MB/2GB) 虽为常量但无注释

#### P2.3 前端未使用导出

`agentSelectors.ts` 中的 `selectActiveRuns`, `selectDraftSelectedDatabaseIds`, `selectDraftError` 三个导出未被任何生产代码使用。

#### P2.4 `model_settings.py` 与 `settings_manager.py` 命名接近

两个文件均涉及模型配置管理，命名区分度不足，增加维护者心智负担。

### P3 级：测试覆盖与文档

#### P3.1 `AgentComposer.tsx` (507行) 缺失独立测试

最复杂的输入组件仅在 `chat-panel.test.tsx` 中间接覆盖。

#### P3.2 `DatabaseSelector.tsx` (162行) 缺失独立测试

仅在 `chat-panel.test.tsx` 中间接测试。

#### P3.3 长期架构文档中混入历史提交诊断

`ARCHITECTURE.md` 中包含大量具体提交 SHA 和修复历史（如 §2.4 中 `5008c56`、`2cf9a01` 等），这些适合在 commit message 或变更日志中，不应长期混入架构描述。

---

## 4. 跨层依赖分析

下表展示七个主要模块组的模块级导入（不含 `TYPE_CHECKING`）：

| FROM / TO | domain | agent_loop | pipeline | runtime | skills | tools | integrations |
|-----------|---|---|------------|----------|---------|--------|-------|--------------|
| **domain** | - | - | - | - | - | - | - |
| **agent_loop** | yes | - | yes | yes | yes | yes | - |
| **pipeline** | yes | yes | - | yes | - | yes | yes (deferred) |
| **runtime** | yes | yes | - | - | - | - | - |
| **skills** | - | yes | - | - | - | yes | - |
| **tools** | yes | **yes**¹ | - | - | yes | - | - |
| **api** | yes | - | - | yes | yes | yes | - |
| **integrations** | yes | - | - | - | - | yes | - |

> ¹ `tools/io.py` → `agent_loop/context.py` 是唯一已知的实际循环依赖（使用延迟导入 workaround）。

**结论**：
- **`domain/`** 是唯一真正的叶子层
- **`agent_loop/`** 是最紧密耦合层（5/7 层），承载过多职责
- **`skills/`** 完全与 `pipeline/` 和 `runtime/` 隔离 — 设计良好
- **`integrations/`** 仅消费底层模块 — 零向上耦合

---

## 5. 代码规模统计

| 区域 | 文件数 | 估计行数 |
|------|--------|---------|
| 后端 `app/` | ~85 .py | ~18,000 |
| 后端 `tests/` | ~80 .py | ~20,000 |
| 前端 `src/` | ~60 .ts/.tsx | ~12,000 |
| 前端 `test/` | ~18 .ts/.tsx | ~4,500 |

### 质量指标总览

| 指标 | 值 |
|------|-----|
| 测试总数 | 1386 (BE) + 339 (FE) = 1725 |
| 超长函数 (>80行) | 5 个 |
| 超长组件 (>300行) | 12 个 |
| 重复代码模式 | 8 类 |
| 静默吞错点 | 6 处 |
| 硬编码值 | 25+ 处 |
| 已知循环依赖 | 1 个 (`tools/io.py`) |
| 死模块/死代码 | 1 个 (`settings_router.py`) + 3 个未使用前端导出 |
| 跨层耦合密度 | `agent_loop/` (5/7 层) |

---

## 6. 架构减法候选（需人类决策）

### 【待确认】候选 A：移除 `api/settings_router.py` 死代码

**Before**: `api/settings.py` (生产) 和 `api/settings_router.py` (仅被 `test_settings_api.py` 导入) 并存。

**After**: 确认测试迁移后移除 `settings_router.py`。

**收益**: 消除约 200 行死代码 + 一个死亡 API 入口 + 降低维护面的 CR 误读风险。

**前置条件**: `test_settings_api.py` 中所有对旧模块的导入迁移到 `app.api.settings` 对应模型。

**风险**: 低。仅需确认测试覆盖映射正确。

---

### 【待确认】候选 B：GDC/PDB/Xena 迁移到统一 `crawler.py` HTTP 基础设施

**Before**: 三个 acquisition skill 各自实现 `_rate_limit` + `_fetch_json` + `_download_file` 等 ~150 行重复的 `urllib.request` 封装。

**After**: 迁移到 `crawler.py` 的统一 `httpx_fetch`/`api_fetch`，删除各自的私有实现。

**收益**: -150 行重复代码；统一限速和反爬行为；实现对 TODO §3.1 的承诺。

**附加收益**: 同时满足 project_memory 硬约束"使用真实浏览器 UA"（`BROWSER_HEADERS`）。

**风险**: 低。`browser.py` 已成功走通此模式；需确保各数据源特定参数在迁移后不变。

---

### 【待确认】候选 C：拆分前端 Runtime 黑盒职责

**Before**: `controller.ts` (643行), `reducer.ts` (1983行), `transport.ts` (762行) 各自包含较大范围的连接、回放、handoff、实时流和投影规则。

**After**: 保持公开 Hook 和 store 接口不变，将"权威同步""订阅生命周期""实时文本协调"划为可独立测试的内部单元。`reducer.ts` 按事件类型拆分为 `reducer/stages.ts`, `reducer/conversation.ts`, `reducer/hil.ts` 等。

**收益**: 降低单文件复杂度、任务切换竞态的修改半径、合并冲突概率。

**风险**: 中等。涉及核心数据流，需先补齐 sequence、重连、切换和重复事件的黄金测试。不应与任何其他重构候选在同一变更中执行。

---

### 【待确认】候选 D：收敛后端 Run 执行编排边界

**Before**: `AgentRunExecutor`、`PipelineRunner`、`TaskManager` 分别持有部分状态、事件、取消和发布语义。

**After**: 保留三层职责但明确黑盒契约——executor 只产候选结果；Pipeline 只产验证包；TaskManager 只拥有 durable Run 状态和发布决策。

**收益**: 减少跨层状态判断和"完成"语义重复。

**风险**: **高**。涉及核心状态机与发布路径，属于架构级改动。必须先补齐该路径完整的黄金测试和 ADR 文档，未经批准和执行计划审查不得实施。

---

## 7. 分阶段执行计划

### Phase 1：基线修复隔离（P1，1-2 小时）

| # | 任务 |
|---|------|
| 1.1 | 独立处理前端两个失败测试：确认产品语义 → 决定修复渲染还是测试 |
| 1.2 | 确认 `ISSUES.md` 所述"任务执行失败但无具体信息"是否与失败测试同源 |

### Phase 2：消除死代码（P1，1-2 小时，需候选 A 批准）

| # | 任务 |
|---|------|
| 2.1 | 迁移 `test_settings_api.py` 到 `app.api.settings` |
| 2.2 | 全仓确认无其他引用后移除 `api/settings_router.py` |
| 2.3 | 删除前端三个未使用导出 |

### Phase 3：消除重复代码（P1，4-6 小时，需候选 B 批准）

| # | 任务 | 减少行数 |
|---|------|---------|
| 3.1 | GDC/PDB/Xena 迁移到 `crawler.py` 统一 HTTP 客户端 | -150 |
| 3.2 | 提取共享 `_write_csv` 到 `tools/io.py` | -20 |
| 3.3 | 前端提取 `errorDescription` 到 `lib/utils.ts` | -20 |
| 3.4 | 前端统一 `formatSize` 到 `fileUtils.ts` | -15 |

### Phase 4：拆分超大组件/方法（P0，3-5 小时，需候选 C/E 批准）

| # | 任务 |
|---|------|
| 4.1 | 拆分 `_run_inner`（`runner.py`） |
| 4.2 | 拆分 `reducer.ts` 为子 reducer 文件 |

> ~~SettingsPanel.tsx 拆分已由上游完成~~

### Phase 5：修复静默吞错（P0，1-2 小时）

| # | 任务 |
|---|------|
| 5.1 | `manager.py:333` 添加 logger.error 记录 commit 失败异常 |
| 5.2 | `runner.py:324` 限制 `except BaseException` 范围到 `except Exception` |
| 5.3 | `ws_events.py` 三处 `except Exception: pass` 添加 debug 日志 |

### Phase 6：硬编码治理（P2，2-3 小时）

| # | 任务 |
|---|------|
| 6.1 | 超时值集中到 `config.py`（`CRAWLER_*`, `STAGE_*`, `HTTP_*`） |
| 6.2 | 前端 SettingsPanel 默认值外提为 `DEFAULTS` 常量 |
| 6.3 | 前端并发槽位数 (4) 从后端 `max_active_runs` 读取 |

### Phase 7：测试覆盖补全（P3，2-4 小时）

| # | 任务 |
|---|------|
| 7.1 | 新增 `AgentComposer.test.tsx` |
| 7.2 | 新增 `DatabaseSelector.test.tsx` |

### Phase 8：防腐化（最后执行）

| # | 任务 |
|---|------|
| 8.1 | 修正 `tools/io.py` 循环依赖（提取 `RunContext` 依赖为接口或共享模块） |
| 8.2 | `ARCHITECTURE.md` 移除历史提交 SHA，只保留架构描述 |
| 8.3 | 清理 `pipeline/runner.py` 中冗余的函数内延迟导入 |
| 8.4 | 评估 CI/Lint 规则（复杂度阈值、调试残留检查） |

### Phase 9：上游新增模块审查（独立于本地修改）

| # | 任务 | 对应新增条目 |
|---|------|------------|
| 9.1 | 审查 `apiResponseParsers.ts` / `apiDeclarativeParsers.ts` 测试覆盖 | N01, N02 |
| 9.2 | 审查 `skills/search.py` 算法正确性与基准测试 | N03 |
| 9.3 | 审查 `catalog_qwen.py` 新增模型的 live 测试覆盖 | N04 |
| 9.4 | 审查 `compaction_*.py` 拆分完整性与残留逻辑 | N05 |

---

## 8. 预计优化收益

| Phase | 减少行数（估计） | 消除重复 | 降低复杂度 |
|-------|-----------------|---------|-----------|
| Phase 2 | -200 | 1 个死模块 | 简化导入图 |
| Phase 3 | -205 | 4 类重复 | — |
| Phase 4 | — | — | 3 个超大文件拆为 8+ |
| Phase 5 | — | — | 6 处错误处理增强 |
| Phase 6 | -20 | — | 15+ 硬编码外提 |
| Phase 7 | +300 (测试) | — | 覆盖 2 个高风险组件 |
| Phase 8 | -10 | — | 消除 1 个循环依赖 |

---

## 9. 建议的执行顺序

1. **Phase 1**（基线修复隔离）— 先恢复前端全绿，避免后续重构验收时误判
2. **Phase 2 + 3**（死代码 + 重复代码）— 最小风险、最大收益的减法切入
3. **Phase 5**（静默吞错修复）— 零新功能的正确性修复
4. **Phase 4**（拆分超大文件）— 需候选 C/E 批准后逐文件执行
5. **Phase 6 + 7**（硬编码治理 + 测试补全）
6. **Phase 8**（防腐化）— 最后执行，不影响功能
7. **Phase 9**（上游新增模块审查）— ~~需先成功 pull 最新代码~~ 网络问题暂缓，列入后续待办

**候选 D（Run 执行编排收敛）独立于所有 Phase**，单独形成 ADR 和设计文档，经审查批准后再排入独立分支实施。

### 上游变更影响的调整

| 变更 | 原计划 | 调整后 |
|------|--------|--------|
| SettingsPanel 已拆分 | Phase 4.3 | **移除** |
| Compaction 已拆分 | 原 P1.3（部分）关注点 | **标记为已解决** |
| 新增 10 个前端 lib 模块 | — | **新增 Phase 9** 审查任务 |
| 新增 skills/search.py | — | **新增 Phase 9** 审查任务 |

---

> **下一步**: 请审阅上述报告，特别是【待确认】的五项架构减法候选（A/B/C/D/E）。确认优先级后，我们将从 Phase 1 开始实际执行。
