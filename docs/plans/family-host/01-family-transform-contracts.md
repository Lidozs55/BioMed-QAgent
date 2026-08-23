# FamilySpec、DatasetTransform 与执行收据契约

> 历史计划说明：本文件记录 Batch 0–2 契约设计。当前生产实现已采用 ADR-039 接受的显式 `in_process_unisolated` backend；涉及 sandbox availability/activation 的旧门槛仅适用于未来 isolated backend，不覆盖当前代码与 receipt。当前状态以 ADR-039、`docs/architecture/FAMILY-HOST-03-execution-constraints.md` 和 `docs/TODO.md` 为准。

## 1. 三个独立对象

### 1.1 FamilySpec

FamilySpec 只描述数据产品，至少绑定：

- `family_spec_id`、semantic version、canonical digest；
- projections、schemas、table definitions、relations；
- primary/supporting/derived roles；
- row granularity、identity/compatibility dimensions；
- transform capability refs 与声明输出；
- integration、validation、assessment policy refs；
- resource class request；
- scope、author/evidence refs。

FamilySpec 禁止包含源码、函数、任意 validator/merge expression、文件路径、网络权限、Publisher threshold、Core nodes/edges。

`canonical_digest` 的输入是 strict-parse 后、**排除自引用 `canonical_digest` 字段**的完整 FamilySpec body：对象键按 canonical JSON 排序、字符串按 NFC canonicalize，所有数组保持声明顺序（尤其 PK/relation tuple、projection/output/policy/evidence 声明）。`parseFamilySpec()` 只证明 wire shape；只有显式 `computeFamilySpecDigest()` / `verifyFamilySpecDigest()` 才证明 embedded digest 与 body 匹配。

### 1.2 DatasetTransform

所有 executable mapping 使用同一 ABI，不再区分“Agent transform”和“Trusted Extension”两套 runtime。Descriptor 至少包含：

- `transform_id`、version；
- normalized source digest、emitted bundle digest；
- compiler ID/version/options digest；
- runtime ABI/policy version；
- dependency closure digest；
- content-addressed code bundle ref；
- entrypoint；
- declared input roles/media constraints；
- declared output table/schema refs；
- bound FamilySpec/projection digest；
- determinism profile、resource class；
- origin、scope、review/verification refs。

v1 imports 仅允许 Transform SDK 和 Host 明确 allowlist；不允许任意 npm、native addon、Node builtin、dynamic import、eval、shell、child process 或 network。

Transform 不能决定 source acquisition、merge winner、validation threshold、ProductAssessment、PublicationCandidate 或 publication。

### 1.3 TransformExecutionReceipt

由 Transform Host 签发，至少绑定：

- task/run/build/invocation/attempt/generation；
- exact FamilySpec、projection、transform/bundle/compiler/runtime/policy digests；
- exact input asset/result IDs、SHA-256、roles；
- granted Host capabilities和资源上限；
- exit state、stable reason code；
- wall/CPU/RSS/temp/output/log usage；
- quarantined output file receipts；
- stdout/stderr/audit refs；
- cancellation/timeout/OOM状态；
- Host implementation digest和时间。

Host receipt 证明“这段 bytes 在该隔离策略下产生这些 quarantined bytes”，不证明科学语义正确，也不能直接满足 Publisher。若平台没有已证明的隔离 backend，receipt 必须使用 `sandbox_backend="unavailable" + exit_state="sandbox_unavailable"`，不得虚报 container/namespace/Job Object，也不得包含 worker exit 或 quarantined outputs。

## 2. Transform SDK

目标 API：

```ts
interface DatasetTransform {
  describe(): TransformDescriptor;
  run(ctx: TransformContext, input: TransformInput): Promise<TransformResult>;
}

interface TransformContext {
  openInput(assetHandle: string): AsyncIterable<Uint8Array>;
  createTableWriter(tableId: string, schemaRef: string): TableWriter;
  emitAudit(record: AuditRecord): void;
  checkpoint(state: JsonValue): Promise<void>;
  throwIfCancelled(): void;
}
```

