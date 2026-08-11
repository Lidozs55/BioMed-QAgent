# BioMed-QAgent 架构（V2）

> **文档元数据（documentation-lifecycle）**
>
> - **受众**：所有在本仓库工作的 agent 与工程师；前端、后端、测试、运维评审。
> - **权威性**：本文件是系统架构的**单一权威来源**（source of truth）。
>   任何与本文矛盾的实现都视为缺陷；任何架构变更必须先修订本文或新增 ADR。
> - **职责分工**：本文回答"系统是什么、怎么组织、约束是什么"；具体决策的
>   "为什么"由 ADR 索引（[BioMed-QAgent_Architecture_Decisions_and_Lessons.md](BioMed-QAgent_Architecture_Decisions_and_Lessons.md)）承担；
>   实现规格由 [BioMed-QAgent_Pipeline_Refactor_Design.md](BioMed-QAgent_Pipeline_Refactor_Design.md) 承担；
>   执行任务由 [TODO.md](TODO.md) 承担。三者不互相复制。
> - **实现状态**：本文描述 V2 目标架构。当前代码仓库仍为 V1，归档于
>   [legacy/ARCHITECTURE_V1.md](legacy/ARCHITECTURE_V1.md)。V2 通过绞杀模式
>   逐步落地，迁移策略见 §18。各章节在涉及"已落地 / 待落地"时以行内标注说明。
> - **验证与失效**：每个里程碑、每次新增/修订 ADR、数据族接入或执行模型变化
>   时对照本文校验一致性；与代码现状矛盾且未标注待落地、或被新 ADR 推翻而未
>   同步修订时，本文标记为 `stale`。
> - **最后验证（Last Verified）**：2026-08-06。
> - **交叉引用约定**：本文档内部章节引用写作 `§N`；引用 ADR 索引的章节写作
>   `ADR §N`（如 `ADR §21` 指 ADR 索引的踩坑复盘，不是本文 §21 Demo 决策）。
> - **治理规则**：变更触发、不重复规则（no-duplication）等见 §24。

---

## 1. 产品定义与边界

BioMed-QAgent 是面向生物医学开放数据的智能检索与标准化系统。它从自然语言
数据需求出发，自动发现和评估来源，将**同类数据**映射至明确的规范 Schema，
经过清洗、兼容性检查、合并、置信度标注和来源追踪后，输出可直接用于后续分析
的标准化数据集。

**核心边界**：系统的首要任务是**构建标准化可用数据集**，而不是完成一项完整
科研研究。研究解释、机制分析、假设生成和多角度证据汇总可以作为上层能力，但
不能决定底层主数据结构。这一边界直接对应赛题
（[PROBLEM.md](../PROBLEM.md) 主选题 A）的评分对象：数据查找完备性、来源可追
溯性、清洗整合可靠性、输出格式可用性。

**多源异构的精确含义**：多源指**来源和载体异构**——数据库、论文表格、附件、
网页和图表；不表示表达、突变、通路、临床和文献元数据可以共享同一行粒度。允
许合并的数据必须属于同一数据域、可比较、可合并。

**复合需求**：当一个用户请求涉及多个数据域或多种行粒度时，拆分为多个独立的
DatasetBuild（见 §3）。会话可将多个 Build 放在同一任务下，但每个 Build 独立
验证和发布。

> 决策依据：ADR-001（产品边界）、ADR-002（单族单粒度）、ADR-006（辅助数据）。

---

## 2. 架构总览

系统采用**双层结构：Agent + Dataset Construction Runtime**。Agent 负责意图解析、
来源发现和规格生成；Runtime 负责确定性获取、解析、归一化、兼容性判断、合并、
验证、置信度、溯源和原子发布。

```text
React/shadcn Frontend
        |
        | HTTP + WebSocket (durable events + realtime assistant stream)
        v
FastAPI Control Plane  (task / run / build / publication / settings / skills / cache)
        |
        v
OpenAI Agents SDK Main Agent + Discovery Skills
        |
        | DatasetBuildSpec  (单一权威输入)
        v
Spec Validator  (trusted service)
        | \
        |  `-- reject -> BuildResult(SPEC_REJECTED) + RunSummary
        v
Dataset Construction Runtime  (服务端固定构建骨架)
        |
        +-- acquire[*]                  每来源获取
        |     +-- built-in Acquisition Provider
        |     `-- PROMOTED WorkflowRecipe -> SourceAsset
        +-- parse[*]                    SourceAdapter 解析
        +-- canonicalize / normalize[*] 映射、实体与单位规范化
        +-- compatibility gate          family / granularity / key / measurement 兼容性
        +-- integrate                   确定性合并
        +-- validate                    Validation Profile 驱动
        `-- publish when eligible       原子提升
                 |
                 +-- DatasetPublication (0..1)
                 |     +-- DatasetManifest
                 |     +-- primary / supporting datasets
                 |     +-- schema + provenance
                 |     `-- audit reports
                 `-- BuildResult + server-generated RunSummary
