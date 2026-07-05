# 字段对齐规则（Field Mapping Rules）

本文档说明 `biomed-data-agent` skill 在 Stage 4（CLEAN）中如何将多源异构字段对齐到统一字段名。规则由 `scripts/cleaners/field_aligner.py` 实现，字段映射表定义于 `dictionaries/field_aliases.yaml`（见 `schemas/field_mapping.schema.yaml`）。

字段对齐是竞赛评分的核心环节：只有当不同来源的同义字段被正确归并，后续的去重、冲突检测与富集分析才有意义。

---

## 1. 设计原则

### 为什么需要字段对齐

不同数据源对同一概念使用不同字段名：

| 概念 | PubMed | GEO | STRING | NCBI Gene | TCMSP |
|---|---|---|---|---|---|
| 基因符号 | （无） | `GeneSymbol` | `preferredName_A` | `name` / `SYMBOL` | （无） |
| 差异倍数 | （无） | `log2FoldChange` | （无） | （无） | （无） |
| P 值 | （无） | `P.Value` / `pvalue` | （无） | （无） | （无） |
| 化合物名 | （无） | （无） | （无） | （无） | `Molecule Name` |
| 互作得分 | （无） | （无） | `score` | （无） | （无） |

若不对齐，TP53 在 GEO 中叫 `GeneSymbol`、在 STRING 中叫 `preferredName_A`、在 NCBI 中叫 `name`，下游无法关联。

### 核心目标

1. **可关联**：同一实体（基因/化合物）在不同源中的记录能被识别为同一对象。
2. **可比较**：同一数值字段（如 fold change）跨源可比，单位统一。
3. **可溯源**：对齐过程不丢失原始字段名，保留在 `field_descriptions` 与 `processing_log`。
4. **可复现**：对齐规则完全由 `dictionaries/field_aliases.yaml` 驱动，无硬编码逻辑。

---

## 2. 命名规范

统一字段名（unified_field_name）遵循以下规范：

- **snake_case**：全小写，下划线分词。如 `gene_symbol`、`log2fc`、`p_value`、`adj_p_value`。
- **无空格、无连字符**：禁止 `Gene Symbol`、`gene-symbol`。
- **无源前缀**：禁止 `geo_log2fc`，统一用 `log2fc`。来源信息记录在 `source_ref.source_name`。
- **缩写保留惯例**：`log2fc`（非 `log_two_fold_change`）、`p_value`（非 `probability_value`）、`doi`（非 `digital_object_identifier`）。
- **单位后缀**：若字段本身含单位，将单位作为后缀。如 `ic50_um`（μM）、`ki_nm`（nM）。
- **布尔字段**：以 `is_` / `has_` 开头。如 `is_significant`、`has_mutation`。

### 统一字段名清单（核心）

| 统一字段名 | 类型 | 单位 | 说明 |
|---|---|---|---|
| `gene_symbol` | string | null | HGNC 官方基因符号 |
| `gene_id` | string | null | NCBI Gene ID |
| `compound_name` | string | null | 化合物通用名（小写） |
| `log2fc` | number | log2 | log2 fold change |
| `p_value` | number | none | 原始 P 值 |
| `adj_p_value` | number | none | 校正后 P 值（BH FDR） |
| `score` | number | none | 互作置信度（0-1） |
| `pathway_id` | string | null | KEGG 通路 ID（如 hsa04151） |
| `pdb_id` | string | null | PDB 结构 ID（如 1AKI） |
| `pmid` | string | null | PubMed ID |
| `doi` | string | null | DOI |

---

## 3. 同义词识别策略

`field_aligner.py` 按以下顺序匹配原始字段名到统一字段名：

### 3.1 精确匹配（confidence ≥ 0.95）

原始字段名经规范化后与 `field_aliases.yaml` 中的别名精确相等。

```python
# 规范化步骤
def normalize(name):
    return name.strip().lower().replace("-", "_").replace(" ", "_")
```

示例：
- `GeneSymbol` → 规范化 → `genesymbol` → 匹配别名 → `gene_symbol`
- `log2FoldChange` → 规范化 → `log2foldchange` → 匹配别名 → `log2fc`

### 3.2 规范化匹配（confidence 0.85-0.94）

去除大小写、空格、连字符、点号后匹配。

示例：
- `P.Value` → 去点 → `pvalue` → 匹配 → `p_value`
- `adj_p_val` → 匹配 → `adj_p_value`
- `preferred_name_A` → 规范化 → `preferred_name_a` → 匹配别名 → `gene_symbol`（仅 STRING 源）

