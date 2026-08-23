# Family Host + Transform Host 计划集

> 状态：**历史Batch 0–2计划集**；ADR-039现已Accepted，当前行为以代码、ADR-039、`docs/architecture/FAMILY-HOST-03-execution-constraints.md`与`docs/TODO.md`为准。
> 代码基线：历史计划基于 `main@94be4a9e`（2026-08-21）。
> 当前范围：显式`in_process_unisolated` Host/Core publication chain已作为稳定`main`基线落地；它不是sandbox/安全边界。sandbox/container/IPC worker仍不开发。后续实现按`docs/TODO.md`的并行分支/worktree计划推进。

## 目标

将 BioMed-QAgent 从“Core 内置若干固定 Family 的领域实现”渐进演进为：

```text
Agent authors FamilySpec + DatasetTransform
  -> Family Host admission
  -> explicit in-process unisolated Transform Host execution
  -> Core output admission / integration / validation / assessment
  -> Core-only Publication
```

统一的是 **DatasetTransform ABI 与受控执行路径**，不是取消信任门。Agent-authored、example、user、curated transform 都走同一 Host；来源、验证状态、作用域、激活状态分别记录。Host 执行成功只产生 quarantine output 和 execution receipt，不代表结果可信或可发布。

## 阅读顺序

1. [00-overview.md](00-overview.md)：目标架构、现状差距、删除的旧设计与范围线。
2. [01-family-transform-contracts.md](01-family-transform-contracts.md)：FamilySpec、DatasetTransform、TransformExecutionReceipt 与 BuildSpec 版本策略。
3. [02-product-identity-relations.md](02-product-identity-relations.md)：Projection、Table/Audit、dataset revision、probe mapping relation。
4. [03-transform-host-security.md](03-transform-host-security.md)：编译、隔离、资源、quarantine、红队门。
5. [04-catalog-scope-resolution.md](04-catalog-scope-resolution.md)：examples catalog、scope/trust/resolution/shadow。
6. [05-core-execution-product-gate.md](05-core-execution-product-gate.md)：流式原语、integration、渐进 B3、provenance、ProductAssessment、Publisher。
7. [06-expression-vertical-slice.md](06-expression-vertical-slice.md)：GEO/GDC expression vertical slice 与 compatibility partition。
8. [07-family-examples-migration.md](07-family-examples-migration.md)：六个静态 Family 逐 capability 迁为 retrieval examples。
9. [08-activation-release.md](08-activation-release.md)：shadow、activation、回滚、Gold/release 证据。
10. [09-execution-matrix.md](09-execution-matrix.md)：Batch 0–2、依赖、并行边界、DoD。
11. [10-consistency-review.md](10-consistency-review.md)：全计划矛盾检查、开放决策与停止条件。

## 当前承诺范围

- **已落地**：FamilySpec contracts、registered input/digest closure、显式non-isolated execution、quarantine/native result、generic B3、ProductAssessment与immutable Publication。
- **Deferred**：isolated Host、sandbox/container、IPC worker。
- **当前release gate**：同一冻结commit/单Host的Gold1–Gold6证据；Gold6另需真实`publication_acceptance`。历史或跨提交 publication 仅是诊断证据。
- **合入后并行方向**：checkpoint/lease/restart、B3 production resource/disk、authoritative identity、family 产品闭包与专用前端 Family Host UX；integration hotspots 串行合并。
- **不在当前迭代承诺**：旧Registry一次性删除、Transform promotion市场或通用DAG。

## 永久边界

- `DatasetBuildSpec 1.0` 保持不变；动态路径使用新的版本化 DTO，不塞可选字段伪兼容。
- WorkflowRecipe 仍只负责 acquisition，不执行 DatasetTransform。
- examples 只供检索、clone 和测试；Core 不 import、不扫描为 production capability。
- `worker_threads`、`node:vm`、普通同账户 `child_process`、workspace `process.exec` 均不能单独充当不可信代码安全边界。
- Transform 不能决定 merge winner、validation threshold、ProductAssessment 或 Publication。
- 只有 Core 可以提交 OperationResult、构造 PublicationCandidate 并调用 Publisher。