```

方括号步骤可以按来源并发；fan-out / fan-in 属于 Runtime 内部控制流，不形成 Agent
可编排 DAG，也不形成数据集级 Recipe。

**保留自 V1 的可靠性内核**（见 §4）：SourceAsset、DownloadAttempt、内容 hash、
Attempt 输入/参数/输出摘要、任务锁、checkpoint、timeout/cancel、durable event、
staging、Validation Gate、原子发布、fixture/live 区分。

**替换自 V1 的业务中心**：固定 `_STAGES` 列表、`StageName` 作为业务主协议、
固定数据库组合 allowlist、`StageAttempt` 的阶段专属语义、固定 Artifact 文件集合、
固定验证顺序、固定 22 列 `main_data.csv` 全局协议，以及 metadata-only 占位主表。
这些 V1 抽象在 V2 中降级为兼容 facade 或彻底移除（见 §18）。

> 决策依据：ADR-003（保留可信内核）、ADR-004（服务端固定构建骨架，不引入完整 DAG 或 BuildRecipe）。

---

## 3. 核心抽象

### 3.1 DatasetBuildSpec（自包含）

`DatasetBuildSpec` 是 Agent 在意图解析和来源发现后生成、提交给 Runtime 的**单一
权威输入契约**。它同时表达用户语义和受控构建参数，至少包含：

- `dataset_family`：数据集族标识（如 `gene_expression`、`pathway_member`）；
- `row_granularity`：行粒度定义（如 "基因 × 样本 × 测量"）；
- `schema_ref`：目标 Schema 的注册引用（见 §3.3）；
- `required_fields`：必需字段清单；
- `source_bindings`：每个来源的 SourceBinding（来源、获取方式、Adapter、
  accession/参数）；获取方式只能是 `builtin` 或 `workflow_recipe`；
- `normalization_profile_ref`：归一化 Profile 引用；
- `merge_strategy`：服务端允许的显式合并策略；
- `validation_profile_ref`：Validation Profile 引用；
- `output_format`：发布格式偏好。

不建立正式 `DatasetRequest` 契约。自然语言解析过程中可以使用 Agent 内部的
`ParsedDatasetIntent`，但它不进入持久化、API 或执行协议，避免
`DatasetRequest -> DatasetBuildSpec` 两个对象之间重复、漂移和跨引用读取。

### 3.2 dataset_family 与 row_granularity

一个 DatasetBuild 的主数据必须满足以下四元组均明确且兼容：

```text
dataset_family + row_granularity + key_semantics + measurement_semantics
```

**可以合并**的示例：

- 多来源 gene-sample expression；
- 多论文中采用同一指标和同一对象粒度的实验测量；
- 多数据库的 pathway-member 记录。

**不能直接合并**的示例：

- 表达行与突变事件行；
- 基因-样本测量与队列聚合统计；
- 文献元数据与表达测量；
- 通路节点与临床样本；
- 原始 count 与 TPM，除非明确转换或保持可区分语义。

`row_granularity` 不是字符串标签，而是结构化定义：一行代表什么实体、什么测量、什么
时间或条件维度。任何"合并"设计必须先写出一行代表什么，再讨论字段对齐。

### 3.3 Canonical Schema 与 Schema Registry

**Schema Registry**（待落地）是数据族规范 Schema 的版本化注册中心。每个注册的 `DatasetSchema`（即 Canonical Schema）声明：

- Schema 标识与版本；
- dataset family 与 row granularity；
- 字段集、类型、约束和语义角色；
- 主键与外键语义；
- 单位、尺度、ontology / vocabulary 规范；
- derivation policy；
- 与历史 Schema 的兼容性关系。

V1 的 22 列表达长表可作为 `gene_expression` 数据族的一个 versioned profile
保留，但**不再是全局协议**。新数据族通过注册新 Schema 接入，不修改其他数据族
的 Schema 或共享分支。

`_FIELD_DESCRIPTIONS` 字典（V1，位于 `pipeline/stages/artifact_build/columns.py`）
将迁移为 Schema Registry 中的字段元数据；不再在 Builder / Validation / API /
前端多处分散定义。

### 3.4 SourceBinding、Acquisition Provider 与 WorkflowRecipe

`SourceBinding` 记录本次使用的来源、查询、accession、版本、获取方式、参数和解析
Adapter。获取方式只能是：

- `builtin`：由可信内置 Acquisition Provider 执行；
- `workflow_recipe`：生产默认引用已提升的 `PROMOTED WorkflowRecipe`，由
  `WorkflowRecipeSourceFetcher` 调用 `RecipeExecutor` 可信解释执行并只产出
  `SourceAsset`。

`WorkflowRecipe` 属于 Acquisition 子系统，不属于 Dataset 核心契约，也不是数据集
级工作流。它是**声明式、非代码**的来源获取描述；不能包含 Python、JavaScript、
Shell 等任意代码。其生命周期与生产消费闭环见 §16.5。

`WorkflowRecipe` 不能产生 Canonical DataBatch、声明跨来源依赖、执行集成、选择
Validation Profile、决定发布或直接写正式 Artifact。

### 3.5 DataBatch 与字段映射

`DataBatch` 是 Parser / Adapter / Canonicalizer 之间的文件型或流式数据契约，至少
声明：

- `batch_id` 与 `binding_id`；
- dataset family 与 row granularity；
- 当前 Schema 引用；
- 数据文件引用、行列数和摘要；
- Parser / Adapter 标识与版本；
- 统计、warning 和 rejected-record 摘要。

全链路不以 `rows: list[dict]` 作为默认交换格式，避免大文件全量读入内存。

字段映射是正式执行输入和审计产物。字符串相似度只能产生 `proposed` 候选，未经
Adapter、Schema Registry、可信元数据、明确规则或人工批准，不得进入正式合并。

### 3.6 主数据与 Artifact Role

一个 Build 只有一个主数据集族和一种行粒度。Manifest 只定义五类稳定角色：

- `primary_dataset`：本次 Build 的核心标准数据集；
- `supporting_dataset`：样本维表、队列信息等辅助结构化数据；
- `schema`：Canonical Schema 和字段说明；
- `provenance`：lineage、字段映射、实体映射和转换链；
- `audit_report`：来源选择、搜索报告、质量报告、拒绝记录、warning、下载审计等。

物理文件名和文件拆分方式属于 Publisher 实现，不属于顶层协议。`SourceAsset` 保持
独立身份，Manifest 引用其 ID，不要求复制进 Artifact 包。

多表不代表回到“多角度研究包”。Supporting dataset 和审计产物服务主数据解释、
映射、复算或质量审查，不与主表争夺业务中心。

**关系型特例**：如果数据天然是关系型结构，可有主事实表和维表，但必须显式建模
关系、主表角色、family 和 row granularity。

### 3.7 DatasetManifest 与 DatasetPublication

`dataset_manifest.json` 是程序识别主数据和其他 Artifact 的**唯一权威入口**。
程序不得硬编码 `main_data.csv`、`dataset.csv` 或任何固定文件名。Manifest 至少
声明：

- Build ID、版本和 Manifest digest；
- 主数据 Artifact ID；
- dataset family 与 row granularity；
- Canonical Schema 引用与版本；
- 主键、行数和 hash；
- SourceAsset、Adapter、Parser 和 Profile 引用；
- confidence 与 provenance 摘要；
- 按 Artifact Role 分类的产物清单。

`DatasetPublication` 是通过 Validation Gate 后原子提升的不可变正式版本，包含：

```text
publication_id
manifest_ref
validation_result_ref
published_at
supersedes_publication_id
```

任务或会话只保存 `current_publication_id`。所谓“当前结果”来自指针，不来自可变 Artifact 状态。

可为 Demo 提供 `dataset.csv` 别名，但程序不依赖该文件名。

> 决策依据：ADR-002（单族单粒度）、ADR-004（不新增 BuildRecipe）、ADR-005（Manifest 驱动）、ADR-006（Artifact Role）、ADR-010（状态正交）、ADR-015（缓存身份）。

---

## 4. 可信执行内核（保留自 V1）

以下能力是赛题“来源追踪、可复现、错误修正”的基础。V2 保留其语义和可靠性
不变量，按需抽取、复用或重构实现：

| 能力 | V1 实现位置（参考） | V2 状态 |
| --- | --- | --- |
| `SourceAsset` 内容 hash 标识 | `domain/contracts/source.py` | 保留 |
| `DownloadAttempt` 成功/失败记录 | `domain/contracts/source.py` | 保留 |
| Attempt 输入/参数/输出摘要 | `domain/contracts/pipeline.py` | 保留，语义从"阶段"泛化为"步骤" |
| 任务锁、checkpoint、timeout/cancel | `runtime/manager.py` | 保留（V1 `pipeline/runner.py` 已删） |
| durable event 持久化与重放 | `runtime/event_store.py`、`runtime/hub.py` | 保留 |
| staging 区与原子发布 | `datasets/build/expression_runner.py`（immutable publication）、`datasets/build/v1_bridge.py`（legacy 镜像） | 保留（V1 `pipeline/stages/validation/publish.py` 已删） |
| Validation Gate | `datasets/build/profiles.py`（`VALIDATION_PROFILES`）+ `datasets/spec_validator.py` + `datasets/build/invariants.py`（release 不变量） | 保留门禁，Profile 驱动（§10） |
| fixture / live 区分 | 测试标记与 `mode` 参数 | 保留 |
| 网络访问、安全下载、沙箱、egress 边界 | `integrations/`、BrowserPool | 保留 |

V2 重构目标是**重新组织**这些能力围绕 DatasetBuild 中心，不是证明 V1 实现一无
是处。重构后这些能力的接口可能变化，但语义不变。

> 决策依据：ADR-003、ADR §20（V1 已做对的事情）。

---

## 5. 执行模型：服务端固定构建骨架

### 5.1 固定 Operation 序列

Dataset Runtime 不暴露数据集级 `BuildRecipe`，也不让 Agent 生成 nodes / edges。
服务端执行以下固定、可测试的构建骨架：

```text
acquire[*]
  -> parse[*]
  -> canonicalize / normalize[*]
  -> compatibility gate
  -> integrate
  -> validate profile
  -> publish
