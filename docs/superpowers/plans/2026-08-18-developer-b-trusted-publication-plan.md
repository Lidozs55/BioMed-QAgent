# 开发者 B：可信多表 Publication 落实计划

> 状态：Accepted execution plan
> 日期：2026-08-18
> 负责人：开发者 B（本组）
> 父任务：TASK-048
> 基线：`main@b43c145`（TASK-048-B0 已完成）
> 总计划：[Gold 可信 Publication 收敛执行计划](2026-08-18-gold-trusted-publication-closure.md)

## 1. B 组目标与完成定义

B 组负责把非表达研究结果从“Agent 能整理 workspace 文件”推进到“Dataset Core
承认、验证、发布并负责的可信数据产品”。B 组不负责 TASK-047 的大文件执行优化，
但负责 A 组实现所需的稳定 contracts，并在 prerequisite 合并后提供可消费接口。

B 组完成不等于“注册了 schema”。TASK-048 只有在 Gold3-Gold6 原样重跑均产生：

```text
registered family
+ trusted SourceAsset/adapter
+ canonical tables
+ explicit relations
+ validation/confidence/provenance closure
+ immutable DatasetPublication
+ verified Artifact API download
+ final answer
```

时才能关闭。最终能否报告 Gold 6/6 仍由 G1 同 commit 六例重跑决定。

## 2. Ownership 边界

### 2.1 B 组独占

```text
packages/contracts/**
server/src/dataset/contracts/**
server/src/dataset/families/**
server/src/dataset/schema/**
server/src/dataset/assembly/**                  # 新建
server/src/dataset/adapters/registered/**       # 新建
server/src/dataset/families/<family>/**         # 新建 family 模块
通用 multi-table validation 新模块
Gold eval manifest / family ADR / contract ADR
```

### 2.2 A 组独占，B 组不得直接修改

```text
server/src/dataset/service/dataset-core.ts
server/src/dataset/runtime/**
server/src/dataset/adapters/base.ts
server/src/dataset/adapters/geo/**
server/src/dataset/integrator/**
server/src/dataset/publish/**                   # A8 前
server/src/product/build-store.ts               # A8 前
```

### 2.3 交接文件

以下文件一次只能有一个 owner：

```text
server/src/dataset/service/ts-core.ts
server/src/dataset/adapters/adapters.ts
server/src/dataset/validation/profile.ts
server/src/dataset/publish/manifest.ts
```

默认归 A 组，直到 A 组明确完成一个 prerequisite 或书面交接。B 组可以先在新模块中
实现 B2/B3/B4，但不得在自己的长期分支偷偷修改这些共享文件。接线必须用独立 wiring
commit，并在开始前 rebase 最新 main。

## 3. 稳定任务 ID 与依赖模型

依赖分为三类：

- `hard_requires`：任务在语义上不能提前完成；
- `merge_after`：为避免 contract spine 冲突而规定的合并顺序，不代表语义依赖；
- `handoff_requires`：开始修改共享文件前必须取得的 owner 交接 commit。

### 3.1 Contract spine 写锁顺序

```text
TASK-048-B1
→ TASK-C1C
→ TASK-047-A5C
→ TASK-C2C
→ TASK-C3C（P1 后续，不阻塞 TASK-048/G1）
```

这是一条 `merge_after` 序列，确保同一时间只有一个 B 组 worktree 修改
`packages/contracts/**`。语义硬依赖另按各任务条目执行：C1C 需要 A1 接口反馈，A5C
需要 `TASK-047-A2` 文件形态确认，`TASK-C3C` 需要 `TASK-C1C` + `TASK-047-A5C`。

### 3.2 P0 可信 Publication 主链

