
# BioMed-QAgent 架构 — 结果、验证、置信度与溯源

> 本文是 [docs/ARCHITECTURE.md](../ARCHITECTURE.md) 的拆分章节（原 §9-§13），
> 章节编号与主文件保持一致。

---

## 9. 运行状态、数据结果与发布状态

系统使用四个正交概念，禁止一个状态字段同时回答执行、数据、验证和发布问题。

### 9.1 四类正交状态

| 概念 | 回答问题 | 典型值 |
| --- | --- | --- |
| `RunStatus` | 执行是否排队、运行、完成、失败或取消 | `QUEUED/RUNNING/COMPLETED/FAILED/CANCELLED` |
| `BuildResult` | 正常完成后得到什么数据结果 | `SUCCEEDED/PARTIAL_SUCCESS/NO_DATA/SPEC_REJECTED` |
| `ValidationResult` | 某个 Manifest digest 是否通过 Profile | `PASSED/FAILED` |
| `DatasetPublication` | 哪个不可变版本已正式提升 | `publication_id + supersedes` |

Parser 崩溃、文件损坏和内部异常对应 `RunStatus=FAILED`；用户取消对应
`RunStatus=CANCELLED`。这些不是数据业务结果。

### 9.2 BuildResult：正常完成后的数据结果

只有 `RunStatus=COMPLETED` 才产生 `BuildResult`：

| 结果 | 含义 | 是否可有 Publication |
| --- | --- | --- |
| `SUCCEEDED` | 主数据通过验证并发布 | 是 |
| `PARTIAL_SUCCESS` | 部分来源失败，剩余来源有效并通过 Profile | 是 |
| `NO_DATA` | 未得到可发布主数据，但运行正常结束 | 可有审计型 Publication |
| `SPEC_REJECTED` | BuildSpec 不满足 Schema、能力、兼容性或资源约束 | 否 |

`BuildResult` 至少包含有效行数、成功来源、拒绝来源、可用 Artifact Role、
`publication_id`、原因码、用户摘要和建议下一步。

不再定义 `EXECUTION_FAILED` 或 `CANCELLED` BuildResult；它们已由 RunStatus 表达。

### 9.3 ValidationResult 与 DatasetPublication

- `ValidationResult` 回答某个 Manifest digest 是否通过指定 Profile；
- `DatasetPublication` 回答哪个不可变版本已经正式提升；
- Task / Session 只保存 `current_publication_id`。

一个 Build 可以产生 ValidationResult 但不发布；只有与当前 Manifest digest 对应的
通过状态 ValidationResult 才能进入原子发布。

### 9.4 NO_DATA 是正式业务结果

- 无主数据不再必然触发内部失败，`RunStatus` 仍可为 `COMPLETED`；
- 前端不通过错误字符串猜测 `NO_DATA`；
- 无数据时可以交付 schema、provenance 和 audit_report；
- 不创建空主表或伪造测量记录；
- 用户始终收到服务端生成的明确 RunSummary。

### 9.5 禁止 metadata-only 占位主表

主表无合法记录时 BuildResult 为 `NO_DATA`；样本元数据保存为
`supporting_dataset`；GEO series matrix 内嵌 metadata 与显式 family SOFT 共用
`geo.sample-group.v1` 提取器。Validation 不允许 warning 或特殊字段豁免目标数据
不存在；空主表不发布为 `SUCCEEDED`；可以发布归入 `audit_report` 的来源搜索、
拒绝和诊断报告，但不能伪装成主数据集成功。

### 9.6 不通过 Artifact 数量判断成功

系统由 RunStatus、BuildResult、ValidationResult 和 Publication 共同表达终态，
不靠 Artifact 数量，也不靠前端解析错误文本。

> 决策依据：ADR-010、ADR-011、ADR §21.4/§21.9（踩坑）。

---

## 10. Validation Profile

### 10.1 Profile 驱动验证

验证由数据集 Profile 驱动：不同数据族使用不同的版本化 Profile，不共享单一通用
Validator。

Profile 可以组合以下类型的具体规则：

- 文件、Manifest、Schema 和类型；
- 主键、外键和唯一性；
- 数据族语义；
- 单位、尺度和归一化；
- provenance 与 confidence；
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
- `validation_result`：验证结果；
- `cross_source_consistency`：跨源一致性；
- `human_review_state`：人工审核状态。

未经标定的 `0.92` 看似精确，实际没有概率解释。赛题更需要可解释、可追溯和可
复核。

### 11.2 通道差异

- 确定性官方 API（GDC、Xena、Reactome、PubMed）可使用批次默认等级；
- VLM / LLM / 网页抽取必须逐条标注。

### 11.3 与 Validation 的关系

置信度不是 Validation 的替代。Validation 判断是否满足发布规则；Confidence 描
述记录在已知证据下有多可靠。

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
