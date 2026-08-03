# 产物审查与自主科研比对报告

> **本文档的执行摘要和结论已整合至
> [RESEARCH_SYSTEM_REVIEW_2026-08-03.md](RESEARCH_SYSTEM_REVIEW_2026-08-03.md)。
> 以下完整产物审查证据和独立科研发现保留为详细参考。**
>
> **研究主题**：阿尔茨海默病与骨质疏松症往往并发出现的原因和相关数据
> **审查日期**：2026-08-02
> **审查方法**：逐文件审查系统产物 + 同主题独立科研 + 严格比对 PROBLEM.md 需求
> **审查产物来源**：`task_03298a37` (2026-08-02T12:20, 最新完成) + `task_248bf8d0` (2026-08-02T08:00, 较早完成)

---

## 一、执行摘要

系统针对"阿尔茨海默病(AD)与骨质疏松症(OP)共病"研究主题执行了两次完整 Pipeline 运行，最终产物通过了 8 项验证检查（165 项子检查, 0 失败）。然而，经逐文件审查与同主题独立科研比对，发现产物在**数据查找完备性、数据内容实质性和多源整合能力**三个核心维度存在严重不足：

| 评价维度 | PROBLEM.md 要求 | 系统实际表现 | 评级 |
|----------|----------------|-------------|------|
| 数据查找完备性 | 子领域内数据查找完备 | 仅 2 个来源(1 文献+1 GEO)，遗漏 GWAS/PDB/Reactome/PubChem | ❌ 严重不足 |
| 来源可追溯性 | 数据来源清楚可追溯 | 完整 provenance 链(14 CSV)，每条记录有 source_id | ✅ 达标 |
| 清洗整合可靠性 | 数据清洗整合可靠 | 表达数据下载 404 失败，以元数据占位符通过验证 | ❌ 严重不足 |
| 输出格式可用性 | 便于后续分析 | CSV 结构规范但 main_data 全空，无法用于下游分析 | ⚠️ 格式达标但内容缺失 |

**核心结论**：系统产出了一个"形式完整但内容空心"的产物包——provenance 链路完整、CSV 格式规范、验证全部通过，但核心数据字段（gene_id、expression_value）100% 缺失，实际无法支撑任何科研分析。

---

## 二、系统产物详细审查

> PROBLEM.md 的七项能力要求和四项评价标准详见仓库根目录 PROBLEM.md，
> 此处不再赘述。下文直接审查系统产物实际表现。

### 3.1 产物文件清单（task_03298a37, 14 CSV + 1 JSON）

| 文件 | 大小 | 行数 | 实质内容评级 |
|------|------|------|-------------|
| `main_data.csv` | 11 KB | 39 行 | ❌ **全空** — 39 行均为 `metadata_only` 占位符，gene_id/expression_value/source_raw_value 100% 缺失 |
| `sample_metadata.csv` | 7 KB | 39 行 | ⚠️ 仅样本分组信息(AD/CTRL, APOE 基因型)，无表达数据 |
| `literature.csv` | 527 B | 1 行 | ⚠️ 仅 1 篇文献(PMID 42421969) |
| `source_list.csv` | 571 B | 2 行 | ⚠️ 仅 2 个来源(1 PubMed + 1 GEO) |
| `dataset_catalog.csv` | 510 B | 1 行 | ❌ **数据库字段错误** — `database=pubmed` 但 accession 是 GEO 的 GSE260461 |
| `source_relations.csv` | 507 B | 2 行 | ✅ 正确关联 PMID↔GSE |
| `source_assets.csv` | 508 B | 1 行 | ✅ 记录了下载的 series_matrix 文件 |
| `download_log.csv` | 679 B | 2 行 | ❌ **表达数据下载失败(HTTP 404)** |
| `processing_log.csv` | 1.7 KB | 1 行 | ❌ **处理步骤为占位符**(`geo_minimal_placeholder`) |
| `cleaning_report.csv` | 507 B | 6 行 | ⚠️ 6 条缺失值报告(全部 39 行的 6 个字段均缺失) |
| `warnings.csv` | 1.5 KB | 6 行 | ⚠️ 6 条 info 级缺失值警告 |
| `quality_report.csv` | 850 B | 8 行 | ❌ **验证过于宽松** — 8 项检查全通过，但未检测到核心数据缺失 |
| `field_descriptions.csv` | 3 KB | 22 行 | ✅ 22 个字段均有描述 |
| `field_mapping.csv` | 2.7 KB | 22 行 | ✅ 22 个字段映射(identity) |
| `run_manifest.json` | — | — | ✅ 完整的运行清单 |

### 3.2 关键缺陷逐项分析

#### 缺陷 1：表达数据下载失败，Pipeline 以空数据继续

`download_log.csv` 显示 `GSE260461_tximportCounts.txt.gz` 下载返回 HTTP 404。
Pipeline 仅成功下载了 series matrix 元数据文件（14 KB），然后以
`geo_minimal_placeholder` 处理步骤生成了 39 行**纯元数据占位行**。

**问题**：下载失败后未尝试替代 URL（SRA/ArrayExpress）、未尝试替代数据集、
未触发 HIL 机制、Pipeline 继续以"成功"状态完成。

#### 缺陷 2：main_data.csv 核心字段 100% 缺失

`main_data.csv` 的 39 行全部为 `metadata_only` 占位符——`gene_id`、
`expression_value`、`source_raw_value` 均 100% 缺失。`cleaning_report.csv`
确认 6 个核心字段各有 39 个缺失值。**产物中没有任何实际的基因表达数据**，
只有 39 个样本的 ID 和分组标签。

#### 缺陷 3：验证门禁过于宽松

`quality_report.csv` 的 8 项检查全部通过，但分析发现验证逻辑存在盲区：

| 检查项 | 结果 | 问题 |
|--------|------|------|
| `main_data_nonempty` | passed (39 rows) | ❌ 仅检查行数>0，未检查核心字段非空率 |
| `source_value_lineage` | passed (0 checked) | ❌ **39 行全部跳过**("skipped_metadata_rows": 39)，0 项实际检查 |
| `field_descriptions` | passed (22 fields) | ✅ 字段描述完整，但描述的字段本身为空 |
| `foreign_keys` | passed (39 rows) | ✅ 外键完整性正确(指向 source/asset) |
| 其余 4 项 | passed | 一致性检查正确，但检查的是空数据的一致性 |