```text
TASK-G0 → TASK-048-B1

TASK-048-B1 + TASK-047-A5C
  → TASK-048-B2M ──handoff──→ TASK-048-B2W(A)

TASK-048-B1 → TASK-048-B3
TASK-048-B1 + TASK-047-A2 + TASK-C1C → TASK-048-B4M
TASK-048-B4M + TASK-C1I(A) + TASK-048-B3 → TASK-048-B4M completed

TASK-048-B1 + TASK-048-B3 → TASK-048-B5C
TASK-048-B2W + TASK-048-B3 + TASK-048-B4M + TASK-048-B5C
  → TASK-048-B5L / TASK-048-B5T / TASK-048-B5V / TASK-048-B5S / TASK-048-B5A

TASK-048-B5L + TASK-048-B5A + TASK-048-B3 + TASK-048-B4M + TASK-C2I(A)
  → TASK-048-B6A
TASK-048-B6D + TASK-047-A5I → TASK-048-B6W(A)
TASK-048-B6W + TASK-048-B2W + TASK-048-B3 + TASK-C2I(A) → TASK-048-B6B

TASK-048-B5C + TASK-048-B5L + TASK-048-B5T + TASK-048-B5V + TASK-048-B5S
  + TASK-048-B5A + TASK-048-B6A + TASK-048-B6B + TASK-C2I(A) → TASK-048-B7
TASK-047-A8(A) + TASK-048-B7 → TASK-G1A(A) → TASK-G1B → TASK-G1R
```

B5L/T/V/S/A 之间没有语义依赖。`B5L → B5T → B5V → B5S → B5A` 只是单人
`merge_after` 排期；任何 family 延误不得无理由阻断其他 family 开发。

### 3.3 跨组依赖任务注册表

| 完整任务 ID | Owner | 状态 | 分支 | B 组消费点 |
| --- | --- | --- | --- | --- |
| `TASK-047-A1` | A | ready/由 A 维护 | `fix/dataset-asset-stream-hash` | C1C 的 hash/TOCTOU 接口反馈 |
| `TASK-047-A2` | A | pending | `refactor/stream-source-adapters` | A5C 文件形态、B4M adapter stream |
| `TASK-047-A5I` | A | blocked by A5C/A2 | `feat/dataset-operation-results` | B2W checkpoint topology |
| `TASK-047-A8` | A | blocked by A1-A7 | `eval/gold-large-geo-benchmark` | G1 冻结屏障 |
| `TASK-C1I` | A | blocked by `TASK-C1C` + `TASK-047-A1` | `feat/core-source-asset-registry` | B4M trusted E2E |
| `TASK-C2I` | A | blocked by `TASK-C2C` + `TASK-C1I` | `feat/core-owned-acquisition` | family live E2E、B6、B7 |
| `TASK-C3I` | A | P1 blocked by `TASK-C3C` + `TASK-047-A5I` + `TASK-C1I` | `feat/durable-build-scheduler` | 不阻塞 TASK-048/G1；后续长任务稳定性 |
| `TASK-048-B2W` | A | blocked by `TASK-048-B2M` + `TASK-047-A5I` | `feat/family-assemble-wiring` | runtime plan/checkpoint/publisher wiring |
| `TASK-048-B6W` | A | blocked by `TASK-048-B6D` + `TASK-047-A5I` | `feat/deterministic-derive-wiring` | fixed derive slot/runtime wiring |
| `TASK-G1A` | A | blocked by `TASK-047-A8` + `TASK-048-B7` | `eval/final-gold-a-evidence` | Gold1-Gold2 同基线 evidence commit |

A 组任务的实现细节由 A 组计划维护；本表只冻结 B 组依赖的完整 ID、owner 和交付接缝。

## 4. 任务台账

### TASK-G0：冻结 Gold eval manifest

- **状态**：ready
- **分支**：`docs/freeze-gold-eval-manifest`
- **依赖**：无
- **修改范围**：`docs/evaluation/gold-v1/**`、`docs/TODO.md`
- **交付**：6 个原始 prompt、成功定义、期望 family/granularity、允许来源标准、
  source/schema hashes、运行参数模板；大文件只登记 accession/bytes/SHA-256。
