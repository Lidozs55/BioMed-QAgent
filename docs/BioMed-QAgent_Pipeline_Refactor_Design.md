# BioMed-QAgent 数据集构建 Pipeline 重构设计 V2

> 文档状态：V2 提案，替代同名 V1，作为下一阶段实现基线  
> 代码基线：用户提供的 `BioMed-QAgent-main.zip`，审计日期 2026-08-06  
> 适用范围：后端 Agent、Pipeline、WorkflowRecipe、数据契约、缓存、事件、前端结果展示与测试迁移  
> 目标：将当前固定五阶段、固定数据库组合、固定 `main_data.csv` 结构，重构为面向同类科学数据检索、标准化与整合的可信数据集构建系统  
> V2 重点：删除冗余 `DatasetRequest` 与 `BuildRecipe`，明确 Run、BuildResult、Validation 和 Publication 的正交边界

---

## 1. 执行摘要

当前 BioMed-QAgent 已经具备一套较完整的可信执行基础设施：任务隔离、下载审计、内容摘要、阶段恢复、取消和超时、事件持久化、Validation Gate、原子发布、SourceAsset 血缘、前端事件重放等。这些能力与赛题要求高度一致，不应推翻。

当前主要问题不是“缺少 Pipeline”，而是 **Pipeline 的中心契约错误**：系统以固定五阶段和固定 22 列 `main_data.csv` 作为全局协议，再用数据库组合分支适配不同任务。随着 GEO、GDC、Xena、Reactome、文献和图表提取能力增加，代码逐步演化成数据库组合状态机，最终出现以下问题：

1. Agent 规划研究方向，而 Pipeline 只接受少量硬编码组合，二者能力不对称；
2. `TaskSpecification` 描述“查哪些来源”，却没有定义“构建哪类数据集”；
3. 不同语义数据被迫迁就表达数据 22 列主表；
4. GEO 无表达矩阵时，系统用样本元数据行填充表达表，避免空表，造成“结构成功、科研内容为空”；
5. 字段对齐主要依赖列名字符串相似度，缺少数据集族、行粒度、单位、键语义和测量语义校验；
6. Runtime 将“没有 artifact”直接等价为运行失败，无法区分无数据、部分成功、规格拒绝和执行异常；
7. 前端、缓存、事件和测试均锁定固定五阶段与 `main_data.csv`，使局部修补成本持续增加。

本设计建议：

> 保留可信执行内核，将 Pipeline 重构为 **数据集契约驱动的 Dataset Construction Runtime**。每次构建只对应一个主数据集族、一种行粒度和一套明确合并语义。Agent 负责理解需求、拆分复合请求、发现来源并直接生成自包含的 `DatasetBuildSpec`；服务端负责下载、解析、归一化、兼容性判断、合并、校验、置信度、溯源和原子发布。

不引入完整 DAG 引擎，也不新增与现有 `WorkflowRecipe` 重叠的 `BuildRecipe`。Dataset Runtime 使用服务端固定、可测试的构建骨架：来源获取可以 fan-out，随后统一 fan-in 至规范化、兼容性检查、集成、Profile 验证和原子发布。现有 `WorkflowRecipe` 只用于受控获取陌生来源并产出 `SourceAsset`，不得承担数据集级编排、合并、验证或发布。

---

## 2. 赛题要求与产品目标校准

### 2.1 赛题直接要求

仓库 `PROBLEM.md:22-63` 将主选题定义为“从科学问题到可用数据”，要求系统：

- 自动查找论文、开放数据库、表格、补充材料和图像数据；
- 从正文、表格、附件或图表提取可用信息；
- 清洗缺失、重复和格式差异；
- 对齐字段与格式；
- 标注每条数据来源；
- 输出合并后的多源 CSV；
- 对图表提取给出识别和校验方式。

评价维度见 `PROBLEM.md:94-103`：数据查找完备性、来源可追溯性、清洗整合可靠性、输出格式可用性。

由此得到系统核心目标：

> 根据用户数据需求，构建一个可分析、可追溯、可复用的标准化数据集。

这不等于“针对一个研究主题收集所有角度的材料”。论文、图像、数据库、网页和附件是 **数据来源通道**；最终主数据仍应描述同一数据域中可比较、可合并的记录。

### 2.2 “同类数据”的精确定义

“描述同一类对象”不能只理解为“都与 TP53 有关”。允许合并的数据至少需要同时满足：

1. `dataset_family` 一致，例如均为基因表达测量；
2. `row_granularity` 一致，例如均为“基因 × 样本 × 测量”；
3. 主键或业务键语义兼容，例如 `gene_id + sample_id + measurement_type`；
4. 测量语义可比较，例如 TPM 不能与原始 read count 无说明地混合；
5. 单位和尺度可统一，或明确标记不可直接比较；
6. 样本、队列和实验条件可识别；
7. 字段映射和数值派生可追溯。

因此：

- GDC 与 Xena 的同类基因表达记录，在数据版本、单位、样本标识和重复来源处理明确后可以整合；
- GEO 不同平台的数据只有在 probe-to-gene 映射、尺度和归一化状态兼容后才可整合；
- 表达、突变、通路成员、文献证据不能按行直接拼接；
- 复合需求应拆成多个 DatasetBuild，并在会话层说明它们之间的关系。

### 2.3 目标产品定义

建议统一产品描述：

> BioMed-QAgent 是面向生物医学开放数据的智能检索与标准化系统。它从自然语言数据需求出发，自动发现和评估来源，将同类数据映射至明确的规范 Schema，经过清洗、兼容性检查、合并、置信度标注和来源追踪后，输出可直接用于后续分析的标准化数据集。

---

## 3. 审计范围与验证限制

### 3.1 已审计范围

静态审计覆盖：

- `backend/app/agent_loop/`
- `backend/app/pipeline/`
- `backend/app/domain/contracts/`
- `backend/app/runtime/`
- `backend/app/skills/`
- `backend/app/recipes/`
- `backend/app/tools/`
- `backend/app/integrations/`
- `backend/tests/`
- `frontend/src/runtime/`
- 前端会话、阶段、结果和任务状态组件
- `PROBLEM.md`、`ARCHITECTURE.md`、现有 Review、Confidence Survey、Cache Design

仓库规模约为：

- 后端 354 个 Python 文件；
- 前端 160 余个 TypeScript/TSX 文件；
- 后端 171 个测试文件；
- 核心大文件包括 `runtime/manager.py`、`pipeline/runner.py`、`agent_loop/runner.py`、`pipeline/stages/processing.py`。

### 3.2 动态验证限制

压缩包不包含 `.git` 元数据、后端虚拟环境和前端 `node_modules`。当前执行环境缺少 `openai-agents` 包，且 `uv` 无法联网下载项目要求的 Python 3.12，因此：

- 静态代码审计、文件结构和契约分析已完成；
- 测试收集尝试因缺少 `agents` 模块失败；
- 前端构建和 Vitest 未执行；
- 本文不声称现有测试已通过，也不把未动态验证的行为写成确定事实。

正式开始重构前，必须在项目锁定环境中建立可复现基线：`uv sync`、后端非 live 测试、Ruff、前端 `pnpm install --frozen-lockfile`、TypeScript、ESLint、Vitest。

---

## 4. 当前架构与关键问题

### 4.1 当前执行链

```text
User
  -> Agent Loop
  -> TaskRequest / TaskSpecification
  -> run_research_pipeline
  -> PipelineRunner
       Discovery
       Acquisition
       Processing
       Artifact Build
       Validation
  -> RunManifest / Artifact events
  -> Frontend ResultsViewer
```

`PipelineRunner` 并非简单脚本。它包含任务锁、恢复、摘要链、超时、取消、持久事件、人工确认和原子发布，是应保留的可靠性内核。

### 4.2 固定五阶段已经成为全局线协议

代码证据：

