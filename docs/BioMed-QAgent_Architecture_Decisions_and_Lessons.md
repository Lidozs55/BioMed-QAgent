# BioMed-QAgent 顶层设计决策、讨论记录与踩坑复盘 V2

> 文档性质：架构决策记录（ADR 汇总）与项目复盘 V2  
> 形成日期：2026-08-06  
> 输入依据：当前代码仓库、赛题说明、历史 Review/Survey，以及本轮关于 Pipeline、DAG、Recipe、状态和产物边界的讨论  
> 用途：约束后续设计，解释为什么改变方向，防止团队再次沿错误抽象继续扩张  
> V2 变更：删除正式 DatasetRequest 和 BuildRecipe，明确 WorkflowRecipe 仅服务 Acquisition，并拆分 RunStatus、BuildResult、ValidationResult 与 DatasetPublication
> ADR 序列续篇：Pi 迁移的 ADR-017 至 ADR-024 使用独立记录，见 [ADR 索引](adr/README.md)。

---

## 1. 最终结论

项目的核心目标已经重新确认：

> BioMed-QAgent 不是以“完成一项完整科研研究”为中心的通用 Research Agent，而是以“从科学问题或数据需求构建可用标准化数据集”为中心的生物医学数据检索、解析、清洗、字段对齐、整合与追溯系统。

最终主产物应描述同一数据域中可比较、可合并的记录。多源异构指来源和载体异构，例如数据库、论文表格、附件、网页和图表，不代表必须将表达、突变、通路、临床和文献元数据强行放进同一张表。

一个正式 DatasetBuild 由自包含 `DatasetBuildSpec` 定义，必须明确：

- 目标和实体范围；
- 数据集族；
- 行粒度；
- Canonical Schema；
- 键和去重语义；
- 测量、单位和归一化语义；
- 来源绑定及其内置或 WorkflowRecipe 获取方式；
- 合并策略；
- 服务端 Validation Profile 引用。

当前固定五阶段 Pipeline 不应整体删除。应保留其可靠执行能力，替换其错误的业务中心：从固定数据库组合和固定 `main_data.csv`，转向数据集契约驱动的 Dataset Construction Runtime。

---

## 2. 讨论演进记录

### 2.1 初始判断：移除固定 Pipeline，改成 Research DAG

最初审计认为：

- `main_data.csv` 无法承载表达、突变、通路、文献等不同角度数据；
- 固定五阶段限制 Agent 的研究自由；
- 应改为 ResearchPlan + Operator DAG + Artifact Package；
- 产物可以包含多个表、图片、网络、PDF 和关系。

这套判断指出了真实问题：固定流程和固定主表确实限制扩展；确定性执行、血缘、验证和原子发布也确实必须保留。

但它把产品边界推向了“通用科研工作台”，没有先回答赛题究竟要求整理什么。

### 2.2 第二阶段：评估 DAG 是否必要

审查代码后确认：

- 当前项目已经有成熟 Runtime，不缺调度基础；
- DAG 能表达多来源并行和依赖，但完整 DAG Engine 会引入额外调度、重试传播、局部失败、循环验证和图版本成本；
- 比赛 Demo 的评分不取决于 DAG；
- 当前任务可用服务端固定构建骨架和来源 fan-out/fan-in 表达。

阶段结论：保留依赖与恢复思想，不实现完整 DAG，也不新增 Agent 可声明的通用构建 Recipe。

### 2.3 关键纠偏：赛题核心不是多角度研究包

进一步对照 `PROBLEM.md` 后确认：

- 赛题强调查找、解析、清洗、字段对齐、来源标注和合并 CSV；
- 论文、数据库、表格、附件和图像是多种来源载体；
- 评价对象是可分析、可追溯、可复用的数据整合结果；
- 因此核心应是“同类数据的跨源整合”，而不是“同一研究对象的所有角度资料集合”。

这意味着此前多表 Artifact Package 方向并非完全错误，但不应成为系统核心。主抽象应从 ResearchPlan 收缩为自包含 `DatasetBuildSpec`。

### 2.4 第二次抽象收缩：避免 V2 再造冗余层

V1 重构提案随后暴露五个问题：

