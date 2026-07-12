# BioMed-QAgent 开发 TODO

> 架构依据：[ARCHITECTURE.md](ARCHITECTURE.md)

## 0. 项目目标

用户输入研究主题，并可选择允许检索的数据库。系统基于 Qwen 和 OpenAI Agents SDK 自动完成：

1. 检索和理解相关论文；
2. 整理数据库、查询方向、accession 和补充材料线索；
3. 从允许的数据库检索并下载原始数据；
4. 解析本地文件；
5. 清洗、字段对齐和多来源合并；
6. 输出 CSV、字段说明、来源清单和处理记录；
7. 可选执行数据分析和可视化。

系统不输出缺少数据依据的科研或临床结论。

## 1. 优先级

| 优先级 | 含义 |
| --- | --- |
| P0 | 完成初赛可演示闭环所必需 |
| P1 | 明显提升可靠性、数据覆盖或展示效果 |
| P2 | 加分项或后续扩展 |

## 2. 架构约定

- [ ] **P0** 保留 OpenAI Agents SDK 作为运行核心
  - 使用 `Agent`、`Runner`、Function Tool、RunContext 和 Streaming；
  - 需要时使用 Session、Guardrail 和 HITL；
  - 不自研平行 Agent Runtime。
- [ ] **P0** 默认使用一个 Main Agent
  - 不强制多 Agent；
  - 只有 Prompt 或 Tool 集合过大时才使用 `Agent.as_tool()` 拆分专家 Agent。
- [ ] **P0** 使用统一 Skill 仓库
  - Skill 按需加载；
  - Skill 是 instructions 与 Tool 的能力包；
  - Tool 由 SDK 直接执行；
  - 不实现通用 SkillExecutor。
- [ ] **P0** 区分内置 Skill 和后天 Skill
  - `skills/builtin/` 存放团队维护的 Skill；
  - `skills/learned/` 存放自迭代产生的 Skill。
- [ ] **P0** 一个网站对应一个或多个 Tool，而不是默认对应一个 Skill
  - 网站检索、查看元数据、下载分别建 Tool；
  - 同类网站可以归入同一个 Skill。
- [ ] **P0** Skill 按四类组织
  - `discovery`：论文检索与理解；
  - `acquisition`：数据库检索与原始文件下载；
  - `processing`：解析、清洗、对齐和合并；
  - `analysis`：分析和可视化，加分项。
- [ ] **P0** 下载与解析严格分离
  - 下载 Tool 不读取数据内容并生成业务记录；
  - 下载 Tool 只保存原始文件、来源和下载元数据；
  - Processing Skill 从本地 raw 文件开始工作。

## 3. 当前状态

### 3.1 已有骨架

- [x] **P0** DashScope/Qwen OpenAI-compatible 模型接入骨架
- [x] **P0** OpenAI Agents SDK Main Agent 骨架
- [x] **P0** `Runner.run_streamed()` 流式运行骨架
- [x] **P0** SDK Function Tool 与 Tool 注册表骨架
- [x] **P0** `RunContext` 共享状态骨架
- [x] **P0** SkillRegistry 占位实现
- [x] **P0** FastAPI WebSocket 接口骨架
- [x] **P0** React 对话与 Tool Trace 页面骨架
- [x] **P0** `.env.example` 与 Qwen 基础配置

### 3.2 必须先修正

- [ ] **P0** 修正 Main Agent 产品提示词
  - 最终目标改为结构化数据和来源记录；
  - 移除必须生成研究报告、分析结果和结论的要求；
  - 明确分析为可选加分项。
- [ ] **P0** 修正 OpenAI Agents SDK 流式事件映射
  - 仅把文本 delta 推送为助手消息；
  - 正确处理 `run_item_stream_event`；
  - 正确推送 `tool_called` 和 `tool_output`；
  - 不把工具参数 delta 当成文本。
- [ ] **P0** 修正前端 WebSocket 所有权
  - 同一个连接实例负责连接、发送和关闭；
  - 修复页面显示已连接但发送端没有连接的问题。
- [ ] **P0** 修正前端构建配置
  - 修正 TypeScript `ignoreDeprecations`；
  - 确保 `src/lib/utils.ts` 被 Git 跟踪；
  - 统一使用 npm 或 pnpm 的一种锁文件和命令。
