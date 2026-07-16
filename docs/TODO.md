# BioMed-QAgent 开发 TODO

> 当前执行依据：[ARCHITECTURE.md](ARCHITECTURE.md) 与
> [Backend Data Closure Design](superpowers/specs/2026-07-12-backend-data-closure-design.md)。

## 0. 当前目标

优先完成一个真实、可重复、可追溯的后端闭环：

```text
主题
    -> PubMed PMID 34180400
    -> GEO GSE178352
    -> 下载真实 processed counts
    -> 解析和标准化
    -> 生成完整产物包
    -> Validation Gate
    -> Artifact API 下载
```

Mock 流程只能用于开发烟雾测试，不作为比赛验收结果。

## 1. 优先级

| 优先级 | 含义 |
| --- | --- |
| P0 | 后端真实闭环和可信产物必需 |
| P1 | Agent/API 集成和前端正式使用必需 |
| P2 | 第二案例、更多数据库和比赛加分项 |

## 2. 已批准架构决策

- [x] **P0** 保留 OpenAI Agents SDK 作为 Agent Runtime
- [x] **P0** 保留一个 Main Agent 和按需 Skill 加载
- [x] **P0** 保留 builtin/learned 统一 Skill 仓库
- [x] **P0** Skill 按 discovery、acquisition、processing、analysis 分类
- [x] **P0** 一个网站对应多个 Tool，不强制一个网站一个 Skill
- [x] **P0** 下载与解析严格分离
- [x] **P0** 新增确定性 Pipeline Runner
- [x] **P0** Agent 只生成 TaskSpecification，不直接拼装产物
- [x] **P0** 产物必须通过 Validation Gate 才能进入 artifacts/
- [x] **P0** 固定真实案例采用 GSE178352 + PMID 34180400
- [x] **P0** 默认 CI 使用真实数据 fixture，live 测试下载完整官方文件
- [x] **P1** 后端契约稳定后使用 shadcn 重写前端任务工作台

## 3. 已有基础与审计结论

### 3.1 可复用基础

- [x] OpenAI Agents SDK Agent/Runner/Function Tool 骨架
- [x] DashScope/Qwen OpenAI-compatible 模型适配骨架
- [x] FastAPI、HTTP 路由和 WebSocket 骨架
- [x] RunContext 与独立任务目录骨架
- [x] SkillRegistry 与四类 Skill 目录
- [x] 文件 Tool 绝对路径、`..` 和目录逃逸防护
- [x] CSV/TSV/JSON/HTML 等解析原语
- [x] 清洗、字段对齐和 CSV 导出原语
- [x] Artifact 列表和安全下载路由原语
- [x] 现有测试在占位模型 Key 下为 99 passed

### 3.2 未通过验收的现状

- [x] **P0** 干净环境不配置模型 Key 时测试仍可运行（235 passed，2026-07-13）
- [x] **P0** 真实 Agent Demo 在总超时内产生终态
- [x] **P0** GEO 查询返回真实 GSE accession，而不是把数值 GDS ID 传给 GEOparse
- [ ] **P0** Xena 不再因固定 URL 返回 403
- [x] **P0** 数据库 API 启动后稳定列出数据库，不依赖模块导入顺序
- [x] **P0** 数据库 API 不混入 analysis/self-evolution 等非数据库 Skill
- [x] **P0** WebSocket 事件前后端使用同一 schema
- [x] **P0** 前端 WebSocket 连接与发送使用同一 client 实例
- [x] **P0** fixture REST 流程的 task_id 从创建、执行到 Artifact 下载完整贯通
- [x] **P0** fixture 真实流程输出可追溯产物，而非 mock 数据
- [x] **P0** 主数据只包含 gene + sample 一种记录粒度
- [x] **P0** 每个源数据派生测量有精确 SourceLocator
- [x] **P0** 非空 warnings 与汇总 metrics 计数一致（fixture 当前为 0 warning）
- [x] **P0** 正式产物实际位于任务 artifacts/ 并可通过 API 下载
- [x] **P1** 建立前端 Vitest、TypeScript、ESLint 和 build 门禁

