# Activation、Publication、Evaluator 与 Release

## 1. Publication closure

任何 Transform/Projection 要进入 activated，必须形成完整证据链：

```text
task -> run -> build -> admitted inputs
  -> transform invocation/receipt
  -> Core quarantined-output admission
  -> OperationResult
  -> compatibility/integration
  -> B3 + semantic validation
  -> ProductAssessment.publishable
  -> PublicationCandidate
  -> Publisher
  -> manifest/artifact API download
  -> recomputed hash parity
  -> final-answer publication reference
```

Host receipt、exit code、CSV 存在、BuildResult succeeded、历史 publication 或 workspace sidecar 均不能替代这条链。

## 2. Status 与 activation

按 exact scope/id/version/digest 的 capability 记录：

```text
example_only
host_fixture_verified
core_shadow_verified
trusted_e2e_verified
activated
revoked
retired
```

- `activated` 是 release capability，不是代码可信标签；
- Agent-authored transform 即使 sandbox_executable，也不能跳过 Core gate；
- `revoked` 阻止新 invocation，保留历史 immutable Publication；
- `retired` 只有在旧调用者、reader、rollback 和 architecture guard 均闭合后使用。

## 3. Shadow release

shadow 使用冻结输入和独立 output root：

- legacy 与 Host 结果不共享可发布目录；
- 比较 schema/table、row/key、relation、provenance、assessment、resource、digest；
- 差异进入 audit evidence，不改 current publication；
- shadow 失败不自动 fallback 为成功；
- activation 前必须有取消、重启、stale worker 和回滚演练。

## 4. Gold 与 ProductAssessment

Gold evaluator 仍是 offline/evaluator-owned：不改变 prompt、source inventory、acceptance threshold，不把 Gold case 表名写进 production FamilySpec。它只接受 selected current publication 的 scoped artifact bytes、receipt 和 exact package/requirement identity；`publishable` 才能通过 semantic product，`validated` 为 unknown，pending HIL 为 blocked。

Gold closure 与 Batch 0 contract/threat model 可以并行，但 Gold evidence 不应反向扩大 Batch 0 scope。Batch 2 expression shadow 是否满足 Gold 由 same-commit trusted E2E 单独决定。

## 5. Release gates

### R1：Contract / compatibility

`@biomed/contracts` strict parser、BuildSpec 1.0 parity、新 2.0 parser、Manifest/Publication legacy readers、exact digest resolution、unknown field fail closed。

### R2：Transform Host security

目标平台真实 OS isolation；无网络/凭据/path escape；compile/import policy；CPU/RSS/PID/disk/output/log quota；hard kill；cancel/fence；红队测试。

### R3：Core product gate

quarantine rehash、OperationResult closure、partition/integration、B3、semantic validation、actual provenance、ProductAssessment、Publisher/artifact hash parity。

### R4：Operational recovery

Build lock、DurableBuildStore lease、worker generation、checkpoint rehydrate、cancel/timeout/OOM、orphan cleanup、publish receipt revalidation。

### R5：Representative E2E

至少两个真实消费者共用 Transform Host contract 和 Core integration/validation path；expression 的大输入通过 bounded/disk-backed 路径；历史 static runtime 可回滚。

## 6. 删除旧路径的条件

逐 capability 而非一次性删除：

1. 无 production caller 仍依赖旧分支；
2. host shadow/trusted E2E 与历史 projection 差异已解释；
3. old manifest/publication reader 仍可用；
4. activation/revoke/rollback 有证据；
5. Core architecture guard 禁止新增 family ID/provider dispatch；
6. 当前 Gold/Release evidence 不依赖被删除的 sidecar；
7. 删除后全量 quality gates 通过。

## 7. 停止条件

若 Host 不是实际 OS sandbox、implementation digest 不覆盖 bundle/dependency/runtime、quarantine output 能绕过 Core、B3 大表仍无界 Map、只有一个真实消费者或 ProductAssessment 与 Publication identity 不一致，立即停止 activation，回到 contract/security/closure 修复。
