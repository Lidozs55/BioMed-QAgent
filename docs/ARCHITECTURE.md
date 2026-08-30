
# BioMed-QAgent 架构

> **文档元数据**
>
> - **受众**：所有在本仓库工作的 agent 与工程师；前端、后端、测试、运维评审。
> - **权威性**：本文是系统架构的**单一权威入口**（source of truth）。
>   任何与本文矛盾的实现都视为缺陷；任何架构变更必须先修订对应章节或新增 ADR。
> - **职责分工**：本文回答“系统是什么、怎么组织、约束是什么”。全仓文档职责与
>   生命周期见 [文档地图](README.md)，决策原因见 [ADR 索引](adr/README.md)，
>   当前工作见 [TODO.md](TODO.md)，能力现状见 [FEATURES.md](FEATURES.md)。
> - **实现状态**：迁移 Phase 0-9 已完成；显式 `in_process_unisolated` Family Host/Core
>   publication chain 已形成稳定 `main` 基线。唯一正式拓扑为
>   TypeScript Host 权威实现 formal `/api/v1`、durable Task/Run/Event、模型设置、
>   product API 与 TS Dataset Core；Agent = Pi（`server/src/agent/pi-adapter.ts`）。
>   legacy FastAPI / Python Core / experimental Pi / rollback feature flags 已全部
>   物理删除（`backend/` 不复存在）；Python 进程边界只剩按需启动的
>   `database/bridge.py`（JSONL named-op persistence）。
> - **验证与失效**：每个里程碑、每次新增/修订 ADR、数据族接入或执行模型变化
>   时对照本文校验一致性；与代码现状矛盾且未标注待落地、或被新 ADR 推翻而未
>   同步修订时，本文标记为 `stale`。
> - **最后验证（Last Verified）**：2026-08-29（对照 `main@8d174f1a`，重点复核 family 清单、API 路由与前端组件名）。
> - **交叉引用约定**：本文档章节写作 `§N`；引用 ADR 索引的章节写作 `ADR §N`。

---

## 架构章节地图

本表只索引架构章节；产品、操作、计划、证据与历史文档统一由
[文档地图](README.md) 导航。章节编号在拆分后保持原样（如 §14.2 位于
`runtime-events.md`）。

| 章节 | 主题 | 位置 |
| --- | --- | --- |
| §1-§3 | 产品定义 / 架构总览 / 核心抽象 | 本文 |
| §4-§8, §20 | 可信执行内核 / 执行模型 / 职责边界 / 来源能力 / 字段映射 / 代码评审检查表 | [architecture/dataset-execution.md](architecture/dataset-execution.md) |
| §9-§13 | 运行状态 / Validation / 置信度 / 溯源 / 缓存 | [architecture/result-validation.md](architecture/result-validation.md) |
| §13A | Canonical Evidence Product Layer（语义产品层） | [architecture/canonical-evidence.md](architecture/canonical-evidence.md) |
| §14-§15 | Durable Runtime / API 面 | [architecture/runtime-events.md](architecture/runtime-events.md) |
| §16-§17 | Skill 仓库与 Subagent / 前端架构 | [architecture/agent-frontend.md](architecture/agent-frontend.md) |
| §18, §21-§23, 附录 A | 迁移历史 / Demo 决策 / 待决问题 / 非目标 / 被否决方案 | [architecture/roadmap.md](architecture/roadmap.md) |
| §19 | 顶层不变量 | 本文 |
| — Skill 自生成/自迭代 | 流程固化 + 可拆卸工具包 + 自迭代闭环 | [architecture/skill-self-iteration.md](architecture/skill-self-iteration.md) |
| §24 | 架构文档更新规则 | 本文 |
| — FamilySpec/Core + dynamic transform | 显式 `in_process_unisolated` production route；不是sandbox/安全边界；Core仍独占B3/assessment/publication | [architecture/FAMILY-HOST-03-execution-constraints.md](architecture/FAMILY-HOST-03-execution-constraints.md) + [ADR-039](adr/039-family-transform-host.md) |
| — 缓存设计 | Cache 契约、Schema 标识与构建参数 | [architecture/result-validation.md](architecture/result-validation.md) §9-13 + [ADR-015](adr/015-cache-schema-build-parameters.md) |
| — 模型供应商参数 | 供应商/模型参数与目录事实（现行 TS `server/src/settings/model-registry/`） | [architecture/model-provider-params.md](architecture/model-provider-params.md) |
| — 运行限制 | 运行时资源上限与设置契约 | [architecture/runtime-limits.md](architecture/runtime-limits.md) |
| — HIL 审批档位 | 三档审批权限分配与大模型初审（人工审批 / llm_pre_review / auto_approve） | [architecture/hil-approval-policy.md](architecture/hil-approval-policy.md) |
| — 测试并发预算 | 本地有界并发、CI 放宽与 worker 预算 | [architecture/test-concurrency.md](architecture/test-concurrency.md) |

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
dataset requirement（见 §3）。一次 Run 可执行多个 requirement；每个 requirement
独立验证，且只有满足产品门禁的结果才产生 Publication。

