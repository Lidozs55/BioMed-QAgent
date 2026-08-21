# Family Host 改造计划集

> 状态：计划文档集
> 基线：仓库当前 `main`，以及 `docs/architecture/FAMILY-HOST-01` 至 `04`
> 目标：在保留 TS Host、Pi Agent、TS Dataset Core、Publisher 可信边界的前提下，规划 Family 从静态源码注册演进为可发现、可声明、可受控加载的 Family Host。

## 阅读顺序

1. [00-overview.md](00-overview.md)：现状、范围、依赖图和总验收门。
2. [01-contract-projection-identity.md](01-contract-projection-identity.md)：Schema、Projection、关系和身份契约。
3. [02-streaming-execution-primitives.md](02-streaming-execution-primitives.md)：流式执行、磁盘中间态、checkpoint 与资源边界。
4. [03-same-schema-integration.md](03-same-schema-integration.md)：同 Schema 多来源确定性整合。
5. [04-provider-projections.md](04-provider-projections.md)：GEO、GDC、Xena 的 projection 和能力验证。
6. [05-validation-provenance-assessment.md](05-validation-provenance-assessment.md)：结构/科学语义验证、溯源和 ProductAssessment。
7. [06-family-registry-host.md](06-family-registry-host.md)：声明式 FamilySpec、Package Loader 和 Family Host。
8. [07-agent-capability-interface.md](07-agent-capability-interface.md)：Agent 的发现、解析、创建 task Family 边界。
9. [08-publication-evaluator-release.md](08-publication-evaluator-release.md)：Publication、Gold 证据链和 release activation。
10. [09-execution-matrix.md](09-execution-matrix.md)：可并行工作包、依赖、分支边界和执行顺序。

## 关键结论

- 当前默认顺序仍是 Gold 诊断、同 commit trusted-input closure、发布链修复，再做 Family Host 泛化；本计划不是要求立即启动完整动态平台。
- `gene_expression` 的生产路径不能直接切换到当前 `registered_multitable.runtime.v1`：该 runtime 仍有完整 `Buffer`、`object[]` 聚合和完整读回统计等风险。
- DatasetBuildSpec 1.0 目前只有单数 `schema_ref`。在没有版本化 wire contract 之前，不临时加入 `schema_refs`。
- 短期由 Core-owned projection 根据 primary schema 解析 supporting tables；长期再由经过 Core admission 的 capability resolver 解析声明式 schema set。
- Agent 可以发现、选择、生成声明式提案，但不能注入任意代码、直接修改 deterministic artifact 或创建正式 Publication。
- 所有“已声明 capability”必须与“已通过 trusted E2E 验证 capability”分开记录。