- `DatasetRequest` 与 `DatasetBuildSpec` 重复；
- 新 `BuildRecipe` 与仓库已有 `WorkflowRecipe` 重叠；
- Artifact 验证状态与 Run 业务终态混为一谈；
- 发布门禁清单混入 Validator 实现细节；
- 辅助数据按具体文件名建模，顶层协议过重。

因此 V2 进一步收缩：

- Agent 直接产出自包含 DatasetBuildSpec；
- Dataset Runtime 使用服务端固定构建骨架；
- WorkflowRecipe 只负责 Acquisition 并产出 SourceAsset；
- RunStatus、BuildResult、ValidationResult 和 DatasetPublication 正交；
- 架构层只保留 provenance closure、Profile passed、atomic promotion 三项发布不变量；
- Manifest 按 Artifact Role 分类，不固定审计文件清单。

### 2.5 当前定稿方向

- 保留主数据集理念；
- 删除固定 22 列万能主表假设；
- 每个 Build 一个 dataset family 和 row grain；
- 支持 supporting dataset、schema、provenance 和 audit report，但不混淆主数据；
- 用 Adapter、Schema、Normalization Profile、Compatibility Gate、Validation Profile 扩展；
- Agent 负责意图和来源规划，服务端控制数据值、验收阈值与发布；
- 无数据时返回 NO_DATA，不用元数据占位；
- 不引入完整 DAG 或 BuildRecipe；
- 保留并补齐 WorkflowRecipe 的受控来源获取闭环。

## 3. ADR-001：产品边界是数据集构建，不是完整科研代理

### 状态

已接受。

### 决策

系统的首要任务是根据用户研究目标或数据需求，构建标准化可用数据集。研究解释、机制分析、假设生成和多角度证据汇总可以作为上层能力，但不能决定底层主数据结构。

### 原因

1. 与赛题评分项直接对应；
2. 产物价值更容易展示和验收；
3. 数据清洗、字段统一、来源追踪和置信度都有明确落点；
4. 可控制 Demo 范围；
5. 避免 Agent 因“研究全面性”搜索大量无法整合的来源。

### 后果

Agent Prompt、工具接口、契约、前端结果页和 Demo 叙事都需要从“研究项目经理”改为“数据集需求解析与来源规划”。

---

## 4. ADR-002：一个 DatasetBuild 只能有一个主数据集族和一种行粒度

### 状态

已接受。

### 决策

一个 Build 的主数据必须满足：

```text
dataset_family + row_granularity + key_semantics + measurement_semantics
```

均明确且兼容。

### 示例

可以合并：

- 多来源 gene-sample expression；
- 多论文中采用同一指标和同一对象粒度的实验测量；
- 多数据库的 pathway-member 记录。

不能直接合并：

- 表达行与突变事件行；
- 基因-样本测量与队列聚合统计；
- 文献元数据与表达测量；
- 通路节点与临床样本；
- 原始 count 与 TPM，除非明确转换或保持可区分语义。

### 复合需求

复合需求拆成多个 Build。会话可将多个 Build 放在同一任务下，但每个 Build 独立验证和发布。

### 后果

`main_data.csv` 的“单一行粒度”原则保留，但文件名、列结构和数据族不再固定。

---

## 5. ADR-003：保留可信执行内核，不保留固定五阶段业务状态机

### 状态

已接受。

### 保留

- SourceAsset；
- DownloadAttempt；
- 文件 hash；
- Attempt 输入/参数/输出摘要；
- 任务锁；
- checkpoint；
- timeout/cancel；
- durable event；
- staging；
- Validation Gate；
- atomic publication；
- fixture/live 区分。

### 替换

- `_STAGES` 全局固定列表；
- `StageName` 作为业务主协议；
- 固定数据库组合；
- `StageAttempt` 的阶段专属语义；
- 固定 Artifact 文件集合；
- 固定验证顺序。

### 理由

可靠性能力本身正是赛题的来源追踪、可复现和错误修正基础。直接删除 Pipeline 会丢失最有价值的实现资产。

---

## 6. ADR-004：不采用完整 DAG，也不新增 BuildRecipe

### 状态

已接受，除非未来需求发生显著变化。

### 决策

Dataset Runtime 使用服务端固定、可测试的构建骨架：

```text
acquire[*]
  -> parse[*]
  -> canonicalize[*]
  -> compatibility gate
  -> integrate
  -> validate profile
  -> publish
```

