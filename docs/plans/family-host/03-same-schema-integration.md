# WP-C：Same-Schema Integration

## 1. 目的

把多个 source/binding 产出同一 Schema 时的整合语义从 expression 专用实现提升为可复用、可审计、可资源约束的通用 primitive。最终输出不能由 binding 顺序、数组 append 或 LLM 选择决定。

## 2. 统一处理模型

```text
source rows
  -> schema compatibility partition
  -> schema-owned canonical identity
  -> disk-backed dedup lookup
  -> conflict detection
  -> deterministic policy / typed review proposal
  -> provenance merge
  -> canonical table + conflict audit
  -> committed OperationResult
```

## 3. Merge contract

每个 table/projection 必须声明：

- identity fields 与 canonical encoding；
- comparison fields 和 conflict definition；
- null/empty 语义；
- duplicate policy；
- conflict policy：reject、preserve-conflict、policy-selected winner 或 review；
- source precedence 是否存在，以及它来自哪个受信任 registry/profile；
- provenance merge 和 audit output；
- resource limits、ordering、digest 规则。

首批 contract：

| 表 | identity / policy |
|---|---|
| expression primary | dataset/sample/feature/measurement/value semantics 等字段；compatibility partition 后 disk-backed dedup；冲突保留 audit 或阻塞 |
| datasets | source-derived dataset_id；同 ID 字段冲突 audit/block |
| samples | `(dataset_id, sample_id)`；metadata conflict 显式记录 |
| probe mapping | mapping_assertion_id 或完整 assertion identity；多映射保留 |
| rejected/conflicts | append-only audit，不参与 canonical primary dedup |

## 4. 分阶段计划

### C1：抽象现有 expression integrator

将 `server/src/dataset/integrator/integrator.ts` 中的 SQLite temp store、canonical row identity、conflict audit、quota、cancel 逻辑拆为参数化接口。保持旧 expression profile 的输出兼容，不先重写算法。

### C2：table-owned identity registry

由 projection/table contract 提供 identity/comparison/policy，而不是 integrator 猜测字段或按 `family.id` 分支。Schema 只描述语义；可执行 merge policy 必须是受信任 registry/profile 的固定实现。

### C3：multi-table aggregation

为 datasets/samples/mapping 和 audit 表提供相同的 file-backed aggregation API。每一张表独立 checkpoint、digest、operation result；不能将所有表强行合成一份内存对象。

### C4：unresolved conflict decision

Core 产生 typed `ConflictCandidate`，Agent/HIL 只能提交 typed `ResolutionDecision`。policy 决定 auto-admit、require human review 或 reject。Core 根据 decision replay 确定性生成 derived artifact，并重新 validation；原始 artifact 保留。

### C5：跨 source fixture

至少验证 GEO+GDC 同 Schema、重复 canonical row、字段冲突、相同输入重跑、不同 binding 顺序、取消恢复和 receipt closure。

## 5. 依赖关系

- C1 依赖 A 的 identity 草案，B 的 disk-backed store。
- C2 必须在 A 的 projection contract 冻结后完成。
- C3 依赖 B4 的 table-level committed result。
- D/GDC/Xena 可在 C2 之后分别接入，不能各自发明 identity。
- E/H 依赖 C3 的 conflict/provenance result。
- F/G 不得将未登记的 merge policy 暴露给 Agent。

## 6. 验收

- 完全相同输入、source binding 重排和重复执行得到相同 canonical output、conflict output、digest 和 decision ordering；
- duplicate 不重复发布；
- conflict 能定位到参与的 source asset、locator、row/key；
- unresolved conflict 不会随机取第一来源；
- provenance 合并后每条 canonical row 仍可回溯；
- quota/cancel/restart 失败时不产生可发布 partial artifact；
- 同一 primitive 至少被两个真实 table/family 消费后，才允许标记为 generic。

## 7. 风险

- “first source wins” 只能是已注册、版本化、可审计 policy，不能由输入顺序隐式决定。
- 不要把语义消歧直接塞进 generic integrator；它必须通过 typed conflict decision 和 Core replay 完成。
- 如果两个 source 的 value semantics、unit 或 granularity 不兼容，应在 compatibility partition 阶段阻止 integration，而不是强行合并。
