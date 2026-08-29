## 参赛作品简介

系统采用“开放式推理与确定性数据处理分权”的设计：Qwen 驱动的 Pi Agent 负责理解研究目标、发现候选来源、检查可用执行路线并提交声明式数据需求；TypeScript Dataset Core 负责来源资产登记、已注册解析器执行、规范化、多源整合、质量门禁、人在回路和正式发布。系统不将 Agent 工作区中的临时 CSV 视为任务完成，而以包含数据表、Schema、Provenance、Audit、Validation 和内容摘要的不可变 Publication 作为正式结果。支持多种静态数据产品，并提供动态 Family 协议处理静态注册表无法表达的多表拓扑。来源文件通过 SourceAsset、SHA-256、Provider revision evidence 和 SourceLocator 进入证据链；不确定的字段映射、未知单位和低置信度抽取可以触发可持久化的人在回路请求；任务中断后可依据事件、操作摘要和 checkpoint 恢复，而不要求模型重新解释已经确认的数据变换。

## 一、引言

### 1.1 真实科研中数据查找与整合的具体不足

在生物医学研究中，“找到数据”并不是搜索到一个网页链接。一个可用于下游分析的数据集至少需要同时回答：数据对应什么实体和样本、来自哪个版本、如何从原文件变成当前字段、不同来源能否在同一粒度上合并、哪些值存在冲突，以及哪些判断仍需研究者确认。现有工作流程主要存在以下不足。

第一，数据来源分散且检索接口异构。同一研究问题可能同时涉及 PubMed 或 Europe PMC 中的论文、GEO/GDC/Xena 中的表达数据、ClinVar/GWAS Catalog 中的变异证据、PDB/UniProt 中的蛋白信息，以及论文附件或网页下载。不同平台的查询语言、分页方式、访问限制、版本标识和返回格式不同。研究者往往能找到“相关页面”，但难以证明是否覆盖了应查来源、是否遍历了分页、是否遗漏补充材料。

第二，可读信息不等于可计算数据。论文中的 HTML、XML、PDF 表格、扫描图、折线图和补充 XLSX 需要不同解析方法。复杂表格还可能包含合并单元格、跨页表头、脚注、单位信息和缩写。视觉模型可以读取图表，但模型输出本身具有非确定性，若不保留页码、边界框、模型身份、提示版本和置信度，就难以复核。

第三，多源数据的语义不自动一致。相同列名可能代表不同测量语义，不同列名也可能代表同一概念；基因、探针、变异、化合物和样本各自有不同标识体系。以表达数据为例，probe-level 与 gene-level 具有不同的行粒度，原始强度、归一化表达量和对数值不能仅凭列名直接拼接。以生物活性数据为例，同一化合物的跨库 identity、实验类型和活性单位需要显式 crosswalk 与冲突记录。

第四，人工复制整理难以复现。常见流程是在浏览器、Excel、脚本和聊天窗口间复制内容。即使最终得到 CSV，也常缺少原始文件摘要、检索条件、字段映射、被拒绝行、冲突处理和处理程序版本。后续发现错误时，研究者难以判断应修改哪一步，只能重新整理。

第五，一次性问答无法承担长流程状态。科学数据任务可能因下载、权限、人工确认或服务故障跨越多个会话。普通问答把中间状态留在上下文窗口中，一旦超时或重启，模型容易重复下载、改变处理口径或忘记用户已确认的修正。

### 1.2 相关工作与差异定位

先简要回顾四类直接相关的工作。科学数据检索方面，PubMed、Europe PMC 等文献平台与 GEO、GDC、PDB、UniProt、ClinVar、ChEMBL 等专业数据库提供标识稳定、字段规范的入口，但跨库研究仍需研究者手工串联查询条件与下载文件；通用网页搜索能发现未被 API 暴露的页面和附件，但搜索排名不等于科学数据覆盖率，网页内容也不能自动成为正式证据。科学数据解析方面，规则解析器对固定格式更可复现，却难以覆盖布局复杂的非结构化内容；OCR、表格理解与视觉语言模型覆盖面更广，但会引入识别和语义误差。多源整合与溯源方面，传统 ETL 擅长把已知来源映射到目标仓库，FAIR 原则强调可查找、可访问、可互操作与可复用，W3C PROV 为来源关系提供通用表达，但大都面向固定来源而非开放式研究目标。LLM 辅助数据处理方面，检索增强生成、工具调用与 ReAct 类方法让模型能够在回答前搜索外部信息并调用工具，但直接让模型生成或改写正式数据会面临幻觉、不可重复与长流程状态脆弱等问题。

本作品的区别在于：模型承担需求理解、来源探索与规格选择等开放性语义工作，Dataset Core 独占正式数据变换与发布权，并用一个最小但强约束的证据闭环（来源资产、版本身份、逐记录 locator、操作结果、冲突审计、验证报告、发布清单）覆盖数据生命周期，使研究者能知道“数据从哪里来、如何变成现在这样、哪些地方仍不确定”。因此，本作品更适合定位为一个“可信科学数据编译器”：自然语言研究需求是输入，具有 Schema、来源、质量记录和发布回执的数据产品是输出。

### 1.3 本作品希望解决的问题

BioMed-QAgent 面向的不是“替研究者得出科学结论”，而是赛题明确提出的上游问题：将自然语言研究目标转换为一份可以继续分析、可以追溯来源、可以检查质量并可以在反馈后修正的结构化科学数据产品。

系统试图解决四个连续问题，四者依次覆盖“Agent 外部工作 → Dataset Core 确定性流水线”的主链路：

1. 根据研究目标定位合适的论文、数据库、附件、表格或图像数据（Agent 侧的需求编译与来源发现）；
2. 把异构载体解析为明确 Schema 和行粒度下的规范记录（Core 的 parse、normalize 阶段）；
3. 在不掩盖缺失、重复、单位差异和身份冲突的前提下完成多源整合（Core 的 compat、integrate、derive 阶段）；
4. 将每一步的来源、输入摘要、处理版本、质量判断和人工修正一起发布，使结果能被验证和复用（Core 的 validate、publish 阶段与 Durable HIL）。

系统有意不把科研分析和结论生成纳入正式完成标准。这样既符合赛题 1A 的任务边界，也避免将“数据是否正确”与“模型解释是否听起来合理”混在一起。

### 1.4 研究问题与数据需求

