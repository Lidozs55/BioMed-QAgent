# Legacy Skill 参考文档

> 本文档扫描 `legacy-biomed-data-agent-skill/biomed-data-agent/` 目录,识别可借鉴的功能、代码和设计模式,为当前 BioMedQAgent 项目的后续开发提供参考。
>
> 生成时间:2026-07-13

## 1. 概述

Legacy 目录是 v0 之前的 Stage 架构实现,采用 6 阶段流水线模型(SEARCH → ACQUIRE → PARSE → CLEAN → ANALYZE → EXPORT),通过 CLI 脚本驱动。当前项目已迁移到 Agent loop 架构(OpenAI Agents SDK),但 legacy 中的许多设计模式和实现逻辑仍然值得借鉴。

**核心差异**:
- Legacy:CLI 脚本模式,stdout 输出 JSON,exit code 表示状态
- 当前:@function_tool 装饰的 Agent Tool,返回 JSON 字符串

## 2. 目录结构

```
legacy-biomed-data-agent-skill/biomed-data-agent/
├── SKILL.md                       # Skill 主清单(6 阶段流水线 + 工具优先级)
├── scripts/                       # 可执行 Python 脚本
│   ├── requirements.txt           # 依赖清单(核心+可选,带降级说明)
│   ├── datasources/               # 7 个生物医学 API 客户端
│   ├── parsers/                   # 5 个格式解析器
│   ├── cleaners/                  # 3 个清洗/字段对齐模块
│   ├── analysis/                  # 3 个生信分析模块
│   ├── provenance/                # 溯源追踪器 + 查询器
│   ├── viz/                       # 5 个可视化脚本
│   ├── export/                    # 5 个导出脚本
│   └── io/                        # 5 个格式转换脚本
├── schemas/                       # 5 个数据契约(JSON/YAML)
├── dictionaries/                  # 4 个同义词字典(YAML)
├── domain_templates/              # 3 个领域模板
├── references/                    # 3 篇详细参考文档
├── examples/                      # 输入/输出样例
└── _test/                         # 端到端测试
```

## 3. 可借鉴功能(按优先级分级)

### P0 — 必须借鉴(架构级,填补当前项目空白)

| # | 功能 | Legacy 路径 | 借鉴理由 |
|---|---|---|---|
| 1 | **DataRecord / SourceReference / ProvenanceNode schema 体系** | `schemas/*.schema.json` | 当前项目 `app.domain` 包尚不完整,这 5 个 schema 可作为 domain models 的基础 |
| 2 | **Provenance DAG 追踪(tracker + query)** | `scripts/provenance/tracker.py` + `query.py` + `_base.py` | 反向 BFS 追溯 + Kahn 拓扑排序 + 四重 DAG 校验 + node_id 哈希生成 |
| 3 | **field_aligner 双层归一化字段对齐** | `scripts/cleaners/field_aligner.py` | `_norm_key` + `_compact_key` 双层匹配 + alias_index + 4 种 transform |
| 4 | **duplicate_dedector 实体去重 + 冲突检测** | `scripts/cleaners/duplicate_dedector.py` | `(gene_symbol, compound_name, context)` 实体键 + 综合置信度 + 20% 冲突阈值 |
| 5 | **6 阶段流水线编排模型** | `SKILL.md` | SEARCH → ACQUIRE → PARSE → CLEAN → ANALYZE → EXPORT 阶段划分 |

### P1 — 强烈建议借鉴(当前项目 stub 可直接替换)