- [ ] **P0** 限制文件 Tool 只能访问当前任务工作目录
  - 拒绝绝对路径；
  - 拒绝 `..` 路径穿越；
  - 拒绝工作目录外符号链接。
- [ ] **P0** 使用 `uv.lock` 固定 SDK 和后端依赖

## 4. 用户输入与任务工作目录

### 4.1 用户输入

- [x] **P0** 定义最小输入
  - `topic`：唯一必填字段；
  - `preferred_sources`：允许检索的数据库；
  - `keywords`：可选；
  - `target_fields`：可选；
  - `time_range`：可选。
- [ ] **P0** 未指定数据库时加载默认数据库集合
  - > 注：`SkillRegistry.get_acquisition_skills(None)` 已支持，待 RunContext 接入
- [ ] **P0** 用户指定数据库时过滤 acquisition Tool
  - > 注：`SkillRegistry.get_acquisition_skills(user_sources)` 已支持，待 RunContext 接入
- [ ] **P0** Discovery Skill 可以建议新数据库，但扩大范围前必须确认
- [ ] **P1** 前端允许设置物种、疾病、基因、蛋白、药物和数据类型等过滤条件

### 4.2 RunContext

- [ ] **P0** 扩展 `RunContext`
  - `task_id`
  - `topic`
  - `preferred_sources`
  - `plan`
  - `sources`
  - `raw_assets`
  - `parsed_datasets`
  - `records`
  - `artifacts`
  - `warnings`
  - `query_log`
  - > 注：`context.py` 当前被 TASK-001 锁定，待解锁后扩展
- [ ] **P0** 不在 Context 中保存大文件内容
- [ ] **P0** Context 只保存本地路径和轻量元数据

### 4.3 工作目录

- [x] **P0** 每个任务创建独立目录

```text
data/tasks/<task_id>/
├── raw/
├── parsed/
├── normalized/
├── artifacts/
└── logs/
```

- [ ] **P0** `raw/` 中的下载文件保持不变
- [ ] **P0** 解析、清洗和导出产物不得覆盖原始文件

## 5. Skill 仓库

### 5.1 目录

- [x] **P0** 调整为统一仓库

```text
backend/app/skills/
├── registry.py
├── builtin/
│   ├── discovery/
│   ├── acquisition/
│   ├── processing/
│   └── analysis/
└── learned/
    ├── discovery/
    ├── acquisition/
    ├── processing/
    └── analysis/
```

### 5.2 SkillDef

- [x] **P0** 扩展 `SkillDef`
  - `name`
  - `category`
  - `description`
  - `instructions`
  - `tools`
  - `supported_sources`
  - `version`
  - `enabled`
  - 可选 `input_model`、`output_model` 和 examples
- [x] **P0** description 简洁说明何时使用 Skill
- [x] **P0** description 不包含开发日志和历史使用记录
- [x] **P0** 每个 Skill 建议暴露不超过约 20 个 Tool
- [x] **P1** 超过 30 个 Tool 时强制评审是否拆分

### 5.3 注册与按需加载

- [x] **P0** SkillRegistry 支持注册、查询和列出 Skill
- [x] **P0** 支持按 category 筛选
- [x] **P0** 支持按 supported source 筛选
- [x] **P0** 支持 enabled/disabled
- [x] **P0** 根据用户数据库选择过滤 acquisition Skill 和 Tool
- [ ] **P0** `create_agent()` 接收本次任务选中的 Skill
  - 合并 Skill instructions；
  - 合并并去重 Skill Tools；
  - 不把整个仓库全部加载给 Agent。
  - > 注：`build_agent_config()` 已实现合并/去重逻辑，待 `agent.py` 解锁后接入 `create_agent()`
- [x] **P0** 简单 Tool 在 Skill 加载后由 Main Agent 直接调用
- [ ] **P1** 需要专家上下文时把 Skill 构造成 `Agent.as_tool()`

## 6. Discovery：论文检索与理解

论文不仅用于背景调研，还用于发现数据库、accession、补充材料和可提取数据，属于核心能力。

### 6.1 论文检索

