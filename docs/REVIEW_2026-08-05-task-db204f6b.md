# REVIEW — METTL5 胰腺癌任务全流程审查与自主调研（2026-08-05）

> 审查对象：`task_db204f6b-e619-4e0f-9641-931ba2dc4912`
> 任务目标：下载清洗 METTL5 在胰腺癌癌组织与癌旁组织的转录组学差异
> 执行模型：`qwen3.7-max-preview`（live 模式，GEO + PubMed）
> 本文档回答三件事：① 对照 PROBLEM.md 产物是否符合需求；② 为 LLM 提供的工具/skill 是否存在问题；③ 自主调研同主题数据的结论与 BioMed QAgent 的差距。

---

## 1. 任务执行回顾

### 1.1 结果概览

| 项目 | 值 |
| --- | --- |
| 任务状态 | `completed`（第二次 run） |
| 首次 run | `failed`：plan 确认 `user_input_required` 300s 超时（`run_02db6490`） |
| 成功 run | `run_e573c75f`（用户输入"继续"后重跑），5 个 stage 全部 succeeded |
| 数据集 | GSE102238（50 对 PDAC 组织 + 配对癌旁组织，100 样本，Agilent GPL19072） |
| 文献 | PMID 39847131（METTL5/METTL7A/METTL7B 在消化道肿瘤中的表达研究） |
| 产物 | 15 个 artifact，validation `valid`（7,657,861 行检查，0 失败） |
| main_data.csv | 950 MB / 2,552,544 行（全基因组 probe 级长格式） |

### 1.2 关键轨迹

- discovery → acquisition → processing → artifact_build → validation 一次通过，pipeline 用时约 2 分钟；上一轮修复的 GEO 前缀目录规则（`GSE102nnn`）已生效，tximport counts 404 后正确回退到 series_matrix（5.86 MB，200）。
- 样本结构：`Perineural_Invasion_N_tumor/normal` 与 `Absence_of_Perineural_Invasion_N_tumor/normal`，即 50 对 tumor/normal 配对（28 对 PNI+、22 对 PNI-）——**恰好是"癌组织 vs 癌旁组织"的配对设计**，数据集选择与任务目标匹配。
- 两次 run 的 plan 数据集不一致：首次选 `GSE183795`，重跑后选 `GSE102238`（同输入、不同发现结果）。

---

## 2. 对照 PROBLEM.md 的产物符合性审查

### 2.1 评价维度：数据查找完备性 — 部分符合（主要扣分点）

- GEO 数据集选择合理（50 对配对 PDAC，含癌旁组织）。
- **缺陷 1 — 单源单数据集**：仅使用了 GEO 一个表达数据源 + 1 篇文献。PROBLEM.md 核心能力要求"自动查找相关论文、开放数据库、表格、补充材料"、"多源异构数据"。METTL5 单基因分析的最权威来源是 **TCGA-PAAD**（GDC/Xena 通道，178 例肿瘤 RNA-seq，gene symbol 直接可用），Agent 完全未触及。
- **缺陷 2 — 数据集与"基因差异"目标脱节**：GSE102238 是 PNI（神经周围浸润）机制研究芯片，不是 METTL5 研究；其价值在于提供 tumor/normal 配对表达矩阵，但 pipeline 产物停留在 probe 级，无法回答 METTL5 差异（见 §3）。
- 文献仅 1 篇（PMID 39847131），且该文献摘要已给出结论（METTL5 在胰腺癌过表达），说明"文献证据提取"能力未参与最终整合。

### 2.2 评价维度：来源可追溯性 — 符合

产物链完整且相互闭合（`validation failed_count=0`）：

- `source_assets.csv` / `download_log.csv`（tximport 404 → series_matrix 200 完整回退链）/ `source_list.csv` / `source_relations.csv` / `processing_log.csv` 齐全。
- 每个表达行带 `source_id`/`asset_id`/`source_line_number`/`source_column_index`/`source_raw_value` 精确溯源坐标。
- 清洗与处理参数（`processing_log.parameters`）记录完整。

### 2.3 评价维度：清洗整合可靠性 — 不达标（核心缺陷）

