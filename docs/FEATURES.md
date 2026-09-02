# BioMed-QAgent 功能与能力全景

> **本文档面向谁**：编写项目汇报材料 / PPT 的协作者、新加入的工程师、产品与数据分析同事。
> 它描述系统**是什么、能做什么、怎么证明已实现**，并把每项能力对齐到赛题
> （[PROBLEM.md](../PROBLEM.md)，主选题 A）的四项评价维度，方便直接取材。
>
> **与架构文档的分工**：本文只讲"功能与能力现状"，不重复讲"系统如何组织、
> 边界与约束"。技术架构（组件、事件模型、数据契约、安全边界）的权威见
> [ARCHITECTURE.md](ARCHITECTURE.md)；实现分层见
> [architecture/dataset-execution.md](architecture/dataset-execution.md)；
> 演进方向见 [architecture/roadmap.md](architecture/roadmap.md) 与
> [TODO.md](TODO.md)。
>
> **实现状态口径**：所有能力均以**代码为事实来源**；本文只描述已落地、
> 可由测试或运行验证的功能，尚未完成的能力标注为「规划中/部分完成」。

---

## 1. 一句话定位

BioMed-QAgent 是一个**生物医学数据智能检索与整合系统**：用户用自然语言描述
研究主题，系统对已注册执行路线（family/schema/provider 闭合、输入闭包明确）的任务
自动完成「查找来源 → 获取原始数据 → 解析/清洗/字段对齐 → 整合 →
带来源与审计的标准化输出」，让数据处理**可追溯、可验证、可恢复**。

它**不**直接"猜"出一个 CSV，也不会在缺少数据证据时生成科研或临床结论——所有
正式产物都必须经过确定性的验证门禁（Validation Gate）才会发布。

---

## 2. 能力全景总览

| 能力域 | 核心职责 | 主要落点（代码） |
| --- | --- | --- |
| 自然语言任务化 | 把研究主题解析为结构化任务规格 | Pi Main Agent + `server/src/agent/pi-adapter.ts` |
| 多源检索与获取 | 检索文献与数据库、下载原始文件、记录来源 | `.pi/skills/` + `server/src/agent/tools/` |
| 确定性数据处理 | 获取 → 解析 → 归一化 → 兼容性 → 整合 → 验证 → 发布 | `server/src/dataset/` |
| 来源与审计 | checksum、下载日志、处理记录、质量门禁 | `server/src/dataset/` + 产物 CSV |
| Durable 任务运行时 | 任务/Run/事件/产物持久化、取消/恢复/重放/人在回路 | `server/src/runtime/` |
| 实时进度反馈 | REST + WebSocket 流式前端 | `frontend/src/runtime/`、`hooks/` |
| 模型与设置 | OpenAI 兼容模型配置、模型注册表 | `server/src/settings/`、`server/src/persistence/` |
| 视觉证据采集 | Playwright 截图 + Qwen-VL / PDF 图表数据提取 | `server/src/external/`、`server/src/processing/` |
| Skill 自迭代闭环 | 流程固化为可复用脚本 / 独立工具包 | `scripts/solidify-run.mjs` |

---

## 3. 核心能力详解（对齐赛题评价维度）

> 赛题（主选题 A）四项评分：**数据查找完备性、来源可追溯性、清洗整合可靠性、
> 输出格式可用性**。下表把每项能力映射到对应维度，便于写 PPT 时直接引用。

### 3.1 数据查找 · 多源异构来源发现与获取

系统通过**可插拔 Skill + TS 工具**访问多类生物医学数据源，把「来源」与「来源关系」
记录进任务。目前内置来源目录如下（`server/src/product/builtin-databases.ts`）：

| 数据库 | 状态 | 说明 |
| --- | --- | --- |
| PubMed | 支持管线 | 文献检索，用于发现研究、提供来源关系（不作为表达主表行） |
| GEO | 支持管线 | 基因表达数据、平台、probe mapping、尺度和归一化兼容性 |
| GDC | 支持管线 | TCGA 级别癌症基因组数据 |
| Xena | 支持管线 | UCSC Xena 表达/元数据镜像 |
| dbSNP | 支持管线 | 变异参考记录 |
| ClinVar | 支持管线 | 变异-疾病断言与临床证据 |
| MGnify | 支持管线 | 肠道微生物组研究（`gut_microbiome` family study 表） |
| ChEMBL | 支持管线 | 生物活性测量（`bioactivity_measurement` family） |
| UniProt | 支持管线 | 蛋白注释与靶点证据 |
| PDB | 支持管线 | 蛋白结构（含 mmCIF 解析、结构距离/序列比对衍生） |
| PubChem | 支持管线 | 化合物信息与 crosswalk |
| Reactome | 支持管线 | 通路/蛋白注释检索 |
| OpenFDA | 支持管线 | 药物不良事件检索 |
| 本地缓存 / 文件 | 能力 | `local_cache`、本地源导入（CSV/TSV/JSON） |