- `backend/app/domain/contracts/enums.py:93-110`：`RequestedOutput.MAIN_DATA` 和阶段化 `TaskState`；
- `backend/app/pipeline/runner.py:1-5`：模块直接声明执行五个固定阶段；
- `backend/app/pipeline/runner.py:96-102`：超时按 `StageName` 固定；
- `backend/app/pipeline/runner.py` 中 `_STAGES`、`_STAGE_OUTPUT_TYPES`、`_STAGE_UPSTREAM` 和 `_execute_stage` 将依赖和分发写死；
- `frontend/src/runtime/contracts.ts:16-21,309-336`：前端 wire contract 同样固定五阶段；
- `frontend/src/components/conversation/StageStep.tsx:23-62`：UI 文案依赖阶段名称；
- 大量测试断言恰好五组 `stage_started/stage_completed`。

问题不在于阶段数量，而在于数据源、数据类型、输出 Schema、验证策略和运行状态全部通过阶段分支耦合。

### 4.3 `TaskSpecification` 没有描述目标数据集

`backend/app/domain/contracts/task.py:19-26` 的 `TaskRequest` 包含主题、数据库、关键词和目标字段。`TaskSpecification` 在 `task.py:71-82` 主要包含查询、数据集 accession、请求输出和来源能力。

缺少：

- 数据集族；
- 行粒度；
- Canonical Schema；
- 主键和去重键；
- 字段语义、类型、单位与本体；
- 可接受的来源通道；
- 合并策略；
- 归一化策略；
- 空结果与部分成功策略；
- 验收阈值。

因此 Agent 只能表达“查 GDC/GEO/Xena”，Pipeline 无法在执行前回答“这些数据是否应进入同一张表”。

### 4.4 数据源组合被硬编码为状态机

`backend/app/domain/contracts/enums.py:63-75` 只允许 GEO、PubMed+GEO、GDC、Xena、GDC+Xena、Reactome 六类组合。`discovery.py`、`acquisition.py`、`processing.py` 和 `tool.py` 继续为每个组合增加分支。

该模式导致：

- 新增来源需要修改多个阶段和契约；
- 来源兼容性等同于“是否出现在 allowlist”，而不是数据语义兼容；
- Reactome 等数据族通过特殊分支绕过通用表达逻辑；
- Agent 参数面不断增加，`run_research_pipeline` 已包含 PMID、GSE、Xena dataset、GDC project/data type、Reactome pathway 等来源特有字段。

### 4.5 `main_data.csv` 方向正确，实现方式错误

赛题要求合并后的标准化表，因此“存在一个主数据集”是合理的。错误在于：

- 文件名和 22 列 Schema 被当成所有数据族共同协议；
- 表达、临床、Reactome 等通过条件分支共用 Builder 和 Validator；
- `backend/app/tools/cache_store.py` 再次硬编码同一 22 列，缓存层也无法泛化；
- `RequestedOutput.MAIN_DATA`、Builder、Validation、API、测试和前端形成跨层锁定。

正确抽象应是：

```text
Primary Dataset = dataset_family + row_granularity + schema_version + data file
```

文件可叫 `dataset.csv` 或基于数据族命名，路径由 `dataset_manifest.json` 指定，不应由所有消费者猜测 `main_data.csv`。

### 4.6 用元数据行填充表达表是 P0 语义缺陷

`backend/app/pipeline/stages/processing.py:53-151` 的 `_build_minimal_parsed_dataset` 在没有表达矩阵时，为每个样本生成一行：

- `measurement_type=sample_metadata`
- `value_semantics=metadata_only`
- `expression_value`、`gene_id` 为空
- 来源行列置 0

其目标是让 `main_data.csv` 非空。随后：

- `validation/checks/main_data.py:90-116` 对全 `metadata_only` 包跳过核心表达完整性校验；
- `validation/checks/lineage.py:71-74` 跳过样本元数据行的数值血缘检查；
- `artifact_build/builder.py:348-375` 只增加 warning，仍继续发布；
- 现有架构文档将此描述为回退能力。

这会将“未找到表达数据”包装成“发布了非空表达表”。即使 warning 诚实，主表语义仍错误，且前端很容易只看到 artifact 存在而误判成功。

重构后必须禁止：

> 为满足结构检查而制造不属于目标行粒度的记录。

无表达数据应返回 `NO_DATA`，并输出来源候选、拒绝原因和诊断报告；样本元数据可作为辅助表，不得冒充表达记录。

### 4.7 字段对齐缺少科学语义门禁

`backend/app/tools/alignment.py:19-44` 通过少量字段别名字典归一化；`92-128` 通过包含关系或公共前缀计算相似度；`131-196` 以 0.7 为阈值模糊对齐；`211-293` 做垂向合并。

该方法没有检查：

- 数据集族；
- 行粒度；
- 主键语义；
- 单位和尺度；
- 测量类型；
- 本体映射；
- 一对多映射；
- 字段映射证据。

字符串相似只能用于候选建议，不能直接决定科研字段合并。

此外，`pipeline/stages/processing.py:379-399` 将文件型 `ParsedDataset` 全量读回内存，转换成 `app/domain/processing.py` 的旧模型。大数据合并因此退回内存行列表，破坏前面流式清洗的优势。

### 4.8 Validation Gate 验证了固定包，而非数据集契约

`validation/package.py:39-86` 以固定顺序执行所有检查，测试还锁定 `check_id` 顺序。问题包括：

- 校验逻辑围绕 `main_data`、Reactome 特例和固定辅助 CSV；
- 非表达数据通过“无 expression 列则跳过”适配；
- metadata-only 通过特殊豁免适配；
- 核心完整性阈值与具体数据族混在通用检查里；
- 不同数据族无法选择不同 Validation Profile。

需要将 Validation 拆成：

1. 通用文件与契约验证；
2. Schema 验证；
3. 数据族语义验证；
4. 归一化与单位验证；
5. 来源和血缘验证；
6. 置信度完整性验证；
7. 发布准入策略。

### 4.9 无输出与空表的运行语义不完整

`backend/app/runtime/manager.py:1666-1694` 在 Agent 真正执行过但没有 artifact 事件时，直接写入 `RunFailedPayload`。前端 `taskOutcome.ts:3-35` 又通过错误消息字符串识别“no_data”。

当前模型无法区分：

- 规格不支持；
- 检索后没有候选数据；
- 有候选但不兼容；
- 部分来源成功；
- 数据行全部被质量门禁拒绝；
- Pipeline 内部异常；
- Agent 未形成最终回复；
- artifact 发布失败。

结果是：为了避免“无输出”，系统倾向制造 artifact；为了避免假成功，Runtime 又将无 artifact 视为失败。这两种修补相互冲突。

### 4.10 Agent Prompt 将产品推向宽泛科研助手

`backend/app/agent_loop/agent.py:103-208` 将 Agent 定义为“生物医学研究项目经理”，并鼓励表达、文献、通路、结构、药物等多角度交叉验证。这适合作为科研助理，但不适合作为数据集构建器的核心指令。

Agent 应先回答：

1. 用户要构建哪一类数据？
2. 一行代表什么？
3. 哪些来源能提供同一语义记录？
4. 是否需要拆成多个独立数据集？

而不是先扩大数据源覆盖，再尝试将结果塞入固定 Pipeline。

### 4.11 置信度已有设计，落地不完整

`docs/SURVEY_2026-08-05-data-confidence.md` 已正确区分确定性数据库通道与模型抽取通道，并提出记录级置信度。当前代码中：

- 字段映射置信度较粗；
- VLM 图表数据点 `confidence` 列存在但为空，见 `extract_chart_data_vlm.py:353-364`；
- 缺少统一 Confidence Contract；
- 置信度尚未成为发布门禁；
- 置信度与 Validation、Provenance、来源通道未形成闭环。

重构应继承现有 Survey 的合理部分，但不要把置信度伪装成统一概率。

---

## 5. 重构目标、非目标和不可破坏约束

### 5.1 目标