上述条目通过测试和产物证据前，不得重新勾选为完成。

## 4. Phase 1A：契约与目录

当前状态：新的权威边界位于 `backend/app/domain/contracts/`。旧 Tool 仍使用的
dataclass 是迁移兼容层，必须在对应 Processing/Pipeline 工作中逐个替换后才能删除。

### 4.1 领域契约

- [x] **P0** 定义 `TaskRequest`
- [x] **P0** 定义 `TaskSpecification`
- [x] **P0** 定义 `QuerySpecification`
- [x] **P0** 定义 `DatasetSelection`
- [ ] **P0** 迁移并删除旧输出层 `SourceRecord` dataclass
      > **现状（2026-07-15 最小迁移）**：6 个 acquisition skill（pdb/pubchem/reactome/xena/gdc/browser）
      > 与 pubmed discovery 已迁移到 `app.domain.contracts.SourceRecord`。旧 `app.domain.output.SourceRecord`
      > dataclass 仍被 `app.tools.export`、`app.tools.parse_*`、`app.tools.cleaning` 等 MVP 通用工具引用，
      > 暂不删除——见 §4.4 MVP 待清理部分。
- [x] **P0** 定义权威 `SourceRecord` 契约（旧输出 dataclass 尚待迁移）
- [x] **P0** 定义 `SourceRelation`
- [x] **P0** 定义 `DownloadAttempt`
- [x] **P0** 定义统一 `FileAsset`
- [x] **P0** 定义只表示成功文件的 `SourceAsset`
- [x] **P0** 定义 `DataLevel`，区分 raw sequence 与 repository processed
- [x] **P0** 定义精确 `SourceLocator`
- [ ] **P0** 将旧 Tool 迁移到 on-disk `ParsedDataset` 契约
      > **现状（2026-07-15 最小迁移）**：旧 `app.domain.processing.ParsedDataset`（含 `rows: list[dict]`
      > 内存数据表）与新 `contracts.ParsedDataset`（on-disk 元数据，`file_asset` 指向磁盘文件）语义不同，
      > 不能简单替换。Pipeline 专用 processor（如 `geo_tximport.py`）已用新契约；MVP 通用工具保留旧模型，
      > 待后续清理——见 §4.4 MVP 待清理部分。
- [x] **P0** 定义 on-disk `ParsedDataset` 契约（旧内存模型尚待迁移）
- [x] **P0** 定义幂等执行所需的 `StageAttempt` 契约
- [x] **P0** 定义 `ArtifactManifestEntry`
- [x] **P0** 定义 `RunManifest`、Warning、Error 和任务状态枚举
- [x] **P0** 定义 requested output 和 event payload 判别联合
- [x] **P0** 统一 `ContractModel(extra="forbid", validate_default=True)`
- [x] **P0** 集合字段使用 default_factory
- [x] **P0** 固定 schema version 与 ID 生成规则
- [x] **P0** task_id 和相对路径执行安全校验

### 4.2 工作目录

- [x] **P0** 统一使用 `data/output/tasks/<task_id>/`
- [x] **P0** 包含 source_assets、download_tmp、parsed、normalized、staging、artifacts、state、logs
- [x] **P0** SourceAsset 路径只能位于 source_assets/
- [x] **P0** 来源文件不可被覆盖
- [x] **P0** Artifact 只能从 staging 验证后提升
- [x] **P0** API 只公开已验证 manifest 注册的 artifacts/
- [x] **P0** 增加任务级锁
- [x] **P0** 增加 SHA-256 内容寻址 blob cache
- [x] **P0** accession/URL/request 参数映射查询缓存，关键词不作资产身份

### 4.3 TDD 验收

