# BioMed QAgent — 详细 TODO 与功能清单

> 依据：代码静态探索结果（backend/app、frontend/src、docs、tests）
> 生成时间：2026-07-11
> 状态：部分子代理测试探索未返回有效结果，测试缺口参考代码直接审计

---

## 一、已实现功能清单

### 1.1 后端核心模块

| 模块/文件 | 功能 | 状态 |
|-----------|------|------|
| `backend/app/main.py` | FastAPI 入口、生命周期、CORS、全局异常 | ✅ 完成 |
| `backend/app/config.py` | DashScope 配置、模型常量、路径管理 | ✅ 完成 |
| `backend/app/agents/orchestrator.py` | 8 阶段流水线编排（planning/export 内联，6 阶段委托） | ✅ 完成 |
| `backend/app/agents/base.py` | BaseAgent ABC、进度推送、线程池包装 | ✅ 完成 |
| `backend/app/agents/search.py` | SearchAgent：文献+实体并行检索、引用追溯、Darwinian 扩展 | ✅ 完成 |
| `backend/app/agents/acquire.py` | AcquireAgent：`requires_crawl` 信号路由、Playwright 浏览器代理 | ✅ 完成 |
| `backend/app/agents/parser.py` | ParserAgent：PDF/生物数据解析、LLM 提取、Qwen-VL 图表 | ✅ 完成 |
| `backend/app/agents/cleaner.py` | CleanerAgent：字段对齐、单位归一化、去重 | ✅ 完成 |
| `backend/app/agents/analysis.py` | AnalysisAgent：PPI/富集/药靶/差异表达/Hub/上游/生存并行 | ✅ 完成 |
| `backend/app/agents/reviewer.py` | ReviewerAgent：LLM 质量审查、改进建议 | ✅ 完成 |
| `backend/app/agents/error_decision.py` | ErrorDecisionAgent：规则优先 + LLM 兜底错误决策 | ✅ 完成 |
| `backend/app/agents/iteration_decision.py` | IterationDecisionAgent：Stage Gate 量化 + LLM 空白分析 | ✅ 完成 |
| `backend/app/agents/llm_reporter.py` | LLMReporter：qwen-max 科学叙事式 HTML 报告 | ✅ 完成 |
| `backend/app/agents/llm_extractor.py` | LLMExtractor：原始爬取记录结构化提取 | ✅ 完成 |
| `backend/app/agents/registry.py` | AgentRegistry：装饰器注册 7 个阶段 Agent | ✅ 完成 |
| `backend/app/tools/registry.py` | ToolRegistry facade：69 条元数据，薄封装层 | ✅ 完成 |
| `backend/app/api/routes/tasks.py` | 任务 CRUD、启动、取消、确认、分析、文件列表 | ✅ 完成 |
| `backend/app/api/routes/data.py` | 数据查询、预览、CSV/JSON/整合 CSV 导出 | ✅ 完成 |
| `backend/app/api/routes/lineage.py` | 完整溯源 DAG + 单记录溯源链 | ✅ 完成 |
| `backend/app/api/routes/ws.py` | WebSocket 实时进度推送 | ✅ 完成 |
| `backend/app/api/routes/skills.py` | 技能发现面板（list/categories/count/get/search） | ✅ 完成 |
| `backend/app/api/routes/system.py` | 健康检查 + 工具列表 | ✅ 完成 |
| `backend/app/api/routes/feedback.py` | 用户反馈提交（refine/retry/general） | ✅ 完成 |
| `backend/app/models/task.py` | Task / TaskStatus / StageInfo Pydantic 模型 | ✅ 完成 |
| `backend/app/storage/task_store.py` | 内存字典 + JSON 文件持久化 | ✅ 完成 |
| `backend/app/llm/client.py` | DashScopeClient：chat/chat_json/chat_vision/chat_document | ✅ 完成 |
| `backend/app/provenance/tracker.py` | ProvenanceTracker + ProvenanceNode（字段级溯源） | ✅ 完成 |
| `backend/app/skills/manifest.py` | SkillManifest 数据模型 | ✅ 完成 |
| `backend/app/skills/registry.py` | SkillRegistry 类注册 | ✅ 完成 |
| `backend/app/skills/definitions.py` | 从 ToolRegistry 元数据自动生成技能清单 | ✅ 完成 |
| `backend/app/skills/retriever.py` | SkillRetriever：关键词 + 可选 LLM 重排序 | ✅ 完成 |