> 决策依据：ADR-001（产品边界）、ADR-002（单族单粒度）、ADR-006（辅助数据）。

---

## 2. 架构总览

系统采用**双层结构：Agent + Dataset Construction Runtime**。Agent 负责意图解析、
来源发现和规格生成；Runtime 负责确定性获取、解析、归一化、兼容性判断、合并、
验证、置信度、溯源和原子发布。

```text
React/shadcn Frontend
        |
        | one public HTTP/WebSocket port
        v
TypeScript Application Host
        +-- Vite middleware / HMR
        +-- /api/v1/tasks* + /api/v1/ws -> TS durable runtime
        +-- settings / model-registry / databases / cache -> native TS APIs
        |
        +--------------------------+-----------------------------+
        |                          |                             |
        v                          v                             v
Pi Main Agent              TypeScript Dataset Core      TS DB client
governed Workspace         deterministic operations          |
        |                          |                           v
        +--------------------------+                  database/bridge.py
        | DatasetExecutionSpec                        (named operations)
        v
Dataset Construction Runtime（服务端固定构建骨架）
        | \
        |  `-- reject -> typed execution error + RunSummary
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
                 `-- ProductAssessment + server-generated RunSummary
```

方括号步骤可以按来源并发；fan-out / fan-in 属于 Runtime 内部控制流，不形成 Agent
可编排 DAG，也不形成数据集级 Recipe。

**Host 启动边界**（ADR-042）：Host 首选配置端口（默认 5173），只有实际绑定返回
`EADDRINUSE` 时才以 `port 0` 让操作系统原子选择可用端口；实际入口由启动日志
`BIOMED_QAGENT_URL` 公布。`pnpm start` / `--static` 在端口与资源初始化前持有每用户
生产实例租约，第二次启动正常退出且不创建 Host；开发模式不持有产品级租约，但同一
data root 的 durable writer 独占租约在所有模式下仍然生效。

**可靠性内核**（见 §4）：SourceAsset、DownloadAttempt、内容 hash、
Attempt 输入/参数/输出摘要、任务锁、checkpoint、timeout/cancel、durable event、
durable evidence-bound HIL、staging、Validation Gate、原子发布、fixture/live 区分。