- [x] **P0** 每个新契约先写失败测试
- [x] **P0** 覆盖空 topic、非法 task_id、未知字段和路径逃逸
- [x] **P0** 覆盖 failed/partial attempt 不产生 SourceAsset
- [x] **P0** 覆盖 SourceAsset checksum、size、data level 和路径约束
- [x] **P0** 覆盖 dataset/sample/source/asset 外键
- [x] **P0** 覆盖 staging 未验证时不可下载

### 4.4 MVP 待清理部分（2026-07-15 标注）

> 以下模块是 MVP 阶段的临时兼容层，已被 Pipeline 专用 processor 取代，
> 但仍被 `app.tools.export`、`app.tools.parse_*`、`app.tools.cleaning`、
> `app.tools.processing`、`app.tools.alignment` 等通用工具引用。在 §4.1
> "迁移并删除旧输出层 SourceRecord dataclass" 与 "将旧 Tool 迁移到 on-disk
> ParsedDataset 契约" 完成前**不得删除**，但新代码必须直接使用
> `app.domain.contracts`。

| 待清理模块 | 现状 | 替代方案 | 何时清理 |
| --- | --- | --- | --- |
| `app/domain/output.py`（旧 `SourceRecord` dataclass） | 被 `tools/export`、`tools/parse_*`、`tools/cleaning`、`tools/processing`、`tools/alignment` 引用 | `app.domain.contracts.SourceRecord` | 旧 Tool 全部迁移到新契约后 |
| `app/domain/processing.py`（旧 `ParsedDataset` 含 `rows: list[dict]`） | 被 MVP 通用解析工具引用 | `app.domain.contracts.ParsedDataset`（on-disk 元数据） | 旧 Tool 全部迁移到 on-disk 模型后 |
| `app/tools/export.py` | MVP CSV 导出，使用旧 `ParsedDataset.rows` | Pipeline Artifact Builder（已用新契约） | Pipeline Runner 完成后评估 |
| `app/tools/parse_geo.py`、`parse_pdb.py`、`parse_excel.py` | MVP 通用解析原语 | Pipeline 专用 processor（如 `geo_tximport.py`） | 各数据源专用 processor 齐备后 |
| `app/tools/cleaning.py`、`processing.py`、`alignment.py` | MVP 通用清洗/处理/对齐原语 | Pipeline 专用 processor | 各数据源专用 processor 齐备后 |
| `app/domain/__init__.py` 顶层导出 | 旧 dataclass 仍可从顶层导入 | 仅从 `app.domain.contracts` 导入 | 旧 dataclass 删除时一并清理 |

**约束**：
- 新增 acquisition skill 或 processor 必须直接使用 `app.domain.contracts`，不得引入旧 dataclass。
- 修改上述待清理模块时，应优先迁移到新契约而非加固旧实现。
- 删除任何待清理模块前，必须确认无引用并更新 `app/domain/__init__.py`。

## 5. Phase 1B：固定真实数据

### 5.1 Fixture

- [x] **P0** 下载官方 `GSE178352_tximportCounts.txt.gz`
- [x] **P0** 记录官方 URL、时间和完整文件 SHA-256
- [x] **P0** 生成体量受控的真实 fixture
- [x] **P0** fixture manifest 记录保留行列和提取命令
- [x] **P0** fixture 自身保存 SHA-256
- [x] **P0** 保存 PMID 34180400 的真实 PubMed 响应 fixture
- [x] **P0** 保存 GSE178352 的真实 GEO 元数据 fixture
- [x] **P0** fixture 不包含伪造 accession、PMID 或表达值

### 5.2 PubMed

- [x] **P0** 使用 NCBI E-utilities，不抓取 PubMed HTML
- [x] **P0** 配置 tool、developer email、User-Agent 和可选 API key
- [x] **P0** 无 API key 全局限制 3 req/s，有 key 默认限制 10 req/s
- [x] **P0** 批量 efetch 并记录 NCBI term translation、分页和返回顺序
- [x] **P0** 429/5xx 使用有界指数退避并尊重 Retry-After
- [x] **P0** 搜索结果包含 PMID、PMCID、DOI、标题、作者、期刊和摘要
- [x] **P0** 实际查询式、顺序和来源 URL 可导出
- [x] **P0** PMID 34180400 关联到 GSE178352
- [x] **P0** 超时和上游错误返回结构化失败
- [x] **P0** 离线 client 使用 fixture，不调用网络

