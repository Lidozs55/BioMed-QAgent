
# BioMed-QAgent 架构 — 确定性执行与职责边界

> 本文是 [docs/ARCHITECTURE.md](../ARCHITECTURE.md) 的拆分章节（原 §4-§8、§20），
> 章节编号与主文件保持一致。

---

## 4. 可信执行内核

以下能力是赛题"来源追踪、可复现、错误修正"的基础，语义与可靠性不变量持续有效：

- `SourceAsset` 内容 hash 标识；
- `DownloadAttempt` 成功/失败记录与 Attempt 输入/参数/输出摘要；
- 任务锁、checkpoint、timeout/cancel、durable event 持久化与重放；
- staging 区与原子发布（immutable publication）；
- Validation Gate（Profile 驱动，见 §10）；
- fixture / live 区分；
- 网络访问、安全下载、沙箱与 egress 边界。

> 决策依据：ADR-003、ADR §20。

### 4.1 大文件下载：断点续传与进度

`acquireSource`（`server/src/external/acquisition/downloader.ts`）支持断点续传：

- 调用方传入**自有 part 文件**（`partPath`）与已接收字节数（`resumeFromBytes`）时，
  下载器发送 `Range: bytes=<offset>-`；服务器返回 **206** 则追加写入，返回 **200**
  （忽略 Range）则截断重头；续传后对**整个文件**重新哈希（前缀重读），保证
  `SourceAsset.sha256` 覆盖全量内容。
- 非 abort 失败时**保留调用方 part 文件**供重试续传；默认（无 `partPath`）part
  始终清理。abort/cancel 对调用方 part 同样保留，便于用户取消后重试续传。
- Core acquisition 在不可重试或重试预算耗尽时保留 provider、底层错误码、attempt
  数和最终 retryability；Agent 工具必须原样投影该结构化失败，不能降级为
  `bridge_unavailable` 或据此盲目重复相同请求。
- `download_xena` 工具据此自动重试（网络错误/超时等瞬态码，指数退避），并以
  节流（1s 或 8MiB）上报 `operation_progress(downloaded_bytes)`，长下载不再表现为
  "卡死"。

> 决策依据：2026-08-15 任务 `task_ts_888508a7`（Xena 多 GB 数据集下载无进度反馈）。

### 4.2 Core provider catalog 与 Dynamic Family

`server/src/dataset/acquisition/provider-catalog.ts` 是 built-in acquisition capability 的
单一清单：phase3 runtime provider 注册与 Dynamic Family 的 acquisition tool schema 都从
该清单派生，不能分别维护 enum。descriptor 同时声明数据库目录 ID、固定 source、参数
契约和 carrier 编码；runtime handler 数量/顺序与 descriptor 必须形成 exact closure。

当前所有 user-selectable builtin database 都有 Core provider，并可复用于 task-scope
Dynamic Family；dbSNP、MGnify、openFDA 和 GWAS Catalog association 也有受控官方 API
provider。Dynamic transform 接受 UTF-8 与受 `temp_bytes` 上限约束的 gzip-compressed UTF-8，
也接受已通过 Core 派生输入 registry 验证的 UTF-8 evidence/parser 资产；每次解析后的输入
递归闭合父 member、父 ZIP 与对应 OperationResult。ZIP/XLSX/PDF 不能直接进入 Dynamic
schema：官方 archive 先由 Core 获取，bounded member extractor 记录父 ZIP/member hash，
CSV/TSV、XLSX sheet 与 PDF table 再由固定 parser registry 生成 UTF-8 derived assets。
仅下载、workspace 解包或浏览器暂存均不构成可消费输入。