```

方括号步骤按来源独立执行并可内部并发。fan-out / fan-in 是 Runtime 实现细节，
不是通用 DAG。只有当用户自定义任意分析链、多级条件分支、节点复用和分布式执行
成为核心需求时，才重新评估 DAG。Spec Validator 拒绝时在获取前短路；`NO_DATA`
或验证失败时跳过正式主数据发布。

### 5.2 OperationAttempt、恢复与局部重跑

每个 Operation 创建独立 `OperationAttempt`，记录输入摘要、参数摘要、实现版本、
输出摘要、attempt 序号和状态。Operation 必须幂等；恢复时只复用输入、参数、实现
版本和输出 digest 一致的成功结果。

- 同一 Agent Run 内只允许一次 publication；补充数据或修正规格通过新的 durable
  Run 实现；
- topic、来源、查询参数、Adapter、Schema、字段映射或 Profile 变化必须形成新的
  Run / 构建版本；
- 局部重跑不是任意 `skip_stages`。服务端按固定依赖闭包从指定 Operation 重新
  执行，下游不得消费 digest 不匹配的上游输出。

### 5.3 Publication 版本关系

每次通过门禁的结果都生成不可变 `DatasetPublication`。后续补充或修订不修改旧
Artifact 状态，而是：

```text
publication_v2.supersedes_publication_id = publication_v1
task.current_publication_id = publication_v2
```

不存在 `validated_intermediate` / `validated_final`。所谓“final”只表示当前
Publication 指针，不是 Artifact 固有状态。

### 5.4 来源并行与确定性集成

`acquire` / `parse` / `canonicalize` 对每个来源独立执行，可内部并发。
`compatibility gate` 之后的 `integrate` 只接受服务端允许的显式策略，不接受 Agent
注入的任意合并逻辑。

> 决策依据：ADR-004、ADR-010。

---

## 6. 职责边界：Agent 与服务端

### 6.1 Agent 权限

- 解析用户需求；
- 选择或建议 Canonical Schema；
- 查找候选来源；
- 选择 Adapter；
- 提议字段映射（状态 `proposed`）；
- 生成 `DatasetBuildSpec`；
- 根据诊断重新规划；
- 拆分复合需求为多个 Build。

### 6.2 服务端权限

- 下载和校验文件；
- 运行 Parser；
- 读取源值；
- 执行确定性转换与归一化；
- 批准字段映射（将 `proposed` 提升为 `approved`）；
- 判断兼容性；
- 计算质量和置信度；
- 验证与发布。

### 6.3 禁止

**Agent 不能直接提交一个数字并声明它来自论文、图表或数据库。** 任何模型提取
必须绑定 SourceAsset、定位信息、模型版本、置信度和审核状态。

Agent 不直接拼装最终 CSV，不绕过 Compatibility Gate，不绕过 Validation Gate，
不绕过原子发布。Agent-only Skill 的产物不能直接作为正式主数据。

> 决策依据：ADR-007。

---

## 7. 来源能力与数据兼容性

V1 的 `SUPPORTED_PIPELINE_SOURCE_COMBINATIONS`（`domain/contracts/enums.py`）
把"来源组合"当成正式能力边界。V2 拆为两层独立判断：

### 7.1 Adapter capability（系统能否安全获取和解析该来源）

声明系统对该来源的获取与解析能力：能否搜索、能否下载、能否解析、是否需要
fixture 豁免、是否仅研究用途。以 `SOURCE_CAPABILITIES` 单一事实表声明（V1 已
存在，V2 保留并扩展）。

### 7.2 Dataset compatibility（本次数据能否映射至目标 Schema 并合并）

每次 Build 独立判断，依据：

- `dataset_family` 一致；
- `row_granularity` 兼容；
- 主键语义兼容；
- 测量语义可比较（如 TPM vs raw count 必须显式处理）；
- 单位与尺度可统一或显式标记不可比较；
- 字段映射证据充分（见 §8）。

**示例**：GDC 和 Xena 都可用（Adapter capability 满足），不代表任意 GDC 数据
与任意 Xena 数据可合并（Dataset compatibility 仍需校验）。

### 7.3 来源接入不变量

新来源接入**不应**修改多个数据库组合分支。新来源通过注册 Adapter + Canonical
Schema + Validation Profile 接入，组合可能性由兼容性判断决定，不靠 allowlist
枚举。

> 决策依据：ADR-008、ADR §21.7（踩坑）。

---

## 8. 字段映射

### 8.1 映射证据来源

正式字段映射必须来自以下之一：

- Adapter 声明（来源官方文档或结构化元数据）；
- Schema Registry（Canonical Schema 间的标准映射）；
- 可信元数据（如 GEO 平台 probe-to-gene 注释）；
- 明确规则（如单位转换公式）；
- 人工批准（HIL）。

### 8.2 字符串相似度只提议，不批准

V1 的 `tools/alignment.py` 使用列名包含关系和公共前缀相似度（阈值 `>= 0.7`）
对齐字段。V2 保留其作为**候选生成器**，但默认状态为 `proposed`，不直接进入
正式数据。

**原因**：列名相似无法证明同一语义、同一单位、同一粒度、同一值域、同一实体
ID、一对一关系。V1 的相似度规则足以将看似相似、实际不同的字段对齐，垂向合并
会让错误进入正式数据。

### 8.3 Schema Registry 与映射状态

字段映射在 Schema Registry 中以状态机管理：`proposed` → `approved` /
`rejected`。批准来源记录在案，便于审计与回滚。

> 决策依据：ADR-009、ADR §21.6（踩坑）。

---

## 9. 运行状态、数据结果与发布状态

V2 使用四个正交概念，禁止一个状态字段同时回答执行、数据、验证和发布问题。

### 9.1 四类正交状态（待落地）

| 概念 | 回答问题 | 典型值 |
| --- | --- | --- |
| `RunStatus` | 执行是否排队、运行、完成、失败或取消 | `QUEUED/RUNNING/COMPLETED/FAILED/CANCELLED` |
| `BuildResult` | 正常完成后得到什么数据结果 | `SUCCEEDED/PARTIAL_SUCCESS/NO_DATA/SPEC_REJECTED` |
| `ValidationResult` | 某个 Manifest digest 是否通过 Profile | `PASSED/FAILED` |
| `DatasetPublication` | 哪个不可变版本已正式提升 | `publication_id + supersedes` |

Parser 崩溃、文件损坏和内部异常对应 `RunStatus=FAILED`；用户取消对应
`RunStatus=CANCELLED`。这些不是数据业务结果。

### 9.2 BuildResult：正常完成后的数据结果

只有 `RunStatus=COMPLETED` 才产生 `BuildResult`：

| 结果 | 含义 | 是否可有 Publication |
| --- | --- | --- |
| `SUCCEEDED` | 主数据通过验证并发布 | 是 |
| `PARTIAL_SUCCESS` | 部分来源失败，剩余来源有效并通过 Profile | 是 |
| `NO_DATA` | 未得到可发布主数据，但运行正常结束 | 可有审计型 Publication |
| `SPEC_REJECTED` | BuildSpec 不满足 Schema、能力、兼容性或资源约束 | 否 |

`BuildResult` 至少包含有效行数、成功来源、拒绝来源、可用 Artifact Role、
`publication_id`、原因码、用户摘要和建议下一步。

不再定义 `EXECUTION_FAILED` 或 `CANCELLED` BuildResult；它们已由 RunStatus 表达。

### 9.3 ValidationResult 与 DatasetPublication

- `ValidationResult` 回答某个 Manifest digest 是否通过指定 Profile；
- `DatasetPublication` 回答哪个不可变版本已经正式提升；
- Task / Session 只保存 `current_publication_id`。

一个 Build 可以产生 ValidationResult 但不发布；只有与当前 Manifest digest 对应的
通过状态 ValidationResult 才能进入原子发布。

### 9.4 NO_DATA 是正式业务结果

- 无主数据不再必然触发内部失败，`RunStatus` 仍可为 `COMPLETED`；
- 前端不通过错误字符串猜测 `NO_DATA`；
- 无数据时可以交付 schema、provenance 和 audit_report；
- 不创建空主表或伪造测量记录；
- 用户始终收到服务端生成的明确 RunSummary。

### 9.5 禁止 metadata-only 占位主表（P0）

V1 在 GEO 没有表达矩阵时，将样本元数据写成
`measurement_type=sample_metadata` 的表达 Schema 行，并在 Validation 中跳过
表达值和 lineage 检查。这破坏了主数据语义。V2 规定：

- 主表无合法记录时 BuildResult 为 `NO_DATA`；
- 样本元数据保存为 `supporting_dataset`；
- Validation 不允许 warning 或特殊字段豁免目标数据不存在；
- 空主表不发布为 `SUCCEEDED`；
- 可以发布归入 `audit_report` 的来源搜索、拒绝和诊断报告，但不能伪装成主数据集
  成功。

### 9.6 不通过 Artifact 数量判断成功

V1 曾通过 Artifact 数量和错误文本间接推断结果，导致 silent completion 与
`NO_DATA` 混淆。V2 由 RunStatus、BuildResult、ValidationResult 和 Publication
共同表达终态，不靠 Artifact 数量，也不靠前端解析错误文本。

> 决策依据：ADR-010、ADR-011、ADR §21.4/§21.9（踩坑）。

---

## 10. Validation Profile

### 10.1 Profile 驱动验证

V2 验证由数据集 Profile 驱动，替换 V1 的单一通用 Validator
（`pipeline/stages/validation/package.py`）。不同数据族使用不同的版本化 Profile，
不再通过 Reactome 特例、表达列存在性和 metadata-only 条件分支共享一个万能
Validator。

Profile 可以组合以下类型的具体规则：

- 文件、Manifest、Schema 和类型；
- 主键、外键和唯一性；
- 数据族语义；
- 单位、尺度和归一化；
- provenance 与 confidence；
- `NO_DATA` / `PARTIAL_SUCCESS` 的阈值；
- 图表 bounding box、模型版本和人工复核状态。

Agent 只能选择服务端允许的 Profile 引用，不能直接写入发布阈值或放宽门禁。

### 10.2 发布门禁：三项架构不变量

架构层只规定三项稳定不变量：

1. **Provenance closure**：正式记录可以追溯到 SourceAsset、源定位、
   Parser/Adapter 版本、字段映射和转换版本；
2. **Validation Profile passed**：与目标 Manifest digest 对应的版本化 Profile
   判定通过；
3. **Atomic promotion**：Publisher 只原子提升引用闭合、staging 完整且已验证的
   Manifest。

CSV 编码、列数稳定、Schema/类型/主键、measurement 完整率、单位尺度与归一化、
warnings 与 metrics 一致、probe mapping 覆盖率、`NO_DATA` / `PARTIAL_SUCCESS`
阈值等属于具体 Validation Profile 的实现与测试，不提升为全局架构协议。

`NO_DATA` 不要求“必需主 Artifact 非空”。它应通过专门结果规则证明没有可发布主
数据，并保留足够审计证据。

### 10.3 ValidationResult 与原子发布

Validation Engine 的输出必须绑定：

- `manifest_digest`；
- `validation_profile_ref` 与版本；
- `PASSED` / `FAILED`；
- 规则结果、原因码和审计摘要。

Publisher 继续使用任务锁、独立 staging、文件 flush、Manifest 验证和同文件系统
原子 rename。发布成功后才生成不可变 `DatasetPublication`、Artifact 事件和完成
事件；失败文件不得出现在 Artifact API。

### 10.4 测试策略

测试锁定三项架构不变量和 Profile 结果，不依赖全局 `check_id` 固定顺序。某个
数据族的列规则、阈值和文件细节应进入对应 Profile 合约测试，而不是成为系统级
架构测试。

> 决策依据：ADR-012、ADR §21.5/§21.10/§21.18（踩坑）。

---

## 11. 置信度

### 11.1 可解释等级，非虚假概率

置信度包含：

- `level`：`high` / `medium` / `low`；
- `channel`：来源通道（API / VLM / 网页 / 表格解析等）；
- `reasons`：判定理由；
- `source_reliability`：来源可靠度；
- `extraction_reliability`：提取可靠度；
- `mapping_reliability`：映射可靠度；
- `validation_result`：验证结果；
- `cross_source_consistency`：跨源一致性；
- `human_review_state`：人工审核状态。

未经标定的 `0.92` 看似精确，实际没有概率解释。赛题更需要可解释、可追溯和可
复核。

### 11.2 通道差异

- 确定性官方 API（GDC、Xena、Reactome、PubMed）可使用批次默认等级；
- VLM / LLM / 网页抽取必须逐条标注。

### 11.3 与 Validation 的关系

置信度不是 Validation 的替代。Validation 判断是否满足发布规则；Confidence 描
述记录在已知证据下有多可靠。

### 11.4 禁止装饰字段

V1 图表数据已有 `confidence` 列但值为空。V2 规定：置信度必须有计算/判定策略、
理由、门禁和 UI，不允许空值默默通过。

> 决策依据：ADR-013、ADR §21.13（踩坑）。

---

## 12. 溯源（Provenance）

### 12.1 主表最小字段

主表保留最小溯源字段：

- `record_id`；
- `source_id`；
- `asset_id`；
- `provenance_id`。

### 12.2 Lineage sidecar

详细定位、原值和转换链放在 lineage sidecar。这样既保持主表可分析性，又能完整
追踪。

`SourceLocator`（V1 已存在）精确定义：

- 解压后的 logical file；
- 以 1 为基准、包含表头/注释/空行的物理文本行号；
- 以 0 为基础的列索引；
- 原始列名与原始 token。

### 12.3 例外

Demo 或小表可以内联关键来源字段，但 Manifest 和 sidecar 仍为权威来源。

> 决策依据：ADR-014。

---

## 13. 缓存身份

V2 缓存身份由 Schema 和构建参数标识，不由关键词或固定列标识。身份包含：

- dataset family；
- Schema version；
- SourceAsset digest；
- Adapter / parser version；
- normalization profile；
- cohort / query parameters。

**关键词用于检索缓存，不用于决定资产身份。**

V1 现状：字节级内容缓存（`tools/content_cache.py`）已按
`(database, accession, url)` 标识，逻辑缓存（`tools/cache_store.py`）按
`(source_namespace, dataset_id)` 标识并使用 SQLite FTS5 检索——这些已符合
V2 精神。V2 目标布局为 `cache/datasets/<namespace>/<dataset_id>/`
（manifest + data + schema + provenance），旧 22 列 `main_data.csv` 缓存
契约迁移为 `gene_expression.long.legacy.v1` 并双写（见实现规格 Design §13）。

> 决策依据：ADR-015、ADR §21.3（踩坑）。

---

## 14. Durable Runtime（保留自 V1）

Durable Runtime 是 V1 已成熟的能力，V2 完整保留。本节描述权威契约。

### 14.1 任务与 Run 生命周期

FastAPI lifespan 初始化唯一的 `TaskManager`、`TaskRepository`、durable
`EventHub`、内存 `AssistantStreamHub` 和 `TaskIndex`。

- `<task_id>/events.jsonl` 是 append-only 事件日志；`EventStore` 强制 sequence
  从 1 开始连续递增，`TaskRepository` 先持久化再向 `EventHub` 发布；
- `<task_id>/state/task_snapshot.json` 是原子写入的权威状态投影；snapshot 落后
  于 event log 时，repository 通过纯函数 `reduce_task_event` 补齐投影；
- `<task_id>/state/session_items.jsonl` 保存 OpenAI Agents SDK 的原始 Session
  历史，`conversation_summary.json` 保存 compaction 摘要；前端不保存会话事实；
- `task_index.sqlite3` 只承担分页和 request-id 幂等查询，可由 snapshot/event
  重建，不是会话事实来源。

`RunStatus` 生命周期（V1 已实现）：

```text
QUEUED -> RUNNING -> FINALIZING -> COMPLETED | FAILED | INTERRUPTED
   |         |             |
   |         +-> AWAITING_USER_INPUT -> RUNNING | FAILED | INTERRUPTED
   |         |             |
   `---------+-------------+-> CANCEL_REQUESTED -> CANCELLED | FAILED | INTERRUPTED
```

