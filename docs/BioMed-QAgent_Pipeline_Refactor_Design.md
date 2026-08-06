# BioMed-QAgent 数据集构建 Pipeline 重构设计

> 文档状态：提案，作为下一阶段实现基线  
> 代码基线：用户提供的 `BioMed-QAgent-main.zip`，审计日期 2026-08-06  
> 适用范围：后端 Agent、Pipeline、数据契约、缓存、事件、前端结果展示与测试迁移  
> 目标：将当前固定五阶段、固定数据库组合、固定 `main_data.csv` 结构，重构为面向同类科学数据检索、标准化与整合的可信数据集构建系统

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

> 保留可信执行内核，将 Pipeline 重构为 **数据集契约驱动的 Dataset Construction Runtime**。每次构建只对应一个主数据集族、一种行粒度和一套明确合并语义。Agent 负责理解需求、拆分复合请求、选择来源和生成构建规格；服务端负责下载、解析、归一化、兼容性判断、合并、校验、置信度、溯源和原子发布。

不引入完整 DAG 引擎。执行模型采用受控 `BuildRecipe`：按来源可并行检索、获取、解析和标准化，随后经过兼容性门禁、集成、验证和发布。步骤依赖由服务端模板和输入输出类型隐式确定，不允许 Agent 自由生成图边。

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

### 6.2 主数据与辅助数据分离

每个 Build 可以包含：

- 一个主数据集；
- Schema；
- 样本维表或实体映射表；
- Provenance sidecar；
- 字段映射；
- 质量报告；
- 来源清单；
- 被拒记录；
- 搜索和诊断报告。

辅助表不能用来制造主表非空。

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
Dataset Requirement Parser (Agent)
    |
    v
DatasetRequest
    |
    v
Source Discovery / Vetting (Agent + skills)
    |
    v
DatasetBuildSpec
    |
    v
Spec Validator (trusted service)
    |
    v
Dataset Build Runtime
    |-- retrieve source A/B/...
    |-- parse source batches
    |-- canonicalize + normalize
    |-- compatibility gate
    |-- integrate
    |-- validation profile
    |-- confidence + provenance
    `-- atomic publish
    |
    v
DatasetManifest + primary dataset + audit artifacts
    |
    v
Explicit BuildOutcome + user summary
```

### 7.1 为什么不采用完整 DAG

当前需求有并行来源，但不是任意工作流系统。完整 DAG 会引入：

- 节点和边版本管理；
- 图循环检测；
- 动态调度；
- 并行资源管理；
- 节点级重试传播；
- 局部失败和下游失效计算；
- Agent 生成图的可靠性问题；
- 更复杂的前端和恢复语义。

这些成本不能直接提高赛题四项评分。

建议使用受控 BuildRecipe：

```text
discover -> select -> retrieve[*] -> parse[*] -> normalize[*]
         -> compatibility_gate -> integrate -> validate -> publish
```

方括号步骤可按来源并发，依赖由服务端模板确定。需要新数据族时增加 Recipe/Profile，不让 Agent 自由声明图边。内部实现可用输入引用推导依赖，但不对外宣传或暴露 DAG。

### 7.2 何时才需要升级为 DAG

只有同时出现以下需求时再评估：

- 用户自定义任意分析链；
- 多轮分支和条件节点成为常态；
- 节点需要独立复用、重算和大规模并行；
- 运行规模超过单机受控 Recipe；
- 现有 Recipe 无法清晰表达依赖。

当前 Demo 和赛题均不满足这些条件。

---

## 8. 新核心契约

建议新建 `backend/app/datasets/contracts.py`，所有契约继续继承 `ContractModel`。

### 8.1 DatasetRequest

表达用户真正需要的数据集，而非数据库组合。

```json
{
  "request_id": "dsreq_...",
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
  "preferred_sources": ["gdc", "ucsc_xena"],
  "output_format": "csv"
}
```

### 8.2 DatasetBuildSpec

服务端可执行的声明式构建规格。

