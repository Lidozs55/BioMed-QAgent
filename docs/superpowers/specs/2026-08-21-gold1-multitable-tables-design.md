# Gene Expression 多表化与 Schema 能力网络 —— 架构设计文档

- 日期:2026-08-21
- 状态:**设计已与用户对齐(决策 D1–D14 锁定),待实现**
- 本文为此前"gold1 四表设计"草稿的完整重写:旧前提"以 gold1-reference 为权威契约"已废弃
- 设计基线:**gold 参考数据非权威契约**(LLM 自主调研产物,未必正确、未必适配本系统);本设计基于赛题四维度需求(数据查找完备性 / 来源可追溯性 / 清洗整合可靠性 / 输出格式可用性)+ 系统架构自洽决策

## 1. 架构愿景:多对多 Schema 能力网络

### 1.1 核心思想

系统**预置一组规范化输出表 Schema**("表头组"的正名);每个数据源(source)声明自己能产出其中哪些 Schema(source↔Schema 为**多对多**);build 时由 **Agent(LLM 运行时)按任务需求决定**选哪些 source、产出哪些 Schema;多个 source 的产出在**同一 Schema 内合并清洗**,最终每个被选 Schema 产出一份规范化最终表。

**关键点:不是"固定产出 N 张表",而是能力网络**——每种 source 注册"能把原始数据展开成哪些规范化表形态"的能力,Agent 按需组合,不同任务可产出不同表集合。

### 1.2 总图

```
[预置 Schema 库] —(每个 source 声明可产出其中哪些)→ [source↔Schema 多对多]
                                              ↓ (LLM 运行时决策选 schema + source)
        多个 source 各产一张/多张 Schema 表
                                              ↓
  同 Schema 内聚合 → 清洗(去重/冲突/溯源,双层模型 §3.3) → 每个 Schema 一份最终表
```

### 1.3 四层模型

1. **Schema 定义层**:Schema 是一张可发布结果表的最小结构契约(`schema_id` / `row_granularity` / `primary_key` / `fields`),是家族 schema 注册表中的注册项,可被运行时校验、汇总、按此裁剪列。
2. **Source↔Schema 多对多层**:一个 source 可产出多个 Schema(如 GEO 可产 long 与 probe_long);一个 Schema 可被多个 source 产出(如 `gene_expression.long.v1` 是 GDC/GEO/Xena 三源共享)。**这是系统既有设计(`sources[].schema_refs` 白名单),非新增。**
3. **运行时决策层**:Agent 在 build spec 里声明 `schema_refs` / `source_bindings`,运行时按所选 source 的 schema 能力框定;同一源可选其能力子集。
4. **同 Schema 跨源合并清洗层**:同一 Schema 下不同 source 的表进入"聚合 + 清洗"过渡,每个被选 Schema 产出一份最终表,多 Schema 间相互独立。

## 2. 现状事实(代码级,已核实)

以下为设计必须以之为准绳的硬事实(2026-08-21,基于 commit 0bf23cf7 核验):

### 2.1 家族与运行时一刀切绑定

- `server/src/dataset/families/registry.ts` `PRODUCTION_RUNTIME_BY_FAMILY`:`gene_expression → "gene_expression.runtime.v1"`(单表);其余 5 家族 → `"registered_multitable.runtime.v1"`。
- `validateDefinition` 强制 `family.runtime_id === PRODUCTION_RUNTIME_BY_FAMILY[id]`:**家族级一刀切,无并档期**。切换后族内所有 build 走多表运行时。

### 2.2 三 source 能力矩阵(实证)

| Source | adapter_id | `gene_expression.long.v1`(gene 级) | `gene_expression.probe_long.v1`(probe 级) |
|---|---|---|---|
| GDC | `gdc.expression.v1` | 恒定产出 | 否 |
| Xena(ucsc_xena) | `xena.matrix.v1` | 恒定产出 | 否 |
| GEO | `geo.expression.v1` | 产出 | **条件产出**(唯一支持 probe 级的源) |