本文要解决的核心问题是：用户以自然语言提出的研究需求，能否被系统可靠地转换为一份定义明确、过程可控、结果可复核的数据交付？回答这一问题需要明确两件事：一是系统应从需求中提取并固定哪些关键信息，二是一份合格的结果必须满足哪些条件。

用户输入最初只是一段自由文本，可能存在多种解读方式。为了避免歧义，系统并不试图穷尽地形式化用户的全部科学意图——那样做既不可能，也没有必要——而是只固定那些“一旦改变，数据产品的含义就会随之变化”的关键选择。这些选择共有十项，共同构成本次执行的数据集规格，在实现中对应 DatasetExecutionSpec 结构：

1. 数据产品类别：本次需要的是哪一类数据产品；
2. 行粒度：表中每一行代表什么观测或统计单位；
3. 目标 Schema：交付表包含哪些字段及其组织方式；
4. 实体集合：分析涉及的对象是谁、范围多大；
5. 队列与筛选条件：按什么标准纳入或排除样本；
6. 来源与采集绑定：数据取自哪个外部库或文件、采用何种访问方式；
7. 规范化配置：采用哪套标准化流程及参数；
8. 合并策略：多个来源出现重叠或冲突信息时按什么规则取舍；
9. 验证配置：用哪些规则和阈值判断质量是否达标；
10. 输出格式：最终以什么格式交付。

明确这十项之后，同一份需求就可以被反复执行、逐项核对和事后审计，不会因表述含糊而产生不同的结果。

相应地，系统的交付物也不是一张孤立的数据表。一个合格的候选结果必须同时包含六类信息：

- 数据本身：可以是单张表，也可以是由主外键关联的多张表组成的集合；
- Schema：各表的字段结构与约束；
- 溯源信息：数据来自哪些来源，每条记录在原始数据中如何定位；
- 审计记录：完整保留处理过程中被丢弃的数据、检测到的冲突以及所做的修正；
- 验证结果：各项质量门的判定结论；
- 文件清单：逐一登记正式交付的文件及对应的 SHA-256 校验值。

候选结果只有在通过全部质量门检查后，系统才生成一份不可更改的正式发布版。这样设计的目的在于：使用者不仅能直接基于表格开展分析，还能随时查证“数据从哪里来、经过哪些处理、是否被人中途修改过”，从而保证交付物的可追溯性和可复现性。

### 1.5 主要贡献与创新点

本文将实际完成的功能归纳为三个贡献。

创新点一：以“Agent 规划、Core 裁决”替代模型直接生成数据。 Qwen/Pi Agent 负责研究需求理解、来源探索和声明式工具选择，Dataset Core 独占正式数据变换与发布权。Agent 不能提交任意执行步骤，也不能仅凭工作区文件宣告任务完成。这一分权把模型适合处理的开放语义问题与代码适合处理的确定性质量问题分开（对应第三章 Agent 侧的需求编译与路线检查，以及第四章的声明式工具与完成契约）。

创新点二：构建从来源字节到正式 Publication 的可验证证据链。 系统以 SourceAsset、SHA-256、Provider 请求身份、版本证据、SourceLocator、OperationResult、Validation Report 和 Manifest 串联数据生命周期。正式完成不是一个聊天答案或临时 CSV，而是一组内容寻址、摘要可重验、关系可检查的数据产品文件（对应第三章从正式采集到不可变发布的流水线各阶段，核心机制为 SourceAsset 与 Manifest）。

创新点三：把质量反馈和人工判断纳入可恢复闭环。 模糊字段映射、未知单位、低置信度图表点或动态产品接纳可触发 Durable HIL。人工选择以结构化 decision 与 evidence digest 绑定到 task/run/requirement；进程重启后从同一 checkpoint 恢复，修正结果可形成新的 Publication，并保留版本替代关系（对应第三章的 Durable HIL 与 checkpoint 恢复机制）。

## 二、问题定义

### 2.1 任务边界

本系统支持的核心任务是：给定医学研究对象和数据需求，发现并采集一个或多个科学数据来源，将其转换为统一的单表或多表结构，保留来源和处理记录，并输出便于后续分析的 CSV 数据产品。

本系统当前不把下列事项作为正式交付承诺：自动提出并验证科学假设、替代领域专家判断数据科学含义、对研究结果给出医学结论、保证互联网范围的绝对查全、将模型抽取值自动升级为高可信事实。

### 2.2 设计目标

1. 可用性：输出为明确 Schema 下的 CSV 单表或多表，可直接进入 R/Python/统计软件或后续知识图谱流程（由 publish 阶段的 Manifest 标准化发布承载）。
2. 可追溯性：每个正式来源绑定文件摘要和来源身份；记录尽可能携带可返回原载体的定位信息（由 acquire 阶段的 SourceAsset 与 SourceLocator 承载）。
3. 可靠性：解析、规范化、整合和发布由注册代码执行；缺失、重复、冲突和单位问题显式记录（由注册 Adapter 与确定性流水线承载）。
4. 可修正性：需要研究者判断时暂停并请求结构化输入；反馈后从同一任务状态恢复（由 Durable HIL 承载）。
5. 可恢复性：下载和长流程操作可重试；已完成且摘要一致的阶段可从 checkpoint 复用（由事件溯源与 checkpoint 承载）。
6. 能力诚实性：工作区暂存、正式候选和已发布产品分层；系统不能以对话措辞替代发布证据（由三层产物模型承载）。
7. 可扩展性：固定 Family 覆盖成熟高频场景，动态 Family 在严格协议下表达未注册多表拓扑（由 Family Registry 与动态 FamilySpec 协议承载）。

系统重点防范以下失败：来源 URL 或版本漂移；下载中断或内容类型错误；字段映射模糊；单位、尺度或行粒度不兼容；重复与冲突被静默覆盖；模型输出无证据；任务重启后重复或改变处理；过期执行晚到发布；正式文件被修改后仍被展示。

这些问题并非都能被自动“修复”。项目的目标是自动解决确定性问题，对无法安全判断的问题进行阻断、降级、记录或请求人工输入。

## 三、方法与架构

![BioMed QAgent主架构图](architecture/biomed-qagent-main.svg)

BioMed 的整体设计遵循一个核心原则：开放式理解交给 LLM，正式数据改变交给确定性 Dataset Core，两者通过声明式规格与事件日志耦合，使“找到什么、怎么解析、如何清洗、从哪里来、输出成什么”都可检查、可回溯。

### 3.1 三层产物模型

系统把结果分为三层：