- [ ] **P0** 实现 `literature_search` Skill
- [ ] **P0** 接入 PubMed 或 Europe PMC
- [ ] **P0** 根据研究主题生成关键词和布尔检索式
- [ ] **P0** 保存实际查询式、时间、返回顺序和来源 URL
- [ ] **P0** 对 DOI、PMID、PMCID 和标题去重
- [ ] **P0** 返回题目、摘要、作者、期刊、时间、DOI/PMID/PMCID 和开放获取状态
- [ ] **P1** 同时接入 PubMed 与 Europe PMC 并合并结果
- [ ] **P1** 接入 Crossref 或 OpenAlex 补充元数据

### 6.2 论文理解与数据方向

- [ ] **P0** 实现 `literature_understanding` Skill
- [ ] **P0** 从摘要、方法和数据可用性声明中识别
  - 数据库名称；
  - accession；
  - 数据类型；
  - 物种和疾病；
  - 检索关键词；
  - 论文补充材料链接；
  - 数据下载页面。
- [ ] **P0** 总结相关论文采用的数据检索方向
- [ ] **P0** 将建议限制在用户允许或默认启用的数据源中
- [ ] **P0** 输出候选数据库、查询式、accession 和选择理由
- [ ] **P1** 对未启用数据源生成用户确认请求

### 6.3 论文文件和论文内数据

- [ ] **P0** 下载开放获取 PDF、全文 XML 和补充材料
- [ ] **P0** 保存 DOI/PMID/PMCID、下载 URL 和本地文件
- [ ] **P0** 论文下载仍属于 acquisition，不直接解析
- [ ] **P0** Processing 支持从全文 XML/HTML 和 CSV、TSV、Excel 等机器可读补充材料提取数据
- [ ] **P1** 支持 PDF 表格提取
- [ ] **P1** 支持图像、图表和扫描表格识别
- [ ] **P1** 对图表坐标轴、单位、图例和数据点执行校验
- [ ] **P1** 对低可信度论文数据请求人工确认
- [ ] **P0** 论文提取结果记录页码、表格号、图像区域或补充材料文件名

## 7. Acquisition：数据库检索与下载

### 7.1 统一约定

- [ ] **P0** 每个大网站至少实现以下网站级 Tool
  - search；
  - describe/metadata；
  - download。
- [ ] **P0** 下载 Tool 统一返回
  - `source`
  - `accession`
  - `source_url`
  - `local_files`
  - `checksum`
  - `mime_type`
  - `format_hint`
  - `retrieved_at`
  - `warnings`
- [ ] **P0** 下载 Tool 只写入 `task/raw/`
- [ ] **P0** 下载 Tool 不调用解析器
- [ ] **P0** 下载 Tool 不生成清洗后的 DataRecord
- [ ] **P0** 记录成功、部分成功、失败和浏览器降级状态
- [ ] **P0** 设置超时、重试、最大文件大小和并发限制

### 7.2 GEO

- [ ] **P0** 实现 GEO 数据集检索 Tool
- [ ] **P0** 返回 accession、标题、摘要、物种、平台、样本数和关联论文
- [ ] **P0** 支持下载 Series Matrix
- [ ] **P0** 支持下载 SOFT 或补充文件
- [ ] **P0** 保存 GEO 页面和实际下载 URL
- [ ] **P1** 支持按 GSE、GSM、GPL 等标识符进一步获取文件

### 7.3 GDC

- [ ] **P0** 实现 GDC 项目、病例和文件检索 Tool
- [ ] **P0** 支持按癌种、项目、数据类型和工作流过滤
- [ ] **P0** 支持下载 manifest 或目标公开文件
- [ ] **P0** 保存项目、case/file ID 和数据类别元数据

### 7.4 UCSC Xena

- [ ] **P0** 实现 cohort 与 dataset 检索 Tool
- [ ] **P0** 支持下载公开矩阵和表型/临床元数据
- [ ] **P0** 保存 hub、cohort、dataset 和下载 URL

### 7.5 RCSB PDB

- [ ] **P0** 实现结构条目检索 Tool
- [ ] **P0** 支持按蛋白、基因、物种和关键词检索
- [ ] **P0** 支持下载 PDB 或 mmCIF
- [ ] **P0** 保存 PDB ID、结构元数据和来源 URL

