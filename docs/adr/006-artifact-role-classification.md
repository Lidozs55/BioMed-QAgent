> Extracted verbatim from the legacy top-level decision index; see [README.md](README.md) for the full ADR index.

## 8. ADR-006：Manifest 按 Artifact Role 分类，主数据不能混粒度

### 状态

已接受。

### 决策

Manifest 只定义五类稳定角色：

- `primary_dataset`
- `supporting_dataset`
- `schema`
- `provenance`
- `audit_report`

样本元数据、实体映射、来源选择、被拒记录、质量报告、搜索报告、warning 和下载审计均映射到这些角色，不在顶层架构固定各自文件名。

`SourceAsset` 保持独立身份，Manifest 引用其 ID。Publisher 可根据规模和展示需要，将同一角色拆成一个或多个物理文件。

多表并不代表回到“多角度研究包”。Supporting dataset 和审计产物服务主数据解释、映射、复算或质量审查，不与主表争夺业务中心。

### 特殊情况

如果数据天然是关系型结构，可有主事实表和维表，但必须显式建模关系、主表角色、family 和 row grain。