### 14.2 事件系统

`EventEnvelope` v2 为 managed Run 增加 `run_id`。Run 生命周期、Agent 活动和经
Agent Tool 桥接的 V1 Pipeline / V2 DatasetBuild 事件都使用 `schema_version="2.0"`；sequence 是
**Task 级单调递增**，不是每个 Run 重新计数。旧 fixture envelope 仍兼容 v1。

事件类型分两个 StrEnum 家族（`domain/contracts/events.py`）：

- `PipelineEventType`（18 类）：`TASK_CREATED`、`PLAN_READY`、
  `USER_INPUT_REQUIRED/RESUMED`、`STAGE_*`、`TOOL_CALLED/COMPLETED`、
  `WARNING`、`ARTIFACT_PRODUCED`、`TASK_CANCEL_*`、`TASK_RECOVERED`、
  `TASK_COMPLETED/FAILED`；
- `RuntimeEventType`（22 类）：`RUN_*`、`ASSISTANT_DELTA/REASONING_DELTA`、
  `TOOL_STARTED`、`CONVERSATION_COMPACTED`、10 个 `SUBAGENT_*` 事件。

V2 逐步新增通用构建事件（`build_spec_ready`、`operation_started/progress/
completed/failed`、`source_candidate_found/rejected`、`compatibility_evaluated`、
`build_result_ready`）。兼容期与旧 `stage_*` 并存；前端基于 `operation_id`、
`label` 和 `category` 渲染，不再依赖固定 `StageName` union。

`tool_started` 携带可选 `arguments` dict（深度截断 3、字符串 200 字符、列表 20
项），`tool_completed.output` 截断到 4096 个字符，前端据此渲染"检索 PubMed · 查询:
..."标签而无需回拉。

### 14.3 双通道 WebSocket

WebSocket 端点 `/api/v1/ws` 只接受三类命令：

- `{"type":"subscribe","task_id":"...","after_sequence":N}`：先重放
  `sequence > N` 的 durable events，再无缝进入 live fan-out；
- `{"type":"unsubscribe","task_id":"..."}`：取消该 Task 的订阅；
- `{"type":"ping"}`：返回 `{"type":"pong"}`。

服务端输出分两条通道：

- **durable 通道**：发送带 Task sequence 的 `EventEnvelope`，以及 `pong` /
  `error` 控制帧；按 Task watermark 去重，若 live sequence 出现间隙，会先从
  repository 补齐；
- **realtime 通道**：发送无 sequence 的 `assistant_stream_delta` 和
  `assistant_stream_end`，由 `AssistantStreamHub` 提供，仅驻留内存、best-effort
  fan-out，不写入 event log；每个订阅队列有界，慢消费者以可重连状态关闭，Run
  的 durable 写入与执行不受影响。

Agent 收到模型文本 chunk 后，先发布 `assistant_stream_delta`，再放入 durable
buffer，按时间/大小批量写为 `assistant_delta`，并在工具调用、正常或截断结束、
异常与取消路径上强制 flush。durable payload 可携带 `stream_id +
from_chunk_index + through_chunk_index`；三字段必须同时出现或同时省略，省略时
兼容旧事件。

### 14.4 人在回路与并发

Agent 模式的计划确认会持久化 `user_input_required`，纯 reducer 将 Run 投影为
`awaiting_user_input`。`POST /resume` 必须匹配当前 Run 的 exact `request_id`，
且同一请求只消费一次；批准后持久化 `user_input_resumed` 并回到 `running`，拒绝
或独立 HIL timeout 会使权威 Run 失败。取消 paused Run 会唤醒执行器的协作式
取消等待，不必等到 HIL timeout。fixture 模式仍记录 required/resumed 审计事件，
但以 `fixture_exempt=true` 自动批准且不阻塞。

默认全局 4 个 active Run slot 和 4 个 worker；不同 Task 可以并行执行，同一
Task 只允许一个 nonterminal Run，后续提交返回冲突。`awaiting_user_input` 期间
仍占用原 slot，避免暂停任务被队列中的新任务抢占。

`UserInputRequiredPayload.prompt_kind` 联合覆盖 `plan_confirmation` /
`max_turns_reached` / `data_correction`。前端 `UserInputDialog` 按 Run 与
submission attempt ID 隔离 A → B → A 切换中的旧 Promise settlement。

### 14.5 模型配置与 Run 自有生成设置

模型配置 REST 端点见 §15。每个 Run 在构造时捕获不可变 `RunModelSettings` 快照
（通过 `run_model_settings_scope` contextvar），将 Agent 与并发的设置变更隔离。
快照包含模型身份与凭据、六个生成参数，以及不可变 `ContextBudget`。运行期间的
设置变更和新校准只影响后续 Run。

到 OpenAI Agents SDK `ModelSettings` 的映射、DashScope 专有字段的条件发送、
Token 估算与压缩校准沿用 V1。`LazyDashScopeModel` 显式持有其创建的
`AsyncOpenAI` 客户端，Run 清理时先解除内部引用再关闭，避免连接池泄漏或重复
关闭。

VLM 调用（`agent_loop/vl_model.py`）执行一次性 `chat.completions.create`，接收
显式 `RunModelSettings` 快照，使用独立 `AsyncOpenAI` 客户端并在 `finally` 关闭。
VLM 不是 Agent 模型，不参与对话轮次。

### 14.6 Agent SDK 动态 instructions 契约

Main Agent 使用动态 instructions，在每轮模型调用前把当前 Run 的已完成检索记录
注入 system prompt。该 callable 必须遵守 OpenAI Agents SDK 的公开二参数契约
`(context, agent)`；即使实现只读取 `context`，也不能省略 `agent` 参数。该契约
由 `tests/test_agent.py::test_dynamic_instructions_resolve_through_sdk` 通过
SDK 的 `Agent.get_system_prompt()` 公共边界固定。