- 产出范围由家族注册表 `sources[].schema_refs` 白名单决定(`registry.ts`),非 adapter 自身。
- GEO probe 级条件 = GEO 绑定 + 探针形状 ID(`declaredNamespace() → geo_probe`)+ 提供 GPL annotation mappingAsset;probe→gene 映射在 canonicalizer 层做(仅翻转 namespace,不做值变换)。
- GDC/Xena adapter 集中 ported 于 `adapters.ts`(无独立目录),恒定 gene 级输出,无 probe 概念。

### 2.3 两条运行时路径的整合语义差距(关键缺口)

- **单表路径**(`gene_expression.runtime.v1`):`integrator.ts` 有完整整合语义——`append_by_canonical_row`(行身份 = gene/sample/measurement_type/value_semantics)、SQLite 流式确定性去重、同身份值冲突时保留第一源并写 `conflicts.csv` 审计。头注明确:**Agent 不可注入任意 merge 逻辑**。
- **多表路径**(`registered_multitable.runtime.v1`):`registered-multitable.ts` L469 对多 provider binding 是 `aggregateRows[tableId].push(...rows)` **裸 append**——无跨源去重、无冲突解析、无审计。**若不补齐,多表化后"清洗整合可靠性"相对单表是倒退。**

### 2.4 多表运行时机制

- provider carrier 分派(L331–367)按 `familyId/source/adapterId` 硬编码查表(`provider-bindings.ts`);**无 gene_expression 绑定,`providerRows` 无其分支,切过去直接 throw "unsupported provider carrier binding"**。
- schema 查表规则(L520):`schema.schema_id.split(".")[1] === table_id`。
- **只允许一个 primary**(L718):`candidate.tables.find(role === "primary")` 决定 manifest 主表。
- 同一 build 可声明多个 provider binding(只禁 provider 与 registered-table 混用)→ 多源同表聚合的通道已存在。
- B3 `validateMultiTableCandidate` 已支持 relations(foreign_key / cardinality / PK 唯一性)。

### 2.5 GEO 现成产物(binding 级,未聚合)

- **samples**:`series-matrix.ts writeSupportingAssets()` → `supporting/<bindingId>_sample_metadata.csv`,列 = `SAMPLE_METADATA_COLUMNS`(sample_id, source_sample_alias, title, organism, platform_id, sample_group, sample_group_raw, pairing_id, group_rule_id),含确定性 tumor/normal 分类(`GROUP_RULE_ID="geo.sample-group.v1"`)。
- **probe_gene_mapping**:`probe-mapping.ts buildProbeMapping()` → `canonical/<bindingId>_probe_mapping.csv`(列 = `MAPPING_DETAIL_COLUMNS`),另有 128 分片磁盘索引(临时生命周期)。
- **expression_long**:`base.ts SOURCE_LONG_COLUMNS`(19 列)长表 CSV + rejected CSV;三格式(tximport_counts / series_matrix / supplementary_matrix)流式解析。
- 缺口:二者均为 **binding 级产物,未聚合进 family assembly**;`ProbeMappingSummary` 及 `missing_sample_platform_evidence` / `ambiguous_multi_platform_mapping` guard 尚未接线 TS executor(`probe-mapping.ts` 头部 TODO)。

## 3. 目标架构

### 3.1 Schema 能力层(gene_expression 家族新增 4 个 Schema 2.0)

| 表 id | role | 粒度 | 说明 |
|---|---|---|---|
| `expression_long` | **primary** | probe_sample_measurement(或 gene 级) | 量测主干;沿用 SOURCE_LONG_COLUMNS 布局,补 `probe_id/unit/scale/platform_id/mapping_status` |
| `samples` | supporting(required 非空) | one biosample | 直接复用 `SAMPLE_METADATA_COLUMNS` |
| `probe_gene_mapping` | supporting(**allow_empty**) | probe→gene assertion | 复用 `MAPPING_DETAIL_COLUMNS`;基因级数据(tximport/ENSG)无 probe,故必须允许空 |
| `datasets` | supporting(required) | one series/pipeline carrier | **唯一真正的新表**:series accession、规模、跨平台 scale/unit 语义、source_locator |