### 5.3 GEO

- [x] **P0** 修复 GEO 数值搜索 ID 到 accession/metadata 的转换
- [x] **P0** `search_geo` 返回真实 GSE accession
- [x] **P0** `describe_geo("GSE178352")` 返回 12 个样本和关联 PMID
- [x] **P0** 获取 processed counts 的真实下载 URL
- [x] **P0** 每次下载生成 DownloadAttempt
- [x] **P0** 完整校验成功后才生成 SourceAsset，不调用解析器
- [x] **P0** 标记 GSE178352 counts 为 repository_processed
- [x] **P0** 下载采用流式写入、临时文件和原子重命名
- [x] **P0** 下载记录 status、size、SHA-256、MIME 和时间
- [x] **P0** 设置连接、读取和最大文件限制
- [x] **P0** 失败文件不得标记 success
- [x] **P0** partial/failed 文件不得成为 Parser 输入
- [x] **P0** 成功文件写入内容寻址 cache，任务目录硬链接或校验复制

## 6. Phase 1C：Processing

### 6.1 Counts Parser

- [x] **P0** 只接受成功 SourceAsset
- [x] **P0** 解析时读取压缩文件，保留原始 `.gz`
- [x] **P0** 解析制表符 counts matrix
- [x] **P0** 验证 12 个预期 GSM 样本列
- [x] **P0** 记录 parser 名称与版本
- [x] **P0** 输出 ParsedDataset 元数据

### 6.2 标准化

- [x] **P0** `main_data.csv` 一行表示 gene + sample
- [x] **P0** 生成稳定 record_id
- [x] **P0** 保存 dataset_id、source_id、asset_id
- [x] **P0** expression_value 保存数值类型
- [x] **P0** 保存 logical_file、1-based physical line、0-based column index、column name 和 raw token
- [x] **P0** 文献、数据集和样本元数据分表
- [x] **P0** 不生成原文件中不存在的 log2FC、p-value 或 subtype

### 6.3 清洗与字段映射

- [x] **P0** 检测空 gene_id 和 sample_id
- [x] **P0** 检测重复 gene/sample 键
- [x] **P0** 检测非数值表达值
- [x] **P0** 不确定值进入 warning，不静默删除
- [x] **P0** field_mapping 记录 source 字段、标准字段和转换规则
- [x] **P0** 输出 cell_line_raw、cell_line_canonical 和 normalization_rule
- [x] **P0** 输出 gene_id_raw、namespace 和 version
- [x] **P0** 明确 measurement_type、value_semantics、scale 和 normalized 状态
- [x] **P0** processing log 记录 rows_before/rows_after

## 7. Phase 1D：Artifact Builder

- [x] **P0** 生成 `run_manifest.json`
- [x] **P0** 生成 `main_data.csv`
- [x] **P0** 生成 `literature.csv`
- [x] **P0** 生成 `dataset_catalog.csv`
- [x] **P0** 生成 `sample_metadata.csv`
- [x] **P0** 生成 `field_descriptions.csv`
- [x] **P0** 生成 `field_mapping.csv`
- [x] **P0** 生成 `source_list.csv`
- [x] **P0** 生成 `source_relations.csv`
- [x] **P0** 生成 `source_assets.csv`
- [x] **P0** 生成 `download_log.csv`
- [x] **P0** 生成 `processing_log.csv`
- [x] **P0** 生成 `quality_report.csv`
- [x] **P0** 生成 `warnings.csv`
- [x] **P0** CSV 中结构化参数使用合法 JSON
- [x] **P0** 固定 authors、ID arrays、refs、parameters 和 warnings 的排序规则
- [x] **P0** 所有 Artifact 记录大小与 SHA-256
- [x] **P0** Artifact 输出顺序稳定，可重复比较