| # | 功能 | Legacy 路径 | 借鉴理由 |
|---|---|---|---|
| 6 | **PubMed 客户端(esearch + efetch)** | `scripts/datasources/pubmed_client.py` | 完整实现,可替换当前 `search_literature` stub |
| 7 | **GEO 客户端 + SOFT 解析器** | `scripts/datasources/geo_client.py` + `scripts/parsers/geo_soft_parser.py` | GEO 肿瘤学研究核心数据源,纯 Python SOFT 解析 |
| 8 | **STRING PPI 客户端 + 网络解析器** | `scripts/datasources/string_client.py` + `scripts/parsers/network_parser.py` | PPI 网络机制研究,支持 STRING TSV/SIF/GraphML 三格式 |
| 9 | **KEGG 通路客户端** | `scripts/datasources/kegg_client.py` | KEGG REST API + flat 格式解析,物种特异性通路优先 |
| 10 | **TCMSP 客户端 + requires_crawl 降级模式** | `scripts/datasources/tcmsp_client.py` | `requires_crawl` 信号机制是处理无 API 数据源的典范 |
| 11 | **PDB 客户端 + PDB 解析器** | `scripts/datasources/pdb_client.py` + `scripts/parsers/pdb_parser.py` | RCSB Search v2 + Data REST,纯 Python 按固定列读取 |
| 12 | **NCBI Gene/Protein 客户端** | `scripts/datasources/ncbi_client.py` | 支持 db=gene/protein 双数据库 |
| 13 | **差异表达分析(BH FDR + 纯 Python 降级)** | `scripts/analysis/differential_expression.py` | `_bh_builtin` 纯 Python BH 实现 |
| 14 | **富集分析(Enrichr + 降级)** | `scripts/analysis/enrichment.py` | Enrichr addList + enrich 流程 |
| 15 | **PPI 网络分析(STRING + networkx 双重降级)** | `scripts/analysis/ppi_network.py` | hub genes = degree top 10% |

### P2 — 建议借鉴(提升完整度与工程质量)

| # | 功能 | Legacy 路径 | 借鉴理由 |
|---|---|---|---|
| 16 | **同义词字典体系(4 个 YAML)** | `dictionaries/*.yaml` | field_aliases(25+ 字段)/gene_symbols/compound_names/unit_aliases |
| 17 | **领域模板机制** | `domain_templates/*.yaml` | 按研究目标(tcm/oncology)加载不同模板 |
| 18 | **Excel 双 sheet 导出(Data + Lineage)** | `scripts/export/to_excel.py` | openpyxl + 表头加粗 + 冻结首行 + 中英宽度估算 |
| 19 | **Markdown 8 节报告 + 内容/渲染分离** | `scripts/export/to_report.py` + `to_docx.py` | `build_report()` 返回 sections,多格式渲染 |
| 20 | **火山图 / 热图 / 网络图 / 气泡图** | `scripts/viz/volcano_plot.py` 等 | 生物医学专用图表,中文字体自动选择 |
| 21 | **本地图片图表数据提取(Qwen-VL)** | `scripts/viz/extract_chart_data.py` | base64 编码 + Qwen-VL API,严格 JSON 提示词 |
| 22 | **IO 转换工具集** | `scripts/io/*.py` | CSV/Excel/JSON 互转 + 多文件合并去重 |
| 23 | **统一 _base.py 工程范式** | 每个 `scripts/*/_base.py` | 抽象基类 + make_record + setup_cli + emit_ok/emit_error |
| 24 | **优雅降级模式** | 全部脚本 | 主依赖缺失 → 降级模式 → 标记 flag |
| 25 | **端到端无网测试** | `_test/e2e_test.py` | 本地 fixture 测试全链路降级路径 |
| 26 | **4 级工具优先级模型** | `SKILL.md` | 调度器原生 → 其他 skill → 内置脚本 → 自写脚本 |

### P3 — 可选借鉴(参考价值)

| # | 功能 | Legacy 路径 | 借鉴理由 |
|---|---|---|---|
| 27 | **FASTA 解析器(蛋白/DNA 自动检测)** | `scripts/parsers/fasta_parser.py` | 字母集合判断序列类型,流式解析 |
| 28 | **PDF 表格解析器 + caption 抓取** | `scripts/parsers/pdf_table_parser.py` | pdfplumber + 正则识别 Figure/Table caption |
| 29 | **3 篇参考文档** | `references/*.md` | datasource_catalog / field_mapping_rules / analysis_recipes |
| 30 | **unit_normalizer 单位归一化** | `scripts/cleaners/unit_normalizer.py` | ln→log2/log10→log2/fold_change→log2fc 转换公式 |

## 4. 关键设计模式总结

### 4.1 统一输出契约
所有脚本 stdout 输出 `{"status":"ok",...}` / `{"status":"error","message":"..."}` JSON,stderr 输出人类可读进度,exit code 0=成功。

### 4.2 make_record 工厂
自动生成 `<source>-<md5_8>` 格式 record_id,自动填 UTC ISO 8601 时间戳,自动构造 source_ref。

### 4.3 DAG 溯源模型
ProvenanceNode 组成 DAG,通过 `input_node_ids` 链接,反向 BFS 追溯 root sources。Kahn 拓扑排序保证无环。

