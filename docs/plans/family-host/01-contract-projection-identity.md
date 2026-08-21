# WP-A：Contract、Projection 与 Identity

## 1. 目的

冻结 Family Host 后续可以复用的最小语义单元，先解决 `gene_expression` 多表化中的身份和拓扑歧义。该工作包只负责声明、解析、构造和离线验证，不负责直接切换 production runtime。

## 2. 交付范围

### 2.1 Expression projections

至少声明两个互斥 primary projection：

```text
gene_expression.expression_gene.v2
  row_granularity = gene_sample_measurement

gene_expression.expression_probe.v2
  row_granularity = probe_sample_measurement
```

共享 supporting tables：`datasets`、`samples`。probe projection 额外包含 `probe_gene_mapping`。禁止一个 Schema 同时承载 gene 和 probe 两种 row semantics。

### 2.2 Table / relation contract

为每张表定义：

- stable `table_id` 与 `schema_ref`；
- role：`primary` / `supporting` / `derived` / audit；
- required、allow-empty、partial publication policy；
- primary key、字段语义、单位和 namespace；
- source-backed 与 derived 字段区分；
- 每张表的 merge identity 和 conflict policy。

至少固定关系：

```text
expression.(dataset_id, sample_id)
  -> samples.(dataset_id, sample_id)
expression.dataset_id
  -> datasets.dataset_id
probe expression.(dataset_id, platform_id, probe_id)
  -> probe_gene_mapping assertion scope
```

具体 field names 必须在代码 Schema 与 fixture 中冻结，不能在 assembler 中用 `schema_id.split(...)` 推导。

### 2.3 Stable identity

- `dataset_id` 从 source namespace + accession + carrier/version 等来源事实确定性派生；不能使用 `build_id`。
- `samples` 使用 `(dataset_id, sample_id)` 或等价的 source-scoped composite key；保留 `source_sample_alias`。
- `probe_gene_mapping` 使用显式 `mapping_assertion_id`，保留 `platform_id`、`probe_id`、`target_gene_id`、`target_namespace`、`annotation_asset_id`、`mapping_rule_id`、`mapping_status`、locator；多 gene mapping 不得静默覆盖。
- `rejected_records`、`conflicts`、`binding_failures` 与 canonical measurement rows 分离。

## 3. 实施阶段

### A1：契约草案与 parser

在 `packages/contracts` 与 `server/src/dataset/contracts` 增加或扩展 versioned projection/table policy types。严格解析未知字段、重复 ID、未知 relation target、key 不在 fields 内、gene/probe granularity 混用等错误。

### A2：源码 Registry 兼容映射

在现有 `DatasetFamilyRegistry` 中以兼容形式登记 projection definition；保留现有单数 `schema_ref`。Core 根据 primary schema 解析 supporting topology，但不声称 Agent 已可提交任意 schema set。

### A3：fixture 与离线 assembler

建立小规模 fixtures，覆盖 gene-only、probe-level、缺失 mapping、重复 sample alias、多 mapping、conflict/rejected 分离。Assembler 只绑定 committed operation result 和 table definitions，不重新实现 parser/merge。

### A4：版本化迁移准备

记录旧 `gene_expression.long.v1` / `probe_long.v1` 与新 projection 的 compatibility mapping。不得原地改变已有 Schema 的 row granularity、primary key、unit policy 或 relation semantics；语义变化必须 bump version。

## 4. 依赖与并行关系

- A1 可立即开展；不依赖 GDC/Xena。
- A2 依赖 A1 的 ID 和 relation 语义。
- B（streaming primitives）可与 A1 并行，但 writer/result API 需在 A2 后适配。
- C（integration）必须等 A3 的 identity fixture 可用。
- E（semantic validation）必须等 A2 冻结 namespace/scale/unit/empty policy。
- F/G（Family Host/Agent）只能消费 versioned definition，不能反向修改本工作包的运行时语义。

## 5. 关键代码落点

- `packages/contracts/src/dataset-build.ts`
- `packages/contracts/src/dataset-multitable.ts`
- `packages/contracts/src/product-assessment.ts`
- `server/src/dataset/contracts/spec.ts`
- `server/src/dataset/contracts/multitable.ts`
- `server/src/dataset/families/registry.ts`
- `server/src/dataset/schema/expression.ts`
- `server/src/dataset/assembly/expression.ts`
- `server/src/dataset/assembly/registered-multitable.ts`

## 6. 测试与验收

- contracts strict parser：未知字段、重复 ID、错误 granularity、错误 relation、错误 key；
- projection fixtures：gene/probe、empty mapping、composite sample key、multi mapping；
- manifest parser：table/schema/relation/candidate closure；
- assembler：只能引用 committed result，不能接受 workspace path；
- compatibility：旧 v1 仍可解析，新 v2 不覆盖旧语义。

完成条件不是“能生成四个 CSV”，而是：每个 table 的身份、粒度、requiredness、relation、source/derived 字段均能由 versioned contract 解释，且旧 Publication 不受影响。

## 7. 风险与停止条件

- 若 product requirement 仍不明确，先保留 projection 为内部 contract，不开放 Agent schema selection。
- 若 stable source dataset identity 无法从 provider receipt 获得，阻止跨源 integration，不以 `build_id` 代替。
- 若某字段只有 LLM 推断而无 source evidence，应标记 derived/proposal，不能填入 source-backed canonical table。