SDK 不暴露真实 path、`fs`、`fetch`、`process`、credentials、Publisher 或任意 Core object。TableWriter 负责 row width/type/size、incremental count/hash、source locator 引用和 transactional close。

## 3. 内容与实现身份

`implementation_digest` 必须由 Host 计算，而非信任 Agent 声明：

```text
hash(
  normalized source bytes,
  emitted bundle bytes,
  compiler id/version/options,
  dependency closure,
  runtime ABI,
  Host policy version
)
```

同 ID/version 不同 bytes 必须拒绝或形成新 digest；checkpoint reuse 同时匹配 input、parameters、FamilySpec、implementation、runtime/policy digest。服务器固定 operation 也应逐步补齐真实 implementation version，避免代码升级后误复用。

## 4. Input / output ownership

- 输入只允许 task-owned registered SourceAsset 或 committed Core OperationResult handle；不接受 workspace/task-relative path。
- transform source 从 workspace 提交后复制到 Host-owned code quarantine，计算 digest；workspace 原文件不再是执行事实来源。
- worker 输出只进入 invocation-scoped quarantine root；Host 自己不能写 build publication root。
- Core 收到 receipt 后重新 hash、strict parse、验证 declared output closure，再生成 native OperationResultManifest。
- failed/cancelled Host execution保留不可误用的 execution receipt，但不产生 committed Core output result。

## 5. Build wire versioning

`DatasetBuildSpec 1.0` 保持完全兼容。禁止添加可选 `schema_refs`、transform path 或 FamilySpec blob。

动态路径另设 `DatasetBuildSpec 2.0`（名称在 Batch 0 contract review 冻结），至少引用：

- exact FamilySpec scope/id/version/digest；
- projection ref；
- source bindings/registered input requirements；
- exact transform refs/digests；
- Core-owned policy refs；
- output format；
- idempotency identity。

Agent 可以 author proposal；Family Host resolver 输出 fully resolved、digest-bound spec；Core 在执行前重新 admission。2.0 不允许 Agent设置 validation threshold、resource 上限以上的值或 arbitrary DAG。

Wire DTO 固定为 `DatasetBuildProposal2(spec_kind="proposal")` 与 `ResolvedDatasetBuildSpec2(spec_kind="resolved")` 两种 exact shape。Proposal binding 只有 `input_requirement_ref`；resolved binding 对 `registered_asset_ref` / `registered_result_ref` 要求 exactly-one。兼容入口 `parseDatasetBuildSpec2()` 是 resolved-only alias，不做 version/shape sniffing，也不接受 proposal/hybrid。

## 6. Contract 工作包

### C0：严格 DTO 与 parser

先进入 `@biomed/contracts`，exact keys、bounded arrays/strings、safe IDs、SHA-256、scope-qualified refs、unknown field fail closed。

### C1：canonical digest

冻结 canonical JSON、排序、Unicode、line endings、source normalization、compiler options和dependency closure算法。当前 contracts 已冻结 FamilySpec body、implementation digest 与 transform descriptor canonical bytes；raw JSON duplicate-key rejection仍属于 HTTP/JSON decoder边界，不能由已构造的 JavaScript object parser伪装实现。

### C2：Host/Core 双重 admission

Host验证 code/input/resource；Core验证 receipt/output/product。两者不得共享一个含糊的“validated”状态。

### C3：compatibility fixtures

保留 BuildSpec 1.0、Manifest 1.0/2.0、Publication 1.0/1.1 reader。新 contract 不原地改变历史 Publication。

## 7. 验收

- 任何 path/source code/function/unknown field 都不能混入 FamilySpec；
- 同 version 不同 source/dependency/compiler产生不同 implementation digest；
- receipt 缺少任一 input/output/runtime digest 时 Core 拒绝；
- Host success 不自动创建 OperationResult或Publication；
- BuildSpec 1.0 contract snapshot 不变；
- 2.0 proposal 与 resolved spec 分离，Core re-admission 可独立测试。
