> Extracted verbatim from the legacy top-level decision index; see [README.md](README.md) for the full ADR index.

## 18. ADR-016：迁移采用绞杀模式，不做一次性重写

### 状态

已接受。

### 决策

- V2 自包含 DatasetBuildSpec 和表达闭环并行加入；
- 不新增 DatasetRequest 或 BuildRecipe；
- 旧 `run_research_pipeline` 作为兼容 facade；
- 先抽取可靠性内核，再迁来源；
- 单独补齐 WorkflowRecipe 从 PROMOTED 到 SourceAsset 的生产消费闭环；
- 先迁 GDC/Xena，后迁 GEO；
- RunStatus、BuildResult、ValidationResult 和 Publication 双轨迁移；
- V2 前端和缓存双轨；
- 达到验收门槛后删除 Legacy。

### 原因

现有 Pipeline 有大量可靠性测试和复杂恢复语义。大爆炸重写风险高，且很容易丢掉比业务流程更成熟的基础设施。WorkflowRecipe 和状态体系也有现存消费者，必须以兼容层和特征测试保护迁移。

> **ADR 序列续篇：** Pi Agent / Host 迁移决策为 ADR-017 至 ADR-024，见
> [docs/adr/README.md](README.md)。此处保留既有章节编号，避免打断
> `ADR §N` 历史交叉引用。
