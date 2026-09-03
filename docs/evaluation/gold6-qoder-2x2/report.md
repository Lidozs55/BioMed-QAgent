# BioMed-QAgent Gold6 — Qoder Flash/Max 离线输出 2×2 横向分析

生成时间（UTC）：见 `report.json.generated_utc` ·只读分析：未控制 Host/task、未建运行、未改 tracked 源码、未用 worktree、未输出秘密。

## 0. 强制声明

1. **这两个离线 Qoder zip 不是正式 BioMed-QAgent Publication**。它们未经过 Publication 字节级验证证据链，本报告的所有测量只是对离线产物的度量，不构成任何采信背书。
2. **历史 Windows 路径不是当前路径**。chat.md 与 methods log 中的 `C:\Users\25943\Documents\Qoder\2026-09-02\{a67d4e61,2c5de5a6}`、`work/raw/**`、`scripts/merge_and_publish.py` 均为生成环境的历史路径，zip 内不存在对应文件。
3. **数据覆盖广不等于可信**。文件数、行数、来源数只是覆盖度量；可信度以可复核证据为准。
4. **缺失指标一律记 unavailable**：原始 payload、提取脚本、每条 QC 声明的确切行过滤器、逐图像素数据在两个 zip 中均不存在。

## 1. 输入与哈希

| 对象 | SHA-256 |
|---|---|
| `data/qoder_flash_gold6_output.zip` | `74317e075e2f702a9a5d24cb85d59e881356fedfe9d721af26f33d07e12c3990` |
| `data/qoder_max_gold6_output.zip` | `10faf91f8994b473f1b47eee91981886a616076ff694b301d3ede007941073bb` |

解压后 30 个文件逐一 SHA-256 见 `analysis-metadata.json.inputs.extracted_file_sha256`。Flash：22 CSV + chat.md（37 MB）；Max：6 CSV + chat.md（5.2 MB）。**文件数不作为优劣判据**，比较以字段级 crosswalk（§4）进行。

## 2. 2×2 轴定义与阈值（可复现）

- **横轴 X = 结构化覆盖/复用性**：x1 模式分解、x2 标识符归一、x3 单位/剂量归一、x4 可复用维表、x5 manifest 完整性、x6 拒绝/排除审计。等权平均。
- **纵轴 Y = 证据可审计性/来源闭环**：y1 溯源列非空、y2 溯源粒度、y3 manifest 哈希可验证、y4 QC 声明可复现、y5 methods log 深度、y6 原始证据留存。等权平均。
- **阈值**：high ≥ 0.66；low < 0.50；0.50–0.66 为 borderline 带；距任一边界 <0.05 标 borderline。**不强行凑象限**。
- 每个指标的打分依据（文件/字段/计数级证据）内嵌于 `report.json.axes`。

## 3. 象限结果（matrix-2x2.csv）

| 侧 | X 覆盖/复用 | X 带 | Y 可审计 | Y 带 | 象限 | borderline |
|---|---|---|---|---|---|---|
| Flash | 0.950 | high | 0.808 | high | **Q1 高覆盖-高可审计** | 否 |
| Max | 0.500 | borderline | 0.758 | high | **borderline-高可审计**（X 处于边界带，不入 Q1/Q2） | 是 |

说明：Max 纵轴本身为 high，但横轴 0.500 恰在 borderline 带内（且距 0.50 边界 0.00），按预注册规则标 borderline、不强行归象限。

## 4. 字段 crosswalk（摘要，完整版在 report.json）

- **事实表**：Flash `egfr_mutant_inhibition_activities.csv`（10,682×109）vs Max `egfr_inhibition_data.csv`（6,439×35）。共享：record_id、variant、化合物、ChEMBL id、activity type、value_nM、cell line、source db、retrieved_date、extraction_method、置信度。Flash 独有：pXC、跨源一致性（423 consistent/310 divergent）、identity resolution、evidence_text、table/row/column 坐标。
- **Flash 独有层**：单剂量筛选表（8,549×103）、非浓度指标表（553）、excluded（190）+ 拒绝候选（845）、补充材料访问日志（473）+ 未解析清单（836）、全语料图件清单（2,295）、5 张参考维表、PubChem AID 清单（794）、置信度规则、字段对齐表。
- **Max 独有优势**：GtoPdb 145 条第三方策展对照源；来源登记表把 2 个失败源（PubChem、BindingDB）作为证据记录；manifest 用完整 MD5 且 5/5 验证通过。
- **剂量-反应**：Flash 实际抽出 7 条 series / 16 个点；Max 6 条曲线全部 `identified_not_digitized`（诚实记录未数字化）。

## 5. 关键统计（逐 CSV 流式统计，全表见 report.json）

| 指标 | Flash 主表 | Max 主表 |
|---|---|---|
| 行×列 | 10,682×109 | 6,439×35 |
| 唯一论文（DOI/PMCID/标题） | 380/78/383 | 563 PMID / 621 title（ChEMBL 文档粒度）|
| 唯一化合物 / ChEMBL id | 4,152 / 3,950 | 214 / 2,621 |
| 唯一细胞系 | 49 | 64 |
| activity type 前列 | IC50 7,961, Kd 1,227, Ki 1,034 | IC50 4,997, Kd 861, Ki 311 |
| 溯源列非空 | 100%（source_db/url/location/method/date）| 100%（db/location/method/date）|
| 溯源唯一粒度 | 10,215 distinct locations | **11** distinct locations |
| value_nM 正数 | 10,682/10,682（0.002–8.3e7 nM）| 6,431/6,439（8 行 unavailable，已注明）|
| 重复行 / 重复 record_id | 0 / 0 | 0 / 0 |

