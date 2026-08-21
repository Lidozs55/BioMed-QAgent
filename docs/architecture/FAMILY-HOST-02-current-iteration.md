# FAMILY-HOST-02 当前这一轮改进计划

> 状态：当前实施计划
> 日期：2026-08-21
> 基线：`docs/superpowers/specs/2026-08-21-gold1-multitable-tables-design.md`
> 核心目标：完成 `gene_expression` 多表化，把 Gold1 做成未来 Family Host 的第一个真实 vertical slice，而不是再制造一套 family-specific 长期特例。

## 1. 本轮目标

本轮只解决当前最急迫的能力缺口：

1. `gene_expression` 从单表 runtime 迁移到多表能力；
2. GEO / GDC / Xena 能按 source↔schema 能力产出多表；
3. 同 Schema 多 source 不再裸 append，而经过确定性 integration；
4. 结果具备完整 provenance、relations、B3 validation；
5. Agent 可按任务选择所需 schema/source 组合；
6. 实现方式尽量为后续 FamilySpec / CapabilityResolver / GenericRuntime 留出抽象接口。

本轮不实现完整 Family Host，不允许范围失控。

## 2. 目标数据模型

`gene_expression` 新增/正式化以下多表 Schema 2.0：

| table_id | role | 说明 |
|---|---|---|
| `expression_long` | primary | 表达量主表 |
| `samples` | supporting | 样本元数据 |
| `datasets` | supporting | series / pipeline carrier 元数据与 provenance |
| `probe_gene_mapping` | supporting | probe→gene 映射，允许空 |

关系至少包括：

```text
expression_long.sample_id
    → samples.sample_id

expression_long.dataset_id
    → datasets.dataset_id

expression_long.(probe_id, platform_id)
    → probe_gene_mapping.(probe_id, platform_id)
```

第三条 relation 使用 profile-defined missing policy，以支持纯 gene-level 数据无 probe mapping 的情况。

## 3. Source ↔ Schema 能力矩阵

当前目标能力：

```text
GEO
├── expression_long
├── samples
├── datasets
└── probe_gene_mapping   # 条件能力

GDC
├── expression_long
├── samples
└── datasets

Xena
├── expression_long
├── samples
└── datasets
```

这里的关键不是“所有 build 固定输出四张表”，而是：

> Family 注册可用 Schema；source 注册自己能够产出哪些 Schema；Agent/build spec 选择本次需要的 schema/source 子集。

## 4. 本轮必须保留的 Gold1 设计

### 4.1 GEO 现有解析内核复用

不重写成熟 GEO 解析逻辑：

- `series-matrix.ts`
- `probe-mapping.ts`
- expression long parser

新增 carrier 适配层，将现有 binding 级产物纳入 family assembly。

### 4.2 同 Schema 确定性整合

必须补齐 `registered_multitable` 当前裸 append 缺口。

A 层统一执行：

```text
aggregate
  ↓
canonical identity
  ↓
deduplicate
  ↓
conflict detection
  ↓
keep deterministic winner
  ↓
conflicts audit
  ↓
provenance merge
```

优先复用现有 `integrator.ts` 的：

- SQLite 流式机制；
- canonical row identity；
- 冲突记录；
- OOM 安全设计。

不得为 multi-table 重新发明第二套冲突语义。

### 4.3 INV-1 不变

确定性流程提交的表不得由 LLM 原地修改。

LLM 若需要进行语义裁决：

```text
deterministic staging
    ↓
Agent review
    ↓
derived artifact
```

原始 deterministic artifact 永远保留。

## 5. 对原 Gold1 计划的调整

### 5.1 允许临时兼容，不扩张 hardcode

本轮可以暂时在现有：

- `provider-bindings.ts`
- `registered-multitable.ts`
- assembler registry

接入 gene_expression，以控制改动规模。

但新增代码应满足：

- family-specific 分支集中在单一适配边界；
- 不在 Generic Runtime 深处继续散布 `if (family.id === "gene_expression")`；
- source-specific transform 尽量封装为 capability/adapter handler；
- assembler handler 保持薄层；
- schema/table/relation 定义尽量保持纯数据结构，避免夹杂执行逻辑。

### 5.2 Assembler 只做最薄适配

当前可以新增 `gene_expression` assembler handler，但其职责只应包括：

- 将 integration results 映射成 table inputs；
- 调用通用 candidate 构造逻辑；
- 添加 family relation；
- 检查 asset closure。

不要在 assembler 中重新实现：