- **验收**：manifest 和 prompt 可版本追踪；不依赖被忽略的 `data/gold/`；G1 driver
  能以 manifest 为唯一输入；明确当前 strict Gold=0/6。
- **禁止**：修改 prompt 以适配现有实现；提交真实大数据或密钥。

### TASK-048-B0：FamilyRegistry admission foundation

- **状态**：completed（`main@b43c145`）
- **交付**：ADR-027、FamilyRegistry、严格 spec parser、family/schema/profile/source/
  adapter/runtime admission tuple；production default 仅 `gene_expression`。
- **后续不变量**：新 family 只有完整 runtime vertical slice 通过后才能加入 default
  Registry；reference schema 不得单独注册制造假能力。

### TASK-048-B1：Multi-table contracts v2 与 ADR

- **状态**：blocked by `TASK-G0`
- **分支**：`feat/multitable-dataset-contracts`
- **hard_requires**：`TASK-G0`、`TASK-048-B0`
- **修改范围**：`packages/contracts/**`、`server/src/dataset/contracts/**`、ADR、contract tests
- **交付**：
  - `TableDefinition`：table ID、schema ref、role、required、allow_empty；
  - `RelationDefinition`：from/to table+fields、cardinality、missing policy；
  - `PublicationCandidateRef`：table/relation/provenance/confidence/audit refs；
  - Manifest 2.0 `tables[]/relations[]`，继续读取 Manifest 1.0；
  - SchemaField 分离“列必需”与“值可空”；
  - SourceLocator 支持 JSON pointer、XML/table cell、PDF page/table/figure、image bbox。
- **验收**：exact-key runtime parser；重复 table ID、未知 schema/field、无 primary、非法
  PK/FK、越界 ref 全部拒绝；Manifest 1.0 / Publication 1.0/1.1 fixtures 继续通过。
- **交接**：合并后通知 A 组 rebase；C1C/A5C/B3 才能开始改 contract spine。

### TASK-C1C：Core SourceAsset registry contracts

- **状态**：blocked
- **分支**：`feat/core-source-asset-contracts`
- **hard_requires**：`TASK-048-B1`；等待 `TASK-047-A1` 输出 hash/TOCTOU 接口需求
- **修改范围**：`packages/contracts/**`、`server/src/dataset/contracts/source.ts`、ADR
- **交付**：source/mapping/metadata/carrier asset roles、asset ID ref、registration receipt、
  immutable hash/size/media type、task ownership、path compatibility 退役字段与遥测。
- **验收**：Agent path、绝对路径、跨 task asset、hash 漂移和未知 role fail-closed；旧 path
  入口只作为版本化兼容，不成为 publication 信任来源。
- **交接**：A 组负责 `TASK-C1I` 实现；`TASK-048-B4M` trusted E2E 必须等待
  `TASK-C1I` 合并。

### TASK-047-A5C：Operation Result Manifest contract 与 ADR

- **状态**：blocked
- **分支**：`feat/dataset-operation-result-contracts`
- **hard_requires**：`TASK-048-B1`；等待 `TASK-047-A2` 确认 operation 文件形态
- **修改范围**：`packages/contracts/**`、`server/src/dataset/contracts/**`、ADR
- **交付**：operation-kind discriminated result、relative file receipts、input/parameter/
  implementation digest、原子提交、最小依赖失效闭包、旧 checkpoint 迁移策略。
- **验收**：exact parser；路径逃逸、缺 receipt、digest 不一致、operation-kind/output
  不匹配拒绝；publish result 不允许 replay 语义写入契约。
- **交接**：A 组负责 `TASK-047-A5I` executor/checkpoint 实现。

### TASK-C2C：Core-owned acquisition contracts