**核心问题**：验证门禁没有"核心数据实质存在性"检查——即不验证 `expression_value` 或 `gene_id` 是否有非空值。100% 缺失的产物可以通过验证。

#### 缺陷 4：dataset_catalog.csv 数据库字段错误

```csv
dataset_id,source_id,database,accession,...
ds_geo_gse260461,src_07efbdec...,pubmed,GSE260461,...
```

`database` 字段值为 `pubmed`，但 `accession` 是 GEO 的 `GSE260461`。这表明 discovery 阶段将 GEO 数据集的来源数据库错误标记为 PubMed。

#### 缺陷 5：GEO 数据集与研究主题不完全匹配

GSE260461 标题为 "Sex-dependent APOE4 Neutrophil-microglia interactions drive cognitive impairment in Alzheimer's Disease"——这是一个**纯 AD 数据集**，研究 APOE4 与小胶质细胞的相互作用，**完全不涉及骨质疏松或骨代谢**。虽然 APOE4 同时是 AD 和 OP 的共享风险基因，但该数据集本身不包含骨组织数据或骨代谢指标。

### 3.3 第二次运行（task_248bf8d0）对比

| 维度 | task_03298a37 (新) | task_248bf8d0 (旧) |
|------|--------------------|--------------------|
| 文献 | PMID 42421969 (骨-免疫-脑轴综述) | PMID 41972397 (APOE4 对女性骨的影响) |
| GEO | GSE260461 (相同) | GSE260461 (相同) |
| main_data SHA256 | 9eb94266... | 9eb94266... (完全相同) |
| 表达数据 | 下载失败 (404) | 下载失败 (404) |
| 验证 | valid (165 checks) | valid (165 checks) |

两次运行找到了**不同的文献**但**相同的 GEO 数据集**，且 main_data 内容**字节级一致**。两次运行的表达数据下载均失败。

---

## 四、独立科研发现（同主题深度研究）

### 4.1 流行病学证据

| 发现 | 数据 | 来源 |
|------|------|------|
| AD→OP 风险增加 | +56%(总体), +70%(AD 患者) | Zhou et al. meta-analysis |
| AD 患者髋部骨折风险 | 高达 ~3× | Margetts 2024, PMC10912148 |
| 骨质疏松→AD 风险 | 女性 2.15×, 男性 2.0× | Zhang 2023, PMC9963274 |
| 遗传度(双胞胎) | AD=60-80%, BMD=60-80% | Li YX 2026, Aging Dis |

### 4.2 共享基因/蛋白（22 个，系统产物覆盖 0 个）

| # | 基因 | AD 中的作用 | OP 中的作用 | 关键证据 |
|---|------|------------|------------|----------|
| 1 | APP | Aβ 前体，AD 标志 | Aβ 沉积于骨组织 | PMC9865655 |
| 2 | APOE | ε4=最强 AD 风险 | 调控骨量 | PMC10912148 |
| 3 | LRP6 | Wnt 共受体, AD 风险(Val-1062) | 同一变异→低骨量 | De Ferrari 2007 PNAS |
| 4 | LRP5 | Wnt 共受体 | 骨密度基因, OPPG | Kobayashi 2016 |
| 5 | SOST | Wnt 拮抗剂, AD 生物标志物 | 骨细胞 Wnt 抑制剂 | Bhat 2024 |
| 6 | DKK1 | Wnt 拮抗剂, Aβ 诱导毒性 | 骨形成抑制剂 | Ogunwale 2025 |
| 7 | TNFSF11 (RANKL) | 神经炎症 | 破骨细胞分化驱动 | PMC12834398 |
| 8 | TNFRSF11A (RANK) | 细胞因子受体 | 破骨细胞受体 | Nelson 2012 |
| 9 | TNFRSF11B (OPG) | OPG/TRAIL 比值预测认知 | 诱饵受体, 抗吸收 | Ogunwale 2025 |
| 10 | VDR | 脑内维生素 D 信号 | 骨矿化 | Life 2023 |
| 11 | ESR1/ESR2 | 雌激素信号, AD 性别差异 | 绝经后骨丢失 | Onisiforou 2024 |
| 12 | BACE1 | APP 裂解(限速) | BACE1-/- 小鼠骨代谢改变 | Li/Cui 2022 |
| 13 | TREM2 | R47H→AD (OR~3-5) | 小胶质细胞, 骨影响 | PMC11781270 |
| 14 | RUNX2 | 受 Aβ 影响 | 成骨细胞主转录因子 | Chen 2024 |
| 15 | TNF | 神经炎症 | 骨吸收↑ | PMC12087362 |
| 16 | IL6 | 神经炎症 | 骨吸收 | 共享综述 |
| 17 | CASR | sAβ-CaSR→Aβ 寡聚 | 骨钙感知 | PMC12834398 |
| 18 | AKT1/FOXO3a | 线粒体/氧化 | 成骨细胞功能障碍 | Liu 2026 PMID 41534646 |
| 19 | TGFB1 | Wnt-TGFβ 串扰 | 破骨细胞 RANKL 调控 | Liu Y 2025 |
| 20 | BDNF | 神经元存活 | 骨神经支配 | 多篇综述 |
| 21 | SP7 (Osterix) | Wnt 靶点 | 成骨细胞分化 | Kobayashi 2016 |
| 22 | TNFSF10 (TRAIL) | 认知生物标志物 | OPG/TRAIL 轴 | Ogunwale 2025 |

### 4.3 关键数据库资源（系统应发现但未发现）

#### GEO 数据集（系统仅找到 1 个，应找到 11+）

**AD 相关（脑/海马）**：GSE5281, GSE48350, GSE36980, GSE1297, GSE29378, GSE221365, GSE28955
**AD 相关（血液/PBMC）**：GSE4226, GSE18309, GSE63060, GSE63061
**OP 相关（骨/BM-MSC/单核细胞）**：GSE35958, GSE35959, GSE56814, GSE56815, GSE7158, GSE7429, GSE13850, GSE100609, GSE74209, GSE64433, GSE115773, GSE100930, GSE80614