1. Workspace 暂存结果：搜索下载、模型阅读、探索脚本或 provisional CSV，可帮助 Agent 工作，但不具有正式可信语义。
2. Dataset Core 候选结果：来源已登记，处理步骤有 OperationResult，候选表具有 Schema、provenance 和验证报告，但仍可能因质量门或 HIL 未完成而不可发布。
3. Publication 正式结果：通过发布门后形成不可变目录，包含 Manifest、数据表、Schema、Provenance、Audit、Validation 与文件 SHA-256。产品界面只应把这一层视为任务完成。

该分层是项目区别于“Agent 生成 CSV”的关键。它使“文件存在”“候选有效”和“正式可交付”成为三个可检查状态。这三层直接服务赛题“清洗整合可靠”与“输出格式可用”两项标准：只有到达第三层的对象才携带 Schema、Provenance 与 Validation，下游脚本可以依赖其结构而无须信任聊天输出。

### 3.2 第一步：研究需求编译

Agent 首先把用户问题中的目标实体、数据类型、样本或队列条件、必需字段、期望粒度和输出要求整理为结构化需求。随后必须调用路线检查能力，获得当前 Registry 可支持的 Family、Schema、来源和 Adapter 组合，以及动态路线可直接绑定的 Provider。

需求编译不是一次自由文本改写，而是形成 DatasetExecutionSpec 的过程。服务器对规格做交叉校验，包括 Family 与 Schema 的注册归属、行粒度与目标实体层级的一致性、每个 source binding 的 Provider/Adapter/参数合法性、normalization/merge/validation profile 的白名单、输出格式支持以及多表输入的角色关系，校验不通过即阻断或要求修正。

如果静态 Registry 能精确表达需求，Agent 选择静态路线。如果静态拓扑不匹配，但所有输入都能由 Core Provider 获取或已是任务拥有的 Core asset，可选择动态 Family。两条路线均无法闭合时，系统只应交付明确标记为 provisional 的暂存结果，并列出缺少的正式能力，不能伪装成 Publication。

### 3.3 第二步：候选来源发现

来源发现由 Agent 的查询策略和专用工具共同完成。当前代码覆盖文献、表达组学、变异、药物与生物活性、蛋白与通路、临床试验、微生物组及通用网页等通道。发现阶段的目标是确定候选 accession、论文、数据集、附件和下载入口，并理解其字段与范围。

建议在正式 Gold 实验中为每次发现过程记录统一的 SourceCoverage 表，字段至少包括检索站点与查询式、时间窗口、命中数与去重后候选数、最终进入正式采集的 accession/附件、排除原因和检索时间，用于回答“是否在问题子领域内查全”。需要强调：该统一 artifact 目前是评审建议，代码尚未形成完整的全局 QueryPlan/SourceCoverage 产品，因此当前系统可以证明“用了什么正式来源”，但还不能仅凭现有运行产物严格证明“在问题子领域内查全了所有来源”。

### 3.4 第三步：正式采集与 SourceAsset 登记

研究工具发现 URL 后，正式路线不直接信任 Agent 工作区中的任意文件。Core acquisition provider 决定请求 URL、方法、请求头、媒体类型和允许参数，并通过统一下载设施执行网络访问。下载层包含 URL/DNS 策略、大小限制、超时、重试、断点与内容缓存等机制，用于降低 SSRF、无限下载、网络抖动和重复获取风险。

文件写入任务拥有的 source_assets/ 后，SourceAsset Registry 流式计算 SHA-256 并生成内容身份。注册信息至少绑定任务与 asset role、文件字节数/媒体类型/SHA-256、来源 ID 与 canonical accession、Provider 与采集实现身份摘要，并在支持时记录 snapshot identity 或 revision token 等版本证据。Registry 拒绝目录逃逸、符号链接和跨任务资产复用。SourceAsset 因此不是“一个本地路径”，而是任务、来源、内容与采集实现共同绑定的输入证据。

### 3.5 第四步：异构数据解析

#### 3.5.1 结构化与半结构化来源

正式静态路线使用已注册 Adapter。Adapter 把来源特定的 CSV、JSON、XML、XLSX、SOFT、矩阵或 API 响应转换为 DataBatch，同时输出解析统计、被拒绝记录和 provenance locator。对于来源格式异常，解析器应失败或把问题记录到 audit，而不是由 Agent 猜测缺失字段。

表达数据的 Adapter 需要识别样本列、实体标识、测量值和表达语义。例如 GEO 既可能提供 gene-level 结果，也可能只提供 probe-level 矩阵；系统不会在缺少可信 annotation 时直接把 probe 当成 gene。GDC 与 Xena 的输入形态不同，但都需要转换到目标表达 Schema 后才可合并。

注册式多表 Family 则将每个来源表映射到明确 table definition，并在后续 Assembly 中检查关系（多表示例见 3.7）。

#### 3.5.2 PDF 表格

PDF 解析保留页面和位置证据。对于可提取文本的表格，可依据文本块位置聚类形成行列，并记录 page、bbox、caption 或 fallback warning。无框线表格、合并单元格、旋转页面和跨页表头仍是启发式解析的难点，应在 Gold 案例中单独标注复杂度并人工核对。

#### 3.5.3 图表与视觉模型

图表工具采用多层降级：优先通过 Qwen-VL 理解页面图像或嵌入图像；失败时尝试 PDF 表格；再失败时提取 caption 作为有限信息。模型抽取结果必须携带 model_name，点级结果包含 confidence_level 与 confidence_reason；其可信级受 3.8 的确定性上限约束，不会因模型自报 high 而自动成为正式真值。

但当前默认正式产品链仍缺少从图表 evidence asset 到发布门的完整接线，正式汇报应将其展示为 processing preview，待接线和 Gold 验证完成后再宣称端到端发布。

### 3.6 第五步：Canonicalize、字段对齐与语义兼容

解析后的来源记录仍不能直接拼接。Canonicalizer 按目标 Schema 完成类型转换、规范字段命名、实体标识表达和必要的值标准化。其核心原则是：只有被目标 Schema 和规范化配置授权的变化才可以自动执行。

字段对齐处理来源列名到规范字段的映射、类型转换、缺失标记统一、实体 ID 与 namespace 表达、单位与测量语义检查、probe-to-gene 等外部映射资产转换，并保留原始 token 与规范值之间的 lineage。缺失与重复也在本阶段按类型处理：必填字段缺失时拒绝或阻断，可选字段缺失保留为空并计入完整性统计；完全重复按确定性 key 去重；主键重复且值一致时合并 lineage、保留多来源。每类处理都保留对应证据（locator、来源集合等），使后续可复核。

