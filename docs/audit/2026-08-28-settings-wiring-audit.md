# 设置项端到端接线审计(2026-08-28)

> **整改进展(2026-08-28 晚,`main@523e0f29`):** 已修复——P0(编辑活动模型参数不生效,`493218e7`);P1 跨字段校验(target≥trigger、max_tokens 对窗口预算、params 按 paramSpecs 校验,同上);P1 activate 残留 max_tokens(同上);P2 第 1 项删除残留 + 第 2 项 base_url 写入端 URL 结构校验(含 updateProvider 先校验后赋值的原子性修复,`1a638d95`);P2 第 3 项加载端钳制校验(共享 bounds 表、坏值回退默认并告警)+ 第 4 项迁移旁路(JSON/SQLite 复用同一钳制)+ 第 5 项 env 引导改查模型目录(`523e0f29`);P2 第 6 项 tmp 清扫、第 9 项 recursive 布尔校验、第 11 项死代码(`493218e7`);前端三项(第 3 项 ModelDetailDialog 基准、第 4 项 ParameterEditor JS 校验含 JSON 通道复用、第 6 项 ModelImportSheet 非法窗口报错、第 10 项初始化不对称,`2d503d1a`)。**仍未修:** P1 personalization 接线(需产品决策)、P1 safety_reserve_ratio 语义、P2 第 7 项掩码边角、第 8 项 compaction 参数前端入口;前端 base_url/规则 path 校验。另:main 红测(scaffold 2 项)已由 `d829c387` 清零,本报告"附"节作废。

> 审计基线:`main@766395c3`(含当日合并的 compaction convergence 修复)。
> 范围:`server/src/settings/`、`server/src/settings/model-registry/`、
> `server/src/agent/pi-adapter.ts` 消费侧、`server/src/agent/permissions/`、
> `frontend/src/components/settings/**`、`packages/contracts/src/settings.ts`。
> 方法:静态追踪每个设置字段从 UI/API → 持久化 → 校验 → 运行时消费的完整链路;
> 未修改任何代码。前序背景:同日 Gold7 上下文压缩根因审计(见
> `docs/ISSUES.md` gold7 条目与 `docs/architecture/runtime-events.md`)。

## 结论总览

设置系统整体骨架健康:模型注册表(provider/model/settings 三层)、权限、
runtime limits、数据库设置的主链路全部接通,持久化走原子写。但存在
**三类系统性问题**:

1. **同步缺口**:活动模型参数编辑后只有 `context_window` 回写 settings,
   `max_tokens` 与采样参数不回写,而运行时只读 settings —— 用户在前端
   唯一入口改"最大输出 Tokens"后实际不生效(除非重新激活模型)。
2. **死设置**:`safety_reserve_ratio` 与个性化设置(personality /
   custom_instructions)有完整的存储、API、甚至前端 UI,但运行时零消费。
3. **校验只查单字段**:跨字段约束(target < trigger、max_tokens 对剩余
   窗口、params 范围)在写入端全部缺失,`paramSpecsFor` 的 min/max 只是
   UI 展示;坏值能落盘,靠读取端静默回退掩盖。

以下按严重度分级,每项给出根因文件:行号与修复建议,可直接认领。

---

## P0 — 编辑活动模型参数不生效(必须重新激活)

**现象**:模型详情对话框的"最大输出 Tokens"(写 `params.max_tokens` +
`max_output_tokens`,前端唯一编辑入口)保存后,运行时请求的 maxTokens
仍是旧值;`temperature` / `top_p` / `repetition_penalty` / `enable_search` /
`thinking_mode` 同理。

**根因链**:

- 运行时只读 settings:`resolveActiveConfig`
  (`server/src/settings/model-registry/model-resolution.ts:66-73`)输出
  `maxTokens: settings.max_tokens`、采样参数取 `settings.advanced.*`;
  `params: model?.params ?? {}` 虽然透传,但 `applyModelProfileToPayload`
  (`server/src/agent/pi-adapter.ts:546`)显式跳过 `max_tokens` /
  `temperature` / `top_p`,这些只走 settings 通道。
- 模型参数 → settings 的同步**只发生在激活时**:`activateInMemory`
  (`server/src/settings/model-registry/service.ts:490-506`)。
- `updateModel`(`server/src/settings/model-registry/service.ts:410-416`)
  仅当 `body.context_window !== undefined` 且是活动模型时回写
  `settings.context_window`——注释明确写了"与 syncCatalogMetadata 一致",
  但 `max_output_tokens` / `params` 分支没有等价回写。

**影响**:

- 用户按"当前模型"面板指引(前端明示"参数修改请到模型列表")改参数,
  保存成功、无任何提示,实际不生效。这是 Gold7 类上下文预算问题的
  另一诱因:用户以为改小了 max_tokens,实际仍是旧值。
- GET `/api/v1/settings` 展示的 `max_tokens` 与模型详情页显示值出现
  无法解释的分叉。

**修复建议**(二选一,推荐前者):

1. `updateModel` 中,当目标是活动模型时,把 `max_output_tokens` /
   `params.max_tokens` / `params.temperature` 等与 `activateInMemory`
  同一份派生逻辑回写 settings(抽公共函数避免两处漂移)。
2. 或反转数据流:运行时直接以 `model.params` 为准、settings 只做展示
   聚合(改动更大,需 ADR)。

配套测试:编辑活动模型 params 后,`resolveActiveConfig` 输出立即变化。

## P1 — `safety_reserve_ratio` 是半死设置

**现象**:字段有存储默认 0.05、PUT 校验 `[0,0.25]`
(`server/src/settings/model-registry/service.ts:198`)、GET 展示
(`safety_reserve_tokens` 参与 `available_input_tokens` 计算,
`service.ts:156-167`),但**运行时完全不消费**:
`resolveActiveConfig` 不输出它,Pi 的 `CompactionSettings`
(`server/src/agent/pi-adapter.ts:706-712`)只使用
`compactionTriggerRatio` / `compactionTargetRatio`,reserve 由
`1 - triggerRatio` 推导。

**影响**:用户(或运维脚本)调整它不会改变任何实际行为;它展示出的
`available_input_tokens` / `run_block_reason` 与 Pi 真实预算计算是两套
互不相干的公式,误导排障。

**修复建议**:明确语义后二选一——(a) 把它接入 Pi:压缩与请求预算统一用
`max(safety_reserve, 1 - trigger)` 作为 reserve;(b) 从 settings 中移除,
`available_input_tokens` 改用与 `resolvePiCompactionOverrides` 同一公式。
禁止维持现状(两个同名 reserve 概念各算各的)。

## P1 — 个性化设置(personality / custom_instructions)完全未接线

**现象**:前端有完整 UI(`frontend/src/components/settings/sections/PersonalizationSettingsSection.tsx`),
API `GET/PUT /api/v1/personalization` 与存储
`data/settings/personalization.json`(`server/src/product/product-api.ts:121,217-225`)
齐备,校验完整(personality 枚举、20000 字符上限,`product-api.ts:48-62`)。
但全仓 grep 证实:agent 侧**没有任何代码读取该文件或调用该 API**;系统提示是
静态 `PHASE1_SYSTEM_PROMPT`(`server/src/agent/phase1-prompt.ts:41`),
`pi-adapter.ts:730` 的 `systemPrompt` 只有这一个来源。

**影响**:用户填写的自定义指令与人格选择毫无作用。

**修复建议**:产品决策——(a) 在 Pi session 创建/换模时把
custom_instructions/personality 合成进 systemPrompt(注意缓存失效与
2 万字符对上下文预算的占用);或 (b) 在 UI 下架该 section 并标注
"规划中"。任一方向都不要保留静默无效的表单。

## P1 — 跨字段校验缺失(前序压缩审计建议 #5 的遗留)

**现象与根因**:

- `updateSettings`(`service.ts:193-213`)逐字段 `boundedNumber`,
  无任何跨字段约束:
  - `compaction_target_ratio` 可 ≥ `compaction_trigger_ratio`(各自
    [0.01,0.99]),落盘后 Pi 的 target ≥ trigger,压缩永不满足目标,
    现在会触发 fail-closed `CONTEXT_COMPACTION_INEFFECTIVE`——校验缺失
    从"性能问题"升级成了"任务终止"。
  - `max_tokens` 仅下界 1 无上界(`service.ts:195`),可存
    `max_tokens > context_window`。
- `getSettings` 只把预算不足折算成展示用 `run_block_reason`
  (`service.ts:160-187`),`run_ready` 仍只看 key/model;服务端 run
  入口没有 preflight,前端 `runBlockReason` 也只用于提示
  (`frontend/src/App.tsx:259`)。
- `updateModel` 的 `params` 自由合并(`asRecord`,`service.ts:403`),
  `paramSpecsFor`(`catalog.ts`)的 min/max 服务端从不执行;
  前端 `ParameterEditor` 的 min/max 只是 HTML 属性无 JS 强制
  (`frontend/src/components/settings/ParameterEditor.tsx:48-49`),
  JSON 通道可绕过一切。

