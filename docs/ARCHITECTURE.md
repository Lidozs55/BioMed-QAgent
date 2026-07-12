# BioMed-QAgent 架构设计

## 1. 项目定位

BioMed-QAgent 是基于 Qwen 与 OpenAI Agents SDK 的生物医学数据检索、下载、整理和呈现系统。

用户提供研究主题，并可限制允许检索的数据库。系统负责：

1. 检索和理解相关论文，整理可能的数据来源与检索方向；
2. 从用户允许或默认启用的数据库中检索并下载原始数据；
3. 解析本地文件，完成清洗、字段对齐和多来源合并；
4. 输出结构化数据、来源清单和处理记录；
5. 可选执行数据分析和可视化，但不生成缺少数据依据的科研或临床结论。

主产物是合并后的 CSV 及其来源和处理记录，而不是自然语言研究报告。

## 2. 已确认的架构原则

- OpenAI Agents SDK 是运行核心，继续使用 `Agent`、`Runner`、Function Tool、RunContext、Streaming、Session、Guardrail 和 HITL 等能力。
- 默认使用一个 Main Agent，不强制拆分多 Agent，也不自研另一套 Agent Runtime。
- 系统不是强制的“全 Skill 架构”。Skill 是按需加载的能力包，Tool 是实际执行单元。
- 所有 Skill 存放在统一 Skill 仓库中，按类别组织，并区分内置 Skill 与后天生成的 Skill。
- 一个网站通常对应一个或多个 Tool，而不是一个 Skill；同类网站及相近工作流可以归入同一个 Skill。
- Skill 宜少而清晰。每个 Skill 建议暴露约 20 个以内 Tool，超过 30 个必须拆分或重新评估。
- 下载与解析严格分离：下载 Tool 只检索、下载并记录元数据，不解析下载文件。
- 未知网站优先调用通用浏览器自动化 Tool；成功后可以生成后天 Skill 或网站 Tool 代码并保存演化记录。
- 用户指定数据库时不得静默访问未选择的数据库；论文调研可以提出建议，但扩大范围需要用户同意。

### 2.1 OpenAI Agents SDK 能力与项目边界

OpenAI Agents SDK 已经提供本项目需要的 Agent 运行骨架，因此没有必要再实现一套平行框架：

- `Agent` 与 `Runner` 管理模型调用循环、Tool 调用、最大轮次和最终结果；
- Function Tool 把 Python 函数暴露为带参数 Schema 的可调用工具；
- `RunContextWrapper` 在 Agent、Tool 和生命周期 Hook 之间传递任务级依赖与状态；
- `Runner.run_streamed()` 和 `stream_events()` 提供模型输出、Tool 调用和 Agent 更新事件；
- Session 可维护多轮历史，Guardrail 可校验输入、输出或 Tool 调用；
- HITL 可在敏感 Tool 执行前暂停，批准或拒绝后恢复运行；
- Handoff 与 `Agent.as_tool()` 支持按需拆分专家 Agent；
- 内置 tracing 可记录模型生成、Tool、Handoff 和 Guardrail，但使用非 OpenAI 模型时需要单独配置或关闭上传。

本项目当前通过 `AsyncOpenAI(base_url=DashScope)` 和 `OpenAIChatCompletionsModel` 接入 Qwen，并关闭 OpenAI tracing。Chat Completions 兼容路径与 Responses 路径的功能并不完全相同，因此只采用当前模型链路已验证支持的 SDK 能力。

SDK 不原生定义本项目所说的 Skill 仓库、数据库适配规范、任务文件目录或 Skill 自迭代流程。这些是建立在 SDK Function Tool 之上的项目层组织能力，不应扩展成另一套 Agent Runtime。

官方资料：

