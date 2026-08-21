# FAMILY-HOST-04 — 下一轮开发注意事项

> 状态：下一轮实现前约束 / 审计吸收稿  
> 适用范围：`gene_expression` Gold1 多表化、Family Host 前置抽象、Dataset Core 可信发布链  
> 基线：结合 2026-08-21 Gold1 多表设计、当前仓库实现与本地 Agent 代码审计整理  
> 原则：吸收代码事实与可靠性问题，但不把短期兼容方案固化为长期架构。

## 1. 结论

下一轮不应直接按现有 Gold1 设计把 `gene_expression` 整族切换到当前 `registered_multitable.runtime.v1`。

原因不是“多表方向错误”，而是当前通用多表 runtime 尚未具备 expression 大数据路径已经拥有的关键运行保证：流式处理、disk-backed integration、checkpoint/recovery、cancel/timeout、build fencing、mapping/metadata receipt closure 以及大表验证边界。

同时，也不应因此退回“所有表拓扑永久由 Core 写死、每个 family 永远维护专用 executor”的保守方案。下一轮正确定位应是：

1. 保留并扩展现有 expression streaming executor，先完成可信多表 projection；
2. 将新能力设计成未来可抽取的通用 primitive，而不是继续堆 `gene_expression` 特例；
3. Family Host / 动态 Family 仍是长期目标；短期只是不让未成熟的 generic runtime 承担 production expression workload；
4. Agent 负责提出需求、选择/生成 capability 与 review proposal，Core 负责验证、确定性执行、形成 committed results 与 publication admission。

因此短期架构应是：

```text
DatasetBuildSpec 1.0
  -> existing expression streaming executor
  -> family-owned projection
  -> file-backed supporting tables
  -> deterministic per-table integration
  -> B3 structural validation
  -> expression semantic validation
  -> ProductAssessment
  -> Publisher
```

长期仍演进为：

```text
Family Host
  -> declarative FamilySpec / Schema capability graph
  -> capability resolver
  -> generic streaming execution primitives
  -> optional trusted runtime extensions
  -> deterministic validation / assessment / publication
```

---

## 2. 本轮必须吸收的审计结论

### 2.1 不直接切换到当前 `registered_multitable.runtime.v1`

当前 runtime 存在三类硬问题：

- provider carrier 读取会缓冲完整输入；
- provider 多表聚合使用内存 `object[]`；
- 表落盘后又可能完整读回以统计行数。

这些行为与 expression 大矩阵的 streaming / bounded-memory 目标直接冲突。

**本轮约束：**

- `gene_expression` production execution 暂时继续使用现有 fixed/streaming executor；
- 不允许为了多表化把 expression rows 转成全量 `object[]`；
- supporting tables 必须 file-backed / streaming；
- 如改造 generic runtime，只能作为独立基础设施任务，不与 Gold1 业务改造捆绑切 production。

### 2.2 gene / probe primary granularity 必须拆分

一个 Schema 不能同时表示 `gene_sample_measurement` 与 `probe_sample_measurement`。

建议在同一 `gene_expression` family 下提供两个明确 primary projection：

```text
gene_expression.expression_gene.v2
  row_granularity = gene_sample_measurement


gene_expression.expression_probe.v2
  row_granularity = probe_sample_measurement
```

二者可共享：

- `datasets`
- `samples`

probe projection 额外拥有：

- `probe_gene_mapping`

**禁止：**继续使用“probe_sample_measurement（或 gene 级）”这类模糊 row semantics。

### 2.3 DatasetBuildSpec 1.0 不假装支持多 `schema_refs`

当前 wire contract 只有单数 `schema_ref`。本轮不要临时加入未经版本化的 `schema_refs`，也不要让实现文档声称 Agent 已能任意选择表集合。

本轮建议语义：

```text
Agent chooses:
  - primary projection
  - source bindings

Core projection resolves:
  - supporting tables
  - relations
  - validation policy
  - publication roles
```

注意：这是 **DatasetBuildSpec 1.0 的短期兼容语义**，不是长期架构原则。

长期 Family Host 仍允许 Agent：

