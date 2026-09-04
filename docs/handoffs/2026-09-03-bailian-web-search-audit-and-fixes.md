# 百炼联网搜索接入审计与夜间修复 handoff（2026-09-03）

> Branch: `fix/advanced-param-carryover`（基于 `origin/dev@37c12a2f`）
> 任务来源：用户指令「同步 main 与 origin/dev；检查并推进 阿里云百炼 平台的联网搜索功能接入；所有 bug 自行修复，原子提交并合并/rebase 到 dev；决策自行做出并记录」。

## 一、审计结论：百炼联网搜索（enable_search）端到端已接入

`enable_search`（设置页显示名「联网搜索」）链路在本次审计时**已完整存在**（最早可追溯
`c2143513`，Phase 6 model profile compatibility），本次核实每一环：

1. **UI**：模型注册表 → `ModelDetailDialog` → `ParameterEditor` 按
   `paramSpecsFor("dashscope")` 渲染 boolean 开关（`catalog.ts` 的
   `PROFILE_PROVIDER_SPECS.dashscope` 与 fallback specs 均含 `enable_search`）。
2. **服务端投影**：激活/编辑激活模型时 `applyModelDerivedParams` 把
   `model.params.enable_search` 镜像进 `settings.advanced.enable_search`
   （`service.ts`），编辑无需重新激活即生效。
3. **运行时解析**：`resolveActiveConfig` → `enableSearch: settings.advanced.enable_search`
   （`model-resolution.ts`）。
4. **请求注入**：pi-adapter `applyModelProfileToPayload` 对「qwen/qwq 前缀模型 +
   `dashscope.aliyuncs.com/compatible-mode/v1`」注入 `next.enable_search`，并把
   `thinking_mode` 映射为 `enable_thinking`；非百炼 Qwen 模型一律不透传（防 400）。
   该函数经 `ModelRuntime.streamSimple` 的 `onPayload` 钩子挂接，已验证
   `pi-ai` 的 openai-completions 实现会以 `onPayload` 返回值**替换**实际请求体。
5. **测试**：注入与防泄漏均有纯函数级用例。

本次夜间工作未新增「接入」代码，而是修复审计中发现的断点（见下）。

## 二、本次修复（原子提交）

### 1. `d860fab1` fix(settings): 模型激活时 advanced 参数重投影

- **Bug**：`applyModelDerivedParams` 只在模型显式携带键时覆盖 `settings.advanced`。
  从「开了联网搜索的模型 A」切到「未设置该参数的模型 B」时，`enable_search: true`
  静默残留——B 的 UI 开关显示为关、运行时却仍向百炼发送 `enable_search: true`
 （联网搜索按调用计费，且思维链开关残留可能引发不兼容模型的 400）。同类残留影响
  temperature/top_p/repetition_penalty/thinking_mode。
- **决策**：与既有测试 `falls back to the default max output when the activated model
  exposes none`（max_tokens 回退 8192）确立的语义对齐——激活是对运行时设置的**重投影**，
  模型未携带的键回退 `ADVANCED_DEFAULTS`，而非沿用上一个激活模型的值。
  先重置 `settings.advanced = { ...ADVANCED_DEFAULTS }` 再按 params 覆盖；
  `updateModel`（编辑激活模型）共用同一函数，语义一致（删掉某参数即回默认值，
  与 UI 编辑器显示 spec default 的行为吻合）。
- **Legacy 语义核查**：仅 `model.json`（无 legacy 注册表）路径不触发 `activateInMemory`，
  不受影响；legacy SQLite 注册表迁移路径与已发布的 max_tokens 迁移行为一致
  （模型 params 未携带的键按默认值落定），不做特例回填——回填会把 legacy 时代的
  同源残留 bug 固化进迁移后的 params。
- **回归测试**：`model-settings.test.ts` 新增「re-derives advanced parameters on
  activation instead of carrying over the previous model's values」。

### 2. `45087027` fix(agent): 百炼国际端点 dashscope-intl 支持 Qwen 专属参数

