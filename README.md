# BioMed QAgent

> 题目编号：XH-202619 · 赛道二 - 数据场景 · 方向1 - 科学数据整合与影响力分析应用
> 选题：A. 科学数据查找、解析与整合

面向生物医学研究场景的 AI 多智能体系统。用户输入自然语言研究目标（如「分析健脾散结方对胰腺癌肝转移的影响」），系统通过多智能体协作自动完成 **数据查找 → 采集 → 解析 → 清洗 → 分析 → 审查 → 报告** 全流程，输出可追溯、可复用的结构化数据。

强制使用阿里云百炼 DashScope 平台（Qwen 系列模型）。

---

## 核心特性

- **多智能体流水线**：Search / Acquire / Parser / Cleaner / Analysis / Reviewer 六阶段 Agent 分工协作
- **多源异构数据整合**：覆盖 PubMed、GEO、STRING、PDB、NCBI、TCMSP、KEGG、OpenAlex、arXiv、Semantic Scholar 等数据源
- **双轨采集策略**：静态预设爬虫（Playwright）+ 动态生成兜底，应对无标准 API 的数据库
- **全链路数据溯源**：每条输出数据可追溯到原始来源与完整处理链路（Provenance Tracker）
- **字段智能对齐**：LLM + 领域同义词表，自动统一不同来源的字段名、单位、格式
- **生物信息学分析**：差异表达、GO/KEGG 富集、PPI 网络、分子对接等模板化分析
- **人在回路**：低置信度数据、字段冲突支持人工介入与反馈修正
- **实时进度推送**：WebSocket 推送 Agent 状态与思考过程

---

## 技术栈

| 层级 | 技术 |
|------|------|
| **后端框架** | FastAPI + Uvicorn + Pydantic |
| **LLM** | 阿里云百炼 DashScope（OpenAI 兼容模式）|
| **文本模型** | qwen-plus / qwen-max |
| **多模态** | qwen-vl-max（图表识图）|
| **长文档** | qwen-long（PDF 全文理解）|
| **数据处理** | pandas / numpy / scipy / pdfplumber |
| **爬虫** | httpx + BeautifulSoup（静态）/ Playwright（动态，可选）|
| **前端** | React 18 + TypeScript + Vite + Ant Design 5 |
| **可视化** | ECharts（图表）+ @xyflow/react（数据血缘图）|
| **状态管理** | Zustand |
| **桌面端** | Electron（可选）|

---

## 项目结构

```
BioMedQAgent/
├── backend/                      # 后端服务
│   ├── app/
│   │   ├── main.py               # FastAPI 入口
│   │   ├── config.py             # 全局配置（DashScope 等）
│   │   ├── api/routes/           # API 路由（tasks/data/lineage/ws/feedback）
│   │   ├── agents/               # 多智能体（orchestrator/search/acquire/parser/cleaner/analysis/reviewer）
│   │   ├── tools/                # 工具注册表
│   │   │   ├── datasources/      # 数据源插件（API 客户端）
│   │   │   ├── crawlers/         # 爬虫与浏览器自动化
│   │   │   ├── processors/       # 文档与生物数据解析器
│   │   │   ├── analysis_templates/  # 生物信息学分析模板
│   │   │   ├── execution/        # 代码执行沙箱
│   │   │   └── validators/       # 数据校验规则
│   │   ├── llm/                  # DashScope 客户端封装 + 提示词
│   │   ├── provenance/           # 数据血缘与溯源
│   │   ├── models/               # Pydantic 数据模型
│   │   └── storage/              # 任务存储
│   ├── requirements.txt
│   └── Dockerfile
├── biomed-data-agent-skill/      # Biomed Data Agent Skill（脚本工具集）
│   ├── scripts/                  # 分析/清洗/数据源/导出/解析/可视化脚本
│   ├── dictionaries/             # 领域词典（基因/化合物/疾病/单位别名）
│   ├── domain_templates/         # 领域模板（中医药/肿瘤学/药理学）
│   ├── schemas/                  # JSON Schema 数据契约
│   └── SKILL.md
├── frontend/                     # 前端应用
│   ├── src/
│   │   ├── App.tsx
│   │   ├── api/                  # API 调用封装
│   │   ├── components/           # 任务/数据/血缘/图表/报告/分析组件
│   │   ├── hooks/                # WebSocket Hook
│   │   └── stores/               # Zustand 状态
│   ├── electron/                 # Electron 桌面端（可选）
│   └── package.json
├── data/                         # 运行时数据（.gitignore）
│   ├── uploads/  parsed/  output/  cache/
├── docs/api/openapi.yaml
├── PROBLEM.md                    # 赛题说明
├── ARCHITECTURE.md               # 架构设计文档
└── DASHSCOPE.md                  # DashScope API 参考
```

---

## 快速开始

### 环境要求

