# Gold7 Alzheimer GWAS Family Design

> 状态：设计草案，尚未注册为 production family。本文解决 gold7 的
> family/provider 缺口；不把 discovery 工具或 workspace 文件提升为发布能力。

## 1. 问题边界

gold7 的请求不是一般的 variant assertion。它要求把同一研究问题下的
GWAS Catalog 关联、Bellenguez et al. supplementary loci 和 dbSNP GRCh38
坐标/变异身份整合为三张可追溯表：研究、位点、变异-基因映射。因此现有
`variant_evidence` 不适合作为替代：它的主粒度是“一个条件下的一个变异断言”，
没有 study、lead/secondary locus、association effect 或 GWAS source record 的
语义。

本设计新增 family `gwas_association`，采用现有
`registered_multitable.runtime.v1` 和标准 Core build/publish 链。第一阶段只
支持 Alzheimer disease 的 EFO/trait binding；family 本身不硬编码 Alzheimer，
trait 作为 build 参数和来源证据的一部分。

## 2. 固定拓扑

| 表 | 角色 | 行粒度 | 主键 | 说明 |
| --- | --- | --- | --- | --- |
| `gwas_studies` | primary | 一个被选中的 GWAS study/analysis | `study_id` | GWAS Catalog accession、trait、样本/期刊元数据和来源绑定 |
| `gwas_loci` | primary | 一个 study 中一个独立或报告的风险位点 | `locus_id` | lead variant、原始坐标、显著性、方向/效应字段和来源 locator |
| `variant_gene_mappings` | primary | 一个 locus variant 到一个 gene 的声明或确定性映射 | `mapping_id` | variant identity、GRCh38 坐标、gene namespace、mapping method/status |
| `sources` | supporting | 一个不可变来源载体/来源定位 | `source_id` | SourceAsset、provider revision、retrieval time、locator |
| `evidence` | supporting | 一个表行的来源或确定性转换证据 | `evidence_id` | 原始值、locator、digest、evidence kind |

三张 primary 表都必须非空；每个 primary row 至少关联一个 source 和一个
evidence。`sources`/`evidence` 使用 family 自己的 schema，不复用
`variant_evidence` 的 assertion 状态字段。

### 2.1 不可推断的字段

- `study_id` 必须是 GWAS Catalog accession 或受控的 paper-study identity，不能
  由标题 hash 冒充 accession。
- `trait_id`/`trait_namespace` 必须保留 GWAS Catalog 原始 trait/EFO 标识；不能把
  “Alzheimer's disease” 文本匹配当作 EFO 证明。
- `locus_id` 必须保留来源 study 与来源行 identity；同一 rsID 在不同 study 中不能
  静默去重成一行。
- `reference_assembly`、`chromosome`、`position`、`reference_allele`、
  `alternate_allele` 必须逐字段保留 raw value 和 normalized value。无法确认
  GRCh38 的行进入 rejected/no-data，不回填旧 assembly 坐标。
- `mapping_status` 只允许 `reported_gene`、`dbsnp_resolved`、`unmapped`、
  `conflict`；Ensembl/nearest-gene 只能作为明确标记的 derived evidence，不能
  覆盖来源报告的 gene。

## 3. Provider 与 acquisition contract

首批注册三个 provider；每个 provider 都必须产生 Core 可消费的 immutable
SourceAsset，而不是返回 Agent 内存中的 JSON：

| provider id | 真实来源 | 输入 | 输出/约束 |
| --- | --- | --- | --- |
| `gwas_catalog.associations.v1` | EMBL-EBI GWAS Catalog REST/API 或官方导出 | exact trait accession、page/cursor、release | study/association records；记录 Catalog release/version 和请求 URL |
| `europepmc.supplementary.v1` | Europe PMC `supplementaryFiles` archive | PMCID/PMID、expected file selector | Bellenguez supplementary ZIP/XLSX；保存 archive digest、entry name、cell/row locator |
| `ncbi.dbsnp.refsnp.v1` | NCBI Variation RefSNP API | numeric rsID batch，3 req/s shared limiter | 每个 rsID 的 GRCh38 placements、alleles、status；单条失败不可扩展为全批成功 |

Provider revision evidence 必须包含 canonical accession、provider snapshot
identity、revision token（Catalog release / archive digest / API retrieval
snapshot）和 SourceAsset registration receipt。dbSNP 的数字路径、批次顺序、
失败/重试信息必须进入 operation provenance。

Ensembl gene lookup 不作为 gold7 第一阶段的必需 provider。若后续加入，必须新增
`ensembl.gene_mapping.v1` 并把结果放在 derived mapping/evidence 中，不能把它当作
GWAS Catalog 的原始 gene assertion。

## 4. 确定性 build 骨架

Core 仍执行固定序列：