来源步骤可以内部并发。Runtime 记录 OperationAttempt、输入输出 digest 和恢复点，但 Agent 不自由生成 nodes/edges，也不声明数据集级 Recipe。

### 与现有 WorkflowRecipe 的关系

仓库已有 `WorkflowRecipe`，其步骤限定为受控 API、HTML 和 Browser 操作，并拒绝 Python、JavaScript、Shell 等任意代码字段。它保留，但边界限定为 Acquisition：

```text
SkillBuilderAgent
  -> WorkflowRecipe draft
  -> controlled validation
  -> VERIFIED/PROMOTED
  -> RecipeExecutor
  -> SourceAsset
  -> SourceAdapter
```

WorkflowRecipe 不能：

- 产生 Canonical DataBatch；
- 声明跨来源依赖；
- 决定合并；
- 选择 Validation Profile 或阈值；
- 直接发布 Dataset。

“non-executable”只表示 Recipe 不包含任意可执行代码，不表示 Recipe 不会由可信解释器执行。

### 当前代码缺口

当前 `RecipeExecutor.execute()` 和 `find_verified()` 主要面向 `VERIFIED`，而 `PROMOTED` Recipe 的正式发现和执行闭环不明确。V2 要求：

- `PROMOTED`：生产 Build 可自动发现和执行；
- `VERIFIED`：仅受限试用或 HIL 确认；
- `DRAFT/REJECTED`：不得进入生产执行。

### 为什么不使用 DAG 或 BuildRecipe

- 当前流程主体近似线性；
- 并行来源不等于需要通用图调度器；
- 完整 DAG 增加大量基础设施，不直接提高评分；
- 新增 BuildRecipe 会与 WorkflowRecipe 命名和生命周期冲突；
- 代码当前真正缺少的是数据契约、兼容性判断和 Recipe 消费闭环，不是图执行。

### 重新评估触发条件

只有当用户自定义任意分析链、多级条件分支、节点复用和分布式执行成为核心需求时，才重新评估 DAG。

## 7. ADR-005：主数据通过 Manifest 识别，不依赖固定文件名

### 状态

已接受。

### 决策

输出包含一个 `dataset_manifest.json`，其中显式标识：

- 主数据路径；
- dataset family；
- row grain；
- Schema；
- 主键；
- 行数和 hash；
- 来源、验证、置信度和 provenance 摘要。

可为 Demo 提供 `dataset.csv`，但程序不得硬编码该文件名。

### 影响

需要迁移：

- Artifact Builder；
- Validation；
- Cache；
- API；
- 前端 ResultsViewer；
- 测试 fixture；
- 文档。

---

## 8. ADR-006：Manifest 按 Artifact Role 分类，主数据不能混粒度

### 状态

已接受。

### 决策

Manifest 只定义五类稳定角色：

- `primary_dataset`
- `supporting_dataset`
- `schema`
- `provenance`
- `audit_report`

样本元数据、实体映射、来源选择、被拒记录、质量报告、搜索报告、warning 和下载审计均映射到这些角色，不在顶层架构固定各自文件名。

`SourceAsset` 保持独立身份，Manifest 引用其 ID。Publisher 可根据规模和展示需要，将同一角色拆成一个或多个物理文件。

多表并不代表回到“多角度研究包”。Supporting dataset 和审计产物服务主数据解释、映射、复算或质量审查，不与主表争夺业务中心。

### 特殊情况

如果数据天然是关系型结构，可有主事实表和维表，但必须显式建模关系、主表角色、family 和 row grain。

## 9. ADR-007：Agent 决定计划，不决定科研数据值

### 状态

已接受。

### Agent 权限

- 解析需求；
- 选择或建议 Schema；
- 查找候选来源；
- 选择 Acquisition Provider、Adapter 或已允许的 WorkflowRecipe；
- 提议字段映射；
- 直接生成自包含 DatasetBuildSpec；
- 根据诊断重新规划。

### 服务端权限

- 下载和校验文件；
- 运行 Parser；
- 读取源值；
- 执行确定性转换；
- 批准字段映射；
- 判断兼容性；
- 管理验收阈值与 Validation Profile；
- 计算质量和置信度；
- 发布。

### 禁止

Agent 不能直接提交一个数字并声明它来自论文、图表或数据库。模型提取必须绑定 SourceAsset、定位信息、模型版本、置信度和审核状态。