> 决策依据：ADR-003（保留可信内核）。

### 14.7 个性化设置契约（自定义指令 / 回复语气）

`app/personalization.py` 提供独立于模型设置的个性化持久化
（`data/personalization.json`，原子写入）：`custom_instructions`（默认空串）
与 `personality`（`pragmatic` / `warm` / `rigorous`）。REST 见 §15
（GET/PUT `/personalization`）。

注入契约：`agent_loop/agent.py::resolve_agent_instructions` 在系统提示词顶部
（`preferred_sources` 之前）追加「用户自定义指令 + 回复语气」小节；子 Agent 与
prompt-shape 估算复用同一函数，保证主 Agent / 子 Agent / token 估算读到完全
一致的内容。指令为空时不注入自定义指令段，仅注入语气行，避免无谓占用上下文。

前端设置：编辑器 / 外观 / 偏好类设置存 `localStorage["biomed.preferences"]`
（`stores/preferencesStore.ts`），通过 `documentElement` 的 data-* 属性与 CSS
变量（`--ui-contrast`、`--background` / `--foreground` 等 color-mix 派生值）
即时生效；自定义颜色留空时保持主题默认。

编辑器「跟进处理方式」提供两种策略：加入队列（当前回答结束后自动发送）与
调整方向（取消当前回答，任务回到空闲后立即用新消息重新引导）；发送时按住
Ctrl+⌘ 可对单条消息执行相反操作。半透明侧边栏开启时，在 body 上追加一层极淡
渐变背景作衬托，配合 backdrop blur 呈现毛玻璃效果（桌面侧边栏为 fixed 定位，
内容区并不在其后方，单纯降低透明度看不到效果）。

---

## 15. API 面

统一前缀 `/api/v1`。下表为 V2 目标 API 面（V1 已实现的标注 ✅，待落地的标注
🚧）。完整路由注册见 `backend/app/api/routes.py`、`api/skills.py`、
`api/settings.py`、`api/model_info_router.py`、`api/provider_models.py`、`api/ws.py`。

| Method | Path | Purpose | 状态 |
| --- | --- | --- | --- |
| GET | `/health` | 健康检查 | ✅ |
| GET | `/databases` | 列出用户可选数据库 | ✅ |
| POST | `/databases` | 声明式用户数据库包上传 | ✅ |
| PUT | `/databases/{name}` | 更新用户数据库包 | ✅ |
| DELETE | `/databases/{name}` | 删除用户数据库包 | ✅ |
| GET | `/settings` | 当前用户模型设置（api_key 掩码） | ✅ |
| POST | `/settings` | 更新并持久化用户模型设置 | ✅ |
| GET | `/personalization` | 当前自定义指令与回复语气 | ✅ |
| PUT | `/personalization` | 更新并持久化个性化设置 | ✅ |
| GET | `/vendors` | 列出已知模型供应商 | ✅ |
| GET | `/models` | 可用模型列表，支持 `?query=`/`?preview_base_url=`/`?use_current_settings=` | ✅ |
| GET | `/models/{model_id}` | 单个内置模型详情 | ✅ |
| GET | `/model-registry/providers` | 列出用户配置的模型供应商（密钥掩码） | ✅ |
| POST | `/model-registry/providers` | 新建供应商（名称代号 / Base URL / API Key / 预设） | ✅ |
| PUT | `/model-registry/providers/{provider_id}` | 更新供应商（api_key 省略不变、空串清除） | ✅ |
| DELETE | `/model-registry/providers/{provider_id}` | 删除供应商（关联 model 级联删除） | ✅ |
| POST | `/model-registry/providers/{provider_id}/discover` | 拉取该供应商 `GET /models` 并用内置目录富化 | ✅ |
| GET | `/model-registry/providers/{provider_id}/param-specs` | 返回该供应商可选的参数定义（含保底回退），供手动添加表单使用 | ✅ |
| GET | `/model-registry/models` | 列出维护的模型列表（含 param_specs 与 params） | ✅ |
| POST | `/model-registry/models` | 添加维护模型（多余参数不报错，写入 params 保留） | ✅ |
| PUT | `/model-registry/models/{model_id}` | 更新模型 / 参数 | ✅ |
| DELETE | `/model-registry/models/{model_id}` | 删除维护模型 | ✅ |
| POST | `/model-registry/models/{model_id}/activate` | 切换为当前模型（回写 `/settings` 运行时设置） | ✅ |
| GET | `/tasks` | 返回全部 active Task 与 cursor 分页的历史 Task | ✅ |
| POST | `/tasks` | 创建 durable Task 并排队首个 Run | ✅ |
| GET | `/tasks/{task_id}` | 返回权威 `TaskSnapshot` | ✅ |
| DELETE | `/tasks/{task_id}` | 删除 terminal Task 及其历史 | ✅ |
| POST | `/tasks/{task_id}/runs` | 为 idle Agent Task 排队下一轮 Run | ✅ |
| POST | `/tasks/{task_id}/runs/{run_id}/cancel` | 取消 queued/running/paused/finalizing Run | ✅ |
| POST | `/tasks/{task_id}/runs/{run_id}/resume` | 提交人在回路决策 | ✅ |
| POST | `/tasks/{task_id}/runs/{run_id}/subagents/{subagent_id}/cancel` | 取消子 Agent | ✅ |
| POST | `/tasks/{task_id}/compact` | 请求上下文压缩 | ✅ |
| GET | `/tasks/{task_id}/messages` | cursor 分页读取 durable messages | ✅ |
| GET | `/tasks/{task_id}/events` | 按 `after_sequence` 重放 durable events | ✅ |
| GET | `/tasks/{task_id}/artifacts` | 列出 manifest 注册且已验证的 Artifact | ✅ |
| GET | `/tasks/{task_id}/artifacts/{artifact_id}` | 按 Artifact ID 下载并校验文件 | ✅ |
| GET | `/tasks/{task_id}/builds` | 列出 Task 下的 Build 摘要、RunStatus、BuildResult 与当前 Publication | 🚧 |
| GET | `/tasks/{task_id}/builds/{build_id}` | 单个 Build 的 BuildResult、ValidationResult、Manifest 与当前 Publication | 🚧 |
| POST | `/import/tasks` | 多部分上传 → IMPORT AgentLoop | ✅ |
| GET | `/cache/export` | 全量缓存 ZIP 导出 | ✅ |
| WS | `/ws` | durable events + realtime assistant stream | ✅ |

**API 不变量**：

- 下载只接受 Manifest 注册的 `artifact_id`；
- 客户端不能提交发布阈值或 acceptance policy，只能引用服务端允许的 Profile；
- 主数据通过 `primary_dataset` role 识别，不依赖固定文件名；
- WebSocket 不接受创建 Run 的命令，也不提供 SSE；
- 不安全供应商 URL 返回 422，供应商网络故障返回 502；
- `TrustedHostMiddleware` 仅接受 `127.0.0.1` 与 `localhost`，阻断 DNS rebinding
  页面通过恶意 Host 访问本地设置控制面。

> 决策依据：ADR-005（Manifest 驱动产物访问）。

---

## 16. Skill 仓库与 Subagent

### 16.1 SkillCatalog

业务 Skill 统一由 lifespan 创建的进程级 `SkillCatalog` 管理
（`skills/catalog.py`）。Catalog 合并随应用发布的 builtin Skill 与外部应用数据
目录中的用户 Skill，并通过不可变快照和单调递增 `generation` 原子热更新。正在
执行的单次调用固定到解析时的 Skill 版本；后续调用读取最新快照。

该进程级 Catalog 必须由 lifespan 同时传给 `UserSkillStore` 和
`ModeDispatchRunExecutor`，并继续下传到 Agent 与 Import executor，确保管理面
热更新和后续 Run 使用同一个快照来源。

### 16.2 四类 Skill 组织

```text
backend/app/skills/
|-- builtin/
|   |-- discovery/    # 论文检索、论文理解、关键词扩展与来源方向发现
|   |-- acquisition/  # 检索数据库、获取元数据与下载原始文件
|   |-- processing/   # 本地原始文件解析、清洗、字段对齐与合并
|   `-- analysis/     # 描述性统计、差异分析、富集、网络分析与可视化
`-- learned/          # 默认禁用，不能绕过 Dataset Runtime 与 Validation Gate
```

`SkillCategory` StrEnum：`DISCOVERY` / `ACQUISITION` / `PROCESSING` /
`ANALYSIS`。

Skill 是 instructions 与 Tool 的能力包：

- 一个网站可以有多个 Tool，不要求一个网站一个 Skill；
- 网站 Tool 分为 search、describe/metadata、download；
- download 记录 `DownloadAttempt`，成功校验后才返回 `SourceAsset`；
- processing 只接受成功的本地 `SourceAsset` 或受控 `DataBatch`；
- learned Skill 默认禁用，不能绕过 Dataset Runtime、Compatibility Gate 和 Validation Gate。

### 16.3 Main Agent 工具集

Main Agent 不直接装载全部业务 Tool 或拼接每个 Skill 的 instructions。Agent 只
持有：