```json
{
  "build_id": "build_...",
  "request_ref": "dsreq_...",
  "schema_ref": "gene_expression.long.v1",
  "source_bindings": [
    {
      "binding_id": "srcbind_gdc",
      "source": "gdc",
      "adapter_id": "gdc.expression.star_counts.v1",
      "accession": "TCGA-COAD",
      "parameters": {
        "workflow_type": "STAR - Counts"
      }
    },
    {
      "binding_id": "srcbind_xena",
      "source": "ucsc_xena",
      "adapter_id": "xena.gene_expression.v1",
      "accession": "...",
      "parameters": {}
    }
  ],
  "normalization_profile": "gene_expression.tcga_compatible.v1",
  "merge_strategy": "append_by_canonical_row",
  "validation_profile": "gene_expression.release.v1",
  "acceptance_policy": {
    "minimum_valid_rows": 1,
    "minimum_successful_sources": 1,
    "allow_partial_sources": true,
    "allow_empty_primary_dataset": false
  }
}
```

### 8.3 DatasetSchema

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

### 8.4 SourceBinding 与 AdapterDescriptor

`SourceBinding` 记录本次使用的来源、查询、accession、版本和 Adapter。`AdapterDescriptor` 在 Registry 中声明：

- 可处理的 source；
- 可产生的 dataset family；
- 源 Schema；
- 支持的获取模式；
- 输出类型；
- 是否确定性；
- 版本；
- 资源限制；
- 允许的参数 Schema。

### 8.5 DataBatch

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

### 8.6 FieldMapping

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

### 8.7 ProvenanceRecord

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

### 8.8 ConfidenceRecord

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

确定性官方 API 可以批次级默认 high，但仍需保留解析器版本、映射状态和质量异常。模型提取数据必须逐条有置信度，不允许空值通过发布门禁。

### 8.9 BuildOutcome

```text
SUCCEEDED
PARTIAL_SUCCESS
NO_DATA
SPEC_REJECTED
EXECUTION_FAILED
CANCELLED
```

每个 outcome 包含：

- `primary_dataset_status`
- `valid_row_count`
- `successful_sources`
- `rejected_sources`
- `available_artifacts`
- `reason_codes`
- `user_summary`
- `recommended_next_action`

`RunStatus` 继续表示执行生命周期，`BuildOutcome` 表示业务结果，二者不要混用。

---

## 9. 执行模型与组件边界

### 9.1 Requirement Parser

输入自然语言，输出 `DatasetRequest`。职责：

- 提取目标数据族；
- 确定一行含义；
- 提取实体和队列条件；
- 确定必要字段；
- 检测复合需求并拆分；
- 对无法判断的关键语义请求一次高价值澄清。

不得：选择不存在的 Schema、产生科研数值、绕过 Spec Validator。

### 9.2 Source Discovery 与 Vetting

使用现有 Skill、Subagent 和 Recipe 能力，产出候选来源及其：

- 数据族；
- 样本/记录范围；
- 平台和测量类型；
- 文件可用性；
- 字段预览；
- 单位和归一化状态；
- 选择或拒绝理由。

PubMed 在表达数据 Build 中主要承担来源发现、数据集关联和证据说明，不把论文元数据行追加到表达主表。

### 9.3 Spec Validator

在下载大文件前执行：

- Schema 是否存在；
- 数据族和行粒度是否明确；
- Adapter 是否支持该数据族；
- 参数是否合法；
- 来源组合是否有潜在兼容性；
- 资源预算是否可接受；
- 合并策略是否适用；
- 空结果和部分成功策略是否明确。

这将替代当前数据库组合 allowlist 作为核心准入机制。可保留来源级安全 allowlist，但不再用来源集合代替语义兼容性。

### 9.4 Source Adapter

每个 Adapter 封装：

```text
discover/describe -> acquire -> parse -> emit source DataBatch
```