- 搜索 family/schema/capability；
- 选择已注册 capability；
- 创建 task-scoped declarative FamilySpec；
- 提出需要的 schema set。

但最终 resolved topology 必须经过 Core validator，不能由 Agent 绕过 contract 直接拼 PublicationCandidate。

### 2.4 supporting outputs 必须升级为 Core-owned committed results

当前已有的：

- sample metadata；
- probe mapping；
- rejected rows；
- conflicts；

不能继续只作为“磁盘 sidecar”。

正式 publication 中的每张表都必须具备：

- Schema 2.0；
- TableDefinition；
- committed `OperationResultManifest`；
- source/mapping/metadata receipt closure；
- assembler 引用；
- B3 / semantic validation；
- Manifest artifact entry；
- hash closure。

### 2.5 identity 语义需要修复

#### dataset identity

`build_id` 不能充当 source dataset identity。

应引入稳定、来源驱动的 `dataset_id`，至少由以下信息确定性派生：

```text
source namespace + accession + carrier/version
```

#### sample identity

跨来源场景下不要只用 `sample_id` 做全局 PK。

推荐：

```text
samples PK = (dataset_id, sample_id)
expression FK = (dataset_id, sample_id)
```

并明确：

- `sample_id`
- `source_sample_alias`
- `dataset_id`

之间的 canonicalization 规则。

#### probe mapping identity

不能默认 `(probe_id, platform_id)` 足以唯一标识 mapping assertion。

至少考虑：

```text
mapping_assertion_id
dataset_id
platform_id
probe_id
target_gene_id
target_namespace
annotation_asset_id
mapping_rule_id
mapping_status
source_locator
```

多 gene mapping 必须可表达，不能静默覆盖。

### 2.6 rejected / conflicts 与 canonical rows 分离

不要把 malformed / unauthorized / binding-level failure 通过 `status/reason` 塞进 expression primary。

正式语义分层：

```text
canonical tables
  - valid source-backed records / assertions

audit artifacts
  - rejected_records
  - conflicts
  - binding_failures
  - validation findings
```

mapping table 可以表达 source-backed assertion 状态，如 `mapped / unmapped / ambiguous`；但 parser rejection、非法数值、缺失关键平台证据等不应污染 primary measurement rows。

### 2.7 merge strategy 必须 schema/table-owned

现有 expression integrator 的 identity 规则不能直接假装成为通用多表 merge engine。

下一轮至少定义 per-table merge contract：

| 表 | 合并策略 |
| --- | --- |
| expression primary | compatibility partition 后 disk-backed canonical identity merge |
| datasets | PK 去重；字段冲突 audit/block |
| samples | composite PK 去重；metadata conflict 显式保留 |
| probe_gene_mapping | assertion identity 去重；多映射不静默覆盖 |
| rejected/conflicts | append-only audit |

expression identity 至少考虑：

```text
dataset_id
sample_id
feature_namespace
feature_id
measurement_type
value_semantics
value_scale
expression_unit
is_normalized
```

probe primary 额外包含 `platform_id`。

**禁止：**通过 Agent 提交的 source binding 顺序隐式决定“第一来源获胜”。如需要 source precedence，应来自受信任 registry/policy；否则保留冲突或阻塞 publication。

### 2.8 Validation 不能只靠 B3

B3 负责结构与关系，不等价于 expression scientific semantics。

本轮必须保留/补齐：

- namespace validation；
- scale/unit/normalization compatibility；
- probe mapping coverage；
- empty/partial publication policy；
- confidence/review policy；
- mapping/metadata receipt checks。

同时评估 B3 在大表上的 JS `Map` 内存边界。若 PK/FK/cardinality 扫描不能 bounded-memory，应提供 disk-backed index 或至少在 production cutover 前建立明确规模门限与压力测试。

### 2.9 provenance 必须由实际 closure 计算

不能使用固定：

```text
coverage_ratio = 1
```

应根据真实 committed evidence 计算：

- traced / untraced rows；
- source asset receipts；
- mapping / annotation receipts；
- parser/adapter version；
- integration decisions；
- conflict/review/correction records。

### 2.10 expression 产品必须接 ProductAssessment