**跨组织网络分析**：Nagarajan et al. (J Gerontol A 2024) 整合了 ROSMAP 脑组织 + Oslo 骨组织转录组数据，识别共享基因模块——这是最直接相关的数据资源。

#### PDB 蛋白结构（系统找到 0 个，应找到 9+）

| 蛋白/复合物 | PDB ID | 说明 |
|------------|--------|------|
| APP E1 结构域 | 4PWQ | 1.40 Å 分辨率 |
| APP E2 结构域 | 3NYJ | 与 LRP5 相互作用 |
| APP E2 + 铜 | 3UMK | Cu/Zn 结合位点 |
| Sclerostin (SOST) | 2KD3 | NMR 结构, 结合 LRP5 |
| RANKL-OPG 复合物 | 4E4D | 骨吸收关键复合物 |
| RANKL-RANK 复合物 | 4GIQ | 破骨细胞信号 |
| APOE4 | 多个条目 | 脂质结合变异体 |
| VDR 配体结合域 | 1DB1, 1IE9 | calcitriol 结合 |

#### Reactome/KEGG 共享通路（系统找到 0 个，应找到 7+）

- Wnt 信号通路 (Reactome R-HSA-201681 / KEGG hsa04310)
- RANKL→NF-κB→破骨细胞分化 (KEGG hsa04380)
- TNF 受体结合 (Reactome R-HSA-5660668)
- 雌激素信号 (KEGG hsa04915)
- 钙信号 (KEGG hsa04020)
- PI3K-Akt 信号 (KEGG hsa04151)
- 维生素 D 受体通路 (Reactome R-HSA-196791)

#### PubChem 化合物（系统找到 0 个，应找到 10+）

Calcitriol (CID 5280453), 17β-Estradiol (CID 5757), Raloxifene (CID 5035), Resveratrol (CID 445154), Probucol (CID 4912) 等——均有双重靶点潜力。

#### GWAS Catalog（系统找到 0 个）

AD 风险位点 ~95 个（APOE, ABCA7, BIN1, TREM2, SORL1 等）；OP/BMD GWAS 位点（LRP5, VDR, ESR1, SOST, TNFSF11 等）。尚无专门的 AD×BMD 跨性状 GWAS 分析作为策展资源。

### 4.4 共享分子机制总结

1. **Wnt/β-catenin 通路** — 核心共享轴，促进骨形成和突触生成
2. **RANKL/RANK/OPG 轴** — 破骨细胞分化与神经炎症共享
3. **Aβ 在骨组织沉积** — APP/PS1 转基因小鼠在海马、皮层和股骨中沉积 Aβ
4. **雌激素缺乏** — 绝经后同时驱动 AD 和 OP
5. **维生素 D/钙稳态** — VDR 在脑和骨中均有表达
6. **神经炎症** — 共享细胞因子 (TNF-α, IL-6, IL-1β)
7. **氧化应激/线粒体功能障碍** — Aβ 在脑和骨中均导致氧化损伤
8. **骨-免疫-脑轴** — 免疫系统作为中枢介导者

---

## 五、严格比对：系统产物 vs 独立科研

### 5.1 数据查找完备性比对

| 数据类别 | 系统发现数 | 独立科研发现数 | 覆盖率 | 评级 |
|----------|-----------|---------------|--------|------|
| PubMed 文献 | 1 篇 | 15+ 篇关键综述 | ~7% | ❌ |
| GEO 数据集 | 1 个(仅 AD) | 23+ 个(AD+OP) | ~4% | ❌ |
| GWAS 位点 | 0 | ~100+ 位点 | 0% | ❌ |
| PDB 结构 | 0 | 9+ 个 | 0% | ❌ |
| Reactome 通路 | 0 | 7+ 条 | 0% | ❌ |
| PubChem 化合物 | 0 | 10+ 个 | 0% | ❌ |
| 共享基因 | 0 | 22 个 | 0% | ❌ |
| **总计** | **2 来源** | **80+ 数据点** | **~2.5%** | **❌ 严重不足** |

### 5.2 数据内容实质性比对

| 维度 | 系统产物 | 独立科研 | 差距 |
|------|---------|---------|------|
| 基因表达数据 | 0 条(100% 缺失) | 应有 GEO 表达矩阵 | 完全缺失 |
| 样本元数据 | 39 条(仅 AD 样本) | 应有 AD+OP 样本 | 仅 AD, 缺 OP |
| 文献信息 | 1 篇(摘要级) | 15+ 篇(含机制分析) | ~7% |
| 基因-疾病关联 | 0 | 22 个共享基因 | 完全缺失 |
| 通路-疾病关联 | 0 | 7+ 共享通路 | 完全缺失 |
| 蛋白结构 | 0 | 9+ PDB 结构 | 完全缺失 |
| 化合物-靶点 | 0 | 10+ 化合物 | 完全缺失 |

### 5.3 PROBLEM.md 七项能力评估

| # | 能力 | 评估 | 证据 |
|---|------|------|------|
| 1 | 数据查找 | ❌ 1/7 | 仅查询 PubMed+GEO，未使用 GWAS/PDB/Reactome/PubChem 技能 |
| 2 | 数据解析 | ❌ 1/7 | 处理步骤为 `geo_minimal_placeholder`，非真实解析；series matrix 仅提取样本 ID |
| 3 | 数据清洗 | ❌ 1/7 | 6 个核心字段 100% 缺失，"清洗"仅报告缺失值，无实际清洗动作 |
| 4 | 字段对齐 | ⚠️ 3/7 | field_mapping/field_descriptions 完整，但仅对空字段做映射 |
| 5 | 来源标注 | ✅ 7/7 | source_list/source_relations/source_assets 完整，每条记录有 source_id |
| 6 | 结构化输出 | ⚠️ 3/7 | CSV 结构规范(22 字段)，但 main_data 内容为空 |
| 7 | 图表数据处理 | ❌ 0/7 | 完全未涉及图表提取 |