Adapter 不负责跨来源合并。现有 `skills/builtin/acquisition/*`、`pipeline/processing/*` 和 `integrations/*` 可逐步迁入 Adapter，而不重写下载安全基础设施。

### 9.5 Canonicalizer

职责：

- 映射字段；
- 标准化实体 ID；
- 规范疾病、样本类型和组织 vocabulary；
- 转换可证明等价的单位；
- 保留原值、转换规则和版本；
- 生成 Canonical DataBatch；
- 生成 mapping、normalization 和 rejected-record sidecar。

禁止：

- 在无证据时猜测 probe-to-gene；
- 将 counts 和 TPM 静默转换或混合；
- 丢弃原始单位与尺度；
- 用列名相似度自动确认语义。

### 9.6 Compatibility Gate

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

### 9.7 Integrator

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

### 9.8 Validation Engine

采用 `ValidationProfile`：

通用规则：

- 文件存在、hash、编码、Schema、类型；
- 行数与统计一致；
- 主键唯一性；
- 外键闭合；
- SourceAsset 与 DownloadAttempt 闭合；
- Provenance 可定位；
- 映射和转换版本存在；
- 置信度必填规则；
- 产物清单闭合。

表达数据规则：

- `gene_id`、`sample_id`、测量值完整率；
- 数值可解析且符合声明尺度；
- measurement type、unit、normalization state 一致；
- probe 映射覆盖率；
- 样本类型有效；
- 目标实体是否存在；
- 跨来源重复和冲突报告。

图表提取规则：

- 页码/bbox/asset/model 存在；
- 轴和单位已解析；
- confidence 非空；
- 低置信值按策略进入 rejected 或 requires_review。

### 9.9 Publisher

继续使用现有 staging、任务锁、flush、manifest 验证和原子 rename。发布对象改为 DatasetManifest V2，而非固定包文件集合。

---

## 10. 产物设计

建议目录：

```text
artifacts/
  dataset_manifest.json
  data/
    gene_expression.csv
  schemas/
    gene_expression.long.v1.json
  provenance/
    record_lineage.jsonl
  mappings/
    field_mapping.csv
    entity_mapping.csv
  quality/
    validation_report.json
    quality_summary.json
    rejected_records.csv
    warnings.csv
  sources/
    source_list.csv
    source_assets.csv
    download_log.csv
  auxiliary/
    sample_metadata.csv
    search_report.json
```

`dataset_manifest.json` 至少包含：

- 构建 ID、请求 ID、版本；
- 主数据路径；
- dataset family；
- row granularity；
- Schema 引用；
- 主键；
- 行数和 hash；
- 来源；
- Adapter 和 Parser 版本；
- normalization/validation profile；
- outcome；
- 置信度摘要；
- provenance 覆盖率；
- 辅助 artifact 清单。

为比赛 Demo，可额外在根目录提供易下载的 `dataset.csv`，但所有程序必须从 manifest 识别主数据，不得依赖固定文件名。

### 10.1 无数据时的产物

`NO_DATA` 不发布空主数据集。可以发布已验证的过程证据：

- `search_report.json`
- `source_candidates.csv`
- `source_rejection_report.csv`
- `download_log.csv`
- `run_summary.json`

这些文件必须清楚标记为诊断和搜索结果，而非科研测量数据。

### 10.2 部分成功

只有至少一个来源产出大于零的合法主数据记录时，才允许 `PARTIAL_SUCCESS`。Manifest 必须列出：

- 成功来源；
- 失败/拒绝来源；
- 影响范围；
- 是否降低覆盖度；
- 是否仍满足最小验收策略。

---

## 11. 避免会话无输出和空表的完整策略

### 11.1 运行时不依赖 LLM 才能产生进度

Runtime 应直接发布：

- requirement parsed；
- source candidate found/rejected；
- download started/completed；
- parsed row count；
- normalization coverage；
- compatibility result；
- validation result；
- outcome。

即使 Agent 暂时没有文本 token，用户也能看到可解释进度。

### 11.2 终态必须有结构化摘要