- **Bug**：`usesDashScopeQwen` 仅匹配 `dashscope.aliyuncs.com`；百炼国际站
  OpenAI 兼容端点为 `dashscope-intl.aliyuncs.com/compatible-mode/v1`
  （官方文档/社区均确认），国际站 Key + Qwen 模型的联网搜索/思维链开关被静默丢弃。
- **决策**：两站点共享同一套 Qwen 专属参数语义，主机名白名单扩为二；
  路径断言 `/compatible-mode/v1` 与 qwen/qwq 前缀限制保持不变（第三方模型
  如 kimi/deepseek on dashscope 仍不透传，避免 invalid_parameter）。
- **回归测试**：`pi-adapter.test.ts` 新增 international endpoint 用例。

### 3. `b75028b4` fix(agent): 系统提示词压回 8_000 字符上限

- **Bug**：`b1fd4e4b`（放宽执行提示词）把 `PHASE1_SYSTEM_PROMPT` 推到 8231 字符，
  破坏 `pi-adapter.test.ts` 的 ≤8_000 守卫（该守卫控制每调用 system-prompt 成本，
  属刻意预算）。**dev 基线即失败，属预存回归。**
- **决策**：压缩提示词而非放宽上限。修剪点均为冗余或与新语义冲突的残留：
  重复的 `Call inspect_dataset_execution_routes` 提示（第 8 行已有）、
  旧重试阶梯残留（`after adjusting the parameters` / `instead of guessing`——
  b1fd4e4b 本意即移除 adjusted-parameter 阶梯）、与同节已有禁令重叠的
  `process.exec` 句（`workspace_exec`/shell/subprocess 禁令保留）、两处括号列举。
  全部测试断言不变量与放宽语义（fix the fact / author topology / end goal 前置）保留；
  修剪后 ≈7930 字符。
- **教训**：改系统提示词必须跑 `pi-adapter.test.ts`（长度守卫 + 全部语义断言都在那里）。

### 4. 环境修复（不改代码、不动 lockfile）

- **Playwright Chromium 修订漂移**：19 个 phase5 真浏览器用例失败，原因是
  lockfile 的 Playwright 期望 `chromium-1234` 而本地缓存只有 `1228`。
  `pnpm exec playwright install chromium` 补装后 55/55 通过。
- **frontend/node_modules 陈旧隔离布局残留**：7 个前端测试文件报
  `Missing "./questionnaire" specifier in "@shadcn/react"`、recharts 双 React 实例
  （`useContext of null`）。根因：`frontend/node_modules` 残留旧版
  `@shadcn/react@0.2.1` 的 `.pnpm` 虚拟 store，遮蔽根 hoisted 的 0.3.0
  （lockfile 仅有 0.3.0；workspace 已配置 `nodeLinker: hoisted`，不应存在子包
  `.pnpm`）。处理：删除 `frontend/node_modules` 后 `pnpm install --frozen-lockfile`
  重建。**lockfile 与 manifests 未做任何改动**；Windows 侧如遇差异重跑
  `pnpm install` 即可。

## 三、开放项（未做，需决策）

- **`search_info` 透出**：开启联网搜索后百炼在响应中返回 `search_info`
  （命中的网页结果与来源）。当前 pi 链路忽略该字段——模型内部可见检索结果，
  但 UI/证据链看不到「模型查过什么网」。与 TODO「通用 Web 搜索工具」是互补项
  （模型侧内置搜索 vs Agent 侧受控搜索工具）。已登记 `docs/TODO.md`。
  **→ 同日已在 `fix/search-info-projection` 实现并合入，见下方 §五。**
- **百炼 Key 的 live 冒烟**：本机未配置百炼 API Key，未能真实调一次
  `enable_search: true`。首次配置后建议对 qwen-plus 开联网搜索跑一轮
  真实请求验证（请求体含 `enable_search` 且无 400）。

## 四、验证状态

- server：`vitest run` 2224 passed / 20 skipped（0 失败）；`eslint --max-warnings 0`
  通过；`tsc -p tsconfig.test.json --noEmit` 通过。
