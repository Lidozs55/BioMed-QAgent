# 表达谱与多组学数据

覆盖转录组（RNA-seq/微阵列）、单细胞、甲基化、突变、蛋白组、代谢组等组学数据的查找与
获取指导。共同主线：**样本可追溯、分组设计匹配、实体身份明确、批次不被忽视**。

## 1. 表达谱数据类型与源选择

| 数据形态 | 特征 | 适用源 | 备注 |
|---|---|---|---|
| 基因级 RNA-seq 矩阵 | 行=基因（symbol/ENSG），列=样本 | GDC（TCGA 系列）、Xena | **单基因/靶基因分析首选**，无需 probe→gene |
| 微阵列 series_matrix | 行=探针（probe ID），列=样本 | GEO | 需 probe→gene 映射或 probe 级 schema；单位多为 log2 |
| 微阵列/RNA-seq 补充矩阵 | 已解析的宽表 | GEO 补充文件 | 结构变化大，需逐文件确认表头 |
| 配对 tumor/normal | 同一患者双样本 | GEO（优先）、TCGA（normal 很少） | 配对能控制混杂，优先于非配对 |

**差异分析数据要求**：至少两组（tumor vs normal / 处理 vs 对照）且设计匹配；单组数据
只能做该组的表达谱，不能回答差异问题（见 `strategy`）。

## 2. 实体身份：基因 vs 探针

- 基因级（GDC/Xena/部分 GEO 补充矩阵）：`gene_id` 直接是 gene symbol 或 ENSG，构建后
  namespace 为 `ensembl_gene`/`gene_symbol`，可直接过滤目标基因。
- 探针级（GEO series_matrix）：`gene_id` 是 probe ID，namespace 为 `geo_probe`。
  两个出路：
  1. **probe→gene 映射**：需 GPL 平台注释，通过
     `mapping_files={"<binding_id>": "<GPL 注释相对路径>"}` 显式声明（机制与后果见 §3）。
     很多平台注释缺少基因列，如实告警，不要伪装成基因级产物；
  2. **probe 级发布**：schema 用 `gene_expression.probe_long.v1`、validation profile 用
     `gene_expression.probe_release.v1`（probe 级可发布，覆盖率为 warning 不阻断）。
- 基因 symbol↔ENSG 可用服务端内置映射（canonicalizer 的 `gene_symbol_map`），
  未命中的 symbol 保留原 namespace，不丢弃。

## 3. AdapterParams 声明（GEO 探针/矩阵构建）

geo.expression.v1 绑定必须声明 `parameters`，且字段须与服务端 normalization profile 一致：

- `format`：`tximport_counts` / `series_matrix` / `supplementary_matrix`
- `value_semantics`：在 `expression_value` / `normalized_expression` / `raw_count` 中选
- `value_scale`：`linear` / `log2` / `log10` / `unknown`（诚实声明，不猜测）
- `expression_unit`：**必须属于 profile 允许集**（如 `log2_expression`、`tpm_unstranded`、
  `fpkm`、`estimated_count`、`expression_value` 等）——`validate_dataset_execution` 会
  对未知单位返回 `unknown_unit` reason code 并列出允许值，按提示修正，不要带病构建。
- `platform_ids`：声明 GPL 平台号（`^GPL\d+$`），供平台审计与 probe 映射使用。

每个不同 GSE 必须使用独立的 `DatasetExecutionSpec` 和 `execute_dataset_execution` 调用，不跨
GSE 拼接行。series matrix 的 `!Sample_*` 字段会自动发布为 `sample_metadata.csv`；若
表达主文件是 tximport/补充矩阵，则把同一 GSE 的 family SOFT 通过
`metadata_files={"binding_id": "<SOFT 相对路径>"}` 传给构建工具。tumor/normal 分组
与 pairing 仅依据显式 metadata；不得从 GSM 顺序、标题相似度或同一 GSE 猜测配对。

### gene 级绑定：probe→gene 映射必须经 `mapping_files` 声明

当 schema 是 gene 级（`gene_expression.long.v1` / `gene_sample_measurement`）而源是
GEO 探针（`geo_probe`）时，**必须在 `execute_dataset_execution` 里为同一个 binding 提供
probe→gene 平台注释**：

```text
mapping_files = { "<binding_id>": "<GPL 注释相对路径>" }
```

- 键 `binding_id` 必须与 spec 里该源绑定的名称一致（与 `source_files` /
  `metadata_files` 用同一把键；`assertKnownBindings` 会拒绝未知键）。
- 值是**单独注册**的注释/映射资产（GPL 平台注释、内置 probe-map、或提供 probe→gene
  的补充注解），不能重复塞进 `source_files`。