- 旧 `gene_expression.long.v1` / `probe_long.v1` 保留为家族 schema 注册中的兼容引用。
- relations(经 assembler 声明,B3 校验):
  1. `expression_long.sample_id → samples.sample_id`(many_to_one,missing=reject)
  2. `expression_long.dataset_id → datasets.dataset_id`(many_to_one,missing=reject)
  3. `expression_long.probe_id+platform_id → probe_gene_mapping.probe_id+platform_id`(missing=profile_defined)
- rejected 态须承载:`missing_sample_platform_evidence` / `ambiguous_multi_platform_mapping` 等已有 rejected 分支进入表的 `status/mapping_status/reason` 列,不只留成功行。

### 3.2 Provider Carrier 层(三 source 全部本轮,GEO 先行)

- **GEO**:`providerRows` 新增 `gene_expression/geo` 分支,直接调用 `parseGeoSeriesMatrixSamples` / `buildProbeMapping` / 现成长表产物喂进四表——**零解析内核重写**。
- **GDC / Xena**:均为流式 SourceAdapter(无 table_id),carrier 重建需把其解析结果按各自能力注册为表(GDC/Xena 恒 gene 级 → 至少 `expression_long` + `samples`;无 probe 级)。
- 三源在 `expression_long` 等 schema 上**同 schema 对齐**,Agent 可跨源组合。
- **不做完整删除重构**(见 D10):GEO 三件套是经验证解析内核,删除即丢成熟实现并破坏 `base.ts` 列契约的跨 adapter 引用。

### 3.3 同 Schema 跨源合并清洗层(双层模型)

**A 层——确定性自动执行**(运行时内建):
- 同 schema 跨源聚合 + canonical 行身份去重 + 冲突审计(同身份保留第一源,记 conflicts)+ 来源标注。
- **复用 `integrator.ts` 的身份/冲突语义**(SQLite 流式、OOM 安全),扩展到多表路径,而非新造一套。

**B 层——LLM 深度介入**(确定性无法裁决的语义判断:跨源尺度/单位/平台冲突、探针映射争议等):
- 介入通道 = staging 中间层 + 备份后派生(受 INV-1 约束,见 §3.4)。
- 现阶段仅依靠**现有分析 + 预览工具**(LLM 从 staging 读取冲突行并背书取源);定向编辑工具列为 TODO(§7)。

### 3.4 不可篡改不变式(INV-1,全系统级)

> **确定性流程产出的任何表,LLM 一律不得 in-place 修改(无论何时何地)。若需非确定性改写,必须先做原始表备份,再基于"原始表(只读锚定)+ 备份"产出第二张派生表;原始确定性表始终不动。**

落点:staging 中间层许可介入;结果表层仅许可"备份 → 派生第二张表"。

### 3.5 Provenance 主锚点

`datasets` / `expression_long` 等表保留 `source_id` / `asset_id` / `source_locator` 列作为跨源 provenance 主锚点;relations 用 from/to + `missing_policy` 把跨源参考完整性显式化。

## 4. 决策记录(已与用户对齐锁定)

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 家族归属 | 扩展现有 `gene_expression` 家族(不新建) |
| D2 | 运行时 | 整族切换 `registered_multitable.runtime.v1`(一刀切,无并档) |
| D3 | carrier 迁移范围 | GDC / GEO / Xena 三 source **全部本轮** |
| D4 | 实现顺序 | **GEO 先行**跑通,再 GDC / Xena |
| D5 | 落地形态 | **Provider Carrier 多表展开**(仿 ChEMBL/BioC 模式,非每源单表) |
| D6 | 设计基线 | gold 参考非权威;按赛题四维度 + 系统自洽自行决策 |
| D7 | 目标模型 | 能力网络:source 注册表能力,Agent 按需组合(非固定 4 表) |
| D8 | 表来源 | `datasets` 为唯一真正新增表;其余三表复用现成 base |
| D9 | 空表语义 | `probe_gene_mapping` allow_empty(基因级无 probe);rejected 态须承载 |
| D10 | GEO 重构策略 | 新增 carrier 适配层、复用成熟解析内核;**不做完整删重构** |
| D11 | 多源协调层 | 多表 provider 聚合后必须接确定性去重 + conflict audit(复用 integrator 语义) |
| D12 | provenance | `source_id`/`source_locator` 为跨源追溯主锚点;relations 显式化 |
| D13 | B 层介入边界 | staging 许可;结果表仅"备份 → 派生第二张表"(INV-1) |
| D14 | B 层触发机制 | 现阶段仅现有分析 + 预览工具;定向编辑工具列 TODO |