## 8. Phase 1E：Validation Gate

- [x] **P0** 验证 main_data source_id 完整关联
- [x] **P0** 验证 main_data dataset_id 存在于 dataset_catalog
- [x] **P0** 验证 main_data sample_id 存在于 sample_metadata
- [x] **P0** 验证 sample_metadata dataset_id 存在于 dataset_catalog
- [x] **P0** 验证 main_data asset_id 存在于 source_assets 并关联 success attempt
- [x] **P0** 验证 source asset 存在且 checksum 一致
- [x] **P0** 验证所有主表字段都有字段说明
- [x] **P0** 验证每个源数据派生测量有完整 SourceLocator
- [x] **P0** 固定 GSE178352 案例全量回溯 expression value
- [x] **P0** 一般任务全量检查结构，默认确定性抽样 100 个源数据值
- [x] **P0** 验证 processing log 完整
- [x] **P0** 验证非空 warnings 与 metrics 一致
- [x] **P0** 验证必需 Artifact 存在且 schema 完整
- [x] **P0** 失败报告写入 logs/validation_report.json
- [x] **P0** 任一失败时不发布 artifacts/
- [x] **P0** 发布执行任务锁、file flush、manifest valid 标记和同文件系统原子 rename
- [x] **P0** 发布完成后才持久化 artifact_produced/task_completed

## 9. Phase 1F：Pipeline Runner

- [x] **P0** 实现固定阶段状态机与 append-only StageAttempt
- [x] **P0** 每个阶段消费和返回明确类型与 input/parameter/output digest
- [x] **P0** 阶段操作幂等，重试生成新 attempt
- [x] **P0** 摘要匹配时复用已验证输出
- [x] **P0** 进程重启后从最近成功阶段恢复
- [x] **P0** 阶段失败时停止下游阶段
- [x] **P0** 网络、模型、解析和完整任务独立超时
- [x] **P0** 每个任务保证 completed 或 failed 终态
- [x] **P0** 正式流程失败时禁止自动切换 mock success
- [x] **P0** 支持离线 fixture 模式
- [x] **P0** 支持显式 live 模式
- [x] **P0** mock 模式必须显式标记且不能通过 live 验收
- [x] **P0** 支持 cancel requested、cancelled、recovered 和 skipped 状态

## 10. Phase 1 测试

### 10.1 默认快速测试

- [x] **P0** 无 DashScope Key 可 import app 和创建确定性 Pipeline
- [x] **P0** 默认 pytest 不访问外网
- [x] **P0** 领域契约单元测试
- [x] **P0** extra forbid、default_factory、schema version 和 ID 测试
- [x] **P0** dataset/sample/source/asset 外键测试
- [x] **P0** GEO ID 转换回归测试
- [x] **P0** NCBI 限速、批量与重试测试
- [x] **P0** DownloadAttempt、checksum、cache 和中断测试
- [x] **P0** parser 与 long-form 测试
- [x] **P0** SourceLocator、名称规范化、字段映射和行数测试
- [x] **P0** StageAttempt、锁、取消、幂等和恢复测试
- [x] **P0** 全部 Validation Gate 规则测试
- [x] **P0** 完整 fixture Pipeline 集成测试
- [x] **P0** Artifact API 列表和下载测试
- [x] **P0** 产物 schema 与固定案例全量值追溯测试

### 10.2 Live 测试

- [x] **P0** pytest `live` marker 默认不运行
- [x] **P0** 实时获取 PMID 34180400
- [x] **P0** 实时获取 GSE178352 元数据
- [x] **P0** 实时下载完整 4,597,797 bytes counts 文件
- [x] **P0** 校验样本 ID、size 和 SHA-256
- [x] **P0** 最小 Qwen TaskSpecification 测试
- [x] **P0** 完整 live 流程在总超时内产生终态