### 5.4 加分项评估

| 加分项 | 实现 | 评估 |
|--------|------|------|
| 自动识别缺失数据 | ⚠️ 部分 | cleaning_report 报告了缺失值，但仅记录未处理 |
| 自动识别重复数据 | ❌ 未实现 | 单一来源无重复可识别 |
| 自动识别单位不一致 | ❌ 未实现 | 无实际数值数据 |
| 图表坐标轴/图例解析 | ❌ 未实现 | — |
| 完成修正或寻求人类建议 | ❌ 未实现 | 下载失败后未触发 HIL，未尝试替代数据源 |

---

## 六、根因分析

### 6.1 Agent 层面：数据库调度策略不足

**现象**：系统拥有 PubMed, GEO, GDC, Xena, PDB, PubChem, Reactome 七个数据库的检索技能，但 Agent 仅使用了 PubMed + GEO。

**根因**：
1. Agent 的 system prompt 未强制要求多数据库联合检索
2. Agent 找到 1 篇文献 + 1 个数据集后即认为"足够"进入 Pipeline
3. 缺少"数据查找完备性"的自评估机制——Agent 不知道何时才算"查找完备"

**证据**：Agent 最终总结提到"建议 DEG 分析聚焦 Wnt 通路基因(LRP5, CTNNB1, SOST)和免疫基因(TREM2, IL17RA, CX3CR1); 整合 Reactome 通路"——说明 Agent **知道**应该查 Reactome 和更多基因，但**没有实际执行**这些查询。

### 6.2 Pipeline 层面：下载失败后的降级策略过于宽松

**现象**：表达数据文件返回 HTTP 404 后，Pipeline 以 series matrix 元数据继续执行，最终产出空数据产物。

**根因**：
1. `geo_minimal_placeholder` 处理步骤是一个"兜底"逻辑——当无法解析真实表达数据时，从 series matrix 提取样本 ID 作为元数据行
2. Pipeline 没有核心数据存在性检查——不验证 `expression_value` 或 `gene_id` 是否有非空值
3. 下载失败后未触发替代策略（如：尝试 SRA 下载、尝试 ArrayExpress 镜像、报告 HIL 让用户选择替代数据集）

### 6.3 验证层面：验证门禁缺少实质内容检查

**现象**：8 项验证检查全部通过，但产物中 100% 核心数据缺失。

**根因**：
1. `main_data_nonempty` 仅检查行数 > 0，不检查核心字段非空率
2. `source_value_lineage` 对 `metadata_only` 行直接跳过(`skipped_metadata_rows: 39`)，0 项实际检查
3. 没有"数据实质存在性"检查——即不验证产物是否包含可分析的实际数据（表达值、基因 ID 等）
4. 验证逻辑关注**结构完整性**（格式、外键、字段描述）而非**内容完整性**（数据值存在性）

### 6.4 数据质量问题：dataset_catalog 字段错误

**现象**：`dataset_catalog.csv` 中 GEO 数据集的 `database` 字段值为 `pubmed`。

**根因**：discovery 阶段将 GEO 数据集的 source 来源标记错误。可能是 discovery 输出中将 PubMed 搜索结果与 GEO 数据集的 source_id 混淆。

---

## 七、优化建议

> 以下建议已按优先级实施或记录为后续设计。P0 项已在 §十四 实施，P1/P2 项
> 的详细设计见 §十五。

| 优先级 | 建议 | 状态 |
|--------|------|------|
| P0 | 验证门禁增加核心数据存在性检查 | ✅ 已实施（§14.1） |
| P0 | 修复 dataset_catalog database 字段错误 | ✅ 已实施（§14.4） |
| P0 | Agent 多数据库联合检索 + 共病双侧分解 | ✅ 已实施（§14.5，本轮重构为五类主题策略） |
| P0 | 下载失败后替代策略 + HIL | 📋 见 §15.2 |
| P1 | GEO series matrix 完整解析器 | 📋 见 §15.3 |
| P1 | 覆盖率报告工具 + post-pipeline 检查 | 📋 见 §15.4 |
| P2 | 文献全文表格提取 | 📋 见 §15.6 |

---

## 八、理想产物蓝图（基于独立科研）

如果系统充分发挥能力，针对"AD 与 OP 共病"主题应覆盖 7 个数据库（PubMed 15+ 篇、
GEO 10+ 个 AD+OP 数据集、GWAS 2 批次、PDB 9+ 结构、Reactome 7+ 通路、PubChem 10+
化合物、Xena 2+ 仓库），`main_data.csv` 应包含 AD 脑组织和 OP 骨组织的基因表达矩阵，
并以 22 个共享基因为枢纽产出多源整合表（基因 × AD 表达值 | OP 表达值 | 通路归属 |
PDB 结构 | GWAS p-value）。

> **架构限制**：当前 PDB/PubChem/GWAS 属于 `RESEARCH_ONLY` 数据库，数据无法进入
> `artifacts/` 正式产物（详见 docs/AGENT_PROMPT_REFACTOR_DESIGN_2026-08-03.md §二）。
> 实现理想蓝图需先将这些数据库升级为 `PIPELINE_SUPPORTED` 或增加 `agent_research_notes`
> 产物通道。

---

## 九、附录：关键文献参考

| # | 文献 | 期刊 | 年份 | PMC/PMID | 核心贡献 |
|---|------|------|------|----------|----------|
| 1 | Xu G et al. | Front Immunol | 2026 | PMC13341297 | 骨-免疫-脑轴框架 |
| 2 | Margetts TJ et al. | Curr Osteoporos Rep | 2024 | PMC10912148 | AD-OP 流行病学综述 |
| 3 | De Ferrari GV et al. | PNAS | 2007 | doi:10.1073/pnas.0603523104 | LRP6 Val-1062 共享变异 |
| 4 | Nagarajan A et al. | J Gerontol A | 2024 | doi:10.1093/gerona/glae211 | 跨组织网络分析 |
| 5 | Xia W et al. | Molecules | 2023 | PMC9865655 | Aβ 在骨组织中沉积 |

---