---

## 10. ADR-008：来源是否可用与数据是否可合并是两个维度

### 状态

已接受。

### 决策

保留来源安全和能力 allowlist，但移除“来源集合等于合并兼容性”的设计。

当前 `SUPPORTED_PIPELINE_SOURCE_COMBINATIONS` 将来源组合当成正式能力边界。重构后需要两层判断：

1. Adapter capability：系统能否安全获取和解析该来源；
2. Dataset compatibility：本次数据能否映射至目标 Schema 并合并。

例如，GDC 和 Xena 都可用，不代表任意 GDC 数据与任意 Xena 数据可合并。

---

## 11. ADR-009：字段字符串相似度只能提议映射，不能批准映射

### 状态

已接受。

### 决策

正式字段映射必须来自：

- Adapter 声明；
- Schema Registry；
- 可信元数据；
- 明确规则；
- 人工批准。

字符串相似度可生成候选和置信度，但默认状态为 `proposed`。

### 原因

列名相似无法证明：

- 同一语义；
- 同一单位；
- 同一粒度；
- 同一值域；
- 同一实体 ID；
- 一对一关系。

### 当前踩坑

`alignment.py` 的包含关系和公共前缀规则足以将看似相似、实际不同的字段对齐。之后垂向合并会让错误进入正式数据。

---

## 12. ADR-010：RunStatus、BuildResult、ValidationResult 与 Publication 正交

### 状态

已接受。

### 决策

四个状态体系分别回答不同问题：

| 概念 | 回答问题 | 典型值 |
| --- | --- | --- |
| `RunStatus` | 执行是否排队、运行、完成、失败或取消 | QUEUED/RUNNING/COMPLETED/FAILED/CANCELLED |
| `BuildResult` | 正常完成后得到什么数据结果 | SUCCEEDED/PARTIAL_SUCCESS/NO_DATA/SPEC_REJECTED |
| `ValidationResult` | 某个 Manifest digest 是否通过 Profile | PASSED/FAILED |
| `DatasetPublication` | 哪个不可变版本已正式提升 | publication ID + supersedes |

只有 `RunStatus=COMPLETED` 才产生 `BuildResult`。执行异常和用户取消不再重复表示为 `EXECUTION_FAILED` 或 `CANCELLED` BuildResult。

不使用 `validated_intermediate` / `validated_final`。每次成功发布都生成不可变 Publication，后续版本使用 `supersedes_publication_id` 关联。任务或会话只维护 `current_publication_id`。

### 结果

- 无主数据不再必然触发内部失败；
- 前端不通过错误字符串猜 no_data；
- 无数据时可以交付审计型 Publication；
- 内部异常仍然是 failed；
- 用户始终收到服务端生成的 RunSummary；
- 新版本不会改变旧 Artifact 的状态。

## 13. ADR-011：禁止 metadata-only 占位主表

### 状态

已接受，列为 P0。

### 当前问题

GEO 没有表达矩阵时，当前代码将样本元数据写成 `measurement_type=sample_metadata` 的表达 Schema 行，并在 Validation 中跳过表达值和 lineage 检查。

这解决了“空表”表象，却破坏了主数据语义。

### 决策

- 主表无合法记录时 outcome 为 NO_DATA；
- 样本元数据保存在辅助表；
- Validation 不允许 warning 或特殊字段豁免目标数据不存在；
- 空主表不发布为 succeeded；
- 可发布来源搜索和拒绝报告。

---

## 14. ADR-012：Validation 由 Profile 驱动，架构层只保留三项发布不变量

### 状态

已接受。

### 决策

架构层只规定：

1. **Provenance closure**：正式记录可追溯到 SourceAsset、源定位、Parser/Adapter 版本、映射和转换；
2. **Validation Profile passed**：与目标 Manifest digest 对应的 Profile 判定通过；
3. **Atomic promotion**：只有引用闭合且 staging 完整的已验证 Manifest 才能原子提升。

具体规则属于版本化 Validation Profile，例如：

- 文件编码和列数稳定；
- Schema、类型和主键；
- measurement 完整率；
- 单位、尺度和归一化；
- warnings 与 metrics 一致；
- probe mapping 覆盖率；
- bbox、模型版本和 confidence；
- NO_DATA 或 PARTIAL_SUCCESS 的阈值。

