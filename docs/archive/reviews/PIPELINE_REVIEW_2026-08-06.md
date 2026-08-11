# Pipeline 复核：TP53/CRC 组合失败

## 结论

本次失败的直接原因是 Agent 将四类不同语义的数据源提交为一次 Pipeline
publication：GDC 表达矩阵、GEO 表达验证、PubMed 文献和 Reactome pathway
participants。当前 Runner 的 Validation Gate 只能发布一个统一的数据包，不能把
pathway participant 行与样本表达行安全地放进同一个 `main_data.csv`。PubMed 也
只是文献证据，不是可与表达矩阵做行级合并的数据集。

因此，`Reactome 混合源不被支持` 和 `GDC + GEO + PubMed` 不被支持是当前设计的
预期 fail-closed 行为，不是应通过放宽枚举解决的网络故障。Xena 的 403 也不应触发
同一组合反复重试。

## 实际支持路径

当前 Pipeline 的确定性闭环为：

- `GEO`，可选 `PubMed`（GEO 表达包 + 关联文献）
- `GDC`（单个显式项目和 `gene-expression`）
- `ucsc_xena`（单个显式数据集）
- `GDC + ucsc_xena`（两个基因级表达数据集的垂向合并）
- `Reactome`（单个显式 pathway participants）

该边界由 `SUPPORTED_PIPELINE_SOURCE_COMBINATIONS`、Discovery 的规格校验、各
Acquisition/Processing 分支共同实现。单一 capability 表只说明来源本身完成了
闭环，不代表任意来源组合都能合并。

## 本轮修复

`run_research_pipeline` 现在在 reservation 之前：

- 拒绝 accession 与 `databases` 不一致的调用；
- 对 GDC/Xena/Reactome 的必需参数返回 `missing_arguments`；
- 明确返回 `supported_paths` 和异构来源的 `next_step`；
- Reactome 混合源错误说明必须拆成独立 Pipeline run；
- malformed GDC 参数不会消耗一次 publication reservation。

Agent prompt 同步加入同样的组合边界和拆分策略，避免在 5 次调用限制内重复提交
必然失败的参数。

## 与赛题的契合度

现有五阶段结构对“来源追溯、下载校验、解析、清洗、字段映射、验证、CSV 输出”
契合度较高，尤其适合作为单一分析数据集的可审计发布器。对赛题要求的“多源异构
数据查找、解析与整合”仍是不完整契合：当前只有 GDC+Xena 的同构表达矩阵合并，
没有异构证据包契约，也没有多 GEO 独立发布、GDC mutation、GDC clinical live、
多 Reactome pathway 或把 Agent 发现结果纳入正式产物的闭环。

## 后续设计优先级

1. **P0/P1：异构证据包契约**。新增按数据集分区的 bundle（例如 `datasets/` 或
   每来源独立 artifact），保留各自 schema、source/asset/locator 和关系图；不要
   把不同 measurement model 行拼成 `main_data.csv`。Bundle 通过统一 Validation
   Gate 发布。
2. **P1：GEO 多数据集独立发布**。每个 GSE 独立 acquisition→processing→validation，
   `source_relations` 记录关系；不做跨 GSE 表达值行合并，避免无统计依据的 batch
   effect 处理。
3. **P1：TP53 变异路径**。为 GDC Masked Somatic Mutation 定义明确 parser、字段
   contract、样本/病例 lineage 和 artifact schema；当前 `gdc_data_type` 只支持
   gene-expression，不能把“GDC 有突变数据”当成已完成能力。
4. **P1：临床与分组语义**。完成 GDC clinical XML 血缘解析，并结构化 tumor/normal
   分组、配对 ID 和样本元数据，才能支撑表达/突变解释。
5. **P2：多轮研究编排**。允许多个 durable Pipeline runs 后，由一个结构化 evidence
   index 关联各 run 的 manifest/source IDs；每轮仍只能发布自身验证过的包。

在这些契约完成前，正确的 TP53/CRC 演示应拆为：GDC 表达单源（或 GDC+Xena 同构
验证）→ GEO 独立表达验证 → Reactome 独立 pathway → PubMed 文献证据，并在最终
报告中按 manifest/source_id 交叉引用，而不是声称一次 Pipeline 完成了四源整合。