## 十、结论

系统在**来源可追溯性**方面表现优秀（完整的 provenance 链、规范的 CSV 格式、详细的字段描述），但在**数据查找完备性**（仅覆盖 2.5% 应有数据来源）、**清洗整合可靠性**（核心数据 100% 缺失却通过验证）和**输出内容实质性**（main_data 全空）三个维度存在严重不足。

最关键的改进优先级：
1. **验证门禁增加核心数据存在性检查**（P0）——防止空数据产物通过验证
2. **下载失败后实施替代策略 + HIL**（P0）——避免单点失败导致整个产物空心化
3. **Agent 多数据库联合检索策略**（P1）——将数据覆盖率从 2.5% 提升到 60%+
4. **GEO 处理步骤升级**（P2）——从占位符解析升级为真实表达数据解析

---

# 第二部分：独立科研工作流深度剖析与 Agent 系统改进设计

> 本部分记录审查者针对"AD 与 OP 共病"主题进行独立深度科研时的**完整工作流、
> 思考路径和决策点**，逐环节与 Agent 系统的实际行为比对，识别 Agent 达成
> 优秀结果所受的**阻力**、**缺失的工具**，以及工作流中**可嵌入 Pipeline 的
> 结构化部分**。目标是让系统能复现甚至超越独立科研的发现质量（比赛项目要求）。

---

## 十一、独立科研完整工作流与决策路径

### 11.1 工作流总览（七阶段闭环）

```
┌─────────────────────────────────────────────────────────────────────┐
│  阶段 0：问题边界界定                                                │
│  "AD 与 OP 共病" → 不是"找 AD 数据 + 找 OP 数据"，而是              │
│  "找解释两者共发的共享分子机制 + 支撑该机制的数据证据"               │
└─────────────────────────────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────────────────────────────┐
│  阶段 1：文献锚定（综述优先）                                        │
│  目标：建立机制全景，而非收集单篇论文                                │
│  动作：搜索近 3 年综述 → 提取"共享机制候选清单"                      │
└─────────────────────────────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────────────────────────────┐
│  阶段 2：机制假设生成                                                │
│  从综述中归纳 7-8 条候选共享通路：Wnt、RANKL/OPG、雌激素、           │
│  维生素 D、Aβ 沉积、神经炎症、氧化应激、骨-免疫-脑轴                 │
└─────────────────────────────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────────────────────────────┐
│  阶段 3：基因-疾病双向验证（核心差异化步骤）                          │
│  对每个候选基因，独立验证它在 AD 和 OP 中均有证据                     │
│  → 产出 22 个"双疾病确证基因"清单                                    │
└─────────────────────────────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────────────────────────────┐
│  阶段 4：多数据库交叉发现（按机制驱动，非按关键词驱动）              │
│  PubMed(文献) + GEO(表达,AD侧+OP侧) + PDB(结构) +                   │
│  Reactome/KEGG(通路) + PubChem(化合物) + GWAS(遗传重叠)             │
└─────────────────────────────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────────────────────────────┐
│  阶段 5：数据可用性预检                                              │
│  对每个 GEO 数据集，验证 supplementary 文件真实可下载（HEAD 请求）    │
│  → 剔除 404 的数据集，换用同主题替代数据集                            │
└─────────────────────────────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────────────────────────────┐
│  阶段 6：覆盖率自评估（闭环门禁）                                    │
│  检查清单：7 个数据库都覆盖了？7 条机制都有数据支撑？                │
│  22 个共享基因都有表达/结构/通路证据？→ 未覆盖则回到阶段 4           │
└─────────────────────────────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────────────────────────────┐
│  阶段 7：跨组织整合与输出                                            │
│  以共享基因为枢纽，整合 AD 脑组织表达 + OP 骨组织表达 + 结构 + 通路  │
└─────────────────────────────────────────────────────────────────────┘
```

### 11.2 阶段 0：问题边界界定（决策点 1）

**我的思考**：用户问"AD 与 OP 为何共病"。如果直接搜索 "Alzheimer AND osteoporosis"，
会得到少量直接研究共病的文献，但会错过大量**间接但关键**的证据——例如 LRP6 基因
的 Val-1062 变异同时导致 AD 风险和低骨量（De Ferrari 2007 PNAS），这类研究本身
不提"共病"但恰好是共享机制的核心证据。

**决策**：将问题分解为三个子目标：
1. **AD 侧数据**：AD 相关基因表达、变异、结构
2. **OP 侧数据**：OP/BMD 相关基因表达、变异、结构
3. **共享机制数据**：同时在 AD 和 OP 文献中出现的基因/通路/化合物

**Agent 的行为**：Agent 把主题当作单一 blob 处理，搜索 "Alzheimer osteoporosis"，
找到 1 篇骨-免疫-脑轴综述 + 1 个 AD 数据集（GSE260461），即认为完成。**没有
双侧分解，没有共享机制子目标**。

**差距根因**：Agent 的 prompt 没有"共病/多表型主题的双侧分解"策略。

### 11.3 阶段 1：文献锚定——综述优先（决策点 2）

**我的思考**：单篇原始研究论文视野狭窄。对于"共病机制"这类需要全局视角的问题，
**先读 3-5 篇近 3 年综述**，建立机制全景，再深入原始研究。综述会明确列出"已
知共享机制清单"，省去逐篇阅读的成本。

**决策**：
- 搜索 "Alzheimer osteoporosis review 2023..2026"
- 找到 Xu G 2026 (骨-免疫-脑轴)、Margetts 2024 (流行病学)、Li YX 2026 (机制综述)
- 从综述中提取候选共享机制：Wnt、RANKL/OPG、雌激素、VDR、Aβ 沉积、神经炎症

**Agent 的行为**：Agent 搜索后取**第一篇命中**（PMID 42421969），未区分综述与
原始研究，未做"近 3 年"时间过滤，未从综述中提取机制清单。

**差距根因**：Agent 的检索策略缺少"文献类型分层"——综述用于建立全景，原始研究
用于验证细节。Agent 也没有"从综述中提取候选机制清单"的步骤。

### 11.4 阶段 2：机制假设生成（决策点 3）

