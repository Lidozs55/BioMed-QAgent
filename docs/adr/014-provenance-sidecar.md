> Extracted verbatim from the legacy top-level decision index; see [README.md](README.md) for the full ADR index.

## 16. ADR-014：Provenance 以记录/批次 sidecar 为主，主表只保留引用

### 状态

已接受。

### 决策

主表保留最小字段：

- `record_id`
- `source_id`
- `asset_id`
- `provenance_id`

详细定位、原值和转换链放在 lineage sidecar。这样既保持主表可分析性，又能完整追踪。

### 例外

Demo 或小表可以内联关键来源字段，但 Manifest 和 sidecar 仍为权威来源。

---
