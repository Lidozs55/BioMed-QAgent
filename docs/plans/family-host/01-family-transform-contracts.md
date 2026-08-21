# FamilySpec、DatasetTransform 与执行收据契约

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

Host receipt 证明“这段 bytes 在该隔离策略下产生这些 quarantined bytes”，不证明科学语义正确，也不能直接满足 Publisher。

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

## 6. Contract 工作包

### C0：严格 DTO 与 parser

先进入 `@biomed/contracts`，exact keys、bounded arrays/strings、safe IDs、SHA-256、scope-qualified refs、unknown field fail closed。

### C1：canonical digest

冻结 canonical JSON、排序、Unicode、line endings、source normalization、compiler options和dependency closure算法。

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
