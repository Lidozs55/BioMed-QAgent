
# BioMed-QAgent 架构 — 结果、验证、置信度与溯源

> 本文是 [docs/ARCHITECTURE.md](../ARCHITECTURE.md) 的拆分章节（原 §9-§13），
> 章节编号与主文件保持一致。

---

## 9. 运行状态、数据结果与发布状态

系统使用五个边界清晰的概念，禁止一个状态字段同时回答执行、数据、产品完整性、验证和发布问题。

### 9.1 执行、结果、评估、验证与发布

| 概念 | 回答问题 | 典型值 |
| --- | --- | --- |
| `RunStatus` | 执行是否排队、运行、完成、失败或取消 | `QUEUED/RUNNING/COMPLETED/FAILED/CANCELLED` |
| `OperationResult` | 某个确定性步骤提交了什么可验证结果 | committed result manifest + receipts |
| `ProductAssessment` | requirement 的产品完整性和可发布性 | `publishable/validated/incomplete` |
| `ValidationResult` | 某个 Manifest digest 是否通过 Profile | `PASSED/FAILED` |
| `DatasetPublication` | 哪个不可变版本已正式提升 | `publication_id + supersedes` |

Parser 崩溃、文件损坏和内部异常对应 `RunStatus=FAILED`；用户取消对应
`RunStatus=CANCELLED`。这些不是数据业务结果。

### 9.2 OperationResult 与 ProductAssessment

`OperationResult` 是 task/run/requirement-scoped 的确定性 checkpoint；它记录输入、参数、
实现和输出 digest、文件 receipt 及依赖闭包。它不等于产品完成，也不拥有独立生命周期。
`ProductAssessment` 根据 family 需求评估 schema、relations、identifiers、provenance、
confidence 和 reproducibility；只有可发布评估与通过的 ValidationResult 才可进入 Publisher。
规格拒绝、无数据、部分来源失败或取消由 typed execution result/error、RunSummary 和事件表达，
不再投影为另一个业务状态机。

### 9.3 ValidationResult 与 DatasetPublication

- `ValidationResult` 回答某个 Manifest digest 是否通过指定 Profile；
- `DatasetPublication` 回答哪个不可变版本已经正式提升；
- Task / Session 只保存 `current_publication_id`。

一个 requirement 可以产生 ValidationResult 但不发布；只有与当前 Manifest digest 对应的
通过状态 ValidationResult 才能进入原子发布。

### 9.4 NO_DATA 是正式业务结果

- 无主数据不再必然触发内部失败，`RunStatus` 仍可为 `COMPLETED`；
- 前端不通过错误字符串猜测 `NO_DATA`；
- 无数据时可以交付 schema、provenance 和 audit_report；
- 不创建空主表或伪造测量记录；
- 用户始终收到服务端生成的明确 RunSummary。

### 9.5 禁止 metadata-only 占位主表

主表无合法记录时返回 typed `no_data` 且不产生 Publication；样本元数据保存为
`supporting_dataset`；GEO series matrix 内嵌 metadata 与显式 family SOFT 共用
`geo.sample-group.v1` 提取器。Validation 不允许 warning 或特殊字段豁免目标数据
不存在；空主表不发布为 `SUCCEEDED`；可以发布归入 `audit_report` 的来源搜索、
拒绝和诊断报告，但不能伪装成主数据集成功。

### 9.6 不通过 Artifact 数量判断成功

系统由 RunStatus、OperationResult、ProductAssessment、ValidationResult 和 Publication 共同表达事实，
不靠 Artifact 数量，也不靠前端解析错误文本。

> 决策依据：ADR-010、ADR-011、ADR §21.4/§21.9（踩坑）。

---

## 10. Validation Profile

### 10.1 Profile 驱动验证

验证由数据集 Profile 驱动：不同数据族使用不同的版本化 Profile，不共享单一通用
Validator。

Profile 可以组合以下类型的具体规则。Manifest 2.0 的 family 可先复用
ADR-032 的通用多表结构/关系 gate，再叠加 family profile；通用 gate 不解释
measurement vocabulary、单位转换等科学语义。

- 文件、Manifest、Schema 和类型；
- 主键、外键和唯一性；
- 数据族语义；
- 单位、尺度和归一化；
- provenance 与 confidence；
- 未解决 blocking HIL 与人工审核状态；
- `NO_DATA` / `PARTIAL_SUCCESS` 的阈值；
- 图表 bounding box、模型版本和人工复核状态。

Agent 只能选择服务端允许的 Profile 引用，不能直接写入发布阈值或放宽门禁。

### 10.2 发布门禁：三项架构不变量

架构层只规定三项稳定不变量：

1. **Provenance closure**：正式记录可以追溯到 SourceAsset、源定位、
   Parser/Adapter 版本、字段映射和转换版本；
2. **Validation Profile passed**：与目标 Manifest digest 对应的版本化 Profile
   判定通过；
3. **Atomic promotion**：Publisher 只原子提升引用闭合、staging 完整且已验证的
   Manifest。

CSV 编码、列数稳定、Schema/类型/主键、measurement 完整率、单位尺度与归一化、
warnings 与 metrics 一致、probe mapping 覆盖率、`NO_DATA` / `PARTIAL_SUCCESS`
阈值等属于具体 Validation Profile 的实现与测试，不提升为全局架构协议。