**我的思考**：有了综述全景后，不应直接跳到数据库检索，而应先**生成机制假设**。
"共享机制"是一个可验证的假设——如果 Wnt 通路是共享机制，那么 Wnt 通路的关键
基因（LRP5/6, SOST, DKK1, CTNNB1）应该同时在 AD 和 OP 中有证据。

**决策**：生成 7 条候选共享通路，每条列出 3-5 个关键基因：
- Wnt/β-catenin → LRP5, LRP6, SOST, DKK1, CTNNB1
- RANKL/RANK/OPG → TNFSF11, TNFRSF11A, TNFRSF11B
- 雌激素信号 → ESR1, ESR2
- 维生素 D → VDR
- Aβ 沉积 → APP, BACE1
- 神经炎症 → TNF, IL6, TREM2
- 成骨分化 → RUNX2, SP7

**Agent 的行为**：Agent 没有显式的"假设生成"步骤。它从 1 篇综述摘要中提到
"Wnt 通路"后在最终总结里**建议**查 Wnt 基因，但**没有实际执行**这个查询。

**差距根因**：Agent 的"知道"和"做到"之间存在断裂——它在总结阶段提出了正确的
方向（Wnt、TREM2、Reactome），但在检索阶段没有执行。说明缺少"假设→验证"
的闭环驱动机制。

### 11.5 阶段 3：基因-疾病双向验证（核心差异化步骤，决策点 4）

**我的思考**：这是独立科研与 Agent 系统差距最大的环节。找到一个候选基因后，
**必须独立验证它在两个疾病中均有证据**，否则不能纳入"共享基因清单"。

**决策**（以 LRP6 为例）：
1. 搜索 "LRP6 Alzheimer" → 找到 De Ferrari 2007 PNAS（Val-1062 变异→AD 风险）
2. 搜索 "LRP6 osteoporosis bone" → 找到同一变异→低骨量的证据
3. **双向验证通过** → LRP6 纳入共享基因清单

对 22 个候选基因逐一执行此流程，最终确认 22 个基因均通过双向验证。

**Agent 的行为**：Agent 完全没有此步骤。它没有"共享基因"概念，没有"双向验证"
概念。它的产物中基因覆盖数为 0。

**差距根因**：这是工作流中最难自动化的部分——它需要"假设→分侧检索→交叉确认"
的多步推理。但可以通过 prompt 策略 + 工具组合部分实现。

### 11.6 阶段 4：多数据库交叉发现（决策点 5）

**我的思考**：不同数据库回答不同问题：
- PubMed → "有什么文献证据？"
- GEO → "有什么表达数据？"
- PDB → "有什么结构数据？"
- Reactome → "有什么通路证据？"
- PubChem → "有什么化合物能同时靶向？"
- GWAS → "有什么遗传重叠？"

**决策**：按**机制**而非按**关键词**驱动检索。例如查 PDB 时不是搜
"Alzheimer osteoporosis"（PDB 没有疾病标签），而是搜"SOST protein structure"
和"RANKL OPG complex"——因为阶段 2 已确定这些是共享机制的关键蛋白。

**Agent 的行为**：Agent 仅查了 PubMed + GEO（2/7 数据库），完全跳过 PDB、
Reactome、PubChem、GWAS。Agent 的最终总结提到"整合 Reactome 通路"，说明它
**知道**应该查 Reactome，但没有执行。

**差距根因**：
1. Agent prompt 没有强制"多数据库覆盖"门禁
2. Agent 没有机制驱动的检索策略——它不知道在 PDB 里该搜什么
3. Agent 找到 2 个来源后即认为"足够"进入 Pipeline，缺少覆盖率自评估

### 11.7 阶段 5：数据可用性预检（决策点 6）

**我的思考**：GEO 数据集的 supplementary 文件经常 404（尤其是较新的数据集，
tximport 文件可能尚未上传）。在投入解析之前，**先验证文件可下载**，避免
浪费下游处理时间。

**决策**：
1. 对每个候选 GSE，先发 HEAD 请求检查 supplementary 文件 URL
2. 若 404 → 换用同主题替代数据集（如 GSE5281 替代 GSE260461）
3. 优先选择有完整 series_matrix + supplementary 文件的成熟数据集

**Agent 的行为**：Agent 直接传入 GSE260461，Pipeline 下载 tximport 文件时
404 失败，但以 series matrix 元数据继续执行，产出空数据。

**差距根因**：
1. Agent 没有数据可用性预检步骤
2. Pipeline 下载失败后无替代策略，无降级标记，以"成功"状态完成
3. 验证门禁不检查核心数据是否存在

### 11.8 阶段 6：覆盖率自评估（闭环门禁，决策点 7）

**我的思考**：科研不是"找到就停"，而是"覆盖完才算完"。我维护一个覆盖率矩阵：

| 数据库 | 已覆盖 | 应覆盖 | 缺口 |
|--------|--------|--------|------|
| PubMed | 15 篇 | 15+ | ✅ |
| GEO(AD) | 7 个 | 7+ | ✅ |
| GEO(OP) | 13 个 | 10+ | ✅ |
| PDB | 9 个 | 9+ | ✅ |
| Reactome | 7 条 | 7+ | ✅ |
| PubChem | 10 个 | 10+ | ✅ |
| GWAS | 2 批 | 2+ | ✅ |

只有所有行 ✅ 才进入输出阶段。

**Agent 的行为**：Agent 没有覆盖率矩阵。找到 2 个来源后直接进入 Pipeline。

**差距根因**：Agent 缺少"数据查找完备性"的自评估机制和门禁。

### 11.9 阶段 7：跨组织整合

**我的思考**：最终产物应以**共享基因为枢纽**，整合多源数据：
- LRP6 行 = {AD 表达值, OP 表达值, PDB 结构 ID, Reactome 通路, GWAS p-value}
- 这需要跨数据库的字段对齐，而非简单堆叠。

**Agent 的行为**：Agent 的 Pipeline 产出 39 行纯元数据占位符，无任何跨源整合。

---

## 十二、Agent 达成优秀结果的阻力分析

