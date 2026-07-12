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

- [ ] **P0** 干净环境不配置模型 Key 时测试仍可运行
- [ ] **P0** 真实 Agent Demo 在总超时内产生终态
- [ ] **P0** GEO 查询返回真实 GSE accession，而不是把数值 GDS ID 传给 GEOparse
- [ ] **P0** Xena 不再因固定 URL 返回 403
- [ ] **P0** 数据库 API 启动后稳定列出数据库，不依赖模块导入顺序
- [ ] **P0** 数据库 API 不混入 analysis/self-evolution 等非数据库 Skill
- [ ] **P0** WebSocket 事件前后端使用同一 schema
- [ ] **P0** 前端连接与发送使用同一 client 实例
- [ ] **P0** task_id 从创建、执行到 Artifact 下载完整贯通
- [ ] **P0** 真实流程输出可追溯产物，而非 mock 数据
- [ ] **P0** 主数据只包含一种记录粒度
- [ ] **P0** 每个最终值能回溯到 raw 行列位置
- [ ] **P0** warnings 与 metrics 计数一致
- [ ] **P0** 正式产物实际位于任务 artifacts/ 并可通过 API 下载
- [ ] **P1** 建立前端单元测试和 lint

上述条目通过测试和产物证据前，不得重新勾选为完成。

## 4. Phase 1A：契约与目录

### 4.1 领域契约

- [ ] **P0** 定义 `TaskRequest`
- [ ] **P0** 定义 `TaskSpecification`
- [ ] **P0** 定义 `DatasetSelection`
- [ ] **P0** 重构 `SourceRecord`
- [ ] **P0** 定义 `RawAsset`
- [ ] **P0** 完善 `ParsedDataset`
- [ ] **P0** 定义 `Artifact`
- [ ] **P0** 定义结构化 Pipeline error
- [ ] **P0** API 边界拒绝未知字段
- [ ] **P0** task_id 和相对路径执行安全校验

### 4.2 工作目录

- [ ] **P0** 统一使用 `data/output/tasks/<task_id>/`
- [ ] **P0** 包含 raw、parsed、normalized、staging、artifacts、logs
- [ ] **P0** RawAsset 路径只能位于 raw/
- [ ] **P0** 原始文件不可被覆盖
- [ ] **P0** Artifact 只能从 staging 验证后提升
- [ ] **P0** API 只公开 artifacts/

### 4.3 TDD 验收

- [ ] **P0** 每个新契约先写失败测试
- [ ] **P0** 覆盖空 topic、非法 task_id、未知字段和路径逃逸
- [ ] **P0** 覆盖 RawAsset checksum、size 和状态约束
- [ ] **P0** 覆盖 staging 未验证时不可下载

## 5. Phase 1B：固定真实数据

### 5.1 Fixture

- [ ] **P0** 下载官方 `GSE178352_tximportCounts.txt.gz`
- [ ] **P0** 记录官方 URL、时间和完整文件 SHA-256
- [ ] **P0** 生成体量受控的真实 fixture
- [ ] **P0** fixture manifest 记录保留行列和提取命令
- [ ] **P0** fixture 自身保存 SHA-256
- [ ] **P0** 保存 PMID 34180400 的真实 PubMed 响应 fixture
- [ ] **P0** 保存 GSE178352 的真实 GEO 元数据 fixture
- [ ] **P0** fixture 不包含伪造 accession、PMID 或表达值

### 5.2 PubMed

- [ ] **P0** 搜索结果包含 PMID、PMCID、DOI、标题、作者、期刊和摘要
- [ ] **P0** 实际查询式、时间、顺序和 URL 可导出
- [ ] **P0** PMID 34180400 关联到 GSE178352
- [ ] **P0** 超时和上游错误返回结构化失败
- [ ] **P0** 离线 client 使用 fixture，不调用网络

### 5.3 GEO