Agent 只能选择服务端允许的 Profile 引用，不能在 BuildSpec 中传入 `minimum_valid_rows`、`allow_empty_primary_dataset` 等 acceptance policy。

### 测试策略

测试应锁定三项架构不变量和 Profile 结果，不应依赖全局 `check_id` 固定顺序，也不应把某个数据族的具体列规则提升为全局架构。

## 15. ADR-013：置信度先做可解释等级，不做虚假概率

### 状态

已接受。

### 决策

置信度包含：

- level：high/medium/low；
- channel；
- reasons；
- source reliability；
- extraction reliability；
- mapping reliability；
- validation result；
- cross-source consistency；
- human review state。

确定性官方 API 可以使用批次默认等级；VLM/LLM/网页抽取必须逐条标注。

### 原因

未经标定的 0.92 看似精确，实际没有概率解释。赛题更需要可解释、可追溯和可复核。

### 与 Validation 的关系

置信度不是 Validation 的替代。Validation 判断是否满足发布规则；Confidence 描述记录在已知证据下有多可靠。

---

## 16. ADR-014：Provenance 以记录/批次 sidecar 为主，主表只保留引用

### 状态

已接受。

### 决策

主表保留最小字段：

- `record_id`
- `source_id`
- `asset_id`
- `provenance_id`

详细定位、原值和转换链放在 lineage sidecar。这样既保持主表可分析性，又能完整追踪。

### 例外

Demo 或小表可以内联关键来源字段，但 Manifest 和 sidecar 仍为权威来源。

---

## 17. ADR-015：Cache 由 Schema 和构建参数标识，不由关键词或固定列标识

### 状态

已接受。

### 决策

缓存身份包含：

- dataset family；
- Schema version；
- SourceAsset digest；
- Adapter/parser version；
- normalization profile；
- cohort/query parameters。

关键词用于检索缓存，不用于决定资产身份。

### 当前踩坑

现有 Cache Design 为复用 Pipeline，固定采用 22 列 `main_data.csv`。这减少了一套 Schema，却把表达任务的实现细节扩散成全局协议。

---

## 18. ADR-016：迁移采用绞杀模式，不做一次性重写

### 状态

已接受。

### 决策

- V2 自包含 DatasetBuildSpec 和表达闭环并行加入；
- 不新增 DatasetRequest 或 BuildRecipe；
- 旧 `run_research_pipeline` 作为兼容 facade；
- 先抽取可靠性内核，再迁来源；
- 单独补齐 WorkflowRecipe 从 PROMOTED 到 SourceAsset 的生产消费闭环；
- 先迁 GDC/Xena，后迁 GEO；
- RunStatus、BuildResult、ValidationResult 和 Publication 双轨迁移；
- V2 前端和缓存双轨；
- 达到验收门槛后删除 Legacy。

### 原因

现有 Pipeline 有大量可靠性测试和复杂恢复语义。大爆炸重写风险高，且很容易丢掉比业务流程更成熟的基础设施。WorkflowRecipe 和状态体系也有现存消费者，必须以兼容层和特征测试保护迁移。

> **ADR 序列续篇：** Pi Agent / Host 迁移决策为 ADR-017 至 ADR-024，见
> [docs/adr/README.md](adr/README.md)。此处保留既有章节编号，避免打断
> `ADR §N` 历史交叉引用。

## 19. 被否决或修正的方案

### 19.1 完整 Research DAG

否决作为当前核心架构。原因：过重、偏离评分、缺少必要场景、Agent 生成图不可靠。

保留：内部步骤依赖、来源并发、可恢复执行。

### 19.2 多角度 Artifact Package 作为主产品

修正。表达、突变、通路、文献、图片可以同时存在于一次科研会话，但不应成为同一个 DatasetBuild 的同一主数据。

保留：辅助 artifact 和多个 Build 的会话级组合。

### 19.3 删除全部 Pipeline

否决。会丢失 SourceAsset、Attempt、digest、恢复、Validation 和原子发布。

### 19.4 固定五阶段继续增加组合分支

否决。短期能接新来源，长期形成指数级状态组合和跨层硬编码。

### 19.5 万能 22 列 Schema

否决作为全局 Schema。可以作为历史表达 Schema 或表达数据族一个版本保留。

### 19.6 用 warning 解释空主数据

否决。Warning 不能改变“主表没有目标科学记录”的事实。

