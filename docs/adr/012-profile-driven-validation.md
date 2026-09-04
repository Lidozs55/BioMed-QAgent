> Extracted verbatim from the legacy top-level decision index; see [README.md](README.md) for the full ADR index.

## 14. ADR-012：Validation 由 Profile 驱动，架构层只保留三项发布不变量

### 状态

已接受。

### 决策

架构层只规定：

1. **Provenance closure**：正式记录可追溯到 SourceAsset、源定位、Parser/Adapter 版本、映射和转换；
2. **Validation Profile passed**：与目标 Manifest digest 对应的 Profile 判定通过；
3. **Atomic promotion**：只有引用闭合且 staging 完整的已验证 Manifest 才能原子提升。

具体规则属于版本化 Validation Profile，例如：

- 文件编码和列数稳定；
- Schema、类型和主键；
- measurement 完整率；
- 单位、尺度和归一化；
- warnings 与 metrics 一致；
- probe mapping 覆盖率；
- bbox、模型版本和 confidence；
- NO_DATA 或 PARTIAL_SUCCESS 的阈值。

Agent 只能选择服务端允许的 Profile 引用，不能在 BuildSpec 中传入 `minimum_valid_rows`、`allow_empty_primary_dataset` 等 acceptance policy。

### 测试策略

测试应锁定三项架构不变量和 Profile 结果，不应依赖全局 `check_id` 固定顺序，也不应把某个数据族的具体列规则提升为全局架构。
