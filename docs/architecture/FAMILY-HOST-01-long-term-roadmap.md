# FAMILY-HOST-01 长期改进计划

> 状态：长期架构路线
> 日期：2026-08-21
> 目标：将当前编译期写死的 Dataset Family 体系演进为可发现、可加载、可创建、可审计的 Family Host，同时保留 Dataset Core 的确定性与可信发布边界。

## 1. 背景与问题定义

当前 Dataset Core 已形成较清晰的 `Agent → Dataset Core → Validation → Publication` 边界，但 Family 仍属于编译期静态结构：

- `DatasetFamilyRegistry` 默认 family 列表写死；
- `PRODUCTION_RUNTIME_BY_FAMILY` 将 family 与 runtime 一刀切绑定；
- schema 以 TS 对象形式直接写入源码；
- assembler registry 写死；
- provider carrier dispatch 与部分 schema 查找仍存在 `family.id` / `source` 特判；
- 新增一种数据产品通常需要同时修改 family、runtime、assembler、provider binding、validation 等多处代码。

这使 Agent 的数据发现能力大于 Dataset Core 的产品表达能力：Agent 可以找到并整理新的科学数据，但只要现有 Family 不认识对应表、关系或 schema，该数据就无法进入正式 Publication。

长期目标不是取消 Family，而是将 Family 从“写死的数据产品实现”升级为“可加载的数据产品插件边界”。

## 2. 目标架构

长期目标结构：

```text
Pi Agent
   │
   ├── Family Discovery
   ├── Data Discovery
   │
   ▼
Family Host
   │
   ├── builtin families
   ├── curated families
   ├── user families
   └── task-scoped families
   │
   ▼
Capability Resolver
   │
   ├── selected schemas
   ├── selected sources
   ├── selected adapters
   └── resolved integration policies
   │
   ▼
Generic Dataset Runtime
   │
   ├── Source Adapter / Provider Carrier
   ├── Canonicalization
   ├── Same-Schema Integration
   ├── Validation
   ├── Product Assessment
   └── Generic Family Assembler
   │
   ▼
Publisher
```

核心原则：

> Family 是插件边界；Schema 是 Family 内部最小可组合数据能力；Capability 描述 source/adapter 能产出哪些 Schema；Generic Runtime 按声明执行；只有真正无法声明化的领域逻辑才进入受信任 Runtime Extension。

## 3. Family Package 模型

建议将每个 Family 收敛为自包含 package：

```text
families/<family-id>/
├── family.json
├── schemas/
│   ├── *.schema.json
│   └── ...
├── README.md
└── runtime.ts          # 可选，受信任 extension
```

其中 `family.json` 至少应描述：

```yaml
family:
  id: gene_expression
  version: 2

schemas:
  expression_long:
    schema_ref: schemas/expression-long.json
    role: primary

  samples:
    schema_ref: schemas/samples.json
    role: supporting

capabilities:
  - source: geo
    adapter: geo.expression.v1
    outputs:
      - expression_long
      - samples
      - datasets
      - probe_gene_mapping

relations:
  - from: expression_long.sample_id
    to: samples.sample_id
    missing_policy: reject

integration:
  expression_long:
    strategy: canonical_identity
    conflict_policy: audit

runtime:
  generic: multitable.v2
  extensions:
    - geo.expression
```

### 3.1 Schema

Schema 负责定义一张规范化结果表：

- `schema_id`
- `row_granularity`
- `primary_key`
- fields
- semantic roles
- ontology / unit policy
- derivation policy

长期应从 TS source hardcode 改为声明式 JSON/YAML，由统一 parser 加载与验证。

### 3.2 Capability

Capability 建立 `source ↔ schema` 多对多网络：

```text
Source A ──→ Schema 1
         └─→ Schema 2

Source B ──→ Schema 1
         └─→ Schema 3
```

Agent 不再只选择一个 Family，而是依据任务需求解析：

- 需要哪些 Schema；
- 哪些 source 可满足；
- 是否需组合多个 source；
- 哪个 source 只提供能力子集；
- 哪些表可以缺省或为空。

### 3.3 Integration Policy

同一 Schema 来自多个 source 时，统一进入 Schema Integration Layer：

```text
source rows
   ↓
canonical identity
   ↓
deduplication
   ↓
conflict detection
   ↓
provenance merge
   ↓
conflict audit
   ↓
canonical table
```

该层应吸收现有 `gene_expression.runtime.v1` / `integrator.ts` 已有的流式去重、确定性冲突处理和 audit 语义，避免 `registered_multitable` 当前裸 append 行为继续扩张。

### 3.4 Generic Family Assembler

长期不应持续新增：

- `assembleGeneExpressionCandidate()`
- `assembleBioactivityCandidate()`
- `assembleTargetEvidenceCandidate()`
- ...

大多数 Family 应由 `GenericFamilyAssembler` 根据 FamilySpec 自动完成：

- selected schemas 完整性检查；
- required/optional/allow_empty 解析；
- table definition 绑定；
- relation 绑定；
- provenance/confidence/audit refs 汇总；
- asset closure 检查；
- PublicationCandidate 构造。