**修复建议**:

1. 写入端统一校验函数:拒绝 `target ≥ trigger`(422,带修复提示);
   拒绝 `max_tokens ≥ context_window × (1 - safety_reserve)`(或至少
   强警告);`params` merge 时按 `paramSpecsFor` 校验已知键。
2. run 入口 preflight:发起 Pi turn 前检查
   `context_window - max_tokens - reserve > 0`,不足时以明确的
   `context_budget_exhausted` 拒绝,而不是等 provider 400。
3. 前端 `ParameterEditor` 提交前 JS 校验 min/max。

## P1 — 激活模型时 max_tokens 残留旧模型值

**根因**:`activateInMemory`(`service.ts:497-498`)
`const maxTokens = model.params.max_tokens ?? model.suggested_max_tokens ??
model.max_output_tokens;` 只在为 number 时覆盖
`settings.max_tokens`。新模型三者皆 null(手动添加、发现接口未返回)时,
settings 保留**上一个模型**的 max_tokens。

**影响**:从大窗口模型(如 262144 窗口、max_tokens 32768)切到小模型
(如 32k 窗口)后,max_tokens 32768 残留,直接压缩小模型的有效输入空间;
与 trigger ratio 叠加可能立即落入上文 P1 校验缺失描述的危险区。

**修复建议**:三源皆空时回退目录建议或全局默认(8192),并在 GET
/settings 标注 `max_tokens_source`。

## P2 — 其余接线与校验缺口

按影响排序,均给出根因位置:

1. **`deleteProvider` / `deleteModel` 脏残留**
   (`service.ts:282-293,422-430`):清了 `provider_id`/`active_model_id`,
   但 `settings.base_url/model_name/context_window/max_tokens` 仍指向已删
   实体;GET /settings 继续展示幽灵模型,前端 `contextWindow`
   (`App.tsx:258`)与运行时 `resolveActiveConfig`(model 优先)出现分叉。
   建议:级联清空或回退默认,并补 `run_block_reason`("未选择模型")。
2. **`base_url` 无 URL 校验**(`service.ts:193` settings PUT、`:252`
   createProvider):仅非空字符串;`validateCredentialedPublicUrl` 只在
   discover 出站时执行(`service.ts:513-527`),运行时
   `resolveActiveConfig` 直接采用未校验值(`model-resolution.ts:53`)。
   建议写入端复用 url-policy。
3. **加载端几乎无 schema 校验**(`store.ts:200-213`):磁盘坏值(类型
   错误)静默流入;`normalizeRuntimeLimits`(`store.ts:215-232`)越界
   **静默回退默认**,无告警、有损。建议加载时校验+日志,拒绝则带原因
   重建。
4. **迁移旁路范围校验**(`migration.ts:33-41,88-90`):legacy 值仅
   typeof 检查后原样写入,发生在 `loadRegistryState` 归一化之后
   (`service.ts:110-131` load → migrate 顺序);另 `migration.ts:99` 把
   SQLite `source="api"` 行错标 `metadata_source:"catalog"`,启动目录
   刷新(`service.ts:576-608`)有权覆盖 API 发现的元数据。
5. **env 引导硬编码**(`store.ts:174-197`):引导模型固定
   `context_window=131072`/`max_tokens=8192` 且标 catalog 来源,不查
   `lookupModelCatalog`;1M 窗口模型被低估。null 回退恒 131072 且
   `context_window_source:"inferred"` 名不副实(`service.ts:171`)。
6. **atomic-json tmp 堆积**(`server/src/persistence/atomic-json.ts:47-53`):
   `data/settings/` 实测残留大量 `*.tmp`(write 与 rename 之间退出即
   永久残留)。建议启动时清扫同目录孤儿 tmp。
7. **api_key 边角**(`service.ts:214-222,63-67`):空串静默清空密钥;
   真实 key 恰为自身掩码形态(≤12 字符)时被误判"未改动"跳过写入。
8. **前端零编辑入口**:`compaction_trigger_ratio` /
   `compaction_target_ratio` / `safety_reserve_ratio` 后端可 PUT 但
   无 UI(全仓唯一 `saveSettings` 调用只发 runtime_limits)。Gold7 的
   100k 窗口这类关键配置只能靠直接改文件/API。建议在"运行限制"或
   模型 section 增加"上下文预算"子表单(含跨字段即时校验)。
