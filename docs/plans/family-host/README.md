# Family Host + Transform Host 计划集

> 状态：非-sandbox FamilySpec/Core 收敛继续；ADR-039 Transform Host 路线已 Deferred
> 代码基线：历史计划基于 `main@94be4a9e`（2026-08-21）；当前行为以代码与 `docs/TODO.md` 为准
> 当前范围：Agent-authored DatasetTransform、sandbox backend、IPC worker与真实Host shadow/release evidence整体暂缓；已有disabled Host/proof/admission fixtures仅作fail-closed guard。

## 目标

将 BioMed-QAgent 从“Core 内置若干固定 Family 的领域实现”渐进演进为：

```text
Agent authors FamilySpec + DatasetTransform
  -> Family Host admission
  -> isolated Transform Host execution
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

- **继续推进**：声明式 FamilySpec contracts、authoritative identity/relation、B3 bounded/disk primitives、Core-owned fixed deterministic slot、checkpoint/release/publication verification。
- **Deferred**：isolated Transform Host MVP、sandbox backend、IPC worker、Agent-authored transform execution，以及依赖真实Host的expression/bioactivity shadow与activation evidence。
- **不在当前迭代承诺**：全六 Family迁移、默认动态Agent build、旧Registry一次性删除、Transform promotion市场或通用DAG。
- Deferred项不得用disabled fixtures、synthetic benchmarks或静态examples标记完成；未来恢复须重新做go/no-go。

## 永久边界

- `DatasetBuildSpec 1.0` 保持不变；动态路径使用新的版本化 DTO，不塞可选字段伪兼容。
- WorkflowRecipe 仍只负责 acquisition，不执行 DatasetTransform。
- examples 只供检索、clone 和测试；Core 不 import、不扫描为 production capability。
- `worker_threads`、`node:vm`、普通同账户 `child_process`、workspace `process.exec` 均不能单独充当不可信代码安全边界。
- Transform 不能决定 merge winner、validation threshold、ProductAssessment 或 Publication。
- 只有 Core 可以提交 OperationResult、构造 PublicationCandidate 并调用 Publisher。
