# WP-H：Publication、Evaluator 与 Release Activation

## 1. 目的

确保 Family Host 的动态性最终仍以可信产品和可复现发布为准，而不是以 capability 数量、tool 成功或 workspace 文件数量为准。

## 2. Publication closure

任何 Family/Projection 必须形成：

```text
task -> run -> build -> admitted inputs
     -> operation results/checkpoints
     -> candidate
     -> structural + semantic validation
     -> ProductAssessment
     -> Publisher
     -> manifest/artifact API
     -> downloaded bytes/hash parity
     -> final answer publication reference
```

Supporting table、mapping、rejected/conflict、assessment 不得只做磁盘 sidecar；需要按其语义决定是正式 table、derived artifact 还是 audit artifact，并都有 receipt、digest 和 candidate/manifest 引用。

## 3. Evaluator 分工

### H1：Production ProductAssessment

检查 package/projection 的 entities/relations/evidence/identifiers/provenance/confidence/reproducibility。状态 `incomplete`、`validated`、`publishable` 语义保持严格，unknown 不得自动通过。

### H2：Gold offline evaluator

继续使用 `docs/evaluation/gold-v1` 的冻结输入和 evaluator-owned requirements。它只读取 selected current publication 的 scoped bytes/receipts，不修改生产 runtime，不将历史 publication、legacy sidecar 或 workspace CSV 作为证据。

### H3：Evidence-chain repair

每个修复必须有 reproducing test、regression test、same-commit evidence。修复顺序由 discovery/trusted_input/contract/assembly/validation/publication/reproducibility 边界诊断决定，而不是按长期架构文档盲目扩张。

## 4. Capability activation

### 当前 family-level activation

在 activation model 未重构前，expression family 的 production cutover 至少要同时满足 gene/probe compatibility、GEO/GDC/Xena trusted source path、streaming/resource、cancel/checkpoint/lock/fence、semantic validation、ProductAssessment、artifact parity 和 frozen Gold1 rerun。

### 未来 capability-level activation

Family Host 可将状态细化到：

```text
family -> projection -> source capability -> version/status
```

只有 `production_activated` 的 capability 才能被 Agent 当作可执行能力；未完成 capability 必须显示 blocked/unavailable。Family 级 package 不能用一个 green flag 掩盖局部缺口。

## 5. Release gates

### R1：合同和回归

`pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm build`，contracts/server/frontend 重点 tests，全量旧 manifest/publication parser parity。

### R2：运行安全

默认 runtime limits 下的大输入、RSS/heap/temp quota、cancel、timeout、restart、checkpoint rehydrate、build lock/fence、permission recovery。

### R3：可信证据

SourceAsset ownership/hash/size、OperationResult dependency closure、relation/provenance/conflict/review refs、manifest artifact API download hash parity。

### R4：严格 Gold

固定 prompt/source/schema/acceptance 不变；六例只用同一 product commit 的完整 task/run/build/publication/final-answer evidence；Gold6 pending HIL 仍为 blocked；历史结果不混入当前 run。

### R5：回滚与兼容

legacy family/runtime parser、历史 publication、old schema reader、旧 Agent single-schema request 保持可读；新 activation 可关闭并回退旧路径，不删除 immutable artifact。

## 6. 完成条件

- 每个 activated capability 都有可信 E2E evidence，而非仅 declaration；
- assessment publishable 与 publication hash closure 同时成立；
- Gold evaluator 不再出现无法定位 boundary 的主要 blocker，或 unsupported capability 被明确记录；
- release checklist、supported topology、extension trust boundary 和取消/恢复语义冻结；
- 后续泛化只接受至少两个真实消费者的 reusable primitive。