### 1.2 工具层已实现模块

#### 数据源（16 活跃 + 2 辅助）

| 模块 | 数据源 | API/协议 | 状态 |
|------|--------|----------|------|
| `datasources/pubmed.py` | PubMed | NCBI E-utilities | ✅ 完成 |
| `datasources/europepmc.py` | EuropePMC | REST search | ✅ 完成 |
| `datasources/openalex.py` | OpenAlex | `/works` + 429 重试 | ✅ 完成 |
| `datasources/semantic_scholar.py` | Semantic Scholar | Graph API | ✅ 完成 |
| `datasources/arxiv.py` | arXiv | Atom API | ✅ 完成 |
| `datasources/geo.py` | GEO | E-utilities esearch+esummary | ✅ 完成 |
| `datasources/string.py` | STRING | `/api/json/network` | ✅ 完成 |
| `datasources/kegg.py` | KEGG | REST find/get | ✅ 完成 |
| `datasources/pdb.py` | PDB | RCSB Search + Data API | ✅ 完成 |
| `datasources/tcmsp.py` | TCMSP | 内部 JSON API | ✅ 完成（不稳定） |
| `datasources/ncbi.py` | NCBI Gene/Protein | E-utilities | ✅ 完成 |
| `datasources/clinicaltrials.py` | ClinicalTrials.gov | v2 API | ✅ 完成 |
| `datasources/tcga.py` | TCGA | GDC cases/files | ✅ 完成 |
| `datasources/drugbank.py` | DrugBank | OpenTargets GraphQL | ✅ 完成 |
| `datasources/disgenet.py` | DisGeNET | REST API | ✅ 完成 |
| `datasources/pubchem.py` | PubChem | PUG REST | ✅ 完成 |
| `datasources/citation_trace.py` | OpenAlex 引用追溯 | referenced_works + cited_by | ✅ 完成 |
| `datasources/web_crawler.py` | 通用 HTTP 爬虫 | httpx + BeautifulSoup | ✅ 完成 |

#### 解析器（6 个）

| 模块 | 格式 | 状态 |
|------|------|------|
| `parsers/pdf_table.py` | PDF 表格 + 图注 | ✅ 完成 |
| `parsers/pdf_download.py` | PDF 下载 + Unpaywall + EPMC XML | ✅ 完成 |
| `parsers/geo_soft.py` | GEO SOFT | ✅ 完成 |
| `parsers/pdb.py` | PDB 结构文件 | ✅ 完成 |
| `parsers/fasta.py` | FASTA/FASTQ | ✅ 完成 |
| `parsers/network.py` | STRING TSV/SIF/GraphML | ✅ 完成 |

#### 清洗器（3 个）

| 模块 | 功能 | 状态 |
|------|------|------|
| `cleaners/field_aligner.py` | 字段名对齐（YAML 词典） | ✅ 完成 |
| `cleaners/unit_normalizer.py` | 单位归一化（ln/log10/fold_change） | ✅ 完成 |
| `cleaners/duplicate_detector.py` | 去重 + 冲突检测 | ✅ 完成 |

#### 分析模块（7 个）

| 模块 | 分析类型 | 外部依赖 | 状态 |
|------|----------|----------|------|
| `analysis/ppi_network.py` | STRING PPI + 中心性 | networkx | ✅ 完成 |
| `analysis/enrichment.py` | GO/KEGG Enrichr | requests | ✅ 完成 |
| `analysis/drug_target.py` | OpenTargets 药物-靶点 | requests | ✅ 完成 |
| `analysis/differential_expression.py` | BH FDR + 火山数据 | statsmodels | ✅ 完成 |
| `analysis/hub_gene.py` | Hub 基因 + 上游 TF | networkx | ✅ 完成 |
| `analysis/upstream_regulator.py` | 上游调控网络 | requests | ✅ 完成 |
| `analysis/survival.py` | KM + log-rank + Cox HR | lifelines/scipy | ✅ 完成 |

#### 可视化（5 个）