### 19.7 只靠 Prompt 修正架构

否决。Prompt 可以约束 Agent，但不能替代服务端契约、兼容性门禁和发布规则。

### 19.8 通过 artifact 数量判断运行成功

否决。应分别使用 RunStatus、BuildResult、ValidationResult 和 DatasetPublication。

---

## 20. 当前代码中已经做对的事情

重构不能忽略现有成果：

1. `SourceAsset` 使用内容 hash 标识并要求下载或派生血缘二选一；
2. `DownloadAttempt` 明确成功和失败；
3. Pipeline 有输入、参数和输出摘要；
4. Runner 支持恢复、取消、总超时和阶段超时；
5. 事件可持久化和重放；
6. 任务目录分 source、parsed、normalized、staging、artifacts、state、logs；
7. 发布前 Validation，失败不进入 Artifact API；
8. 原子发布和 manifest 检查；
9. fixture/live 有明确边界；
10. 网络访问、安全下载、沙箱和 egress 边界较完整；
11. Skill Catalog、Subagent 和 Recipe 已能支持来源发现与获取；
12. 清洗已向流式处理演进；
13. Confidence Survey 已正确识别模型提取是置信度重点。

重构目标是重新组织这些能力，不是证明旧实现一无是处。

---

## 21. 踩坑复盘

### 21.1 先设计通用科研平台，后确认赛题核心

问题：从“AI Scientist”背景出发，系统自然扩展到机制、通路、结构、药物和文献综述，但主选题评分实际聚焦数据整合。

教训：先从评分对象和交付物倒推架构。背景叙事不等于具体产品边界。

### 21.2 把“多源异构”误解为“多种语义都合在一起”

问题：多源是来源和载体异构，不表示表达、突变和通路可以共享行粒度。

教训：任何“合并”设计先写出一行代表什么，再讨论字段对齐。

### 21.3 将一个成功案例的 Schema 提升为全局协议

问题：GSE178352 的 22 列表达长表在固定案例中合理，随后扩散到 Cache、Builder、Validation、API 和前端。

教训：示例 Schema 只能注册为一个 versioned profile，不能自动成为全领域 Schema。

### 21.4 为避免空表制造元数据占位行

问题：结构检查驱动业务数据，导致“非空”替代“有目标科学值”。

教训：质量门禁必须验证语义存在，而不只是行数。无数据应是一等结果。

### 21.5 Validation 为错误产物开豁免

问题：metadata-only 进入主表后，Validation 添加跳过逻辑；lineage 再跳过这些行。Validator 从质量门禁变成兼容错误设计的补丁层。

教训：出现大量“特殊情况跳过”时，优先检查上游数据模型是否错误。

### 21.6 用字符串相似度代替字段语义

问题：列名归一化和前缀相似度容易实现，却无法证明字段等价。

教训：字段对齐需要 Schema、单位、Vocabulary、映射来源和审核状态。文本相似只能辅助。

### 21.7 把来源组合当作数据兼容性

问题：GDC+Xena 出现在 allowlist 就能走合并，而 GEO 被排除；判定由代码分支而非数据属性决定。

教训：来源能力和数据兼容性必须分层。

### 21.8 Prompt 逐渐承担 Workflow Engine 职责

问题：Prompt 写入大量来源策略、重试、vetting、组合和错误处理，模型需要记住越来越多流程规则。

教训：稳定规则进入契约和服务端 Validator；Prompt 只保留意图层原则。

### 21.9 通过“没有 artifact”判断 Agent 失败

问题：修复 silent completion 时，将所有无 artifact 情形都标成失败；之后前端再解析错误文本识别 no_data。

教训：运行生命周期和业务结果需要不同状态模型。

### 21.10 测试锁定了实现顺序，而非业务不变量

问题：测试固定五阶段数量、事件顺序、文件名和 validation check 顺序。重构时大量失败可能只是协议迁移，不代表可靠性退化。

教训：核心测试应锁定取消、恢复、hash、血缘、兼容性和原子发布等不变量。

### 21.11 修复大文件内存问题后，又在合并路径全量读回

问题：清洗改为流式，但为了复用旧 `alignment.merge_datasets`，CSV 又被读成 `rows=list(reader)`。

教训：局部流式优化必须检查完整数据路径；Legacy Adapter 容易把问题带回来。