新增通用、非 Gold-specific 的 expression product assessment，例如：

```text
package_id = expression_evidence
```

至少判断：

- Dataset/Study 是否存在；
- Sample 与 measurement 是否闭合；
- ExpressionMeasurement 是否存在；
- probe projection 下 mapping assertion 状态；
- provenance locator/receipt 是否闭合；
- required artifact hash 是否存在；
- review/correction 状态是否允许发布。

只有实际 artifact hashes 回填后 `publishable`，才允许 promotion。

---

## 3. 对本地审计中“过度收紧”结论的修正

### 3.1 “表拓扑必须永久由 Core-owned projection 决定”只适用于本轮

在 DatasetBuildSpec 1.0 和当前 runtime 约束下，本轮由注册 projection 决定 supporting tables 是合理的。

但长期不应固化为：

```text
Agent 永远不能选择/扩展 table topology
```

Family Host 目标仍是：

```text
Agent proposes / selects capabilities
        -> Core validates FamilySpec + capability graph
        -> Core resolves executable topology
        -> deterministic execution
```

也就是说：

- Agent 可以表达“我需要哪些数据形态”；
- Agent 可以创建 task-scoped declarative family/schema；
- Core 决定该声明是否满足 contract、trust 与 resource policy；
- Agent 不能直接构造可信 publication。

这是“Agent 可扩展 + Core admission”，不是“Core 永久写死”。

### 3.2 “保留 expression fixed executor”是迁移策略，不是长期目标

下一轮应保留现有 executor，因为它已经拥有成熟 streaming/recovery 能力。

但新增实现应优先抽出未来可复用的 primitive：

- file-backed table writer；
- disk-backed identity merge；
- source receipt closure；
- table-level OperationResult；
- relation validation adapter；
- projection assembler；
- ProductAssessment hooks。

禁止继续复制：

```text
if family === gene_expression
```

式核心逻辑。目标是以后逐步让 generic runtime 复用这些 primitive，而不是让 expression executor 永久特殊化。

### 3.3 LLM correction 不必强制每次“人工批准”，但必须 durable + replayable

审计提出“durable HIL + human accept/reject + Core replay”的信任方向正确，但“所有语义冲突必须人工批准”过于死板。

更通用模型：

```text
Core emits typed ConflictCandidate
    -> Agent proposes typed ResolutionDecision
    -> policy decides:
         auto-admit / require human review / reject
    -> immutable DecisionRecord
    -> server-owned deterministic replay
    -> committed OperationResult
    -> revalidate
```

因此长期约束是：

- LLM 不直接编辑 publication-eligible CSV；
- LLM 输出 typed proposal；
- 是否需要 human approval 由 policy/HIL profile 决定；
- 最终数据改写必须由 Core deterministic transform 执行；
- replay identity、implementation digest、decision/evidence digest 必须可追溯。

### 3.4 “三源全部完成后才能上线”取决于 activation model

如果继续维持当前 family-level runtime 一刀切，则审计结论成立：GEO/GDC/Xena 与 legacy spec 必须全部闭合后才能 production cutover。

长期 Family Host / capability registry 应允许更细的 activation：

```text
family
  -> projection
     -> source capability
        -> status/version
```

未完成 capability 不应对 Agent 宣称可用；已验证 capability 可以独立启用。

本轮若不改 activation model，就按保守条件执行：**不要在只完成 GEO 时整族切 production。**

---

## 4. 下一轮推荐实施顺序

### M0 — 修订设计，不编码 production cutover

先锁定：

1. gene/probe 两个 primary projection；
2. stable source-derived `dataset_id`；
3. composite sample identity；
4. probe mapping assertion identity；
5. canonical / rejected / conflict 分层；
6. per-table merge identity；
7. expression semantic validation；
8. expression ProductAssessment；
9. 本轮继续使用 existing expression executor；
10. Family Host 兼容目标：新增设计必须可后续声明式抽取。

### M1 — Schema / projection / assembler 离线闭环

实现并 fixture-test：

- Schema 2.0；
- TableDefinition；
- RelationDefinition；
- projection definition；
- assembler；
- B3 小规模结构测试；
- explicit schema↔table mapping。