### 4.4 综合置信度
`extraction_confidence × source_reliability`,source_reliability 按数据源类型分级:
- pubmed/ncbi_gene/ncbi: 0.95
- pdb: 0.92
- geo/kegg: 0.90
- string: 0.88
- tcmsp: 0.85
- tcm: 0.80
- 默认: 0.70

### 4.5 20% 冲突阈值
同实体跨源数值差异 > 20% 标记 `conflict + needs_review`,满足"人工纠错"加分项。

### 4.6 优雅降级三段式
主依赖缺失 → 降级模式 → 标记 flag(`*_unavailable`),永不中断流水线。

### 4.7 内容/渲染分离
`build_report()` 生成 sections 列表(block 类型 para/bullets/table),`render_markdown`/`render_docx` 分别渲染,同一份内容多格式输出。

### 4.8 领域模板驱动
按研究目标加载 tcm/oncology 模板,模板定义 priority_sources / recommended_field_mappings / analysis_recipes / confidence_thresholds。

### 4.9 4 级工具优先级
调度器原生 → 其他 skill → 内置脚本 → 自写脚本(带完整 QA),内置脚本定位为"最后兜底"。

### 4.10 requires_crawl 信号机制
无 API 数据源(如 TCMSP)在接口被封锁时输出 `{"status": "requires_crawl", "reason": "..."}` 并 exit 0,把决策权交回上层用浏览器自动化接管。**当前项目已在 D4 阶段实现此机制**(`app/tools/crawl_signal.py`)。

## 5. 移植建议

### 5.1 与当前项目的对应关系

| 当前项目 | Legacy 对应实现 | 移植建议 |
|---|---|---|
| `app.domain`(不完整) | `schemas/*.schema.json` (5 个) | 转为 Pydantic v2 models,放 `app.domain.models` |
| 溯源(部分实现) | `provenance/tracker.py` + `query.py` | 封装为 `app.core.provenance`,作为 runner 内置能力 |
| 字段对齐(缺失) | `cleaners/field_aligner.py` + `dictionaries/field_aliases.yaml` | 封装为 `app.tools.alignment` 模块 |
| 去重(缺失) | `cleaners/duplicate_dedector.py` | 封装为 `app.tools.cleaning` 模块 |
| 分析脚本(部分) | `analysis/*.py` (3 个) | 封装为 `@function_tool`,放 `app.skills.builtin.analysis` |

### 5.2 CLI → Agent Tool 转换要点

1. **入口转换**:CLI `main()` → `@function_tool` 装饰的函数
2. **参数转换**:`argparse` 参数 → `@function_tool` 函数签名
3. **输出转换**:`print(json.dumps(...))` → `return json.dumps(...)`
4. **上下文注入**:添加 `ctx: RunContextWrapper[RunContext]` 首参数
5. **provenance 集成**:调用 `run_ctx.add_source()` / `run_ctx.add_raw_asset()`
6. **查询日志**:调用 `run_ctx.log_query()`
7. **工作目录**:使用 `run_ctx.work_dir.raw` / `artifacts` 替代硬编码路径

### 5.3 保留不变的核心逻辑

- `make_record` 工厂(record_id 生成)
- `_bh_fdr` / `_bh_builtin`(BH FDR 校正)
- `_trace_root_nodes`(反向 BFS 追溯)
- `_norm_key` / `_compact_key`(双层归一化)
- `RateLimiter`(限速器)
- `SOURCE_RELIABILITY` 权重表
- 优雅降级三段式模式

## 6. 附录:完整文件清单

### 6.1 数据源客户端(scripts/datasources/)

| 文件 | 数据源 | 访问方式 | 关键字段 |
|---|---|---|---|
| `pubmed_client.py` | PubMed | NCBI E-utilities | pmid, title, abstract, authors, journal, doi |
| `ncbi_client.py` | NCBI Gene/Protein | esearch + esummary | gene_id, symbol, organism, aliases |
| `geo_client.py` | GEO | esearch on gds + esummary | geo_id(GSE), title, sample_count, platform |
| `string_client.py` | STRING PPI | REST JSON | protein_a, protein_b, score, evidence |
| `kegg_client.py` | KEGG | REST flat | pathway_id, title, genes, compounds |
| `pdb_client.py` | RCSB PDB | Search v2 + Data REST | pdb_id, title, organism, resolution, method |
| `tcmsp_client.py` | TCMSP | API + 爬虫降级 | compound_name, mw, ob, dl |

### 6.2 解析器(scripts/parsers/)

