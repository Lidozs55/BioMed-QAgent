# Plan: A5I Increment 3（无 replay 恢复）+ WP-A6（disk-backed integrate）

- 日期：2026-08-18
- Owner：A 组（`lidozs55xx-agent-trae`）
- 依据：[gold-trusted-publication-closure.md](./2026-08-18-gold-trusted-publication-closure.md) 的 WP-A5（161-183 行）与 WP-A6（185-200 行）
- 前置：A5I Increment 1+2 已合并进 main（`3a5a5db8`），typed ADR-030 `OperationResultManifest` 已在成功路径写入
- 约束：不触碰 `packages/contracts/**`（只读）；质量门禁 `pnpm typecheck` / `pnpm lint` / `pnpm --filter @biomed/server test` / `pnpm build`

---

## 1. Goal

两个独立工作包，可同分支分阶段交付，也可分两个分支（建议分两个分支，合并粒度更清晰）：

1. **A5I Increment 3**：删除 `rehydrateCheckpoint()` 中的 expensive replay（`REHYDRATE_RUNNER_KINDS`），改为从已落盘的 typed `OperationResultManifest` + 磁盘产物恢复 host-side 状态。达到 WP-A5 验收：restart 后 parse/canonicalize/integrate runner 调用次数为 0；删除/篡改 result file 使 reuse fail-closed 并仅重跑最小依赖闭包；publish 永不 replay；6 GB canonical output 的 checkpoint 校验不整文件读入。
2. **WP-A6**：用 SQLite temp table（`node:sqlite` `DatabaseSync`）替换 `integrator.ts` 中 O(unique rows) 的 `seen: Map<string, [value, assetId]>`。保留 canonical identity、first-source deterministic winner、dedup/conflict audit；设 temp disk quota 与明确 `resource_limit` 失败。达到验收：integrator parity（顺序、dedup、conflict、hash）不变；多源高基数低 heap 完成；peak JS heap 与 row count 不线性增长；temp disk/batch 数可观测。

## 2. 现状（已复核的事实）

### 2.1 executor（`server/src/dataset/runtime/executor.ts`）

- `REHYDRATE_RUNNER_KINDS: ReadonlySet<OperationKind> = new Set(["acquire","parse","canonicalize","integrate","validate_profile"])`（L156-165）。publish 刻意不在其中。
- `ExecutorOptions` 已有 `rehydrateCompletedRunners?: boolean`（L194），ts-core 传 `true`。
- `rehydrateCheckpoint()`（L325-368）：
  1. `!rehydrateCompletedRunners || state === null` 直接 return；
  2. `hasIncomplete = plan.some(op => state.completed_operations[op.operation_id] === undefined)`，**fully completed 时 return**（此时 publish 输出已在首次运行写盘，靠 `getOutput` 恢复）；
  3. 对每个 completed op：`findReusable`（digest 匹配）→ `loadOperationOutput(stateDir, {...}, signal)` 流式校验 file receipts 后返回 metadata（L182-228，file 用 `sha256FileStream` 逐文件流式，不整文件读入）→ 存入 `this.outputs[opId]`；
  4. **若 `REHYDRATE_RUNNER_KINDS.has(op.kind)` → `await this.executeOperation(op, this.availableUpstream(op))`** —— 这就是要删除的 replay。
- 成功路径已写 typed manifest：`writeOperationResult()`（L582-639）→ `saveOperationResultManifest(stateDir, manifest)`（`checkpoint.ts` L274-286，原子写 `<opId>_result.json`）。`output_summary = JSON.parse(JSON.stringify(result.output))`，即与 `loadOperationOutput` 返回的 `envelope.output` 内容一致。
- `loadOperationResultManifest(stateDir, operationId)`（`checkpoint.ts` L293-307）已存在：缺失/解析失败返回 null（fail-closed）。

### 2.2 ts-core（`server/src/dataset/service/ts-core.ts`）

- `runnerState: RunnerState`（L606-613）：`{ batches: Map, canonicalResults: CanonicalizationResult[], integration: IntegrationResult|null, manifest: DatasetManifest|null, validation: unknown|null, publicationId: string|null }`。
- `createTsCoreOperationRunner` 各 case 输出（从 checkpoint 恢复时 `outputs` 里可拿到）：
  - canonicalize：`{ binding_id, row_count, file, rejected_count }`
  - integrate：`{ row_count, dedup_count, conflict_count, merged_file }`
  - validate_profile：`{ status, checked_count, failed_count, manifest_digest }`
  - publish：`{ publication_id, version_dir, supersedes }`
