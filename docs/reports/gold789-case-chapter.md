以下展开第 7–9 条案例（gold7 / gold8 / gold9）。三者均在同一冻结代码提交（`e8d03589`）、单一 Host、同一评测协议下完成，是该协议下首批三例连续达成"正式发布终态"的案例，分别代表三类典型难点：动态多表拓扑闭环（gold7）、外部来源失效下的部分维度发布与结构化阻断（gold8）、多源多表整合与跨源证据（gold9）。

### 5.1 案例评测协议与总览

为保证结果可复核，三个案例遵循同一评测协议：Agent 的输入只有案例 `TOPIC.txt` 原文（数百字节的研究需求描述，不含任何参考答案或人工整理数据）；代码冻结在单一提交；由一个有界外部监督程序（`scripts/gold-formal-supervisor.mjs`）驱动任务、逐页持久化事件流、对发布产物逐件重新下载并重算字节与 SHA-256，最终给出终态分类（`succeeded_publication` / `blocked_no_publication` / `failed_or_cancelled`）。评测模型为 DeepSeek-V4-Flash（上下文窗口 1,000,000、最大输出 32,768、温度 0.2）——选择一个非 Qwen 的国产模型是为了验证系统的模型无关性；此前 gold8 亦在同链路上取得过 Qwen3.8-27B 的同类正式发布（`pub_dili_benchmark_faers_counts_852d6a0a4bcd531c`，2026-08-28）。

| 案例 | 研究主题 | 正式发布（Publication） | 交付物 | 校验 | 上下文峰值 |
| --- | --- | --- | --- | --- | --- |
| gold7 | 阿尔茨海默 GWAS 风险位点多源整合 | `pub_ad_gwas_risk_loci_integration_b51fdc25…` | study / locus / variant_gene_mapping 三表 + schema + provenance + 评估 | 逐件 SHA-256 通过 | 766,326 / 1M（76.6%） |
| gold8 | DILI 风险药物证据整合 | `pub_REQ_DILI_FAERS_COUNTS_fd56dd6f…` | faers_reaction_counts 主表 + schema + provenance + 评估（4 件） | 逐件 SHA-256 通过 | 380,287 / 1M（38.0%） |
| gold9 | 原发性免疫缺陷基因-疾病-表型整合 | `pub_iei_pid_v1_bafb191e…` | gene / disease / gene_disease / crosswalk 四表 + schema + provenance + 评估（7 件） | 逐件 SHA-256 通过；结构校验 67/67 | 750,739 / 1M（75.1%） |

三例全程零 shell/网络绕路、零权限暂停（权限面的停审-拒绝-恢复链路在更早轮次已单独验证）；上下文峰值均远低于窗口，未触发任何压缩。全部事件流、发布清单与重验记录保留在 `data/gold-runs/` 评测证据目录中（gold7：`e8d03589-gold7-dsflash-r1`；gold8：`…-gold8-dsflash-r1/-r2`；gold9：`…-gold9-dsflash-r1…r5`，其中 gold9 另有可直接引用的证据包 `evidence-pack/`，含输入、输出、验证与 README）。

### 5.2 案例 gold7：阿尔茨海默 GWAS 风险位点整合（动态 Family 全链闭环）

**输入（TOPIC 摘要）**：以 Bellenguez 2022（PMID 35379992）等来源整合 AD GWAS 风险位点，输出研究、位点、变异-基因映射三张表，要求补充材料 75 位点表解析与 GRCh38 坐标核验。

**过程要点**：Agent 首步调用路线检查（`inspect_dataset_execution_routes`），确认静态注册表无任何 family 能表达该三表拓扑后选择动态 Family 路线；随后经治理工具完成采集——GWAS Catalog REST 返回 GCST90027158 的 89 条全基因组显著关联；Europe PMC 官方补充通道取得 27,656,649 字节归档（SHA-256 逐字节登记后作为任务资产），Core 提取器将 XLSX 成员逐工作表转为 provenance 绑定的 UTF-8 CSV 资产；dbSNP 工具核验 GRCh38 坐标。正式发布前，动态预检拒绝了 11 次规格提交（角色映射、输入闭包、外键策略、字段形状等），每次均给出可操作的错误信息；Agent 修正后发布 v1，又自行发现 v1 的 GWAS 统计列未填充与解析缺陷，发布修正版 v2 并以替代关系保留 v1 历史——这一"自检-修正-换版"行为正是 3.10 节反馈修正闭环的实测样本。