兼容性门检查各批次是否在 Family、Schema、行粒度、实体层级、单位、语义和尺度上可合并。未知单位、未知 value semantics 或不受支持的 scale 不会被模型根据常识静默修正；单位不一致仅在注册转换存在时换算，否则系统阻断，或以 HIL 询问研究者选择合法 correction。

对于 probe-to-gene，映射资产本身也需要 SourceAsset 与摘要。未映射 probe、一个 probe 对应多个 gene、annotation 与表达平台不匹配等情况应进入 coverage、rejected 或 ambiguity 记录。Gold 案例应报告映射覆盖率，而不能只展示最终成功行。

### 3.7 第六步：多源整合与多表组装

对同一规范 Schema 的批次，Integrator 按注册 merge strategy 合并，并在最终 source-of-record 行上重新汇总 lineage 和 confidence。合并时的冲突按注册策略处理：主键重复且值冲突时保留 source-of-record 并写 conflict audit，必要时阻断；实体 identity 冲突不强制合并而保留 crosswalk；统计异常作为 warning 或人工核查信号，不默认自动改值。

当前表达整合采用确定性策略，冲突时的 first source wins 能保证复现，但不能证明第一个值在科学上更正确。因此冲突审计必须进入正式产物，答辩中也不能把“处理稳定”表述为“冲突值自动判真”。

对需要多实体关系的数据，Family Assembly 生成多表候选，并检查主键、外键、基数和表角色。

多表设计比单一宽表更适合生物医学对象。以生物活性数据为例，可拆分为 activities（测量值）、assays（实验条件）、compounds/targets（规范身份）、sources 与 compound crosswalks 等表，而不是压成重复严重的宽表。多表 Publication Manifest 记录 tables、relations、provenance refs 和 confidence refs。这样既减少宽表重复，也让下游使用者能明确关联规则，而不是根据列名猜 join key。

### 3.8 第七步：Validation、Confidence 与 ProductAssessment

Validation Profile 对候选结果执行发布前检查，覆盖 Schema 与字段类型、必填字段完整性与允许缺失率、主键唯一性与外键关系基数、实体标识 namespace 与 token preservation、单位/值尺度/允许语义、provenance 与 source locator 覆盖、confidence 记录与最终行对齐、artifact 摘要闭合，以及可复现性所需的输入与实现身份。

多表 ProductAssessment 从 schema、relations、identifiers、provenance、confidence 和 reproducibility 六个维度评价产品。无 blocker 时可达到 publishable；仅存在可复现性 blocker 时至多为 validated；存在语义 blocker 时为 incomplete。这使“CSV 能打开”与“数据产品语义闭合”不再等价。

置信度按证据类型受到上限约束。确定性、受版本约束的解析可以获得较高可信等级；VLM、LLM、OCR 和 web extraction 等非确定性来源最高封顶为 medium，并可按记录进入人工审核。系统关注的是“该记录由何种证据和处理产生”，而不是让模型自由输出一个看似精确的概率。

### 3.9 第八步：Durable HIL 与反馈修正

遇到模型或规则无法安全决定的问题时，Core 创建结构化 HIL 请求。请求包含合法选项、相关记录、证据摘要和 task/run/requirement 身份。前端允许用户 approve、reject 或 correct；响应只有在 evidence digest 和任务身份匹配时才可恢复原操作。

典型 HIL 场景包括字段映射存在多个候选、未知单位或测量语义、probe-to-gene 映射歧义、低置信度图表点确认、动态 Family 候选是否接受为正式产品，以及冲突记录需指定保留策略等。

从审批对象看，HIL 覆盖三级：工具许可与凭据授权（approve/reject）、数据审核（字段映射、单位、图表与网页证据）、发布验收。其中发布验收不可绕过——只有人工 accept 后系统才执行发布，这与“Core 独占发布权”互为表里。

HIL 不是聊天中的一句“请确认”。请求和决策均落盘，进程重启后可以确定性恢复。对于数据更正，系统应重新执行受影响阶段并发布新版本，通过 supersedes 关系保留旧版本历史，而不是覆盖原 Publication。

### 3.10 第九步：不可变发布与消费时重验

发布器把通过质量门的候选复制到独立目录，生成 Manifest，并记录每个 artifact 的相对路径、媒体类型、字节数和 SHA-256。典型正式产物包括 primary_dataset 与 supporting_dataset CSV、Schema、Provenance、Audit/Validation 报告，以及 Manifest 与 Publication receipt。

发布采用临时目录与原子切换，且在发布前检查执行锁和 generation fence，防止 timeout/cancel 后的旧操作晚到覆盖新结果。产品 API 在消费时重新验证 Manifest 与 artifact 摘要；若文件被修改或损坏，应返回错误而不是继续展示。

## 四、LLM 使用方法与上下文工程

本章展开 Agent 侧（Dataset Core 外部）的实现细节，对应 1.5 的创新点一；其中 4.4 的置信度控制与验证阶段的确定性上限、Durable HIL 直接衔接。

### 4.1 系统提示中的完成契约

Agent 系统提示把“任务完成”约束为可验证状态，而非自然语言自报。对于数据生产请求，Agent 必须先检查可用执行路线；正式成功需要取得 Publication 或明确的 artifact inventory。若只能形成工作区 CSV，则必须标记 provisional 并说明正式路线为何无法闭合。

该完成契约减少三类常见幻觉：

1. 工具调用返回了几行预览，模型就宣称“数据集已完成”；
2. 文件写进 Workspace，模型就把它称为正式发布；
3. 某个来源失败，模型省略失败项并给出“已完整检索”的结论。

### 4.2 路由预检与声明式工具 Schema

BioMed QAgent 系统向大模型暴露当前真实能力与相关参数。静态路线要求精确匹配 Registry；动态路线只接受预检报告为可绑定的输入。工具 Schema 限制字段类型、枚举、对象结构和必要参数，服务器端再做交叉验证。

上下文工程的重点不是把所有代码塞进 prompt，而是把模型作决策所需的最小权威信息放进上下文：

- 当前任务与研究目标；
- 可用工具及其严格输入 Schema；
- Registry 返回的 Family/Schema/Provider 能力；
- 来源搜索结果和失败回执；
- validation issue、HIL 选项与 evidence digest；
- 当前 Publication 或阻塞状态。