- **状态**：blocked
- **分支**：`feat/core-acquisition-contracts`
- **hard_requires**：`TASK-C1C`；实现验收前依赖 `TASK-C1I`
- **修改范围**：contracts、acquisition ADR
- **交付**：builtin/workflow_recipe request identity、provider/recipe version、DownloadAttempt、
  retry/resume/cache lineage、registered external extraction asset ref。
- **验收**：Agent 不能提交任意下载代码/路径；recipe 必须 PROMOTED；参数/version 进入
  cache/checkpoint identity；source values 可回溯到成功 attempt。
- **交接**：A 组负责 `TASK-C2I` acquisition runtime。

### TASK-C3C：Durable Build API 与状态机 contracts

- **状态**：P1 backlog
- **分支**：`feat/durable-build-contracts`
- **hard_requires**：`TASK-C1C`、`TASK-047-A5C`；吸收 `TASK-C3I` 的 lease/recovery 约束
- **修改范围**：`packages/contracts/**`、runtime API DTO、ADR
- **交付**：`start/get/cancel` Build API、幂等键、状态机、terminal result、cancel ack、
  Task/Run/Build identity 与 durable events。
- **验收**：状态转换 exact；重复 start 幂等；Run 终态不替代 Build 终态；API/前端不从
  error string 推断状态。
- **交接**：A 组负责 `TASK-C3I` scheduler/runtime。

### TASK-048-B2M：PublicationCandidate 与 family assembler module

- **状态**：blocked
- **owner**：B
- **分支**：`feat/family-assembler-module`
- **hard_requires**：`TASK-048-B1`、`TASK-047-A5C`
- **修改范围**：新建 `server/src/dataset/assembly/**`、expression single-table assembler、
  candidate contract adapters、单元测试；不修改 A 组 runtime/publish 文件。
- **验收**：expression integration result 可确定性包装为 candidate；candidate 只能引用 Core
  result refs；缺 assembler handler 的 family 不能构造 runtime capability；无 Agent path。

### TASK-048-B2W：固定 assemble operation runtime wiring

- **状态**：blocked
- **owner**：A
- **分支**：`feat/family-assemble-wiring`
- **hard_requires**：`TASK-048-B2M`、`TASK-047-A5I`
- **A 组独占范围**：`runtime/plan.ts`、`runtime/operations.ts`、checkpoint topology、
  `ts-core.ts`、`publish/manifest.ts`/`publisher.ts` 接缝。
- **验收**：固定骨架增加 `integrate[*] -> assemble -> validate -> publish`；不是 DAG；
  expression publication 语义/布局兼容；topology/version 使旧 checkpoint 正确失效；Publisher
  不出现 family `if/else`。
- **交接**：B2M merge 后 B 组提供 candidate/assembler API；A 组完成 B2W 后归还 family/
  assembly ownership。B 组不得自行修改 A 独占 runtime 文件。
- **禁止**：把 `integrate` 简单改名；让 Agent 提交 candidate 或任意文件路径。

### TASK-048-B3：Generic multi-table validation 与 relation gate

- **状态**：blocked
- **分支**：`feat/multitable-validation`
- **hard_requires**：`TASK-048-B1`
- **修改范围**：新 generic validation 模块、fixtures；不改 A 组 expression 大文件扫描
- **交付**：header 顺序/行宽、data type/nullability、PK uniqueness、FK/cardinality、
  required/allow_empty、relation/unit token preservation、逐表 provenance/confidence refs。
- **验收**：正负 fixtures；activity `<,>,=` 不丢失；只在 schema 声明 allow_empty 时允许
  空 supporting table；blocking HIL/low-confidence policy 由 family profile 决定。
- **边界**：通用层只检查结构/关系，不吞并 family measurement 语义。

### TASK-048-B4M：Registered-table adapter module

- **状态**：blocked
- **owner**：B
- **分支**：`feat/registered-table-adapter`
- **可开始条件**：`TASK-048-B1`、`TASK-047-A2`、`TASK-C1C`；`TASK-048-B3`
  可并行但完成前必须合入