### 7.6 浏览器降级

- [ ] **P0** 实现通用浏览器自动化 Tool
- [ ] **P0** 仅在 API/脚本不可用、网站未知或页面交互必要时启用
- [ ] **P0** 支持导航、输入、点击、等待和文件下载
- [ ] **P0** 记录目标 URL、关键操作、下载结果和错误
- [ ] **P0** 下载文件仍写入 `task/raw/`
- [ ] **P0** 不绕过登录、付费、验证码或明确访问控制

## 8. Processing：解析、清洗与对齐

### 8.1 文件识别和解析

- [ ] **P0** 根据扩展名、MIME 和文件内容识别格式
- [ ] **P0** 解析 CSV 和 TSV
- [ ] **P0** 解析 Excel
- [ ] **P0** 解析 JSON
- [ ] **P0** 解析 HTML 表格
- [ ] **P0** 解析 GEO Series Matrix 或 SOFT 的最小字段
- [ ] **P0** 解析 PDB/mmCIF 基础结构元数据
- [ ] **P1** 解析 HDF5、压缩矩阵和其他组学格式
- [ ] **P1** 解析 PDF 正文和表格
- [ ] **P1** 多模态解析图表和图像

### 8.2 ParsedDataset

- [ ] **P0** 解析结果统一包含
  - 数据集 ID；
  - 原始文件路径；
  - 表、Sheet 或区块名称；
  - 字段名和推断类型；
  - 数据行；
  - 来源定位；
  - 解析器名称和版本；
  - warnings。
- [ ] **P0** 解析结果写入 `task/parsed/`

### 8.3 清洗

- [ ] **P0** 缺失值统计
- [ ] **P0** 精确重复检测
- [ ] **P0** 字符串和日期格式规范化
- [ ] **P0** 字段类型检查
- [ ] **P0** 异常格式标记
- [ ] **P0** 清洗规则记录影响行数
- [ ] **P0** 不静默删除或覆盖原始记录
- [ ] **P1** 近似重复检测

### 8.4 字段对齐与合并

- [ ] **P0** 字段名标准化
- [ ] **P0** 单位识别与转换
- [ ] **P0** 生成字段映射表
- [ ] **P0** 支持纵向合并
- [ ] **P0** 支持按主键连接
- [ ] **P0** 保留来源列和冲突值
- [ ] **P0** 无法可靠判断的字段映射请求人工确认
- [ ] **P1** 实体名称归一化
- [ ] **P1** 来源冲突检测

## 9. Analysis：加分项

- [ ] **P1** 描述性统计摘要
- [ ] **P1** 数据分布和缺失情况可视化
- [ ] **P1** 简单表格预览和字段筛选
- [ ] **P2** 差异表达分析
- [ ] **P2** 富集分析
- [ ] **P2** PPI 或网络分析
- [ ] **P2** 热图、火山图、网络图等可视化
- [ ] **P1** Analysis Skill 只读取 normalized 数据
- [ ] **P1** Analysis Skill 不修改 raw 和 parsed 文件
- [ ] **P1** 输出中区分数据统计与科研结论

## 10. 后天 Skill 与自迭代

### 10.1 触发与生成

- [ ] **P1** 预置 Tool 无法处理网站时调用浏览器 Tool
- [ ] **P1** 浏览器成功完成可重复任务后生成网站 Tool 或后天 Skill 代码
- [ ] **P1** 后天 Skill 保存到 `skills/learned/<category>/<name>/`
- [ ] **P1** 后天 Skill 具有完整 description
- [ ] **P1** 后天 Skill 不覆盖同名内置 Skill
- [ ] **P1** 后天 Skill 默认可禁用
- [ ] **P1** 不引入 SiteRecipe DSL

### 10.2 EVOLUTION.md

- [ ] **P1** 每个后天 Skill 创建 `EVOLUTION.md`
- [ ] **P1** 记录生成或修改时间
- [ ] **P1** 记录目标网站和任务目标
- [ ] **P1** 记录来源 task/run
- [ ] **P1** 记录生成或修改原因
- [ ] **P1** 记录浏览器成功步骤摘要
- [ ] **P1** 记录下载文件类型和数量
- [ ] **P1** 记录验证方法和结果
- [ ] **P1** 记录后续使用成功和失败情况
- [ ] **P1** 记录人工修改和已知限制
- [ ] **P1** EVOLUTION.md 默认不加载到 Agent 上下文