这样可以把“模型知道什么”绑定到运行时实际能力，减少提示词与代码版本漂移。

### 4.3 Skill 与专用工具

专用数据库工具封装查询、分页、下载与来源特有字段，使 Agent 不必为每个站点编写任意脚本。声明式数据库 Skill 可以扩展数据源描述，但不应绕过网络策略、资产登记或正式 Adapter。工具层返回结构化结果和错误，Agent 据此调整查询或向用户报告缺口，从而能在“选择和组合能力”上发挥作用，同时保持底层 I/O、权限和数据变换可审计。

### 4.4 证据上下文与不确定性控制

模型不应仅看到最终值，还应看到该值的来源类别、locator、解析层级和置信度。对于非确定性抽取，系统以类别置信度、原因、模型身份和 review state 表示不确定性，并在 Core 中设置可信度上限。

字段映射和单位修正也采用相同原则：模型可以提出候选，但只有注册规则或绑定证据的人工 decision 可以改变正式数据。

## 五、实验与案例

本项目整理了10份参考输入输出样例，用于检验模型能力。完整问题列表如下：

| 案例 ID | 研究主题 | 主要来源 | Gold 规模（目标表） | 主要难点 |
| --- | --- | --- | --- | --- |
| 1 | 乳腺癌肿瘤 vs 正常组织 GEO 转录组表达整合 | NCBI GEO / E-utilities + GPL 平台注释 | datasets、samples、expression_long、probe_gene_mapping | 探针→基因映射、缺失、冲突、单位/尺度 |
| 2 | LUAD EGFR 突变表达的基因/探针双粒度整合 | GEO + 临床与 EGFR 突变注释 | study_records、sample_annotations、egfr_variant_records、probe_expression、gene_expression | probe→gene 双粒度、临床表型字段对齐 |
| 3 | EGFR NSCLC 靶点多源证据整合 | UniProt、NCBI Gene、ClinVar、RCSB PDB、PubChem、ChEMBL、ClinicalTrials.gov、COSMIC | gene_protein、variant、structure、drug、clinical_trial、entity_crosswalk | 跨数据库 identity 冲突与 crosswalk |
| 4 | SARS-CoV-2 Spike–ACE2 结构、序列与变异证据 | NCBI、UniProt、RCSB PDB、PubMed、Europe PMC | viral_protein、spike_variant、structure、interface、paper | 派生行不得冒充来源行、结构版本与 interface |
| 5 | EGFR 抑制剂 ChEMBL 活性与 PubChem 结构整合 | ChEMBL、PubChem | target、compound、assay、activity、compound_crosswalk | compound crosswalk、单位、identity 冲突 |
| 6 | EGFR 突变体抑制实验与论文图表提取 | PubMed / PMC / Europe PMC（PDB 仅校验） | paper、experiment、activity_value、chart_series、chart_points、supplementary_asset | 低置信度图表点阻断至人工、轴/图例校验、图表提取 |
| 7 | 阿尔茨海默病 GWAS 风险位点多源整合 | GWAS Catalog + Bellenguez 2022 补充材料 + dbSNP GRCh38 | study、variant、variant_gene_mapping | 补充材料 75 风险位点解析、坐标版本 |
| 8 | 药物性肝损伤（DILI）风险药物证据整合 | FDA DILIrank 2.0、LiverTox、openFDA FAERS | drug、livertox、faers_report_count、drug_crosswalk | 外部来源失效（DILIrank 404）、来源切换策略 |
| 9 | 原发性免疫缺陷基因-疾病-表型整合 | Orphadata、HGNC、ClinVar、ClinGen | gene、disease、association、cross_source | 疾病归一、跨源证据分级 |
| 10 | 肠道微生物组-疾病关联整合（T2D/IBD/CRC） | MGnify、GMRepo、病例对照论文、NCBI Taxonomy | study、taxon、differential_abundance、reference_prevalence | 动态路线闭合、分类学术语归一 |

以下展开第 7–9 条案例（gold7 / gold8 / gold9）。三者均在同一冻结代码提交（`e8d03589`）、单一 Host、同一评测协议下完成，是该协议下首批三例连续达成"正式发布终态"的案例，分别代表三类典型难点：动态多表拓扑闭环（gold7）、外部来源失效下的部分维度发布与结构化阻断（gold8）、多源多表整合与跨源证据（gold9）。

### 5.1 案例评测协议与总览

为保证结果可复核，三个案例遵循同一评测协议：Agent 的输入只有案例 `TOPIC.txt` 原文（数百字节的研究需求描述，不含任何参考答案或人工整理数据）；代码冻结在单一提交；由一个有界外部监督程序（`scripts/gold-formal-supervisor.mjs`）驱动任务、逐页持久化事件流、对发布产物逐件重新下载并重算字节与 SHA-256，最终给出终态分类（`succeeded_publication` / `blocked_no_publication` / `failed_or_cancelled`）。评测模型为 DeepSeek-V4-Flash（上下文窗口 1,000,000、最大输出 32,768、温度 0.2）——选择一个非 Qwen 的国产模型是为了验证系统的模型无关性；此前 gold8 亦在同链路上取得过 Qwen3.8-27B 的同类正式发布（`pub_dili_benchmark_faers_counts_852d6a0a4bcd531c`，2026-08-28）。

| 案例 | 研究主题 | 正式发布（Publication） | 交付物 | 校验 | 上下文峰值 |
| --- | --- | --- | --- | --- | --- |
| gold7 | 阿尔茨海默 GWAS 风险位点多源整合 | `pub_ad_gwas_risk_loci_integration_b51fdc25…` | study / locus / variant_gene_mapping 三表 + schema + provenance + 评估 | 逐件 SHA-256 通过 | 766,326 / 1M（76.6%） |
| gold8 | DILI 风险药物证据整合 | `pub_REQ_DILI_FAERS_COUNTS_fd56dd6f…` | faers_reaction_counts 主表 + schema + provenance + 评估（4 件） | 逐件 SHA-256 通过 | 380,287 / 1M（38.0%） |
| gold9 | 原发性免疫缺陷基因-疾病-表型整合 | `pub_iei_pid_v1_bafb191e…` | gene / disease / gene_disease / crosswalk 四表 + schema + provenance + 评估（7 件） | 逐件 SHA-256 通过；结构校验 67/67 | 750,739 / 1M（75.1%） |