- **修改范围**：`server/src/dataset/adapters/registered/**`，不修改 A 正在维护的 adapter base。
- **交付**：CSV/TSV/JSON SourceAsset ref -> registered canonical table；schema-driven parse；
  locator/parser version/rejected rows audit。
- **完成条件**：`TASK-048-B3` + `TASK-C1I`；只接受 Core asset ID；workspace path/
  未知 schema/hash 漂移拒绝；严格行宽/类型；不执行 Agent 代码；至少一个非 Gold
  真实结构化 API asset E2E。
- **接线窗口**：A2 merge 后，`adapters/adapters.ts` 单文件 ownership 临时交给 B4M 分支；
  B4M merge 后立即归还 A 组，期间 A 组不得并行改该文件。

### TASK-048-B5C：共享 biomedical tables 与 relation vocabulary

- **状态**：blocked
- **分支**：`feat/biomedical-common-schemas`
- **hard_requires**：`TASK-048-B1`、`TASK-048-B3`
- **merge_after**：`TASK-048-B4M` contract 形态冻结后优先；不硬依赖 `TASK-C2I`
- **交付**：可复用 entity、paper、compound、assay、structure dimension、trial、source、
  entity/compound crosswalk schema；ID namespace、relation/cardinality、unit/relation vocab。
- **验收**：跨 family 不复制同义 schema；crosswalk 保留匹配证据和冲突；source/carrier
  不被命名为 family；本任务不启用任何 production family。

### TASK-048-B5L：literature_evidence family

- **状态**：blocked
- **分支**：`feat/literature-evidence-family`
- **可开始条件**：`TASK-048-B2M`、`TASK-048-B3`、`TASK-048-B4M`、`TASK-048-B5C`
- **完成条件**：`TASK-048-B2W`、`TASK-048-B4M` completed、`TASK-C2I`
- **主表**：paper/experiment evidence，不是“PubMed family”或“PDF family”。
- **验收**：结构化文献 adapter、locator、主/supporting relation、validation/confidence/
  provenance/publication E2E；至少一个非 Gold 正例和一个负例 Publication E2E，负例证明
  locator/provenance/FK 缺失时 fail-closed；完整后才注册 runtime ID。

### TASK-048-B5T：target_evidence family

- **状态**：blocked
- **分支**：`feat/target-evidence-family`
- **可开始条件**：`TASK-048-B2M`、`TASK-048-B3`、`TASK-048-B4M`、`TASK-048-B5C`
- **完成条件**：`TASK-048-B2W`、`TASK-048-B4M` completed、`TASK-C2I`
- **验收**：target primary + evidence/source/supporting relations；UniProt/临床试验等作为
  source，不作为 family；至少一个非 Gold 正例和一个负例 Publication E2E。Gold3 只在 B7 验收。

### TASK-048-B5V：variant_evidence family

- **状态**：blocked
- **分支**：`feat/variant-evidence-family`
- **可开始条件**：`TASK-048-B2M`、`TASK-048-B3`、`TASK-048-B4M`、`TASK-048-B5C`
- **完成条件**：`TASK-048-B2W`、`TASK-048-B4M` completed、`TASK-C2I`
- **验收**：variant assertion/evidence 粒度、reference/allele/condition semantics、source
  locator 与 conflict policy；至少一个非 Gold 正例和一个负例 E2E。Gold3/4 只在 B7 验收。

### TASK-048-B5S：protein_structure family

- **状态**：blocked
- **分支**：`feat/protein-structure-family`
- **可开始条件**：`TASK-048-B2M`、`TASK-048-B3`、`TASK-048-B4M`、`TASK-048-B5C`
- **完成条件**：`TASK-048-B2W`、`TASK-048-B4M` completed、`TASK-C2I`
- **验收**：structure primary + chain/ligand supporting + relations；PDB 是 source；结构版本、
  locator/provenance 闭合；至少一个非 Gold 正例和负例 E2E。Gold3/4 只在 B7 验收。

