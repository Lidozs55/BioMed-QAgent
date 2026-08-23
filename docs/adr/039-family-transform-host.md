# ADR-039: FamilySpec 与受控 DatasetTransform Host

## Status

Accepted — 2026-08-22（原 Proposed / Deferred）。

当前批准的是**显式启用的进程内非隔离执行**，backend receipt 固定为
`in_process_unisolated`。它不是 sandbox、隔离机制或安全边界，不能用于抵御恶意
transform。当前范围明确不开发 container、IPC worker 或独立低权限 process backend。

`node:vm` 仅用于同步 wall-time interruption；它不提供权限、网络、文件系统、进程或
内存隔离。任何文档、UI、receipt 或 release evidence 都不得把它描述为 sandbox。

## Context

静态 `DatasetFamilyRegistry` 和 family-specific assembler 无法表达未知数据格式及冻结的
多表 topology。永久扩张领域分支会使 Core 同时承担动态格式转换与产品信任判断。
我们需要统一的声明式 `FamilySpec` + executable `DatasetTransform` 边界，同时保持
SourceAsset、OperationResult、B3、ProductAssessment、Publication 和 Artifact API 的
Core authority。

隔离执行不在本轮范围内。接受非隔离执行意味着 transform source 必须被视为拥有
Application Host 进程权限；AST deny list、`node:vm`、bounded SDK 和 timeout 只能减少
误用和失控，不是恶意代码防御。该风险必须由显式 opt-in 和产品部署信任模型承担。

## Decision

### 1. FamilySpec 与 DatasetTransform 分离

`FamilySpec` 是不含代码/path/DAG 的声明式数据产品契约，描述 projection、tables、
relations、identity、validation、assessment 和资源请求。`DatasetTransform` 是固定
ABI 的转换代码，绑定 exact FamilySpec/Projection/implementation digests、registered
input handles 和 declared outputs；它不能定义 arbitrary DAG、merge winner、validator、
ProductAssessment 或 Publisher。

### 2. 当前 backend：`in_process_unisolated`

当前唯一动态 backend 在 TS Application Host 进程内执行，必须满足：

- 调用方显式选择 `execution_backend=in_process_unisolated`；
- receipt 同样诚实记录 `in_process_unisolated` 和 `securityBoundary=false`；
- source 由 Host normalize/compile，bundle content-addressed，并在执行前重验 SHA-256；
- 输入只来自当前 task 的 registered immutable asset/result receipts，按 exact handle/order/
  owner/size/digest 重新验证；不向 transform 暴露路径、credentials 或 workspace API；
- bounded output/log、deadline、generation/cancel fence 在 admission 前生效；
- `node:vm` 只提供同步 timeout，不提供隔离；
- 该 backend 不接受 `sandbox`、`secure`、`isolated` 等能力声明。

未来若增加 isolated backend，必须单独 ADR，完成 OS identity、network deny、credential
stripping、read-only inputs、quota/hard kill/process-tree cleanup 和 cross-platform release
evidence。不得把当前 backend 原地改名为 sandbox。

### 3. Host receipt 不等于 Core trust

Transform 只产生 `TransformExecutionReceipt` 和 invocation-scoped bytes。Core 必须把
bytes 写入私有 quarantine、重新 hash、执行 closed-world output admission，并创建 native
`OperationResultManifest`。随后才可 materialize dynamic string-preserving schemas、运行
multi-table B3、创建 Core evidence、ProductAssessment 和 immutable Publication。

Agent、Transform、FamilySpec、workspace 和 Host receipt 都不能直接创建 Publication。

### 4. 严格 submission 与 identity

`submit_dynamic_family_build` 只接受 exact-key、descriptor-safe、digest-bound input：

- valid `FamilySpec` canonical digest 和 selected Projection digest；
- Host-compiled transform descriptor digest（首次 mismatch 会返回 expected digest，调用方
  必须用该 digest 重提；不能跳过 readmission）；
- `binding_id → asset_<sha256>` 的 task-owned registered source closure；
- 禁止 direct/workspace paths、discovery response bytes、unknown fields、Proxy/accessor objects、
  example scope 和 sandbox/security claims；
- `build_id` 只是 execution proposal identity，不能生成 dataset/provider revision identity。

### 5. Generic materialization and publication

FamilySpec 缺少科学 field types 时，dynamic tables 使用保守的
`dynamic_string_preserving.v1`；不得推断 numeric/unit/ontology/domain semantics。一个 native
multi-table OperationResult 可用 strict `output_summary.tables` 描述多表，但 summary keys 必须
精确闭合 projection tables。B3、Core-derived provenance/confidence manifests、
ProductAssessment、Publisher 和 Artifact API hash verification 仍是正式产品门禁。

包含 `review_status` 或 `human_review_status` 的 schema 必须 fail closed 为
`human_review_pending`。Core 必须在 B3 后创建候选、ProductAssessment 与 table bytes 绑定的
`publication_acceptance` HIL；只有 matching `accept` 可以发布，credential `approve` 不能满足该门，
accepted review identity/snapshot 必须进入最终 assessment/provenance。当前同一 live process 内支持
suspend/resume；跨 Host 重启 continuation 尚未完成，必须 fail closed。

### 6. Fixed slot, not Agent DAG

DatasetTransform 仅进入服务端固定 dynamic-family slot。Agent 不能提交 arbitrary
nodes/edges、merge function、validator、acquisition code 或 publication path。

## Consequences

### Positive

- 未知/冻结多表 topology 不再要求新增 family-ID dispatch；
- registered source receipts 到 immutable Publication 的同一 Core trust chain 可复用；
- non-isolated runtime 的限制和风险在 contract、receipt、docs 与 tests 中保持诚实；
- static registered runtime 继续兼容，动态路径不会放宽现有 provider boundary。

### Costs and risks

- transform code与Application Host同权限；恶意代码风险不由当前机制缓解；
- 进程级RSS/PID/open-file限制只是声明/门禁，不能像OS sandbox那样强制；
- 多进程Host并发写同一task event log的race仍需独立修复；Gold运行冻结期间必须只运行一个Host；
- `dynamic_string_preserving.v1` 只保证结构保真，不代表科学语义完整；
- evidence-bound publication HIL 已接入；跨 Host restart continuation、family-specific scientific
  assessment、production resource/identity hardening 与未来isolated backend仍是独立工作；
- 当前 Host/Core 主链可作为 `main` 稳定基线，但这不等于 Gold release gate 已通过。

## Relationship to Earlier ADRs

- ADR-027：静态 registry 保持兼容 facade；dynamic topology 不增加 family-ID branches。
- ADR-033/034：PublicationCandidate 和 provider acquisition 继续 Core-owned；discovery bytes 不是 carrier。
- ADR-036：dynamic transform 和 deterministic derive 都是 fixed slot，不是通用 DAG。
- ADR-038：registered inputs、digest、B3、ProductAssessment 和 Publisher authority 保持不变。