- **缺陷 3 — 950 MB / 255 万行主产物不可用**：全基因组 probe 级长格式 CSV 对"METTL5 单基因差异"任务过度冗余，任何下游工具打开即 OOM/卡死。PROBLEM.md 要求"输出格式便于后续分析"。
- **缺陷 4 — probe→gene 映射完全缺失**：`main_data.csv` 的 `gene_id` 为 Agilent probe ID（`A_19_P00315492`），`gene_id_namespace="geo_id_ref"`。**数据集中无法定位 METTL5 的任何行**——清洗后的产物对目标基因分析是盲盒。GEO 平台注释（`GPL19072_052909_D_GEO_20130704.txt.gz`）的所有基因映射列（REFSEQ/GB_ACC/GENE_NAME/ENSEMBL_ID 等）**全部为空**，仅探针序列可下载；probe→gene 无法从 GEO 侧完成。
- `warnings.csv` 仅 1 条 `gene_id_version` 缺失（info 级），对上述核心问题零感知。

### 2.4 评价维度：输出格式可用性 — 不达标

- 22 列 schema、字段描述（`field_descriptions.csv`）规范，但承载内容（probe 级全基因组）不满足"可分析、可复用"。
- `sample_metadata.csv` 100 样本的 tumor/normal 分组信息仅存在于 `treatment` 字段（`Perineural_Invasion_1_tumor`），未结构化出 `sample_group`/`pair_id` 列，下游做配对差异分析需自行解析。

### 2.5 加分项：自动识别缺失/重复/单位不一致 — 部分

- cleaning_report 正确识别 `gene_id_version` 缺失（500,000 行）；无重复、无类型不一致。
- **未识别**：probe 无基因注释（可比作"语义缺失"）、数据集与目标基因的可分析性缺失。

---

## 3. 工具 / skill 问题（导致工作流不顺畅的根因）

### 3.1 P0 — GEO 平台注释缺基因映射，probe 级产物不可用（已实证）

- 现象：`process_geo_series_matrix_expression` 输出 `gene_id_namespace="geo_id_ref"`，无任何 probe→gene 注释步骤。
- 实证（本次调研）：GSE102238 的 25,526 个 probe 与 GPL19072 注释 100% 匹配，但注释的 `GENE_SYMBOL`/`GENE_NAME`/`ENSEMBL_ID` 等列全部为空（仅 SEQUENCE 有值）；**从 GEO 侧无法构建 probe→gene 映射，METTL5 无法定位**。
- 影响：所有 Agilent/定制芯片数据集的单基因分析路径断裂。上一轮发现的"Affymetrix probe ID 需映射"问题在本轮以更严重的形式复现（连注释都没有）。
- 建议：processing 阶段集成平台注释解析（GEO 注释优先；缺失时显式告警"该平台无基因注释，产物仅 probe 级"），或将 `gene_id_namespace=geo_id_ref` 标记为**不可分析**并在 validation gate 拦截。

### 3.2 P1 — 单基因分析未引导优先 TCGA 通道

- Agent 拥有 gdc/xena 能力（databases 列表含 7 个库），但 discovery 仅命中 GEO+PubMed。
- TCGA-PAAD 是"胰腺癌 tumor vs normal + 基因级符号"的最优来源（178 tumor + 4 normal，ENSG 直接可查）；当前 Agent 的 tool prompt 未把"单基因差异分析优先 RNA-seq 基因级矩阵（GDC/Xena）"作为引导。
- 建议：discovery/plan 阶段加入通道推荐规则（单基因分析 → TCGA/Xena 优先；微阵列作为验证/补充）。

### 3.3 P1 — plan 确认 HITL 300s 超时导致首次 run 失败

- `user_input_required`（plan_confirmation）5 分钟无人确认即 `task_failed(timeout)`，整个 run 作废；用户实际在 11 分钟后输入"继续"才推进。
- 建议：plan 确认超时后应保持任务挂起（非失败）或默认批准并打标，避免已投入的 discovery 结果丢失。

### 3.4 P2 — 两次 run 数据集选择不一致（无 vetting 纪律）

- 同输入两次发现结果不同（GSE183795 vs GSE102238），无 `describe_geo` 前置校验（TODO §1.6 已登记未实现）。首次若被批准，可能选中不含 normal 或平台不可分析的数据集。

### 3.5 工作流顺畅度总评