### TASK-048-B5A：bioactivity_measurement family

- **状态**：blocked
- **分支**：`feat/bioactivity-family`
- **可开始条件**：`TASK-048-B2M`、`TASK-048-B3`、`TASK-048-B4M`、`TASK-048-B5C`
- **完成条件**：`TASK-048-B2W`、`TASK-048-B4M` completed、`TASK-C2I`
- **验收**：activity fact + compound/assay/target tables；raw value/unit/relation 与 standardized
  value/unit 并存；`<,>,=` 不丢失；至少一个非 Gold 正例和负例 E2E。Gold5 只在 B7 验收。

### TASK-048-B6A：Chart/VLM evidence Publication

- **状态**：blocked
- **分支**：`feat/chart-vlm-evidence-publication`
- **hard_requires**：`TASK-048-B3`、`TASK-048-B4M` completed、`TASK-048-B5C`、
  `TASK-048-B5L`、`TASK-048-B5A`、`TASK-C2I`
- **family 落点**：初始 primary measurements 进入 `bioactivity_measurement`；paper/figure/chart
  locator 与 extraction audit 作为 literature/common supporting tables。不得创建 `figure family`。
- **交付**：chart series/points、bbox、model/version、axis/legend status、estimated/exact、
  confidence/review/transform provenance。
- **验收**：未审 low-confidence primary 不发布；人工 accepted 只解除 review block，不自动
  升级 source/extraction reliability；axis/legend unclear 显式保留；Gold6 可发布。

### TASK-048-B6D：Deterministic derive ADR

- **状态**：blocked
- **分支**：`docs/deterministic-derive-adr`
- **hard_requires**：`TASK-048-B1`、`TASK-048-B2M`、`TASK-047-A5C`
- **交付**：固定 derive slot、允许算法 registry、参数/reference version/input asset/output
  digest provenance；明确不允许 Agent code、不引入通用 DAG。
- **验收**：PDB distance/sequence alignment 等用同一 deterministic contract 表达。

### TASK-048-B6W：Fixed derive slot runtime wiring

- **状态**：blocked
- **owner**：A
- **分支**：`feat/deterministic-derive-wiring`
- **hard_requires**：`TASK-048-B6D`、`TASK-047-A5I`
- **交付**：在固定 runtime plan 中加入注册式 derive slot、checkpoint/digest 接缝和
  cancel/timeout；不允许动态节点或 Agent code。
- **验收**：无 derive handler 时按固定骨架跳过；有 handler 时 operation result/version
  进入 checkpoint identity；参数/reference/input digest 变化使 reuse 失效。

### TASK-048-B6B：Deterministic derived evidence

- **状态**：blocked
- **分支**：`feat/deterministic-derived-evidence`
- **hard_requires**：`TASK-048-B2W`、`TASK-048-B3`、`TASK-048-B5C`、
  `TASK-048-B5V`、`TASK-048-B5S`、`TASK-048-B6D`、`TASK-048-B6W`、`TASK-C2I`
- **wiring owner**：A 组通过 `TASK-048-B6W` 接入 derive slot；B 组实现算法 registry、
  family consumer/schema/profile。
- **family 落点**：PDB distance/interface 输出由 `protein_structure` 消费；sequence/reference
  mapping 输出由 `variant_evidence` 消费；不得创建万能 derived family。
- **验收**：注册算法可复算；未注册算法/Agent code 拒绝；参数、reference version 或输入
  digest 改变使 cache/checkpoint 失效；derived records 不冒充 source records；两个 consumer
  各有非 Gold 正负 E2E。

### TASK-048-B7：Gold3-Gold6 原样重跑

- **状态**：blocked
- **分支**：`eval/gold3-6-publication`
- **hard_requires**：`TASK-048-B5C`、`TASK-048-B5L`、`TASK-048-B5T`、
  `TASK-048-B5V`、`TASK-048-B5S`、`TASK-048-B5A`、`TASK-048-B6A`、
  `TASK-048-B6B`、`TASK-C2I`