## 5. 迁移路径(里程碑)

- **M1 — GEO 先行**:GEO provider carrier + 4 Schema 2.0 + assembler handler + B3 校验;单 GEO 源全量跑通,verify-gold01 门禁回归 + 新多表断言。可独立验证的稳定点。
- **M2 — 多源协调层**:A 层确定性去重 + conflict audit 接入多表路径(GEO 内多 binding 即可验证)。
- **M3 — GDC / Xena carrier**:复用 carrier/assembler 骨架,补两源,验证跨源同 schema 对齐与 relations。
- **能力网络验证**:spec 选不同 binding 组合出不同表集合、primary 可指定,证明"按需组合"而非固定输出。

## 6. 工程件清单

1. **Schema 2.0 + TableDefinition + relations** — 新文件 `server/src/dataset/families/gene-expression/multitable/schemas.ts`(4 表 + 3 relations)。
2. **Carrier 注册** — `provider-bindings.ts` 注册三 source;`registered-multitable.ts providerRows()` 加三分支。
3. **Carrier 实现** — 新文件 `families/gene-expression/multitable/provider.ts`(GEO 复用三件套现成函数;GDC/Xena 按各自 adapter 打平)。
4. **Assembler handler** — gene_expression registered assembler,注册进 `assembly/index.ts`(仿 `assembleTargetEvidenceCandidate`:summary↔schema↔column_count 校验、asset closure、表齐全、relations 完整)。
5. **家族定义切换** — `registry.ts`:`runtime_id` → multitable、schemas 追加 4 项、`PRODUCTION_RUNTIME_BY_FAMILY` 更新、`multitable_validation_policy`。
6. **多源协调层** — A 层去重 + conflict audit(复用 integrator 语义扩展到多表)。
7. **校验与发布** — B3 已知字段扩展 + profile 门禁(跨平台 scale/unit 语义)。

## 7. TODO / 扩展项(本轮不实现)

- **冲突行定向编辑工具**(B 层 a 方案):按 `conflict_id` / 源资产 id / 修正值编辑 staging 冲突行,产 audit 回填,再确定性重算收敛。受 INV-1 约束。
- **旧单表死路径清理审视**:整族切换后,`gene_expression.runtime.v1` 单表集成器、旧 schema 引用是否成死路径(切换收尾评估项)。
- **`ProbeMappingSummary` guard 接线**:`missing_sample_platform_evidence` / `ambiguous_multi_platform_mapping` 等旧 Python runner 逻辑接入 TS executor(`probe-mapping.ts` 头部 TODO)。
- **跨平台 scale/unit 深度治理**(GPL570 vs GPL887 语义)。

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 家族级一刀切:切换即全族多表,carrier 不齐备则运行即 throw | M1 先把 GEO carrier + schema + assembler 齐备再切;切换本身是最后一步 |
| GDC/Xena 流式 adapter 无 table_id,carrier 重建工作量被低估 | M3 独立里程碑;先验证 GEO 骨架,复用模式 |
| 裸 append 缺口不补 → 赛题"清洗整合可靠性"倒退 | D11 强制 M2 落地协调层,复用已验证的 integrator 语义 |
| B 层现仅"背书"无编辑工具,审计颗粒弱 | 明知取舍(D14);审计增强列 TODO |
| LLM 介入侵蚀确定性产物 | INV-1 不变式全系统级约束(备份 → 派生,原始只读) |

## 9. 关联

- 赛题:`PROBLEM.md`(评价四维度;L28-30 多源异构/来源记录/知识图谱与证据推理,L53 一张或多张 CSV)
- 既有计划:`plans/2026-08-18-gold-trusted-publication-closure.md`、`docs/TODO.md`(TASK-G1A/G1B/G1R)
- 实现顺序遵循本文 §5;实现前经 writing-plans 出实施计划