三例全程零 shell/网络绕路、零权限暂停（权限面的停审-拒绝-恢复链路在更早轮次已单独验证）；上下文峰值均远低于窗口，未触发任何压缩。全部事件流、发布清单与重验记录保留在 `data/gold-runs/` 评测证据目录中（gold7：`e8d03589-gold7-dsflash-r1`；gold8：`…-gold8-dsflash-r1/-r2`；gold9：`…-gold9-dsflash-r1…r5`，其中 gold9 另有可直接引用的证据包 `evidence-pack/`，含输入、输出、验证与 README）。

### 5.2 案例 gold7：阿尔茨海默 GWAS 风险位点整合（动态 Family 全链闭环）

**输入（TOPIC 摘要）**：以 Bellenguez 2022（PMID 35379992）等来源整合 AD GWAS 风险位点，输出研究、位点、变异-基因映射三张表，要求补充材料 75 位点表解析与 GRCh38 坐标核验。

**过程要点**：Agent 首步调用路线检查（`inspect_dataset_execution_routes`），确认静态注册表无任何 family 能表达该三表拓扑后选择动态 Family 路线；随后经治理工具完成采集——GWAS Catalog REST 返回 GCST90027158 的 89 条全基因组显著关联；Europe PMC 官方补充通道取得 27,656,649 字节归档（SHA-256 逐字节登记后作为任务资产），Core 提取器将 XLSX 成员逐工作表转为 provenance 绑定的 UTF-8 CSV 资产；dbSNP 工具核验 GRCh38 坐标。正式发布前，动态预检拒绝了 11 次规格提交（角色映射、输入闭包、外键策略、字段形状等），每次均给出可操作的错误信息；Agent 修正后发布 v1，又自行发现 v1 的 GWAS 统计列未填充与解析缺陷，发布修正版 v2 并以替代关系保留 v1 历史——这一"自检-修正-换版"行为正是 3.10 节反馈修正闭环的实测样本。

**输出结构（v2，`study.csv` 1 行、`locus.csv` 88 行、`variant_gene_mapping.csv` 127 行）**：`locus.csv` 24 列，含双坐标基准对照（`position_grch38` 与补充材料 `position_grch38_supp`）、分层统计（`stage1/stage2/stage12` 的 OR 与 p 值）、异质性（`i2`/`phet`）与来源标记（`in_supp_75_loci`、`dbsnp_variant_type`）。真实样例行：

| 字段 | 值 |
| --- | --- |
| variant_rsid / risk_allele | rs141749679 / C |
| position_grch38 / _supp | 109345810 / 109345810 |
| p_value / odds_ratio / CI | 8e-9 / 1.38 / [1.24-1.54] |
| nearest_gene / known_locus | SORT1 / New |
| stage1_or · stage2_or | 1.37 (1.19-1.57) · 1.41 (1.17-1.7) |
| i2 / phet / in_supp_75_loci | 0 / 0.9019 / yes |

**来源清单**：GWAS Catalog 关联记录（GCST90027158）、Bellenguez 2022 补充材料（Europe PMC 官方归档，字节级摘要入链）、dbSNP RefSNP 记录。**如实局限**（终答自报）：正式绑定范围为单研究（GCST90027158）而非全部 AD 研究；GWAS Catalog 关联对象的 `authorReportedGenes` 为空，故映射表基因全部来自补充材料；样本量元数据存在于原始缓存但未作为正式输入绑定。发布范围窄于参考全集，但每一行均可溯源、可重验。

### 5.3 案例 gold8：DILI 风险药物证据整合（来源失效下的正确终态）

**输入（TOPIC 摘要）**：针对 DILIrank 2.0 vMost 药物整合三类证据——DILIrank 标签注释、LiverTox 专论、openFDA FAERS 肝毒性 PT 报告计数，约 50 种代表药、四表交付。

**关键难点与行为**：DILIrank 2.0 官方文件（`fda.gov/media/113052/download`）持续 404，LiverTox 无药物级结构化导出。系统的处理展示了赛题"自动识别缺失数据……完成修正或寻求人类建议"加分项的完整链路：第一轮运行在发现阶段确认官方来源不可达后**未编造任何行**，以工作区暂存 + 结构化阻断收尾，明确请求"提供官方文件或注册 Core 资产"；第二轮定向续跑把可达维度（FAERS 计数）正式化——9 个已验证药物各经一条 `openfda.files.v1` Core 采集绑定**重新获取**（发现阶段的查询输出不被当作正式载体），以动态 Family 发布。

**输出结构**：`faers_reaction_counts.csv` 68 行 × 5 列（`drug_name, reaction_pt, report_count, retrieval_method, source_url`）。请求的 9 药 × 8 肝毒性 PT = 72 行中，4 行因官方聚合响应确无该 PT 词条而**未零填充**，逐条列出（如 azathioprine–HEPATOCELLULAR INJURY）；其余 68 行与发现阶段 openFDA 计数逐条一致（如 acetaminophen ACUTE HEPATIC FAILURE = 3297）。校验 16/16 通过（0 坏行、0 重复主键）、provenance 9/9 载体满足、`product_status=publishable`。每行 `source_url` 直接给出可复核的官方 API 查询串。

**诚实边界**：DILIrank vMost 名册与 LiverTox 维度保持"未验证/阻断"状态，仅存在于明确标注 provisional 的工作区文件，不进入正式发布；FAERS 计数语义为 MedDRA PT 报告次数（非去重患者、非因果证据），已在终答与 provenance 中注明。"部分维度正式发布 + 不可达维度结构化阻断"是该上游条件下唯一诚实的完成形态。

### 5.4 案例 gold9：原发性免疫缺陷基因-疾病整合（多源四表与跨源证据）

**输入（TOPIC 摘要）**：从 Orphadata 筛选免疫缺陷相关罕见病及基因关联，经 HGNC 归一为现行符号，整合 ClinVar 致病性变异计数与 ClinGen 有效性分类，输出基因、疾病、基因-疾病关联、跨源证据四表，以 `hgnc_symbol`/`orphacode` 关联，ClinGen Refuted/Disputed 冲突单独标记。

**过程要点**：Orphadata 两个大型 XML（en_product1 54,026,799 字节、en_product6 22,612,034 字节）经任务内容缓存命中（先前由同一官方端点获取并逐字节验证，摘要一致），零网络重取；HGNC、ClinVar、ClinGen 为本 run 真实网络采集。前两轮 run 因基础设施缺陷（浏览器渲染超大文件导致资源耗尽、会话取消路径无界等待）中断——两个缺陷均被定位并修复（渲染资源闸门、强制取消），续测一次通过，本身即 3.10/2.2 节"可恢复性"目标的工程实证。