Agent 在数据获取前通过无副作用的 `inspect_dataset_execution_routes` 查看该能力清单的当前
投影。对于动态产品，随后调用 `scaffold_dataset_profile`；Core 根据 profile 生成完整
FamilySpec、Projection、表定义、关系与输出 closure，并可在调用方只提交来源绑定、Core
asset/provider 绑定、transform 输入角色与抽取实现时生成完整 prepare submission。Agent 不再
手写 profile topology。prepare 拒绝会返回 expected family、完整表清单、可用 profile 与
scaffold，标记 unchanged retry forbidden；修改来源/抽取事实后必须重新 scaffold/prepare。
输出严格区分 static exact match、Dynamic 可直接绑定的 UTF-8/gzip UTF-8 provider，
以及 acquisition-only binary carrier；provider 已接线只证明可信 acquisition/输入解码，
不证明 FamilySpec/Projection/transform/源站可达性或 Publication closure。具体 Dynamic
提交仍由 `acquisition_requests` schema 和 `prepare_dynamic_family_publication` receipt 校验。

Profile 选择按语义和表闭包从具体到通用：要求 `paper_records`、
`experiment_records`、`activity_value_records`、图表系列/点和补充资产共同闭合的论文实验
产品必须使用 `literature_experiment_chart.release.v1`；旧的
`bioactivity_measurement.chart_evidence.release.v1` 只用于 compound-assay-target 归一化
矩阵附带图表证据，不能替代论文六表产品。route preflight 以该顺序返回并携带
`use_when` / `do_not_use_when`。

---

## 5. 执行模型：服务端固定构建骨架

### 5.1 固定 Operation 序列

Dataset Runtime 不暴露数据集级 `BuildRecipe`，也不让 Agent 生成 nodes / edges。
服务端执行以下固定、可测试的构建骨架：

```text
acquire[*]
  -> parse[*]
  -> canonicalize / normalize[*]
  -> compatibility gate
  -> integrate
  -> [fixed derive slot]
  -> validate profile
  -> publish
```

`derive` 是服务端固定骨架中的单一可选 slot，不是 Agent 可提交的节点或通用 DAG。
它只接受 registered SourceAsset 或 committed Core result，使用服务端 registry 中的
算法，并将参数、reference version、input digest 和 output digest 写入 derived
provenance。PDB distance 与 sequence alignment 共用该 contract；两者的参数和输出
schema 由各自算法/family 定义。该 slot 的 runtime/checkpoint/publisher 接线已随
TS Dataset Core 落地（原 TASK-048-B6W 跟踪项闭环）。

方括号步骤按来源独立执行并可内部并发。fan-out / fan-in 是 Runtime 实现细节，
不是通用 DAG。只有当用户自定义任意分析链、多级条件分支、节点复用和分布式执行
成为核心需求时，才重新评估 DAG。Spec Validator 拒绝时在获取前短路；`NO_DATA`
或验证失败时跳过正式主数据发布。

### 5.2 OperationAttempt、恢复与局部重跑

每个 Operation 创建独立 `OperationAttempt`，记录输入摘要、参数摘要、实现版本、
输出摘要、attempt 序号和状态。Operation 必须幂等；恢复时只复用输入、参数、实现
版本和输出 digest 一致的成功结果。

- 同一 Agent Run 内只允许一次 publication；补充数据或修正规格通过新的 durable
  Run 实现；
- topic、来源、查询参数、Adapter、Schema、字段映射或 Profile 变化必须形成新的
  Run / 构建版本；
- 局部重跑不是任意 `skip_stages`。服务端按固定依赖闭包从指定 Operation 重新
  执行，下游不得消费 digest 不匹配的上游输出。

### 5.3 Publication 版本关系

每次通过门禁的结果都生成不可变 `DatasetPublication`。后续补充或修订不修改旧
Artifact 状态，而是：

```text
publication_v2.supersedes_publication_id = publication_v1
task.current_publication_id = publication_v2
```

不存在 `validated_intermediate` / `validated_final`。所谓“final”只表示当前
Publication 指针，不是 Artifact 固有状态。

### 5.4 来源并行与确定性集成

`acquire` / `parse` / `canonicalize` 对每个来源独立执行，可内部并发。
`compatibility gate` 之后的 `integrate` 只接受服务端允许的显式策略，不接受 Agent
注入的任意合并逻辑。

> 决策依据：ADR-004、ADR-010。