| 模块 | 输出 | 状态 |
|------|------|------|
| `viz/volcano_plot.py` | 火山图 PNG | ✅ 完成 |
| `viz/enrichment_bubble.py` | 富集气泡图 PNG | ✅ 完成 |
| `viz/heatmap.py` | 热图 PNG（seaborn） | ✅ 完成 |
| `viz/network_plot.py` | PPI 网络图 PNG | ✅ 完成 |
| `viz/extract_chart_data.py` | Qwen-VL 图表数据提取 | ✅ 完成 |

#### 导出/IO（8 个）

| 模块 | 功能 | 状态 |
|------|------|------|
| `export/to_csv.py` | CSV 导出 | ✅ 完成 |
| `export/to_excel.py` | Excel 导出 + Lineage sheet | ✅ 完成 |
| `export/to_report.py` | Markdown 报告 | ✅ 完成 |
| `export/merge_csv.py` | 多源整合 CSV（按实体分组） | ✅ 完成 |
| `io/csv_to_json.py` | CSV → JSON | ✅ 完成 |
| `io/excel_to_json.py` | Excel → JSON | ✅ 完成 |
| `io/json_to_csv.py` | JSON → CSV | ✅ 完成 |
| `io/merge_json.py` | 多 JSON 合并去重 | ✅ 完成 |

#### 优化（3 个）

| 模块 | 功能 | 状态 |
|------|------|------|
| `optimization/stage_evaluator.py` | Stage Gate 量化评估 | ✅ 完成 |
| `optimization/reflection_loop.py` | 反思循环控制器 | ✅ 完成（dormant） |
| `optimization/keyword_expander.py` | 关键词扩展 | ✅ 完成 |

### 1.3 前端已实现组件

| 组件/文件 | 功能 | 状态 |
|-----------|------|------|
| `frontend/src/App.tsx` | 根布局：侧栏 + 4 Tab 内容区 | ✅ 完成 |
| `frontend/src/main.tsx` | 入口 + Antd zhCN 配置 | ✅ 完成 |
| `frontend/src/api/types.ts` | 完整 TypeScript 类型定义 | ✅ 完成 |
| `frontend/src/api/client.ts` | HTTP 客户端（15 个端点） | ✅ 大部分完成 |
| `frontend/src/stores/taskStore.ts` | Zustand 状态管理（含迭代/Stage Gate） | ✅ 完成 |
| `frontend/src/hooks/useTaskWebSocket.ts` | WebSocket 自动重连 + 心跳 | ✅ 完成 |
| `frontend/src/components/task/TaskInput.tsx` | 研究目标输入 + 领域选择 | ✅ 完成 |
| `frontend/src/components/task/TaskList.tsx` | 任务列表面板 | ✅ 完成 |
| `frontend/src/components/task/PipelineStatus.tsx` | 8 阶段流水线状态 + 进度 + 人在回路检查点 | ✅ 完成 |
| `frontend/src/components/task/IterationPanel.tsx` | Stage Gate 4 指标 + 迭代决策时间线 | ✅ 完成 |
| `frontend/src/components/data/DataOverview.tsx` | 数据总览 Tab 容器 | ✅ 完成 |
| `frontend/src/components/data/DataPreview.tsx` | 分页表格 + 来源过滤 + 置信度排序 | ✅ 完成 |
| `frontend/src/components/charts/ChartsView.tsx` | ECharts 统计图表 | ✅ 完成 |
| `frontend/src/components/lineage/LineageGraph.tsx` | ReactFlow 血缘 DAG | ✅ 完成 |
| `frontend/src/components/report/ResearchReport.tsx` | LLM 报告 iframe + 分析结果 | ✅ 完成 |
| `frontend/src/components/analysis/AnalysisView.tsx` | 生存分析 KM 曲线 + 通用分析卡片 | 🟡 部分完成 |
| `frontend/src/components/feedback/FeedbackPanel.tsx` | 3 模式反馈 + 历史 | ✅ 完成 |

---

## 二、部分实现 / 待完善功能

### 2.1 前端部分实现