**输出结构（四表）**：

| 表 | 行数 | 字段（语义） |
| --- | --- | --- |
| `gene_records.csv` | 213 | hgnc_symbol、hgnc_id、gene_name、alias_symbols、previous_symbols、locus_group、locus_type、status（HGNC 归一后的现行身份） |
| `disease_records.csv` | 269 | orphacode、disease_name、synonyms、disease_type、disorder_group |
| `gene_disease_records.csv` | 241 | orphacode、hgnc_symbol、orphanet_gene_symbol、gene_name、association_type、source（主表） |
| `gene_evidence_crosswalk.csv` | 241 | hgnc_symbol、orphacode、clingen_classification（+日期/疾病标签）、clinvar_count（+查询串）、conflict_flag、conflict_detail |

关联样例（`gene_disease_records`）：`567, TBX1, TBX1, "T-box transcription factor 1", "Disease-causing germline mutation(s) in; Role in the phenotype of", Orphanet en_product6`。结构校验 67/67 通过（候选引用闭合、逐表 schema 契约、主键唯一、外键关系、provenance 覆盖等），`product_status=publishable`。

**来源清单（五个正式载体，provenance 逐条登记 receipt、请求身份摘要与官方端点快照）**：en_product1（54,026,799 B，`df8d562a…`）、en_product6（22,612,034 B，`f1c039f7…`）、HGNC current（16,948,051 B）、ClinVar gene-esearch（460 B）、ClinGen current（1,119,208 B）。

**诚实边界**：本例 crosswalk 的 ClinVar/ClinGen 数值列在发布表中为空——两个载体虽已获取并绑定，但数据变换未将值落入交叉表（ClinVar 载体亦仅绑定单基因 BTK）；结构校验不检查可选列填充率，因此照常通过。团队复核后已将此偏差记入案例档案，并把"源维度行级填充率检查"列为 ProductAssessment 的改进项。报告如实呈现该边界：gold9 闭合的是 Orphadata×HGNC 两源四表与完整发布/溯源/验证链，而非 TOPIC 全部四源的数值级整合。

### 5.5 可调用测试 API 与可交互前端

系统以 HTTP API 与 Web 前端同时暴露全部能力，评审可不经代码直接复现上述案例：

| 端点 | 方法 | 作用 |
| --- | --- | --- |
| `/api/v1/health` | GET | Host/运行时/Core 健康自检 |
| `/api/v1/tasks` | POST / GET | 创建任务（自然语言输入即 Body）/ 列出任务 |
| `/api/v1/tasks/{task_id}` | GET | 任务快照：状态、runs、artifact 数、当前发布指针 |
| `/api/v1/tasks/{task_id}/runs` | POST | 在既有任务上发起新 run（续跑） |
| `…/runs/{run_id}/cancel` · `…/resume` | POST | 取消 / 恢复（含权限与 HIL 恢复） |
| `…/runs/{run_id}/permissions/{request_id}` | POST | 权限裁决（approve/deny，绑定证据摘要） |
| `/api/v1/tasks/{task_id}/compact` | POST | 手动上下文压缩 |
| `/api/v1/publications/{pub_id}/artifacts/…` | GET | 发布物与逐 artifact 下载（消费时重验 SHA-256） |
| `/api/v1/settings` · `/api/v1/model-registry/*` | GET/PUT/POST | 模型供应商/模型注册、参数与激活（不锁定任何模型） |
| `/api/v1/ws` | WebSocket | 事件流实时订阅（工具调用、验证、发布事件） |

前端（React 19 + Vite + Tailwind）提供任务列表与创建、run 事件时间线、发布物查看（按当前发布指针渲染并重验摘要）、HIL 结构化问卷（字段映射/单位/发布确认等场景的 approve/reject/correct）、模型设置页。开发入口 `pnpm dev`（Host 8000 + 前端中间件），生产入口 `pnpm start`。三案例的完整复现命令（supervisor 调用模板、缓存种子方法、单实例约束）已在仓库 `docs/plans/` 与 `docs/gold-formal-rerun.md` 固化。

### 5.6 结构化输出样例与字段说明

以 gold9 跨源证据交叉表为例（真实发布行）：

```csv
hgnc_symbol,orphacode,clingen_classification,clingen_classification_date,clingen_disease_label,clinvar_count,clinvar_query,conflict_flag,conflict_detail
TBX1,567,,,,,,NONE,
```

字段语义：`clingen_classification` 为 ClinGen 基因-疾病有效性分类（如 Definite/Strong/Limited；Refuted/Disputed 出现时触发冲突逻辑）；`clinvar_count` 为 ClinVar 该基因致病记录计数，`clinvar_query` 保留实际查询串以供复核；`conflict_flag` 取 `NONE` 或 `CONFLICT_CLINGEN_REFUTED_OR_DISPUTED_WITH_ORPHANET_ASSOCIATION`，`conflict_detail` 列出冲突的 ClinGen 疾病标签。空值即"来源未覆盖该单元格"，系统不以零或推断填充。

来源凭据样例（`provenance.json` 中 `input_asset_receipts` 的第一条，逐字段）：

```json
{ "asset_id": "asset_df8d562a0c6011af…c0962bbb", "role": "in_0",
  "sha256": "df8d562a0c6011af36a74eb4000ce81ca7d723e8031010819fb71727c0962bbb",
  "size_bytes": 54026799, "locator_ref": "asset_df8d562a0c60…c0962bbb" }
```

即：输入不是"一个下载文件"，而是（任务、来源、字节摘要、采集实现身份）共同绑定的证据对象。发布清单（`dataset_manifest.json`）对每个 artifact 登记相对路径、媒体类型、字节数与 SHA-256（如 gold8 主表 13,558 B / `08e9db4f…`，清单文件摘要 `1ec9f4ab…`）；消费端每次读取都重算摘要，文件被改动即拒绝展示。

### 5.7 案例结论对照赛题评价标准