## 11. Phase 2：Agent 与 API

- [ ] **P1** Agent 使用结构化 TaskSpecification
- [x] **P1** Pipeline 暴露为单一 SDK Function Tool
- [x] **P1** 数据库过滤不加载未选择 acquisition Tool
- [x] **P1** Agent 正式产物统一调用 Pipeline Tool，不直接拼装最终 CSV
- [x] **P1** `POST /api/v1/tasks` 创建 task_id
- [x] **P1** TaskRequest API 校验
- [x] **P1** Task status 返回当前 stage 和终态
- [x] **P1** Artifact API 只列出 manifest 中已验证文件
- [x] **P1** Artifact 下载使用 artifact_id，不接受任意 path
- [x] **P1** 支持任务取消
- [x] **P1** 统一 WebSocket event envelope
- [x] **P1** 统一 schema_version、event_id、task_id、stage_attempt_id、sequence、timestamp、payload
- [x] **P1** payload 使用判别联合，不接受任意 dict
- [x] **P1** 事件先持久化再推送，支持按 sequence 续读
- [x] **P1** 事件覆盖创建、计划、阶段成功/失败/跳过、工具、警告、取消、恢复、Artifact 和终态
- [x] **P1** API/WebSocket 契约集成测试

## 12. Phase 3：shadcn 前端重写

后端事件与 Artifact 契约稳定后开始。

- [ ] **P1** 使用 shadcn Form 创建任务
- [x] **P1** 数据库选择只显示真实数据库
- [ ] **P1** 计划确认 Card/Dialog
- [x] **P1** 阶段 Timeline/Progress
- [ ] **P1** 结果使用 Tabs 分离主数据、来源、处理和警告
- [ ] **P1** 使用 Table 展示紧凑预览
- [x] **P1** Artifact 下载列表
- [ ] **P1** 单一 task/event client
- [ ] **P1** 自动重连和任务恢复
- [x] **P1** Vitest + React Testing Library
- [x] **P1** ESLint、TypeScript 和 production build 检查
- [x] **P1** 真实浏览器覆盖 fixture 创建、执行、结果展示和下载流程

## 13. Phase 4：扩展能力

- [ ] **P2** 开放获取 PDF 和补充材料
- [ ] **P2** PDF 表格与定位信息
- [ ] **P2** 图表提取、坐标轴、单位、图例和置信度校验
- [ ] **P2** GDC search/metadata/download live 测试
- [ ] **P2** PDB search/metadata/download live 测试
- [ ] **P2** Xena 403 修复与 live 测试
- [ ] **P2** 第二个真实多数据库案例
- [ ] **P2** 描述性统计和可视化
- [ ] **P2** learned Skill 语法、重放和人工启用流程

## 14. Phase 1 完成标准

以下条件必须在同一轮新鲜验证中全部满足：

- [x] 默认 pytest 无真实 Key 通过（434 passed，20 live deselected，2026-07-16）
- [x] pinned fixture Pipeline 生成全部 14 个必需文件及正式 RunManifest
- [x] 主数据只包含 gene + sample 粒度
- [x] dataset_id、sample_id、source_id 和 asset_id 外键全部有效
- [x] 每条源数据记录含精确 SourceLocator
- [x] GSE178352 fixture 全部 48 个 expression value 可从 source asset 精确复算
- [x] 所有字段有说明，所有下载有 checksum
- [x] cleaning、mapping 和 processing 记录完整
- [x] Validation Gate 通过才发布 artifacts/
- [x] Artifact API 通过 artifact_id 列出并下载完整产物包
- [x] live PubMed + GEO 获取与完整 counts 校验在总超时内完成
- [x] 阶段失败、取消和恢复保留完整 attempt/event 历史
- [x] 真实失败不会转换成 mock success
- [x] 文档和 TODO 只勾选已有自动测试或浏览器证据的条目