**输出结构（v2，`study.csv` 1 行、`locus.csv` 88 行、`variant_gene_mapping.csv` 127 行）**：`locus.csv` 24 列，含双坐标基准对照（`position_grch38` 与补充材料 `position_grch38_supp`）、分层统计（`stage1/stage2/stage12` 的 OR 与 p 值）、异质性（`i2`/`phet`）与来源标记（`in_supp_75_loci`、`dbsnp_variant_type`）。真实样例行：

| 字段 | 值 |
| --- | --- |
| variant_rsid / risk_allele | rs141749679 / C |
| position_grch38 / _supp | 109345810 / 109345810 |
| p_value / odds_ratio / CI | 8e-9 / 1.38 / [1.24-1.54] |
| nearest_gene / known_locus | SORT1 / New |
| stage1_or · stage2_or | 1.37 (1.19-1.57) · 1.41 (1.17-1.7) |
| i2 / phet / in_supp_75_loci | 0 / 0.9019 / yes |

**来源清单**：GWAS Catalog 关联记录（GCST90027158）、Bellenguez 2022 补充材料（Europe PMC 官方归档，字节级摘要入链）、dbSNP RefSNP 记录。**如实局限**（终答自报）：正式绑定范围为单研究（GCST90027158）而非全部 AD 研究；GWAS Catalog 关联对象的 `authorReportedGenes` 为空，故映射表基因全部来自补充材料；样本量元数据存在于原始缓存但未作为正式输入绑定。发布范围窄于参考全集，但每一行均可溯源、可重验。

### 5.3 案例 gold8：DILI 风险药物证据整合（来源失效下的正确终态）

**输入（TOPIC 摘要）**：针对 DILIrank 2.0 vMost 药物整合三类证据——DILIrank 标签注释、LiverTox 专论、openFDA FAERS 肝毒性 PT 报告计数，约 50 种代表药、四表交付。

**关键难点与行为**：DILIrank 2.0 官方文件（`fda.gov/media/113052/download`）持续 404，LiverTox 无药物级结构化导出。系统的处理展示了赛题"自动识别缺失数据……完成修正或寻求人类建议"加分项的完整链路：第一轮运行在发现阶段确认官方来源不可达后**未编造任何行**，以工作区暂存 + 结构化阻断收尾，明确请求"提供官方文件或注册 Core 资产"；第二轮定向续跑把可达维度（FAERS 计数）正式化——9 个已验证药物各经一条 `openfda.files.v1` Core 采集绑定**重新获取**（发现阶段的查询输出不被当作正式载体），以动态 Family 发布。

**输出结构**：`faers_reaction_counts.csv` 68 行 × 5 列（`drug_name, reaction_pt, report_count, retrieval_method, source_url`）。请求的 9 药 × 8 肝毒性 PT = 72 行中，4 行因官方聚合响应确无该 PT 词条而**未零填充**，逐条列出（如 azathioprine–HEPATOCELLULAR INJURY）；其余 68 行与发现阶段 openFDA 计数逐条一致（如 acetaminophen ACUTE HEPATIC FAILURE = 3297）。校验 16/16 通过（0 坏行、0 重复主键）、provenance 9/9 载体满足、`product_status=publishable`。每行 `source_url` 直接给出可复核的官方 API 查询串。

**诚实边界**：DILIrank vMost 名册与 LiverTox 维度保持"未验证/阻断"状态，仅存在于明确标注 provisional 的工作区文件，不进入正式发布；FAERS 计数语义为 MedDRA PT 报告次数（非去重患者、非因果证据），已在终答与 provenance 中注明。"部分维度正式发布 + 不可达维度结构化阻断"是该上游条件下唯一诚实的完成形态。

### 5.4 案例 gold9：原发性免疫缺陷基因-疾病整合（多源四表与跨源证据）

