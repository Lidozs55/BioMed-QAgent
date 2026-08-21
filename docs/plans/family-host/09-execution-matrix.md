# Batch 0–2 执行矩阵

## 1. 现阶段承诺

这套计划不是一个迭代内完成全平台的任务单。当前开发截止线是：

```text
Batch 0
  + Batch 1
  + Batch 2A expression shadow slice
  + Batch 2B 第二真实消费者的 go/no-go 评审
```

Batch 3+ 只保留路线，不在本轮承诺全六 Family、默认动态 Agent build 或旧 Registry 一次性删除。

## 2. Work packages

| ID | 工作包 | 产物 | 硬依赖 | 批次 |
|---|---|---|---|---|
| T0 | ADR、威胁模型、平台支持矩阵 | ADR-039 proposal、threat model、sandbox backend decision | 无 | 0 |
| T1 | FamilySpec / Transform / Receipt contracts | `@biomed/contracts` strict DTO/parser、digest fixtures | T0 | 0 |
| T2 | identity / projection / relation | dataset/revision/asset、audit artifact、probe relation contract | T0 | 0 |
| T3 | implementation identity | bundle/compiler/dependency/runtime/policy digest、checkpoint invalidation | T1 | 0-1 |
| T4 | B3/resource baseline | memory telemetry、threshold、large-input benchmark | T2 | 0 |
| T5 | compiler/admission spike | source normalization、AST/import policy、bundle receipt | T1/T3 | 1 |
| T6 | isolated Transform Host MVP | independent worker/backend、asset handles、quarantine、hard kill | T0/T5 | 1 |
| T7 | Host protocol/receipt | invocation、generation、quota、cancel、terminal result | T1/T3/T6 | 1 |
| T8 | Core quarantine admission | rehash、schema/locator/output closure、native OperationResult | T2/T7 | 1 |
| T9 | fixed transform slot | server-owned plan slot、transform capability admission、不引入 DAG | T1/T7/T8 | 1 |
| T10 | checkpoint/lease/recovery | Host/Core owner fencing、orphan cleanup、publish reuse 修复 | T3/T7/T9 | 1 |
| T11 | B3 disk mode | PK/FK first hotspot、quota/cancel、memory parity | T2/T4 | 1-2 |
| E1 | expression examples | GEO/GDC projection examples、dataset revision、mapping assertion | T2/T5 | 2A |
| E2 | expression shadow | Host -> Core -> assessment -> artifact parity | T6-T11/E1 | 2A |
| E3 | second consumer | bioactivity example 与相同 Host/Core path | T6-T11 | 2B |
| R1 | release/go-no-go | trusted E2E、rollback、activation recommendation | E2/E3 | 2 |

## 3. Batch 0：合同与安全冻结

### 并行工作

- T0：新增 Proposed ADR-039，记录 Agent-authored transform 的目标边界、Transform Host 非同进程/非同账户要求、与 ADR-020/027/033/034/036/038 的关系；
- T1：FamilySpec、DatasetTransform、TransformExecutionReceipt、BuildSpec 2.0 草案；
- T2：Projection、Table/Audit、dataset/revision/asset、sample、mapping relation；
- T3：implementation digest 与 deterministic replay identity；
- T4：B3 当前 Map 的规模基线、阈值和 benchmark harness；
- 现有六 Family inventory 与 caller/assembler/provider branch map。

### 出口条件

- 所有 ID、digest、ownership、scope、status 可 strict parse；
- audit 不进入 TableRole；
- probe mapping relation 方向、字段、many-to-many、missing policy 已冻结；
- dataset_id/revision/asset/build 分层已冻结；
- `DatasetBuildSpec 1.0` snapshot 不变；
- 明确 examples 不可直接执行、Host receipt 不等于 Core trust；
- 明确生产支持的 OS isolation backend；
- 没有默认 build route、没有 dynamic Family activation、没有 Family 迁移代码。

### Batch 0 禁止

- 在 `server/src` 中 `eval/import` Agent code；
- 使用 workspace `process.exec` 作为 Transform Host；
- 把 `worker_threads`/`node:vm` 当 sandbox；
- 将 Gold-specific requirement 写进 FamilySpec；
- 修改现有 accepted ADR 的历史 Decision 文字以隐藏冲突。

## 4. Batch 1：非生产 Host MVP

### 并行工作

