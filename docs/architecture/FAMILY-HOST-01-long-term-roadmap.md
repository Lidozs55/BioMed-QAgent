# FAMILY-HOST-01：旧路线已被 FamilySpec + Transform Host 计划取代

> 状态：Superseded（2026-08-21）
>
> 本文件保留路径，避免历史链接失效；不再作为当前架构或实施依据。

原路线把 Family Host 建模为 builtin/curated/user/task package loader，并将可执行能力放入 Runtime Extension。第二轮设计已将中心模型改为：

```text
retrieval examples
  -> Agent-authored FamilySpec + DatasetTransform
  -> isolated Transform Host
  -> Core output admission / integration / validation / assessment
  -> Core-only Publication
```

请改读：

- [Family Host + Transform Host 计划集](../plans/family-host/README.md)
- [ADR-039: FamilySpec 与受控 DatasetTransform Host](../adr/039-family-transform-host.md)

重要边界：ADR-039 已Deferred。现有静态Registry、registered adapters、fixed derive slot和Core Publisher继续有效；当前不开发动态Transform Host/sandbox/IPC。不得依据本历史文档实现动态代码执行或删除现有Family runtime。
