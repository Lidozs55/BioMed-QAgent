# 目标架构、迁移边界与旧设计清理

## 1. 当前代码事实

当前 production 仍是：

```text
TS Host + Pi Agent + static DatasetFamilyRegistry
  + fixed/registered family runtimes
  + TS Dataset Core validation/Publisher
```

已实现且必须保留：SourceAsset 内容寻址与 task ownership、固定 operation skeleton、OperationResultManifest、checkpoint/cancel/timeout、build lock/fence、B3、ProductAssessment、Core-only Publisher、Artifact API hash verification。

尚未实现：

- Agent-authored TS 的安全 compiler/bundler；
- 独立低权限 Transform Host；
- DatasetTransform ABI、execution receipt 和 quarantine output admission；
- FamilySpec 动态 build wire contract；
- examples/families retrieval catalog；
- static family 到 example 的 shadow/activation/retirement 流程。

当前 `registered_multitable.runtime.v1` 仍完整缓冲 carrier、使用 `object[]` 聚合并存在 family/provider 特判；它还绕开通用 executor 的完整 lock/checkpoint/timeout/cancel 生命周期。不能在该旁路上叠加 Agent transform。

## 2. 目标职责

```text
Agent
  discover sources / retrieve examples
  author FamilySpec and DatasetTransform
  propose semantic decisions
        |
        v
Family Host (control plane)
  strict parse / digest / scope resolution
  resolve projection, schemas, transform refs, policies
  admit or reject
        |
        v
Transform Host (isolated execution plane)
  compile/admit content-addressed bundle
  registered inputs only
  bounded reader/writer, no network
  quota/cancel/timeout/process fence
  quarantine outputs + execution receipt
        |
        v
Dataset Core (product trust plane)
  rehash and admit Host outputs
  compatibility partition / deterministic integration
  B3 + scientific validation + provenance closure
  ProductAssessment
  generic PublicationCandidate
  Publisher
```

核心原则：Agent 控制“目标产品和候选转换逻辑”；Host 控制“不可信代码如何被隔离执行”；Core 控制“输出是否成为可信产品”。真正可信的是完整 admission + isolation + Core gate，而不是 transform 源码的作者标签。

## 3. Family、Projection 与 Transform

- `FamilySpec` 是 declarative data-product contract，不携带代码。
- `Projection` 定义 primary/supporting/derived tables、relations、granularity、compatibility dimensions、integration/validation/assessment policy refs。
- `DatasetTransform` 将登记输入转换为声明输出；所有来源的 transform 共用一种 ABI。
- FamilySpec 可以引用 TransformDescriptor，但不能携带任意函数、validator、merge implementation、网络权限或 Core DAG。
- transform 输出默认是 quarantined candidate；Core 重新校验后才形成 native OperationResult。

## 4. Core 最终保留什么

目标目录职责（不是本轮文件移动任务）：

```text
server/src/dataset/
  contracts/
  family-host/
  transform-host/
  execution/
  integration/
  validation/
  assessment/
  publish/
```

Core 持续拥有：

- fixed operation topology 和 transform slot；
- SourceAsset / committed-result admission；
- bounded IO、disk-backed state、checkpoint、cancel、lease/fence；
- compatibility partition、dedup/conflict/provenance merge；
- structural/scientific validation；
- ProductAssessment、PublicationCandidate、Publisher。

Agent 不获得 DAG、Publisher、task output/state/settings、网络或任意 npm 权限。

## 5. 六个现有 Family 的终态

`gene_expression`、`literature_evidence`、`target_evidence`、`variant_evidence`、`protein_structure`、`bioactivity_measurement` 最终成为 `examples/families/` 下的 retrieval-based reference corpus，承担：few-shot、SDK example、fixture/regression、shadow parity、Gold capability evidence。

这不是一次性搬迁：每个 capability 必须经过 `example -> host fixture -> Core shadow -> trusted E2E -> activated -> legacy retired`。在最后一个旧调用者和回滚条件消失前，静态 Registry 保持 compatibility facade。

`gene_expression` 暂时保留 fixed executor，并作为 BoundedReader/TableWriter/DiskBackedIndex/Checkpoint/ConflictWriter 的 donor；它最终也不享有架构特权。

## 6. 从 v1 计划中删除的设计

本计划不再使用：

1. `runtime.ts` / Runtime Extension 作为 Family package 的第二套 executable ABI；
2. “Agent 永远只能声明、不能编写 transform”的绝对限制；
3. `builtin > curated > user > task` 同时充当 trust、lookup 和 shadow precedence；
4. 将六个现有 Family 转成永久 builtin packages 的终态；
5. package root 扫描即获得 production capability；
6. family-specific GenericAssembler handler 作为长期迁移终点；
7. 把 GEO/GDC/Xena 都完成、全六族迁移和 Agent create_family 塞入同一迭代；
8. 把 `audit` 加入现有 `TableRole`；处理失败仍是 audit artifact，不进入产品 table topology。

## 7. ADR 治理

[ADR-039](../../../adr/039-family-transform-host.md) 现已 **Accepted**。本文件其余内容是历史设计输入；当前执行边界见`docs/architecture/FAMILY-HOST-03-execution-constraints.md`：

- ADR-027/033/034/036/038 与production行为继续有效；
- 显式`in_process_unisolated` dynamic route与Core publication chain已作为稳定`main`基线落地，但不是sandbox/安全边界；
- sandbox/container/IPC不开发；static runtime不删除；
- Core继续独占quarantine admission、native OperationResult、B3、ProductAssessment、evidence-bound publication HIL与Publication；
- 后续checkpoint/restart/resource/identity、family closure与frontend UX在独立分支/worktree并行，integration hotspots串行合并。

若未来增加isolated backend，再通过独立ADR逐项评估supersede/narrow：

- ADR-027 static Registry -> legacy compatibility facade；
- ADR-033 family-specific assembler -> contract-driven generic assembly；
- ADR-034 registered adapter path 保留，Agent transform 走独立 Host；
- ADR-036 fixed derive 保留为 Core primitive，DatasetTransform 使用固定 transform slot而非 DAG；
- ADR-038 的 promoted-only transform 模型 -> sandbox-executable 与 publication activation 分离。

## 8. 依赖图

```text
D0 ADR + threat model
 |-- C1 FamilySpec / Projection contract
 |    `-- C2 DatasetTransform / receipt / BuildSpec 2.0
 |         `-- H1 compiler admission -> H2 OS sandbox -> H3 Host protocol
 |-- I1 identity/relation/audit contract
 |    `-- E1 expression transform examples
 `-- S1 bounded IO/result protocol
      `-- S2 integration + B3 disk mode

H3 + C2 + S1 -> Core quarantine admission
Core admission + I1 + S2 -> Product gate
Product gate + expression examples -> shadow E2E
Two real consumers -> generic claim / migration decision
```

## 9. 范围截止线

- Batch 0 不运行动态 Family。
- Batch 1 不激活任何 Agent-authored transform，也不接默认 Agent tool。
- Batch 2A 只做 expression shadow slice；2B 第二消费者需评审后启动。
- Batch 3+ 才讨论全六族迁移、promotion/user catalog、默认动态 build。
- Gold closure 与 Batch 0 contract/security 可并行；Gold requirements 不得塑造 production FamilySpec，但同 commit Gold evidence 仍是 release gate。