| 评价维度 | 三案例证据 | 尚存边界 |
| --- | --- | --- |
| 数据查找完备性 | 路线检查 + 多库治理采集（GWAS Catalog/Europe PMC/dbSNP、openFDA、Orphadata/HGNC/ClinVar/ClinGen）；不可达来源显式阻断而非静默缺失 | 全局 QueryPlan/SourceCoverage 证据尚未产品化（3.3 节），不能宣称"全网查全" |
| 来源可追溯性 | 全部正式行携带 source_url/locator；输入载体字节级摘要入链；发布产物消费时重验 | gold9 跨源数值列未落表（已披露），证据维度整合深度依赖载体绑定完整性 |
| 清洗整合可靠性 | 动态预检 11 次结构化拒绝迭代；v1→v2 自检换版；68/72 行真实缺失逐条列出；四表主外键闭合 67/67 | 冲突合并为确定性策略（first source wins），稳定但不等于科学裁真（3.7 节） |
| 输出格式可用性 | 三例均交付 CSV+Schema+Provenance+Validation+Manifest 的不可变发布，逐件 SHA-256 经第三方监督重验 | 图表抽取到正式发布的链路仍在接线中（3.5.3 节），当前以 preview 呈现 |

## 六、总结与讨论

### 6.1 BioMed QAgent 系统带来的收益

分别以“纯人工整理”和“纯 Agent 问答”为基线，说明本系统的收益。

#### 6.1.1 相较于纯人工带来的收益

系统预期主要减少以下人工成本：

1. 在多个数据库之间重复输入查询、下载和整理文件；
2. 手工复制表格、重命名列和统一缺失值；
3. 反复查找每条记录来源和版本；
4. 人工检查主键、外键、重复、冲突和基础格式；
5. 任务中断后重新开始；
6. 发现错误后无法定位步骤而整体重做；
7. 为下游分析补写 Schema、来源清单和处理说明。

#### 6.1.2 相较于纯 Agent 带来的收益

以“把一次性问答直接当作最终答案”的纯 Agent 工作流为基线，本系统的收益是把对话输出升级为可复用、可核验的数据产品：

- 确定性与可复现：固定执行骨架和确定性 Core 使同一需求在相同输入下产出可复现结果，而纯 Agent 的自由改写流程难以稳定复现；
- 来源与版本证据：每条记录可追溯到 SourceAsset 与 Provider 版本，纯 Agent 只能给出无法独立核验的引用列表；
- 质量门与审计：Validation、conflict audit 与 ProductAssessment 在发布前拦截结构与一致性错误，纯 Agent 交付物缺少这类检查；
- 可恢复与可修正：checkpoint、Durable HIL 与 supersedes 使长任务可续跑、错误可定位重发，纯 Agent 会话中断或出错后往往需要整体重来。

### 6.2 相比基线的消耗

可信闭环并非零成本。同样以两条基线分别说明新增的消耗。

#### 6.2.1 相较于纯人工带来的消耗

相较纯人工整理，系统引入了自动化组件自身的消耗：

- token 成本：正式规格与 Family/Schema 设计、Agent 推理与 Qwen-VL 图表抽取等模型调用均计入 token 消耗，需求越复杂规格设计成本越高；
- 存储成本：来源文件、checkpoint、审计和 Publication 的持久化占用；
- 计算成本：SHA-256、验证、多表关系检查和重复执行的计算开销；
- 访问成本：Qwen/Qwen-VL 调用和专用数据 API 的使用费用；
- 人工审核成本：模糊映射、低置信度抽取和冲突的人工核对；
- 一次性工程成本：新数据源接入 Provider、Adapter 和验证配置的适配工作量。

#### 6.2.2 相较于纯 Agent 带来的消耗

相较纯 Agent 问答，本系统为实现确定性、证据链与可复用产物，多付出了以下消耗：

- 额外模型与计算成本：正式规格、Family/Schema 设计、固定骨架的 Stage 级检查、SHA-256 与重复执行验证，都高于“一次问答生成答案”的开销；
- 存储与维护成本：来源文件、checkpoint、审计与 Publication 需要持久化，纯 Agent 通常不保留这类产物；
- 人工审核成本：HIL、低置信度抽取和冲突核对需要在流程中安排研究者介入，而纯 Agent 的“先回答后纠错”可以完全自助，但代价是没有质量保证；
- 配置成本：为每个 Family 注册 Schema、Adapter 和验证 profile 需要一次性投入，且新数据源接入成本高于纯 Agent 的直接提问。

项目的价值不应表述为“消除人工”，而应表述为：把人工从重复搬运转向对科学语义、不确定性和冲突的高价值核对，并使这些核对结果可持续复用。

### 6.3 对科研数据适用性的实际意义

对研究者而言，正式 Publication 比聊天答案更接近可纳入科研流程的数据对象：它能被脚本读取，有明确 Schema，包含来源与质量说明，可以在发现错误时定位并修正。对团队协作而言，Manifest 和 supersedes 关系降低了“每个人手里有一份不同 CSV”的风险。对后续知识图谱、统计分析或证据推理而言，多表关系和 provenance 提供了比宽表复制更稳定的输入。

这种意义建立在能力边界被诚实保留的前提下：Validation 通过不等于科学结论正确，结构关系闭合不等于跨来源实体一定同一，统计异常 warning 也不等于系统已经自动纠错。

### 6.4 结论

BioMed-QAgent 针对赛题“从科学问题到可用数据”建立了一条从自然语言需求、来源发现、正式采集、异构解析、字段规范化、多源整合、质量反馈到不可变发布的闭环。其关键不在于让 Qwen 直接生成更多内容，而在于把模型放在适合开放式推理的位置，并把正式数据改变交给可验证的 Dataset Core。

系统通过 SourceAsset、版本证据、SourceLocator、OperationResult、Audit、Validation 和 Manifest 保留来源与处理过程；通过 Durable HIL 和 checkpoint 将人工反馈纳入可恢复执行；通过 Publication 把“任务完成”定义为可重验的数据产品，而不是一次性问答结果。这些设计直接回应赛题对多源异构处理、来源可追溯、清洗整合、结构化输出和错误修正的要求，把“问题 → 来源 → 处理 → 核对 → 发布 → 再修正”组织成一个可追踪的闭环：闭环设计保证错误可定位与可恢复，来源保留保证每条正式数据可复核到原始位置，质量反馈保证人工判断的结果可持续复用于后续版本。三者共同支撑赛题的最终提交要求——数据质量控制、来源追溯与图表数据提取。

系统不仅能找到和整理科学数据，还能说明每条正式数据从哪里来、经过什么处理、质量如何、何处不确定，以及收到反馈后如何形成可追溯的新版本。
