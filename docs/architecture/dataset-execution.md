
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
- `download_xena` 工具据此自动重试（网络错误/超时等瞬态码，指数退避），并以
  节流（1s 或 8MiB）上报 `operation_progress(downloaded_bytes)`，长下载不再表现为
  "卡死"。

> 决策依据：2026-08-15 任务 `task_ts_888508a7`（Xena 多 GB 数据集下载无进度反馈）。

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
  -> validate profile
  -> publish
```

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

---

## 6. 职责边界：Agent 与服务端

### 6.1 Agent 权限

- 解析用户需求；
- 选择或建议 Canonical Schema；
- 查找候选来源；
- 选择 Adapter；
- 提议字段映射（状态 `proposed`）；
- 生成 `DatasetBuildSpec`；
- 根据诊断重新规划；
- 拆分复合需求为多个 Build。

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

> 决策依据：ADR-007。

---

## 7. 来源能力与数据兼容性

来源能力拆为两层独立判断：

### 7.1 Adapter capability（系统能否安全获取和解析该来源）

声明系统对该来源的获取与解析能力：能否搜索、能否下载、能否解析、是否需要
fixture 豁免、是否仅研究用途。以 `SOURCE_CAPABILITIES` 单一事实表声明。

### 7.2 Dataset compatibility（本次数据能否映射至目标 Schema 并合并）

每次 Build 独立判断，依据：

- `dataset_family` 一致；
- `row_granularity` 兼容；
- 主键语义兼容；
- 测量语义可比较（如 TPM vs raw count 必须显式处理）；
- 单位与尺度可统一或显式标记不可比较；
- 字段映射证据充分（见 §8）。

**示例**：GDC 和 Xena 都可用（Adapter capability 满足），不代表任意 GDC 数据
与任意 Xena 数据可合并（Dataset compatibility 仍需校验）。

### 7.3 来源接入不变量

新来源接入**不应**修改多个数据库组合分支。新来源通过注册 Adapter + Canonical
Schema + Validation Profile 接入，组合可能性由兼容性判断决定，不靠 allowlist
枚举。

> 决策依据：ADR-008、ADR §21.7（踩坑）。

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

列名包含关系与公共前缀相似度（阈值 `>= 0.7`）只作为**候选生成器**，默认状态为
`proposed`，不直接进入正式数据。

**原因**：列名相似无法证明同一语义、同一单位、同一粒度、同一值域、同一实体
ID、一对一关系。相似度规则足以将看似相似、实际不同的字段对齐，垂向合并
会让错误进入正式数据。

### 8.3 Schema Registry 与映射状态

字段映射在 Schema Registry 中以状态机管理：`proposed` → `approved` /
`rejected`。批准来源记录在案，便于审计与回滚。

> 决策依据：ADR-009、ADR §21.6（踩坑）。

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