1. 支持 Agent 根据用户需求自由选择和组合来源，但只整合科学语义兼容的数据；
2. 每次构建有明确的数据集族、行粒度、Schema 和合并策略；
3. 不再通过空表、元数据占位行或特殊分支制造假成功；
4. 任何终态都向用户给出明确结果，不出现整个会话无输出；
5. 保留来源追踪、下载审计、字段映射、归一化、置信度、Validation Gate 和原子发布；
6. 允许数据库 API、表格、附件、网页和图表成为同一数据集的来源通道；
7. 通过 Registry 和 Profile 扩展数据族与来源，不继续增加数据库组合分支；
8. 为当前比赛 Demo 提供一条可稳定验收的真实数据闭环。

### 5.2 非目标

本轮不做：

- 通用科研假设生成平台；
- 任意研究工作流编排器；
- 用户可编程 DAG；
- 分布式调度、队列集群或多机执行；
- 任意数据之间自动推断关系；
- 自动执行复杂统计建模和因果推断；
- 在无来源证据时允许 LLM 填写科研数值；
- 为所有生物医学数据一次性设计万能 Schema。

### 5.3 不可破坏约束

以下现有能力必须保留或增强：

- SourceAsset 不可变性和 SHA-256；
- DownloadAttempt 全记录；
- 输入、参数、输出 digest；
- 任务目录隔离；
- 取消、超时、任务锁；
- checkpoint 和可恢复执行；
- append-only durable events；
- Validation 失败不发布；
- staging 到 artifacts 原子发布；
- fixture 不得被标记为 live accepted；
- 原始文件、解析文件、标准化文件和正式产物分层；
- Agent 无权直接制造正式数据值。

---

## 6. 核心设计原则

### 6.1 一个 DatasetBuild 对应一个主数据集族和一种行粒度

示例：

```text
Dataset family: gene_expression
Row granularity: gene_sample_measurement
Primary key: dataset_id + sample_id + gene_id + measurement_type
```

复合请求如“整理 TP53 表达、突变和通路数据”应拆分为三个 Build：

- `gene_expression`
- `mutation_event`
- `pathway_member`

会话层可将多个 Build 组织为一个复合回答，但不得将三类记录行合并。

### 6.2 主数据与非主数据按 Artifact Role 分离

每个 Build 至少声明一个 `primary_dataset`。其余产物按角色分类，不在架构层固定文件清单：

- `supporting_dataset`：样本维表、队列信息或与主数据存在明确关系的辅助结构化数据；
- `schema`：Canonical Schema、字段定义和关系说明；
- `provenance`：记录或批次血缘、字段映射、实体映射和转换链；
- `audit_report`：来源选择、搜索过程、质量报告、被拒记录、warning 和下载审计。

`SourceAsset` 保持独立身份，Manifest 通过 ID 引用，不要求复制进正式产物目录。物理文件名和一个角色拆成几个文件属于 Publisher 实现细节，不是顶层协议。

辅助数据不能制造主数据非空，也不能改变主数据的 family、row grain 或测量语义。

### 6.3 来源通道与数据语义分离

数据库名称不能决定输出 Schema。GDC、Xena、GEO、论文表格和网页表格都可能提供 `gene_expression`；同一个 GDC 也可能提供表达、突变或临床数据。

因此 Registry 应按以下维度注册：

```text
source adapter + operation + supported dataset family + source schema
```

而不是简单 `database -> pipeline_supported`。

### 6.4 Agent 规划，服务端裁决

Agent 可以：

- 解析用户需求；
- 选择数据集族；
- 提出行粒度与字段；
- 查找候选来源；
- 选择 Adapter；
- 生成 DatasetBuildSpec；
- 根据中间诊断发起新 Build。

服务端必须裁决：

- Schema 是否存在；
- Adapter 是否允许；
- 来源是否真实获取；
- 数据值是否来自 SourceAsset；
- 映射和单位转换是否合法；
- 数据是否可合并；
- 质量和血缘是否达标；
- 是否允许发布。

### 6.5 Fail closed，但不 silent fail

- 无法证明数据兼容时，不合并；
- 无法证明来源时，不发布该记录；
- 没有有效数据时，不创建假主表；
- 任何终态都生成可读结论与结构化运行摘要；
- `NO_DATA` 不是内部失败；
- `PARTIAL_SUCCESS` 不能隐藏失败来源。

---

## 7. 目标架构

```text
User request
    |
    v
Agent intent parsing + source discovery
    |
    v
DatasetBuildSpec
    |
    v
Spec Validator (trusted service)
    |
    v
Dataset Build Runtime
    |-- acquire source A/B/...
    |     |-- built-in acquisition
    |     `-- WorkflowRecipe -> SourceAsset
    |-- parse through SourceAdapter
    |-- canonicalize + normalize
    |-- compatibility gate
    |-- integrate
    |-- Validation Profile
    `-- atomic publication
    |
    v
DatasetPublication
    |-- DatasetManifest
    |-- primary/supporting datasets
    |-- schema + provenance
    `-- audit reports
    |
    v
BuildResult + server-generated run summary
```

### 7.1 为什么不采用完整 DAG，也不新增 BuildRecipe

当前需求需要多来源 fan-out/fan-in，但不是任意工作流系统。完整 DAG 会引入：

- 节点和边版本管理；
- 图循环检测；
- 动态调度；
- 并行资源管理；
- 节点级重试传播；
- 局部失败和下游失效计算；
- Agent 生成图的可靠性问题；
- 更复杂的前端和恢复语义。

这些成本不能直接提高赛题四项评分。另一方面，仓库已经存在 `WorkflowRecipe`，它描述受控 API、HTML 和 Browser 获取步骤。再定义一个数据集级 `BuildRecipe` 会产生两套命名相近、生命周期不同的 Recipe。

Dataset Runtime 因此采用服务端固定构建骨架：

```text
acquire[*] -> parse[*] -> canonicalize[*]
           -> compatibility_gate -> integrate
           -> validate_profile -> publish
```

方括号步骤可按来源并发。内部可以记录 OperationAttempt 和输入输出引用，但这些是可靠执行实现，不构成 Agent 可编排 Recipe。

`WorkflowRecipe` 的边界限定为 Acquisition：

```text
SkillBuilderAgent
    -> WorkflowRecipe draft
    -> controlled validation
    -> verified/promoted recipe
    -> acquire SourceAsset
    -> SourceAdapter parse
    -> source DataBatch
