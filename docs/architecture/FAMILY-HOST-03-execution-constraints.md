# FAMILY-HOST-03 长期执行约束

> 状态：长期架构不变式
> 日期：2026-08-21
> 适用范围：Dataset Core、Family Host、Agent、FamilySpec、Runtime Extension、Validation、Publication。

本文约束优先于局部实现便利。未来 Family Host、动态 Schema、Agent-generated Family 均不得破坏这些边界。

## INV-1 — Deterministic Artifact Immutability

确定性流程已经提交的任何 artifact 不允许由 Agent / LLM 原地修改。

允许：

```text
original deterministic artifact
        ↓
read-only review
        ↓
derived artifact
```

不允许：

```text
original.csv
   ↓
LLM in-place edit
   ↓
继续假装 original.csv 仍为 deterministic output
```

任何非确定性修正必须：

- 保留原始 artifact；
- 新建 derived artifact；
- 记录 parent refs；
- 记录 decision evidence；
- 重新进入 validation。

## INV-2 — Code Trust Boundary

Agent 可以自由生成和修改声明式 FamilySpec，但不能自动生成任意代码并作为 trusted Dataset Core extension 执行。

### 允许自动执行

- Schema JSON；
- TableDefinition；
- RelationDefinition；
- capability declaration；
- declarative integration policy；
- declarative validation policy；
- task-scoped Family metadata。

前提：全部通过 Core parser / validator。

### 不允许自动进入 trusted runtime

- arbitrary TS/JS；
- arbitrary shell；
- native binary；
- 未审核 provider transform；
- 未审核 validator extension。

Executable extension 必须有显式 trust / install / approval 过程。

## INV-3 — Publication Authority

只有 Dataset Core 可以创建正式 Publication。

Agent、workspace、Skill、FamilySpec 均不能直接声明：

```text
publication succeeded
```

必须经过：

```text
Operation Results
   ↓
PublicationCandidate
   ↓
Validation
   ↓
Product Assessment
   ↓
Publisher
```

正式事实来源始终是 Core 生成的 Publication + manifest。

## INV-4 — Success Means Product Success

以下条件不能单独视为任务成功：

- tool call 成功；
- provider 下载成功；
- CSV 文件存在；
- BuildResult.succeeded；
- Agent 自述“完成”；
- assembler 返回 candidate。

成功至少需要验证实际数据产品：

- 本次 required/selected schemas 是否齐全；
- required tables 是否存在且满足 allow_empty 语义；
- schema refs 是否正确；
- relations 是否完整；
- provenance 是否闭合；
- validation 是否通过；
- publication 是否完成；
- 如有 product assessment，是否 publishable。

## INV-5 — Capability Honesty

source/adapter 只能声明自己真实能够产出的 Schema。

禁止：

- 为满足 build spec 虚报 capability；
- 由 Agent 猜测 source 能产某 schema；
- 发现缺字段后静默补默认值以伪造 schema compliance；
- 将 derived/estimated value 冒充 source value。

Capability 必须来自：

- builtin/curated declaration；或
- task FamilySpec 中可验证的声明与实际 adapter output。

运行时必须验证：

```text
requested schema ⊆ source capability
```

## INV-6 — Same-Schema Integration Is Deterministic

多个 source 产出同一 Schema 时，不允许使用简单裸 append 作为最终发布语义。

必须显式定义：

- canonical row identity；
- deduplication；
- conflict definition；
- deterministic conflict policy；
- provenance merge；
- conflict audit。

若 deterministic policy 无法裁决，则进入 Agent/HIL review，不允许 runtime 随机选择。

## INV-7 — Raw Evidence Preservation

任何 normalization / standardization 都不得销毁关键原始证据。

例如：

```text
raw_unit
raw_relation
raw_value
source token
source locator
```

如生成：

```text
standardized_unit
standardized_value
canonical_id
```

必须可追溯到对应 raw evidence。

Family 可以定义 token-preservation rule，但不能通过 FamilySpec 关闭全局 provenance 要求。

## INV-8 — Provenance Closure

正式 Publication 中每张表、每条需要追溯的数据都必须能最终闭合到 Core 注册的 SourceAsset / OperationResult。

不允许将 workspace 中任意文件路径直接当 provenance。

至少要求：

```text
row / table
  ↓
source_locator / result ref
  ↓
source_asset_id / operation_result
  ↓
registration receipt / digest
```

所有 asset ID 必须 content-addressed 或具有等价不可变标识。

## INV-9 — Workspace Is Not Trusted Core Input By Default

Agent workspace 是研究、下载、临时处理和推理空间，不等价于 Dataset Core trusted input。

workspace 产物只有经过显式：

```text
register source asset
        或
register derived input
```

并获得 receipt 后，才允许进入 Core pipeline。

禁止 Core 在 Publication 时直接读取未经登记的 workspace 路径。

## INV-10 — FamilySpec Must Be Validated Before Registration