| 文件 | 格式 | 亮点 |
|---|---|---|
| `fasta_parser.py` | FASTA | 纯标准库,蛋白/DNA 自动检测,流式 |
| `pdb_parser.py` | PDB | 纯 Python 按固定列,AA3TO1 映射 |
| `geo_soft_parser.py` | GEO SOFT | 纯 Python,自动 gzip,状态机 |
| `network_parser.py` | STRING/SIF/GraphML | 三格式自动检测,纯标准库 |
| `pdf_table_parser.py` | PDF 表格 | pdfplumber + caption 抓取 |

### 6.3 清洗器(scripts/cleaners/)

| 文件 | 功能 | 关键设计 |
|---|---|---|
| `field_aligner.py` | 字段名对齐 + 值标准化 | 双层归一化 + alias_index + 4 种 transform |
| `unit_normalizer.py` | 单位归一化 | ln→log2/log10→log2/fold_change→log2fc |
| `duplicate_dedector.py` | 去重 + 冲突检测 | 实体键 + 综合置信度 + 20% 冲突阈值 |

### 6.4 分析脚本(scripts/analysis/)

| 文件 | 分析类型 | 关键设计 |
|---|---|---|
| `differential_expression.py` | 差异表达 | BH FDR + 纯 Python 降级 |
| `enrichment.py` | GO/KEGG 富集 | Enrichr API + 降级 |
| `ppi_network.py` | PPI 网络 | STRING + networkx 双重降级 |

### 6.5 溯源(scripts/provenance/)

| 文件 | 功能 |
|---|---|
| `tracker.py` | 有状态 CLI(record/link/export 三子命令) |
| `query.py` | 查询器(反向 BFS + text/json 格式) |
| `_base.py` | 基础设施(make_node/topological_sort/validate_dag) |

### 6.6 可视化(scripts/viz/)

| 文件 | 用途 |
|---|---|
| `volcano_plot.py` | 差异表达火山图 |
| `enrichment_bubble.py` | GO/KEGG 富集气泡图 |
| `heatmap.py` | 表达矩阵热图(seaborn clustermap) |
| `network_plot.py` | PPI 网络图(hub 高亮) |
| `extract_chart_data.py` | 本地图片图表数据提取(Qwen-VL) |

### 6.7 导出(scripts/export/)

| 文件 | 格式 | 特性 |
|---|---|---|
| `to_csv.py` | CSV | 必含来源列 |
| `to_excel.py` | Excel | 双 sheet(Data + Lineage) |
| `to_report.py` | Markdown | 8 节中文报告 |
| `to_docx.py` | Word | 复用 to_report.build_report() |
| `to_pdf.py` | PDF | reportlab + 中文字体检测 |

### 6.8 IO 转换(scripts/io/)

| 文件 | 转换方向 |
|---|---|
| `csv_to_json.py` | CSV → DataRecord JSON |
| `excel_to_json.py` | Excel → DataRecord JSON |
| `json_to_csv.py` | DataRecord JSON → CSV |
| `json_to_excel.py` | DataRecord JSON → Excel |
| `merge_json.py` | 多 JSON/目录 → 合并去重 |

### 6.9 数据契约(schemas/)

| 文件 | 用途 |
|---|---|
| `data_record.schema.json` | 统一记录格式 |
| `source_reference.schema.json` | 来源引用 |
| `provenance_node.schema.json` | 溯源节点 |
| `field_mapping.schema.yaml` | 字段映射表 |
| `lineage_graph.schema.yaml` | 血缘图 |

### 6.10 同义词字典(dictionaries/)

| 文件 | 覆盖范围 |
|---|---|
| `field_aliases.yaml` | 25+ 字段(gene_symbol/log2fc/p_value 等) |
| `gene_symbols.yaml` | ~30 个 HGNC 基因别名 |
| `compound_names.yaml` | ~25 个化合物(含 SMILES/PubChem CID) |
| `unit_aliases.yaml` | 全单位覆盖(expression_log/fold_change/concentration) |

### 6.11 领域模板(domain_templates/)

| 文件 | 研究方向 | 首选数据源 |
|---|---|---|
| `_template.yaml` | 通用基类 | - |
| `tcm.yaml` | 中医药 | TCMSP(OB≥30%/DL≥0.18) |
| `oncology.yaml` | 肿瘤学 | GEO(adj_p<0.01) |

---

**文档结束**。本文档基于 2026-07-13 的 legacy 目录扫描生成,后续如有 legacy 目录变更需同步更新。