- `find_skill` / `invoke_skill` 网关（由 `build_skill_gateway` 构造，绑定
  `SkillCatalog`）；
- `validate_dataset_build_spec` / `execute_dataset_build`：校验并提交自包含
  `DatasetBuildSpec`（V1 确定性 pipeline 已退役，这是唯一正式产物入口）；
- 文件读写工具（`read_file` / `read_file_head` / `search_file` / `write_file` /
  `list_files`）；
- `compress_query_log` / `review_query_strategy`；
- `delegate_research` / `get_subagent_results` / `cancel_subagent`。

用户选择的数据库是 `preferred_sources`：Main Agent 优先使用这些来源，但也可以
探索公开、免登录且不需要私密凭据的其他来源。登录、CAPTCHA、付费、凭据和服务
条款边界仍必须进入 HIL。

Agent 只负责形成 `DatasetBuildSpec` 和必要的来源证据；不能写入发布阈值、不能把
Agent-only Skill 或子 Agent 的自然语言结果作为正式数据，也不能绕过 Spec
Validator、Compatibility Gate、Validation Profile 或 Publisher。

### 16.4 用户扩展

用户扩展支持声明式 JSON/YAML HTTP 数据库包和 Python ZIP Skill 包。用户包保存
在单文件程序之外的可写目录，支持校验、上传、启停、版本回滚和删除。坏包保持
`unavailable/load_error` 管理可见性，不阻断应用启动。设置页的 Model、Databases
和 Skills 三个区段使用对应 REST API 管理这些状态。

### 16.5 托管式 Subagent 与 WorkflowRecipe 闭环

`SubagentSupervisor`（`app/subagents/supervisor.py`）是 lifespan-owned 的运行时
服务。Main Agent 可以在一个父 Run 内并行委派两类子 Agent：

- **SourceResearchAgent**：bounded source-research child agent，只能使用
  DISCOVERY + ACQUISITION Skill，产出来源候选、accession 和经过校验的
  `source_asset_ids`；不能递归委派、调用 Dataset Runtime 或写入正式
  `artifacts/`。失败时返回 `EXTRACTION_FAILED`。
- **SkillBuilderAgent**：bounded acquisition-workflow child agent，使用
  DISCOVERY + ACQUISITION + `create_skill`，只能生成**声明式、非代码**的
  `WorkflowRecipe`；步骤限定为受控 API / HTML / Browser 操作，并拒绝任意代码
  字段。失败时返回 `CAPABILITY_GAP`。

子 Agent 使用独立 SDK Session，`global_limit=4`、`per_run_limit=3`、
`batch_limit=8`、`timeout=3600s`。Supervisor 把 queued、running、progress、HIL、
cancel 和 terminal 状态写入父 Task 的同一 durable event log。

子 Agent 的网络或 Recipe 采集只能写 `staging/subagents/<subagent_id>/`。
`SubagentStagingWorkspace` 校验路径、大小、摘要和元数据后，才把文件原子提交为
不可变 `SourceAsset`，并通过 `SubagentResult.source_asset_ids` 向 Main Agent
暴露轻量引用。

**WorkflowRecipe Acquisition 闭环**：

```text
DRAFT
  -> controlled validation
VERIFIED
  -> 受限试用或 HIL 确认
PROMOTED
  -> 生产 DatasetBuild 可发现和执行
REJECTED
  -> 永不执行
```

生产 Build 只自动发现 `PROMOTED` Recipe；`VERIFIED` 只能在明确受限试用或 HIL
确认后引用。消费链为：

```text
SkillBuilderAgent -> WorkflowRecipe draft -> controlled validation
  -> WorkflowRecipeSourceFetcher -> RecipeExecutor
  -> Workspace validation -> SourceAsset -> SourceAdapter
```

`WorkflowRecipe` 不得产生 Canonical DataBatch、声明跨来源依赖、执行集成、选择
Validation Profile、决定发布，或包含 Python / JavaScript / Shell 等任意代码字段。

**Agent ↔ Dataset Runtime 边界**：Main Agent 使用子 Agent 的结构化结果形成
`DatasetBuildSpec.source_bindings`。正式获取必须由内置 Acquisition Provider 或
受控 WorkflowRecipe 完成；SourceResearchAgent 的资产若要进入正式流程，仍需经过
SourceBinding、SourceAsset 校验和 Adapter 能力检查。正式 DatasetPublication 只
能由 Validation Gate 和 Publisher 产生，子 Agent 完成事件、自然语言结果或
SourceAsset ID 本身不构成发布证据。

### 16.6 视觉证据与图表提取

**视觉证据采集（`web_visual_capture` skill）**：`capture_web_page` 与
`capture_page_section` 调用 RunContext 中由 lifespan 注入的 `CrawlerFacade`，
由共享 `BrowserPool` 完成 Chromium 截图；PNG 和 metadata sidecar 均先进入
`SubagentStagingWorkspace`，通过大小、摘要、路径和链接检查后再 commit 到任务
`source_assets/<asset_id>/`。该 Skill 不允许自行启动 Chromium、创建 HTTP client
或直接写最终截图路径。不出现在 `GET /databases` 列表中，由 Agent 按需调用。

BrowserPool 只保有一个 Chromium，最多同时打开 4 个隔离 BrowserContext。每个
Context 强制 `service_workers="block"`，并使用独立凭据访问 loopback-only HTTPS
CONNECT 代理。代理在实际 CONNECT 层仅解析一次目标域名、拒绝非公网地址并直连该
固定 IP；Playwright route 继续负责 Recipe / source host allowlist。HTTP API /
HTML 请求同样逐 hop 固定 IP、保留原始 Host/SNI、禁用自动重定向并为每次请求使用
独立 transport，避免 DNS rebinding、跨 SNI 连接池复用和私网重定向。

**视觉模型图表数据提取（`extract_chart_data_vlm` skill）**：接受任意获取渠道的
论文产物（PNG/JPG/WEBP/GIF 图片或 PDF 文件）。单一工具入口
`extract_chart_data_vlm(source_path, hint="")` 内部按 MIME 分派：图片直接
base64 送 Qwen-VL；PDF 先用 `pdfplumber` 提取嵌入图片（每文件上限 10 张），再
逐图送 VLM。VLM 客户端在 `agent_loop/vl_model.py` 中独立于 `LazyDashScopeModel`。

**三级降级链**（L1→L2→L3，全部失败抛 `ChartExtractionError`，禁止静默空数据
降级）：

- L1 — Qwen-VL：主路径，要求 `DASHSCOPE_API_KEY`；返回严格 JSON
  `{chart_type, axes, data_points, legend}`；
- L2 — pdfplumber 表格：仅 PDF 触发，提取矢量 PDF 表格数据；
- L3 — caption 文本：兜底，正则提取 `Figure N.` / `Table N.` captions，写入
  `chart_type="caption_only"` 行并发出 `warning`。

产物 `parsed/chart_data/chart_data.csv` + `chart_data_points.csv`（UTF-8 BOM，
Excel 兼容）。每行 `source_asset_id` 将 chart 追溯到原始图片 / PDF。大图（>10MB）
由 Pillow LANCZOS 自动降采样到 1920px 最长边。

> 决策依据：ADR-003（保留可信内核）、ADR-007（Agent 不决定数据值）。

---

## 17. 前端架构

前端已按后端 durable 契约实现为任务工作台，而不是聊天窗口加日志。技术栈：
React 19 + Vite + Tailwind CSS v4 + shadcn/ui，包管理器 pnpm（**never npm**）。

### 17.1 双通道运行时

`frontend/src/runtime/` 实现双通道设计：

- `transport.ts`：`AgentEventTransport` 处理 WebSocket 收帧、rAF 批量刷新、自动
  重连携带 durable watermark；
- `controller.ts`：`RuntimeController` 拥有 transport 生命周期，在 snapshot /
  accepted-Task handoff 时使用 REST `/events` 重放；
- `reducer.ts` 与 `reducers/`：纯 reducer 把事件投影到 store；
- `types.ts`：`ConversationItem` 联合类型等。

| 通道 | 帧类型 | 处理 |
| --- | --- | --- |
| Durable events | `EventEnvelope`（schema 1.0/2.0，单调 `sequence`） | `applyEvent` |
| Realtime assistant stream | `assistant_stream_delta` / `assistant_stream_end` | `applyAssistantStreamFrames` |

Pending stream 帧上限 `MAX_PENDING_ASSISTANT_STREAM_FRAMES = 2048`，rAF 批量
flush；`tool_started` / `run_finalizing` / Run 终态等边界事件强制 flush。

### 17.2 对话流（Coding Agent 风格）

对话主流使用"按时间顺序交错的步骤流"，所有事件类型统一投影到 `ConversationItem`
列表，按 `sequence` 升序渲染。

