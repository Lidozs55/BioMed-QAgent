> Extracted verbatim from the legacy top-level decision index; see [README.md](README.md) for the full ADR index.

## 10. ADR-008：来源是否可用与数据是否可合并是两个维度

### 状态

已接受。

### 决策

保留来源安全和能力 allowlist，但移除“来源集合等于合并兼容性”的设计。

当前 `SUPPORTED_PIPELINE_SOURCE_COMBINATIONS` 将来源组合当成正式能力边界。重构后需要两层判断：

1. Adapter capability：系统能否安全获取和解析该来源；
2. Dataset compatibility：本次数据能否映射至目标 Schema 并合并。

例如，GDC 和 Xena 都可用，不代表任意 GDC 数据与任意 Xena 数据可合并。

---