### 5.5 大文件解析的内存边界

GEO series-matrix/tximport 解析必须使用 gzip 流式逐行读取；不得同时保留解压后的
整段字符串、全量行数组和全量输出行数组。TS adapter 的大文件路径通过有界 CSV
writer 写入 `batches/`，保留原始行号、列名、raw value 和 SourceAsset hash。
小型 fixture 仍可使用数组 helper 做 parity 测试，但不能让该 helper 成为生产大文件
路径。解析失败需保留结构化 `EmptySourceError`/`AdapterError`，不可将确定性数据
错误包装成笼统的网络失败。

> 证据：2026-08-17 gold1/gold2 真实 run；319 MiB GEO matrix 在旧路径触发
> Node heap OOM / `Invalid string length`。回归覆盖
> `server/tests/phase5/geo-adapter.test.ts` 的 gzip 流式行迭代。

---

## 6. 职责边界：Agent 与服务端

### 6.1 Agent 权限

- 解析用户需求；
- 选择或建议 Canonical Schema；
- 查找候选来源；
- 选择 Adapter；
- 提议字段映射（状态 `proposed`）；
- 生成 `DatasetExecutionSpec`；
- 根据诊断重新规划；
- 拆分复合需求为多个 requirement。

### 6.2 服务端权限

- 下载和校验文件；
- 运行 Parser；
- 读取源值；
- 执行确定性转换与归一化；
- 批准字段映射（将 `proposed` 提升为 `approved`）；
- 判断兼容性；
- 计算质量和置信度；
- 验证与发布。

### 6.3 禁止

**Agent 不能直接提交一个数字并声明它来自论文、图表或数据库。** 任何模型提取
必须绑定 SourceAsset、定位信息、模型版本、置信度和审核状态。

Agent 不直接拼装最终 CSV，不绕过 Compatibility Gate，不绕过 Validation Gate，
不绕过原子发布。Agent-only Skill 的产物不能直接作为正式主数据。

### 6.4 HIL policy boundary

Agent 可以提出审核候选，但只有 Runtime/Profile policy 可以暂停 Run。有已注册的
确定性 parser、curated mapping 或 UnitConversionRule 时自动执行并留审计；没有
确定性规则时不得让模型继续猜测，而是按字段映射、VLM 低可信 primary value 或
未知单位换算生成批量 blocking HIL。低可信 supporting data 可由 Profile 降为
warning。用户 correction 必须进入转换与 provenance 链，不能直接覆盖源证据。
已注册单位规则只接受可审计的安全线性公式，不执行任意表达式；公式无效属于 Profile
配置错误并 fail-closed。DashScope VLM 的模型凭据在每次外部调用前仍需 Runtime
permission HIL，数据点审核不能替代凭据授权。

Blocking HIL 请求进入人工等待前可经三档审批档位（人工审批 / 大模型初审 /
不审批，按 scope 分配）短路：仅大模型初审不通过（或自动档之外的失败）才暂停
等待人工，发布边界 scope 始终人工审批。详见
[hil-approval-policy.md](hil-approval-policy.md)。

> 决策依据：ADR-007。

---

## 7. 来源能力与数据兼容性

来源能力拆为两层独立判断：

### 7.1 Adapter capability（系统能否安全获取和解析该来源）

声明系统对该来源的获取与解析能力：能否搜索、能否下载、能否解析、是否需要
fixture 豁免、是否仅研究用途。能力口径由多套来源表共同承载、需要统一治理，任何
单一表都不自称“唯一事实源”：界面可选择的内置数据库目录
（`server/src/product/builtin-databases.ts`）、Dataset Core 的 acquisition provider
catalog（`server/src/dataset/acquisition/provider-catalog.ts`，capability 路由与动态
绑定 schema 都从它派生）与静态 spec validator 的 family/schema 注册表
（`DatasetFamilyRegistry`）分工不同——provider 已接线只证明可信 acquisition/输入解码，
不证明对应 family 已实现或可发布；新增来源时须三处同步更新并通过派生/闭包测试断言一致。