> 说明：「支持管线」指该来源的数据能进入受信任的 Dataset Core 摄取路径（静态注册
> family 或经动态 Family 路线的正式采集）。其余研究辅助能力（文献理解、PDF/图表
> 抽取、浏览器、缓存）不属于用户可选数据库，产物停在 workspace/cache。

其他检索/解析能力（非用户可选数据库，属 Agent 能力包）：
- **PubMed / 文献理解 / PDF 抽取**：从正文、表格、附件提取信息；
- **网页视觉采集 + 图表数据 VLM 抽取**：对论文页面截图，用 Qwen-VL / PDF /
  caption 文本组成降级链路提取图表数据（见 §3.6）；
- **browser / analysis / research_data_guidance**：浏览器自动化、分析、科研数据
  处理通用指导。

### 3.2 数据解析 · 多格式、多载体信息提取

- 内置受信任 Adapter 覆盖 GEO / GDC / Xena / STAR counts，可将结构化数据解析为
  不可变 `SourceAsset`（带 hash / media type / size 校验，ADR-029）；
- 通过 `Schema-driven RegisteredSourceAssetAdapter` 支持 CSV / TSV / JSON 的严格
  表头 / 行宽 / 类型校验，失败行进入审计拒绝记录（ADR-034）；
- 论文 / 附件 / 网页 / 图表数据的解析支持（PDF、VLM 图表抽取）；正式补充材料路线由
  Core 获取 Europe PMC ZIP，bounded member extractor 记录父 ZIP/member hash，随后固定
  CSV/TSV、XLSX、PDF table parser 生成可绑定的 UTF-8 derived assets；
- 压缩载体成员提取：`acquire_core_carrier` 把 zip 成员与 xlsx 工作表确定性转换为
  CSV extraction assets（Core 拥有并登记 provenance）；
- **Core 资产预览/解压工具**：`preview_core_asset` 只读列出 zip 成员清单并预览
  成员头部文本，`extract_core_archive` 把单个成员解出并注册为**新的 Core 资产**
  （derived 溯源，可直接绑入 dynamic family 的 `registered_sources`）；两者由
  Host 内置 stdlib ZIP 读取器确定性完成，模型无需也不允许再借道 python/shell
  解压（配套系统提示词 `[Dynamic publication mechanics]` 段，2026-08-29 直问
  验证 campaign 落地，见
  [reports/2026-08-29-gold-qwen-direct-validation-study.md](reports/2026-08-29-gold-qwen-direct-validation-study.md)）；
- 注册式多表 family 可由服务端 `scaffold_dataset_execution_spec` 从 live Family
  Registry 组合出 validate-ready 的完整执行规格，Agent 只提供 family、实体和来源绑定。
- 文献定量产品使用 Core-owned `literature_experiment_chart.release.v1` 六表 projection，
  profile scaffold 固定表/关系，Agent 只提交来源与抽取事实。

### 3.3 数据清洗与字段对齐 · 可靠性核心

系统不依赖模型"猜字段"，而是由**确定性 Dataset Core** 驱动：

1. **获取（Acquire）**：来源绑定 → 下载 → 校验（协议/域名/大小/超时/checksum）；
2. **解析（Parse）**：按来源 Adapter 解析为 `DataBatch`；
3. **归一化（Canonicalize / Normalize）**：字段映射、实体与单位规范化；字符串相似度
   只能产生 `proposed` 候选，必须经 Adapter / Schema Registry / 可信元数据 / 人工
   批准才进入正式合并（ADR §字段映射）。Agent 可用 `preflight_cleaning_rules` 获取
   Core 重排的候选与注册规则预检；预检 receipt 只在需要应用已接受规则时作为 execute
   的必要输入，`needs_hil` 是“应走后续 HIL 流程”的标记而非自动创建的 durable HIL，
   通用字段映射 transform 当前不执行（仅注册单位规则与精确 schema identity 可自动接受）；
   `inspect_source_coverage` 可消费已发布的
   `source_coverage_report.json`，据声明绑定范围内的失败项决定补源，不能宣称全网查全；
4. **兼容性门禁（Compatibility Gate）**：family / row granularity / key / measurement
   兼容，才允许合并；
5. **整合（Integrate）**：确定性合并，含磁盘化去重（`node:sqlite` temp table + 资源上限）；
6. **验证（Validate）**：由服务端版本化 Validation Profile 驱动，非提示词约束；
7. **发布（Publish）**：通过验证才**原子提升**为不可变 `DatasetPublication`。