每次 Run 无论成功与否都生成 `BuildOutcome`，并由服务端提供基础终结文本。Agent 可补充解释，但不能成为唯一输出来源。

### 11.3 明确禁止以下回退

- 生成只有表头的主数据并标记 success；
- 用样本元数据填充表达表；
- 将 warning 当作对语义错误的豁免；
- 因 artifact 数量为零直接推断内部失败；
- 通过错误字符串让前端猜测 no_data；
- 重试同一不适用数据集直到超时。

### 11.4 终态判定示例

| 情形 | RunStatus | BuildOutcome | 主数据 |
|---|---|---|---|
| 两来源成功并通过验证 | completed | succeeded | 有 |
| 一来源成功，一来源下载失败，仍满足策略 | completed | partial_success | 有 |
| 找到来源但全部不兼容 | completed | no_data | 无 |
| 用户要求表达+突变，未允许拆分 | completed | spec_rejected | 无 |
| Parser 崩溃 | failed | execution_failed | 无 |
| 用户取消 | cancelled | cancelled | 无或未发布 |

---

## 12. 后端重构目录与职责

建议新增：

```text
backend/app/datasets/
  contracts.py
  schema_registry.py
  adapter_registry.py
  recipe.py
  compatibility.py
  integration.py
  publish.py
  outcomes.py
  runtime/
    executor.py
    attempts.py
    checkpoint.py
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
| `pipeline/runner.py` | 抽取可靠性内核到 `datasets/runtime/executor.py`；保留 Legacy wrapper |
| `pipeline/stages/discovery.py` | 来源发现逻辑迁到 Skills/Adapters；不再是全局 Stage |
| `pipeline/stages/acquisition.py` | 下载编排迁到 Adapter；复用安全下载与 SourceAsset |
| `pipeline/stages/processing.py` | 拆成 Adapter parser、Canonicalizer、Integrator；删除占位行 |
| `pipeline/stages/artifact_build/` | 改为 manifest-driven Publisher |
| `pipeline/stages/validation/` | 拆为 profile-driven Validation Engine |
| `domain/contracts/task.py` | 保留 V1；新增 DatasetRequestV2/BuildSpec |
| `domain/contracts/pipeline.py` | StageAttempt 逐步替换为 OperationAttempt/BuildAttempt |
| `domain/processing.py` | 删除旧内存 ParsedDataset |
| `tools/alignment.py` | 降级为映射候选工具；禁止直接正式合并 |
| `tools/cache_store.py` | 改成 Schema-aware Dataset Cache |
| `agent_loop/agent.py` | 改为数据集需求和来源规划 Prompt |
| `pipeline/tool.py` | 新增 Dataset Build 工具，旧工具作为兼容层 |
| `runtime/manager.py` | RunStatus 与 BuildOutcome 解耦 |

### 12.2 不建议使用 `Operator` 作为所有概念的统一名称

项目当前最需要清晰边界，而非泛化抽象。建议使用明确术语：

- `SourceAdapter`
- `Canonicalizer`
- `CompatibilityGate`
- `Integrator`
- `ValidationProfile`
- `Publisher`
- `BuildStep`

这比通用 `Operator` 更容易维护和测试。

---

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
4. 生成 DatasetBuildSpec
5. 调 validate_dataset_build_spec
6. 调 execute_dataset_build
7. 根据 BuildOutcome 汇报或生成新的 Build
```

### 14.2 建议工具接口

优先三个接口：

- `validate_dataset_request`
- `validate_dataset_build_spec`
- `execute_dataset_build`

可选增加：

- `list_dataset_schemas`
- `describe_source_adapter`
- `preview_dataset_source`

不要把所有来源特有参数继续平铺在一个 function tool 中。`source_bindings[].parameters` 应由 Adapter Schema 校验。

### 14.3 Prompt 关键规则