仅真正存在无法声明化 publication 语义的 Family 才使用 extension hook。

## 4. Family 作用域

建议定义四级作用域：

```text
builtin
  随程序发布、由仓库维护

curated
  经项目维护者审核并安装

user
  用户长期保留

task
  Agent 为单次任务临时创建
```

默认策略：

- Agent 可自由创建 `task` Family；
- `task` Family 仅允许声明式 FamilySpec；
- 可执行 extension 不能自动获得 trusted Core 权限；
- task Family 经验证且多次复用后，可由用户或维护者 promote 为 user/curated；
- builtin/curated 更新必须版本化。

## 5. Agent-facing Family 工具

长期提供：

```text
list_families
search_families
inspect_family

search_schemas
search_capabilities
resolve_capabilities

create_family
clone_family
extend_family
validate_family
register_family

promote_family
remove_family
```

推荐工作流：

```text
用户任务
  ↓
Agent 提取目标数据形态
  ↓
search_family / search_schema
  ↓
已有能力足够？
  ├─ 是 → resolve capabilities → build
  └─ 否 → create task family
              ↓
          validate_family
              ↓
          task-scoped registry
              ↓
              build
```

## 6. Runtime Extension 模型

FamilySpec 应优先声明化；只有以下能力允许进入 runtime extension：

- 特殊原始格式解析；
- source-specific provider transform；
- 复杂实体消歧 / identity resolution；
- 无法由通用策略表达的 normalization；
- 无法由通用 validator 表达的科学领域规则；
- 特殊 derivation。

Extension 必须：

- 显式注册；
- 有稳定 ID 与版本；
- 有实现 digest；
- 有输入输出 contract；
- 有资源与权限边界；
- 不允许 Agent 自动将任意生成 TS 注入 trusted runtime。

## 7. 长期阶段划分

### L0 — Gold1 vertical slice

目标：用 `gene_expression` 多表化验证 Schema 能力网络、同 Schema 跨源整合和 provenance。

这是当前迭代，不实现完整 Family Host。

### L1 — 收敛 Generic Multi-table Runtime

目标：

- 抽出 Same-Schema Integration Layer；
- 消除 runtime 中新增的裸 append；
- 将 primary/relations/table completeness 逻辑尽可能泛化；
- 新 Family 不再增加 runtime 顶层 `if (family.id === ...)`。

### L2 — 声明式 FamilySpec

目标：

- schema 从 TS source 转为可加载 JSON；
- table definition / relation / integration policy 数据化；
- Family registry 从静态构造转为 loader；
- 现有 6 个 family 至少 4–5 个能使用 GenericFamilyAssembler。

### L3 — Family Host

目标：

- builtin/curated/user/task 四级 registry；
- package scan/load/validate；
- version resolution；
- capability index；
- runtime extension registry。

### L4 — Agent Family Discovery

目标：

- `search_families` / `search_schemas` / `resolve_capabilities`；
- Agent 先检索已有 Family，再决定是否创建；
- build spec 从单 `schema_ref` 演进为 resolved schema set。

### L5 — Agent-generated Task Family

目标：

- Agent 可创建纯声明式 task Family；
- Core 自动验证 schema、relations、capabilities、validation policy；
- 通过后仅在当前 task 生效；
- 可以导出、审阅、promote。

## 8. 与当前 Gold1 设计的关系

当前 `gold1-multitable-tables-design.md` 中以下内容应视为长期架构基础，不应在后续推翻：

1. `source ↔ schema` 多对多能力网络；
2. Agent 按任务选择 schema + source，而不是固定 N 张表；
3. 同 Schema 跨源合并必须有确定性去重 / conflict audit；
4. provenance 以 `source_id` / `source_asset_id` / `source_locator` 为核心锚点；
5. deterministic Core 与 LLM semantic review 分层；
6. 确定性结果不可原地篡改。

需要长期替换的部分：

- “预置 Schema 库” → 可加载 Schema Registry；
- family/source dispatch hardcode → Capability Resolver + Adapter Registry；
- family-specific assembler → GenericFamilyAssembler；
- `PRODUCTION_RUNTIME_BY_FAMILY` → runtime capability / extension resolution；
- compile-time family registry → Family Host。

## 9. 完成判据

长期架构完成至少满足：

- 新增纯声明式 Family 不需要修改 Dataset Core 源码；
- 新增 schema 不需要重新编译 server；
- source 能力由 capability declaration 决定，不由 runtime `if/else` 决定；
- Agent 能检索现有 Family / Schema；
- Agent 能创建 task-scoped declarative Family；
- Generic Runtime 能执行动态 schema set；
- 同 Schema 跨源整合具备确定性 dedup/conflict/provenance；
- Publication 仍只能由 Core validation gate 产生；
- Agent 无法通过生成 arbitrary code 绕过 Core trust boundary。

## 10. 非目标

长期路线不包含：

- 允许 Agent 自动执行任意生成 TS 作为 trusted extension；
- 取消 Dataset Core；
- 让 LLM 直接构造正式 Publication；
- 将 Family 退化为无约束 CSV 模板；
- 为追求动态性牺牲 provenance、schema validation 或 reproducibility。