### 10.3 代码验证

- [ ] **P1** 后天 Python 代码通过语法检查
- [ ] **P1** 至少用相同目标重放一次
- [ ] **P1** 检查输出文件存在、非空且类型符合预期
- [ ] **P1** 检查代码不读取密钥或任务目录外文件
- [ ] **P1** 检查代码不包含任意系统命令执行
- [ ] **P1** 人工启用、禁用和删除后天 Skill

## 11. 输出与来源追踪

- [ ] **P0** 输出主数据 CSV
- [ ] **P0** 输出字段说明
- [ ] **P0** 输出来源清单
- [ ] **P0** 输出下载记录
- [ ] **P0** 输出处理记录
- [ ] **P0** 输出 warnings 和未解决问题
- [ ] **P0** 每条最终记录至少关联原始数据源和 raw 文件
- [ ] **P0** 每个转换记录 Tool、参数和影响记录数
- [ ] **P0** 论文提取数据记录 DOI/PMID 和原始位置
- [ ] **P1** 支持 Excel、Parquet 或 JSON 辅助产物
- [ ] **P1** 支持从最终记录反查原始文件
- [ ] **P1** 输出可视化 Artifact

## 12. API 与前端

### 12.1 WebSocket

- [ ] **P0** 接收主题和数据库选择
- [ ] **P0** 推送 Agent 文本增量
- [ ] **P0** 推送 Skill 加载事件
- [ ] **P0** 推送 Tool 调用和结果
- [ ] **P0** 推送下载文件和 Artifact 事件
- [ ] **P0** 推送人工确认请求
- [ ] **P0** 推送完成和失败事件
- [ ] **P1** 自动重连和任务恢复

### 12.2 HTTP API

- [ ] **P0** 获取可选数据库和默认选择
- [ ] **P0** 查询任务状态
- [ ] **P0** 获取 Artifact 列表
- [ ] **P0** 下载 Artifact
- [ ] **P1** 提交人工确认结果
- [ ] **P1** 取消任务

### 12.3 前端

- [ ] **P0** 输入研究主题
- [ ] **P0** 显示数据库列表并允许勾选
- [ ] **P0** 区分默认、用户选择和 Agent 建议的数据源
- [ ] **P0** 展示 Agent 文本
- [ ] **P0** 展示 Skill 和 Tool 运行轨迹
- [ ] **P0** 展示已下载文件
- [ ] **P0** 展示和下载 CSV、来源清单和处理记录
- [ ] **P1** 展示字段说明和表格预览
- [ ] **P1** 展示人工确认界面
- [ ] **P1** 展示分析和可视化结果

## 13. 测试、安全与复现

### 13.1 SDK 与 Agent

- [ ] **P0** Qwen 普通文本测试
- [ ] **P0** Qwen 流式文本测试
- [ ] **P0** 单 Tool 调用测试
- [ ] **P0** 连续 Tool 调用测试
- [ ] **P0** 结构化输出测试
- [ ] **P0** SDK 事件映射测试
- [ ] **P0** 最大轮数、超时和模型错误测试

### 13.2 Skill

- [ ] **P0** Skill 注册和查询测试
- [ ] **P0** 按 category 筛选测试
- [ ] **P0** 按数据库筛选测试
- [ ] **P0** enabled/disabled 测试
- [ ] **P0** 按需加载后不出现未选择数据源的 Tool
- [ ] **P0** Main Agent 选择正确 Skill 的代表性测试

### 13.3 Acquisition

- [ ] **P0** 每个网站分别测试 search、describe 和 download
- [ ] **P0** 断言下载 Tool 不调用解析器
- [ ] **P0** 断言下载文件写入 raw 目录
- [ ] **P0** API 失败和浏览器降级测试
- [ ] **P0** 超时、重试、限流和下载大小测试
- [ ] **P0** SSRF、危险协议和云元数据地址测试

### 13.4 Processing

