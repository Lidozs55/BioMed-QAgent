# FAMILY-HOST-05: B3 生产资源/磁盘 lane（C-T4/C-T11 production wiring）

> 状态：Implemented（2026-08-23，`feat/family-host-b3-resource`）。
> 本文档记录生产 B3 资源/磁盘 lane 的接线决策与残余限制；不修改共享文档。

## 1. 目标

把已测量的资源策略（`resource-baseline.ts`）与既有 SQLite TupleIndex
（`disk-index.ts`）接到生产 multitable B3（`publishDynamicFamily` →
`validateMultiTableCandidate`），使超阈值校验**显式选择安全磁盘模式或 fail
closed**；PK 优先，FK/cardinality 复用同一 tuple index；保持 memory/disk
checks 顺序与 digest parity、quota/cancel/cleanup、显式磁盘选择后不回退内存、
无 family 语义分支。

## 2. 接线结构

```
publishDynamicFamily (production lane)
  └─ validateMultiTableCandidate(request, signal, {
       resourceBaseline: { policy: PRODUCTION_B3_RESOURCE_POLICY,
                           configuredHeapBytes/TempBytes, telemetrySink → resource_report.json },
       b3Backend: { owner: {taskId, buildId, generation: receipt.generation},
                    factory: createProductionB3DiskFactory(),
                    snapshotImmutable: true,
                    parityProof: PRODUCTION_B3_PARITY_PROOF,
                    cleanup: task-owned b3-index dir removal,
                    directory: <taskRoot>/builds/<buildId>/b3-index,
                    quotaBytesPerIndex, batchSize } })
  └─ decideB3Backend (b3-backend-decision/index.ts, 纯决策 gate)
       memory  |  disk  |  reject（factory/snapshot/parity/owner/cancel/cleanup/temp quota 任一缺失 → reject）
  └─ disk mode：每表每个唯一 PK/FK/relation combo 一个 owner-bound TupleIndex
       PK uniqueness → index.primaryKeyCheck()
       FK/cardinality → checkRelationIndexes(from, to, {referencedRowCount}) 复用同一 index
```

- `b3-backend-decision` gate 从 staging-only 变为生产决策边界：`validateMultiTableCandidate`
  在 preflight 测量后调用 `decideB3Backend`；gate 仍纯函数（无 I/O，绝不调用 factory）。
- `MultiTableB3BackendOptions` 替代原 `stagingPrimaryKeyDiskIndex`（PK-only、拒绝 relations
  的临时路径已删除）。
- `RelationIndexCheckOptions.referencedRowCount`：`allow_empty` 的 referenced-empty 判定
  与 memory 扫描的 rowCount（含 malformed rows）对齐，保证 memory/disk 完全一致。
- 显式磁盘选择后任何失败（quota/cancel/ownership/scan）→ throw（fail closed），
  created indexes 在 finally 中全部 cleanup；任务级 b3-index 目录由 cleanup capability 兜底。

## 3. 生产策略与基准证据

- `PRODUCTION_B3_RESOURCE_POLICY`（`b3-production-multitable.v1`）：
  memoryThreshold 256 MiB、heapQuota 512 MiB、tempQuota 8 GiB、row overhead 24 B、
  key-entry overhead 72 B、tuple-field overhead 8 B、maxRowChars 1 MiB、maxFieldChars 512 KiB。
  effective threshold = min(policy, configured) → 首字节超阈即 disk/reject，不再无界 Map。
- 同 commit 估算器基准（`server/tests/ct4-resource-baseline-bench.run.ts`，
  本分支 HEAD 处运行）：100,000 次决策 ≈ 34 ms（≈2.9M ops/s），50M 行 × 2 key 输入
  → 13.6 GB 估算 → fail closed `temp_quota_exceeded`。这是 estimator 常数空间算术证据，
  不是行扫描吞吐测量；任何阈值调整需在同一 commit 重新产出代表性基准。
- `PRODUCTION_B3_PARITY_PROOF` = 已提交证据文件
  `server/tests/fixtures/b3-memory-disk-parity-v1.json` 的 SHA-256 + ref。
  证据文件记录 memory/disk 同一 relation fixture（parents/children、many_to_one FK、
  1 missing + 1 duplicated FK 值）的 checks digest parity（11 checks，digest 相同）。
  `b3-memory-disk-parity.test.ts` 同时重算文件 digest 与 live memory/disk digest，
  防止漂移；`b3-memory-disk-parity.gen.run.ts` 重新生成证据。

## 4. 验收对照（C-T11）

- [x] memory/disk checks 顺序与 digest parity（PK + FK/cardinality，fixture 断言 toEqual + canonicalDigest）
- [x] 同一 index 复用支持 cardinality/relation（checkRelationIndexes + referencedRowCount）
- [x] 超阈强制 disk 或 fail closed；显式 disk 选择后无 memory fallback
- [x] owner（task/build mismatch → gate owner_mismatch，创建后 ownerBinding 复查）、
  quota（per-index SQLite quota + 总预留 ≤ effectiveTempQuota）、
  cancel（addBatch abort → cleanup）、cleanup（finally + task dir）测试覆盖
- [x] 生产 wiring：resource_report.json 记录 memory/disk/reject 模式与测量事实；
  e2e 强制 disk（memoryThreshold=0）发布成功且 b3-index 目录被清理；temp 超限发布 fail closed
- [x] 无 `family.id ===` 语义分支；legacy 无 options 调用者结果形状不变

## 5. 残余限制（明确不做/未做）

- **FK/cardinality 覆盖范围**：disk 模式为每个唯一 combo 建独立 index（PK 与 relation
  同 fields 时共享同一 index）；宽表多 relation 时磁盘用量约为 Σcombo，未做索引合并优化。
- **temp 上限 8 GiB**：估算 temp 超过 effective quota 直接 reject（fail closed），
  不尝试降级为部分磁盘/分批模式；超大表需先确认配额。
- **generation 语义**：生产 owner generation 取 `execution.receipt.generation`
  （当前动态 build 恒为 0，与 transform context 一致）；gate 的 `late_generation`
  在 validator 接线中不可达（owner 单一来源），由 gate 单测直接覆盖。
- **legacy 调用者**（families、registered-multitable 等未传 options 的 B3 调用）
  仍走原小输入路径，不构成 Family Host 大输入 admission；后续如需统一需逐个接线。
- **parity digest 排除项**：证据 digest 排除 `trusted_root`（detail 含绝对路径）与
  `resource_baseline`（detail 含所选 mode）；两者不参与 memory/disk 等价性。
- 已知 flaky（与本分支无关）：`tests/phase5/hil-timeout-suspension.test.ts` 在
  `pnpm test` 并发下偶发 `resolvePending` 时序断言失败，单跑稳定；未在本分支改动。

## 6. 验证命令

```bash
pnpm --filter @biomed/server exec vitest run tests/b3-memory-disk-parity.test.ts \
  tests/b3-production-policy.test.ts tests/ct4-multitable-resource-preflight.test.ts \
  tests/b3-backend-decision.test.ts tests/disk-index.test.ts tests/dynamic-family-build-tool.test.ts
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm --filter @biomed/server exec tsx tests/ct4-resource-baseline-bench.run.ts   # 策略基准证据
pnpm --filter @biomed/server exec tsx tests/b3-memory-disk-parity.gen.run.ts     # 重新生成 parity 证据
```