| 功能 | 文件 | 问题 | 状态 |
|------|------|------|------|
| 文件上传 UI | `TaskInput.tsx` / `App.tsx` | 后端 `/upload` 已实现，前端无上传组件 | 🔴 缺失 |
| 技能发现页面 | 无对应组件 | 后端 6 个 skills 端点，前端无页面 | 🔴 缺失 |
| 工具列表页面 | 无对应组件 | 后端 `/tools` 端点，前端无页面 | 🟡 缺失 |
| AnalysisView 其他分析可视化 | `AnalysisView.tsx` | PPI/富集/药靶仅有文字卡片，无专属可视化 | 🟡 部分 |
| Electron 桌面端 | `frontend/electron/main.js` | 2 行占位代码，未实现 | 🔴 占位 |
| 布局组件 | `frontend/src/components/layout/` | 仅 `.gitkeep`，无实现 | 🟡 缺失 |
| 路由 | `App.tsx` | 条件渲染，无 React Router | 🟢 可接受 |

### 2.2 后端部分实现

| 功能 | 文件 | 问题 | 状态 |
|------|------|------|------|
| qwen-long PDF 全文解析 | `llm/client.py` | `chat_document()` 已封装，未接线到任何工具 | 🟡 未接线 |
| 中文数据库（CNKI/万方） | `datasources/` | 仅 `web_crawler.py` + `browser_agent.py` 可处理，无专用模块 | 🟡 待实现 |
| CheMBL 数据源 | `datasources/` | 无专用模块，仅 `browser_agent.py` JS 列表 | 🟡 待实现 |
| DOCX 导出 | `export/` | `to_report.py` 注释提及复用，实际未实现 | 🟡 缺失 |
| DataRecord 类型安全 | `models/` | 已移除 Pydantic 模型，运行时裸 dict | 🟢 已知限制 |
| Reflection Loop LLM 在环 | `optimization/reflection_loop.py` | 代码存在，未激活 | 🟡 设计已记录 |

### 2.3 工具层部分实现

| 功能 | 文件 | 问题 | 状态 |
|------|------|------|------|
| TCMSP 稳定性 | `datasources/tcmsp.py` | 接口不稳定，常返回 `None` | 🟡 不稳定 |
| DisGeNET 鉴权 | `datasources/disgenet.py` | 需要 `DISGENET_API_KEY` 环境变量 | 🟡 需配置 |
| Semantic Scholar 鉴权 | `datasources/semantic_scholar.py` | 可选 `SEMANTIC_SCHOLAR_API_KEY` | 🟢 可选 |

---

## 三、缺失功能 / TODO 清单

### 3.1 文档缺失

| 缺失项 | 位置 | 优先级 | 说明 |
|--------|------|--------|------|
| `docs/pipeline_dispatch_trace.md` | README 项目结构引用 | 🔴 High | 文件从未创建，README 引用失效 |
| ARCHITECTURE.md 数据源表格更新 | `ARCHITECTURE.md` §四 | 🔴 High | 仍写"15 活跃"，实际 16，缺 europepmc |
| README 反馈接线状态 | `README.md` | 🟡 Medium | 写"前端未接线"，实际已接线 |
| archive 文档状态更新 | `docs/archive/*.md` | 🟡 Medium | 3 个文档状态标注错误 |
| `docs/api/openapi.yaml` 引用 | README / ARCHITECTURE | 🟢 Low | 文件存在但未引用 |

### 3.2 前端缺失

| 缺失项 | 优先级 | 说明 |
|--------|--------|------|
| 文件上传组件 | 🔴 High | 阻断用户提供本地 PDF/数据 |
| 技能发现页面 | 🟡 Medium | 后端功能不可见 |
| 工具列表页面 | 🟡 Medium | 后端功能不可见 |
| 系统健康状态页 | 🟢 Low | 无状态指示器 |
| 测试框架搭建 | 🔴 High | 零测试、零测试框架 |
| React Router | 🟢 Low | 当前 Tab 模式够用，但限制扩展 |

### 3.3 后端缺失

| 缺失项 | 优先级 | 说明 |
|--------|--------|------|
| qwen-long PDF 全文解析工具 | 🟡 Medium | 已封装未接线 |
| CNKI / 万方 数据源模块 | 🟡 Medium | 仅爬虫基础设施 |
| CheMBL 数据源模块 | 🟡 Medium | 仅 browser_agent JS 列表 |
| DOCX 导出 | 🟢 Low | 仅 Markdown |
| Biogrid / Reactome 分类分支清理 | 🟢 Low | `merge_csv.py` 死分支 |