```text
acquire[gwas_catalog, europepmc, dbsnp]
  -> parse each source
  -> canonicalize source rows while retaining raw fields
  -> compatibility gate (trait, study identity, assembly, allele orientation)
  -> integrate with explicit identity keys
  -> fixed derive: dbSNP placement/gene mapping closure
  -> validate gwas_association.release.v1
  -> publish immutable DatasetPublication
```

Transform 只做受控字段映射、去重键计算、等位基因方向/assembly 检查和关系闭合。
不能在 transform 中调用网络、猜测 gene、合成效应值、或者读取 workspace 路径。
dbSNP 网络获取必须由 Core acquisition request 完成；Agent 的 `lookup_dbsnp`
只用于 discovery/诊断，不能成为 publication input。

## 5. Validation 与发布门

`gwas_association.release.v1` 至少检查：

1. `gwas_studies`, `gwas_loci`, `variant_gene_mappings`, `sources`, `evidence`
   全部非空，主键唯一。
2. 每个 locus 的 `study_id` 存在；每个 mapping 的 `locus_id` 和 `source_id`
   存在；每个 source/evidence locator 的 asset digest 与注册 receipt 相符。
3. 研究 trait 必须与 build 的 exact trait binding 相符；不能把相邻 phenotype
   混入 Alzheimer build。
4. 每个需要 GRCh38 的 locus 必须有 dbSNP success evidence；缺失、HTTP 失败、
   解析失败或 allele conflict 都进入 rejected rows，并阻止 primary publication，
   除非未来明确批准 partial profile。
5. dbSNP 返回 `not_found` 与 transport failure 分开记录；前者是可审计的
   `unmapped`，后者是 acquisition failure，不能折叠为同一个空值。
6. 来源之间相同 rsID/coordinate 的冲突必须保留 conflict evidence。默认策略是
   `retain_conflict_and_block_primary`，不能 silently prefer Bellenguez 或 Catalog。
7. `mapping_status=unmapped` 只允许在 supporting/rejected 结果中出现；主发布的
   mapping primary 表要求 `reported_gene` 或 `dbsnp_resolved` 的完整证据。

在 provider 不可达或完整性不足时，Core 返回 `no_data`（或有明确 rejected
rows 的 `partial_success`，仅在未来批准 profile 后），`publication_id` 必须为
null，workspace 草稿不得出现在 Artifact API。

## 6. 扩展设计

### 6.1 新 trait

不新建 family。新增 exact trait binding、Catalog release evidence 和 fixture/live
测试；dataset identity 必须由 trait binding、provider revisions、schema/profile
和 normalized source digests 共同决定。

### 6.2 新 GWAS provider

只新增 provider registration + parser/schema mapping + compatibility tests。不能在
transform 中加入 provider-specific 分支；provider 输出必须先归一化到
`gwas_studies`/`gwas_loci` 的 raw/normalized contract。

### 6.3 新 variant resolver

允许新增 `variant_resolver` capability（例如 future Ensembl/Allele Registry），
但每个 resolver 结果都要以独立 evidence/source 记录，采用 deterministic priority
和 conflict retention。resolver 不能改变原始 locus 行 identity。

### 6.4 新分析字段

效应值、标准误、P 值、OR/CI 等字段只有在来源 schema 明确提供且单位/尺度可比时
加入版本化 projection。已有 publication 不变；新 projection/family semantic
version 生成 superseding publication。

## 7. 实现分期与验收

1. **Schema/registry**：新增 family definition、5 张 schema、表关系、profile 和
   registered parser；验证 family catalog/skill-tool map 一致性。
2. **Providers**：注册三个 Core acquisition providers，先写 fixture tests，再做
   live smoke；测试 429/5xx、archive entry 缺失、dbSNP 部分失败和并发限流。
3. **Transform/assembly**：实现 raw-preserving canonicalizer、identity merge、
   conflict retention 和 deterministic mapping closure；禁止 workspace input。
4. **Publication E2E**：用小型真实 source assets 跑 `validate -> execute ->
   publish`，检查 Artifact API 字节 hash、manifest/provenance closure 和
   `current_publication_id`。
5. **Gold7 rerun**：只允许 TOPIC.txt 作为 Agent input；成功标准是正式
   DatasetPublication。任何 source blocker 标准结果是结构化 `no_data`，不是
   completed workspace CSV。

## 8. 明确不做

- 不把 `variant_evidence` 改名或扩字段来承载 GWAS study/locus 语义。
- 不把 `lookup_dbsnp`、浏览器结果、workspace CSV 或模型记忆作为 Core source。
- 不先实现 Ensembl nearest-gene 推断来“填满”映射表。
- 不为通过 gold7 而降低 provenance、assembly、conflict 或 non-empty validation
  门槛。