```

它只能产出 `SourceAsset`，不能产生 Canonical DataBatch、选择合并策略、选择发布阈值或直接发布 Dataset。

### 7.2 何时才需要升级为 DAG

只有同时出现以下需求时再评估：

- 用户自定义任意分析链；
- 多轮分支和条件节点成为常态；
- 节点需要独立复用、重算和大规模并行；
- 运行规模超过单机固定构建骨架；
- 固定构建骨架无法清晰表达核心任务。

当前 Demo 和赛题均不满足这些条件。

## 8. 新核心契约

建议新建 `backend/app/datasets/contracts.py`，所有契约继续继承 `ContractModel`。正式领域契约直接从 `DatasetBuildSpec` 开始；自然语言解析中间结果可使用 Agent 内部 `ParsedDatasetIntent`，但不得进入持久化、API 或执行协议。

### 8.1 DatasetBuildSpec

Agent 在意图解析和来源发现后直接生成自包含的构建规格：

```json
{
  "build_id": "build_...",
  "objective": "比较 TP53 在结直肠癌肿瘤与正常样本中的基因表达",
  "dataset_family": "gene_expression",
  "row_granularity": "gene_sample_measurement",
  "entities": {
    "genes": ["TP53"],
    "diseases": ["colorectal cancer"]
  },
  "cohort_filters": {
    "sample_types": ["primary_tumor", "solid_tissue_normal"]
  },
  "required_fields": [
    "gene_id",
    "gene_symbol",
    "sample_id",
    "disease_id",
    "sample_type",
    "measurement_value",
    "measurement_unit"
  ],
  "schema_ref": "gene_expression.long.v1",
  "source_bindings": [
    {
      "binding_id": "srcbind_gdc",
      "source": "gdc",
      "acquisition": {
        "mode": "builtin",
        "provider_id": "gdc.files.v1"
      },
      "adapter_id": "gdc.expression.star_counts.v1",
      "accession": "TCGA-COAD",
      "parameters": {
        "workflow_type": "STAR - Counts"
      }
    },
    {
      "binding_id": "srcbind_custom",
      "source": "example_repository",
      "acquisition": {
        "mode": "workflow_recipe",
        "recipe_id": "recipe_...",
        "recipe_version": 3
      },
      "adapter_id": "generic.tabular.expression.v1",
      "parameters": {}
    }
  ],
  "normalization_profile_ref": "gene_expression.tcga_compatible.v1",
  "merge_strategy": "append_by_canonical_row",
  "validation_profile_ref": "gene_expression.release.v1",
  "output_format": "csv"
}
```

`DatasetBuildSpec` 同时承担用户语义和执行规格，避免 `DatasetRequest -> DatasetBuildSpec` 两个对象之间出现重复、漂移和跨引用读取。

Agent 可以选择服务端允许的 `validation_profile_ref`，但不能直接传入 `minimum_valid_rows`、`allow_empty_primary_dataset` 等验收阈值。阈值、部分成功策略和人工复核要求属于服务端版本化 Profile。

### 8.2 DatasetSchema

```json
{
  "schema_id": "gene_expression.long.v1",
  "dataset_family": "gene_expression",
  "row_granularity": "gene_sample_measurement",
  "primary_key": [
    "dataset_id",
    "sample_id",
    "gene_id",
    "measurement_type"
  ],
  "fields": [
    {
      "name": "measurement_value",
      "data_type": "float",
      "semantic_role": "measurement",
      "required": true,
      "unit_policy": "declared_per_record"
    },
    {
      "name": "gene_id",
      "data_type": "string",
      "semantic_role": "entity_identifier",
      "ontology": "Ensembl/HGNC",
      "required": true
    }
  ]
}
```

字段至少声明：

- `name`
- `data_type`
- `semantic_role`
- `required` / `nullable`
- `unit_policy`
- `ontology` 或 vocabulary
- `description`
- `derivation_policy`

### 8.3 SourceBinding 与 AdapterDescriptor

`SourceBinding` 记录本次使用的来源、查询、accession、版本、获取方式和解析 Adapter。获取方式只能是：

- `builtin`：由可信内置获取器执行；
- `workflow_recipe`：生产默认引用已提升的 `WorkflowRecipe`；受限试用可在 HIL 确认后引用已验证版本。可信解释器执行后只产出 `SourceAsset`。

`AdapterDescriptor` 在 Registry 中声明：

- 可处理的 source；
- 可产生的 dataset family；
- 源 Schema；
- 支持的获取模式；
- 输出类型；
- 是否确定性；
- 版本；
- 资源限制；
- 允许的参数 Schema。

`WorkflowRecipe` 不属于 Dataset 核心契约。它是 Acquisition 子系统中的声明式、非代码获取描述；“非可执行”应理解为“不包含任意代码”，而不是“不会运行”。

### 8.4 DataBatch

替代当前语义不足的 `ParsedDataset`：

```json
{
  "batch_id": "batch_...",
  "binding_id": "srcbind_gdc",
  "dataset_family": "gene_expression",
  "row_granularity": "gene_sample_measurement",
  "schema_ref": "gdc.star_counts.source.v1",
  "file_asset": {},
  "row_count": 100000,
  "column_count": 18,
  "parser_id": "gdc.star_counts.parser",
  "parser_version": "1.2.0",
  "statistics": {},
  "warnings": []
}
```

全程保持文件型和流式处理，不再转换成内存 `rows: list[dict]`。

### 8.5 FieldMapping

字段映射必须是正式产物和执行输入，而非字符串算法隐式结果。

```json
{
  "mapping_id": "map_...",
  "source_schema_ref": "xena.expression.source.v1",
  "target_schema_ref": "gene_expression.long.v1",
  "source_field": "sample",
  "target_field": "sample_id",
  "transform": "identity",
  "mapping_method": "adapter_declared",
  "confidence_level": "high",
  "evidence": "Xena dataset metadata field definition",
  "review_status": "accepted"
}
```

字符串相似度只能生成 `proposed` 映射，未经 Schema Registry、Adapter 或人工确认不得用于正式合并。

### 8.6 ProvenanceRecord

建议以 sidecar 保存记录级或批次级血缘，主 CSV 保留最小引用字段：`record_id`、`source_id`、`asset_id`、`provenance_id`。

```json
{
  "provenance_id": "prov_...",
  "record_id": "record_...",
  "source_asset_id": "asset_...",
  "source_locator": {
    "logical_file": "...",
    "line": 128,
    "column": 5,
    "column_name": "tpm_unstranded",
    "raw_value": "12.43"
  },
  "transforms": [
    {
      "transform_id": "strip_ensembl_version.v1",
      "input": "ENSG00000141510.18",
      "output": "ENSG00000141510"
    }
  ]
}
```

对于图表提取需额外记录 PDF/图片 asset、页码、bounding box、模型、模型版本、提示摘要、提取档位和人工复核状态。

### 8.7 ConfidenceRecord

置信度不是模型给出的单一神秘概率，建议分通道和组件：

```json
{
  "confidence_id": "conf_...",
  "record_id": "record_...",
  "level": "medium",
  "channel": "vlm_chart_extraction",
  "components": {
    "source_reliability": "high",
    "extraction_reliability": "medium",
    "mapping_reliability": "high",
    "validation_status": "passed",
    "cross_source_consistency": "not_checked"
  },
  "reasons": ["vlm_l1", "axis_units_detected"],
  "requires_human_review": true
}
```

确定性官方 API 可以批次级默认 high，但仍需保留解析器版本、映射状态和质量异常。模型提取数据必须逐条有置信度，是否允许发布由 Validation Profile 判断。

### 8.8 BuildResult

`BuildResult` 只描述一个正常结束的 Dataset Build 的业务结果：

```text
SUCCEEDED
PARTIAL_SUCCESS
NO_DATA
SPEC_REJECTED
```

每个结果包含：

- `valid_row_count`
- `successful_sources`
- `rejected_sources`
- `available_artifact_roles`
- `publication_id`（可空）
- `reason_codes`
- `user_summary`
- `recommended_next_action`

`RunStatus` 独立表示执行生命周期：

```text
QUEUED
RUNNING
COMPLETED
FAILED
CANCELLED
```

只有 `RunStatus=COMPLETED` 才产生 `BuildResult`。Parser 崩溃对应 `RunStatus=FAILED`，用户取消对应 `RunStatus=CANCELLED`，不再重复映射成 `EXECUTION_FAILED` 或 `CANCELLED` BuildResult。

### 8.9 ValidationResult、DatasetManifest 与 DatasetPublication

三个概念保持正交：

- `ValidationResult`：某个 Manifest digest 是否通过指定 Profile；
- `DatasetManifest`：不可变产物清单，按 Artifact Role 引用文件和 SourceAsset；
- `DatasetPublication`：通过门禁后原子提升的正式版本。

不定义 `validated_intermediate` / `validated_final`。第一轮结果和后续修订都是不可变 Publication，使用：

```text
publication_id
manifest_ref
validation_result_ref
published_at
supersedes_publication_id
```

任务或会话只保存 `current_publication_id`。所谓“final”只是当前指针，不是 Artifact 固有状态。

## 9. 执行模型与组件边界

### 9.1 Agent Intent Parser 与 Source Planner

输入自然语言，直接输出 `DatasetBuildSpec`。Agent 内部可先形成不持久化的 `ParsedDatasetIntent`，用于：

- 提取目标数据族；
- 确定一行含义；
- 提取实体和队列条件；
- 确定必要字段；
- 检测复合需求并拆分；
- 搜索和筛选候选来源；
- 形成 `source_bindings`；
- 对无法判断的关键语义请求一次高价值澄清。

不得：选择不存在的 Schema、产生科研数值、写入服务端验收阈值、绕过 Spec Validator。

### 9.2 Spec Validator

在下载大文件前执行：

- Schema 是否存在；
- 数据族和行粒度是否明确；
- required fields 是否属于 Schema；
- Adapter 或 WorkflowRecipe 是否支持该数据族；
- 参数是否合法；
- 来源组合是否有潜在兼容性；
- 资源预算是否可接受；
- 合并策略是否适用；
- `validation_profile_ref` 是否在服务端 allowlist 中。

这将替代当前数据库组合 allowlist 作为核心准入机制。可保留来源级安全 allowlist，但不再用来源集合代替语义兼容性。

### 9.3 Acquisition Provider

Acquisition Provider 统一两种获取路径：

1. 内置获取器：已有官方 API、受控下载器和固定集成；
2. `WorkflowRecipeSourceFetcher`：由 `RecipeExecutor` 解释执行 `WorkflowRecipe`，产出 `SourceAsset`。

两条路径都必须：

- 受 egress、host、timeout、rate limit 和凭据边界约束；
- 生成 DownloadAttempt 或 RecipeAttempt；
- 校验内容、hash 和 SourceAsset；
- 只把 SourceAsset 交给后续 Adapter。

### 9.4 WorkflowRecipe 生命周期与消费闭环

仓库当前已有 `WorkflowRecipe`、`WorkflowRecipeStore`、`RecipeExecutor` 和 SkillBuilderAgent，但正式数据集路径尚未形成稳定消费闭环。V2 必须明确：

```text
DRAFT
  -> controlled validation