### 3.4 待人类决策项（来自 `docs/20260708-review-optimization.md`）

| 编号 | 内容 | 优先级 |
|------|------|--------|
| A1 | skills 自演化系统移除/瘦身决策 | 🟡 Medium |
| A2 | 17 个 dormant BaseDataSource 子类移除决策 | 🟡 Medium |
| A4 | DataRecord Pydantic 模型移除决策 | 🟢 Low |
| B14 | 前端 Stage Gate 阈值硬编码修复 | 🔴 High |
| B15 | 前端 awaiting_confirmation 状态缺失 | 🟡 Medium |
| B16 | 前端 FeedbackPanel planning 选项 | 🟡 Medium |
| B17 | 前端 drug_targets 键名错误 | 🟡 Medium |

---

## 四、测试覆盖缺口

> 注：子代理测试探索未返回有效结果，以下基于代码直接审计。

### 4.1 已有测试

| 测试文件 | 覆盖范围 | 状态 |
|----------|----------|------|
| `backend/tests/test_api_endpoints.py` | API 端点可达性 | ✅ 存在 |
| `backend/tests/test_e2e_smoke.py` | 生命周期端点 | ✅ 存在 |
| `backend/tests/test_error_decision.py` | ErrorDecisionAgent 规则 | ✅ 存在 |
| `backend/tests/test_skills_registry.py` | SkillRegistry 计数/分类 | ✅ 存在 |
| `backend/tests/test_skills_retrieval.py` | SkillRetriever 检索 | ✅ 存在 |
| `backend/tests/test_skills_endpoints.py` | 技能 API 端点 | ✅ 存在 |

### 4.2 测试缺口

| 缺口 | 影响 | 优先级 |
|------|------|--------|
| 前端零测试 | 前端逻辑/组件无验证 | 🔴 High |
| 流水线集成测试 | Orchestrator 多阶段协同 | 🔴 High |
| Agent 单元测试 | 13 个 Agent 无单元测试 | 🟡 Medium |
| 工具层测试 | 63 个工具模块无测试 | 🟡 Medium |
| 数据源测试 | 16 个数据源无 mock 测试 | 🟡 Medium |
| 清洗器测试 | 3 个清洗器无测试 | 🟢 Low |
| 分析模块测试 | 7 个分析模块无测试 | 🟡 Medium |
| 可视化测试 | 5 个 viz 模块无测试 | 🟢 Low |
| 存储层测试 | TaskStore 持久化无测试 | 🟡 Medium |
| 溯源测试 | ProvenanceTracker 无测试 | 🟡 Medium |
| LLM 客户端测试 | DashScopeClient 无测试 | 🟡 Medium |

---

## 五、技术债务清单

| 债务项 | 文件 | 影响 | 优先级 |
|--------|------|------|--------|
| 无类型安全的数据记录 | `models/task.py` 移除后裸 dict | 类型错误风险 | 🟢 Low |
| Electron 占位代码 | `frontend/electron/` | 虚假功能预期 | 🟡 Medium |
| 无 React Router | `App.tsx` | 扩展性受限 | 🟢 Low |
| 无测试框架 | `frontend/package.json` | 质量无保障 | 🔴 High |
| ARCHITECTURE.md 与代码不一致 | 3 处 | 文档误导 | 🟡 Medium |
| README.md 过时描述 | 2 处 | 用户误导 | 🟡 Medium |
| 死代码分支 | `export/merge_csv.py` biogrid/reactome | 维护负担 | 🟢 Low |

---

## 六、 prioritized 行动项（建议执行顺序）

### Phase 1：阻塞性缺口（必须解决）

1. **搭建前端测试框架** — vitest + React Testing Library，覆盖 `taskStore`、`api/client`、`PipelineStatus`
2. **实现文件上传组件** — 在 `TaskInput` 或新建 `UploadPanel`，对接 `/api/v1/tasks/{id}/upload`
3. **创建缺失文档** — `docs/pipeline_dispatch_trace.md` 或从 README 删除引用
4. **修复文档不一致** — ARCHITECTURE.md 数据源表格 15→16，补充 europepmc；README 反馈状态更新

### Phase 2：可见性缺口（用户体验）