**输入（TOPIC 摘要）**：从 Orphadata 筛选免疫缺陷相关罕见病及基因关联，经 HGNC 归一为现行符号，整合 ClinVar 致病性变异计数与 ClinGen 有效性分类，输出基因、疾病、基因-疾病关联、跨源证据四表，以 `hgnc_symbol`/`orphacode` 关联，ClinGen Refuted/Disputed 冲突单独标记。

**过程要点**：Orphadata 两个大型 XML（en_product1 54,026,799 字节、en_product6 22,612,034 字节）经任务内容缓存命中（先前由同一官方端点获取并逐字节验证，摘要一致），零网络重取；HGNC、ClinVar、ClinGen 为本 run 真实网络采集。前两轮 run 因基础设施缺陷（浏览器渲染超大文件导致资源耗尽、会话取消路径无界等待）中断——两个缺陷均被定位并修复（渲染资源闸门、强制取消），续测一次通过，本身即 3.10/2.2 节"可恢复性"目标的工程实证。

**输出结构（四表）**：

| 表 | 行数 | 字段（语义） |
| --- | --- | --- |
| `gene_records.csv` | 213 | hgnc_symbol、hgnc_id、gene_name、alias_symbols、previous_symbols、locus_group、locus_type、status（HGNC 归一后的现行身份） |
| `disease_records.csv` | 269 | orphacode、disease_name、synonyms、disease_type、disorder_group |
| `gene_disease_records.csv` | 241 | orphacode、hgnc_symbol、orphanet_gene_symbol、gene_name、association_type、source（主表） |
| `gene_evidence_crosswalk.csv` | 241 | hgnc_symbol、orphacode、clingen_classification（+日期/疾病标签）、clinvar_count（+查询串）、conflict_flag、conflict_detail |

关联样例（`gene_disease_records`）：`567, TBX1, TBX1, "T-box transcription factor 1", "Disease-causing germline mutation(s) in; Role in the phenotype of", Orphanet en_product6`。结构校验 67/67 通过（候选引用闭合、逐表 schema 契约、主键唯一、外键关系、provenance 覆盖等），`product_status=publishable`。

**来源清单（五个正式载体，provenance 逐条登记 receipt、请求身份摘要与官方端点快照）**：en_product1（54,026,799 B，`df8d562a…`）、en_product6（22,612,034 B，`f1c039f7…`）、HGNC current（16,948,051 B）、ClinVar gene-esearch（460 B）、ClinGen current（1,119,208 B）。

**诚实边界**：本例 crosswalk 的 ClinVar/ClinGen 数值列在发布表中为空——两个载体虽已获取并绑定，但数据变换未将值落入交叉表（ClinVar 载体亦仅绑定单基因 BTK）；结构校验不检查可选列填充率，因此照常通过。团队复核后已将此偏差记入案例档案，并把"源维度行级填充率检查"列为 ProductAssessment 的改进项。报告如实呈现该边界：gold9 闭合的是 Orphadata×HGNC 两源四表与完整发布/溯源/验证链，而非 TOPIC 全部四源的数值级整合。

### 5.5 可调用测试 API 与可交互前端

系统以 HTTP API 与 Web 前端同时暴露全部能力，评审可不经代码直接复现上述案例：

| 端点 | 方法 | 作用 |
| --- | --- | --- |
| `/api/v1/health` | GET | Host/运行时/Core 健康自检 |
| `/api/v1/tasks` | POST / GET | 创建任务（自然语言输入即 Body）/ 列出任务 |
| `/api/v1/tasks/{task_id}` | GET | 任务快照：状态、runs、artifact 数、当前发布指针 |
| `/api/v1/tasks/{task_id}/runs` | POST | 在既有任务上发起新 run（续跑） |
| `…/runs/{run_id}/cancel` · `…/resume` | POST | 取消 / 恢复（含权限与 HIL 恢复） |
| `…/runs/{run_id}/permissions/{request_id}` | POST | 权限裁决（approve/deny，绑定证据摘要） |
| `/api/v1/tasks/{task_id}/compact` | POST | 手动上下文压缩 |
| `/api/v1/publications/{pub_id}/artifacts/…` | GET | 发布物与逐 artifact 下载（消费时重验 SHA-256） |
| `/api/v1/settings` · `/api/v1/model-registry/*` | GET/PUT/POST | 模型供应商/模型注册、参数与激活（不锁定任何模型） |
| `/api/v1/ws` | WebSocket | 事件流实时订阅（工具调用、验证、发布事件） |