- [Agents](https://openai.github.io/openai-agents-python/agents/)
- [Running agents](https://openai.github.io/openai-agents-python/running_agents/)
- [Tools](https://openai.github.io/openai-agents-python/tools/)
- [Streaming](https://openai.github.io/openai-agents-python/streaming/)
- [Models and non-OpenAI providers](https://openai.github.io/openai-agents-python/models/)
- [Human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)
- [Tracing](https://openai.github.io/openai-agents-python/tracing/)

## 3. 当前运行架构

```text
Frontend
   │ WebSocket
   ▼
FastAPI
   ▼
Runner.run_streamed()
   ▼
Main Agent
   ├── 根据主题和数据库限制制定计划
   ├── 从 SkillRegistry 按需加载 Skill
   ├── 调用 Skill 提供的 SDK Function Tool
   └── 通过 RunContext 共享任务状态
          │
          ▼
   任务本地工作目录
   raw → parsed → normalized → artifacts
```

现有 `backend/app/agent_loop/`、`backend/app/tools/`、`backend/app/skills/` 和 WebSocket 结构继续保留并渐进扩展。

不引入以下强制层：

- 独立 `AgentRuntime` Port；
- 通用 `SkillExecutor`；
- `domain/application/ports/infrastructure` 四层架构；
- Tool 必须经过 SkillExecutor 才能调用的限制；
- 自研持久化工作流平台。

## 4. Agent、Skill 与 Tool

### 4.1 Main Agent

Main Agent 负责：

- 理解用户主题和限制；
- 判断是否先检索论文；
- 选择需要加载的 Skill；
- 生成查询式和执行顺序；
- 调用 Tool 并根据结果决定下一步；
- 在 API 失败时决定是否使用浏览器降级；
- 检查是否已经生成要求的结构化产物；
- 在关键歧义或高风险操作前请求用户确认。

简单任务可以直接调用已加载 Skill 中的 Tool。只有在单一 Agent 的 Prompt 或 Tool 集合过大时，才考虑使用 `Agent.as_tool()` 拆出专家 Agent。

### 4.2 Skill

Skill 是可发现、可选择、可加载的能力包。它主要包含：

- `name`：唯一名称；
- `category`：所属类别；
- `description`：供 Agent 判断何时使用；
- `instructions`：加载时附加给 Agent 的说明；
- `tools`：允许调用的 SDK Function Tool；
- `supported_sources`：支持的数据源或网站；
- `version`：版本；
- `enabled`：是否可用；
- 可选输入、输出模型和示例。

Skill 的 `description` 用于运行时选择。开发历史、使用效果和修复记录不放进 description，而由后天 Skill 的演化日志保存，避免无关内容进入模型上下文。

Skill 被加载后，Tool 仍由 OpenAI Agents SDK 直接执行，不经过额外执行引擎。

### 4.3 Tool

Tool 是 Agent 可以调用的底层或中层操作，包括但不限于：

- 关键词、文本和本地文件搜索；
- 数据库检索；
- 原始文件下载；
- 浏览器点击、输入、等待和下载；
- CSV、Excel、JSON、PDF、图表等文件解析；
- 缺失值、重复值和字段检查；
- 字段对齐、单位转换和多表合并；
- CSV、来源清单和可视化导出。

Tool 应有明确输入输出、可独立测试，并通过 `RunContextWrapper` 访问任务工作目录和共享状态。

### 4.4 网站与 Skill 的关系

- 一个已适配网站至少提供网站级 Tool，例如 `search_geo`、`describe_geo_dataset`、`download_geo_dataset`。
- 一个网站可以有多个 Tool，因为检索、查看元数据和下载是不同操作。
- 不建议一个网站建立一个 Skill；同类网站可以共享一个 Skill。
- 例如 `omics_data_acquisition` Skill 可以组织 GEO、GDC 和 UCSC Xena Tool，`structure_data_acquisition` Skill 可以组织 RCSB PDB Tool。

## 5. Skill 仓库

```text
backend/app/skills/
├── registry.py
├── builtin/
│   ├── discovery/
│   │   ├── literature_search/
│   │   └── literature_understanding/
│   ├── acquisition/
│   │   ├── biomedical_literature/
│   │   ├── omics_databases/
│   │   ├── structure_databases/
│   │   └── browser_fallback/
│   ├── processing/
│   │   ├── tabular_parsing/
│   │   ├── paper_data_extraction/
│   │   ├── data_cleaning/
│   │   └── schema_alignment/
│   └── analysis/
│       ├── statistics/
│       └── visualization/
└── learned/
    ├── discovery/
    ├── acquisition/
    ├── processing/
    └── analysis/
```

目录是人工维护和代码组织方式，`category` 是运行时检索字段。二者同时保留。

### 5.1 四类 Skill

#### Discovery

负责论文检索、论文理解、关键词扩展和数据来源方向发现。

论文相关能力是核心能力，不是附属功能：

- 检索 PubMed、Europe PMC 等文献源；
- 阅读题目、摘要、数据可用性声明和方法部分；
- 识别数据库名称、accession、补充材料和目标数据类型；
- 总结其他论文采用的数据检索方向；
- 为后续 acquisition 生成候选数据库、查询式和标识符。

#### Acquisition

负责检索数据库、获取元数据和下载原始文件。

第一批重点网站：

- GEO；
- GDC；
- UCSC Xena；
- RCSB PDB；
- PubMed / Europe PMC 论文全文和补充材料；
- 通用浏览器自动化降级。

Acquisition 只产生原始文件和下载记录，不产生解析后的 DataRecord。

#### Processing

负责本地原始文件处理，包括：

- 文件类型识别；
- CSV、TSV、Excel、JSON、HTML 表格解析；
- PDF 正文、表格、图像、图表和补充材料解析；
- GEO Series Matrix、SOFT、表达矩阵、PDB/mmCIF 等专业格式解析；
- 缺失、重复和异常格式检查；
- 字段对齐、单位转换、实体规范化和多来源合并；
- 生成结构化 CSV、字段说明和处理记录。

#### Analysis

分析属于加分项，后于数据闭环实现，包括：

- 描述性统计；
- 差异分析；
- 富集、网络等生物信息分析；
- 表格预览和可视化。

分析 Skill 只能消费已经解析和清洗的数据，不直接下载或修改原始文件。

## 6. 端到端数据流

```text
用户主题 + 允许数据库列表
        ↓
Main Agent
        ↓
Discovery Skill：论文检索与理解
        ↓
数据库、查询式、accession、补充材料候选
        ↓
Acquisition Skill：API/脚本检索与下载
        ↓ 失败或未知网站
Browser Fallback Tool
        ↓
task/raw/ 原始文件 + 下载记录
        ↓
Processing Skill：解析 → 清洗 → 对齐 → 合并
        ↓
task/artifacts/ CSV + 来源 + 字段说明 + 处理记录
        ↓
Analysis Skill（可选）
```

### 6.1 下载输出约定

下载 Tool 统一返回类似信息：

```text
source
accession
source_url
local_files
checksum
mime_type
format_hint
retrieved_at
warnings
```

`format_hint` 只用于帮助 Agent 选择解析 Skill，不代表文件已解析。

### 6.2 任务工作目录

```text
data/tasks/<task_id>/
├── raw/          # 不修改的下载文件
├── parsed/       # 解析结果
├── normalized/   # 清洗、对齐后的数据
├── artifacts/    # CSV、来源清单、说明和可视化
└── logs/         # Tool 调用、下载和 Skill 演化记录
```

## 7. 后天 Skill 与自迭代

### 7.1 触发条件

当出现以下情况时可以启动自迭代：

- 已知数据库 API 或预置 Tool 失效；
- 用户允许访问的数据库尚未适配；
- 页面必须通过浏览器交互才能检索或下载；
- Agent 使用浏览器成功完成了可重复的数据获取流程。

### 7.2 最小流程

```text
调用 browser_fallback
        ↓
完成页面检索与文件下载
        ↓
根据成功轨迹生成网站 Tool 或后天 Skill 代码
        ↓
保存到 skills/learned/<category>/<name>/
        ↓
写入 description 和 EVOLUTION.md
        ↓
至少执行一次相同目标的重放验证
        ↓
人工启用或保持 disabled
```

不引入 SiteRecipe 格式，也不要求复杂的自动晋升平台。

### 7.3 内置与后天 Skill

- `builtin/`：团队手工维护、默认可信、随源码发布；
- `learned/`：Agent 在运行中生成或更新，必须保留来源和效果记录；
- 后天 Skill 默认不覆盖同名内置 Skill；
- 后天 Skill 可以被禁用、修改或删除；
- 对代码类后天 Skill，至少需要语法检查、一次重放验证和人工启用。

### 7.4 EVOLUTION.md

Skill 的 description 足以支持运行时选择，但不足以说明自动生成代码的来源和效果。每个后天 Skill 使用一个简短 `EVOLUTION.md`，记录：

- 生成或修改时间；
- 目标网站和任务目标；
- 触发生成的 task/run；
- 生成或修改原因；
- 浏览器成功步骤摘要；
- 实际下载的文件类型和数量；
- 验证方法与结果；
- 后续使用次数、成功/失败情况；
- 人工修改说明和已知限制。

该日志默认不加载进 Agent 上下文，只用于维护、复盘和评估。

## 8. 用户数据库限制

- 用户可以显式选择允许检索的数据库；
- 未选择时使用默认数据库集合；
- SkillRegistry 根据用户选择过滤 acquisition Tool；
- Discovery 可以建议新数据库，但不能直接绕过选择；
- 如果建议的数据源不在允许列表中，Main Agent 请求用户确认后再加载对应 Skill；
- 前端应展示默认启用、用户启用和 Agent 建议三种状态。

## 9. 输出与来源追踪

MVP 至少输出：

- 主数据 CSV；
- 字段说明；
- 来源清单；
- 下载记录；
- 数据处理记录；
- 异常和警告；
- 可选分析和可视化产物。

每个最终记录至少关联原始数据源和本地 raw 文件。论文中提取的数据还应尽量记录 DOI/PMID、页码、表格、图像或补充材料位置。

## 10. 错误处理与安全

- API 或脚本失败后才能选择浏览器降级，并保留失败原因；
- 浏览器 Tool 不绕过登录、付费、验证码或网站明确的访问控制；
- 文件 Tool 只能访问当前任务目录；
- 下载必须限制协议、文件大小和超时；
- Tool 错误作为结构化结果返回 Agent，由 Agent 决定重试、降级或停止；
- 后天代码不得读取密钥、任意执行系统命令或访问任务目录之外的文件。

## 11. 测试策略

- Tool 单元测试：使用固定响应和本地样本，不依赖模型；
- 数据库集成测试：分别覆盖检索、元数据和下载，不混入解析；
- Processing 测试：使用已保存的 raw fixture；
- Skill 测试：检查按类别和数据源发现、按需加载及 Tool 数量；
- Agent 测试：检查选择正确 Skill、遵守数据库限制和生成要求产物；
- 自迭代测试：检查后天 Skill 保存位置、EVOLUTION.md、语法和重放结果；
- 前端测试：检查数据库选择、运行轨迹和 Artifact 下载。

## 12. 非目标

MVP 不实现：

- 强制全 Skill 执行链；
- 通用 SkillExecutor；
- 一个网站一个 Skill；
- SiteRecipe DSL；
- 后天 Skill 无验证自动启用；
- 强制多 Agent 或 Handoff；
- 自研 Agent Runtime；
- 复杂向量缓存和知识库；
- 科研影响力分析或自动生成科研结论。