### 12.1 认知层阻力（Agent "想不到"）

| 阻力 | 表现 | 影响 |
|------|------|------|
| 缺少问题分解模型 | 把"共病"当单一主题，不做双侧分解 | 只找到单侧数据 |
| 缺少机制假设驱动 | 不先生成假设再验证，而是"搜到什么算什么" | 检索无方向性 |
| 缺少覆盖率自评估 | 不知道"什么时候算查完了" | 提前停止，覆盖 2.5% |
| 综述与原始研究不分层 | 取第一篇命中，不论类型 | 错过机制全景 |

### 12.2 工具层阻力（Agent "做不到"）

| 缺失工具/能力 | 影响 | 可嵌入 Pipeline? |
|---------------|------|-----------------|
| 数据可用性预检工具 | 无法在入 Pipeline 前验证文件可下载 | ✅ 可做 pre-pipeline check |
| 共享基因交叉验证工具 | 无法自动做基因→双疾病反向验证 | ⚠️ 半结构化，需 LLM 辅助 |
| 覆盖率报告工具 | 无法自动生成"已覆盖/未覆盖"矩阵 | ✅ 可做 post-pipeline report |
| 替代数据集推荐工具 | 下载失败后无法自动换数据集 | ✅ 可做 acquisition fallback |
| 全文表格提取工具 | 仅获取摘要，错过表格中的基因列表 | ⚠️ 需 PMC 全文解析 |
| series matrix 完整解析器 | 只提取样本 ID，不解析表达矩阵 | ✅ 可做 processing 升级 |
| 通路-基因映射工具 | 无法将基因映射到 Reactome 通路 | ✅ Reactome 已有数据 |

### 12.3 流程层阻力（Agent "停不下/走不动"）

| 阻力 | 表现 | 影响 |
|------|------|------|
| 无"进入 Pipeline 前"覆盖率门禁 | 找到 2 个来源就进 Pipeline | 覆盖率极低 |
| 下载失败后无 HIL 机制 | 静默降级为空数据 | 产物空心化 |
| 验证门禁不检查内容实质 | 空数据通过 8 项检查 | 假阳性"成功" |
| Pipeline 无降级状态 | 核心数据缺失仍标"completed" | 误导 Agent 和用户 |

---

## 十三、工作流中可嵌入 Pipeline 的结构化部分

以下是独立科研工作流中**高度结构化、可直接编码进 Pipeline 或工具**的环节：

### 13.1 可嵌入验证门禁的结构化检查（本轮已实施）

| 检查 | 来源工作流阶段 | 实现方式 |
|------|---------------|---------|
| 核心数据存在性检查 | 阶段 5：数据可用性预检 | `check_core_data_existence`：expression_value/gene_id 非空率 < 阈值则 failed |
| 测量实质性检查 | 阶段 5 | `check_measurement_substance`：100% 行为 sample_metadata 则 warning |
| 数据库覆盖检查 | 阶段 6：覆盖率自评估 | `check_source_diversity`：来源数据库数 < 2 则 warning |

### 13.2 可嵌入 Agent prompt 的结构化策略（本轮已实施）

| 策略 | 来源工作流阶段 | 实现方式 |
|------|---------------|---------|
| 研究主题分类与策略选择 | 阶段 0 | prompt 第1步：五类主题（单疾病/共病/药物靶点/生物标志物/通路）各自策略 |
| 多数据库强制覆盖 | 阶段 4/6 | prompt 第3步：覆盖门禁检查清单，至少 3 个相关数据库才进 Pipeline |
| 机制驱动检索 | 阶段 2/4 | prompt 第2步：先从综述提取候选机制，再按机制基因查 PDB/Reactome |
| 数据可用性预检 | 阶段 5 | prompt 第4步：传入 GSE 前优先选成熟数据集，404 后换替代 |
| RESEARCH_ONLY 数据流 | 阶段 7 | prompt"数据库与数据流"小节：PDB/PubChem 数据用 write_file 保存供汇报 |

### 13.3 需要较大改动才能嵌入的部分（记录为后续设计）

| 部分 | 来源阶段 | 改动规模 | 文档位置 |
|------|---------|---------|---------|
| 数据可用性预检工具 | 阶段 5 | 中（新工具） | §十五 大改动设计 |
| 下载失败替代策略 + HIL | 阶段 5 | 大（Pipeline 状态机扩展） | §十五 大改动设计 |
| series matrix 完整解析器 | 阶段 7 | 中（processing 升级） | §十五 大改动设计 |
| 覆盖率报告工具 | 阶段 6 | 中（新产物 + 检查） | §十五 大改动设计 |
| 共享基因交叉验证 | 阶段 3 | 大（需 LLM 多步推理） | §十五 大改动设计 |
| 全文表格提取 | 阶段 1 | 大（PMC 解析 + OCR） | §十五 大改动设计 |

---

## 十四、本轮已实施的中小改动清单

> 以下改动均为结构化、低风险、可直接编码的改进，已在本轮直接实施。

### 14.1 验证门禁：新增 `core_data_existence` 检查（P0）

**文件**：`backend/app/pipeline/stages/validation/checks/main_data.py`
**改动**：新增 `check_core_data_existence` 函数，检查 `expression_value` 和 `gene_id`
的非空率。阈值 10%——低于此则产物无法支撑任何分析，标记 failed。
**嵌入位置**：`package.py` 检查序列，紧随 `main_data_nonempty` 之后。

### 14.2 验证门禁：`source_value_lineage` 增加跳过比例报告（P1）

**文件**：`backend/app/pipeline/stages/validation/checks/lineage.py`
**改动**：当 `skipped_metadata_rows` 占比 > 80% 时，在 `details` JSON 中追加
`high_skip_ratio: true` 标记。这让下游可区分"真实验证通过"和"跳过全部行的空通过"
（后者即产物空心化的信号）。
**注**：原计划的 `measurement_substance` 检查与 `core_data_existence` 功能重叠
（都检测"全元数据无表达"），已合并到 14.1 不单独实现。

### 14.3 数据库覆盖引导：改为 Agent prompt 策略（非验证检查）