- [ ] **P0** 修复 GEO 数值搜索 ID 到 accession/metadata 的转换
- [ ] **P0** `search_geo` 对 breast cancer 返回非空真实 accession
- [ ] **P0** `describe_geo("GSE178352")` 返回 12 个样本和关联 PMID
- [ ] **P0** 获取 processed counts 的真实下载 URL
- [ ] **P0** 下载只返回 RawAsset，不调用解析器
- [ ] **P0** 下载采用流式写入、临时文件和原子重命名
- [ ] **P0** 下载记录 status、size、SHA-256、MIME 和时间
- [ ] **P0** 设置连接、读取、总时长和最大文件限制
- [ ] **P0** 失败文件不得标记 success

## 6. Phase 1C：Processing

### 6.1 Counts Parser

- [ ] **P0** 只接受 RawAsset
- [ ] **P0** 解压到 parsed/，保留原始 `.gz`
- [ ] **P0** 解析制表符 counts matrix
- [ ] **P0** 验证 12 个预期 GSM 样本列
- [ ] **P0** 记录 parser 名称与版本
- [ ] **P0** 输出 ParsedDataset 元数据

### 6.2 标准化

- [ ] **P0** `main_data.csv` 一行表示 gene + sample
- [ ] **P0** 生成稳定 record_id
- [ ] **P0** 保存 dataset_id、source_id、asset_id
- [ ] **P0** expression_value 保存数值类型
- [ ] **P0** 保存 source_row 和 source_column
- [ ] **P0** 文献、数据集和样本元数据分表
- [ ] **P0** 不生成原文件中不存在的 log2FC、p-value 或 subtype

### 6.3 清洗与字段映射

- [ ] **P0** 检测空 gene_id 和 sample_id
- [ ] **P0** 检测重复 gene/sample 键
- [ ] **P0** 检测非数值表达值
- [ ] **P0** 不确定值进入 warning，不静默删除
- [ ] **P0** field_mapping 记录 raw 字段、标准字段和转换规则
- [ ] **P0** processing log 记录 rows_before/rows_after

## 7. Phase 1D：Artifact Builder

- [ ] **P0** 生成 `run_manifest.json`
- [ ] **P0** 生成 `main_data.csv`
- [ ] **P0** 生成 `literature.csv`
- [ ] **P0** 生成 `dataset_catalog.csv`
- [ ] **P0** 生成 `sample_metadata.csv`
- [ ] **P0** 生成 `field_descriptions.csv`
- [ ] **P0** 生成 `field_mapping.csv`
- [ ] **P0** 生成 `source_list.csv`
- [ ] **P0** 生成 `download_log.csv`
- [ ] **P0** 生成 `processing_log.csv`
- [ ] **P0** 生成 `quality_report.csv`
- [ ] **P0** 生成 `warnings.csv`
- [ ] **P0** CSV 中结构化参数使用合法 JSON
- [ ] **P0** 所有 Artifact 记录大小与 SHA-256
- [ ] **P0** Artifact 输出顺序稳定，可重复比较

## 8. Phase 1E：Validation Gate

- [ ] **P0** 验证 main_data source_id 完整关联
- [ ] **P0** 验证 main_data asset_id 完整关联
- [ ] **P0** 验证 raw 文件存在且 checksum 一致
- [ ] **P0** 验证所有主表字段都有字段说明
- [ ] **P0** 验证每条记录有 raw 行列位置
- [ ] **P0** 最多抽样 100 个值回溯 raw 并精确比较
- [ ] **P0** 验证 processing log 完整
- [ ] **P0** 验证 warnings 与 metrics 一致
- [ ] **P0** 验证必需 Artifact 非空
- [ ] **P0** 失败报告写入 logs/validation_report.json
- [ ] **P0** 任一失败时不发布 artifacts/
- [ ] **P0** 通过后原子提升 staging 为 artifacts/

## 9. Phase 1F：Pipeline Runner

- [ ] **P0** 实现固定阶段状态机
- [ ] **P0** 每个阶段消费和返回明确类型
- [ ] **P0** 阶段失败时停止下游阶段
- [ ] **P0** 网络、模型、解析和完整任务独立超时
- [ ] **P0** 每个任务保证 completed 或 failed 终态
- [ ] **P0** 正式流程失败时禁止自动切换 mock success
- [ ] **P0** 支持离线 fixture 模式
- [ ] **P0** 支持显式 live 模式
- [ ] **P0** mock 模式必须显式标记且不能通过 live 验收