- frontend：修复 node_modules 残留后重跑（结果见合并前最终确认）。
- 合并：本分支按「≤5 提交 rebase / >5 merge」政策合入 `dev` 并推送。

## 五、search_info 透出（同日追加实现，`fix/search-info-projection`）

用户确认按方案推进后，四层各一个原子提交实现：

### 关键约束（决定方案形态的调研事实）

1. pi-ai 的 `onResponse` 只透出 `{status, headers}`（dist 已核），内部 OpenAI
   SDK（v6.26）未暴露自定义 fetch——**响应体只能从 fetch 层镜像**。
2. 百炼兼容模式把 `search_info`（`search_results[]`：`site_name`/`icon`/`url`，
   部分型号带 `title`）放在**流式最后一个 chunk**（与 `include_usage` 的 usage
   同机制），一次模型调用收集一次即可。

### 四层实现

- **L1 捕获**（`server/src/agent/search-info-capture.ts`）：进程级 fetch tee，
  仅命中 DashScope 两站点的 `/compatible-mode/v1/chat/completions` 且带
  `x-biomed-search-probe` 探针头才介入；`response.body.tee()` 主干照常喂
  SDK、镜像流增量解析 SSE 只挑 `search_info`（天然免疫 SDK 字段剥离）。
  有界化 ≤20 条/字段 200 字符；镜像流静默 30s 兜底取消；原始 fetch 抛错/
  非 SSE 响应均安全释放 slot。**会话关联用 per-request 探针头**（pi-ai 会把
  stream options 的 headers 合并进 OpenAI client defaultHeaders），并发会话
  不串扰。
- **L2 事件**：`BioMedAgentEvent` + `EventPayload` 新增
  `provider_search_info`（纯新增联合成员——events.jsonl 解析是宽松 shape
  校验、reducer 未知类型静默跳过，旧日志/旧前端零影响）；event-adapter
  白名单 + 映射 + 纵深有界化（防未来捕获路径回归把无界数据写进 durable
  log）；`PiBioMedAgentSession` 订阅 upstream 新增的 `onSearchInfo` 通道，
  转发到活跃 turn（turn 终结后到达的滞后批次丢弃）。
- **L3 投影**（task-reducer）：按 URL 去重、单消息封顶 20 条挂到当前 run
  的 assistant 消息（`MessageRecord.search_results?`）；事件先于首条
  delta 到达时 stash、创建时合并；`run_steered` 边界清除 stash。
- **L4 前端**：事件白名单 + payload 校验；reducer 按 run 聚合为单个
  `search_info` 时间线项（保持首现位置）；快照 hydration 从消息
  `search_results` 重建；`SearchInfoStep` 折叠式「联网搜索来源（N）」
  （站点名/域名 + 外链 rel=noreferrer），无该事件零渲染开销。消息 API
  解析器放行可选 `search_results`。

### 决策记录

- **fetch tee 而非 onResponse/上游改造/非流式重放**：前者是唯一能拿到响应
  体的缝，且 host+path+探针头三重白名单把 global patch 风险收窄到百炼端点。
- **独立事件类型而非挂 turn_completed**：重放幂等、UI 关联干净、可按调用
  粒度记录。
- **按 run 聚合去重**（而非逐调用堆叠）：一个 agent loop 多轮模型调用会
  重复命中同一 URL；UI 语义是"这一轮查过什么网"。
- **检索结论永远只是展示元数据**：SearchInfoStep 与 Agent 工具取证步骤
  视觉区分，不进入 evidence/coverage 证据链（与「通用 Web 搜索工具」
  验收口径一致）。P2 若要计入覆盖证据，再走专门决策。

### 验证

server：2239 passed（含 capture 9、event-adapter 2、task-reducer 3 新用例）/
lint / typecheck / build / 启动冒烟 health ok。frontend：943 passed（含
reducer 2、SearchInfoStep 2 新用例）/ lint / tsc / build。
**遗留**：本机无百炼 Key，search_info 的端到端 live 验证仍待首次配 Key
后执行（与 §三 live 冒烟合并做一次即可）。