`NO_DATA` 不要求“必需主 Artifact 非空”。它应通过专门结果规则证明没有可发布主
数据，并保留足够审计证据。

### 10.3 ValidationResult 与原子发布

Validation Engine 的输出必须绑定：

- `manifest_digest`；
- `validation_profile_ref` 与版本；
- `PASSED` / `FAILED`；
- 规则结果、原因码和审计摘要。

Publisher 继续使用任务锁、独立 staging、文件 flush、Manifest 验证和同文件系统
原子 rename。发布成功后才生成不可变 `DatasetPublication`、Artifact 事件和完成
事件；失败文件不得出现在 Artifact API。

### 10.4 测试策略

测试锁定三项架构不变量和 Profile 结果，不依赖全局 `check_id` 固定顺序。某个
数据族的列规则、阈值和文件细节应进入对应 Profile 合约测试，而不是成为系统级
架构测试。

> 决策依据：ADR-012、ADR §21.5/§21.10/§21.18（踩坑）。

---

## 11. 置信度

### 11.1 可解释等级，非虚假概率

置信度包含：

- `level`：`high` / `medium` / `low`；
- `channel`：来源通道（API / VLM / 网页 / 表格解析等）；
- `reasons`：判定理由；
- `source_reliability`：来源可靠度；
- `extraction_reliability`：提取可靠度；
- `mapping_reliability`：映射可靠度；
- `cross_source_consistency`：跨源一致性；
- `human_review_state`：人工审核状态。

未经标定的 `0.92` 看似精确，实际没有概率解释。赛题更需要可解释、可追溯和可
复核。

### 11.2 通道差异

- 确定性官方 API（GDC、Xena、Reactome、PubMed）可使用批次默认等级；
- VLM / LLM / 网页/OCR 抽取必须逐条标注；批次默认只保存一次，异常记录使用稀疏
  override，字段映射可信度由记录引用的 `mapping_ids` 派生，不复制到每个 cell。

批次默认的 `record_count` 必须按 integrate/dedup/conflict 之后的最终
source-of-record 行计算，所有 default + override 的有效总数必须等于 primary row
count；被去重或冲突淘汰的来源记录不能继续影响 low fraction 或发布门禁。

最终 level 使用 weakest-link：关键 component 为 low 则 low，否则存在 medium 则
medium，全部 high 才 high；VLM-only、未审核 proposed/string-similarity mapping 与
跨源冲突使用显式 cap。`requires_human_review` 是 evaluator 派生值，不由 Adapter 设置。

对论文源数值（图表 y 值）另做固定代码数字规律筛查，灵感来自公开的医学论文数据
打假方法：末位数 / 末两位数分布均匀性卡方检验、插值（等差）规律与重复值检测；
统计异常时该图表置信度降级为 `low`。

### 11.3 与 Validation 的关系

置信度不是 Validation 的替代。Validation 判断是否满足发布规则；Confidence 描
述记录在已知证据下有多可靠。`human_review_state=accepted` 可以解除 Profile 的
审核阻塞，但不会自动把 low 提升为 high；人工修正保留原值并写入 TransformRecord
与 review provenance 后才重新评估。Profile 的 `ConfidenceGatePolicy` 决定必需字段
最低等级、low primary 容忍度、待决审核和需复核通道，Agent 无权调整这些阈值。
正式 release Profile 要求 `confidence_records.json` 存在；缺失时
`evidence_confidence_policy` 明确失败，不能跳过检查。

跨源一致性只有在 source lineage 证明来源独立时才增加证据；共享同一上游的镜像
一致只记录为同源确认，不增加票数。V1 不以复杂跨源加权作为发布前提。

### 11.4 禁止装饰字段

置信度必须有计算/判定策略、理由、门禁和 UI，不允许空值默默通过。

> 决策依据：ADR-013、ADR §21.13（踩坑）。

---

## 12. 溯源（Provenance）

### 12.1 主表最小字段

主表保留最小溯源字段：

- `record_id`；
- `source_id`；
- `asset_id`；
- `provenance_id`。

### 12.2 Lineage sidecar

详细定位、原值和转换链放在 lineage sidecar。这样既保持主表可分析性，又能完整
追踪。

`SourceLocator` 精确定义：

- 解压后的 logical file；
- 以 1 为基准、包含表头/注释/空行的物理文本行号；
- 以 0 为基础的列索引；
- 原始列名与原始 token。

### 12.3 例外

Demo 或小表可以内联关键来源字段，但 Manifest 和 sidecar 仍为权威来源。

> 决策依据：ADR-014。

---

## 13. 缓存身份

缓存身份由 Schema 和构建参数标识，不由关键词或固定列标识。身份包含：

- dataset family；
- Schema version；
- SourceAsset digest；
- Adapter / parser version；
- normalization profile；
- cohort / query parameters。

**关键词用于检索缓存，不用于决定资产身份。**

缓存布局为 `cache/datasets/<namespace>/<dataset_id>/`（manifest + data + schema +
provenance）。字节级内容缓存与逻辑缓存分别由
`server/src/external/acquisition/content-cache.ts` 与 `database/cache_store.py`
（经 TS DB bridge）实现。

> 决策依据：ADR-015、ADR §21.3（踩坑）。