- Python ≥ 3.10
- Node.js ≥ 18
- 阿里云百炼 API Key（[获取地址](https://help.aliyun.com/zh/model-studio/get-api-key)）

### 1. 配置环境变量

```bash
# Windows PowerShell
setx DASHSCOPE_API_KEY "sk-xxxxxxxxxxxxxxxx"

# Linux / macOS
export DASHSCOPE_API_KEY="sk-xxxxxxxxxxxxxxxx"
```

### 2. 启动后端

```bash
cd backend
pip install -r requirements.txt
python -m app.main
# 服务启动在 http://localhost:8000
# API 文档：http://localhost:8000/docs
```

### 3. 启动前端

```bash
cd frontend
npm install
npm run dev
# 前端启动在 http://localhost:5173
```

### 4. 可选：Electron 桌面端

```bash
cd frontend
npm run electron:dev
```

---

## 核心 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/tasks` | 创建任务 |
| GET | `/api/v1/tasks` | 任务列表 |
| GET | `/api/v1/tasks/{id}` | 任务详情 |
| POST | `/api/v1/tasks/{id}/start` | 启动执行 |
| GET | `/api/v1/tasks/{id}/status` | 任务状态 |
| GET | `/api/v1/tasks/{id}/data` | 输出数据 |
| GET | `/api/v1/tasks/{id}/export/csv` | 导出 CSV（含来源标注）|
| GET | `/api/v1/tasks/{id}/export/json` | 导出 JSON |
| GET | `/api/v1/tasks/{id}/report` | HTML 研究报告 |
| GET | `/api/v1/tasks/{id}/lineage` | 数据血缘图 |
| GET | `/api/v1/tasks/{id}/analysis` | 分析结果 |
| POST | `/api/v1/tasks/{id}/feedback` | 提交反馈 |
| WS | `/api/v1/ws/tasks/{id}` | 实时状态推送 |
| GET | `/api/v1/health` | 健康检查 |
| GET | `/api/v1/tools` | 可用工具列表 |

### 创建任务示例

```bash
curl -X POST http://localhost:8000/api/v1/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "research_goal": "分析健脾散结方对胰腺癌肝转移的影响",
    "domain_hint": "中医药"
  }'
```

---

## 系统架构

```
┌─────────────────────────────────────────────────────────┐
│              Frontend (React + Antd)                     │
│   任务面板 │ 数据预览 │ 血缘图 │ 图表 │ 反馈 │ 报告      │
└────────────────────────┬────────────────────────────────┘
                         │ REST API + WebSocket
┌────────────────────────▼────────────────────────────────┐
│              Backend (FastAPI)                           │
│  ┌──────────────────────────────────────────────────┐   │
│  │       Orchestrator Agent（任务规划与调度）         │   │
│  └──┬─────────┬─────────┬─────────┬─────────┬──────┘   │
│  ┌──▼──┐ ┌──▼──┐  ┌──▼──┐ ┌──▼──┐ ┌──▼──┐ ┌──▼───┐    │
│  │Search│ │Acquire│ │Parse│ │Clean│ │Analy│ │Review│    │
│  └──┬──┘ └──┬──┘  └──┬──┘ └──┬──┘ └──┬──┘ └──┬───┘    │
│     └────────┴────────┴────────┴────────┴────────┘      │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Tool Registry（数据源/爬虫/解析器/分析模板/校验）│   │
│  └──────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Provenance Tracker · 任务存储 · LLM Client        │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

详细设计见 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 流水线阶段

| 阶段 | Agent | 职责 |
|------|-------|------|
| 1. 查找 | Search | 通过标准 API 检索论文、数据库条目；标记无 API 数据源 |
| 2. 采集 | Acquire | 浏览器自动化采集无 API 数据源（静态预设 + 动态生成）|
| 3. 解析 | Parser | PDF / GEO SOFT / PDB / 网络文件的解析与结构化 |
| 4. 清洗 | Cleaner | 缺失/重复/单位处理；字段语义对齐；冲突检测 |
| 5. 分析 | Analysis | 差异表达 / 富集 / PPI / 分子对接（可选）|
| 6. 审查 | Reviewer | 完整性、引用准确性、数值一致性、爬虫验证 |

任务状态机：`CREATED → PLANNING → SEARCHING → ACQUIRING → PARSING → CLEANING → ANALYZING → REVIEWING → COMPLETED`（失败可从断点重试）

---

## 数据溯源

每条最终输出数据均携带完整溯源链，CSV 导出自动附加来源标注列：

| compound_name | gene_symbol | log2fc | p_value | source_doi | extraction_method | confidence |
|---|---|---|---|---|---|---|
| Quercetin | AKT1 | 2.35 | 0.001 | 10.xxxx | table | 0.95 |
| Kaempferol | TP53 | -1.82 | 0.023 | GSE12345 | crawl | 0.88 |

溯源链示例：
```
字段 "compound_name": "Quercetin"
├─ [parse]  Parser → extract_tables → tcmsp_result 表格1
│   └─ [acquire] Acquire → crawl_tcmsp → Playwright 自动化
│       └─ 原始来源: TCMSP (https://tcmspw.com/tcmsp.php)
└─ [clean]  Cleaner → align_fields → "MolName" → "compound_name"（置信度 0.95）
```

---

## 可扩展性

系统通过注册机制支持多维度扩展，无需修改核心代码：

| 扩展点 | 基类 | 示例 |
|--------|------|------|
| 新增 Agent | `BaseAgent` | 引用网络分析 Agent |
| 新增数据源 | `BaseDataSource` | CNKI、ChEMBL |
| 新增爬虫 | `BaseCrawler` | KEGG 网页爬虫 |
| 新增解析器 | `BaseProcessor` | HDF5 解析器 |
| 新增分析模板 | `BaseAnalysis` | 蛋白质组学分析 |
| 新增校验规则 | `BaseValidator` | 天文坐标校验 |
| 新增领域模板 | YAML 配置 | 中医药、肿瘤学 |

---

## 文档

- [赛题说明](PROBLEM.md)
- [架构设计](ARCHITECTURE.md)
- [DashScope API 参考](DASHSCOPE.md)
- [API OpenAPI 规范](docs/api/openapi.yaml)
- 后端启动后访问 `http://localhost:8000/docs` 查看交互式 API 文档

---

## License

本项目用于参赛提交。
