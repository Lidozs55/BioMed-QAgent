# Core Execution、Integration、B3 与 Product Gate

## 1. Core 不被 Transform Host 取代

Transform Host 只负责隔离执行和 quarantine receipt。Core 仍拥有：

```text
Host receipt + quarantine output
  -> Core rehash / output admission
  -> compatibility partition
  -> deterministic integration
  -> B3 structural/relation validation
  -> scientific semantic policy
  -> provenance closure
  -> ProductAssessment
  -> generic PublicationCandidate
  -> Publisher
```

Host exit code、schema parse、B3 pass 都不能单独授权 Publication。

## 2. Streaming primitives

现有 expression donor 中可抽出：

- `BoundedReader`：asset handle、chunk/record size、cancel-aware hash/size；
- `TableWriter`：bounded buffer、schema row validation、incremental count/digest、locator；
- `DiskBackedIndex`：SQLite/等价 temp store、quota、transaction batch、canonical tuple key；
- `ConflictWriter`：append-only audit artifact；
- checkpoint/recovery：typed state、attempt/generation、atomic commit；
- resource accounting：RSS/heap/temp/output/log/row/column limits。

不要为表达数据创建一套只服务 GEO 的新语义；但在第二个真实消费者前也不要宣称 primitive 已 generic。`registered_multitable.runtime.v1` 不能以 Buffer/object[] 旁路承担表达大矩阵。

## 3. Same-Schema Integration

```text
source outputs
  -> compatibility partition
  -> table/projection-owned identity
  -> disk-backed dedup
  -> conflict detection
  -> fixed policy or typed ResolutionDecision
  -> provenance merge
  -> committed table/audit outputs
```

Agent 只能提出 policy/decision；不能注入 merge function，也不能以 source binding 顺序决定 winner。不同 unit/scale/normalization/taxon/reference 先 split/block，不强行 merge。

每个表声明 identity、comparison fields、null semantics、conflict policy、provenance policy。unresolved conflict 通过 `ConflictCandidate -> ResolutionDecision -> policy(auto/HIL/reject) -> Core deterministic replay`，保留 parent artifact 和 decision evidence。

## 4. B3 渐进 disk-backed

### B3-D0：Batch 0 可观测性与门限

在现有 `server/src/dataset/validation/multitable.ts` 上增加 benchmark/telemetry 设计：row/key estimate、validator mode、heap、temp bytes、duration、failure reason。超过明确阈值时强制 disk mode 或 fail closed；不得继续 Map 到 OOM。保留小 fixture 的 memory mode 作为 parity oracle。

### B3-D1：Batch 1 PK/FK index

只替换第一个真实爆点：PK uniqueness、FK existence、duplicate count 使用 disk-backed tuple index；保留流式 type/null/header/token 检查。实现 quota、cancel、batch transaction、cleanup、确定性 key encoding。

### B3-D2：Batch 2 cardinality/relation reuse

复用 tuple index 支持 one-to-one/one-to-many/many-to-one/many-to-many 和 audit relation。memory/disk mode 产出同 checks、ordering、digest；checkpoint/cancel 后不留下可复用 validation result。

不一次性重写 B3，也不将 scientific validation 混入 B3。

## 5. Provenance 与 ProductAssessment

coverage 从实际 committed evidence 计算：traced/untraced rows/assertions、asset receipts、locators、transform/runtime digests、integration decisions、conflict/review/correction refs。禁止固定 `coverage_ratio = 1`。

ProductAssessment 包含 schema、relations、identifiers、provenance、confidence、reproducibility；`incomplete`、`validated`、`publishable` 保持严格。expression package 至少要求 Dataset/Study、Sample、Measurement、projection-specific mapping、relation closure、locator/receipt 和实际 artifact hash。

## 6. Operation / publication 生命周期修复

Agent Transform 接入前必须统一 registered family runtime 与通用 executor：build lock/fence、AbortSignal、timeout、OperationAttempt、OperationResult、checkpoint、durable continuation、Publisher fence。当前 `registered_multitable.runtime.v1` 的旁路不得继续扩展。

另须修复 publish checkpoint reuse：publish 不能仅复用旧 checkpoint summary；必须重新验证 authoritative publication receipt，或禁止 publish shortcut。固定 operation 的 implementation identity 也要绑定真实部署版本，不能仅靠 null/version 字符串。

## 7. 验收

- Host quarantine output 未经过 Core admission 时不可成为 OperationResult；
- source locator 不得指向未知输入；
- memory/disk B3 fixture parity；
- 大表达数据不走无界 JS Map/全量 object array；
- cancel/timeout/restart/stale worker 不会 late commit；
- ProductAssessment 与 selected Publication、manifest、Artifact API digest identity 一致；
- Core generic modules 不新增 `family.id === ...` 语义分支。