- 二次 run 一次通过、2 分钟完成，说明 Agent 编排与 pipeline 稳定；瓶颈全部在"选择的数据集 → 清洗产物 → 目标基因"这一语义链上。

---

## 4. 自主调研：METTL5 在胰腺癌组织 vs 癌旁组织的转录组学差异

> 目的：以"获取尽可能多的数据并清洗"为参照系，检验 BioMed QAgent 的产出差距。所有数据为本次真实网络获取。

### 4.1 TCGA-PAAD（Xena GDC hub，STAR TPM）

- 数据：`TCGA-PAAD.star_tpm.tsv.gz`（60,660 基因 × 183 样本；178 tumor(01) + 4 solid normal(11) + 1 转移(06)）。
- METTL5（ENSG00000138382.15）：

| 组 | n | mean TPM | median TPM |
| --- | --- | --- | --- |
| 癌组织 | 178 | 4.579 | 4.594 |
| 癌旁组织 | 4 | 4.274 | 4.259 |

- 结论：TCGA-PAAD 中 METTL5 在癌组织仅**轻微上调**（mean 比值 1.07×，log2FC ≈ +0.10），无显著差异；正常样本仅 4 例，统计功效很低，**证据不足以支撑"显著上调"**。
- 清洗要点：列名即 TCGA 条码（第 4 位 01=tumor / 11=normal），无需外部表型文件即可分组；gene 行是带版本 Ensembl ID，可直接匹配目标基因。

### 4.2 GSE102238（50 对配对 PDAC）

- 数据设计（series_matrix 元数据）：50 对 PDAC + 配对癌旁组织，28 对 PNI+ / 22 对 PNI-，平台 GPL19072（Agilent-052909 CBC_lncRNAmRNA_V3）。
- **METTL5 定位失败**：probe 100% 匹配平台注释，但注释无基因列 → 无法提取 METTL5（见 §3.1）。该数据集虽含理想配对设计，在当前工具链下对目标基因不可分析。

### 4.3 文献佐证

- PMID 39847131（TCGA 分析 + qPCR）：作者结论"METTL5 在结肠、肝、食管、胰腺癌中过表达"。
- 与 4.1 的 TCGA-PAAD 直接计算存在张力（作者可能合并多癌种或使用不同归一化）；提示**结论需以可复现的原始数据计算为准**。

### 4.4 自主调研 vs BioMed QAgent 的差距

| 维度 | BioMed QAgent 产物 | 本次自主调研 |
| --- | --- | --- |
| 数据源 | GEO 单数据集 | GEO + TCGA-PAAD（多源） |
| 基因级可用性 | 无（probe 级，无映射） | TCGA-PAAD 直接给出 METTL5 表达 |
| 目标结论 | 无（无法提取 METTL5） | METTL5 在 PAAD 癌组织轻微上调（log2FC≈0.10） |
| 样本配对 | 有（50 对，但未结构化配对字段） | 有（条码自动分组） |

---

## 5. 改进建议（按优先级）

1. **P0** processing 增加平台注释解析：GEO 注释可下载时构建 probe→gene 映射；不可用时在 validation gate 标记 `geo_probe_unmapped` 并生成显式 warning（Agent 可见）。
2. **P0** 主产物体积治理：对 probe 级全基因组长格式，提供按目标基因过滤的瘦身输出或分块产物，避免 950 MB 单文件。
3. **P1** discovery/plan 引导：单基因差异分析优先 GDC/Xena 基因级矩阵；`describe_geo` vetting 落地（TODO §1.6）。
4. **P1** plan 确认超时策略：挂起而非失败，保留已 discovery 结果。
5. **P2** `sample_metadata` 结构化 tumor/normal 分组与配对 ID（供差异分析直接使用）。

## 6. 结论

- **流程层面**：任务完成、验证通过、溯源完整——工程闭环成立。
- **结果层面**：产物对"METTL5 差异"目标**不可分析**（probe 无基因映射），且单源、无 TCGA 对照，与 PROBLEM.md 的"数据查找完备性 / 清洗整合可靠性 / 输出格式可用性"存在实质差距。
- **最有价值的单一修复**：probe→gene 映射（含平台注释不可用时的显式告警），它是把"下载的数据"变成"可分析的数据"的关键一环。