- 先定义数据集，再选数据库；
- 同一 Build 只能有一个 family/granularity；
- 复合请求拆分，不进行无依据宽表拼接；
- 文献、网页和图像是来源通道，不自动成为主数据行；
- Agent 不得传入自称来自论文的裸数字；
- 没有合法数据时返回 NO_DATA；
- 不要求机械查满所有数据库；覆盖度按相关数据源计算；
- 只选择能提供目标 Schema 字段的来源。

---

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
build_outcome_ready
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

删除通过错误字符串识别 no_data 的方式。后端直接返回 `BuildOutcome` 枚举及 reason code。

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

- 新增 DatasetRequest、DatasetBuildSpec、DatasetSchema、DataBatch、BuildOutcome；
- 注册 `gene_expression.long.v1`；
- 编写 Spec Validator；
- 不修改旧 Pipeline 执行。

验收：

- 复合请求可被拒绝或拆分；
- 缺 family/granularity 的规格不能执行；
- Adapter 参数通过正式 Schema 校验。

### Phase 2：抽取可信执行内核

工作：

- 从 `PipelineRunner` 抽取通用任务锁、Attempt、digest、checkpoint、超时、取消和事件逻辑；
- 定义 `BuildStep` 和受控 `BuildRecipe`；
- 用旧五阶段 Recipe 验证行为等价；
- `PipelineRunner` 变成 Legacy facade。

验收：旧测试主要保持通过；新 executor 能运行最小空壳 Recipe。

### Phase 3：实现表达数据 V2 Demo 链路

工作：

- Adapter 化 GDC 和 Xena；
- 实现文件型 canonicalization；
- 实现表达 Compatibility Gate；
- 实现显式 append/dedup 规则；
- 生成 DatasetManifest V2；
- 实现表达 Validation Profile；
- 不再依赖 `main_data.csv`。

验收：

- 单 GDC、单 Xena、兼容 GDC+Xena 均可生成合法主表；
- 不兼容单位/尺度会被拒绝；
- provenance 可抽样回溯；
- 重跑可复用成功步骤。

### Phase 4：修复空表和终态语义

工作：

- 删除 metadata-only 主表占位路径；
- 引入 BuildOutcome；
- Runtime 不再把“无 artifact”自动视为内部失败；
- 服务端保证终态摘要；
- 前端直接展示 NO_DATA/PARTIAL_SUCCESS；
- 增加诊断 artifact。

验收：

- 没有表达数据时无假主表；
- 会话仍给出明确原因和下一步；
- 空表不能以 SUCCEEDED 发布。

### Phase 5：迁移 GEO

工作：

- 将 GEO acquisition/parser 迁为 Adapter；
- 正式建模 platform、probe mapping、value scale 和 normalization；
- 只有通过 Compatibility Gate 的 GEO 数据才能与其他表达数据整合；
- 映射失败时保留独立来源诊断或 NO_DATA，不伪装 gene-level 数据。

验收：

- gene-level 与 probe-level 清楚区分；
- 无映射时发布策略明确；
- 测量尺度不兼容时不合并。

### Phase 6：Validation、Confidence、图表通道

工作：

- Profile 化 Validation；
- 实现 Confidence Contract；
- 为 VLM 图表点填充置信度、页码/bbox/model 元数据；
- 建立模型提取准入门禁；
- 通用 provenance coverage 统计。

验收：模型提取记录缺置信度或 source-of-record 时发布失败。

### Phase 7：Cache、前端和 API 完整迁移

工作：

- V2 Dataset Cache；
- Manifest-driven ResultsViewer；
- 通用 operation events；
- API 返回 BuildOutcome；
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
- `run_research_pipeline` 旧参数面。

---

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

- 用户自然语言 -> DatasetRequest；
- 选择来源及理由；
- DatasetBuildSpec；
- 下载和 SourceAsset；
- 字段映射、实体映射和单位说明；
- Compatibility Gate；
- 合并后的标准表；
- 每条记录或批次来源；
- Validation 报告；
- confidence/provenance 摘要；
- 一个来源失败时的 partial success；
- 无数据时不生成假表。