- **验收**：冻结 prompt 不改；每例有 task/run/build/publication ID、table/relation inventory、
  manifest/provenance/confidence closure、Artifact API 下载 hash 和最终答案；workspace summary
  不计 artifact pass。只有此任务完成才关闭 TASK-048。

### TASK-G1B：最终 Gold3-Gold6 同基线复跑

- **状态**：blocked
- **分支**：`eval/final-gold-b-evidence`
- **hard_requires**：`TASK-048-B7`、`TASK-047-A8`、`TASK-G1A`
- **merge_after / handoff**：A 组先在 `eval/final-gold-a-evidence` 提交 Gold1-Gold2 evidence；
  B 组从该 commit 创建独立分支，只追加 Gold3-Gold6 evidence，不修改 A 组记录。
- **验收**：与 `TASK-G1A` 使用同一产品 commit、默认 RuntimeLimits、同一冻结 manifest；
  输出 machine-readable evidence refs，不能只引用人工截图。

### TASK-G1R：严格 Gold 最终报告

- **状态**：blocked
- **分支**：`docs/final-gold-e2e-report`
- **hard_requires**：`TASK-G1A`、`TASK-G1B`
- **交付**：逐例 task/run/build/publication/artifact hash、资源指标、失败/通过定义、最终结论。
- **验收**：只有六例完整通过才写 Gold 6/6；否则保持精确阶段性表述。

## 5. B 组执行波次

### 波次 B-1：现在开始

```text
TASK-G0 -> TASK-048-B1
```

G0 合并后立即启动 B1。B1 是 contract spine 独占窗口；期间不并行修改 contracts 的
`TASK-C1C` / `TASK-047-A5C` / `TASK-C2C` / `TASK-C3C`。

### 波次 B-2：提供 A 组 P0 prerequisite contracts

```text
TASK-C1C -> TASK-047-A5C -> TASK-C2C
```

每个 contract task 独立 merge。A 组在每次合并后 rebase 并实现对应 `*I` 任务。B 组
同时可在不修改共享 contract spine 的前提下开始 `TASK-048-B3` fixtures/design。
`TASK-C3C` 是 P1 backlog，在 P0 contract spine 空闲时再领取，不得延迟 B2-B7。

### 波次 B-3：多表运行基础

```text
TASK-048-B3
TASK-048-B2M -> TASK-048-B2W(A)
TASK-048-B4M -> trusted E2E after TASK-C1I(A)
```

B2M 只写 B 组 assembly 新模块；runtime/plan/checkpoint/publisher 接线由 A 组 B2W 完成。
B4M 可在 C1C+A2 后开始，但 trusted E2E 必须等待 C1I 和 B3。共享 adapter registry 的
ownership 仅在 B4M 接线窗口临时转给 B，merge 后立即归还 A。

### 波次 B-4：family vertical slices

```text
TASK-048-B5C
merge_after: B5L -> B5T -> B5V -> B5S -> B5A
```

箭头仅表示单人合并排期，不是 family 语义依赖。每个 family 一个 merge；至少有一个
非 Gold 正例和负例 E2E，完整 vertical slice 后才加入 production default Registry。

### 波次 B-5：VLM/derive 与验收

```text
TASK-048-B6A
TASK-048-B6D -> TASK-048-B6W(A) -> TASK-048-B6B
TASK-048-B7
TASK-047-A8(A) + TASK-048-B7 -> TASK-G1A(A) -> TASK-G1B -> TASK-G1R
```

`TASK-C3C` / `TASK-C3I` 是 P1 长任务稳定性后续，不阻塞本轮 TASK-048/G1；若产品决定把 durable async
Build 作为比赛最终门禁，再通过新 ADR/TODO 变更加入 G1 hard requirements，不能静默追加。