前端（React 19 + Vite + Tailwind）提供任务列表与创建、run 事件时间线、发布物查看（按当前发布指针渲染并重验摘要）、HIL 结构化问卷（字段映射/单位/发布确认等场景的 approve/reject/correct）、模型设置页。开发入口 `pnpm dev`（Host 8000 + 前端中间件），生产入口 `pnpm start`。三案例的完整复现命令（supervisor 调用模板、缓存种子方法、单实例约束）已在仓库 `docs/plans/` 与 `docs/gold-formal-rerun.md` 固化。

### 5.6 结构化输出样例与字段说明

以 gold9 跨源证据交叉表为例（真实发布行）：

```csv
hgnc_symbol,orphacode,clingen_classification,clingen_classification_date,clingen_disease_label,clinvar_count,clinvar_query,conflict_flag,conflict_detail
TBX1,567,,,,,,NONE,
```

字段语义：`clingen_classification` 为 ClinGen 基因-疾病有效性分类（如 Definite/Strong/Limited；Refuted/Disputed 出现时触发冲突逻辑）；`clinvar_count` 为 ClinVar 该基因致病记录计数，`clinvar_query` 保留实际查询串以供复核；`conflict_flag` 取 `NONE` 或 `CONFLICT_CLINGEN_REFUTED_OR_DISPUTED_WITH_ORPHANET_ASSOCIATION`，`conflict_detail` 列出冲突的 ClinGen 疾病标签。空值即"来源未覆盖该单元格"，系统不以零或推断填充。

来源凭据样例（`provenance.json` 中 `input_asset_receipts` 的第一条，逐字段）：

```json
{ "asset_id": "asset_df8d562a0c6011af…c0962bbb", "role": "in_0",
  "sha256": "df8d562a0c6011af36a74eb4000ce81ca7d723e8031010819fb71727c0962bbb",
  "size_bytes": 54026799, "locator_ref": "asset_df8d562a0c60…c0962bbb" }
```

即：输入不是"一个下载文件"，而是（任务、来源、字节摘要、采集实现身份）共同绑定的证据对象。发布清单（`dataset_manifest.json`）对每个 artifact 登记相对路径、媒体类型、字节数与 SHA-256（如 gold8 主表 13,558 B / `08e9db4f…`，清单文件摘要 `1ec9f4ab…`）；消费端每次读取都重算摘要，文件被改动即拒绝展示。

### 5.7 案例结论对照赛题评价标准

| 评价维度 | 三案例证据 | 尚存边界 |
| --- | --- | --- |
| 数据查找完备性 | 路线检查 + 多库治理采集（GWAS Catalog/Europe PMC/dbSNP、openFDA、Orphadata/HGNC/ClinVar/ClinGen）；不可达来源显式阻断而非静默缺失 | 全局 QueryPlan/SourceCoverage 证据尚未产品化（3.3 节），不能宣称"全网查全" |
| 来源可追溯性 | 全部正式行携带 source_url/locator；输入载体字节级摘要入链；发布产物消费时重验 | gold9 跨源数值列未落表（已披露），证据维度整合深度依赖载体绑定完整性 |
| 清洗整合可靠性 | 动态预检 11 次结构化拒绝迭代；v1→v2 自检换版；68/72 行真实缺失逐条列出；四表主外键闭合 67/67 | 冲突合并为确定性策略（first source wins），稳定但不等于科学裁真（3.7 节） |
| 输出格式可用性 | 三例均交付 CSV+Schema+Provenance+Validation+Manifest 的不可变发布，逐件 SHA-256 经第三方监督重验 | 图表抽取到正式发布的链路仍在接线中（3.5.3 节），当前以 preview 呈现 |