## 10. Phase 1 测试

### 10.1 默认快速测试

- [ ] **P0** 无 DashScope Key 可 import app 和创建确定性 Pipeline
- [ ] **P0** 默认 pytest 不访问外网
- [ ] **P0** 领域契约单元测试
- [ ] **P0** GEO ID 转换回归测试
- [ ] **P0** 下载 checksum 和中断测试
- [ ] **P0** parser 与 long-form 测试
- [ ] **P0** 清洗、字段映射和行数测试
- [ ] **P0** 全部 Validation Gate 规则测试
- [ ] **P0** 完整 fixture Pipeline 集成测试
- [ ] **P0** Artifact API 列表和下载测试
- [ ] **P0** 产物 schema 与值追溯测试

### 10.2 Live 测试

- [ ] **P0** pytest `live` marker 默认不运行
- [ ] **P0** 实时获取 PMID 34180400
- [ ] **P0** 实时获取 GSE178352 元数据
- [ ] **P0** 实时下载完整 4.4 MB counts 文件
- [ ] **P0** 校验样本 ID、checksum 和 parser
- [ ] **P0** 最小 Qwen TaskSpecification 测试
- [ ] **P0** 完整 live 流程在总超时内产生终态

## 11. Phase 2：Agent 与 API

- [ ] **P1** Agent 使用结构化 TaskSpecification
- [ ] **P1** Pipeline 暴露为单一 SDK Function Tool
- [ ] **P1** 数据库过滤不加载未选择 acquisition Tool
- [ ] **P1** Agent 不直接调用 export Tool 生成最终产物
- [ ] **P1** `POST /api/v1/tasks` 创建 task_id
- [ ] **P1** TaskRequest API 校验
- [ ] **P1** Task status 返回当前 stage 和终态
- [ ] **P1** Artifact API 只列出已验证文件
- [ ] **P1** 支持任务取消
- [ ] **P1** 统一 WebSocket event envelope
- [ ] **P1** 统一 task_id、sequence、timestamp、payload
- [ ] **P1** 事件覆盖创建、计划、阶段、工具、警告、Artifact 和终态
- [ ] **P1** API/WebSocket 契约集成测试

## 12. Phase 3：shadcn 前端重写

后端事件与 Artifact 契约稳定后开始。

- [ ] **P1** 使用 shadcn Form 创建任务
- [ ] **P1** 数据库选择只显示真实数据库
- [ ] **P1** 计划确认 Card/Dialog
- [ ] **P1** 阶段 Timeline/Progress
- [ ] **P1** 结果使用 Tabs 分离主数据、来源、处理和警告
- [ ] **P1** 使用 Table 展示紧凑预览
- [ ] **P1** Artifact 下载列表
- [ ] **P1** 单一 task/event client
- [ ] **P1** 自动重连和任务恢复
- [ ] **P1** Vitest + React Testing Library
- [ ] **P1** ESLint 和 TypeScript 严格检查
- [ ] **P1** 真实浏览器覆盖创建、执行、失败和下载流程

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

- [ ] 默认 pytest 无真实 Key 通过
- [ ] pinned fixture Pipeline 生成全部 12 个必需文件
- [ ] 主数据只包含 gene + sample 粒度
- [ ] 每条记录关联 source_id、asset_id 和 raw 行列位置
- [ ] 100 个抽样值全部可从 raw 精确复算
- [ ] 所有字段有说明，所有下载有 checksum
- [ ] cleaning、mapping 和 processing 记录完整
- [ ] Validation Gate 通过才发布 artifacts/
- [ ] Artifact API 可列出并下载完整产物包
- [ ] live PubMed + GEO 流程在超时内完成
- [ ] 真实失败不会转换成 mock success
- [ ] 文档和 TODO 不包含无证据的完成声明