### 21.12 Fixture 成功不等于真实来源闭环

问题：固定案例可通过，不代表 live 下载、平台映射、字段语义和单位兼容都可靠。

教训：fixture、recorded integration、live smoke 和发布验收必须分层标记。

### 21.13 置信度容易变成装饰字段

问题：图表数据已有 `confidence` 列但值为空；字段存在不等于功能完成。

教训：置信度必须有计算/判定策略、理由、门禁和 UI，不允许空值默默通过。

### 21.14 超大核心文件掩盖边界错误

当前 `runtime/manager.py`、`pipeline/runner.py`、`agent_loop/runner.py` 和 Processing 文件体积很大。大文件本身不是唯一问题，但通常说明状态、业务分发和错误处理集中。

教训：先按稳定职责拆分，而不是单纯按行数拆文件。

### 21.15 广泛捕获 Exception 降低错误可解释性

静态扫描发现大量 `except Exception/BaseException`。边界清理和 finalization 中有合理场景，但业务路径中过宽捕获会把数据不兼容、网络失败、解析错误和内部 Bug 混成一个错误。

教训：建立错误分类；执行错误进入 RunStatus/RunSummary，正常业务结果由 BuildResult 使用稳定 reason code。

### 21.16 V2 容易以“通用化”名义重新堆叠抽象

问题：发现固定 Pipeline 过重后，很容易同时引入 DatasetRequest、DatasetBuildSpec、BuildRecipe、BuildStep、Artifact 状态和业务 Outcome，形成另一套难以消费的框架。

教训：每个正式契约必须有独立行为、生命周期和消费方。只用于传递到下一个对象且字段高度重复的 DTO 应保持内部或删除。

### 21.17 用一个状态字段同时回答多个问题

问题：`validated_intermediate/final` 同时表达“是否通过验证”和“是不是当前最新版本”；BuildOutcome 又混入 failed/cancelled 执行状态。

教训：执行生命周期、正常业务结果、验证结果和发布版本必须正交。当前版本用指针表达，不修改历史产物状态。

### 21.18 将 Validator 规则清单误当成架构

问题：编码、列数、warning 计数、特定字段完整率等规则很重要，但都写在架构层会使每次 Profile 变化都像顶层协议变更。

教训：架构只保留 provenance closure、Profile passed 和 atomic promotion；具体规则进入版本化 Profile 和测试
---

## 22. 顶层不变量

后续设计和代码评审必须检查以下不变量：

1. 一个主数据集只有一个 family；
2. 一个主数据集只有一种 row grain；
3. Agent 直接生成自包含 DatasetBuildSpec，不维护重复的 DatasetRequest；
4. Agent 不能直接制造科研值或修改服务端验收阈值；
5. 主数据记录必须来自真实来源或可复算确定性派生；
6. 无 SourceAsset/locator 的来源值不得作为高可信正式记录；
7. WorkflowRecipe 只产出 SourceAsset，不参与集成、Validation 或发布；
8. 生产自动发现只使用 PROMOTED WorkflowRecipe；
9. 合并前必须通过 Compatibility Gate；
10. 字段名相似不等于语义相同；
11. 单位、尺度和归一化状态不得静默丢失；
12. metadata 不能冒充 measurement；
13. 空主数据不能标记 succeeded；
14. NO_DATA 必须有明确用户输出；
15. 部分成功必须列出失败来源；
16. RunStatus、BuildResult、ValidationResult 和 Publication 不得混用；
17. Validation 发布架构只依赖 provenance closure、Profile passed 和 atomic promotion；
18. 发布必须原子；
19. Publication 不可变，当前版本通过指针选择；
20. Manifest 按 Artifact Role 分类，不固定审计文件名；
21. 任何已发布数据都能定位到构建版本和处理版本；
22. fixture 不能伪装 live；
23. 置信度必须可解释；
24. 复合需求需要拆分或显式关系模型；
25. 新来源接入不应修改多个数据库组合分支；
26. 前端不得通过错误字符串推断业务状态。

## 23. 代码评审检查表

新增数据源或数据类型时必须回答：