### 7.2 Dataset compatibility（本次数据能否映射至目标 Schema 并合并）

每次 requirement 独立判断，依据：

- `dataset_family` 一致；
- `row_granularity` 兼容；
- 主键语义兼容；
- 测量语义可比较（如 TPM vs raw count 必须显式处理）；
- 单位与尺度可统一或显式标记不可比较；
- 字段映射证据充分（见 §8）。

**示例**：GDC 和 Xena 都可用（Adapter capability 满足），不代表任意 GDC 数据
与任意 Xena 数据可合并（Dataset compatibility 仍需校验）。

### 7.3 来源接入不变量

新来源接入**不应**修改多个数据库组合分支。新 family 通过完整
`DatasetFamilyDefinition` 登记 Canonical Schema、粒度、来源 Adapter、Profile、
source/schema 与 schema/profile 兼容关系和已实现 runtime ID；同一 family 的新来源登记
source-to-adapter/schema 能力。Agent Tool Schema 与 Core admission 从同一
`DatasetFamilyRegistry` 派生，组合可能性由兼容性判断决定，
不靠散落的 allowlist 枚举。仅注册 Schema 不代表该 family 可以执行或发布。

> 决策依据：ADR-008、ADR-027、ADR §21.7（踩坑）。

### 7.4 非表达研究数据的发布边界

target/variant/structure/activity/paper/figure 等非 `gene_expression` 数据不能把
Agent workspace 的 Markdown/CSV 直接当作正式 artifact。每个数据族必须先注册
Canonical Schema、Adapter、Validation Profile 和 Publication manifest；图表估读
还必须携带 figure/axis/legend locator、`estimated`/confidence 和人工审核状态。
在这些组件落地前，运行可以正常结束并产出审计型报告，但不得设置
`current_publication_id` 或伪造可下载主数据。

> gold3–gold6 的 2026-08-17 真实 run 当时仅有 workspace 摘要、不满足该边界；该缺口
> 已由后续注册式/动态发布路线（gold7–gold9 正式发布）闭环，原 Commonly
> `TASK-048` 跟踪项结束。

---

## 8. 字段映射

### 8.1 映射证据来源

正式字段映射必须来自以下之一：

- Adapter 声明（来源官方文档或结构化元数据）；
- Schema Registry（Canonical Schema 间的标准映射）；
- 可信元数据（如 GEO 平台 probe-to-gene 注释）；
- 明确规则（如单位转换公式）；
- 人工批准（HIL）。

### 8.2 字符串相似度只提议，不批准

列名包含、token 重叠与公共前缀相似度（`string_similarity.v1`，NFKC 归一后计算，
阈值 `>= 0.7`、并列判定 `ε=0.05`，候选集携带排序与 sha256 digest）是**可复现的
轻量词法候选排序器**，不是生物医学语义理解模型；其输出默认状态为 `proposed`，
不直接进入正式数据。

**原因**：列名相似无法证明同一语义、同一单位、同一粒度、同一值域、同一实体
ID、一对一关系。相似度规则足以将看似相似、实际不同的字段对齐，垂向合并
会让错误进入正式数据。

### 8.3 Schema Registry 与映射状态

字段映射在 Schema Registry 中以状态机管理：`proposed` → `approved` /
`rejected`。批准来源记录在案，便于审计与回滚。

Agent 可通过 `preflight_cleaning_rules` 提交单位/字段映射提议；Core 会重新按
注册 NormalizationProfile/Schema Registry 校验并稳定排序候选。只有唯一且命中
Core 注册规则的项可标为 `accepted_registered_rule`；相似度-only、并列或近似并列
候选仍保持 proposed 并进入 HIL。需要把已接受规则应用到 execute 时（不是所有
execute 的全局必需），必须携带 Core 重算并签发、绑定当前 task/run/requirement/binding
的 digest receipt；未携带任何接受规则时 execute 可按无清洗规则继续。`needs_hil`
是预检标记，表示该项应走后续 HIL 流程，不等于工具自动创建 durable HIL；通用字段
映射（非 schema-identity、非注册单位规则）不会被执行，registered-multitable 路线
当前也显式拒绝 cleaning rule receipt。receipt digest 漂移、事实重投影不一致或
task-owned 原子消费标记已存在时 fail-closed。已注册单位规则沿用 canonicalizer 的
`value * factor + offset` 路径；任意字段 transform 仍不能改变 canonicalizer 行为。

