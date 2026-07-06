# 示例研究查询

本文件展示用户可能输入给 `biomed-data-agent` skill 的典型研究查询。每条查询以自然语言描述研究目标，并列出期望整合的数据维度。skill 会据此选择数据源、加载领域模板（`domain_templates/`）并执行 6 阶段流水线（search → acquire → parse → clean → analyze → export）。

> 这些示例仅作输入参考，非真实实验结论。skill 不得据此编造数据；若某数据源未返回结果，对应记录不会出现在最终 `data.csv` 中。

---

## 示例 1 — 中医药研究：健脾散结方治疗胰腺癌肝转移

```
查找健脾散结方治疗胰腺癌肝转移的相关数据，包括：
- 方中各味中药的活性成分（来自 TCMSP）
- 这些成分的潜在靶点蛋白（来自 SwissTargetPrediction 或文献）
- 胰腺癌肝转移相关基因（来自 GEO 差异表达数据）
- 靶点-疾病基因的 PPI 网络（来自 STRING）
- 富集到的 KEGG 通路
```

**领域判定**：TCM（中医药研究）。加载 `domain_templates/tcm.yaml`。

**预期数据源**：
- `tcmsp_client.py` — 检索健脾散结方中各味中药的活性成分（OB ≥ 30%、DL ≥ 0.18 为筛选阈值）。
- `geo_client.py` — 检索 "pancreatic cancer liver metastasis" 相关 GEO 数据集，解析差异表达基因。
- `string_client.py` — 构建 compound-target 与 disease gene 的 PPI 网络（物种 9606，置信度 0.4）。
- `kegg_client.py` — 对 hub 基因进行 KEGG 通路富集（物种 hsa）。
- `pubmed_client.py` — 补充检索 "Jianpi Sanjie formula pancreatic cancer" 文献，提取支持性证据。

**预期分析**：compound-target network 构建 + pathway enrichment for TCM（见 `references/analysis_recipes.md` 中医药专属配方）。

---

## 示例 2 — 肿瘤学：TP53 在乳腺癌中的表达差异及机制

```
分析 TP53 基因在乳腺癌中的表达差异及其机制：
- GEO 中乳腺癌 vs 正常组织的 TP53 差异表达
- TP53 互作蛋白网络
- 共富集的 GO/KEGG 通路
- 相关 PDB 结构
```

**领域判定**：肿瘤学。加载 `domain_templates/oncology.yaml`。

**预期数据源**：
- `geo_client.py` — 检索 "breast cancer TP53 expression" 数据集，提取 tumor vs normal 差异表达。
- `string_client.py` — 检索 TP53 互作蛋白网络（物种 9606）。
- `kegg_client.py` — 检索 TP53 相关通路（如 hsa04115 p53 signaling pathway）。
- `pdb_client.py` — 检索 TP53 蛋白结构（如 1TUP 等转录因子结构域）。
- `ncbi_client.py` — 补充 TP53 基因摘要与别名信息（db=gene）。

**预期分析**：差异表达分析（BH FDR 校正，|log2fc| > 1 且 adj_p < 0.05）+ GO/KEGG 富集（见 `references/analysis_recipes.md` 肿瘤学专属配方）。

---

## 示例 3 — 基础研究：AKT1 抑制剂相关数据整合

```
整合 AKT1 抑制剂相关数据：
- PubMed 中 AKT1 inhibitor 的最新文献
- 已知 AKT1 抑制剂的化学结构（PubChem/PDB）
- AKT1 上下游信号通路（KEGG）
```

**领域判定**：分子生物学/药理（无专属模板，使用默认配置）。

**预期数据源**：
- `pubmed_client.py` — 检索 "AKT1 inhibitor" 文献，限制近 3 年，提取化合物-靶点关系。
- `pdb_client.py` — 检索 AKT1 与抑制剂共晶结构（如 MK-2206、GSK690693 复合物）。
- `kegg_client.py` — 检索 PI3K-Akt signaling pathway（hsa04151），提取上下游基因。
- `ncbi_client.py` — 检索 AKT1 基因信息（db=gene，含 aliases 与 summary）。
- `string_client.py` — 检索 AKT1 互作蛋白，辅助识别上下游调控因子。

**预期分析**：以数据整合与字段对齐为主，可选 PPI 网络分析识别 hub 基因（degree top 10%）。

---

## 输入建议

- **明确物种**：默认人（9606 / hsa）。若研究其他物种，请在查询中指明。
- **明确分组**：差异表达分析需指明 case vs control（如 "tumor vs normal"）。
- **明确阈值**：如不指定，差异表达采用默认 |log2fc| > 1、adj_p < 0.05（见 `references/analysis_recipes.md`）。
- **模糊容忍**：若目标不清，skill 至多提出 1 个澄清问题，随后按最佳假设推进。