5. **技能发现页面** — 使用后端 6 个 skills 端点构建前端页面
6. **工具列表页面** — 展示 `/api/v1/tools` 结果
7. **修复前端 Bug** — B14 Stage Gate 阈值、B15 awaiting_confirmation、B16/B17 反馈/分析键名
8. **接线 qwen-long** — 新建 `parsers/pdf_fulltext.py` 调用 `chat_document()`

### Phase 3：扩展性缺口（中长期）

9. **中文数据源** — CNKI/万方专用模块或确认仅走爬虫
10. **CheMBL 数据源** — 评估是否需要专用模块
11. **DOCX 导出** — 如需 Word 输出，实现 `export/to_docx.py`
12. **清理死代码** — `merge_csv.py` biogrid/reactome 分支
13. **Electron 决策** — 移除或完整实现
14. **Reflection Loop LLM 在环** — 按 `docs/reflection_loop_design_notes.md` 演进
15. **添加 React Router** — 当页面数超过当前 Tab 模式承载能力

### Phase 4：质量保障（持续）

16. **后端测试覆盖** — 优先流水线集成测试、Agent 单元测试、数据源 mock 测试
17. **前端测试覆盖** — 组件测试、E2E 测试（Playwright）
18. **代码审查流程** — 建立 PR review 机制
19. **性能监控** — 数据源响应时间、LLM 延迟、流水线阶段耗时

---

## 七、功能-文件映射速查

### 核心流水线

```
Orchestrator → agents/orchestrator.py
 ├─ planning → DashScopeClient.chat() (qwen-plus)
 ├─ search → agents/search.py → tools/datasources/* (16 源) + citation_trace
 ├─ acquire → agents/acquire.py → tools/browser_agent.py + web_crawler.py
 ├─ parse → agents/parser.py → tools/parsers/* + llm_extractor
 ├─ clean → agents/cleaner.py → tools/cleaners/*
 ├─ analyze → agents/analysis.py → tools/analysis/*
 ├─ review → agents/reviewer.py → DashScopeClient.chat() (qwen-max)
 └─ export → tools/export/* + agents/llm_reporter.py
```

### 前端页面映射

```
App.tsx
 ├─ 流水线状态 → PipelineStatus + IterationPanel
 ├─ 数据总览 → DataOverview → DataPreview / ChartsView / LineageGraph / AnalysisView
 ├─ 研究报告 → ResearchReport
 └─ 反馈修正 → FeedbackPanel
```

### API 端点映射

```
/api/v1/tasks → tasks.py (CRUD + start + confirm + upload + files + feedback)
/api/v1/data → data.py (records + export)
/api/v1/lineage → lineage.py (DAG + record lineage)
/api/v1/ws → ws.py (WebSocket)
/api/v1/skills → skills.py (5 个只读端点)
/api/v1/system → system.py (health + tools)
```

---

## 八、统计摘要

| 类别 | 数量 | 备注 |
|------|------|------|
| 后端 Python 模块 | 30+ | 全部完成，无 stub |
| 后端 Agent | 13 | 全部完成 |
| 数据源 | 18（16 活跃 + 2 辅助） | 全部完成 |
| 解析器 | 6 | 全部完成 |
| 清洗器 | 3 | 全部完成 |
| 分析模块 | 7 | 全部完成 |
| 可视化模块 | 5 | 全部完成 |
| 导出/IO 模块 | 8 | 全部完成 |
| 优化模块 | 3 | 1 个 dormant |
| API 路由文件 | 7 | 全部完成 |
| 前端组件 | 16 | 1 个部分完成 |
| 前端测试 | 0 | 无测试框架 |
| 后端测试 | 6 | 覆盖 API/错误决策/技能 |
| 缺失文档 | 1 | pipeline_dispatch_trace.md |
| 前端缺失页面 | 3 | 上传/技能/工具 |
| 待接线功能 | 1 | qwen-long PDF 全文 |
| 待实现模块 | 3 | CNKI/万方、CheMBL、DOCX |
| 技术债务 | 5 | 类型安全、Electron、路由、死代码、文档不一致 |
| 待人类决策 | 4 | A1/A2/A4/B14-B17 |

---

*本文件由代码静态探索自动生成，依据实际代码实现状态，不含推测。*
