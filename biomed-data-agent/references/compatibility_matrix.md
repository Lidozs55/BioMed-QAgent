# 双平台兼容性矩阵（Trae Work / Qoder / Qoder Work）

本文档详细对比 Trae Work、Qoder（IDE/Quest）、Qoder Work 三个调度平台的内置能力，明确 `biomed-data-agent` skill 在每个平台上的运行边界与依赖关系，确保功能"不重不漏"。

> 调研日期：2026-07-05
> 数据来源：Trae 官方文档 docs.trae.cn、Qoder 官方文档 docs.qoder.com

## 一、调度平台能力对比总表

| 能力类别 | 能力项 | Trae Work | Qoder (IDE/Quest) | Qoder Work | 本 skill 是否依赖 |
|---------|--------|-----------|-------------------|------------|------------------|
| **文件操作** | 文件读取 | ✅ 内置 | ✅ 内置 | ✅ 内置 | ✅ 依赖（读取脚本输出） |
| | 文件写入 | ✅ 内置 | ✅ 内置 | ✅ 内置 | ✅ 依赖（保存输出） |
| | 目录列表 | ✅ 内置 | ✅ 内置 | ✅ 内置 | ✅ 依赖（merge_json 扫描） |
| **网络访问** | WebFetch | ✅ 内置 | ✅ MCP fetch | ✅ 内置 | ✅ 依赖（Stage 2 抓取） |
| | WebSearch | ✅ 内置 | ✅ MCP | ✅ 内置 | ✅ 依赖（文献检索辅助） |
| | 浏览器自动化 | ✅ agent-browser skill | ✅ Browser Use + Chrome MCP | ✅ Chrome 插件 | ✅ 依赖（动态页面回退） |
| **代码执行** | Bash / Shell | ✅ 沙箱 | ✅ Quest 沙箱 | ✅ 安全工作环境 | ✅ 依赖（运行 Python 脚本） |
| | Python 沙箱 | ✅ 沙箱 | ✅ Quest 沙箱 | ✅ 安全工作环境 | ✅ 依赖（核心执行环境） |
| | pip install | ✅ 沙箱内 | ✅ 沙箱内 | ✅ 安全工作环境 | ✅ 依赖（安装依赖） |
| **文档处理** | PDF 阅读 | ❌ 不内置 | ✅ pdf skill (Qoder Work) | ✅ pdf skill | ⚠️ 部分（pdf_table_parser 专注生物文献表格） |
| | Excel 读写 | ❌ 不内置 | ❌ 不内置 | ✅ xlsx skill | ❌ 不依赖（自带 scripts/io/） |
| | Word 读写 | ❌ 不内置 | ❌ 不内置 | ✅ docx skill | ❌ 不依赖（自带 to_docx.py） |
| | PPT 生成 | ❌ 不内置 | ❌ 不内置 | ✅ pptx skill | ❌ 不依赖（留给 Qoder Work pptx） |
| **图片能力** | 本地图片识别 | ❌ 不支持 | ✅ 图生代码 | ✅ 内置 | ⚠️ Trae 上依赖 Qwen-VL 脚本 |
| | 图片生成 | ✅ chart-visualization | ✅ Canvas | ❌ | ✅ 依赖（图表 PNG 生成） |
| **可视化** | 通用图表 | ✅ chart-visualization | ✅ Canvas | ❌ | ❌ 不依赖（自带生物医学专用图） |
| | 交互式 UI | ❌ | ✅ Skill UI (HTML Widget) | ✅ Skill UI | ❌ 不依赖 |
| **扩展机制** | MCP 协议 | ✅ | ✅ | ✅ | ⚠️ 可选（未来扩展） |
| | Hooks | ✅ | ✅ | ✅ | ❌ 不依赖 |
| | Skills 市场 | ✅ | ✅ skills.sh | ✅ Skill 广场 | ❌ 不依赖 |
| **记忆/知识** | 项目记忆 | ✅ project_memory.md | ✅ Repo Wiki + Memory | ❌ | ❌ 不依赖 |
| | 长期对话记忆 | ✅ topics.md | ✅ Memory 知识卡片 | ❌ | ❌ 不依赖 |

