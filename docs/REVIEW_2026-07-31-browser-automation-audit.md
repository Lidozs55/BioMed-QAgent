# 浏览器自动化接入审计报告 v2（2026-07-31，复审后修正）

> **范围修正（v1 → v2）**：v1 混入了"编程框架能否调用浏览器"的内容（用户 MCP/技能/`~/.omp/puppeteer` 等），
> 与本次审计对象无关。v2 只审计**项目内 Agent（Qwen，经 OpenAI Agents SDK 运行）能否自主调用项目自身的
> 浏览器集成**。全部发现已经 **4 个独立子代理并行复审**（发现层/选择层/提示词层/运行接线层），
> 复审后修正了 2 处不准确表述（见 §2.1、§3.1）。未改动任何代码。
>
> 核心问题：**项目做了浏览器集成（BrowserPool + browser_fallback + web_visual_capture），
> 但项目内 Agent 实际无法自主调用它。** 能力存在且接线完整，卡在"发现层"。

---

## TL;DR

| 层 | 结论 | 复审状态 |
|---|---|---|
| **发现层（根因）** | `find_skill` 词汇搜索的**语料侧**是全英文——两个浏览器 Skill 的所有可搜字段零中文 token，`_DOMAIN_INTENTS` 无 网页/浏览器/截图 条目；Agent 按提示词建议用中文能力描述查询（`浏览器`/`网页`/`截图`/`爬取`）→ **全部返回空** → 判定"无浏览器能力" | ✅ CONFIRMED |
| **选择层** | `_NON_SELECTABLE_BUILTINS` 把 `browser_fallback`+`web_visual_capture` 从 `/api/v1/databases` 排除（用户选择器只有 7 个来源）；但仍可通过 gateway 按名调用 | ✅ CONFIRMED |
| **提示词层** | 两处 last-resort 措辞压制自主调用 + 一处**内部提示词矛盾**：`视觉证据采集` 段把 `capture_web_page` 当可直接调用，而 `动态 Skill 发现协议` 说能力不直接注入（实际也未注入）→ 字面执行会报未知工具 | ✅ PARTIALLY（1 处修正） |
| **运行接线层** | 能力**真实存在**：BrowserPool→CrawlerFacade→task_context_factory→RunContext→SDK Agent context 端到端绑定，egress proxy 进程内 | ✅ CONFIRMED |

---

## 一、现状盘点（项目内 Agent 视角）

### 1.1 浏览器集成存在且接线完整（ReviewRuntimeWiring: CONFIRMED）

```
lifespan (main.py:126-127)
  BrowserPool(max_contexts=4) ──> CrawlerFacade(browser_pool=...)
        │
task_context_factory (main.py:137-142): RunContext.bind_crawler_facade(crawler_facade)
        │
TaskManager(context_factory=task_context_factory) (main.py:171)
        │  _execute (manager.py:1378): context = self._context_factory(task_id)
        ▼
RunExecution(context=context) (manager.py:1381)
        │
AgentRunExecutor → Runner.run_streamed(agent, ..., context=execution.context) (runner.py:910-915)
        │  SDK 用同一 RunContext（agents/run.py:504-507 包 RunContextWrapper）
        ▼
技能工具 navigate_page/web_visual_capture → run_ctx.crawler_facade.browser()/screenshot()
```

- 子代理上下文传播：`create_child_context` 继承 facade（context.py:331-332）。
- egress proxy 是进程内 asyncio 回环服务器（egress_proxy.py:76,94），无外部代理依赖。
- manager.py:623-629 的默认 context factory（不绑定 facade）在生产是死代码——main.py 显式传入 factory。

**结论：能力存在且运行时可达，不是"没接通"。**

### 1.2 主 Agent 的注入面（ReviewPromptLayer: CONFIRMED）

`build_agent`（agent.py:271-283）只注入：`find_skill`、`invoke_skill`、`run_research_pipeline`、
`read_file`/`write_file`/`list_files`、`compress_query_log`、`review_query_strategy`、
子代理工具。**`navigate_page`/`download_from_page`/`capture_web_page`/`capture_page_section`
均未直接注入**，全库 grep 只出现在各自 SkillDef、测试与文档中。