**决策**：`source_diversity` 作为验证检查价值有限——验证层无法知道 Agent"应该"
查哪些数据库，只能检查已有来源数。已改为 Agent prompt 中的"多数据库联合检索要求"
（见 14.5），在检索阶段而非验证阶段驱动覆盖率。覆盖率报告工具的设计见 §15.4。

### 14.4 修复 `catalog.py` database 字段错误（P0）

**文件**：`backend/app/pipeline/stages/artifact_build/catalog.py`
**改动**：`_build_dataset_catalog_rows` 的单数据集分支中，`database` 字段从
`sources[0].database.value`（总是 PubMed，因为 sources 列表 PubMed 在前）改为
根据 `is_reactome` / `geo` 判定实际数据库。Reactome → "reactome"，有 geo → "geo"。

### 14.5 Agent prompt 连贯化重构（P1，两轮迭代）

**文件**：`backend/app/agent_loop/agent.py`
**改动**：
- **第一轮**：新增多数据库覆盖门禁、共病双侧分解、数据可用性预检（补丁式）
- **第二轮**：将补丁式小节重构为连贯的六步工作流——第1步内嵌五类研究主题
  分类与策略选择（单疾病机制/共病/药物靶点/生物标志物/通路网络），第3步
  内嵌结构化覆盖门禁检查清单，第4步内嵌数据可用性预检。新增"数据库与数据流"
  小节明确 RESEARCH_ONLY 数据库（PDB/PubChem）的数据无法进入 artifacts/。
  详见 `docs/AGENT_PROMPT_REFACTOR_DESIGN_2026-08-03.md`。

### 14.6 更新 `test_validation_split.py` 黄金检查序列（P0）

**文件**：`backend/tests/pipeline/test_validation_split.py`
**改动**：在 `_GEO_CHECK_IDS` 和 `_REACTOME_CHECK_IDS` 中插入 `core_data_existence`
（紧随 `main_data_nonempty`），保持序列与 `package.py` 一致。

---

## 十五、需要确认的大改动设计（暂不实施）

> 以下改动涉及架构级变更或较大实现量，记录设计供后续确认。

### 15.1 数据可用性预检工具（中型，建议优先）

**目标**：在 Agent 调用 `run_research_pipeline` 前，自动验证 GSE 的 supplementary
文件可下载。

**设计**：
- 新增 `check_geo_data_availability` Agent 工具
- 输入：GSE accession
- 动作：HEAD 请求 GEO supplementary 文件 URL，检查 HTTP 200
- 输出：`{available: bool, file_url: str, file_size: int, alternative_gses: list}`
- 若不可用，推荐同主题替代数据集（基于 GEO 相关性）

**嵌入位置**：Agent 工具表，在 `run_research_pipeline` 之前调用。

### 15.2 下载失败替代策略 + HIL 机制（大型，需确认）

**目标**：Pipeline 下载失败后不静默降级，而是尝试替代方案或请求人类决策。

**设计**：
1. **替代策略链**（acquisition 阶段）：
   - 策略 1：尝试 GEO supplementary 其他文件格式（如 SOFT 而非 tximport）
   - 策略 2：尝试 SRA 下载原始测序数据
   - 策略 3：尝试 ArrayExpress 镜像
2. **HIL 触发**（所有替代均失败时）：
   - 发出 `user_input_required` 事件，附带失败原因和候选替代数据集
   - 暂停 Pipeline，等待用户/Agent 决策
   - Agent 收到后可调用 `search_geo` 发现替代 GSE，再 resume
3. **降级状态标记**（用户选择"继续 anyway"时）：
   - Pipeline 状态从 `completed` 改为 `degraded`
   - `run_manifest.json` 增加 `degradation_reason` 字段
   - 验证报告增加 `degraded` 状态

**需要确认**：HIL 的 resume 协议已有（`POST /runs/{run_id}/resume`），但
Pipeline Runner 需要支持"下载阶段暂停→等待新参数→继续"的状态机扩展。

### 15.3 series matrix 完整解析器（中型）

**目标**：从 GEO series matrix 文件中解析完整表达矩阵，而非仅提取样本 ID。

**设计**：
- 在 `processing` 阶段新增 `parse_series_matrix` 处理器
- 解析 series matrix 的 `!series_matrix_table_begin`...`!series_matrix_table_end` 块
- 提取表达矩阵（基因 × 样本），写入 main_data.csv
- 保留样本注释行（`!sample_characteristics`）写入 sample_metadata.csv
- 当 tximport/supplementary 文件 404 时，自动回退到 series matrix 解析

**需要确认**：series matrix 的表达值是 log2 归一化后的，需在 field_descriptions
中标注归一化状态。

### 15.4 覆盖率报告工具 + post-pipeline 检查（中型）

**目标**：Pipeline 完成后自动生成数据覆盖率报告。

**设计**：
- 新增 `coverage_report.csv` 产物：列出每个数据库的已覆盖/应覆盖条目数
- 新增 `check_coverage_gate` 验证检查：来源数据库数 < 3 则 warning
- 报告内容嵌入 `run_manifest.json` 的 `coverage` 字段
- Agent 收到 Pipeline 返回后可读取覆盖率，决定是否补充检索

### 15.5 共享基因交叉验证工具（大型，需 LLM 辅助）

**目标**：自动验证候选基因在两个疾病中均有证据。

**设计**：
- 新增 `verify_shared_gene` Agent 工具
- 输入：gene symbol + disease A + disease B
- 动作：并行搜索 "gene AND disease A" 和 "gene AND disease B"
- 输出：`{gene, evidence_a: list, evidence_b: list, is_shared: bool}`
- 此工具依赖 LLM 判断证据相关性，非纯结构化

### 15.6 全文表格提取（大型）

**目标**：从 PMC 全文 XML 中提取表格数据（基因列表、通路信息）。

**设计**：
- 新增 `parse_pmc_fulltext` 处理器
- 输入：PMID（若有 PMC ID）
- 动作：获取 PMC 全文 XML，解析 `<table-wrap>` 元素
- 输出：结构化表格行，写入 literature 相关产物
- 需处理表格嵌套、跨列、图注等复杂情况