- publish case（L518-546）依赖 `runnerState.manifest`、`runnerState.validation`、`runnerState.canonicalResults`（推导 `expectedSourceAssetIds`）。若 validate_profile 被 checkpoint 复用而 runnerState 未恢复，publish 会抛 `BuildError("validation result is missing before publish")` —— 这正是增量 3 要修复的恢复缺口。
- `executeDatasetBuild` 尾部（L663-667）已能从 `executor.getOutput("publish")` 恢复 `publication_id`（fully completed 场景）。
- validate_profile 落盘产物：`dataset_manifest.json`（`writeManifest`，L508）与 `validation_report.json`（`getBuild` L696-698 引用同名文件）—— 恢复时可直接读回。

### 2.3 integrator（`server/src/dataset/integrator/integrator.ts`）

- `integrate({results, mergeStrategy, schema, buildId, outputDir, signal})`（L66-199）。
- `seen = new Map<string, [value: string, assetId: string]>`（L97）—— A6 替换目标。key = `rowIdentity(row, idField).join("\u0000")`，idField ∈ `{probe_id, gene_id}`（L94-96）。
- 语义：first-source wins；`numericallyEqual(previousValue, value)` → dedup；否则 conflict 写 `merged/conflicts.csv`（`CONFLICT_COLUMNS`，L39-50）。
- 输出用 `BufferedCsvWriter` 流式写 `merged/primary.csv`，结尾 `sha256FileStream(mergedPath)` 算 asset（L157）。
- parity harness：`server/tests/integrator-parity.ts`（`checkIntegratorParity`，vitest-free）+ `server/tests/dataset-integrator.test.ts`（fixture 驱动，期望 `issues` 为空）。

### 2.4 SQLite 先例

- `server/src/settings/model-registry/migration.ts` L10 已 `import { DatabaseSync } from "node:sqlite"`（只读打开）。说明 `node:sqlite` 在当前 Node 22.19+ 环境可用、类型已装。

## 3. 技术栈

- Node 22.19+、TypeScript、`node:sqlite`（`DatabaseSync`，同步 API，配合现有 `CHECKPOINT_STRIDE` + `checkpoint(signal)` 让出事件循环）、vitest。
- 不新增 npm 依赖、不触碰 `packages/contracts/**`。

## 4. 任务

### Phase 1 — A5I Increment 3：无 replay 恢复

分支建议：`feat/dataset-rehydrate-no-replay`。

#### T1（红）：resume 场景 runner 调用 0 次

新测试文件 `server/tests/rehydrate-no-replay.test.ts`，复用 `operation-result-manifest.test.ts` 的 helper 模式（`binding`/`spec`/`sourceAsset`/`RecordingRunner`/`makeExecutor`）：