### 17.2 Demo 不应展示为核心

- 表达+突变+通路+文献混合大包；
- Agent 自由 DAG；
- 大量研究结论生成；
- 复杂统计分析；
- 与评分无直接关系的多 Agent 编排细节。

---

## 18. 测试策略

### 18.1 契约测试

- DatasetRequest 必填语义；
- family/granularity 与 Schema 一致；
- Adapter 参数 Schema；
- BuildOutcome 状态约束；
- Manifest 主数据引用闭合。

### 18.2 Adapter 合约测试

所有 Adapter 共享测试套件：

- 只读取成功 SourceAsset；
- 输出 DataBatch 的 family/granularity 正确；
- row count/hash 正确；
- Parser 版本存在；
- malformed 输入 fail closed；
- 不静默截断；
- 网络失败有明确错误码。

### 18.3 兼容性与集成测试

- family 不同拒绝；
- grain 不同拒绝；
- 单位不可转换拒绝；
- count 与 TPM 不静默合并；
- GDC/Xena 镜像重复处理；
- GEO probe mapping 不足拒绝或独立输出；
- 冲突记录进入报告。

### 18.4 Validation 测试

- 0 行主表不得 success；
- metadata 行不能满足表达完整性；
- 缺 provenance 拒绝；
- 低 confidence 模型值按策略拒绝；
- 原文件篡改导致失败；
- 原子发布失败不暴露半成品。

### 18.5 Runtime 测试

- 取消；
- timeout；
- checkpoint 重用；
- digest 变化触发重算；
- partial success；
- no data；
- execution failed；
- 事件重放；
- 服务端终态摘要始终存在。

### 18.6 前端测试

- Manifest 主数据识别；
- outcome 呈现；
- 主数据/辅助/诊断分类；
- confidence/provenance 展示；
- operation 事件；
- 老事件兼容；
- NO_DATA 不显示为红色内部错误。

---

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

1. Agent 能输出明确 DatasetRequest；
2. 一个 Build 只能对应一个 family/granularity；
3. GDC、Xena 表达数据通过 Adapter 和 Canonical Schema；
4. 合并前执行 Compatibility Gate；
5. 主数据不含 metadata-only 占位；
6. 0 行结果为 NO_DATA，不是 success；
7. 部分来源失败时能返回 PARTIAL_SUCCESS；
8. 每条或每批数据可追溯到 SourceAsset；
9. 字段映射、单位、归一化和版本可审计；
10. 模型提取数据有强制置信度；
11. Validation Profile 决定发布；
12. 原子发布、恢复、取消和摘要链能力不退化；
13. 前端从 manifest 识别主数据并显示 outcome；
14. 旧 Pipeline 可在迁移期运行，最终有明确删除计划；
15. 代表性成功、部分成功、无数据和失败案例均有自动化测试。

---

## 21. 首批实施任务清单

建议按以下顺序开工：

1. 建立完整可运行基线并保存四类 golden outputs；
2. 新增 `DatasetRequestV2`、`DatasetBuildSpec`、`DatasetSchema`、`BuildOutcome`；
3. 注册 `gene_expression.long.v1`；
4. 编写 Spec Validator 和 Compatibility Gate 单元测试；
5. 从 PipelineRunner 抽取通用 Attempt/checkpoint/timeout/cancel/event 机制；
6. 实现 GDC Expression Adapter；
7. 实现 Xena Expression Adapter；
8. 实现文件型 Canonicalizer 和显式 merge；
9. 实现 DatasetManifest V2 和表达 Validation Profile；
10. 删除 V2 路径中的 metadata-only 主表行为；
11. 接入 BuildOutcome 与终态摘要；
12. 前端增加 V2 manifest/outcome 展示；
13. 完成成功、partial、no-data、tamper/recovery Demo；
14. 再迁 GEO、Cache、Confidence 和图表通道。

该顺序优先建立正确数据契约和可演示闭环，避免继续向旧 Pipeline 增加数据库组合分支。