### 3.3 模糊匹配（confidence 0.6-0.84，需人工复核）

当精确与规范化匹配均失败时，使用 Levenshtein 编辑距离（阈值 ≤ 2）寻找最接近的别名。模糊匹配的记录必须标记 `quality_flags: ["needs_review"]`。

示例：
- `logFC` → 编辑距离 1 → `log2fc`（少 "2"）→ 匹配，confidence=0.8
- `gene_sym` → 编辑距离 2 → `gene_symbol`（少 "bol"）→ 匹配，confidence=0.7

### 3.4 匹配失败处理

若三种策略均失败，字段名保留原样，记录到 `unmapped_fields` 列表，并在最终报告中提示。**不丢弃数据**，但该字段不参与跨源关联。

---

## 4. 单位转换规则

数值字段的单位必须统一。`unit_normalizer.py` 处理以下转换：

### 4.1 对数转换

| 原始单位 | 目标单位 | 转换公式 | 说明 |
|---|---|---|---|
| `log2` | `log2` | 无 | 已统一 |
| `log10` | `log2` | `x * log2(10)` ≈ `x * 3.3219` | GEO 部分旧数据集 |
| `ln` (自然对数) | `log2` | `x * log2(e)` ≈ `x * 1.4427` | RNA-seq 少数工具 |
| `log2FoldChange` | `log2` | 无 | 字段名不同，单位相同 |

### 4.2 Fold Change 转换

| 原始字段 | 原始单位 | 目标 | 转换公式 |
|---|---|---|---|
| `fold_change` | linear | `log2fc` | `log2(x)`（若 x > 0） |
| `fold_change` | linear（含负值表示下调） | `log2fc` | `sign(x) * log2(abs(x))` |
| `log2fc` | log2 | `log2fc` | 无 |

**方向约定**：`log2fc > 0` = case 高表达，`log2fc < 0` = control 高表达。若某源方向相反（如 `control/case`），应用 `transform: "x * -1"`。

### 4.3 浓度单位

| 原始单位 | 目标单位 | 转换公式 |
|---|---|---|
| `mM` | `uM` | `x * 1000` |
| `nM` | `uM` | `x / 1000` |
| `ug/mL` | `uM` | 需分子量 `x / MW * 1000` |

### 4.4 P 值

P 值无单位，但需处理以下边界：
- `p = 0`：截断为 `1e-300`（避免 `-log10(p)` 爆炸为 inf）
- `p > 1`：非法值，标记 `quality_flags: ["needs_review"]`
- `p < 0`：非法值，标记 `quality_flags: ["needs_review"]`，保留原值

---

## 5. 冲突处理策略

当同一实体（如 TP53 基因）在多个源中有同名字段但值不同时，按以下策略决策：

### 5.1 优先级源排序

按源的可信度排序，高优先级源的值胜出：

1. **结构化 API**（`extraction_method: api`，confidence=1.0）：GEO、NCBI、STRING、KEGG、PDB
2. **半结构化解析**（`extraction_method: table`，confidence=0.8）：PDF 表格、SOFT 解析
3. **非结构化提取**（`extraction_method: text`，confidence=0.6）：文献摘要 LLM 抽取
4. **图表 OCR**（`extraction_method: chart`，confidence=0.5）：图表数据提取
5. **手工录入**（`extraction_method: manual`，confidence=0.4）

### 5.2 数值冲突判定

两值差异超过 20% 视为冲突：

```python
def is_conflict(a, b, threshold=0.20):
    if a == 0 and b == 0:
        return False
    denom = max(abs(a), abs(b))
    return abs(a - b) / denom > threshold
```

### 5.3 冲突解决流程

1. **自动解决**：若高优先级源与低优先级源冲突，采用高优先级源的值，低优先级源的值记入 `processing_log`。
2. **人工复核**：若两个同优先级源冲突且差异 > 20%，标记 `quality_flags: ["needs_review", "conflict"]`，并在最终报告的 "Top Conflicts" 章节列出。
3. **数值平均**：若多个源值差异均 < 20%，取加权平均（权重 = extraction_confidence）。

### 5.4 字符串冲突

字符串字段（如 gene_symbol 大小写）冲突时：
- 基因符号：以 HGNC 官方大写形式为准（如 `TP53` 而非 `tp53`、`Tp53`）。
- 化合物名：以小写通用名为准（如 `quercetin` 而非 `Quercetin`）。
- 路径/URL：保留高优先级源的值。

