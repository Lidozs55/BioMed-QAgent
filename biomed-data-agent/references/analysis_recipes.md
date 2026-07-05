# 分析配方（Analysis Recipes）

本文档推荐不同研究场景下 `biomed-data-agent` skill 在 Stage 5（ANALYZE）中的分析参数与流程。配方对应 `scripts/analysis/` 下的脚本：`differential_expression.py`、`enrichment.py`、`ppi_network.py`。

> 配方是建议值，非硬约束。用户在查询中指定阈值时，以用户指定为准。

---

## 1. 差异表达分析配方

**脚本**：`scripts/analysis/differential_expression.py`
**输入**：cleaned DataRecord 列表（`fields` 含 `gene_symbol`、`log2fc`、`p_value`）
**输出**：`AnalysisResult`（`stats_table` + `chart_data` 火山图数据）

### 1.1 推荐阈值

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--lfc-threshold` | 1.0 | \|log2fc\| 显著性阈值，即 fold change ≥ 2 |
| `--p-threshold` | 0.05 | adj_p_value 显著性阈值 |
| FDR 校正方法 | `fdr_bh` | Benjamini-Hochberg FDR（statsmodels 优先，不可用时退化为内置实现） |

**显著基因判定**：`adj_p_value < 0.05` 且 `|log2fc| > 1.0`。
**调控方向**：`log2fc > 0` → `up`，`log2fc < 0` → `down`，否则 `not_significant`。

### 1.2 样本量要求

- 每组（case / control）≥ 3 个生物学重复。低于此数差异表达结果不可靠，应在报告中标注 `low_sample_size` 警告。
- 每组 ≥ 5 时推荐使用 DESeq2 / edgeR 而非简单 t 检验（本 skill 当前实现为 BH 校正后的阈值过滤，未做负二项建模）。

### 1.3 多重检验校正

- **默认**：BH FDR（`fdr_bh`），适合 RNA-seq 与芯片数据。
- **替代**：Bonferroni（过于保守，不推荐用于 > 100 基因场景）、q-value（Storey，需 `qvalue` 包）。
- 本 skill 实现见 `differential_expression.py` 的 `_bh_fdr()` 与 `_bh_builtin()`。

### 1.4 调用示例

```bash
python scripts/analysis/differential_expression.py \
    --input results/cleaned.json \
    --out results/diff_expr.json \
    --task-id tcm-jp-001 \
    --p-threshold 0.05 \
    --lfc-threshold 1.0
```

输出示例见 `examples/example_diff_expr_result.json`。

---

## 2. 富集分析配方

**脚本**：`scripts/analysis/enrichment.py`
**输入**：显著基因列表（来自差异表达或 PPI hub 基因）
**输出**：`AnalysisResult`（`stats_table` 富集条目 + `chart_data` 气泡图数据）

### 2.1 推荐基因集库

| 基因集库 | 适用场景 | 来源 |
|---|---|---|
| `KEGG_2021_Human` | 通路富集（首选） | Enrichr |
| `GO_Biological_Process_2023` | 生物过程富集 | Enrichr |
| `GO_Molecular_Function_2023` | 分子功能富集 | Enrichr |
| `Reactome_2022` | 通路富集（替代 KEGG） | Enrichr |
| `WikiPathways_2023_Human` | 通路富集（社区策展） | Enrichr |

默认同时富集 `KEGG_2021_Human` 与 `GO_Biological_Process_2023`。

### 2.2 显著性阈值

| 参数 | 推荐值 | 说明 |
|---|---|---|
| adj_p_value | < 0.05 | BH FDR 校正后 |
| 最小基因数 | 3 | 富集条目至少包含 3 个输入基因，否则丢弃 |

### 2.3 调用示例

```bash
python scripts/analysis/enrichment.py \
    --gene-list results/significant_genes.txt \
    --out results/enrichment.json \
    --task-id tcm-jp-001 \
    --libraries KEGG_2021_Human,GO_Biological_Process_2023