→ `find_skill` + `invoke_skill` 是 Agent 触达浏览器集成的**唯一自主路径**。

---

## 二、根因：发现层（ReviewDiscoveryLayer: CONFIRMED）

### 2.1 机制（实证）

对全部 15 个 builtin skill 的活目录实测 `LexicalSkillSearchStrategy.search`：

| 查询 | hits（有序） |
|---|---|
| `浏览器` / `网页` / `网页截图` / `截图` / `爬取` | **[]（全空）** |
| `browser` / `web` | `browser_fallback`, `web_visual_capture` |
| `navigate_page` / `capture` | `browser_fallback` / `web_visual_capture` |
| （空串） | 全部 15 个（含两个浏览器 skill） |

- 匹配机制（search.py:88-136）：per-token 精确集合包含，identity 权重 12 / operation 6 /
  description 3，无模糊、无子串、无翻译。
- `browser_fallback` 与 `web_visual_capture` 的**全部可搜字段（name/display_name/
  supported_sources/operation_names/description）CJK token 数 = 0**；整个 builtin 语料
  CJK token map = `{}`。
- `_DOMAIN_INTENTS`（search.py:25-36）：8 个中文键（文献/基因表达/差异表达/蛋白结构/通路/
  化合物/图表/表格/统计分析）+ 1 英文（literature），**无 网页/浏览器/截图 条目**。
- `find_skill`（gateway.py:62-97）只过滤 `enabled`，原样返回搜索结果，无中文别名。

### 2.2 闭环

Agent 系统提示（中文）指示：给 `find_skill` 传"简短自然语言能力描述"（agent.py:162-163）。
Agent 说"浏览器"/"网页"/"截图" → 空结果 → 提示词 166-167 又只建议"缩短查询/换 source/category"，
没有任何指引把 Agent 导向英文名 `browser_fallback` → Agent 判定"没有浏览器能力"。

### 2.3 复审修正（相对 v1）

1. **"English-only" 是语料侧属性，不是分词器限制**：`_TOKEN_PATTERN`（search.py:20-23，
   `[^\W_]+` re.UNICODE）保留 CJK，`浏览器` 是单个 token；机制里已有 8 个中文 intent 键。
   因此**加中文别名或 `网页`/`browser` intent 条目即可用现有机制修复**。
2. **"Agent 断定无浏览器能力"略夸大**：agent.py:154-157（视觉证据采集段）直接点名了
   `capture_web_page`/`capture_page_section`，`find_skill(text='')` 也返回全部——
   失败仅在 Agent 按提示词建议用中文能力词查询时发生（这正是提示词引导的默认路径）。

---

## 三、次级成因

### 3.1 选择层（ReviewSelectionLayer: CONFIRMED）

- `_NON_SELECTABLE_BUILTINS`（builtin/__init__.py:11-17）含 `browser_fallback`(:12) 与
  `web_visual_capture`(:14) → `user_selectable=False`（:47-50）。
- `GET /api/v1/databases`（routes.py:182-202）过滤 `enabled and user_selectable and
  supported_sources` → 用户选择器只有 7 个来源（gdc/geo/pdb/pubchem/pubmed/reactome/xena），
  **无浏览器**。
- gateway 不过滤 `user_selectable`：`find_skill`/`invoke_skill` 只检查 `enabled`，
  按名调用仍然可达——**能力被隐藏但未被真正禁用**。
- 复审 nuance：`GET /api/v1/skills`（api/skills.py:48-52）仍列出浏览器 skill（设置页
  "Skills" 管理 tab 显示为不可选）；v1 引用的"Browser Fallback 采集"按钮只存在于
  `.playwright-snapshot-scenario1.yml`（gitignored 的历史 MCP 快照，2026-07-12/23），
  当前前端源码无任何 browser 开关——**按钮是陈旧残留，不是当前 UI**。

### 3.2 提示词层（ReviewPromptLayer: PARTIALLY-CONFIRMED）

已确认：
- `browser_fallback` SkillDef（browser.py:256-275）："Use browser_fallback tools **only when
  API endpoints are unavailable**"；`navigate_page`/`download_from_page` docstring 同款
  "last-resort"（:79, :144）。