## 二、本 skill 与调度平台能力的边界划分

### 2.1 明确不重复实现的能力（交给调度器）

以下能力调度器已内置，本 skill 不再实现，避免功能重叠：

1. **通用文件读写** — 调度器的 Read/Write 工具
2. **通用网页抓取** — Trae 的 WebFetch / Qoder 的 fetch MCP / Qoder Work 的内置 web 工具
3. **通用 Web 搜索** — 调度器的 WebSearch
4. **通用浏览器自动化** — Trae 的 agent-browser / Qoder 的 Browser Use
5. **通用图表可视化** — Trae 的 chart-visualization / Qoder 的 Canvas（本 skill 只做生物医学专用图：火山图、气泡图、热图、PPI 网络）
6. **通用 PDF 阅读** — Qoder Work 的 pdf skill（本 skill 的 pdf_table_parser 专注生物文献中的实验数据表，差异化定位）
7. **通用 Excel/Word/PPT** — Qoder Work 的 xlsx/docx/pptx skill（本 skill 的 to_excel/to_docx 专注带溯源列的生物医学规范导出）
8. **MCP 协议支持** — 调度器原生支持
9. **代码执行沙箱** — 调度器原生支持

### 2.2 本 skill 独家提供的能力（调度器没有）

| 能力 | 脚本 | 说明 |
|------|------|------|
| PubMed 文献检索 | `scripts/datasources/pubmed_client.py` | NCBI E-utilities 客户端 |
| NCBI Gene/Protein | `scripts/datasources/ncbi_client.py` | 基因/蛋白信息 |
| GEO 表达数据集 | `scripts/datasources/geo_client.py` | 基因表达数据搜索 |
| STRING PPI 网络 | `scripts/datasources/string_client.py` | 蛋白质互作 |
| KEGG 通路 | `scripts/datasources/kegg_client.py` | 通路数据 |
| PDB 蛋白结构 | `scripts/datasources/pdb_client.py` | 结构数据搜索 |
| TCMSP 中药成分 | `scripts/datasources/tcmsp_client.py` | 中药化合物 |
| GEO SOFT 解析 | `scripts/parsers/geo_soft_parser.py` | 表达矩阵解析 |
| PDB 结构解析 | `scripts/parsers/pdb_parser.py` | 蛋白结构解析 |
| FASTA 序列解析 | `scripts/parsers/fasta_parser.py` | 序列解析 |
| 生物网络文件解析 | `scripts/parsers/network_parser.py` | STRING/SIF/GraphML |
| PDF 生物表格提取 | `scripts/parsers/pdf_table_parser.py` | 文献实验数据表（差异化） |
| 字段对齐引擎 | `scripts/cleaners/field_aligner.py` | 跨源字段统一 |
| 单位归一化 | `scripts/cleaners/unit_normalizer.py` | log2/ln/浓度转换 |
| 重复检测去重 | `scripts/cleaners/duplicate_dedector.py` | 冲突检测 |
| 差异表达分析 | `scripts/analysis/differential_expression.py` | BH FDR |
| GO/KEGG 富集 | `scripts/analysis/enrichment.py` | Enrichr API |
| PPI 网络分析 | `scripts/analysis/ppi_network.py` | networkx |
| 溯源记录/查询 | `scripts/provenance/tracker.py` + `query.py` | DAG 验证 |
| 火山图 | `scripts/viz/volcano_plot.py` | 差异表达可视化 |
| 富集气泡图 | `scripts/viz/enrichment_bubble.py` | 富集结果可视化 |
| 表达热图 | `scripts/viz/heatmap.py` | 表达矩阵可视化 |
| PPI 网络图 | `scripts/viz/network_plot.py` | 网络可视化 |
| 本地图片识别 | `scripts/viz/extract_chart_data.py` | Qwen-VL API（Trae 上必需） |
| CSV 导出 | `scripts/export/to_csv.py` | 带溯源列 |
| Excel 导出 | `scripts/export/to_excel.py` | 双 sheet（Data + Lineage） |
| Markdown 报告 | `scripts/export/to_report.py` | 中文报告 |
| Word 报告 | `scripts/export/to_docx.py` | 可选（Qoder Work 可用内置 docx） |
| CSV→JSON | `scripts/io/csv_to_json.py` | 用户上传数据导入 |
| Excel→JSON | `scripts/io/excel_to_json.py` | 用户上传数据导入 |
| JSON→CSV | `scripts/io/json_to_csv.py` | 通用导出 |
| JSON→Excel | `scripts/io/json_to_excel.py` | 通用导出 |
| JSON 合并 | `scripts/io/merge_json.py` | 多源数据合并 |