不要使用 `schema_id.split(...)` 推导 table identity。

### M2 — supporting artifacts 接入 existing executor

将已有 side outputs 升级成 committed Core outputs：

- samples；
- datasets；
- probe_gene_mapping；
- rejected_records；
- conflicts。

要求：file-backed、streaming、receipt-backed。

### M3 — GEO trusted E2E

闭合：

- mapping guards；
- sample alias canonicalization；
- metadata/mapping receipt；
- expression semantic profile；
- ProductAssessment；
- Manifest / Artifact API hash parity；
- cancel/timeout/checkpoint/lock/fence 回归。

此阶段可以作为内部可信 vertical slice，但**不自动意味着整族 production cutover**。

### M4 — disk-backed 多表 merge / validation hardening

实现：

- schema-owned merge identity；
- disk-backed index；
- conflict artifact；
- quota/cancel；
- B3 大表内存测试与必要的 bounded-memory 替代。

### M5 — GDC / Xena projection

重点生成可信：

- dataset rows；
- sample rows；
- source locators；
- compatibility metadata；
- committed supporting results。

不要简单“包成 provider carrier”后转入 `object[]`。

### M6 — production activation

在当前 family-level activation 未重构前，至少要求：

- gene/probe legacy compatibility；
- GEO/GDC/Xena 全部 production source；
- streaming / heap regression；
- timeout/cancel/checkpoint/build lock/fence；
- relation / PK / FK；
- conflict/rejected audit；
- semantic validation；
- ProductAssessment publishable；
- Artifact hash closure；
- frozen Gold1 same-commit rerun。

---

## 5. 本轮禁止事项

下一轮实现中明确禁止：

1. 为了多表化直接把大表达矩阵读取成 Buffer / `object[]`；
2. 只完成 GEO 后直接整族切换 runtime；
3. 临时给 DatasetBuildSpec 1.0 塞未版本化 `schema_refs`；
4. 一个 primary Schema 同时拥有 gene/probe 两种 row granularity；
5. 使用 `build_id` 冒充 source dataset identity；
6. 依赖裸 `sample_id` 做跨来源全局身份；
7. 用 source binding 顺序作为隐式 precedence；
8. 把 parser rejected rows 混入 canonical primary；
9. 让 LLM 直接改 staging/final CSV 并视作可信结果；
10. 仅凭 B3 通过就认为 expression semantic product 合格；
11. provenance coverage 写死 100%；
12. 新增更多 `family.id === ...` / `source === ...` 的核心 runtime 分支，除非明确标注临时兼容层并附后续移除任务。

---

## 6. 与 Family Host 长期计划的关系

本轮不是 Family Host 的反方向，而是它的前置去风险阶段。

这轮需要沉淀的通用能力：

```text
Family / Projection metadata
        |
        +-- schemas
        +-- table definitions
        +-- relations
        +-- source capabilities
        +-- merge definitions
        +-- validation policies
        +-- assessment policy

Streaming execution primitives
        |
        +-- file-backed transforms
        +-- disk-backed merge
        +-- durable operation results
        +-- receipt closure
        +-- deterministic replay
```

未来 Family Host 只负责：

- 动态发现/加载这些声明；
- capability search/resolution；
- task/user/builtin scope；
- declarative FamilySpec validation；
- trusted extension binding。

它不应重新实现数据处理内核。

最终边界：

```text
Agent:
  discover / select / propose / generate declarative specs / propose decisions

Family Host:
  load / validate / resolve capabilities

Dataset Core:
  deterministic execution / replay / validation / assessment / publication
```

---

## 7. 验收原则

下一轮验收重点不是“Gold1 多了四张 CSV”，而是：

> 在不损失现有 expression runtime 的 streaming、恢复、安全与可信边界前提下，将 expression 产品提升为有明确 primary granularity、稳定实体身份、正式 supporting tables、关系校验、semantic validation、provenance closure 与 ProductAssessment 的多表可信数据产品；同时新增实现可以在后续抽取到 Family Host，而不制造新的 family-specific 核心债务。