- 它产生哪种 dataset family？
- 一行是什么？
- 源 Schema 是什么？
- Canonical Schema 是什么？
- 主键是什么？
- 单位和尺度是什么？
- 是否已归一化？
- 字段映射证据来自哪里？
- 与哪些已有 Batch 兼容？
- 冲突和重复如何处理？
- provenance 到什么粒度？
- confidence 如何确定？
- Validation Profile 是什么？
- 产物属于哪个 Artifact Role？
- 获取方式是 builtin 还是 PROMOTED WorkflowRecipe？
- WorkflowRecipe 是否只产出 SourceAsset？
- 无数据时 BuildResult 是什么？
- 执行失败时是否由 RunStatus 表达？
- 新版本是否使用 Publication supersedes 和 current pointer？
- 是否会在其他模块新增来源特例？若是，抽象可能仍不正确。

## 24. 当前推荐 Demo 决策

### 主案例

`gene_expression` 数据集构建。

### 来源优先级

- GDC；
- Xena；
- GEO 在完成平台、probe mapping、尺度和归一化兼容性后加入；
- 一个受控 PROMOTED WorkflowRecipe 来源，用于证明陌生来源获取闭环，但不作为主路径依赖。

### PubMed 角色

- 发现相关研究和 accession；
- 说明数据选择依据；
- 提供来源关系；
- 不作为表达主表行。

### Reactome 角色

独立 `pathway_member` 数据集族，用于证明系统可扩展到第二个 Schema，不与表达数据合并。

### 必测结果

1. 成功：两来源兼容并合并；
2. 部分成功：一个来源失败但另一个有效；
3. 无数据：来源不适合或无目标记录，不生成假表；
4. 规格拒绝：复合 family 或非法 Profile 在执行前拒绝；
5. 执行失败：文件损坏或 Parser 异常，由 RunStatus=FAILED 表达；
6. 取消：不产生新 BuildResult 或 Publication；
7. 版本更新：新 Publication supersedes 旧版本，current pointer 更新；
8. Recipe 获取：PROMOTED WorkflowRecipe 产出 SourceAsset 后由 Adapter 解析。

## 25. 尚未完全决定的问题

以下问题不阻塞第一阶段，但需在实现中形成新 ADR：

### 25.1 主数据文件格式

Demo 使用 CSV；大数据内部是否使用 Parquet，发布是否同时提供 CSV，需要评估内存、速度和用户可用性。

### 25.2 记录级还是批次级 confidence

确定性数据库通道可批次级默认，模型抽取需记录级。需要定义何时继承、何时覆盖。

### 25.3 Provenance sidecar 格式

CSV、JSONL 或 Parquet 的选择需考虑可读性、规模和查询效率。

### 25.4 多 Build 会话模型

一个用户任务是否直接拥有 `builds[]`，还是每次续聊产生独立 Run/Build，需要结合现有 Runtime 数据模型决定。

### 25.5 GDC 与 Xena 镜像数据去重

两者可能呈现同一上游 TCGA 数据。需要明确 source-of-record、版本差异和重复规则，不能把镜像当独立证据数量。

### 25.6 聚合粒度

用户有时需要 cohort-level 汇总，而现有表达长表是 gene-sample。应通过明确 aggregation operation/profile 生成另一个 Schema，不能在同表混合。

### 25.7 人工确认点

字段映射、低置信图表值和单位转换哪些必须触发 HIL，需要按 Demo 交互成本确定。

---

## 26. 文档治理建议

当前 `ARCHITECTURE.md`、`CACHE_DESIGN.md`、`RESEARCH_SYSTEM_REVIEW` 和 Confidence Survey 中部分结论基于旧方向。建议：

1. 将本文件作为顶层 ADR 索引；
2. 将重构设计文档作为 V2 实现规格；
3. 在旧 `ARCHITECTURE.md` 顶部标注 V1/Legacy；
4. 不立即删除历史 Review，因为它们记录问题演进；
5. 对已推翻结论标记“superseded by ADR-xxx”；
6. 每个重大边界变化新增 ADR，不在 Prompt 或 TODO 中悄悄改变；
7. TODO 只记录执行任务，不承担长期架构解释。

---

## 27. 防止再次走偏的简短规则

开始设计任何新功能前，先回答三句话：

1. 用户最终要下载和分析的主数据是什么？
2. 主表一行代表什么？
3. 新来源提供的记录能否在科学语义上进入这张表？

如果第三问答案不明确，就先保持独立、补充映射证据或拆成另一个 Build，而不是先写合并代码。