9. **权限规则 `recursive` 静默收敛**(`server/src/settings/permission-settings.ts:186`):
   仅 `=== true` 为 true,`1`/`"yes"` 静默存 false;前端规则 path 无
   绝对路径校验(`AgentPermissionSettingsSection.tsx:266`,描述却声称
   "必须为绝对路径")。
10. **ModelDetailDialog 初始化不对称**(`frontend/src/components/settings/ModelDetailDialog.tsx:78-81,166`):
    初始取 `params.max_tokens` 优先,保存比对却用 `model.max_output_tokens`,
    两者不一致时会无条件把 `max_output_tokens` 覆盖为输入框值;
    `ModelImportSheet.tsx:330-339` 非法 context_window 静默当 null,
    与 Dialog 的报错行为不一致。
11. **死代码**:`catalog.ts:466-479` `guessContextWindow` 全仓无调用。

## 设置域接线全景

| 设置域 | UI | API | 存储 | 运行时消费 | 判定 |
| --- | --- | --- | --- | --- | --- |
| provider(增删改、key) | ✅ | ✅ | ✅ | ✅(activate→settings) | 健康;base_url 缺 URL 校验 |
| 模型列表/激活/删除 | ✅ | ✅ | ✅ | ✅ | 健康;删除残留脏状态 |
| 模型参数编辑(params) | ✅ | ✅ | ✅ | ⚠️ 仅激活时同步 | **P0 断点** |
| context_window | ✅ | ✅ | ✅ | ✅(同步+model 优先) | 健康;null 回退语义弱 |
| max_tokens(settings 级) | 仅模型入口 | ✅ | ✅ | ✅(min of 调用级) | 接线通;激活残留+无上界 |
| compaction trigger/target | ❌ 无 UI | ✅ | ✅ | ✅(含 fail-closed) | 接线通;无跨字段校验 |
| safety_reserve_ratio | ❌ 无 UI | ✅ | ✅ | ❌ | **死设置** |
| temperature/top_p 等 advanced | 仅模型入口 | ✅ | ✅ | ⚠️ 仅激活时同步 | **P0 断点** |
| runtime_limits(14 字段) | ✅ | ✅ | ✅ | ✅(phase3-composition.ts:424-529、business-tools.ts:153-253 全量接入) | 健康 |
| 权限(preset/rules/exec) | ✅ | ✅ | ✅ | ✅(broker/policy-store) | 健康;recursive/path 边角 |
| personalization | ✅ | ✅ | ✅ | ❌ | **未接线** |
| 数据库 enabled/连接 | ✅ | ✅ | ✅ | ✅(named-op) | 健康 |
| skill iteration / 缓存 / 外观 | ✅ | ✅/本地 | ✅/本地 | ✅/仅本地 | 健康(外观为纯本地偏好,合理) |

## 与前序压缩审计的衔接

2026-08-28 上午的压缩审计(整改建议 1/2/3/7)已随
`fix/context-compaction-convergence`(merge `766395c3`)落地:
调用级 maxTokens 取较小值、压缩遥测贯穿 durable 事件、fail-closed
`CONTEXT_COMPACTION_INEFFECTIVE`、证据脱敏白名单、前端真实 >100% 显示。
本报告覆盖其遗留项:

- 建议 4(目标预算扣除固定开销 + 每次调用前 preflight)→ 见上文
  "跨字段校验缺失"修复建议 2,仍未实现;
- 建议 5(跨字段设置校验)→ 同节,仍未实现;
- 建议 6(真实收敛测试:大 tool result + 旧摘要 + 100k 窗口)→ 部分完成
  (E2E fail-closed 用例已有),大 tool result 场景建议随 preflight 一并补。

## 附:main 现存测试失败(与设置无关,勿混淆)

`main@766395c3` 上 `tests/family-host-core-dispatch-guard.test.ts`(generic
Core 边界)与 `tests/skill-manifests.test.ts`(SKILL.md 引用不存在的工具)
各 1 例失败,系 `bd4c990d` scaffold 提交带入,合并前已在纯 main 复现。
需 scaffold 作者修复;设置类改动勿被这两个红测干扰判断。

## 建议整改顺序

1. P0 模型参数同步(小改动、用户可感知)。
2. P1 跨字段校验 + run preflight + params 范围校验(同一 PR 主题:
   "设置写入端真正生效的校验")。
3. P1 personalization 接线或下架(需产品决策,建议先发 [Q])。
4. P1 safety_reserve_ratio 语义统一(可与 2 合并)。
5. P1 激活残留 + P2 删除残留(同一 PR:registry 生命周期一致性)。
6. P2 其余按上表逐项认领;tmp 清扫与死代码清理可随手做。
