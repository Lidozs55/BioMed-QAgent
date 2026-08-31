# 正式发布的结构化阻塞报告（本运行未产生任何 Publication）

## 结论
请求的六表闭包（paper_records / experiment_records / activity_value_records /
chart_series / chart_points / supplementary_asset_records）在**两条受治理路由上均被阻塞**，
原因不同且均已用工具证据确认。本目录 CSV 为临时暂存件，未通过验证管线，不得引用为已发布产物。

## 路由 A：动态 profile `literature_experiment_chart.release.v1`（规则指定的唯一可用拓扑）
被两条互斥的 Core 约束夹死：

- 约束 1（gen 0 / 2 / 3 提交被拒）：
  `literature_experiment_chart requires a Core-owned supplementary member asset`
- 约束 2（gen 1 / 4 提交被拒；gen 4 中该 member 已注册为源但 transform **完全未读取**其字节）：
  `Registered transform input must contain UTF-8 text or gzip-compressed UTF-8 text`

即：profile 要求把 supplementary **member** 资产注册为源绑定（gen 5 试图只注册不绑定，被
`$.registered_sources[3].binding_id is not a declared source binding` 拒绝），而每个已注册源都必须
是 UTF-8 文本输入。

但三篇论文的官方补充包**不含任何文本成员**（`preview_core_asset` 成员清单实测）：
| 论文 | 成员数 | 成员类型 |
|---|---|---|
| PMC10408569 | 37 | jpg / gif / 1× PDF（SM6031.pdf，14,130,872 B） |
| PMC5355725 | 20 | 仅 jpg / gif |
| PMC5094958 | 21 | 仅 jpg / gif |

`extract_core_archive` 已正式解包并返回带 OperationResult 的 Core-owned member：
`asset_962bf2fe…`（application/pdf, result_archive_c82c7d66…）、
`asset_38428f9b…`、`asset_a5ceb001…`（application/octet-stream）。
三者均为二进制 → 无法满足约束 2。→ **约束 1 与约束 2 对这三篇输入不可同时成立。**

## 路由 B：静态注册族 `bioactivity_measurement`（registered_bioactivity_* 源）
`validate_dataset_execution` 通过（valid:true, reason_codes:[]），但 `execute_dataset_execution`
对 curated 源的文件解析被拒，三种取值形式各自失败：
- `asset_<64hex>` → `source asset path must be a relative source_assets path`
- `source_assets/paper_chart_evidence/evidence_*.json` → `registered source asset was not found`
- `paper_chart_evidence/evidence_*.json` → `binding 'av_pmc10408569' has no registered asset ID`
- 省略 source_files → `curated sources have no acquisition provider`，并要求
  “task-owned asset id (e.g. an extraction member asset from acquire_core_carrier)”

即该族期望的是**已注册的 bioactivity 载体资产**（或其抽取成员）。本任务的
`paper_chart_evidence` 载体不属于该注册集，而其抽取成员恰为上述二进制文件。→ 路由 B 亦不可闭合。

## 第二项覆盖缺口（即便发布成功也存在）
`extract_registered_paper_chart_evidence` 实测行数（工具返回，非估算）：

| paper | paper_records | experiment_records | activity_value_records | chart_series | chart_points | supplementary |
|---|---|---|---|---|---|---|
| PMC10408569 | 1 | 18 | 84 | 9 | **0** | 1 |
| PMC5355725 | 1 | 80 | 117 | 85 | **0** | 1 |
| PMC5094958 | 1 | 23 | 20 | 9 | **0** | 1 |
| 合计 | 3 | 121 | 221 | 103 | **0** | 3 |

- chart_points = 0：103 条 series 全部被 VLM 判为 `unclear no-points: axis unit missing`
  （PMC5355725 另有 `legend status missing`；`series_s_B_*` 为 `admitted no points and was marked unclear`），
  `pending_review.point_count = 0`、`review_ids = []`。
  → **图表剂量-反应曲线的数值点本次一个都未被接受**，不存在"估算点当精确值"的产物。
- 页面级丢弃：PMC10408569 第 6/7/8/10 页、PMC5094958 第 3 页因
  `experiment protein/assay_type is required` 校验失败被丢弃；PMC10408569 另有 2 个 PDF 页候选
  因 page cap 未渲染 → 表格数值抽取不完整。

## 独立核验（允许来源：RCSB PDB，仅用于验证）
PMC5094958 记录中引用的对接结构已核实存在且与描述一致：
- **2ITY** — "Crystal structure of EGFR kinase domain in complex with Iressa"（gefitinib），
  X-RAY，3.42 Å，Yun et al., Cancer Cell 2007, PMID 17349580。
- **2JIV** — "Crystal structure of EGFR kinase domain T790M mutation in complex with HKI-272"，
  X-RAY，3.5 Å，Yun et al., PNAS 2008, PMID 18227510。

## 需要的具体协助（任一即可解锁发布）
1. **放宽 member 输入闸**：允许 supplementary member 以「仅溯源、非文本」方式注册
   （或为 `europepmc_supplementary_member` 提供 provenance-only 绑定模式），使二进制 member 满足约束 1 而不触发约束 2；或
2. **提供文本类补充资产**：上传/指明期刊侧补充 Excel-CSV，或提供 Core 的 PDF→文本 provider，
   使 SM6031.pdf 能注册为 UTF-8 文本 member；或
3. **授权人工复核通道**：先为 103 条 series 补齐坐标轴单位与图例状态，再重跑
   `extract_registered_paper_chart_evidence`，使 chart_points 能进入 pending review 并被接受
   （否则即使发布，chart_points 仍为空表）。

## 本目录文件（仅含真实、可溯源、已逐字读出的记录；无补全、无推测）
- `paper_records_verified.csv` — 3 篇论文书目；标题/期刊逐字读自 Core 证据载体，
  PMID/DOI 逐字读自注册的全文 XML 载体；PMC5355725 的 publication_date 在载体中为 null（已如实标注）。
- `experiment_records_verified_partial.csv` — 17 条实验记录，逐字读自证据载体可读窗口
  （含页码、Table/Figure 定位、原始图注文本）。
- `activity_values_verified_partial.csv` — 8 条 IC50，逐字读自注册全文 XML 载体：
  PMC10408569 化合物 10d 对 WT/T790M/L858R = 0.097 / 0.280 / 0.051 µM，erlotinib = 0.082 / 0.342 / 0.055 µM；
  PMC5094958 Transtinib 对 H1975 = 34 nM、对 A431 = 62 nM。均为文本精确值，非图表估算。
- `chart_series_pending_review.csv` — 38 条可读到的 series 及其降级原因/复核状态（0 点被接受）。
- `asset_manifest.csv` — 15 个 Core 资产的 id、角色、父级、媒体类型、OperationResult。

未纳入 CSV 的 221 条 activity_value_records 与 103 条 chart_series 中，超出可读窗口的部分
无法通过受治理工具逐字读出（`preview_core_asset` 仅返回 head 文本、无 offset；工作区外的 Core
资产无治理读取通道），因此不做任何补全或推测。