```

### 2.4 结果解读

- **富集比（fold enrichment）** > 2 视为强富集。
- **q值 < 0.01** 的条目优先报告。
- 气泡图（`enrichment_bubble.py`）按 `-log10(adj_p_value)` 排序，取 top 20。

---

## 3. PPI 网络分析配方

**脚本**：`scripts/analysis/ppi_network.py`
**输入**：基因列表 + STRING 互作边（来自 `string_client.py`）
**输出**：`AnalysisResult`（`stats_table` 节点 centrality + `chart_data` 网络图数据）

### 3.1 推荐参数

| 参数 | 推荐值 | 说明 |
|---|---|---|
| 物种 | 9606 (human) | NCBI taxon ID |
| 置信度阈值 | 0.4 (medium) / 0.7 (high) | 默认 medium；机制研究用 high |
| hub 基因定义 | degree top 10% | 按节点度数排序取前 10% |
| 最大节点数 | 200 | 超过则按 degree 截断，避免网络过大 |

### 3.2 centrality 指标

`ppi_network.py` 计算以下指标（依赖 networkx）：

- **degree**：节点连接数，识别 hub 基因。
- **betweenness centrality**：介数中心性，识别瓶颈节点。
- **closeness centrality**：接近中心性，识别信息传播关键节点。

### 3.3 调用示例

```bash
python scripts/analysis/ppi_network.py \
    --input results/string_edges.json \
    --out results/ppi_network.json \
    --task-id tcm-jp-001 \
    --species 9606 \
    --score-threshold 0.4 \
    --hub-top-pct 10
```

### 3.4 网络可视化

```bash
python scripts/viz/network_plot.py \
    --input results/ppi_network.json \
    --out charts/network.png
```

hub 基因以红色大节点高亮，其余节点按 degree 渐变色。

---

## 4. 中医药研究专属配方

**领域模板**：`domain_templates/tcm.yaml`
**典型场景**：健脾散结方治疗胰腺癌肝转移（见 `examples/example_research_query.md` 示例 1）

### 4.1 Compound-Target 网络构建

**目标**：构建"中药-成分-靶点-通路"四层网络。

**流程**：
1. 从 TCMSP 检索方中各味中药的活性成分（OB ≥ 30%，DL ≥ 0.18）。
2. 检索各成分的潜在靶点（TCMSP targets 字段，或 SwissTargetPrediction 补充）。
3. 用 STRING 检索靶点间 PPI（物种 9606，置信度 0.4）。
4. 用 KEGG 对靶点富集通路。
5. 构建四层二分图：herb → compound → target → pathway。

**参数**：
- OB 阈值：30（可调，严格模式用 50）
- DL 阈值：0.18
- STRING 置信度：0.4（medium）
- 富集库：`KEGG_2021_Human`

### 4.2 Pathway Enrichment for TCM

中医药研究的富集分析关注以下通路类别：

| 通路类别 | KEGG 通路 ID 示例 | 说明 |
|---|---|---|
| 细胞凋亡 | hsa04210 | 抗肿瘤机制核心 |
| PI3K-Akt | hsa04151 | 常见调控通路 |
| p53 信号 | hsa04115 | 肿瘤抑制 |
| 细胞周期 | hsa04110 | 增殖调控 |
| 血管生成 | hsa04370 | 转移相关 |
| NF-kappa B | hsa04064 | 炎症调控 |

### 4.3 调用流程

```bash
# 1. 检索中药成分
python scripts/datasources/tcmsp_client.py --herb "健脾散结方" --out results/tcmsp.json

# 2. 检索靶点 PPI
python scripts/datasources/string_client.py --query "TP53" --species 9606 --out results/string.json

# 3. 富集分析
python scripts/analysis/enrichment.py \
    --gene-list results/targets.txt \
    --out results/enrichment.json \
    --libraries KEGG_2021_Human

# 4. 构建复合网络
python scripts/analysis/ppi_network.py \
    --input results/string.json \
    --out results/ppi.json --score-threshold 0.4