**Agent 边界**（ADR-026）：Agent 的工作目录是 `data/workspaces/<taskId>/`，
与框架输出 `data/output/tasks/<taskId>/` 物理分离；Workspace 之外的所有文件访问与
命令执行都经过 `allow / ask / deny` 权限系统（fs.read/write/edit、process.exec），
`ask` 挂起单个 Tool Call 等待用户批准（`permission_requested` / `permission_resolved`
durable events + `POST .../permissions/{requestId}`）。正式 Publication 只由
Dataset Core 产生并以 manifest + hash 验证——权限放开不改变业务可信边界。
权限 scope 含 `framework_internal`（`data/settings/**`、其他 Task 的 workspace/output）与
`sensitive`（`.env*`/密钥/凭据文件），对所有能力硬拒绝/独立策略，任何授权/规则/preset
均不能覆盖（ADR-026 §2）。持久路径规则绑定 `resource_scope`（请求 scope 必须等于规则
scope 才匹配，API 缺省 project）；Restricted 切换会作废全部 pending 并清空全部临时
授权；Run 结束时经 `onRunEnd` 清理该 run 的 grants。Run/Task 文件授权以批准路径为根
（canonical root + 子树），不覆盖整个 scope（ADR-026 §2）。

当前不存在固定五阶段、固定 22 列 `main_data.csv` 全局协议或 metadata-only
占位主表：dataset requirement 由自包含 `DatasetExecutionSpec`（§3）驱动，产物由
`DatasetManifest` 按 Artifact Role 声明。

> 决策依据：ADR-003（保留可信内核）、ADR-004（服务端固定构建骨架，不引入完整 DAG 或 BuildRecipe）。

---

## 3. 核心抽象

### 3.1 DatasetExecutionSpec（自包含）

`DatasetExecutionSpec` 是 Agent 在意图解析和来源发现后生成、提交给 Runtime 的**单一
权威输入契约**。它同时表达用户语义和受控构建参数，至少包含：

- `dataset_family`：数据集族标识（如 `gene_expression`、`gut_microbiome`）；
- `row_granularity`：行粒度定义（如 "基因 × 样本 × 测量"）；
- `schema_ref`：目标 Schema 的注册引用（见 §3.3）；
- `required_fields`：必需字段清单；
- `source_bindings`：每个来源的 SourceBinding（来源、获取方式、Adapter、
  accession/参数）；获取方式只能是 `builtin` 或 `workflow_recipe`；
- `normalization_profile_ref`：归一化 Profile 引用；
- `merge_strategy`：服务端允许的显式合并策略；
- `validation_profile_ref`：Validation Profile 引用；
- `output_format`：发布格式偏好。

生产可选值由 `DatasetFamilyRegistry` 统一登记。每个
`DatasetFamilyDefinition` 将 Canonical Schema、row granularity、真实来源 Adapter、
source/schema 与 schema/profile 兼容关系、family-owned 默认 Normalization Profile、
合并策略、输出格式和 Adapter 参数契约绑定为一个受信任 admission 能力单元。多表 family 的 assembler
通过独立 handler registry 注册；缺 handler 时不能构造 assembly capability。Core-only
`PublicationCandidate` 只引用 committed Core result receipts 和 registered asset IDs，
不接受 Agent path。runtime/checkpoint/publisher 与 derive 接线已随 TS Dataset Core 落地（原
TASK-048-B2W/B6W 跟踪项已闭环）；基础 Registry 仍不能据此伪装未闭环 family 已实现。Agent Tool Schema 与 Core Spec Validator 从同一 Registry 派生；production Registry 还要求
family `runtime_id` 命中 Core 已实现的 runtime allowlist。仅有 Schema、或 Adapter/Profile
无真实实现的数据族不得进入 production default Registry（ADR-027）。

不建立正式 `DatasetRequest` 契约。自然语言解析过程中可以使用 Agent 内部的
`ParsedDatasetIntent`，但它不进入持久化、API 或执行协议，避免
`DatasetRequest -> DatasetExecutionSpec` 两个对象之间重复、漂移和跨引用读取。

### 3.2 dataset_family 与 row_granularity

一个 dataset requirement 的主数据必须满足以下四元组均明确且兼容：

```text
dataset_family + row_granularity + key_semantics + measurement_semantics
```

**可以合并**的示例：