```typescript
import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatasetBuildExecutor, makeOperationOutput, type OperationSpec } from "../src/dataset/runtime/index.js";
// 复用：binding()/spec()/sourceAsset()/RecordingRunner/EXPECTED_OUTPUT_KINDS 等

test("resume 只调用未完成 op 的 runner（completed 的 parse/canonicalize/integrate 为 0 次）", async () => {
  const root = mkdtempSync(join(tmpdir(), "rehydrate-"));
  try {
    // 第一轮：完整跑完（不 resume），runner 记录 calls
    const first = new RecordingRunner();
    const ex1 = makeExecutor({ outputRoot: root, runner: first, rehydrateCompletedRunners: true });
    await ex1.run();
    const fullRun = [...first.calls];
    expect(fullRun.length).toBeGreaterThan(0);

    // 第二轮：同一 stateDir，plan 相同 → 全部 completed；hasIncomplete=false
    const second = new RecordingRunner();
    const ex2 = makeExecutor({ outputRoot: root, runner: second, rehydrateCompletedRunners: true });
    const outcome = await ex2.run();
    expect(outcome.status).toBe("completed");
    expect(second.calls).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("半途 resume：completed 的 parse/canonicalize/integrate 不重放，只跑 incomplete 闭包", async () => {
  const root = mkdtempSync(join(tmpdir(), "rehydrate-partial-"));
  try {
    // 第一轮：手动在 integrate 完成前中断（用 runner 抛 cancel 或只让部分 op 成功）
    // 简化：第一轮用 resumeFrom 制造 incomplete 状态（参考 dataset-runtime.test.ts 的 recovery 用例）
    // 第二轮：断言 calls 只包含尚未 completed 的 op，且不含已 completed 的 parse/canonicalize/integrate
    expect(true).toBe(true); // 占位：按 dataset-runtime.test.ts 的 interrupted 模式填充
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

> 注意：`makeExecutor` 需支持 `rehydrateCompletedRunners` 透传（当前测试 helper 未传，默认为 false）。

命令：`pnpm --filter @biomed/server test -- rehydrate-no-replay`（红：第二阶段 `second.calls` 非空——replay 会重跑 completed kinds）。

#### T2（红）：fully completed build 恢复 publish 输出与 manifest/validation

在 `server/tests/rehydrate-no-replay.test.ts` 增加：

```typescript
test("fully completed build：publish 输出、manifest、validation 全部从磁盘恢复", async () => {
  const root = mkdtempSync(join(tmpdir(), "rehydrate-full-"));
  try {
    // 第一轮完整跑完（用真实 ts-core runner，见 T5 前用 RecordingRunner 的替代：
    // 断言 executor 层 getOutput("publish") 有 publication_id）
    const runner = new RecordingRunner();
    const ex1 = makeExecutor({ outputRoot: root, runner, rehydrateCompletedRunners: true });
    await ex1.run();
    // 第二轮
    const ex2 = makeExecutor({ outputRoot: root, runner: new RecordingRunner(), rehydrateCompletedRunners: true });
    await ex2.run();
    const publishOutput = ex2.getOutput("publish");
    expect(publishOutput).toBeDefined();
    // ts-core 层断言（validate_profile 恢复后 manifest/validation 非 null）在 T5 实现后补真值
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

红：`getOutput("publish")` 目前第二轮的 `outputs` 会被 `loadOperationOutput` 填充（Increment 1 已实现），此测试大概率直接绿——真正红的是 ts-core 层 manifest/validation 恢复（见 T5 的断言）。T2 的核心作用是锁定"恢复 publish summary"这条链路，避免增量 3 实现时回退。

#### T3（红）：篡改 result file → fail-closed 重跑最小闭包

在 `server/tests/rehydrate-no-replay.test.ts` 增加：

```typescript
import { writeFileSync, readFileSync, rmSync } from "node:fs";

test("篡改 canonicalize 输出文件：fail-closed 且只重跑其下游闭包", async () => {
  const root = mkdtempSync(join(tmpdir(), "rehydrate-tamper-"));
  try {
    // 第一轮完整跑完
    const ex1 = makeExecutor({ outputRoot: root, runner: new RecordingRunner(), rehydrateCompletedRunners: true });
    await ex1.run();
    // 篡改：截断 canonicalize:srcbind_xena 的 canonical 输出文件
    const stateDir = join(root, "state");
    const manifest = loadOperationResultManifest(stateDir, "canonicalize:srcbind_xena");
    expect(manifest).not.toBeNull();
    const target = join(root, ...manifest!.output_files[0].relative_path.split("/"));
    writeFileSync(target, readFileSync(target, "utf8").slice(0, 16));
    // 第二轮：loadOperationOutput 对 canonicalize:srcbind_xena 返回 null → 该 op 及其下游重新执行
    const second = new RecordingRunner();
    const ex2 = makeExecutor({ outputRoot: root, runner: second, rehydrateCompletedRunners: true });
    const outcome = await ex2.run();
    expect(outcome.status).toBe("completed");
    expect(second.calls).toContain("canonicalize:srcbind_xena");
    // 最小闭包：srcbind_gdc 链不应重跑
    expect(second.calls).not.toContain("parse:srcbind_gdc");
    expect(second.calls).not.toContain("canonicalize:srcbind_gdc");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

红：当前 replay 逻辑在 `outputDigest` 匹配但 `loadOperationOutput` 返回 null 时**不重跑**（L347-356 的 if 内才重跑），且篡改的 op 会在 `runPlan` 中因 completed marker 存在而 skip——导致 build 以 stale 状态 "completed"。此测试锁定 fail-closed 重跑语义。

#### T4（绿）：executor 实现——删除 replay，新增恢复回调

改 `server/src/dataset/runtime/executor.ts`：

1. 删除 `REHYDRATE_RUNNER_KINDS` 常量（L148-165）及其 doc comment。
2. `ExecutorOptions` 新增：

```typescript
/**
 * Host-side state rebuild hook (increment 3): called for each checkpointed
 * completed operation whose output was digest-verified and loaded, with the
 * loaded metadata and the strict ADR-030 manifest (null when the manifest is
 * missing/malformed). Never re-runs the runner. Lets ts-core rebuild
 * runnerState (manifest/validation/integration/canonical binding ids) from
 * durable artifacts so the plan can continue without replay.
 */
onRehydratedOperation?: (
  op: OperationSpec,
  output: Record<string, unknown>,
  manifest: OperationResultManifest | null,
) => void | Promise<void>;
```

3. 构造器增加 `this.onRehydratedOperation = options.onRehydratedOperation ?? null;`（连同 private 字段声明）。
4. `rehydrateCheckpoint()` 改为：

```typescript
private async rehydrateCheckpoint(): Promise<void> {
  if (!this.rehydrateCompletedRunners) return;
  const state = this.state;
  if (state === null) return;
  // 完全完成的 build 无下游执行，输出已可从 outputs 恢复（getOutput）；
  // 不重跑任何 runner（publish 永不 replay 的既有保证）。
  const hasIncomplete = this.plan.some(
    (op) => state.completed_operations[op.operation_id] === undefined,
  );
  if (!hasIncomplete) return;
  for (const op of this.plan) {
    if (this.isCancelled()) return;
    const outputDigest = state.completed_operations[op.operation_id];
    if (outputDigest === undefined) continue;
    const scope = this.digestScope(op);
    const reusable = findReusable(
      state,
      op.operation_id,
      computeInputDigest(op, scope),
      computeParameterDigest(op, scope),
    );
    if (reusable === null || reusable.output_digest !== outputDigest) continue;
    const loaded = await loadOperationOutput(this.stateDir, {
      taskRoot: this.taskRoot,
      taskId: this.taskId,
      buildId: this.buildId,
      operationId: op.operation_id,
      operationAttemptId: reusable.operation_attempt_id,
      outputDigest: reusable.output_digest,
    }, this.cancellationSignal);
    if (loaded === null) {
      // 篡改/缺失：fail-closed——剥掉 completed 标记，让 runPlan 重跑最小闭包
      delete state.completed_operations[op.operation_id];
      saveBuildState(this.stateDir, state);
      continue;
    }
    this.outputs[op.operation_id] = loaded;
    const manifest = loadOperationResultManifest(this.stateDir, op.operation_id);
    await this.onRehydratedOperation?.(op, loaded, manifest);
  }
}
```

> fail-closed 关键：`loadOperationOutput === null` 时删除 `completed_operations[opId]` 并持久化。这样 `runPlan` 会重新执行该 op（digest 匹配 reuse 会失败，因为 reuse 校验 output 文件；真正重跑），其下游因 `upstream` 链自动重跑——正是"最小依赖闭包"。注意 phase-A 语义：重跑失败会进 `perBindingOutcomes` 拒绝路径，行为与首次一致。
>
> 另一处需同步：`writeOperationResult` 依赖 `upstreamResultManifestIds()` 从 `this.outputs` 取 attempt；重跑路径不变。`getOutput("publish")` 的 fully-completed 恢复路径不变。

5. 同步更新 `rehydrateCompletedRunners` 的 doc comment（L186-194）：不再"re-run stateful runners"，改为"从 checkpoint + result manifests 恢复 host-side state"。

#### T5（绿）：ts-core runnerState 恢复

改 `server/src/dataset/service/ts-core.ts`：

1. `executeDatasetBuild` 中 executor 构造增加 `onRehydratedOperation`：

```typescript
onRehydratedOperation: (op, output, manifest) => {
  // 重建 phase-B 所需的 runnerState（无 runner replay，仅读盘）
  if (op.kind === "canonicalize") {
    const bindingId = String(output.binding_id ?? "");
    if (bindingId !== "") rehydratedBindingIds.add(bindingId);
  } else if (op.kind === "integrate") {
    runnerState.integration = {
      batch: EMPTY_MERGED_BATCH,
      mergedPath: String(output.merged_file ?? ""),
      rowCount: Number(output.row_count ?? 0),
      dedupCount: Number(output.dedup_count ?? 0),
      conflictCount: Number(output.conflict_count ?? 0),
      conflictsPath: null,
    };
  } else if (op.kind === "validate_profile") {
    const manifestPath = join(outputDir, "dataset_manifest.json");
    const reportPath = join(outputDir, "validation_report.json");
    if (existsSync(manifestPath)) {
      runnerState.manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as DatasetManifest;
    }
    if (existsSync(reportPath)) {
      runnerState.validation = JSON.parse(readFileSync(reportPath, "utf8"));
    }
  }
},
```

2. 在 `runnerState` 定义旁新增恢复专用集合：`const rehydratedBindingIds = new Set<string>();`
3. publish case 的 `expectedSourceAssetIds` 推导改为同时纳入恢复的 binding ids：

```typescript
const expectedSourceAssetIds = new Set<string>();
for (const result of runnerState.canonicalResults) {
  const bindingId = result.batch.binding_id;
  const asset = bindingId in sourceAssets ? sourceAssets[bindingId] : undefined;
  if (asset !== undefined) expectedSourceAssetIds.add(asset.asset_id);
}
for (const bindingId of rehydratedBindingIds) {
  const asset = bindingId in sourceAssets ? sourceAssets[bindingId] : undefined;
  if (asset !== undefined) expectedSourceAssetIds.add(asset.asset_id);
}
```

> 说明：恢复场景下 `canonicalResults` 为空，`rehydratedBindingIds` 提供 phase-A-successful 集合（completed 的 canonicalize 才有 output）。`EMPTY_MERGED_BATCH` 用最小合法 `DataBatch` 占位（publish 不使用 integration 本身，仅 validate_profile 用它——而 validate_profile completed 时不会被重跑；该占位仅满足类型）。实现时若类型不匹配，可在 `RunnerState` 增加 `integration: IntegrationResult | null` 之外的独立字段，避免伪造 batch——以"不伪造数据、只恢复可证明事实"为原则，若 `merged_file` 缺失则保持 `null` 并让依赖方抛清晰错误。

4. `executeDatasetBuild` 返回值里 `manifest`/`validation` 直接用恢复后的 `runnerState.manifest`/`runnerState.validation`（现有 L673-674 已如此，无需改）。

#### T6（绿）：大文件 checkpoint 校验不整文件读入（流式回归）

`server/tests/dataset-runtime.test.ts` 已有 file-receipt 篡改测试。补一个显式断言：`loadOperationOutput` 对大文件用流式 hash（`sha256FileStream`），且**不**通过 `readFileSync` 整读。用 vitest `vi.spyOn` 断言：

```typescript
import { vi } from "vitest";
import * as fsModule from "node:fs";

test("loadOperationOutput 对大文件流式校验，不整文件读入", async () => {
  const spy = vi.spyOn(fsModule, "readFileSync");
  try {
    // 构造含 1 个 8MB 文件的 envelope（writeVerifiedEnvelope 已有模式）
    // 调用 loadOperationOutput → 非 null
  } finally {
    spy.mockRestore();
  }
  const bigRead = spy.mock.calls.find(
    (c) => typeof c[0] === "string" && (c[0] as string).endsWith(".csv"),
  );
  expect(bigRead).toBeUndefined();
});
```

> 若 `node:fs` 命名空间无法 spy（ESM 场景），改为检查 `sha256FileStream` 被调用（spy `server/src/dataset/adapters/hashing.ts` 导出）。红-绿判定：当前实现已流式，此测试首跑即绿——作为回归锁，不阻塞增量 3 实现。

**Phase 1 门禁**：`pnpm --filter @biomed/server test`（新测试全绿）→ `pnpm typecheck` → `pnpm lint` → `pnpm build`。之后按 AGENTS.md §7 提交并 merge（可先 push 分支，等 Phase 2 一起合，也可独立合——建议独立合，一个功能单元）。

### Phase 2 — WP-A6：disk-backed integrate

分支建议：`refactor/disk-backed-integrator`（依赖 Phase 1 的 `onRehydratedOperation`？——不依赖；integrator 内部改动，独立可合）。

#### T7（基线）：integrator parity 现状全绿

```bash
pnpm --filter @biomed/server test -- dataset-integrator
```

确认 `checkIntegratorParity` 返回空 issues。这是后续改动的回归基线。

#### T8（红）：高基数低 heap 基准测试

新文件 `server/tests/integrator-heap.test.ts`：

```typescript
import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGeneExpressionSchema } from "../src/dataset/schema/index.js";
import { integrate } from "../src/dataset/integrator/index.js";

function makeCanonicalRows(count: number): Array<Record<string, string>> {
  // 两源：srcbind_a 用 gene_g{i}，srcbind_b 用 gene_h{i}（i 不同则 identity 不重叠）
  // 每源 count 行；约一半行两源重复（dedup 路径），value 有数值相等与冲突两种情况
}

async function peakHeapDeltaMs(fn: () => Promise<void>): Promise<number> {
  const before = process.memoryUsage().heapUsed;
  let peak = before;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  }, 25);
  try { await fn(); } finally { clearInterval(timer); }
  return peak - before;
}