> 决策依据：ADR-009、ADR §21.6（踩坑）。

---

## 9. 来源覆盖证据（QueryPlan / SourceCoverage）

Core 在发布装配时确定性生成 `source_coverage_report.json`，以 `audit_report`
角色进入发布清单（契约见 `@biomed/contracts` 的 `SourceCoverageReport`，构建见
`server/src/dataset/audit/source-coverage.ts`）。

**数据分三层，证据强度不同：**

1. `query_plan`：从执行规格的 `source_bindings` 确定性投影的检索计划
   （source/provider/adapter/accession/参数）；
2. `acquisition_coverage`：Core 自验的采集结果——绑定资产回执（asset_id、
   SHA-256、字节数、media_type、registered_at）、行数记账（解析/规范化保留/
   规范化拒绝）与排除原因；覆盖计数只由这一层推导；
3. `discovery_queries`：runtime 工具钩子累积的检索观察记录，逐条 fail-closed
   解析后原样携带；它是观察记录，不参与覆盖计数，也不得被解读为查全证明。

**边界不变量：**

- 覆盖只在 `universe_scope: "spec_source_bindings"`（任务规格声明的源绑定）内
  计算；报告携带固定 scope note，明确不构成"全网查全"宣称；
- 报告是审计证据，不是逐行 provenance，也不是主数据；
- summary 由解析器强制与条目一致（汇总撒谎即拒绝）；
- discovery 台账为审计输入，不参与构建的 authoritative identity digest。

**Agent 消费与补源**：发布后的 Agent 可调用 `inspect_source_coverage`，读取经
manifest/artifact SHA-256 校验的 Core 报告；只能依据声明绑定范围内的 failed /
not_attempted 项决定独立补源，不能把报告表述为全网查全。Dynamic Family 当前
没有规格绑定的 coverage artifact，必须显式报告 coverage unavailable。

**路线覆盖与恢复**：V1 静态路线经 `validate_profile` 的 `auditPaths` 进入清单；
V2 注册式路线在发布条目中追加；动态 Family 路线的发布层目前没有规格绑定与
完整回执，暂不产出该报告（跟进项）。runtime 恢复时用
`server/src/runtime/discovery-ledger.ts` 的 `projectDiscoveryQueries` 从既有
`operation_*` 事件重建检索台账，不新增事件类型。

**遗留项**：完整检索 `filters`、`time_window`、requested/succeeded pages 与
raw/deduplicated/selected counts 语义尚未进入 DTO（当前只有 `requested_limit`
与解析/规范化行数记账），列为遗留；生产运行是否持有 ToolHooks ledger 决定
`discovery_queries` 是否填充，缺失时报告该字段为 null——恢复时把生产 ledger
重新注入具体构建的完整接线仍属部分完成。

---

## 20. 代码评审检查表

新增数据源或数据类型时，先逐项对照 §19 顶层不变量，再回答：

- 它产生哪种 dataset family？
- 一行代表什么，即 row granularity 是什么？
- 源 Schema 与 Canonical Schema 分别是什么？
- 主键是什么，冲突和重复如何处理？
- 单位、尺度和归一化状态是什么？
- 字段映射证据来自哪里？
- 与哪些已有 DataBatch 兼容？
- provenance 和 confidence 到什么粒度？
- Validation Profile 是什么，阈值由哪个服务端版本管理？
- Acquisition 使用内置 Provider 还是 `PROMOTED WorkflowRecipe`？
- 无数据时返回什么？
- 是否会在其他模块新增来源特例？若是，抽象可能仍不正确。
