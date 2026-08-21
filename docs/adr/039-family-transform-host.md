# ADR-039: FamilySpec 与受控 DatasetTransform Host

## Status

Proposed — 2026-08-21。

本 ADR 是 `docs/plans/family-host/` v2 计划的目标决策，不代表当前仓库已经具备动态 Transform Host。接受前，Agent-authored transform 仍遵守 ADR-034/038 的 candidate-only 限制。

## Context

当前 Dataset Core 通过静态 `DatasetFamilyRegistry`、registered adapter、family assembler 和固定 operation skeleton 提供已注册数据能力。Agent 可以发现和整理未知数据，但无法为新数据格式提出可执行的正式转换逻辑。另一方面，当前 `workspace process.exec` 是同 OS 账户下的授权命令执行，明确不是 sandbox；`worker_threads`、`node:vm` 和普通 `child_process` 也不能单独安全执行不可信 TypeScript。

现有六个 Family 是有价值的生产回归样例，但把它们永久扩张为六套 Core 领域框架会继续增加 family/provider/assembler 分支。需要一个统一、受控、可复现的动态转换边界，同时不能把 Agent 变成 Publisher 或任意 DAG 编排器。

## Decision

### 1. FamilySpec 与 DatasetTransform 分离

`FamilySpec` 是不含代码的声明式数据产品契约，描述 projection、schema、table/relation、identity、compatibility、integration、validation、assessment 和资源请求。

`DatasetTransform` 是统一的可执行转换 ABI，声明输入 asset/result handles、输出 schema/table、FamilySpec digest、实现/编译器/依赖/runtime/policy digest 和 determinism profile。它不选择 merge winner、validation threshold、ProductAssessment、PublicationCandidate、Publisher 或任意 DAG。

不再把“Agent transform”和“Trusted Extension”设计为两套 executable ABI。来源、scope、执行状态、复用状态和 activation 独立记录；统一 ABI 不等于统一信任等级。

### 2. Transform Host 是独立隔离执行面

Transform 必须在独立进程或等价容器中执行，不能在 TS Application Host 中 `eval/import`，也不能使用 workspace `process.exec` 作为生产执行器。受支持 backend 必须提供低权限 OS identity、输入只读、独立 quarantine 输出、网络 deny、凭据不继承、CPU/RSS/PID/disk/open-file 限制、hard timeout kill、process-tree cleanup 和 worker generation fence。

若目标平台不能提供等价隔离，Agent-authored transform 保持 disabled；不得降级为同账户 spawn、`node:vm` 或 `worker_threads`。

### 3. Host receipt 不等于 Core trust

Host 只产生 `TransformExecutionReceipt` 和 invocation-scoped quarantine output。Core 必须重新 hash、严格解析声明输出、检查 source locator/input closure、创建 native `OperationResultManifest`，然后执行 compatibility partition、deterministic integration、B3、科学语义验证、ProductAssessment 和 Publisher。

Agent、Transform Host、workspace、FamilySpec 均不能直接创建正式 Publication。

### 4. 固定 slot，不引入 Agent DAG

DatasetTransform 只能进入服务端声明的固定 slot。Agent 不能提交 nodes/edges、任意 merge function、任意 validator 或 acquisition WorkflowRecipe code。WorkflowRecipe 仍只负责受控 acquisition 并产出 SourceAsset。

### 5. Family 的长期形态

现有六个 Family 逐 capability 迁移为 `examples/families/` 下的 retrieval-based reference examples，承担 few-shot、SDK example、fixture、shadow parity 和回归用途。Example 不被 Core import、启动扫描或自动注册为 production capability。只有 exact scope/id/version/digest 的 capability 经过 Host fixture、Core shadow、trusted E2E 和 activation gate 后才能启用；legacy path 按 capability 逐项退休。

### 6. 兼容和版本

`DatasetBuildSpec 1.0` 不增加 `schema_refs` 或 transform path。动态路径使用新的版本化 DTO，引用 exact FamilySpec/Projection/Transform digests；Core 重新 admission。现有 SourceAsset、OperationResult、checkpoint、B3、ProductAssessment、Publisher 和历史 Manifest/Publication readers 保持兼容。

## Consequences

### Positive

- Agent 可以为未知格式提出可执行转换，但代码执行有独立隔离面；
- Core 仍是唯一产品信任和 Publication 权威；
- 领域 Family 可从 Core hardcode 逐步迁为可检索参考实现；
- 同一 Transform ABI 避免两套扩展运行时；
- implementation digest、input receipt、quarantine、Core gate 和 replay 保证可审计。

### Costs and risks

- 必须先实现真实 OS/container isolation，不能用 Node 内置机制冒充 sandbox；
- compiler/bundle/dependency/runtime identity、资源和 deterministic replay 需要新 contract；
- `registered_multitable.runtime.v1` 旁路必须先回到通用 executor 生命周期；
- 只有两个真实消费者证明 primitive 可复用后，才能推广为 generic；
- Windows 等平台若无等价隔离只能禁用动态 transform。

## Relationship to Earlier ADRs

- ADR-020：当前代码已完成 Python Core 迁移；本 ADR 提议保留 Core deterministic admission/integration/validation/assessment/publication，而把领域转换放入受控 Host，接受后需正式 supersede 历史 Phase 0/1 ownership wording。
- ADR-027：静态 Family Registry 先保留为 DatasetBuildSpec 1.0 compatibility facade，最终由 admitted FamilySpec/capability resolution 逐步替代。
- ADR-028：现有 `TableRole` 不加入 `audit`；processing audit 使用独立 audit artifact contract。
- ADR-033：保留 Core-only PublicationCandidate，长期用 contract-driven assembly 替代 family-specific handler registry。
- ADR-034：registered adapter 继续只接受 Core asset receipt 和 registered parser；Agent transform 走独立 Host，不放宽 adapter 边界。
- ADR-036：fixed deterministic derive slot 保留；DatasetTransform 也是 fixed slot，不是通用 DAG。
- ADR-038：ProductAssessment、digest、registered inputs、resource/no-network 和 Publisher 边界保留；“promoted before any execution”改为 sandbox execution 与 publication activation 分离。