**自动识别异常**（加分项）：缺失、重复、单位不一致的识别；图表坐标轴 / 图例
语义校验；对论文明确发布的数值做末位数 / 末两位数分布与插值规律检测（固定代码
卡方检验，异常时置信度降级为 low）；需要时请求人工确认来源映射或单位语义（HIL，
见 §3.5）。像素/矢量数字化、OCR 推断、插值和拟合坐标不作为正式数值。

### 3.4 来源标注 · 可追溯性

- 每个 requirement 的产物由 `dataset_manifest.json` 唯一权威声明（程序不硬编码文件名）；
- 每条数据可通过 `SourceAsset` / locator / Adapter / Parser / Profile 引用回溯到
  原始来源与处理版本；
- 产物含来源清单、来源关系、下载日志、字段映射、处理日志、质量报告、拒绝记录、
  警告（`source_list` / `source_relations` / `source_assets` / `download_log` /
  `field_mapping` / `processing_log` / `quality_report` / `warnings` 等）；
- 置信度可解释（批次默认 vs 记录级，VLM/LLM 抽取需记录级 + human review）。

### 3.5 人在回路（HITL）· 交互可靠

- 任务 / Run 支持**暂停 / 继续**，等待用户输入（计划确认、数据修正、达到轮次上限）；
- Agent 的文件访问与命令执行经 `allow / ask / deny` 权限系统，`ask` 挂起单个 Tool Call
  等待用户批准（durable events + `/permissions/{requestId}`，ADR-026）；
- 前端通过统一 Questionnaire 基础设施承载各类人机交互（`intervention/UserInputQuestionnaire`、`intervention/PermissionQuestionnaire`）；
- **三档 HIL 审批档位**（设置 → Agent → HIL 审批）：按审核范围把每个 blocking 审批分配为
  人工审批 / **大模型初审**（初审通过自动接受，仅不通过进入人工审批）/ 不审批；
  大模型初审的提示词会拦截绕过系统设计的请求（判不通过即回退人工审批）；
  发布边界（图表抽取、浏览器证据接受、发布验收）始终人工审批，详见
  [architecture/hil-approval-policy.md](architecture/hil-approval-policy.md)。

### 3.6 图表 / 图像数据提取 · 视觉证据

- 可选使用 Playwright 对网页 / 论文页面截图；
- 以 **Qwen-VL / PDF 解析 / caption 文本** 组成降级链路，发现图表、panel、series、
  坐标轴、图例和 page/bbox locator；VLM 图像几何不是精确数值来源；
- 正式 chart coordinates 全局采用 **exact-only**：非空点必须来自正文表格、补充数值
  文件、官方出版社 source data 或论文/作者明确关联仓库中的显式数值，并闭合到已注册
  numeric asset；找不到时保留图表定位、跳过 points、继续交付独立精确表格值并报告缺口
  （[ADR-043](adr/043-exact-only-chart-values.md)）；
- 旧 `estimated` point + `vlm_extraction` HIL + correction 发布路径已过时。当前代码为
  历史兼容暂留，新任务必须 reject/skip 估计点 review 且不绑定含估计点的 carrier；
  人工审核不能把估计升级为 exact；
- **迁移状态：部分完成。** Prompt/skills 和现行产品规范已切换；Core 对 reviewed
  estimate 的机械硬拒、官方 source-data acquisition/parser/series mapping 正向路径、
  frontend/evaluator 清理仍在 [`TODO.md`](TODO.md) P1 跟踪。既有 estimated-point
  fixture 只证明旧代码闭环，不证明当前产品能力。

---

## 4. 运行时能力

### 4.1 Durable 任务运行时

- 任务的权威事实来源是追加写入的 `<task_id>/events.jsonl`，snapshot 可从事件重建；
- 支持任务 / Run 生命周期、取消、恢复（重启后 `recoverActiveRuns`）、事件重放、
  构建记录与本地缓存；
- 正式评测 supervisor（`scripts/gold-formal-supervisor.mjs`）支持 **`--adopt`**：
  直接附加到任务当前/最新 Run 从序列 0 采证——直问建任务（无 bootstrap 占位），
  自动启动的 Run 即被测 Run（方法学与 campaign 见
  [reports/2026-08-29-gold-qwen-direct-validation-study.md](reports/2026-08-29-gold-qwen-direct-validation-study.md)）；
- dynamic family 发布为 **receipt-only submit**：submit 只需 `schema_version` 与
  prepare 返回的 `preflight_receipt`，服务端按收据解析已存储的 prepared
  submission（全量回显仍兼容）；prepared submission 存储在 Host 进程内
  coordinator（`server/src/runtime/dynamic-family-preflight-coordinator.ts`），
  不是跨重启 durable store；发布拒绝消息携带失败检查的 `detail`；