## 三、平台特定运行指南

### 3.1 在 Trae Work 上运行

**前置条件**：
- 安装 skill 到 `.trae/skills/biomed-data-agent/` 或 `~/.trae-cn/skills/biomed-data-agent/`
- 沙箱中执行 `pip install -r scripts/requirements.txt`

**能力边界**：
- ✅ 完整支持所有 7 个数据源 API 客户端
- ✅ 完整支持所有 5 个解析器
- ✅ 完整支持清洗、分析、溯源、可视化
- ✅ 本地图片识别通过 `extract_chart_data.py`（Qwen-VL API，需 `QWEN_API_KEY`）
- ⚠️ PDF 表格提取用本 skill 的 `pdf_table_parser.py`（Trae 无内置 PDF skill）
- ⚠️ Excel/Word 生成用本 skill 的 `to_excel.py`/`to_docx.py`（Trae 无内置 office skill）

**环境变量**：
- `QWEN_API_KEY`（可选，仅 `extract_chart_data.py` 需要）

### 3.2 在 Qoder / Qoder Quest 上运行

**前置条件**：
- 安装 skill 到 `~/.qoder/skills/biomed-data-agent/`（用户级）或 `.qoder/skills/biomed-data-agent/`（项目级）
- Quest 沙箱中执行 `pip install -r scripts/requirements.txt`

**能力边界**：
- ✅ 完整支持所有功能
- ✅ 推荐在 **Quest 模式**下运行长流水线（异步委派，不阻塞对话）
- ✅ Quest 的 Action Flow 视图天然适配本 skill 的 6 阶段流水线
- ✅ Quest 任务报告与本 skill 的 `report.md` 互补
- 💡 可选配合 Qoder 的 **Repo Wiki** 记录数据源 API 调用经验
- 💡 可选配合 Qoder 的 **Memory** 记录字段映射规则

**与 Qoder 内置能力的协同**：
- PDF 阅读：通用 PDF 用 Qoder 内置；生物文献表格提取用本 skill 的 `pdf_table_parser.py`
- Excel 编辑：通用 Excel 用 Qoder Work 内置 xlsx skill；带溯源列的规范导出用本 skill 的 `to_excel.py`

### 3.3 在 Qoder Work 上运行

**前置条件**：
- 安装 skill 到 `~/.qoderwork/skills/biomed-data-agent/`
- 安全工作环境中执行 `pip install -r scripts/requirements.txt`

**能力边界**：
- ✅ 完整支持所有功能
- ✅ 本地图片识别可用 Qoder Work 内置能力（更佳），也可用本 skill 脚本
- ✅ PPT 生成推荐用 Qoder Work 的 pptx skill（本 skill 不实现）
- ✅ Word 报告可用 Qoder Work 的 docx skill（更灵活），或用本 skill 的 `to_docx.py`（自动化）

