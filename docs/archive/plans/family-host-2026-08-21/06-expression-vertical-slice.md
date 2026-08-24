# Expression Vertical Slice：GEO/GDC 与 Compatibility Partition

## 1. 定位

这是 Family Host 的第一个真实 workload slice，不是把 `gene_expression` 永久特殊化，也不是直接切换 `registered_multitable.runtime.v1`。短期继续使用现有 expression streaming executor，并逐步让它消费通用 primitives。

## 2. Source capability 不等于可合并

GEO、GDC、Xena 可以共享 execution/integration framework，但是否可 merge 必须按 partition 判断：

```text
schema_ref
row_granularity
taxon/organism
feature_namespace
measurement_type
value_semantics
value_scale
expression_unit
normalization_state
reference/genome version
```

规则：

- GEO gene/probe 是不同 projection；
- GDC 首批只声明 gene-level，不伪造 probe mapping；
- raw/count、log2、TPM、FPKM、不同 normalization 不能被强制合并；
- compatibility 相同的 partition 才能 dedup/conflict；
- 不兼容输入可作为独立 partition 共存，或按 FamilySpec/ProductAssessment block；
- source binding 顺序不决定 winner；
- 相同裸 sample/feature ID 在不同 dataset revision 不碰撞。

## 3. Batch 2A deliverables

### Expression contract

- `expression_gene.v2` 与 `expression_probe.v2`；
- `datasets`、`samples`、probe mapping assertion contract；
- `dataset_id` / `dataset_revision_id` / asset closure；
- stable table/relation/audit definitions；
- explicit schema-to-table mapping，禁止 `schema_id.split(...)`。

### GEO

复用 `series-matrix.ts`、`probe-mapping.ts`、`sample-metadata.ts` 的稳定 streaming logic，输出：

- expression primary；
- datasets/samples supporting；
- probe mapping assertions（probe projection）；
- rejected/conflicts/binding failures audit artifacts；
- locator、annotation asset、parser/transform receipts。

### GDC/Xena

以 shared projection contract 产出 gene expression、datasets、samples 和 source metadata；不使用 provider carrier 全量 `Buffer/object[]` 旁路。GDC/Xena 可在 Batch 2B 或后续独立完成，但必须消费 A/B/C 共用 identity/partition/integration。

### Core gate

- Core quarantine/output admission；
- compatibility partition；
- disk-backed PK/FK B3 slice；
- expression semantic validation；
- expression `ProductAssessment`；
- shadow publication/artifact hash parity；
- cancel/timeout/checkpoint/lock/fence regression。

## 4. GEO/GDC test matrix

至少覆盖：

1. GEO gene projection；
2. GEO probe projection，0/1/N gene mapping；
3. GDC gene projection、无 probe mapping；
4. 同 semantic partition 的 GEO/GDC 共用 integration path；
5. unit/scale/normalization 不同时 deterministic split/block；
6. 相同 sample ID 不同 revision 不碰撞；
7. annotation asset/mapping rule 变化形成新 mapping scope/revision；
8. binding reorder 不改变 output/conflict/assessment；
9. 大输入的 heap/temp/quota/cancel/restart；
10. Host shadow 与 legacy result 的表、关系、provenance、assessment 对比。

## 5. Activation gate

Batch 2A 通过只表示 expression shadow capability verified，不自动激活 production。要激活至少还需：

- Transform Host backend 在目标平台可用；
- Core output admission 与 publication closure 完整；
- 大表 B3 disk mode 不依赖无界 Map；
- GEO/GDC/Xena 的实际 capability 状态分别记录；
- frozen Gold1 same-commit evidence 通过对应产品要求；
- rollback 到 legacy runtime 可演练。

若只完成 GEO，不能把整个 `gene_expression` family 标记为 production ready。