任何动态 Family 必须在注册前完成结构与语义验证。

至少检查：

- family ID/version；
- schema uniqueness；
- schema family ownership；
- primary key；
- row granularity；
- relation target existence；
- source capability refs；
- adapter refs；
- validation policy；
- integration policy；
- runtime requirement；
- extension trust level。

非法 FamilySpec 不能以“Agent 生成内容”理由绕过检查。

## INV-11 — Dynamic Family Is Scoped

Agent 自动创建 Family 时默认作用域必须是 `task`。

```text
builtin > curated > user > task
```

task Family：

- 只在当前任务生命周期内自动生效；
- 不自动污染全局 registry；
- 不自动覆盖 builtin/curated Family；
- promotion 必须显式发生。

名称冲突必须基于 scope + version resolution 处理，禁止静默覆盖。

## INV-12 — Family Evolution Is Versioned

已发布或已用于正式 Publication 的 Family/Schema 不能原地改变语义。

以下变化必须 bump version：

- field semantic role；
- primary key；
- row granularity；
- unit policy；
- relation semantics；
- integration identity；
- requiredness 规则；
- validation semantics。

历史 Publication 必须仍能解析到当时使用的 Family/Schema 版本。

## INV-13 — Runtime Must Not Depend on Family Name for Generic Semantics

Generic Runtime 不应通过：

```ts
if (family.id === "...")
```

决定本可由 contract 表达的行为。

长期允许 family-specific branch 的位置仅包括：

- explicitly registered runtime extension；
- source/provider transform implementation；
- unavoidable domain-specific validator。

以下行为必须逐步 family-agnostic：

- schema selection；
- table writing；
- required/optional evaluation；
- relation validation；
- same-schema integration；
- provenance closure；
- generic assembly。

## INV-14 — Agent Chooses Within Declared Capabilities

Agent 可以：

- 选择 source；
- 选择 schema set；
- 组合 capability；
- 创建 task FamilySpec；
- 请求 semantic review；
- 生成 derived artifact proposal。

Agent 不可以：

- 注入任意 merge function；
- 绕过 validation；
- 修改 committed deterministic artifact；
- 伪造 source receipt；
- 直接 publish；
- 将 unsupported source 伪装成 supported capability。

## INV-15 — LLM Semantic Review Must Produce Evidence

当确定性层无法裁决时，Agent/HIL 的语义判断必须形成可审计 decision record。

记录至少包含：

- decision ID；
- input conflict refs；
- considered source refs；
- chosen resolution；
- rationale；
- model/user identity；
- timestamp；
- derived artifact ref。

“LLM 看过了”不能作为可审计结论。

## INV-16 — Determinism Where Possible, Explicit Uncertainty Where Not

所有能够由规则可靠完成的步骤必须保持确定性。

不应为了“Agent 更智能”将以下能力重新交给 LLM：

- CSV parsing；
- schema validation；
- primary key uniqueness；
- exact ID match；
- deterministic dedup；
- hash/checksum；
- relation integrity；
- unit token preservation。

只有真正存在语义不确定性时才进入模型判断，并显式保留 uncertainty / review evidence。

## INV-17 — Streaming and Resource Safety

Family Host 与动态 schema 不得导致 Dataset Core 回退为“全部数据读入内存再处理”。

大规模 integration 应继续优先：

- streaming parser；
- SQLite / disk-backed index；
- bounded buffers；
- explicit limits；
- deterministic external sort / partition；
- cancellation-aware IO。

FamilySpec 不得通过声明取消全局资源上限。

## INV-18 — Backward Compatibility Is Explicit

迁移旧 Family/runtime 时允许短期兼容层，但必须：

- 标记 legacy path；
- 不新增依赖 legacy path 的新 Family；
- 有删除条件；
- 测试新旧路径差异；
- 不因“兼容”长期保留重复语义实现。

例如 `gene_expression.runtime.v1` 迁移完成后，应评估其是否成为死路径，而不是默认永久保留。

## INV-19 — Tests Validate Data Product Semantics

测试不能只验证函数是否返回或 build 是否 succeeded。

关键测试必须覆盖：

- schema set；
- requiredness；
- row identity；
- dedup；
- conflicts；
- provenance；
- relations；
- validation checks；
- product assessment；
- Publication manifest。

Gold case / representative case 应作为产品级回归，而不是单纯 fixture snapshot。

## INV-20 — Keep the Core Small

新增需求优先按以下顺序实现：

```text
1. FamilySpec declaration
2. Generic runtime capability
3. Reusable adapter / validator
4. Trusted runtime extension
5. Core hardcode        # 最后手段
```

任何新增 `family.id` / `source ===` 特判都应说明：

- 为什么无法声明化；
- 为什么无法作为 adapter/extension；
- 删除计划是什么。

长期目标是 Family 越多，Core 本身仍保持小而稳定，而不是 Family 数量与 Core 条件分支数量线性增长。