- `web_visual_capture` SkillDef（web_visual_capture.py:370-391）："Do NOT use these for
  sources with working structured APIs"，整文件零中文。
- agent.py:154-157（视觉证据采集段）："`capture_web_page` 与 `capture_page_section` 用于
  结构化 API 失败时的视觉兜底，**不得替代已有结构化 API**"。

**复审修正（v1 有误）**：v1 断言"INSTRUCTIONS 无任何浏览器提及"——**事实错误**。
视觉证据采集段点名了两个 capture 工具（虽为 last-resort 框架）。

**复审新增发现——内部提示词矛盾**：视觉证据采集段把 `capture_web_page` 等描述为可直接调用，
而动态 Skill 发现协议（agent.py:160-161）说"业务数据库与处理能力不会作为主 Agent 的直接工具注入"，
且实际确实未注入 → **字面理解该段直接调用会得到"未知工具"错误**；走 `find_skill` 又因中文查询
空结果而失败——两条路都堵，Agent 只能得出"浏览器不可用"。

---

## 四、修复建议（按投入产出排序）

1. **发现层（根治，改动最小）**：✅ **已实施**（branch `fix/browser-skill-discovery`）——
   `_DOMAIN_INTENTS` 增加 `"网页"/"浏览器"/"截图"` 中文键（search.py），
   中文能力词现可命中 `browser_fallback`/`web_visual_capture`；新增
   `test_chinese_browser_intents_expand_to_browser_skills` 测试；既有中文意图
   （文献/蛋白结构/差异表达/统计分析/图表）真实目录排序无回归。
2. **提示词一致性**：✅ **已实施**——agent.py 视觉证据采集段改写为通过
   `find_skill`（`text="网页截图"` 或 `source="web_visual_capture"`）+ `invoke_skill`
   路由调用 `capture_web_page`/`capture_page_section`，保留 last-resort 框架，
   消除"未注入却称可直接调用"的矛盾。
3. **软化 last-resort 措辞**：未实施（用户未要求，属可选后续）。
4. **选择层（可选）**：未实施（用户未要求）。
5. **语义检索（已实施，branch `feat/llm-skill-retrieval`）**：`find_skill` 引入
   `LLMRerankingSkillSearchStrategy`（app/skills/llm_search.py）——词法检索为确定性基线，
   词法空结果/模糊时用 `qwen-flash` 单次分类调用对全目录（15 skills）重排 top-k；
   模型失败/离线回退词法，空 text fast-path 保留。仅主 Agent 启用；子代理保持词法。
   中文能力词（网页/截图/浏览器）由模型语义命中，不再依赖 `_DOMAIN_INTENTS` 手工表。

---

## 附：复审证据与勘误记录

| 复审子代理 | 判定 | 关键证据 / 勘误 |
|---|---|---|
| ReviewDiscoveryLayer | CONFIRMED（2 处 nuance） | 15-skill 活目录 probe 表；CJK token 审计=0；`_DOMAIN_INTENTS` 无浏览器条目；"English-only"系语料属性 |
| ReviewSelectionLayer | CONFIRMED（2 处 nuance） | /databases 过滤 3 条件→7 来源；gateway 仅过滤 enabled；/api/v1/skills 仍列出；"Browser Fallback 采集"按钮为陈旧快照残留 |
| ReviewPromptLayer | PARTIALLY-CONFIRMED | **修正 v1 错误**：agent.py:154-157 确实点名 capture 工具；新增发现：直接调用 vs 发现协议的内部矛盾；build_agent 未注入浏览器工具（CONFIRMED） |
| ReviewRuntimeWiring | CONFIRMED（1 处方法名勘误） | 端到端绑定链完整；manager.py:623-629 默认 factory 生产死代码；egress proxy 进程内；方法名 `_execute` 非 `_start_run` |

主要文件：`backend/app/skills/search.py`（发现）、`backend/app/skills/builtin/__init__.py` +
`backend/app/api/routes.py`（选择）、`backend/app/agent_loop/agent.py` +
`backend/app/skills/builtin/acquisition/{browser,web_visual_capture}.py`（提示词）、
`backend/app/main.py` + `backend/app/runtime/manager.py` + `backend/app/agent_loop/runner.py` +
`backend/app/agent_loop/context.py`（接线）。