- 该映射按 `binding_id` 关联到绑定，在 canonicalize 阶段做 probe→gene 折叠并计算
  覆盖率；**gene-required 构建**要求覆盖率 1.0 且主表无 residual `geo_probe` 行
  （validation profile 的 `probe_coverage_required_gene_level`，见 `probe-mapping`）——
  未命中映射的 probe 保持 `geo_probe` 命名空间，不会在 canonicalize 阶段被本行级删除，
  而是作为 gene 级 validation 的失败项被拒。
- **漏掉这份 `mapping_files` 的典型后果**：`validate` 可能通过（因为 gene schema 与
  `geo.expression.v1` 适配器在字面上兼容），但执行时该绑定因 gene-required 覆盖率/
  residual gate 未达标而被拒；若所有绑定都被拒，结果 `status: "no_data"`、
  `reason_codes: ["no_primary_data"]`，`user_summary` 提示 “Every source binding was
  rejected”。此时不是重跑同一参数，而是要补上 probe→gene 映射（或改走 gene 级源，
  或改用 probe 级 schema 发布）。注意：单绑定的精确拒绝码与 `not_attempted` 标注当前
  以 Python 侧为完整实现，TS executor 的按绑定守卫仍在接线中——因此以 validation
  profile 的 coverage/residual 检查为准，不要臆断具体 reason code。

## 4. 构建前 vetting

对每个候选 GSE/GDC 数据集：

1. `describe_geo` / `describe_gdc` 检查样本构成：样本数、tumor/normal 分组、平台类型
   （microarray vs RNA-seq）与课题目标相符；
2. 下载后用 `read_file_head` 确认表头结构（基因/探针列 + 样本列），不要盲目构建；
3. 探针平台必须走 §2 的两个出路之一，否则构建会因 gene-required gate 拒绝。

### 4.1 选样完备性：以**数据**验证分组，不以论文/标题验题为依据

查找完备性是数据质量的第一维。选样不是"查到了文献引用的数据集"即可，而是所选数据集
的**分组在设计上由数据本身即可独立验证**（tumor/normal 标签能落到真实样本 characteristics，
而不是靠数据集标题或论文描述推断）。

- **一律从 series matrix / SOFT 的 `!Sample_characteristics_*` 读取分组**，用
  `read_file_head` / `describe_geo` 看原始分组文本，再据此确认该集是否真的含目标两组；
  不要把 GEO 系列标题、GSE 页面摘要或论文中提到的分组当成数据证据；
- **选样验收口径**：每个包含病例/对照要求的 GSE，至少（a）中性词样本能归入 tumor 或
  normal 任一组（分组覆盖率/一致性），（b）两组样本数都要够做差异（一般各 ≥ 3，越多越稳），
  （c）分组依据与课题"breast tumor vs normal"语义一致。满足不了就换数据，不要用
  "含该疾病即可"的低标准凑数；
- **平台上的一致性**：优先选择**同一 GPL** 的多系列以便直接合并；跨平台（不同 GPL）
  无可信 rescale 手段（GEO 无共识的跨平台归一化），应避免在 gene 级上硬拼异构平台，
  或在输出里明确标注平台的 `platform_id` 字段并在元数据中留下是否同平台的判定；
- **完备性自检**：列出所有候选 GSE，逐一给出 (样本数, 每组样本数, 平台, 分组文本来源)，
  明确哪些因缺组/组太小/平台不合被排除，以及为何保留最终所选；这个筛选过程本身就是
  查找完备性的可追溯证据，写进 `runs-log.md`。

## 5. 其它组学要点

- **甲基化/突变/临床**（GDC）：按 data_category/data_type/workflow_type 精确过滤，
  不要把不同 data_type 的文件混进同一构建；
- **单细胞**：区分患者/样本/细胞层级；差异分析的推断单位通常是患者/样本而非细胞；
  数据量大、格式复杂，获取后需确认是否在 V2 能力范围内；
- **蛋白组/代谢组**：确认定量方式（label-free/TMT、非靶/靶向）与 ID 命名空间，
  构建前明确 schema 是否覆盖；
- **批次与多重性**：记录批次/文库/芯片信息；多重检验控制在下游分析进行，数据层只需
  保留必要的设计矩阵信息，不做统计推断。

## 6. 失败处理

- `no_data` 且 rejected.csv 显示 `unknown_unit`/`unknown_semantics`：修正 AdapterParams
  后重新 `validate_dataset_execution`，不要用相同参数重跑；
- `no_data` / `no_primary_data`（probe 未折叠 / gene-required coverage 未达标，机制见
  §3）：补上 `mapping_files[binding_id]` 的 probe→gene 注释后重试，或改走 gene 级源
  （GDC/Xena），或改用 probe 级 schema 发布；不要沿用缺失映射的参数重跑；
- 表达块为空（只有样本元数据）：换 experiment_type 含 "Expression profiling by array"
  的 microarray 数据集，或改走 GDC/Xena 基因级；
- 2-3 次调整仍无合适数据：停止重试，如实汇报已尝试方案与失败原因。