## 6. 跨组交接协议

1. 非 owner 不直接修改对方独占文件，只提交接口需求（字段、错误码、调用时机、验收）。
2. Contract prerequisite 由 B 组独立分支实现并先合并 main。
3. A 组 rebase 后实现 runtime；若发现 contract 缺口，退回新 contract task，不在 A 组分支
   临时修改 `packages/contracts`。
4. 共享文件接线必须在任务描述中写明当前 owner、交接 commit 和预计归还点。
5. `runtime/plan.ts`、`runtime/operations.ts`、checkpoint 和 publisher wiring 始终由 A 组；
   B2M/B6B 只能提供 module/handler API。
6. `adapters/adapters.ts` 只在 A2 merge 后的 B4M 接线窗口交给 B；
   `validation/profile.ts` 和 publish manifest 只在明确的单任务 wiring commit 交接。
7. `docs/TODO.md` 与 Gold eval manifest 默认归 B 组；A 组通过 runs log/benchmark 文档追加
   证据，不并行改任务状态字段。
8. 每个 WP 合并后另一组立即 rebase；禁止双方维护同一 contract 的私有版本。
9. A 组的 synthetic/large-data fixtures 与 B 组 schema fixtures 分目录保存，避免互相覆盖。

## 7. 每任务 Definition of Done

- 任务 ID、父任务、依赖、owner 和 branch 与本文一致；
- 新 feature 有 contract/unit/E2E；bug fix 有真实 red-green 证据；
- 不出现 Gold case/accession 特例分支；
- `pnpm test/lint/typecheck/build` 和数据库 bridge 门禁全绿；
- ADR/architecture/TODO 与实际状态同步；
- 独立 worktree 开发，一个任务一个 merge；
- 完成后记录 merge commit 和验收证据；blocked 任务不勾完成。

## 8. 当前 B 组队列

| 顺序 | 任务 ID | 状态 | hard_requires / ready_when |
| --- | --- | --- | --- |
| 1 | `TASK-G0` | ready | 无 |
| 2 | `TASK-048-B1` | blocked | `TASK-G0` |
| 3 | `TASK-C1C` | blocked | `TASK-048-B1` + `TASK-047-A1` 接口反馈 |
| 4 | `TASK-047-A5C` | blocked | `TASK-048-B1` + `TASK-047-A2` 文件形态 |
| 5 | `TASK-048-B3` | blocked | `TASK-048-B1` |
| 6 | `TASK-C2C` | blocked | `TASK-C1C` |
| 7 | `TASK-048-B2M` | blocked | `TASK-048-B1` + `TASK-047-A5C` |
| 8 | `TASK-048-B2W`（A owner） | blocked | `TASK-048-B2M` + `TASK-047-A5I` |
| 9 | `TASK-048-B4M` | blocked | start: B1+A2+C1C；complete: B3+C1I |
| 10 | `TASK-048-B5C` | blocked | B1+B3；B4M contract 形态冻结 |
| 11 | `TASK-048-B5L/T/V/S/A` | blocked | start: B2M+B3+B4M+B5C；complete: B2W+B4M+C2I |
| 12 | `TASK-048-B6A/B6D/B6W/B6B` | blocked | 对应完整任务条目中的 family/C2I/derive 依赖 |
| 13 | `TASK-048-B7` | blocked | B5C/L/T/V/S/A+B6A+B6B+C2I |
| 14 | `TASK-G1B` | blocked | `TASK-048-B7`+`TASK-047-A8`+`TASK-G1A` |
| 15 | `TASK-G1R` | blocked | `TASK-G1A`+`TASK-G1B` |
| P1 | `TASK-C3C` | backlog | `TASK-C1C`+`TASK-047-A5C`；不阻塞本轮 closure |

当前 B 组唯一应领取任务是 `TASK-G0`。完成并合并后，领取 `TASK-048-B1`。
