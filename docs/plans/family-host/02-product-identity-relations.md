# Projection、产品身份、Relation 与 Audit Contract

## 1. Projection

Family 不是固定 N 张表，也不是 Agent 任意拼表：

```text
FamilySpec -> Projection -> admitted table topology
```

Projection 冻结 primary/supporting/derived tables、required/optional/allow-empty、relations、row granularity、compatibility dimensions、merge identity、validation/assessment refs。BuildSpec 1.0 暂以 primary `schema_ref` 映射到 Core-owned projection；2.0 使用显式 projection ref。

Expression 首批 projection：

```text
expression_gene.v2  -> expression + samples + datasets
expression_probe.v2 -> expression + samples + datasets + probe_gene_mapping
```

一个 Schema 不能同时表示 gene_sample_measurement 与 probe_sample_measurement。

## 2. TableRole 与 AuditArtifact

现有正式 `TableRole` 保持：

```text
primary | supporting | derived
```

本计划**不增加 `audit` TableRole**。原因：rejected rows、conflicts、binding failures、validation findings 描述处理过程，而不是 biomedical product topology。

```text
canonical/derived scientific data -> TableDefinition
processing failure/conflict log   -> audit artifact (`audit_report`)
```

结构化 CSV/JSONL audit 可以有独立 `AuditArtifactDefinition`（schema ref、fields、locator、receipt、append-only policy），并由 validation 检查，但：

- 不得成为 primary/supporting/derived table；
- 不得满足 required entity/measurement；
- 不参与 canonical integration；
- 不因存在而使 ProductAssessment 通过。

`mapped/unmapped/ambiguous` 若是来源支持的 mapping assertion 状态，仍属于 supporting scientific table；malformed/unauthorized/parser failure 属于 audit artifact。

## 3. 三层 dataset identity

| ID | 含义 | 规则 |
|---|---|---|
| `dataset_id` | 稳定逻辑数据集 | `source_namespace + canonical_accession`；source version 通常不参与 |
| `dataset_revision_id` | 一次可复现来源快照 | dataset ID + source revision token + provider snapshot identity + sorted carrier asset IDs |
| `asset_id` | 精确文件 bytes | `asset_<sha256>` |

另有：`build_id` 是一次执行；`transform_digest` 是实现；`family_spec_digest` 是产品合同；`publication_id` 是正式不可变发布。

规则：

- `build_id` 永远不能充当 dataset identity；
- 一个 revision 可以由多个 asset 组成，故 asset ID 不能替代 revision；
- source 无 revision token 时记录 `null`，以 exact carrier closure 保证本次快照可重放；
- sample/measurement 引用 `dataset_revision_id`；`dataset_id` 用于跨 revision 归组；
- 跨 revision 不静默覆盖；manifest 保留 dataset/revision/input asset closure。

建议：

```text
dataset_id = ds_<hash(namespace, accession)>
dataset_revision_id = dsrev_<hash(dataset_id, revision_token|null,
                                    provider_snapshot, sorted asset IDs)>
```

## 4. Sample identity

跨来源/数据集使用：

```text
samples PK     = (dataset_revision_id, sample_id)
expression FK  = (dataset_revision_id, sample_id)
```

保留 `source_sample_alias` 与 canonicalization evidence。相同裸 sample ID 位于不同 revision 时不得 dedup。

## 5. Probe mapping assertion

`probe_gene_mapping` 的 PK 是 `mapping_assertion_id`，不是 `(probe_id, platform_id)`。至少保留：

- `mapping_assertion_id`；
- `dataset_revision_id`、`mapping_scope_id`；
- `platform_id`、`probe_id`；
- `target_gene_id`、`target_namespace`（unmapped 时可空）；
- `annotation_asset_id`、`mapping_rule_id`；
- `mapping_status = mapped | unmapped | ambiguous`；
- source locator / confidence / review refs。

多 gene mapping 用多 assertion 表达，不能覆盖。

### 5.1 可直接交给 RelationDefinition 的 v1 relation

```text
relation_id: probe_expression_mapping_coverage
from_table_id: expression
to_table_id: probe_gene_mapping
from_fields: [dataset_revision_id, platform_id, probe_id]
to_fields:   [dataset_revision_id, platform_id, probe_id]
cardinality: many_to_many
missing_policy: profile_defined
```

这是 coverage relation，不要求 mapping target fields 唯一。expression 表中每个 sample 可重复同 probe，mapping 表可有多个 target assertion，故 `many_to_many` 是明确语义。

普通 B3 检查字段存在和 relation keys；semantic validator 检查：要求覆盖的 distinct probe 数、mapped/unmapped/ambiguous 分布、annotation receipt、阈值和 review policy。gene-level projection不声明该 relation。

长期若需要把“probe存在”与“mapping assertion”完全分离，可增加 `probes` / `mapping_scopes` 维表；它不是 Batch 0–2 的前置。

## 6. Merge identity 与 compatibility

Expression identity 至少包含：

```text
dataset_revision_id, sample_id,
feature_namespace, feature_id,
measurement_type, value_semantics, value_scale,
expression_unit, normalization_state
```

probe projection额外包含 platform/probe identity。source binding 顺序不能决定 winner。不同 granularity、unit、scale、normalization、taxon或reference version先进入 compatibility partition，只有相同 partition 内才 dedup/conflict。

## 7. 验收

- dataset source revision变化保留同 dataset_id、产生新 revision ID；
- carrier bytes变化使 revision closure变化；
- 同 sample ID 不同 revision 不碰撞；
- 一 probe 对 0/1/N gene 均可表示；
- RelationDefinition字段、方向、cardinality、missing policy均可 strict parse；
- audit row 不能计入产品 table/row count或 assessment requirement；
- `server/src/dataset/integrator/integrator.ts` 中任何 `dataset_id = buildId` 路径最终有红灯测试和迁移计划。