VERIFIED
  -> limited trial / promotion request
PROMOTED
  -> production Dataset Build discovery and execution
REJECTED
  -> never execute
```

当前代码中需要修正的具体边界：

- `RecipeExecutor.execute()` 当前要求 `VERIFIED`；
- `find_verified()` 当前只返回 `VERIFIED`；
- Recipe 提升为 `PROMOTED` 后，正式发现和执行路径反而可能不可达。

V2 应让生产 Build 只自动发现 `PROMOTED`；`VERIFIED` 只能在明确受限试用或 HIL 确认下引用。Recipe 执行结果必须经 Workspace 校验和提交后形成 SourceAsset，再进入 SourceAdapter。

`WorkflowRecipe` 不得：

- 产生 Canonical DataBatch；
- 声明跨来源依赖；
- 执行数据集集成；
- 选择 Validation Profile；
- 决定发布；
- 包含 Python、JavaScript、Shell 等任意代码字段。

### 9.5 Source Adapter

每个 Adapter 封装：

```text
inspect SourceAsset -> parse -> emit source DataBatch
```

Adapter 不负责来源获取，也不负责跨来源合并。现有 `skills/builtin/acquisition/*`、`pipeline/processing/*` 和 `integrations/*` 需按职责拆分：获取逻辑进入 Acquisition Provider，解析逻辑进入 Adapter，下载安全基础设施继续复用。

### 9.6 Canonicalizer

职责：

- 映射字段；
- 标准化实体 ID；
- 规范疾病、样本类型和组织 vocabulary；
- 转换可证明等价的单位；
- 保留原值、转换规则和版本；
- 生成 Canonical DataBatch；
- 生成 mapping、normalization 和 rejected-record 审计信息。

禁止：

- 在无证据时猜测 probe-to-gene；
- 将 counts 和 TPM 静默转换或混合；
- 丢弃原始单位与尺度；
- 用列名相似度自动确认语义。

### 9.7 Compatibility Gate

合并前逐项判断：

1. family；
2. granularity；
3. required keys；
4. measurement type；
5. units；
6. scale；
7. normalization state；
8. cohort semantics；
9. entity mapping coverage；
10. provenance completeness。

输出：`compatible`、`compatible_after_transform` 或 `incompatible`，附理由和影响行数。

### 9.8 Integrator

只执行显式策略：

- `append_by_canonical_row`
- `join_by_declared_key`
- `aggregate_to_declared_grain`
- `keep_separate`

不再存在“对齐到看起来相似的列后直接 union”的万能合并器。

去重需要明确：

- 业务去重键；
- 同一上游数据在 GDC/Xena 镜像中重复时的优先来源；
- 数值冲突处理；
- 保留冲突还是拒绝；
- 冲突记录的 provenance。

### 9.9 Validation Engine

架构层只规定三条发布不变量：

1. **Provenance closure**：正式记录可追溯到 SourceAsset、源定位、Parser/Adapter 版本以及字段映射和转换版本；
2. **Validation Profile passed**：当前 dataset family 对应的服务端 Profile 对目标 Manifest digest 判定通过；
3. **Atomic promotion**：Publisher 只原子提升已验证、引用闭合且 staging 完整的 Manifest。

CSV 编码、列数稳定、主键唯一、表达值完整率、warnings 与 metrics 一致、probe mapping 覆盖率和 bbox/model 元数据等均属于具体 Profile 的规则与测试，不上升为全局架构门禁。

`NO_DATA` 不要求“必需主 artifact 非空”；它应通过专门 Profile/结果规则证明本次没有可发布主数据，并保留足够审计证据。

### 9.10 Publisher

继续使用现有 staging、任务锁、flush、manifest 验证和原子 rename。发布输入为：

- DatasetManifest；
- 与该 Manifest digest 对应的通过状态 ValidationResult；
- 完整 staging 内容。

发布后生成不可变 `DatasetPublication`。新版本通过 `supersedes_publication_id` 关联旧版本，任务只更新 `current_publication_id`，不修改旧 Artifact 的验证状态。

## 10. 产物设计

DatasetManifest 使用 Artifact Role，而不是固定物理文件清单：

```text
primary_dataset
supporting_dataset
schema
provenance
audit_report
```

示例目录仅用于说明一种 Publisher 实现，不构成协议：

```text
artifacts/
  dataset_manifest.json
  data/
    gene_expression.csv
    sample_metadata.csv
  schemas/
    gene_expression.long.v1.json
  provenance/
    record_lineage.jsonl
    field_mapping.csv
  reports/
    validation_report.json
    source_selection.json
    rejected_records.csv
    warnings.csv
```

Manifest 中每个 artifact 至少声明：

```json
{
  "artifact_id": "artifact_...",
  "role": "audit_report",
  "media_type": "application/json",
  "path": "reports/source_selection.json",
  "sha256": "...",
  "row_count": null
}
```

`dataset_manifest.json` 至少包含：

- 构建 ID、版本和 Manifest digest；
- 主数据 artifact ID；
- dataset family；
- row granularity；
- Schema 引用；
- 主键；
- 行数和 hash；
- SourceAsset 引用；
- Adapter 和 Parser 版本；
- normalization/validation profile；
- confidence 摘要；
- provenance 覆盖率；
- 按角色分类的 artifact 清单。

为比赛 Demo，可额外提供易下载的 `dataset.csv`，但所有程序必须从 Manifest 的 `primary_dataset` role 识别主数据，不得依赖固定文件名。

### 10.1 无数据时的产物

`NO_DATA` 不发布空主数据集。它可以生成一个已验证的审计型 Publication，只包含：

- `schema`
- `provenance`（如已发生来源定位和转换）
- `audit_report`

来源候选、拒绝原因、下载日志、搜索过程和运行摘要都归入 `audit_report`，不在架构层为每种报告规定单独文件名。

### 10.2 部分成功

只有至少一个来源产出大于零的合法主数据记录，并通过所选 Validation Profile 时，才允许 `PARTIAL_SUCCESS`。Manifest 和 BuildResult 必须列出：

- 成功来源；
- 失败/拒绝来源；
- 影响范围；
- 是否降低覆盖度；
- Profile 是否仍允许正式发布。

### 10.3 Publication 版本关系

每次正式发布生成不可变 Publication。后续修订不修改前一版状态，而是：

```text
publication_v2.supersedes_publication_id = publication_v1
task.current_publication_id = publication_v2
```

前端的“当前结果”来自指针，不来自 `validated_final` 等可变 Artifact 状态。

## 11. 避免会话无输出和空表的完整策略

### 11.1 运行时不依赖 LLM 才能产生进度

Runtime 应直接发布：

- build spec validated；
- source candidate found/rejected；
- download started/completed；
- parsed row count；
- normalization coverage；
- compatibility result；
- validation result；
- publication result；
- build result。

即使 Agent 暂时没有文本 token，用户也能看到可解释进度。

### 11.2 终态必须有结构化摘要

服务端始终生成 `RunSummary`：

- `RunStatus=COMPLETED` 时附 `BuildResult`；
- `RunStatus=FAILED` 时附稳定错误分类和已保留诊断；
- `RunStatus=CANCELLED` 时说明取消点和未发布状态。

Agent 可补充解释，但不能成为唯一输出来源。

### 11.3 明确禁止以下回退

- 生成只有表头的主数据并标记 success；
- 用样本元数据填充表达表；
- 将 warning 当作对语义错误的豁免；
- 因 artifact 数量为零直接推断内部失败；
- 通过错误字符串让前端猜测 no_data；
- 重试同一不适用数据集直到超时；
- 用 `validated_intermediate` / `validated_final` 混合表达验证和当前版本。

### 11.4 状态正交关系

| 维度 | 负责问题 | 典型状态 |
|---|---|---|
| `RunStatus` | 执行是否仍在运行、失败或取消 | queued/running/completed/failed/cancelled |
| `BuildResult` | 正常结束后得到了什么数据结果 | succeeded/partial_success/no_data/spec_rejected |
| `ValidationResult` | 某 Manifest digest 是否通过 Profile | passed/failed |
| `DatasetPublication` | 哪个不可变版本已正式提升 | publication ID + supersedes |
| `current_publication_id` | 会话当前展示哪一版 | 指针 |

这些状态不得相互替代。

### 11.5 终态判定示例

| 情形 | RunStatus | BuildResult | Publication |
|---|---|---|---|
| 两来源成功并通过验证 | completed | succeeded | 有主数据 |
| 一来源成功，一来源下载失败，Profile 允许部分发布 | completed | partial_success | 有主数据 |
| 找到来源但全部不兼容 | completed | no_data | 可选审计型 Publication |
| 用户要求表达+突变，未允许拆分 | completed | spec_rejected | 无 |
| Parser 崩溃 | failed | 不产生 | 无 |
| 用户取消 | cancelled | 不产生 | 无新 Publication |

## 12. 后端重构目录与职责

建议新增：

```text
backend/app/datasets/
  contracts.py
  schema_registry.py
  adapter_registry.py
  compatibility.py
  integration.py
  publication.py
  results.py
  runtime/
    executor.py
    operations.py
    attempts.py
    checkpoint.py
  acquisition/
    provider.py
    builtin.py
    workflow_recipe.py
  adapters/
    base.py
    gdc.py
    xena.py
    geo.py
    reactome.py
    pubmed.py
    table_extraction.py
  normalization/
    fields.py
    entities.py
    units.py
    profiles.py
  validation/
    engine.py
    profiles/
      common.py
      gene_expression.py
      mutation_event.py
      pathway_member.py
  confidence/
    contracts.py
    policy.py
```

### 12.1 现有模块迁移映射

| 当前模块 | 目标处理 |
|---|---|
| `pipeline/runner.py` | 抽取可靠性内核到 `datasets/runtime/executor.py`；保留 Legacy facade |
| `pipeline/stages/discovery.py` | 来源发现逻辑迁到 Agent/Skills；不再是全局 Stage |
| `pipeline/stages/acquisition.py` | 下载编排迁到 Acquisition Provider；复用安全下载与 SourceAsset |
| `pipeline/stages/processing.py` | 拆成 Adapter parser、Canonicalizer、Integrator；删除占位行 |
| `pipeline/stages/artifact_build/` | 改为 role-based Manifest 和 DatasetPublication |
| `pipeline/stages/validation/` | 拆为 profile-driven Validation Engine |
| `domain/contracts/task.py` | 保留 V1；新增自包含 `DatasetBuildSpec`，不新增 `DatasetRequestV2` |
| `domain/contracts/pipeline.py` | StageAttempt 逐步替换为 OperationAttempt/BuildAttempt |
| `domain/processing.py` | 删除旧内存 ParsedDataset |
| `domain/contracts/recipe.py` | 保留 Acquisition Recipe；修正文档中的“non-executable”为“non-code declarative”语义 |
| `recipes/executor.py` | 支持生产执行 PROMOTED Recipe，并明确 VERIFIED 受限试用 |
| `recipes/store.py` | 增加生产发现接口；修复 promoted 后无法被正式发现的问题 |
| `skills/builtin/processing/create_skill/` | 保留 Recipe 开发/验证；补齐从推广到 Dataset Build 消费的闭环 |
| `tools/alignment.py` | 降级为映射候选工具；禁止直接正式合并 |
| `tools/cache_store.py` | 改成 Schema-aware Dataset Cache |
| `agent_loop/agent.py` | 改为数据集需求和来源规划 Prompt |
| `pipeline/tool.py` | 新增 Dataset Build 工具，旧工具作为兼容层 |
| `runtime/manager.py` | RunStatus、BuildResult、ValidationResult 和 Publication 分离 |

### 12.2 不创建通用 BuildRecipe 或公开 BuildStep

项目当前最需要清晰边界，而非泛化抽象。建议使用明确术语：

- `AcquisitionProvider`
- `SourceAdapter`
- `Canonicalizer`
- `CompatibilityGate`
- `Integrator`
- `ValidationProfile`
- `Publisher`
- `OperationAttempt`

构建顺序由 `DatasetBuildExecutor` 的固定骨架控制。`OperationAttempt` 用于恢复、事件和摘要，不成为 Agent 可声明的工作流节点。

## 13. Cache 重构

当前 `CacheStore` 将缓存固定为 22 列表达主表。目标布局：

```text
cache/datasets/<namespace>/<dataset_id>/
  manifest.json
  data/<primary_file>
  schema.json
  provenance/...
```

缓存键至少包含：

- dataset family；
- Schema ID/version；
- source binding；
- Adapter/parser version；
- normalization profile；
- query/cohort parameters；
- source asset digest。

不要以自然语言关键词作为数据身份。关键词仅用于索引和搜索。

迁移策略：

1. V2 Cache 双写；
2. V2 读取优先，V1 只读回退；
3. 将旧 `main_data.csv` 包装为 `gene_expression.long.legacy.v1`；
4. 提供离线迁移命令；
5. 稳定后删除 22 列硬编码写入接口。

---

## 14. Agent 与工具重构

### 14.1 新 Agent 工作流

```text
1. 识别目标数据集族和行粒度
2. 检测是否为复合请求，必要时拆分
3. 搜索并 vet 候选来源
4. 直接生成自包含 DatasetBuildSpec
5. 调 validate_dataset_build_spec
6. 调 execute_dataset_build
7. 根据 RunStatus/BuildResult 汇报或生成新的 Build
```

意图解析中的 `ParsedDatasetIntent` 只在 Agent 内部存在，不持久化，也不作为工具参数。

### 14.2 建议工具接口

优先两个主接口：

- `validate_dataset_build_spec`
- `execute_dataset_build`

可选增加：

- `list_dataset_schemas`
- `describe_source_adapter`
- `preview_dataset_source`
- `find_promoted_workflow_recipe`

不要把所有来源特有参数继续平铺在一个 function tool 中。`source_bindings[].parameters` 应由 Adapter 或 WorkflowRecipe input Schema 校验。

### 14.3 Prompt 关键规则

- 先定义数据集，再选数据库；
- 同一 Build 只能有一个 family/granularity；
- 复合请求拆分，不进行无依据宽表拼接；
- 文献、网页和图像是来源通道，不自动成为主数据行；
- Agent 不得传入自称来自论文的裸数字；
- Agent 不得定义发布阈值或放宽 Validation Profile；
- 没有合法数据时返回 NO_DATA；
- 不要求机械查满所有数据库；覆盖度按相关数据源计算；
- 只选择能提供目标 Schema 字段的来源。

## 15. 前端重构

### 15.1 事件模型

逐步新增通用事件：

```text
build_spec_ready
operation_started
operation_progress
operation_completed
operation_failed
source_candidate_found
source_candidate_rejected
compatibility_evaluated
build_result_ready
```

兼容期可同时发送旧 `stage_*` 事件。前端改为基于 `operation_id`、`label`、`category` 渲染，不再依赖固定 StageName union。

### 15.2 结果展示

`ResultsViewer` 应先读取 `dataset_manifest.json`，展示：

- 主数据集名称、family、row grain、Schema；
- 有效行数；
- 来源覆盖；
- Validation 状态；
- confidence 分布；
- provenance 覆盖率；
- 部分成功或 NO_DATA 原因；
- 辅助文件；
- CSV 预览与下载。

当前仅按文件列表展示会让用户无法区分主数据、辅助表和诊断文件。

### 15.3 明确 outcome

删除通过错误字符串识别 no_data 的方式。后端直接返回 `BuildResult` 枚举及 reason code；执行失败和取消由 `RunStatus` 表达。

---

## 16. 迁移执行计划

采用绞杀式迁移，不做大爆炸重写。

### Phase 0：冻结与特征测试

目标：建立可比较基线。

工作：

1. 恢复项目锁定环境；
2. 运行全部非 live 后端测试、Ruff、前端构建和测试；
3. 保存一个真实成功表达任务、一个 metadata-only GEO、一个 Reactome、一个失败任务的输出；
4. 增加 characterization tests，记录当前事件、manifest、恢复和原子发布行为；
5. 将本设计列入仓库文档，并标记旧架构文档待迁移部分。

验收：基线结果可重复，失败原因已记录。

### Phase 1：引入 V2 数据集契约和 Schema Registry

工作：

- 新增自包含 `DatasetBuildSpec`、`DatasetSchema`、`DataBatch`、`BuildResult`、`ValidationResult`、`DatasetManifest` 和 `DatasetPublication`；
- 不新增正式 `DatasetRequest`；
- 注册 `gene_expression.long.v1`；
- 编写 Spec Validator；
- 将验收阈值放入服务端 Validation Profile；
- 不修改旧 Pipeline 执行。

验收：

- 复合请求可被拒绝或拆分；
- 缺 family/granularity 的规格不能执行；
- Agent 无法通过 Spec 自行允许空主表；
- Adapter/Recipe 参数通过正式 Schema 校验。

### Phase 2：抽取可信执行内核

工作：

- 从 `PipelineRunner` 抽取通用任务锁、Attempt、digest、checkpoint、超时、取消和事件逻辑；
- 实现服务端固定 `DatasetBuildExecutor` 骨架；
- 使用内部 Operation/OperationAttempt 记录来源 fan-out 和后续 fan-in；
- 不定义 `BuildRecipe`，不允许 Agent 声明构建步骤；
- `PipelineRunner` 变成 Legacy facade。

验收：旧可靠性测试主要保持通过；新 Executor 能运行最小固定骨架，并证明取消、恢复、digest 和事件行为不退化。

### Phase 2.5：补齐 WorkflowRecipe Acquisition 闭环

工作：

- 明确 `WorkflowRecipe` 只用于 Acquisition；
- 实现 `WorkflowRecipeSourceFetcher`；
- `SourceBinding` 支持 `recipe_id + version`；
- 生产发现只返回 PROMOTED Recipe；
- VERIFIED Recipe 仅允许受限试用或 HIL 确认；
- 修复 `RecipeExecutor.execute()`、Store discovery 和 promotion 状态之间的不一致；
- Recipe 输出提交为 SourceAsset 后再交给 Adapter。

验收：

- promoted Recipe 能被正式 Dataset Build 发现和执行；
- Recipe 不能绕过 SourceAsset；
- Recipe 不能参与合并、Validation Profile 选择或发布；
- 任意代码字段仍 fail closed。

### Phase 3：实现表达数据 V2 Demo 链路

工作：

- Adapter 化 GDC 和 Xena；
- 实现文件型 canonicalization；
- 实现表达 Compatibility Gate；
- 实现显式 append/dedup 规则；
- 生成 role-based DatasetManifest V2；
- 实现表达 Validation Profile；
- 不再依赖 `main_data.csv`。

验收：

- 单 GDC、单 Xena、兼容 GDC+Xena 均可生成合法主表；
- 不兼容单位/尺度会被拒绝；
- provenance 可抽样回溯；
- 重跑可复用成功 Operation。

### Phase 4：修复空表和终态语义

工作：

- 删除 metadata-only 主表占位路径；
- 引入 `BuildResult`；
- `RunStatus` 不再用 artifact 数量推导；
- 删除 `validated_intermediate` / `validated_final` 类状态；
- 增加不可变 Publication 与 `current_publication_id`；
- 服务端保证终态摘要；
- 前端直接展示 NO_DATA/PARTIAL_SUCCESS；
- 审计报告通过 Artifact Role 发布。

验收：

- 没有表达数据时无假主表；
- 会话仍给出明确原因和下一步；
- 空表不能以 SUCCEEDED 发布；
- failed/cancelled Run 不产生伪 BuildResult；
- 新 Publication 不修改旧版本状态。

### Phase 5：迁移 GEO

工作：

- 将 GEO acquisition/parser 按 Acquisition Provider 与 Adapter 拆分；
- 正式建模 platform、probe mapping、value scale 和 normalization；
- 只有通过 Compatibility Gate 的 GEO 数据才能与其他表达数据整合；
- 映射失败时保留审计报告或 NO_DATA，不伪装 gene-level 数据。

验收：

- gene-level 与 probe-level 清楚区分；
- 无映射时发布策略明确；
- 测量尺度不兼容时不合并。

### Phase 6：Validation、Confidence、图表通道

工作：

- 架构层固定“provenance closure + Profile passed + atomic promotion”三项不变量；
- 将 CSV、字段完整率、mapping、bbox 等具体规则迁入 Profile；
- 实现 Confidence Contract；
- 为 VLM 图表点填充置信度、页码/bbox/model 元数据；
- 建立模型提取准入门禁；
- 通用 provenance coverage 统计。

验收：模型提取记录缺置信度或 source-of-record 时对应 Profile 失败，无法发布。

### Phase 7：Cache、前端和 API 完整迁移

工作：

- V2 Dataset Cache；
- Manifest-driven ResultsViewer；
- 通用 operation events；
- API 分别返回 RunStatus、BuildResult、ValidationResult 和 Publication；
- 双读双写迁移旧缓存和旧 artifact API。

### Phase 8：清理 Legacy

满足以下条件后删除：

- 固定 `_STAGES`；
- `StageName` 业务依赖；
- `SUPPORTED_PIPELINE_SOURCE_COMBINATIONS` 作为语义门禁；
- 22 列缓存硬编码；
- `app/domain/processing.py` 旧 ParsedDataset；
- 正式路径上的 `tools/alignment.merge_datasets`；
- metadata-only 占位；
- `run_research_pipeline` 旧参数面；
- 任何 V2 `DatasetRequest` 或 `BuildRecipe` 临时实现。

## 17. 当前 Demo 的一步到位范围

为了控制范围，当前可用 Demo 建议只证明一件事：

> 系统能根据自然语言表达数据需求，从两个兼容官方来源检索、标准化并整合基因表达记录，输出带 Schema、来源、映射、质量与置信度说明的可分析 CSV；来源失败时返回真实部分成功或无数据结论。

推荐主数据族：`gene_expression`。

推荐第一优先来源：

1. GDC；
2. Xena；
3. GEO 作为需要额外兼容性判断的扩展。

PubMed 用于发现和证据；Reactome 作为独立 `pathway_member` Build 展示扩展能力，不与表达主表合并。

### 17.1 Demo 必须展示

- 用户自然语言 -> 自包含 DatasetBuildSpec；
- 选择来源及理由；
- Spec Validator；
- 内置获取或 WorkflowRecipe 获取后形成 SourceAsset；
- 字段映射、实体映射和单位说明；
- Compatibility Gate；
- 合并后的标准表；
- 每条记录或批次来源；
- Validation Profile 报告；
- confidence/provenance 摘要；
- DatasetPublication 和当前版本；
- 一个来源失败时的 partial success；
- 无数据时不生成假表。

### 17.2 Demo 不应展示为核心

- 表达+突变+通路+文献混合大包；
- Agent 自由 DAG；
- Agent 自定义 BuildRecipe；
- 大量研究结论生成；
- 复杂统计分析；
- 与评分无直接关系的多 Agent 编排细节。

## 18. 测试策略

### 18.1 契约测试

- DatasetBuildSpec 同时包含 objective、family、granularity、Schema 和来源绑定；
- family/granularity 与 Schema 一致；
- required fields 属于目标 Schema；
- Agent 不能内联 acceptance thresholds；
- Adapter 和 WorkflowRecipe 参数 Schema；
- RunStatus 与 BuildResult 组合约束；
- ValidationResult 绑定精确 Manifest digest；
- Publication 的 supersedes 关系与 current pointer；
- Manifest 主数据引用和 Artifact Role 闭合。

### 18.2 Acquisition 与 Adapter 合约测试

所有 Acquisition Provider 共享：

- 内置获取和 WorkflowRecipe 获取都只产出已校验 SourceAsset；
- PROMOTED Recipe 可生产发现和执行；
- VERIFIED Recipe 不能未经允许进入生产；
- Recipe 不能包含任意代码字段；
- Recipe 输出必须通过 Workspace 校验和 commit。

所有 Adapter 共享：

- 只读取成功 SourceAsset；
- 输出 DataBatch 的 family/granularity 正确；
- row count/hash 正确；
- Parser 版本存在；
- malformed 输入 fail closed；
- 不静默截断；
- 获取失败和解析失败有不同错误码。

### 18.3 兼容性与集成测试

- family 不同拒绝；
- grain 不同拒绝；
- 单位不可转换拒绝；
- count 与 TPM 不静默合并；
- GDC/Xena 镜像重复处理；
- GEO probe mapping 不足拒绝或独立输出；
- 冲突记录进入审计报告。

### 18.4 Validation 与 Publication 测试

架构不变量：

- provenance 不闭合拒绝；
- Profile 未通过拒绝；
- Manifest digest 不匹配拒绝；
- 原子发布失败不暴露半成品；
- 新 Publication 不修改旧 Publication；
- current pointer 只在成功发布后更新。

Profile 规则示例：

- 0 行主表不得 succeeded；
- metadata 行不能满足表达完整性；
- 低 confidence 模型值按策略拒绝；
- 原文件篡改导致失败；
- warnings、metrics、行数和映射覆盖率按 Profile 校验。

### 18.5 Runtime 测试

- 取消；
- timeout；
- checkpoint 重用；
- digest 变化触发重算；
- partial success；
- no data；
- execution failure；
- 事件重放；
- 服务端终态摘要始终存在；
- failed/cancelled 不产生 BuildResult；
- completed 必须产生合法 BuildResult。

### 18.6 前端测试

- Manifest 按 Artifact Role 识别主数据；
- RunStatus 与 BuildResult 分开展示；
- Publication 版本和 current pointer；
- confidence/provenance 展示；
- operation 事件；
- 老事件兼容；
- NO_DATA 不显示为红色内部错误；
- failed/cancelled 不伪装成 no_data。

## 19. 风险与控制

### 19.1 重构范围过大

控制：先做表达 V2 垂直切片，保留 Legacy facade；不同时迁所有来源。

### 19.2 新旧契约双轨漂移

控制：V2 为新功能唯一入口；V1 只做兼容；增加转换器和废弃期限，不长期双写业务逻辑。

### 19.3 测试固定旧行为

控制：先增加业务不变量测试，再迁测试。不要仅机械修改“5 stages”断言，而应验证取消、恢复、摘要链和发布不变量。

### 19.4 Schema 过度设计

控制：只注册 Demo 真正使用的数据族；Schema Registry 支持版本化，不预先穷举所有生物医学数据。

### 19.5 Agent 规格不稳定

控制：严格 Pydantic Schema、服务端 Validator、允许一次澄清、拒绝不完整规格；Agent 不直接执行自由代码。

### 19.6 合并看似成功但科学上不可比

控制：Compatibility Gate 为独立发布前门禁；单位、尺度、测量类型和粒度是硬条件，字符串字段相似度不是充分条件。

### 19.7 置信度造成虚假精确

控制：先用 level + reasons + components；除非经过校准，不输出看似精确的 0.873 概率。

---

## 20. 完成定义

重构达到可交付状态需同时满足：

1. Agent 能直接输出自包含且可验证的 DatasetBuildSpec；
2. 一个 Build 只能对应一个 family/granularity；
3. Agent 不能通过 BuildSpec 修改服务端验收阈值；
4. GDC、Xena 表达数据通过 Acquisition Provider、SourceAsset、Adapter 和 Canonical Schema；
5. promoted WorkflowRecipe 能完成 Acquisition 消费闭环，且不能越权参与集成或发布；
6. 合并前执行 Compatibility Gate；
7. 主数据不含 metadata-only 占位；
8. 0 行结果为 NO_DATA，不是 success；
9. 部分来源失败时能返回 PARTIAL_SUCCESS；
10. RunStatus、BuildResult、ValidationResult 和 Publication 状态正交；
11. 每条或每批数据可追溯到 SourceAsset；
12. 字段映射、单位、归一化和版本可审计；
13. 模型提取数据有强制置信度；
14. 发布只依赖 provenance closure、Profile passed 和 atomic promotion 三项架构不变量；
15. Manifest 通过 Artifact Role 识别主数据和审计产物；
16. 新 Publication 不修改旧版本，current pointer 正确更新；
17. 原子发布、恢复、取消和摘要链能力不退化；
18. 前端从 Manifest 识别主数据并分开展示执行与业务结果；
19. 旧 Pipeline 可在迁移期运行，最终有明确删除计划；
20. 代表性成功、部分成功、无数据、规格拒绝、执行失败和取消案例均有自动化测试。

## 21. 首批实施任务清单

建议按以下顺序开工：

1. 建立完整可运行基线并保存四类 golden outputs；
2. 新增自包含 `DatasetBuildSpec`、`DatasetSchema`、`DataBatch`、`BuildResult`、`ValidationResult`、`DatasetManifest` 和 `DatasetPublication`；
3. 注册 `gene_expression.long.v1` 与服务端 `gene_expression.release.v1`；
4. 编写 Spec Validator 和 Compatibility Gate 单元测试；
5. 从 PipelineRunner 抽取通用 Attempt/checkpoint/timeout/cancel/event 机制，实现固定 DatasetBuildExecutor；
6. 定义 RunStatus、BuildResult、ValidationResult、Publication 和 current pointer 的状态约束；
7. 修复 WorkflowRecipe VERIFIED/PROMOTED 发现与执行规则，实现 `WorkflowRecipeSourceFetcher`；
8. 实现 GDC Expression Acquisition/Adapter；
9. 实现 Xena Expression Acquisition/Adapter；
10. 实现文件型 Canonicalizer 和显式 merge；
11. 实现 role-based DatasetManifest V2、表达 Validation Profile 和原子 Publication；
12. 删除 V2 路径中的 metadata-only 主表行为；
13. 接入 BuildResult 与服务端终态摘要；
14. 前端增加 V2 Manifest、Artifact Role、Publication 和 BuildResult 展示；
15. 完成 success、partial、no-data、spec-rejected、failed、cancelled、tamper/recovery Demo；
16. 再迁 GEO、Cache、Confidence 和图表通道。

该顺序先建立正确数据契约、Recipe 获取闭环和状态边界，避免继续向旧 Pipeline 增加数据库组合分支，也避免 V2 再造一套通用编排框架。
