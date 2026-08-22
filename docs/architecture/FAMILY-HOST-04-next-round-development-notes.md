# FAMILY-HOST-04：旧下一轮笔记已被 Transform Host Batch 计划取代

> 状态：Superseded（2026-08-21）
>
> 本文件保留路径，仅用于历史链接兼容；不再作为当前实现合同。

原笔记正确识别了 `registered_multitable.runtime.v1` 的内存、receipt、checkpoint、identity 和 B3 风险，但仍以 expression fixed executor + Family Host/Runtime Extension 为长期分层。第二轮设计已进一步统一为：

```text
FamilySpec + DatasetTransform
  -> isolated Transform Host
  -> Core quarantine admission
  -> compatibility/integration/B3/semantic validation
  -> ProductAssessment/Publisher
```

请改读：

- [01-family-transform-contracts.md](../plans/family-host/01-family-transform-contracts.md)
- [02-product-identity-relations.md](../plans/family-host/02-product-identity-relations.md)
- [03-transform-host-security.md](../plans/family-host/03-transform-host-security.md)
- [05-core-execution-product-gate.md](../plans/family-host/05-core-execution-product-gate.md)
- [09-execution-matrix.md](../plans/family-host/09-execution-matrix.md)

仍然有效的审计结论：

- 不把 workspace `process.exec`、`worker_threads`、`node:vm` 或普通同账户 `child_process` 当作不可信代码 sandbox；
- Transform implementation identity 必须覆盖 bundle/compiler/dependency/runtime/policy；
- `registered_multitable.runtime.v1` 不能继续作为 expression 大数据和动态 transform 的旁路；
- `dataset_id` 不得来自 `build_id`；
- audit 不属于现有 TableRole；
- probe mapping 必须支持 0/1/N assertion；
- GEO/GDC 共享 integration framework，但只在兼容 partition 内 merge；
- B3 必须按真实 workload 渐进 disk-backed，而不是一次性重写。

ADR-039现已Accepted：显式`in_process_unisolated` dynamic route已接production；它不是sandbox/安全边界。sandbox/container/IPC仍不开发，且不得删除现有静态Family runtime。