- parsing；
- merge；
- conflict resolution；
- provider dispatch。

### 5.3 required 语义尽量向 build-level 靠拢

本轮 schema 可暂时保留 required/optional 标记，但设计上区分：

```text
Family-level:
  可提供哪些 Schema

Build-level:
  本次选择哪些 Schema
  哪些是本次 Publication 必须项
```

避免把“Gold1 当前需要四表”固化成长期“gene_expression 永远必须四表”。

## 6. 里程碑

### M1 — GEO 多表 vertical slice

完成：

- 4 个 Schema 2.0；
- TableDefinition / relations；
- GEO provider carrier；
- `expression_long` / `samples` / `datasets` / `probe_gene_mapping` 产出；
- thin assembler；
- B3 validation；
- provenance；
- 单 GEO build 发布成功。

验收：

- 每张输出表 schema 正确；
- `source_asset_id` / `source_locator` 可追溯；
- relations 无 dangling references；
- `probe_gene_mapping` 在 gene-level 情形允许为空；
- validation gate 通过后才能 publish。

### M2 — Same-Schema Integration Layer

完成：

- multi-provider / multi-binding aggregation；
- canonical identity；
- deterministic dedup；
- conflict detection；
- conflict audit；
- provenance preservation。

至少使用 GEO 多 binding 验证。

验收：

- 不再使用裸 `push(...rows)` 作为最终整合语义；
- 重复 canonical row 不重复发布；
- 冲突可定位到 source asset；
- 相同输入产生相同输出与冲突决策。

### M3 — GDC / Xena Carrier

完成：

- GDC → expression_long / samples / datasets；
- Xena → expression_long / samples / datasets；
- 与 GEO 共享 schema contract；
- 跨 source 同 Schema integration。

验收：

- source 不同但相同 Schema 可进入同一 integration path；
- schema 对齐不依赖 source-specific table 名；
- provenance 不丢失；
- relations 继续满足 B3。

### M4 — Capability Network 验证

至少覆盖：

1. GEO 单源，含 probe mapping；
2. GDC 单源，无 probe mapping；
3. GEO + GDC 跨源；
4. 不同 build 选择不同 schema set；
5. primary schema 可由 resolved build contract 明确确定。

目的：证明实际实现是能力网络，而不是“固定四表模板”。

## 7. 建议工程落点

本轮优先关注：

```text
server/src/dataset/families/gene-expression/
  multitable/
    schemas.ts
    provider.ts
    assembler.ts          # 尽量薄

server/src/dataset/runtime/
  registered-multitable.ts
  provider-bindings.ts

server/src/dataset/integration/
  schema-integrator.ts    # 若能在本轮抽出则优先
```

如果时间不足，不强制新目录重构；但 Same-Schema Integration 逻辑必须形成独立函数/模块，避免直接嵌入 provider 特判。

## 8. 测试要求

至少新增或强化：

- schema definition tests；
- relation validation tests；
- GEO four-table carrier tests；
- allow-empty probe mapping tests；
- GDC/Xena capability tests；
- same-schema deterministic dedup tests；
- same-schema conflict audit tests；
- provenance closure tests；
- multi-source integration tests；
- publication rejection tests；
- Gold1 representative end-to-end run。

测试应检查产品语义，不只检查函数返回成功。

尤其禁止仅以：

```text
BuildResult.succeeded === true
```

作为 Gold 成功标准。

必须检查：

- required/selected tables；
- schema refs；
- row counts；
- relation integrity；
- provenance；
- conflict audit；
- validation status；
- publication artifacts。

## 9. 本轮明确不做

不实现：

- 完整 Family Host；
- 动态扫描 user/task family package；
- Agent `create_family`；
- Agent-generated runtime extension；
- family promotion；
- 全部现有 6 Family 声明式重构；
- 完整 removal of legacy single-table runtime；
- 大范围仓库卫生重构。

本轮只要求新增代码不阻碍后续这些工作。

## 10. 本轮结束后的直接下一步

完成 Gold1 后立即进入一次小型抽象审计：

1. 哪些 gene_expression 新代码本质通用；
2. 哪些 `if (family/source)` 可以移动到 capability registry；
3. 哪些 assembler 逻辑可归入 GenericFamilyAssembler；
4. schema 是否已可序列化为纯 JSON；
5. Same-Schema Integration 是否已完全 family-agnostic；
6. 是否可以用一个最简单的新 declarative family 验证 loader 原型。

该审计作为 `FAMILY-HOST-01` L1/L2 的入口。