test("多源高基数：row count 4x 时 peak heap 增量不线性增长", async () => {
  const base = 25_000;
  const small = await peakHeapDeltaMs(() => runIntegrate(base));
  const large = await peakHeapDeltaMs(() => runIntegrate(base * 4));
  // 线性增长 ≈ 4x；有界增长应远小于 4x（宽松阈值，实现后标定）
  expect(large).toBeLessThan(small * 2.5);
});
```

红：当前 `seen: Map` 使 large 的增量约等于 small 的 4x（O(n) 内存），测试失败。阈值在实现后按实测标定并写入注释。

#### T9（红）：temp quota / resource_limit / 清理

在 `server/tests/integrator-heap.test.ts` 增加：

```typescript
test("temp disk quota 超限 → resource_limit 失败且清理 temp 文件", async () => {
  const root = mkdtempSync(join(tmpdir(), "integrator-quota-"));
  try {
    await expect(
      integrate({
        results: makeCanonicalResults(root, 50_000),
        mergeStrategy: "append_by_canonical_row",
        schema: buildGeneExpressionSchema(),
        buildId: "build_quota",
        outputDir: root,
        tempStore: { quotaBytes: 256 },
      }),
    ).rejects.toMatchObject({ name: "IntegratorResourceLimitError" });
    // temp db 已清理
    const leftovers = readdirSync(root).filter((f) => f.includes("integrate-temp"));
    expect(leftovers).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancel 中断时 temp db 被清理、merged 半成品被清理", async () => {
  // AbortController：读行中段 abort → integrate rejects（OperationAbortedError）
  // 断言 integrate-temp.sqlite 不存在、merged/primary.csv 不存在
});
```

#### T10（绿）：integrator 改 SQLite temp table

改 `server/src/dataset/integrator/integrator.ts`：

1. 顶部 `import { DatabaseSync } from "node:sqlite";`
2. 导出错误类型：

```typescript
/** Temp-store disk quota exceeded (WP-A6): fail closed, never OOM. */
export class IntegratorResourceLimitError extends IntegratorError {}
```

3. `integrate()` 签名新增可选 `tempStore?: { quotaBytes: number }`（默认提供合理上限，如 `256 * 1024 * 1024`，且可观测：`IntegrationResult` 增加 `tempStoreBytes: number`）。temp 文件：`join(outputDir, "integrate-temp.sqlite")`（任务路径内；`mergedDir` 同目录）。

4. 替换 `seen` Map 的核心循环（保持 first-source wins 语义逐字对齐现有逻辑）：

```typescript
const db = new DatabaseSync(tempDbPath);
try {
  // temp 语义：无需持久 WAL/fsync（可重建数据）
  db.exec("PRAGMA journal_mode=OFF;");
  db.exec("PRAGMA synchronous=OFF;");
  db.exec(`
    CREATE TABLE seen (
      ${idField} TEXT NOT NULL,
      sample_id TEXT NOT NULL,
      measurement_type TEXT NOT NULL,
      value_semantics TEXT NOT NULL,
      value TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      PRIMARY KEY (${idField}, sample_id, measurement_type, value_semantics)
    )
  `);
  const insertSeen = db.prepare(
    `INSERT INTO seen (${idField}, sample_id, measurement_type, value_semantics, value, asset_id) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const selectSeen = db.prepare(
    `SELECT value, asset_id FROM seen WHERE ${idField}=? AND sample_id=? AND measurement_type=? AND value_semantics=?`,
  );
  let visited = 0;
  for (const result of results) {
    for await (const row of readCsvDictRows(result.canonicalPath, signal)) {
      visited += 1;
      if (visited % CHECKPOINT_STRIDE === 0) {
        await checkpoint(signal);
        await enforceQuota(db, tempDbPath, quotaBytes);
      }
      const keyParts = rowIdentity(row, idField);
      const value = row["expression_value"] ?? "";
      const existing = selectSeen.get(...keyParts) as
        | { value: string; asset_id: string }
        | undefined;
      if (existing === undefined) {
        if (results.length > 1) {
          insertSeen.run(...keyParts, value, row["asset_id"] ?? "");
        }
        mergedWriter.writeRow(columns.map((column) => row[column] ?? ""));
        rowCount += 1;
        continue;
      }
      if (numericallyEqual(existing.value, value)) {
        dedupCount += 1;
        continue;
      }
      conflictWriter.writeRow([
        `conflict_${keyParts[0]}_${keyParts[1]}_${rowCount}`,
        keyParts[0], keyParts[1], keyParts[2], keyParts[3],
        existing.asset_id, existing.value,
        row["asset_id"] ?? "", value,
        "kept_first_source",
      ]);
      conflictCount += 1;
    }
  }
} finally {
  db.close();
  try { unlinkSync(tempDbPath); } catch { /* best effort */ }
}
```

> `idField` 白名单校验：仅 `"gene_id" | "probe_id"`（来自 schema.fields，仍防御性校验，避免列名拼接注入）。

5. `enforceQuota`：

```typescript
async function enforceQuota(
  db: DatabaseSync,
  tempDbPath: string,
  quotaBytes: number,
): Promise<void> {
  if (quotaBytes <= 0) return;
  let size = 0;
  try { size = statSync(tempDbPath).size; } catch { return; }
  if (size > quotaBytes) {
    throw new IntegratorResourceLimitError(
      `resource_limit: integrate temp store exceeded ${quotaBytes} bytes (${size})`,
    );
  }
}
```

> 插入前可另用 `SELECT COUNT(*)` 预检（batch 数可观测字段 `tempStoreRows`），避免超限才触发。

6. 现 `catch (error)` 分支（L147-153）已做 merged/conflicts 清理，保留；新增 temp db 清理在 `finally` 中。

#### T11（绿）：T8/T9 通过 + parity 回归

- 运行 T8/T9 测试：`pnpm --filter @biomed/server test -- integrator-heap` 全绿。
- 运行 T7 parity：`pnpm --filter @biomed/server test -- dataset-integrator` 仍绿（顺序、dedup、conflict、hash 与 Python fixture 一致）。
- 若 `merge_strategy`/`union` 别名、`IntegrationResult` 形状有测试依赖（如 `dataset-runtime.test.ts` 或 `operation-result-manifest.test.ts` 断言 `dedup_count`），同步更新但不改变语义。

#### T12（回归 + 门禁）

```bash
pnpm --filter @biomed/server test
pnpm typecheck
pnpm lint
pnpm build
```

全部通过后按 AGENTS.md §7 提交/merge；更新 `docs/TODO.md`（A5I 增量 3、WP-A6 勾选）+ Commonly `[DONE]`。

## 5. 执行 handoff

推荐 **inline 顺序执行**（T1→T6 串行改 executor/ts-core，同一批文件；T7→T12 串行改 integrator）。若时间紧可拆两个子代理：子代理 A 做 Phase 1（T1-T6），子代理 B 做 Phase 2（T7-T12），两者无共享文件（Phase 1 不碰 `integrator.ts`，Phase 2 不碰 `executor.ts`/`ts-core.ts`）。Phase 2 不依赖 Phase 1 的代码，可并行启动。

每个任务遵循 TDD：先跑测试确认红 → 实现 → 绿。合并前必须满足 AGENTS.md §7.3 全部质量门禁。