---

## 6. 示例：字段对齐全过程

### 示例 1：GEO 的 `log2FoldChange` → `log2fc`

**原始记录**（来自 GEO 解析）：
```json
{
  "fields": {
    "GeneSymbol": "TP53",
    "log2FoldChange": -2.31,
    "P.Value": 0.00012,
    "adj_p_val": 0.0006
  },
  "source_ref": {"source_name": "geo"}
}
```

**对齐过程**：
1. `GeneSymbol` → 规范化 `genesymbol` → 精确匹配别名 → `gene_symbol`（confidence=0.95）
2. `log2FoldChange` → 规范化 `log2foldchange` → 精确匹配别名 → `log2fc`（confidence=0.99），单位 `log2` 无需转换
3. `P.Value` → 去点 `pvalue` → 匹配别名 → `p_value`（confidence=0.90）
4. `adj_p_val` → 规范化匹配 → `adj_p_value`（confidence=0.88）

**对齐后**：
```json
{
  "fields": {
    "gene_symbol": "TP53",
    "log2fc": -2.31,
    "p_value": 0.00012,
    "adj_p_value": 0.0006
  },
  "unit_info": {"log2fc": "log2", "p_value": "none", "adj_p_value": "none"},
  "extraction_confidence": 1.0
}
```

### 示例 2：STRING 的 `preferredName_A` → `gene_symbol`

**原始记录**（来自 STRING）：
```json
{
  "fields": {
    "preferredName_A": "AKT1",
    "preferredName_B": "TP53",
    "score": 0.95,
    "experimental": 0.62
  },
  "source_ref": {"source_name": "string"}
}
```

**对齐过程**：
1. `preferredName_A` → 规范化 `preferredname_a` → 匹配 STRING 源别名 → `gene_symbol`（confidence=0.92）
2. `preferredName_B` → 匹配 → `gene_symbol_b`（互作伙伴，非主基因）
3. `score` → 精确匹配 → `score`（confidence=1.0）
4. `experimental` → 匹配 → `evidence_experimental`（confidence=0.85）

### 示例 3：单位冲突解决

TP53 的 `log2fc` 在两源中值不同：
- GEO（api，confidence=1.0）：`log2fc = -2.31`
- 文献摘要抽取（text，confidence=0.6）：`fold_change = 0.2`（线性，下调）

**处理**：
1. 文献值转 `log2fc`：`sign(0.2) * log2(abs(0.2))` ... 但 0.2 < 1 表示下调，`log2(0.2) = -2.32`
2. 比较：`|-2.31 - (-2.32)| / 2.32 = 0.4%` < 20%，非冲突。
3. 加权平均：`(1.0 * -2.31 + 0.6 * -2.32) / 1.6 = -2.314`，采用 GEO 值（高优先级源）。

---

## 7. 引用：dictionaries/field_aliases.yaml

字段别名字典位于 `dictionaries/field_aliases.yaml`，格式遵循 `schemas/field_mapping.schema.yaml`。每条目定义一个统一字段及其在各源的别名：

```yaml
- unified_field_name: gene_symbol
  unified_field_label: 基因符号
  unified_unit: null
  unified_data_type: string
  description: HGNC 官方基因符号
  source_mappings:
    - source_name: ncbi_gene
      original_field_name: name
      original_unit: null
      transform: null
      confidence: 0.99
    - source_name: geo
      original_field_name: GeneSymbol
      original_unit: null
      transform: null
      confidence: 0.95
    - source_name: string
      original_field_name: preferredName_A
      original_unit: null
      transform: null
      confidence: 0.92

- unified_field_name: log2fc
  unified_field_label: log2 差异倍数
  unified_unit: log2
  unified_data_type: number
  description: case vs control 的 log2 fold change
  source_mappings:
    - source_name: geo
      original_field_name: log2FoldChange
      original_unit: log2
      transform: null
      confidence: 0.99
    - source_name: literature
      original_field_name: fold_change
      original_unit: linear
      transform: "sign(x) * log2(abs(x))"
      confidence: 0.70
```

`field_aligner.py` 启动时加载该字典，构建 `original_field_name → unified_field_name` 的查找表。运行时按上述 3 级策略（精确 → 规范化 → 模糊）匹配。

> 若 `dictionaries/field_aliases.yaml` 不存在，`field_aligner.py` 退化为仅做规范化匹配（无别名表），并发出警告。这是降级模式，不推荐用于生产。