| kind | 来源事件 | 渲染组件 | 默认状态 |
| --- | --- | --- | --- |
| `user_message` | `MessageRecord(role=user)` hydrate | `UserMessageBubble` | 右对齐气泡 |
| `assistant_segment` | `assistant_delta`（按 `stream_id` 分段） | `AssistantSegment` | 展开，流式时末尾光标 |
| `reasoning` | `assistant_reasoning_delta`（按 tool call 分段） | `ReasoningBlock` | 折叠；流式时展开 |
| `tool_call` | `tool_started` + `tool_completed` | `ToolCallStep` | 折叠；running Spinner |
| `operation` | `operation_started/completed/failed`；迁移期兼容 `stage_*` | `OperationStep` | 展开（紧凑单行） |
| `progress` | `operation_progress`；迁移期兼容 `stage_progress` | `ProgressStep` | 展开（同 operation 原位更新） |
| `warning` | `warning` | `WarningStep` | 展开（黄色） |
| `artifact` | `artifact_produced` | `ArtifactStep` | 展开（含大小 Badge） |

`itemId` 规则保证按工具调用分段、同 operation 共用项、同 kind progress 原位更新。
`run_queued` / `user_input_required` / `user_input_resumed` /
`conversation_compacted` / `plan_ready` / Run 终态事件**不创建 item**，分别由
ChatPanel 草稿态、`pendingUserInput` + UserInputDialog、状态条分隔符处理。

`toolLabels` 映射 `toolName + arguments` → `{ verb, target, details? }` 三元组，
状态条与 ToolCallStep 复用同一映射。

### 17.3 结果展示

`ResultsViewer.tsx` 当前动态读取 CSV 头与行（`Papa.parse`，预览前 100 行），
**不硬编码 22 列 Schema**。V2 迁移后先读取 `BuildResult`、
`current_publication_id` 和 `dataset_manifest.json`，再识别主数据与辅助表，
按数据族选择结果 Tab 与列渲染策略。界面必须显式展示 family、
row granularity、有效行数、来源覆盖、Validation 状态、confidence 分布、
provenance 覆盖率，以及 `PARTIAL_SUCCESS` / `NO_DATA` 的原因。

启动时并发加载数据库、后端历史分页和 WebSocket，但保持 `activeTaskId=null`，
展示独立的新研究草稿；后续历史通过 cursor 加载并按不可变
`(created_at DESC, task_id DESC)` 排序去重。

`tasksById` 中每个 Task 都有独立的 Run、message、activity、artifact、fixture
stage、`subagentsById`、`subagentOrder` 和 `lastSequence` 投影。桌面端右侧
`ResizablePanel` 展示子 Agent 工作区，移动端复用 Sheet；产物入口位于聊天输入区
FAB。

Assistant 文本采用 realtime / durable 双投影：实时 chunk 按
`(run_id, stream_id, chunk_index)` 进入 pending，durable `assistant_delta` 的
chunk 范围推进 confirmed watermark 并移除已确认 pending。durable 先到、实时帧迟
到或重放重复时都按该 watermark 去重，因此在线文本与断线重放后的最终文本收敛
一致。

> 决策依据：ADR-005（Manifest 驱动）、ADR §21.10（测试锁定不变量而非顺序）。

---

## 18. 迁移策略：绞杀模式

V2 采用**绞杀模式（strangler）**，不做一次性重写。原因：V1 Pipeline 有大量可
靠性测试和复杂恢复语义，大爆炸重写风险高，且容易丢掉比业务流程更成熟的基础
设施。

### 18.1 迁移步骤

1. **冻结 V1 特征并加入 V2 契约**：新增自包含 `DatasetBuildSpec`、
   `DatasetSchema`、`DataBatch`、`BuildResult`、`ValidationResult`、
   `DatasetPublication`、`dataset_manifest.json`、Schema Registry 和 Validation
   Profile；不新增正式 `DatasetRequest` 或数据集级 `BuildRecipe`；
2. **旧入口作为兼容 facade**：`run_research_pipeline` 内部逐步构造
   `DatasetBuildSpec` 并调用 `validate_dataset_build_spec` / `execute_dataset_build`；
3. **抽取可信执行内核**：把 SourceAsset、DownloadAttempt、Attempt digest、event、
   checkpoint、Validation Gate 和原子发布从固定 Stage 语义中抽出；
4. **实现固定 DatasetBuildExecutor**：执行 acquire、parse、canonicalize、
   compatibility、integrate、validate、publish，不公开自由 BuildStep；
5. **补齐 WorkflowRecipe Acquisition 闭环**：生产只自动发现 `PROMOTED`，受限使用
   `VERIFIED`，`WorkflowRecipeSourceFetcher` 通过 RecipeExecutor 产出
   SourceAsset，SourceBinding 再交给 Adapter；
6. **先迁 GDC / Xena，后迁 GEO**：先完成表达数据 V2 闭环；GEO 在平台映射、probe
   mapping、尺度和归一化兼容性完成后迁移；
7. **状态与发布双轨迁移**：前端和 API 同时支持 V1 状态及 V2 的 RunStatus、
   BuildResult、ValidationResult 和 Publication；不引入
   `validated_intermediate/final`；
8. **前端和缓存双轨**：结果页同时支持 V1 固定包与 V2 Manifest；缓存按 V1 固定
   Schema 和 V2 Schema / 构建参数身份双轨，旧 `main_data.csv` 包装为
   `gene_expression.long.legacy.v1`；
9. **达到验收门槛后删除 Legacy**：V2 闭环通过四种必测结果（见 §21）后，删除固定
   五阶段、固定 22 列、来源组合 allowlist、单一通用 Validator 和 metadata-only
   占位路径。

### 18.2 迁移期不变量

- V1 与 V2 不能在同一 Run 内混用：一个 Run 要么走 V1 facade，要么走 V2 Runtime；
- V2 发布必须带 `dataset_manifest.json` 和不可变 Publication；V1 产物保留旧
  `run_manifest.json`；
- 内容寻址 `SourceAsset.asset_id` 在 V1 / V2 间相等当且仅当字节相等；
- Agent 不能控制发布阈值；
- 生产 DatasetBuild 只能自动执行 `PROMOTED WorkflowRecipe`；
- 测试同时锁定 V1 可靠性不变量和 V2 单族单粒度、状态正交、Profile 门禁、
  Artifact Role 与 Publication 不变量。

### 18.3 不立即删除历史 Review

历史 Review 与 Survey 记录问题演进，不立即删除。已推翻结论标记
`superseded by ADR-xxx`。每个重大边界变化新增 ADR，不在 Prompt 或 TODO 中悄悄
改变。TODO 只记录执行任务，不承担长期架构解释。

> 决策依据：ADR-016、ADR §26（文档治理）。

---

## 19. 顶层不变量

后续设计和代码评审必须检查以下不变量：

1. 一个主数据集只有一个 family；
2. 一个主数据集只有一种 row granularity；
3. 正式领域契约直接从自包含 `DatasetBuildSpec` 开始，不引入重复的
   `DatasetRequest`；
4. Dataset Runtime 使用服务端固定构建骨架，不新增数据集级 `BuildRecipe`；
5. 主数据记录必须来自真实来源或可复算确定性派生；
6. Agent 不能直接制造科研值；
7. Agent 不能提交发布阈值或放宽 acceptance policy；
8. 无 SourceAsset / locator 的来源值不得作为高可信正式记录；
9. 合并前必须通过 Compatibility Gate；
10. 字段名相似不等于语义相同；
11. 单位、尺度和归一化状态不得静默丢失；
12. metadata 不能冒充 measurement；
13. 空主数据不能产生 `SUCCEEDED` BuildResult；
14. `NO_DATA` 必须有明确用户输出；
15. 部分成功必须列出失败来源；
16. Validation 失败不得发布；
17. 发布必须原子且生成不可变 Publication；
18. 旧 Publication 不因新版本发布而改变状态；
19. 任何已发布数据都能定位到构建版本和处理版本；
20. fixture 不能伪装 live；
21. 置信度必须可解释；
22. 复合需求需要拆分或显式关系模型；
23. 新来源接入不应修改多个数据库组合分支；
24. `WorkflowRecipe` 只负责 Acquisition，生产自动执行必须为 `PROMOTED`；
25. `RunStatus`、`BuildResult`、`ValidationResult` 和 `DatasetPublication` 不得
    相互替代；
26. 前端不得通过错误字符串或 Artifact 数量推断业务状态。

---

## 20. 代码评审检查表

新增数据源或数据类型时，先逐项对照 §19 顶层不变量，再回答：

- 它产生哪种 dataset family？
- 一行代表什么，即 row granularity 是什么？
- 源 Schema 与 Canonical Schema 分别是什么？
- 主键是什么，冲突和重复如何处理？
- 单位、尺度和归一化状态是什么？
- 字段映射证据来自哪里？
- 与哪些已有 DataBatch 兼容？
- provenance 和 confidence 到什么粒度？
- Validation Profile 是什么，阈值由哪个服务端版本管理？
- Acquisition 使用内置 Provider 还是 `PROMOTED WorkflowRecipe`？
- 无数据时返回什么？
- 是否会在其他模块新增来源特例？若是，抽象可能仍不正确。

---

## 21. Demo 决策

### 21.1 主案例

`gene_expression` 数据集构建。

### 21.2 来源优先级

GDC、Xena 优先；GEO 在完成平台、probe mapping、尺度和归一化兼容性后加入
（迁移顺序见 §18.1 步骤 4）。

### 21.3 PubMed 角色

- 发现相关研究和 accession；
- 说明数据选择依据；
- 提供来源关系；
- **不作为表达主表行**。

### 21.4 Reactome 角色

独立 `pathway_member` 数据集族，用于证明系统可扩展到第二个 Schema，**不与表达
数据合并**。