**与 Qoder Work 内置 skills 的协同**：

| Qoder Work 内置 skill | 本 skill 对应 | 协同方式 |
|----------------------|--------------|---------|
| `docx` | `to_docx.py` | 通用 Word 用内置；带溯源的报告用本 skill |
| `pdf` | `pdf_table_parser.py` | 通用 PDF 用内置；生物表格提取用本 skill |
| `pptx` | 无 | 完全用 Qoder Work 内置（本 skill 不实现 PPT） |
| `xlsx` | `to_excel.py` + `io/` | 通用 Excel 用内置；带 Lineage sheet 的导出用本 skill |

## 四、功能覆盖完整性检查

### 4.1 赛题要求 vs skill 覆盖

| 赛题要求 | 覆盖脚本 | 状态 |
|---------|---------|------|
| 多源数据查找 | 7 个 datasources 客户端 | ✅ |
| 网页数据爬取 | 调度器 WebFetch / 浏览器（回退 Playwright） | ✅ |
| PDF/文献数据提取 | `pdf_table_parser.py` + 调度器 PDF skill | ✅ |
| 图表数据提取 | `extract_chart_data.py`（Qwen-VL） | ✅ |
| 数据清洗整合 | `field_aligner.py` + `unit_normalizer.py` + `duplicate_dedector.py` | ✅ |
| 字段对齐 | `field_aligner.py` + `dictionaries/` | ✅ |
| 数据可视化 | 5 个 viz 脚本 | ✅ |
| 来源可追溯性 | `provenance/`（记录/链接/导出/查询 + DAG 验证） | ✅ |
| 数据导出 | `export/`（CSV/Excel/Markdown/Word） | ✅ |
| 报告生成 | `to_report.py` + `to_docx.py` | ✅ |

### 4.2 与调度器能力的去重检查

| 调度器能力 | 本 skill 是否重复 | 说明 |
|-----------|------------------|------|
| 文件读写 | ❌ 不重复 | 完全用调度器 |
| WebFetch | ❌ 不重复 | 完全用调度器 |
| WebSearch | ❌ 不重复 | 完全用调度器 |
| Bash 执行 | ❌ 不重复 | 完全用调度器 |
| 浏览器自动化 | ❌ 不重复 | 完全用调度器 |
| 通用图表 | ❌ 不重复 | 本 skill 只做生物医学专用图 |
| 通用 PDF | ⚠️ 部分重叠 | 本 skill 专注生物文献表格（差异化） |
| 通用 Excel | ❌ 不重复 | 本 skill 专注带溯源列的导出 |
| 通用 Word | ❌ 不重复 | 本 skill 专注带血缘的报告 |
| MCP | ❌ 不重复 | 完全用调度器 |

## 五、依赖与环境

### 5.1 Python 依赖（scripts/requirements.txt）

所有依赖在 Trae Work 沙箱和 Qoder Quest 沙箱中均可通过 `pip install` 安装：

| 依赖 | 用途 | 必需性 |
|------|------|--------|
| requests | API 客户端 | 必需 |
| beautifulsoup4 + lxml | HTML 解析 | 必需 |
| pdfplumber | PDF 表格提取 | 必需（pdf_table_parser） |
| PyYAML | 字典加载 | 必需（cleaners） |
| numpy + scipy + statsmodels | 生信分析 | 必需（analysis） |
| networkx | PPI 网络 | 必需（ppi_network） |
| matplotlib + seaborn | 可视化 | 必需（viz） |
| openpyxl | Excel 读写 | 必需（io + export） |
| python-docx | Word 报告 | 可选（to_docx，缺失时降级） |

### 5.2 环境变量

| 变量 | 用途 | 必需性 |
|------|------|--------|
| `QWEN_API_KEY` | Qwen-VL API（本地图片识别） | 可选（仅 Trae 上需要；Qoder Work 内置图片识别） |
