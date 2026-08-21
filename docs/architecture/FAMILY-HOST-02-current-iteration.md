# FAMILY-HOST-02：旧当前迭代方案已被 Batch 0–2 计划取代

> 状态：Superseded（2026-08-21）
>
> 本文件保留路径，仅用于历史链接兼容；不再作为当前实现顺序。

原方案把 `gene_expression` 多表化作为当前 Family Host 主线，并围绕 `registered_multitable.runtime.v1` 设计 provider carrier。第二轮审计确认该 runtime 仍有完整 `Buffer`、`object[]`、旁路 executor 生命周期和大表验证边界问题，因此新路线将 expression 放入 Transform Host/Core shadow vertical slice，而不是直接切换该 runtime。

请改读：

- [06-expression-vertical-slice.md](../plans/family-host/06-expression-vertical-slice.md)
- [05-core-execution-product-gate.md](../plans/family-host/05-core-execution-product-gate.md)
- [09-execution-matrix.md](../plans/family-host/09-execution-matrix.md)

当前保留的有效结论：gene/probe 使用不同 projection；dataset/revision/asset identity 分层；GEO/GDC 只在兼容 partition 内整合；B3 大表按真实 workload 渐进 disk-backed；Publication 仍只能由 Core 创建。
