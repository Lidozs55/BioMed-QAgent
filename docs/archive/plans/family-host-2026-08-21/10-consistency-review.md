# 全计划一致性审查与开放决策

## 1. 已解决的旧矛盾

| 旧问题 | v2 结论 |
|---|---|
| audit 被写成 TableRole | 保持 `primary/supporting/derived`；processing audit 是独立 audit artifact |
| probe mapping 只有模糊 assertion scope | v1 明确 coverage relation：`many_to_many` + `profile_defined`；mapping PK 为 assertion ID |
| dataset_id 混入 build/version/bytes | 拆 `dataset_id`、`dataset_revision_id`、`asset_id` |
| scope 同时表示 trust/priority | scope、trust/status、resolution、shadow 分离 |
| GEO/GDC 默认能合并 | 共享 framework；只在兼容 partition 内 merge |
| Family Host 只有 declarative package | FamilySpec + 统一 DatasetTransform + isolated Transform Host |
| Trusted Extension 是第二套代码体系 | 删除独立 ABI；保留统一 Host，但不能删除 admission/trust gate |
| 六 Family 永久 builtin | 逐 capability 迁为 retrieval examples，legacy 按证据退休 |
| 一口气完成全平台 | 当前截止 Batch 0–2，Batch 3+ 重新 go/no-go |

## 2. 不得混淆的状态

```text
example catalog presence
  != transform sandbox execution
  != Host receipt
  != Core OperationResult
  != ProductAssessment.publishable
  != Publication
  != activated capability
```

```text
source capability declaration
  != compatible partition
  != trusted E2E verified
```

```text
scope
  != trust
  != resolution precedence
  != shadow execution
```

## 3. 仍需 ADR/contract review 冻结的事项

### 3.1 Transform isolation backend

必须明确目标平台和具体 OS/container backend。若 Windows 不能达到低权限 identity、ACL、Job Object、网络隔离和 hard resource kill，首版不得在 Windows 激活 Agent-authored code。不能用文档措辞替代 backend proof。

### 3.2 BuildSpec 2.0 边界

Batch 0 只冻结引用 FamilySpec/Projection/Transform digest 的方向；字段命名、与 durable Build API 的承载关系、旧 API 的错误语义需进入 `@biomed/contracts` review。任何 2.0 DTO 不能被 1.0 parser 静默接受。

### 3.3 DatasetTransform 的可信语义

统一 ABI 只统一调用协议。`origin`、`scope`、`status`、`runtime policy`、`activation` 独立记录。Task transform 可以 sandbox execute，但默认输出仍是 untrusted candidate。

### 3.4 Audit artifact 的 schema

当前 Batch 0–2 不扩展 `TableRole`。若未来需要可查询的结构化 rejected/conflict artifact，新增独立 versioned `AuditArtifactDefinition`，并定义是否进入 Publication artifact manifest；不得偷偷复用 supporting role。

### 3.5 Probe dimension tables

Batch 0–2 使用 coverage relation 最小模型。只有当 coverage 统计、mapping scope 或多平台数据在真实 fixture 中无法由该模型表达，才引入 `probes`/`mapping_scopes` 表，避免先发明 topology。

### 3.6 Core runtime consolidation

`registered_multitable.runtime.v1` 必须先回到通用 executor，或明确新的 fixed operation slot 继承同一 lock/checkpoint/cancel/fence/Publisher 生命周期。Transform Host 不能接旁路。

## 4. 计划内部自检

- 计划没有把 `schema_refs` 塞入 BuildSpec 1.0。
- 计划没有把 audit 当 TableRole。
- 计划没有把 source binding order 当 precedence。
- 计划没有把 Host receipt 或 BuildResult 当 product success。
- 计划没有让 Transform 写 Publisher、OperationResult commit 或 Core state。
- 计划没有把 examples 自动注册为 production capabilities。
- 计划没有默认合并 GEO/GDC/Xena。
- 计划没有要求一次迁移六个 Family。
- 计划没有把 worker thread/vm/cwd 当 sandbox。
- 计划没有把 ProductAssessment scientific semantics 塞进 B3。
- 计划保留了 WorkflowRecipe 的 acquisition-only 边界。
- 计划保留了固定 operation topology，不开放 Agent DAG。

## 5. 当前不合理或不应执行的提案

1. 直接用 `workspace_exec node/tsx transform.ts`：违反真实隔离要求。
2. 让 Transform Host 在 TS Application Host 同进程 `eval/import`：代码执行和框架权限混在一起。
3. 用 transform 自报 digest 或只用 ID/version：无法防止代码/依赖漂移。
4. 将 transform 的 output receipt 直接转为 Publication artifact：绕过 Core admission。
5. 用 memory B3 扫描大表直到 OOM：应强制 disk mode 或 fail closed。
6. 把所有 ambiguity 交给 LLM：必须 typed decision + policy + Core replay。
7. 以六个 example 目录存在证明 capability 已迁移：必须逐 capability shadow/trusted E2E。
8. 在 Batch 2 未完成前设计 promotion 市场、全六族删除或通用 DAG：范围失控。

## 6. 最终验收问题

每个后续实现 PR 必须回答：

- 这个变更是 contract、Host、Core、example 还是 release 层？
- 输入是否 exact asset/result handle，是否有 ownership/hash closure？
- 代码执行是否在批准的 OS isolation backend 中？
- output 是否 quarantine、重哈希、strict parse、Core committed？
- implementation/runtime/dependency/policy digest 是否进入 checkpoint identity？
- 大数据是否 bounded/disk-backed？
- cancel/timeout/restart/late worker 是否有测试？
- ProductAssessment 和 Publication 是否来自同一 selected run/build/candidate？
- 是否至少有第二真实消费者，才称为 generic？
- legacy path 的删除条件、shadow evidence 和 rollback 是否具备？
