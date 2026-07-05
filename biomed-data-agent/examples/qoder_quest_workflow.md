# Qoder Quest 模式使用示例

本文件展示如何在 Qoder 的 Quest 模式（异步自主委派）中运行 `biomed-data-agent` skill 完成一个完整的生物医学数据整合任务。

## 场景：健脾散结方治疗胰腺癌肝转移的多源数据整合

### 任务描述（粘贴到 Qoder Quest 对话框）

```
使用 biomed-data-agent skill 完成以下任务：

研究目标：分析健脾散结方治疗胰腺癌肝转移的潜在机制。

需要整合的数据：
1. 健脾散结方中各味中药的活性成分（来自 TCMSP）
2. 这些成分的潜在靶点蛋白（来自文献和 SwissTargetPrediction）
3. 胰腺癌肝转移相关差异基因（来自 GEO）
4. 靶点-疾病基因的 PPI 网络（来自 STRING）
5. 富集到的 KEGG 通路

输出要求：
- data.csv（带溯源列的统一数据表）
- data.xlsx（含 Data 和 Lineage 两个 sheet）
- report.md（中文 Markdown 报告）
- charts/（火山图、富集气泡图、PPI 网络图）
- lineage.json（完整血缘图）

任务 ID：tcm-jp-001
输出目录：data/output/tcm-jp-001/
```

### Qoder Quest 执行流程

Quest 模式会自动拆解任务并按本 skill 的 6 阶段流水线执行。Action Flow 视图将显示：

```
Stage 1: SEARCH
├─ [运行中] python scripts/datasources/tcmsp_client.py --herb "健脾散结方"
├─ [完成] python scripts/datasources/pubmed_client.py --query "pancreatic cancer liver metastasis TCM" --max 50
├─ [完成] python scripts/datasources/geo_client.py --query "pancreatic cancer liver metastasis" --max 20
└─ [等待中] python scripts/datasources/string_client.py --query "AKT1,TP53,MYC" --species 9606

Stage 2: ACQUIRE
└─ TCMSP 标记 requires_crawl → 调用 Qoder Browser Use 抓取

Stage 3: PARSE
├─ [完成] python scripts/parsers/geo_soft_parser.py --input GSE12345.soft.gz
└─ [完成] python scripts/parsers/pdf_table_parser.py --input paper.pdf

Stage 4: CLEAN
├─ [完成] python scripts/cleaners/field_aligner.py --input raw/ --out cleaned.json --dictionaries dictionaries/
├─ [完成] python scripts/cleaners/unit_normalizer.py --input cleaned.json --out normalized.json
└─ [完成] python scripts/cleaners/duplicate_dedector.py --input normalized.json --out dedup.json

Stage 5: ANALYZE
├─ [完成] python scripts/analysis/differential_expression.py --input dedup.json --out diff_expr.json
├─ [完成] python scripts/analysis/enrichment.py --gene-list "AKT1,TP53,MYC,..." --out enrichment.json
└─ [完成] python scripts/analysis/ppi_network.py --gene-list "AKT1,TP53,MYC,..." --out ppi.json

Stage 6: EXPORT
├─ [完成] python scripts/export/to_csv.py --input dedup.json --out data.csv
├─ [完成] python scripts/export/to_excel.py --input dedup.json --lineage lineage.json --out data.xlsx
├─ [完成] python scripts/export/to_report.py --input dedup.json --lineage lineage.json --out report.md
├─ [完成] python scripts/viz/volcano_plot.py --input diff_expr.json --out charts/volcano.png
├─ [完成] python scripts/viz/enrichment_bubble.py --input enrichment.json --out charts/enrichment.png
└─ [完成] python scripts/viz/network_plot.py --input ppi.json --out charts/ppi.png
```

### 与 Qoder 内置能力的协同

在 Quest 执行过程中，本 skill 会智能调用 Qoder 内置能力：

1. **TCMSP 爬取**：当 `tcmsp_client.py` 返回 `requires_crawl` 时，Quest Agent 自动调用 Qoder 的 Browser Use 抓取动态页面
2. **PDF 文献阅读**：通用 PDF 阅读用 Qoder 内置 pdf skill；提取实验数据表用本 skill 的 `pdf_table_parser.py`
3. **Word 报告**：如果用户更偏好 Qoder 的 docx skill，可以让 Quest Agent 在生成 `report.md` 后，用 docx skill 转换为 Word（带更丰富的排版）
4. **PPT 汇报**：本 skill 不实现 PPT，Quest Agent 可以读取 `report.md` 后用 Qoder Work 的 pptx skill 生成汇报 PPT

### 最终交付物

```
data/output/tcm-jp-001/
├── data.csv                 # 100 条记录，带 source_doi/source_url/extraction_confidence
├── data.xlsx                # 双 sheet：Data (100 行) + Lineage (45 节点)
├── report.md                # 8 节中文报告
├── report.docx              # 可选 Word 版（python-docx 生成）
├── lineage.json             # 完整血缘图，DAG 验证通过
├── field_mapping.json       # 字段映射表
├── duplicate_report.json    # 重复检测报告
├── unit_changes.json        # 单位转换记录
├── diff_expr.json           # 差异表达结果
├── enrichment.json          # 富集分析结果
├── ppi.json                 # PPI 网络结果
└── charts/
    ├── volcano.png          # 火山图
    ├── enrichment.png       # 富集气泡图
    ├── ppi.png              # PPI 网络图
    └── heatmap.png          # 表达热图（如有表达矩阵）
```

## Trae Work 上的对应运行方式

在 Trae Work 中，直接在对话中描述同样的任务，Trae 会自动调用本 skill 并在沙箱中执行脚本。差异：

- TCMSP 爬取回退到 Trae 的 WebFetch 或 agent-browser skill
- 本地图片识别用 `extract_chart_data.py`（Trae 不支持本地图片，需 `QWEN_API_KEY`）
- Excel/Word 生成完全用本 skill 的脚本（Trae 无内置 office skill）
- 长任务不支持异步委派（Trae 无 Quest 模式），需在对话中同步等待

## 关键提示

1. **任务 ID 一致性**：所有脚本的 `--task-id` 必须一致，确保溯源图能正确关联
2. **输出目录**：建议统一放到 `data/output/<task_id>/` 下，便于管理
3. **依赖安装**：首次运行前在沙箱中执行 `pip install -r scripts/requirements.txt`
4. **字典加载**：`field_aligner.py` 的 `--dictionaries` 参数指向 `dictionaries/` 目录
5. **溯源记录**：每个 stage 完成后用 `provenance/tracker.py record` 记录节点，最后用 `export` 导出血缘图