- 前端状态是后端事件的**投影**，不是事实来源。

### 4.2 实时反馈与界面

- 前端为 **React 19 + Vite + Tailwind v4 + shadcn/ui** 单页应用；编码 agent 风格
  步骤流：用户输入 / 思维链 / 工具调用 / 阶段 / 进度 / 警告 / 产物；
- 通过 REST + WebSocket 接收 Agent 文本、工具调用、Pipeline 阶段、进度、警告与
  产物事件；WS 支持断线重连按 durable sequence 补齐；
- 结果区按 Tab 展示产物，支持 CSV 预览与下载。

### 4.3 模型与设置

- 通过设置 API 配置 OpenAI 兼容模型；模型配置经**模型注册表**持久化（供应商/模型/
  激活状态入 `model-registry.json`，API Key 入 `model-auth.json`，0600，仅掩码返回）；
- 保存的模型快照在 Run 创建时形成不可变配置，避免并发变更影响已开始任务。

### 4.4 桌面 / 生产打包

- 正式分发为**跨平台源码包**（`frontend/dist` + `server/dist` + `database/` +
  `.pi/skills`），由 TS Host 静态托管（`pnpm start`）；
- 静态生产入口按 OS 用户持有唯一实例租约：已有实例时第二次 `pnpm start` 正常
  no-op，不创建第二个 Host；开发入口仍允许使用不同端口和 data root 的隔离实例；
- Host 首选 5173；端口被占用时由操作系统原子分配替代端口，实际地址通过
  `BIOMED_QAGENT_URL=<url>` 启动行公布；
- GitHub Actions 在推 `v*` 标签时构建并上传 bundle（不再使用 PyInstaller 单文件）。

---

## 5. Skill 系统与自迭代闭环

- **curated Skill**：`.pi/skills/<name>/SKILL.md` 是 SOP 知识（按任务加载）；
  配套 `server/src/agent/tools/` 为 TS 业务工具实现，稳定名称映射在
  `server/src/agent/skills/skill-tool-map.ts`；
- **Skill 自迭代闭环**（`scripts/solidify-run.mjs`）：执行完成后把工具流还原为
  **可复用 `.mjs` 脚本候选 + SKILL.md 候选 + 分析报告**；`--toolkit` 从
  `server/src/agent/tools/*.ts` 的静态工具元数据生成用途、参数、返回值、依赖和调用
  骨架，不重复摘要 `SKILL.md`。生产路径固化需人工评审（详见
  [architecture/skill-self-iteration.md](architecture/skill-self-iteration.md)）。
- **历史个性化 Skill 迭代**：设置页可选择一个 curated Skill 与最近已结束任务，
  由当前配置模型提炼带证据引用的用户偏好、数据处理方式和完整 SKILL.md 候选；
  历史在发送前脱敏并受预算限制，候选持久化但不自动激活（ADR-040）。

---

## 6. 视频演示建议脚本（可选）

> 面向赛题「10 分钟演示视频」或现场演示，提供一个可直接照着走的流程：

1. **开场定位**：说清"从科学问题到可用数据"；展示输入一个真实研究主题。
2. **数据查找**：演示 PubMed 发现 + GEO accession 定位 + 下载（含校验）。
3. **数据解析/清洗/对齐**：展示阶段进度条、工具调用、字段映射与归一化。
4. **来源与审计**：打开产物区，展示 manifest、来源清单、处理日志、质量报告。
5. **人在回路**：演示一次 HIL（计划确认或数据修正）与权限批准。
6. **结构化输出**：下载 CSV，说明字段含义与来源追溯。
7. **闭环 / 收尾**：可选展示流程固化为可复用脚本，说明系统可追溯可恢复。

---

## 7. 相关文档

| 文档 | 内容 |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 权威技术架构、数据流、契约、事件与安全模型 |
| [architecture/dataset-execution.md](architecture/dataset-execution.md) | 可信执行内核 / 执行模型分层 |
| [architecture/canonical-evidence.md](architecture/canonical-evidence.md) | Canonical Evidence 语义产品层（规划） |
| [architecture/roadmap.md](architecture/roadmap.md) | 演进方向、待决问题、非目标、被否决方案 |
| [TODO.md](TODO.md) | 开发任务与进度（P0–P3 / Gold 验收） |
| [PROBLEM.md](../PROBLEM.md) | 赛题背景、评分标准、最终提交要求 |
| [DEVELOPER_QUICKSTART.md](DEVELOPER_QUICKSTART.md) | 环境、启动、常用命令 |