# 5. 可视化
python scripts/viz/network_plot.py --input results/ppi.json --out charts/network.png
```

---

## 5. 肿瘤学专属配方

**领域模板**：`domain_templates/oncology.yaml`
**典型场景**：TP53 在乳腺癌中的表达差异（见 `examples/example_research_query.md` 示例 2）

### 5.1 Tumor vs Normal 对比

**目标**：识别肿瘤组织相对于正常组织的差异表达基因与突变。

**数据源优先级**：
1. GEO（首选，表达谱）
2. TCGA（若可访问，含突变与表达）
3. STRING（PPI 网络）
4. KEGG（通路富集）
5. PDB（蛋白结构，机制研究）

### 5.2 Mutation + Expression 整合

**流程**：
1. 从 GEO 检索 tumor vs normal 表达数据，差异表达分析。
2. （若 TCGA 可用）检索同一基因的突变频率。
3. 整合：高突变 + 表达异常的基因为关键驱动基因。
4. 对关键基因做 PPI 与富集分析。

**整合字段**：
- `gene_symbol`（关联键）
- `log2fc`（表达差异）
- `mutation_frequency`（突变频率，0-1）
- `mutation_type`（missense / nonsense / frameshift）

### 5.3 肿瘤学常用阈值

| 分析 | 参数 | 推荐值 |
|---|---|---|
| 差异表达 | \|log2fc\| | > 1.0 |
| 差异表达 | adj_p_value | < 0.01（肿瘤学研究比默认 0.05 更严） |
| 突变频率 | frequency | > 0.05（5% 为常见突变） |
| PPI 置信度 | score | > 0.7（high，机制研究） |
| 富集 | 最小基因数 | 3 |

### 5.4 调用流程

```bash
# 1. GEO 差异表达
python scripts/datasources/geo_client.py --query "breast cancer TP53" --out results/geo.json
python scripts/parsers/geo_soft_parser.py --input GSE12345.family.soft.gz --out results/geo_expr.json
python scripts/analysis/differential_expression.py \
    --input results/geo_expr.json --out results/diff_expr.json \
    --p-threshold 0.01 --lfc-threshold 1.0

# 2. PPI 网络（高置信度）
python scripts/datasources/string_client.py --query "TP53" --species 9606 --out results/string.json
python scripts/analysis/ppi_network.py \
    --input results/string.json --out results/ppi.json --score-threshold 0.7

# 3. 通路富集
python scripts/analysis/enrichment.py \
    --gene-list results/significant_genes.txt \
    --out results/enrichment.json \
    --libraries KEGG_2021_Human,GO_Biological_Process_2023

# 4. 蛋白结构
python scripts/datasources/pdb_client.py --query "TP53" --out results/pdb.json

# 5. 可视化
python scripts/viz/volcano_plot.py --input results/diff_expr.json --out charts/volcano.png
python scripts/viz/network_plot.py --input results/ppi.json --out charts/network.png
python scripts/viz/enrichment_bubble.py --input results/enrichment.json --out charts/enrichment.png
```

---

## 6. 配方速查表

| 研究场景 | 主脚本 | 关键阈值 | 输出图表 |
|---|---|---|---|
| 差异表达 | `differential_expression.py` | \|log2fc\|>1, adj_p<0.05 | 火山图 |
| GO/KEGG 富集 | `enrichment.py` | adj_p<0.05, min_genes=3 | 气泡图 |
| PPI 网络 | `ppi_network.py` | score≥0.4, hub=top10% | 网络图 |
| TCM 网络药理学 | 上述三者组合 | OB≥30%, DL≥0.18 | 复合网络图 |
| 肿瘤多组学 | 差异表达+PPI+富集 | adj_p<0.01, score≥0.7 | 火山图+网络图+气泡图 |
| 表达热图 | `heatmap.py`（viz） | — | 热图 |

---

## 7. 注意事项

- **样本量不足**：每组 < 3 时跳过差异表达，仅做描述性统计。
- **基因数不足**：富集分析输入基因 < 5 时结果不可靠，应警告。
- **网络过大**：PPI 节点 > 500 时按 degree 截断至 top 200，避免可视化拥塞。
- **多重比较**：富集分析的条目数可能很多，务必看 adj_p_value 而非原始 p_value。
- **可复现性**：所有分析参数必须写入 `AnalysisResult.parameters`，并最终进入 `lineage.json` 的对应 ProvenanceNode。