### 21.5 必测四种结果

1. **成功**：两来源兼容并合并，发布 DatasetPublication；
2. **部分成功**：一个来源失败但另一个有效，且 Profile 允许发布；
3. **无数据**：来源不适合或无目标记录，返回 `NO_DATA`，不生成假表；
4. **执行失败**：文件损坏或 Parser 异常，`RunStatus=FAILED`，不产生 BuildResult，
   也不发布。

### 21.6 V1 固定真实验收案例（参考）

Phase 1 固定案例仍可作为 V1 闭环回归基线：

- Topic：`breast cancer gene expression under Hsp70 inhibition`；
- PubMed：PMID `34180400`；
- GEO：`GSE178352`；
- 样本数：12；
- 处理后计数文件：`GSE178352_tximportCounts.txt.gz`（4,597,797 bytes，SHA-256
  `71e78e43fbd0db021c243feb8d935850d2c95bbfeba884d42f6dd78bfa753a55`）。

默认测试使用记录来源与裁剪范围的真实 fixture；标记为 `live` 的集成测试下载完
整官方文件并验证 checksum、样本标识和解析兼容性。Mock Demo 仅作为开发烟雾测
试，不能满足正式验收，也不能在真实流程失败后自动转为成功。

> 决策依据：ADR §24（推荐 Demo 决策）。

---

## 22. 待决问题

以下问题不阻塞第一阶段，但需在实现中形成新 ADR：

### 22.1 主数据文件格式

Demo 使用 CSV；大数据内部是否使用 Parquet，发布是否同时提供 CSV，需要评估内
存、速度和用户可用性。

### 22.2 批次级与记录级 confidence 的继承规则

§11.2 已定"确定性 API 可批次级默认、VLM/LLM 抽取需记录级"。待定的是批次默认
值何时被记录级判定继承或覆盖，以及前端如何呈现。

### 22.3 Provenance sidecar 格式

CSV、JSONL 或 Parquet 的选择需考虑可读性、规模和查询效率。

### 22.4 多 Build 会话模型

一个用户任务是否直接拥有 `builds[]`，还是每次续聊产生独立 Run / Build，需要结
合现有 Runtime 数据模型决定。

### 22.5 GDC 与 Xena 镜像数据去重

两者可能呈现同一上游 TCGA 数据。需要明确 source-of-record、版本差异和重复规
则，不能把镜像当独立证据数量。

### 22.6 聚合粒度

用户有时需要 cohort-level 汇总，而现有表达长表是 gene-sample。应通过版本化 aggregation profile 或 deterministic operator 生成另一个 Schema，不能在同表混合。

### 22.7 人工确认点

字段映射、低置信图表值和单位转换哪些必须触发 HIL，需要按 Demo 交互成本确定。

---

## 23. 非目标

- 替换 OpenAI Agents SDK；
- 通用 Workflow Engine 或完整 DAG 引擎；
- 正式 `DatasetRequest` 中间契约；
- 数据集级 `BuildRecipe` 或 Agent 自由生成 nodes / edges；
- 包含 Python、JavaScript、Shell 等任意代码的 WorkflowRecipe；
- 由模型直接生成可进入生产执行的 Python Skill；
- Agent 或 learned Skill 绕过 Spec Validator、Compatibility Gate、Validation
  Profile 或 Publisher；
- 允许 Agent 在 BuildSpec 中设置 `minimum_valid_rows`、
  `allow_empty_primary_dataset` 等 acceptance policy；
- 将 mock 产物当作正式案例；
- 自动生成缺乏数据依据的科研或临床结论；
- 把“多角度研究包”作为同一 DatasetBuild 的主数据；
- 用 warning 解释空主数据；
- 使用 `validated_intermediate` / `validated_final` 等可变 Artifact 状态；
- 通过 Artifact 数量或错误文本判断运行成功；
- 只靠 Prompt 修正架构（Prompt 只保留意图层原则，稳定规则进入契约和服务端
  Validator）；
- 后端事件、BuildResult、Manifest 和 Publication 契约稳定前重写前端。

受控、声明式、非代码的 Acquisition `WorkflowRecipe` **属于目标范围**，但只能由
可信 `RecipeExecutor` 执行并产出 `SourceAsset`。

> 决策依据：ADR §19（被否决或修正的方案）。

---

## 24. 文档治理

### 24.1 文档权威性矩阵

| 主题 | 权威文档 | 状态 |
| --- | --- | --- |
| 系统架构（是什么 / 怎么组织 / 约束） | `docs/ARCHITECTURE.md`（本文） | V2 目标，权威 |
| 架构决策（为什么） | `docs/BioMed-QAgent_Architecture_Decisions_and_Lessons.md` | ADR 索引，权威 |
| V2 实现规格 | `docs/BioMed-QAgent_Pipeline_Refactor_Design.md` | 实现基线，权威 |
| V1 架构（历史现状） | `docs/legacy/ARCHITECTURE_V1.md` | Legacy，仅参考 |
| 执行任务 | `docs/TODO.md` | 任务清单，不承担架构解释 |
| 赛题背景与评分 | `PROBLEM.md` | 外部约束，权威 |
| Agent 通用规则 | `AGENTS.md` | 工作流约束，权威 |

### 24.2 不重复规则

- **一个概念一处权威**：每个架构概念只在本文定义权威表述；其他文档引用本文而
  不复述。
- **历史 Review 与 Survey 不作为现行架构依据**：已推翻结论必须标注
  `superseded by ADR-xxx`。
- **TODO 不承担架构解释**：TODO 只记录执行任务，长期架构解释必须进入本文或新
  ADR。
- **Prompt 不承担 Workflow Engine 职责**：稳定规则进入契约和服务端 Validator；
  Prompt 只保留意图层原则（见 ADR §21.8 踩坑）。

### 24.3 ADR 流程

每个重大边界变化必须新增 ADR，不在 Prompt 或 TODO 中悄悄改变。ADR 形成后同步
修订本文相关章节，并在本文顶部元数据更新 `Last Verified`。本文与代码现状矛盾
且未标注为待落地时，标记 `stale` 并在下一里程碑修复。

### 24.4 新增数据族 / 来源的最小文档要求

新增数据族或来源时，必须更新：

1. 本文 §3.2（数据族与行粒度）、§7（来源能力）、§10（Validation Profile）、
   §16（Skill 仓库）相关章节；
2. 对应 ADR（若涉及边界变化）；
3. `docs/TODO.md` 的执行任务条目；
4. Schema Registry 与 Validation Profile 注册条目。

### 24.5 防止再次走偏的简短规则

开始设计任何新功能前，先回答三句话：

1. 用户最终要下载和分析的主数据是什么？
2. 主表一行代表什么？
3. 新来源提供的记录能否在科学语义上进入这张表？

如果第三问答案不明确，就先保持独立、补充映射证据或拆成另一个 Build，**而不是
先写合并代码**。

---

## 附录 A：被否决或修正的方案

| 方案 | 处置 | 原因 |
| --- | --- | --- |
| 正式 `DatasetRequest` 契约 | 否决 | 与 `DatasetBuildSpec` 语义重复，无独立生命周期、行为或消费方 |
| 数据集级 `BuildRecipe` | 否决 | 与现有 `WorkflowRecipe` 命名和生命周期冲突，重新制造通用编排层 |
| 完整 Research DAG | 否决作为当前核心架构 | 过重、偏离评分、缺少必要场景、Agent 生成图不可靠 |
| Acquisition `WorkflowRecipe` | 保留并收窄 | 只描述受控来源获取，由可信解释器执行并只产出 SourceAsset |
| 多角度 Artifact Package 作为主产品 | 修正 | 可同时存在于一次科研会话，但不应成为同一 DatasetBuild 的同一主数据 |
| 删除全部 Pipeline | 否决 | 会丢失 SourceAsset、Attempt、digest、恢复、Validation 和原子发布 |
| 固定五阶段继续增加组合分支 | 否决 | 短期能接新来源，长期形成指数级状态组合和跨层硬编码 |
| 万能 22 列 Schema | 否决作为全局 Schema | 可作为历史表达 Schema 或表达数据族一个版本保留 |
| `validated_intermediate/final` | 否决 | 混淆 Artifact 验证、Run 结果和当前版本；改用正交状态与 Publication 指针 |
| 发布门禁固定实现清单 | 修正 | 架构层只保留 provenance closure、Profile passed、atomic promotion |
| 辅助产物固定文件清单 | 修正 | Manifest 只定义 Artifact Role，物理文件属于 Publisher 实现 |
| 用 warning 解释空主数据 | 否决 | Warning 不能改变“主表没有目标科学记录”的事实 |
| Agent 设置 acceptance policy | 否决 | 发布阈值和部分成功规则属于服务端版本化 Validation Profile |
| 只靠 Prompt 修正架构 | 否决 | Prompt 不能替代服务端契约、兼容性门禁和发布规则 |
| 通过 Artifact 数量判断运行成功 | 否决 | 应使用 RunStatus、BuildResult、ValidationResult 和 Publication |

> 完整决策记录见 [BioMed-QAgent_Architecture_Decisions_and_Lessons.md](BioMed-QAgent_Architecture_Decisions_and_Lessons.md) 的 §19（被否决或修正的方案）。
