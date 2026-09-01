# 清洗、规范化与可分析性判定

构建前评估数据可分析性、构建结果异常时定位问题。BioMedQAgent 的清洗由 V2 内核
（canonicalizer → compatibility gate → integrator）执行，本主题指导**如何判断产物是否
可分析、如何解读失败原因**，不自行拼装 CSV。

## 1. 实体身份与映射

- **gene symbol↔ENSG**：canonicalizer 内置本地映射表；命中转 `ensembl_gene` 并记
  normalization_log，未命中保留原 namespace，不丢弃；
- **probe→gene**：需 GPL 平台注释；有注释且映射成功 → 转 `gene_symbol`/`ensembl_gene`；
  无注释或映射失败 → 保留 `geo_probe`（诚实标注），gene-required 构建会拒绝该 binding
  （`REASON_PROBE_MAPPING_UNAVAILABLE_REQUIRED_GENE_LEVEL`）；
- **版本保留**：ENSG 带版本后缀时拆出 `gene_id_version`，不丢失；
- namespace 权威性来自 adapter 声明（`gene_id_namespace_declared`），**不按 ID 形状猜测**。
- 字段对齐先调用 `preflight_cleaning_rules`：Core 重新按注册 Schema 生成候选并稳定排序；唯一相似候选没有注册语义规则时仍保持 proposed，只有注册规则可自动应用，歧义项进入 HIL。

## 2. 单位/语义/尺度（profile 一致）

canonicalizer 按 normalization profile 对每行做 fail-closed 校验，拒绝即写入
`<binding>_rejected.csv`：

- `expression_unit` 必须在 profile `allowed_units`（如 `log2_expression`、`tpm_unstranded`、
  `fpkm`、`estimated_count`、`expression_value`）——否则 reason_code=`unknown_unit`；
- `value_semantics` 必须在 `expression_value`/`normalized_expression`/`raw_count`——
  否则 `unknown_semantics`；
- `value_scale` 必须是 `linear`/`log2`/`log10`/`unknown`——诚实声明，**不猜测**；
- 这些在 spec 预检阶段就会拦截（`validate_dataset_execution` 返回 reason_code 并列出
  允许值），不要带病构建。

## 3. 缺失、重复与异常（保守口径）

- **原始数据不改写**：下载文件只读；修正/排除/转换发生在派生副本并可追溯；
- **重复**：区分完全重复、主键重复、重复测量、生物/技术重复；主键冲突无源优先级时
  保留冲突组或整组隔离，不默认取首行/末行；
- **缺失**：区分结构性不适用/未测/失访/意外缺失/未知；结构性不适用不计入质量问题计数；
- **异常**：先区分错误/流程伪影/真实极端值；只有违反已定义规则的记录进入异常计数；
- 无法裁定的问题保留原值并标记，不影响已可靠部分的推进。

## 4. 可分析性判定（"能不能回答这个问题"）

构建成功后核对产物是否满足目标分析：

1. **分组充分性**：差异分析需要 ≥2 组；检查 `sample_metadata`/`sample_group` 中
   tumor/normal（或对照）分组与配对 ID 是否结构化存在；
2. **实体可达性**：目标基因能否在产物中直接过滤（gene 级）；probe 级产物需明确
   只能做 probe 层面分析或需下游映射；
3. **行/列语义**：`row_granularity` 与用户问题匹配（gene×sample 才能做基因差异）；
4. **单组/单样本产物**：若最终只有一组/一个样本，明确告诉用户"该产物不能回答组间
   差异"，并给出可行替代（换数据集 / 追加正常组）。

## 5. 失败诊断路径

- 读 `rejected.csv` 的 `reason_code` 列（`unknown_unit`/`unknown_semantics`/
  `unauthorized_namespace`/`non_finite_value` 等）定位拒绝原因；
- `no_data` 时检查：是 spec 参数问题（修正 AdapterParams）还是数据本身问题（换数据集）；
- 不要在相同参数下重试；2-3 次调整无果即止损汇报。

## 5.1 未通过 Core 校验的候选数据 → 非正规发布途径（仅参考、可溯源、不进入正式链）

- Core 自动校验（如 CSV 决定性行必须为首行表头）是**合理拦截**，不是需要绕过的缺陷：
  禁止为满足校验而把已通过的**另一个需求/表型**的资产复制过来冒充本表型数据；
- 未能通过自动校验的**真实数据**按下列情况分流（非正规发布途径 = quarantine 旁路，
  仅参考、可溯源、不进入正式链）：
  1. **格式/清洗问题可修**：优先走**受治理导入通道**（user upload → task-owned Core 资产 →
     registered parser / HIL）清洗补全后**重试正式流程**；
  2. **结构不完整、自动校验原则性不会通过**（如缺表头、混合格式包）：标记
     "手动补全/结构不完整"，经 quarantine 作**可溯源参考**，不得进入正式发布；
  3. **来源无法证实**：仅经 quarantine 参考，不得进入正式发布；
- 受治理导入通道当前不可用或无法落地时，如实上报 blocker / 所需用户支持，
  不得以复制冒充集成。

## 6. 边界

- 统计检验、可视化、p 值/效应量等由用户或下游分析完成，数据层只保证"结构化、可溯源、
  分组与实体明确"；
- 不要把清洗产物当成分析结论本身。