- T5 compiler/admission：只允许 SDK allowlist，生成内容寻址 bundle；
- T6 isolated worker：无网络、低权限身份、只读 input、quarantine output、quota/hard kill；
- T7 framed Host protocol：invocation/generation/receipt/terminal reason；
- T8 Core output admission：Host output 重哈希、strict schema/locator、native result；
- T9 fixed slot：只在专用 fixture route 使用；
- T10 recovery：cancel/timeout/restart/stale worker/late commit；
- T11 B3 PK/FK first hotspot：小 fixture parity + large fixture resource evidence。

### 出口条件

- path escape、network、secret/env、process spawn、symlink/junction、quota、timeout、cancel、late commit 全部 fail closed；
- 同 input + exact transform/runtime/policy digest 可 replay；双跑输出不一致则阻止 deterministic status；
- Host output 未 Core admission 前不可成为 OperationResult/Publication；
- memory/disk B3 fixtures checks/order/digest parity；
- 不接默认 Agent build tool，现有六 Family 仍走 legacy；
- `registered_multitable.runtime.v1` 旁路问题已登记并有统一 executor 修复门，不在旁路继续叠加 transform。

### Batch 1 禁止

- 把任何 Agent-authored transform 标记为 activated；
- 允许第三方 npm、native addon、动态 import 或网络；
- 让 worker 写 task output/state/logs/artifacts/publication；
- 以 Host exit code 代替 ProductAssessment。

## 5. Batch 2A：Expression shadow vertical slice

### 范围

- GEO gene/probe examples；
- GDC gene example；
- dataset/revision/asset identity；
- samples composite key；
- mapping assertion relation/coverage；
- compatibility partition；
- disk-backed B3 relation path；
- expression ProductAssessment；
- legacy vs Host shadow comparison；
- Artifact API/download/hash closure。

### 出口条件

- GEO/GDC 进入同一个 integration framework，但只在兼容 partition 内 merge；
- GDC 无 probe mapping 时诚实声明 unsupported/allow-empty，不伪造 capability；
- 大输入不走全量 Buffer/object[] 或无界 B3 Map；
- task/run/build/Host receipt/Core result/validation/publication evidence 完整；
- shadow 结果的 schema、rows、relations、provenance、assessment 差异可解释；
- rollback 到 legacy executor 可演练；
- 通过只代表 shadow verified，不自动激活 family。

## 6. Batch 2B：第二真实消费者 go/no-go

优先选择 `bioactivity_measurement`，因为已有跨库 identity/crosswalk/ProductAssessment 语义。必须先证明它能使用与 expression 相同的 Host contract、Core quarantine admission、integration/validation/assessment path，而不是仅复用一个接口名称。

只有以下条件全部满足才启动：

- Batch 2A 无未解释的 trust/resource blocker；
- 第二消费者的输入/output topology 能由 FamilySpec 描述；
- 需要的 transform slot、relation、provenance 和 assessment semantics 不依赖新 family-specific Core branch；
- 至少一个 capability 可做独立 shadow/rollback。

若不满足，Batch 2B 退回 contract/primitive 修复，不扩展到其余四族。

## 7. 后续路线，不是本轮承诺

Batch 3+ 才讨论：

- examples catalog user/curated lifecycle；
- promotion/revoke/activation UI/API；
- literature/target/structure/variant 逐 capability migration；
- capability-level legacy retirement；
- default Agent dynamic BuildSpec 2.0 route；
- Generic IR/package projection；
- full old Registry/assembler/provider branch deletion。

每新增一个通用 primitive，必须有至少两个真实消费者、compatibility fixtures、resource evidence 和 rollback path。

## 8. 分支、交接与提交门

建议分支：

- `docs/family-host-transform-plan-v2`：本次计划/ADR/架构文档；
- `feat/transform-contracts`：T1-T3；
- `feat/transform-host-sandbox`：T5-T7；
- `feat/core-transform-admission`：T8-T10；
- `feat/dataset-validation-disk-index`：T4/T11；
- `feat/expression-host-shadow`：E1/E2；
- `feat/bioactivity-host-shadow`：E3。

每个实现分支合并前必须提供：契约版本/digest、trust/status、resource evidence、tests、same-commit artifact refs、rollback plan，并明确 `example_only` / `sandbox_executable` / `shadow_verified` / `trusted_e2e_verified` / `activated` 状态。

## 9. 全局质量门

适用代码提交：`pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm build`；涉及 database 时运行 Python bridge gates。新增 Host 还必须运行 sandbox/red-team、resource、cancel/restart、digest/replay、Artifact API hash tests。

文档阶段不运行生产动态 transform，不声称新能力已经存在。
