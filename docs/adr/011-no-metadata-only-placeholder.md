> Extracted verbatim from the legacy top-level decision index; see [README.md](README.md) for the full ADR index.

## 13. ADR-011：禁止 metadata-only 占位主表

### 状态

已接受，列为 P0。

### 当前问题

GEO 没有表达矩阵时，当前代码将样本元数据写成 `measurement_type=sample_metadata` 的表达 Schema 行，并在 Validation 中跳过表达值和 lineage 检查。

这解决了“空表”表象，却破坏了主数据语义。

### 决策

- 主表无合法记录时 outcome 为 NO_DATA；
- 样本元数据保存在辅助表；
- Validation 不允许 warning 或特殊字段豁免目标数据不存在；
- 空主表不发布为 succeeded；
- 可发布来源搜索和拒绝报告。

---