- 多来源 gene-sample expression；
- 多论文中采用同一指标和同一对象粒度的实验测量；
- 多数据库的基因-疾病关联记录。

**不能直接合并**的示例：

- 表达行与突变事件行；
- 基因-样本测量与队列聚合统计；
- 文献元数据与表达测量；
- 通路节点与临床样本；
- 原始 count 与 TPM，除非明确转换或保持可区分语义。

`row_granularity` 不是字符串标签，而是结构化定义：一行代表什么实体、什么测量、什么
时间或条件维度。任何"合并"设计必须先写出一行代表什么，再讨论字段对齐。

### 3.3 Canonical Schema 与 Schema Registry

**Schema Registry** 是数据族规范 Schema 的版本化注册中心。每个注册的 `DatasetSchema`（即 Canonical Schema）声明：

- Schema 标识与版本；
- dataset family 与 row granularity；
- 字段集、类型、约束和语义角色；
- 主键与外键语义；
- 单位、尺度、ontology / vocabulary 规范；
- derivation policy；
- 与历史 Schema 的兼容性关系。

22 列表达长表不再是全局协议；新数据族通过完整
`DatasetFamilyDefinition`（其中包含注册 Schema）接入，不修改其他数据族的 Schema
或共享分支，也不能只注册 Schema 就宣称该 family 可执行或可发布。

Schema Registry 是字段元数据的唯一权威来源，不在 Builder / Validation / API /
前端多处分散定义。跨 family 的 biomedical common table 由
`server/src/dataset/schema/common/` 的参数化模板生成 family-scoped Schema 2.0；模板本身
不进入 production Registry，也不代表对应 family 已具备执行或发布能力（ADR-034）。

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

一个 requirement 只有一个主数据集族和一种行粒度。Manifest 只定义五类稳定角色：

- `primary_dataset`：本次 requirement 的核心标准数据集；
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

- Run/requirement identity、版本和 Manifest digest；
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

## 19. 顶层不变量

后续设计和代码评审必须检查以下不变量：

1. 一个主数据集只有一个 family；
2. 一个主数据集只有一种 row granularity；
3. 正式领域契约直接从自包含 `DatasetExecutionSpec` 开始，不引入重复的
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
13. 空主数据不能产生 Publication；
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
25. `RunStatus`、`OperationResult`、`ProductAssessment`、`ValidationResult` 和 `DatasetPublication` 不得
    相互替代；
26. 前端不得通过错误字符串或 Artifact 数量推断业务状态。

---

## 24. 文档治理

全仓文档类型、生命周期、归档和不重复规则统一由 [文档地图](README.md) 维护，
本文不复制该矩阵。架构侧额外遵循：

- 重大边界变化必须新增 ADR，不能在 Prompt、TODO 或实现笔记中悄悄改变；
- ADR 接受或替代后同步本文及对应 `architecture/` 章节，并更新顶部 `Last Verified`；
- 与代码矛盾且未标注待落地的章节应立即标为 `stale` 并登记修复；
- Prompt 只表达意图层原则，稳定规则进入 contracts、Core 或 versioned policy。

### 24.1 新增数据族 / 来源的最小文档要求

新增数据族或来源时，必须更新：

1. §3.2（数据族与行粒度）、§7（来源能力）、§10（Validation Profile）、
   §16（Skill 仓库）相关章节（位置见上文文档地图）；
2. 对应 ADR（若涉及边界变化）；
3. 仍有开放工作时更新 `docs/TODO.md`；
4. Schema Registry 与 Validation Profile 注册条目。

### 24.2 防止再次走偏的简短规则

开始设计任何新功能前，先回答三句话：

1. 用户最终要下载和分析的主数据是什么？
2. 主表一行代表什么？
3. 新来源提供的记录能否在科学语义上进入这张表？

如果第三问答案不明确，就先保持独立、补充映射证据或拆成另一个 Build，**而不是
先写合并代码**。