## 6. Manifest 与 QC 声明 vs 实际复核

- **Flash manifest**：rows/bytes/columns 22/22 全对；sha1 为 16 位十六进制截断前缀，21/22 前缀匹配，**自指行（dataset_manifest.csv 自身）sha1 不匹配**（问题 H1）。
- **Max manifest**：rows/bytes/columns/md5 5/5 全部验证通过（不含自身，记 L3）。
- **Flash qc_checks 16 条**：record_id 唯一、value_nM 正数及 min/max、pXC 逐行一致、mutant 5,703、跨源 9,949/423/310、来源计数——全部精确复现。5 条参考生物学中位数仅方向可复现，数值不可（过滤条件未公开，问题 M4；如 gefitinib L858R/T790M 复算 941 vs 声明 845 nM，n=40）。
- **Max S12/S13**：行/列/哈希/溯源非空全部复现；8 行 value_nM 缺失与文档声明的不可换算行一致。

## 7. chat.md 策略比较（不按长度评分）

- **Flash**：以 ChEMBL `assay_variant_mutation` 为锚（11,713 条突变活性）+ 同文档 WT 对照（7,256）；EuropePMC 23 个查询选纸；并发→被 EBI 限流（10054）→串行退避；栅格图件无 OCR→放弃像素数字化、只从数值表聚合曲线；≥6 次实质自纠错（多面板归属、EGFRL858R 连写漏读、未标注 EGFR 行误判、度量列回退错配、跨测定曲线合并、docx 合并单元格重复）；最后一次全量按序重跑。失败/回退证据保留在 access log。
- **Max**：全量下载 58,847 条 CHEMBL203 活性再过滤（5,178 突变+1,622 明显药物 → 6,285）；GtoPdb 145；3 篇标志性 PMC 论文全文；PubChem 504×2→404 与 PMC /bin/ 404 全部作为失败证据记录；自纠错包括非 JSON 响应诊断、括号查询 URL 编码、Windows 编码、QC 抓出列数不一致重建、32 行 GtoPdb 缺主键补 fallback id。
- **共同**：两侧都未做像素级数字化，且都记录了原因与位置——这一点上声明与实际一致。

## 8. 问题清单（high/medium/low，带文件/字段/计数）

| ID | 级别 | 侧 | 文件 | 字段 | 计数 | 问题 |
|---|---|---|---|---|---|---|
| H1 | high | flash | dataset_manifest.csv | sha1 | 1/22 | 自指行 sha1 不匹配（claimed `389e64b2acd77011` vs actual `d57d6e9a…`）|
| H2 | high | both | methods_qc_log.csv / egfr_methods_qc_log.csv | evidence_artifact | flash 57 步 / max 13 步 | 引用的 raw payload 与 scripts/ 不在 zip 内，“可复现”声明离线不可验证 |
| M1 | medium | flash | dataset_manifest.csv | sha1 | 22/22 | SHA-1 截断为 16 hex（64-bit），完整性保证弱 |
| M2 | medium | flash | egfr_mutant_single_dose_screening.csv | header | 1 | `variant_reported` 列名重复（103 列）|
| M3 | medium | flash | egfr_mutant_single_dose_screening.csv | paper_doi/paper_pmcid | 8,479 / 7,782 空 | 筛选表 99.2% 行无直接 DOI，论文链需经 activity→document join |
| M4 | medium | flash | qc_checks.csv | evidence（中位数声明）| 5/16 | 数值不可精确复现，过滤条件 unavailable |
| M5 | medium | max | egfr_inhibition_data.csv | location_in_source | 11 唯一值/6,439 行 | 记录级而非单元格级溯源，6,285 行共享同一说明串 |
| M6 | medium | max | egfr_inhibition_data.csv | value_nM | 8 行 >1e7 nM + 8 行缺失 | 极端值（至 ~933 mM）仅以 reliability=low 保留在主表 |
| L1 | low | flash | supplementary_access_log.csv | 整行 | 117 | 重复行 |
| L2 | low | flash | dataset_manifest.csv | purpose/key_grain | 19 空单元 | manifest 元数据部分为空 |
| L3 | low | max | egfr_manifest.csv | 自身覆盖 | 1 | manifest 不含自身（惯例，如实记录）|
| L4 | low | flash | reference_variant_classification.csv | variant_token | 19/26 | 组合 token 未在 16 行参考表中逐条列出 |

## 9. 校验与自检

- `report.json` 可被 JSON 解析（生成后程序化验证）。
- `matrix-2x2.csv` 与本报告的行数/得分一致（同一生成器产出）。
- `verification.sha256` 覆盖 5 个生成物并附自检结果。
- credential-pattern 扫描：只报告是否命中，不打印匹配内容（结果见 `analysis-metadata.json.verification.credential_scan`）。

## 10. 结论

Flash 以结构化覆盖与复用性取胜（Q1），其可审计性同样为 high 但 manifest 完整性（H1/M1）与离线不可复核的复现声明（H2）是主要短板；Max 落在 X 边界带（borderline-高可审计）：manifest 全验证、失败源证据诚实，但溯源粒度（M5）与主表极端值处理（M6）限制其证据闭环。两套产物都不是正式 Publication，任何采信需以可复核的原始证据为前提。