- [ ] **P0** 使用本地 raw fixture 测试解析
- [ ] **P0** 字段类型测试
- [ ] **P0** 缺失、重复、单位和字段对齐测试
- [ ] **P0** 来源追踪测试
- [ ] **P0** CSV 导出测试
- [ ] **P0** 清洗前后记录数和规则回归测试

### 13.5 工程

- [ ] **P0** Backend pytest
- [ ] **P0** Frontend TypeScript check
- [ ] **P0** Frontend build
- [ ] **P1** Frontend component tests
- [ ] **P1** CI 自动运行离线测试
- [ ] **P1** 定时运行真实数据源集成测试
- [ ] **P0** README 提供安装、配置、启动和测试命令

## 14. 推荐迭代顺序

### Sprint 0：修好现有 SDK 闭环

- [ ] 修正 Main Agent Prompt
- [ ] 修正 SDK 流式事件
- [ ] 修正前端 WebSocket
- [ ] 修正文件路径安全
- [ ] 建立 Backend/Frontend 基础测试

验收：前端输入主题后，Agent 可以调用占位 Tool，并正确显示文本和 Tool Trace。

### Sprint 1：论文与一个真实数据库

- [ ] 完成 Skill 仓库最小实现
- [ ] 完成 PubMed 或 Europe PMC
- [ ] 完成 GEO 检索和下载
- [ ] 完成任务 raw 目录和下载记录
- [ ] 完成 CSV/TSV 解析和 CSV 导出

验收：自然语言主题可以产生论文线索、GEO 原始文件、CSV 和来源清单。

### Sprint 2：多数据库和数据处理

- [ ] 完成 GDC、UCSC Xena 和 RCSB PDB
- [ ] 完成论文补充材料获取
- [ ] 完成 Excel、JSON、HTML 和专业格式解析
- [ ] 完成清洗、字段对齐和多来源合并
- [ ] 前端展示数据库选择和 Artifact

验收：至少两个数据库的数据可以合并，并追溯至原始文件。

### Sprint 3：浏览器、自迭代和质量

- [ ] 完成浏览器降级案例
- [ ] 生成并保存一个后天 Skill 或网站 Tool
- [ ] 写入并展示 EVOLUTION.md 记录
- [ ] 完成人工确认和质量问题展示
- [ ] 完成第二案例或异常案例

验收：未知或变化网站可以通过浏览器下载数据，并将成功流程沉淀到 learned Skill。

### Sprint 4：加分项和比赛材料

- [ ] 论文表格或图表数据提取案例
- [ ] 一个 Analysis Skill 和可视化案例
- [ ] 对照实验与指标
- [ ] 技术报告、PPT/PDF 和演示缓存
- [ ] 本地复现检查

## 15. MVP 完成标准

- [ ] 用户可以输入主题并选择数据库
- [ ] Main Agent 按需加载 Skill，而不是加载整个 Skill 仓库
- [ ] 系统可以检索和理解相关论文
- [ ] 系统可以从论文识别数据库、accession 或补充材料
- [ ] 系统接入至少一个文献源
- [ ] 系统接入至少两个专业数据库，其中包含 GEO
- [ ] 每个专业数据库具有独立 search/describe/download Tool
- [ ] 下载 Tool 不负责解析
- [ ] API/脚本失败时至少有一个浏览器降级案例
- [ ] 系统至少解析两种文件格式
- [ ] 系统完成缺失、重复和字段格式检查
- [ ] 系统完成字段对齐和至少一次多来源合并
- [ ] 系统输出主数据 CSV
- [ ] 系统输出字段说明、来源清单、下载记录和处理记录
- [ ] 每条最终记录可以追溯到原始数据源和本地 raw 文件
- [ ] 前端展示 Agent、Skill、Tool 和 Artifact
- [ ] 主案例可以在个人电脑上稳定复现
- [ ] 后端和前端验证命令通过

## 16. 后续扩展

### P1

- 更多论文源和全文获取方式
- PDF 表格和图表解析
- 更多专业数据库
- 人工确认和中断恢复
- 后天 Skill 使用统计和自动修复建议
- 内容哈希缓存和重复下载复用

### P2

- 差异表达、富集和网络分析
- 高精度图表数据提取
- 多模态交叉校验
- 向量检索和本地知识索引
- 多任务并行
- 后天 Skill 自动评测和版本回滚
- 知识图谱或影响力分析
