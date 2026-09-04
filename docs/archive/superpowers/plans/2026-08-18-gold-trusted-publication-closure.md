# Gold 可信 Publication 收敛执行计划

> 状态：Historical execution record（2026-08-20 起不再作为当前任务队列）
> 日期：2026-08-18
> 跟踪：TASK-047、TASK-048
> 架构依据：`docs/ARCHITECTURE.md`、ADR-027
>
> 当前阶段、优先级与退出条件见
> [`Phase 4 → Phase 5 Hardening Roadmap`](../../plans/2026-08-20-phase4-to-phase5-hardening-roadmap.md)；
> 当前近期任务见
> [`Gold Evaluator Near-term Plan`](../../plans/2026-08-20-gold-evaluator-near-term-plan.md)。
> 本文保留迁移后可信 Publication 建设的历史依赖、验收和证据，不应继续以旧
> A/B/C worktree 状态驱动新开发。

## 1. 成功定义与基线

本轮 Gold 严格结果为 0/6。这里的 0/6 只表示没有 case 完成：

```text
request -> discovery -> acquire -> parse -> canonicalize -> compatibility
-> integrate/assemble -> validate -> provenance closure -> publish
-> downloadable trusted artifact -> final answer
```

不得将 fixture/core-logic 通过、research workflow 完成或 workspace 文件等同于
产品级 E2E pass。TASK-046 只证明 Pi 长上下文 continuation 不再假完成；它不关闭
TASK-047/048。

固定可信骨架继续保留，不引入 Agent 可编排 DAG。来源/载体（PubMed、PDF、figure、
PDB）不等于数据语义 family。`integrate` 继续负责同一 canonical table 内多来源合并、
去重与冲突；`assemble` 是后续将多张受信任表和 relation 组成 Publication candidate
的独立 operation，不做简单改名。

## 2. 交付与协作规则

开发者 B 的稳定任务 ID、contract spine 写锁和共享文件交接以
[开发者 B：可信多表 Publication 落实计划](2026-08-18-developer-b-trusted-publication-plan.md)
为执行台账；本文保留跨轨道目标与最终验收。

- 每个 WP 使用独立 worktree 和专用分支；一个 WP 对应一个完整 merge。
- 不并行修改同一 ownership 文件。跨轨道共享契约先合并，再让下游分支 rebase。
- 每个 bug fix 必须有 red-green 证据；每个新 feature 带 contract/unit/E2E 测试。
- 每个 WP 合并前执行根级质量门禁。真实大数据 benchmark 是 TASK-047 的额外门禁，
  不能由 synthetic fixture 替代。
- `docs/TODO.md` 只维护状态和本计划链接；架构理由进入 ADR/architecture 文档。
- Gold prompt、数据规模和成功标准冻结；不通过放宽 profile、增加 Node heap、减少数据
  或把 workspace CSV 当 artifact 获得“通过”。

## 3. 轨道与依赖

```text
TASK-048-B0 completed

B group: TASK-G0 -> TASK-048-B1
A group: TASK-047-A1 -> TASK-047-A2 -> A3/A4

TASK-048-B1 + TASK-047-A1 feedback -> TASK-C1C -> TASK-C1I(A)
TASK-048-B1 + TASK-047-A2 shape -> TASK-047-A5C -> TASK-047-A5I(A)
TASK-C1C -> TASK-C2C -> TASK-C2I(A)
TASK-048-B1 -> TASK-048-B3

TASK-048-B1 + TASK-047-A5C -> TASK-048-B2M
TASK-048-B2M + TASK-047-A5I -> TASK-048-B2W(A)
TASK-048-B1 + TASK-047-A2 + TASK-C1C -> TASK-048-B4M
TASK-048-B4M + TASK-048-B3 + TASK-C1I -> B4 trusted E2E

TASK-048-B1 + TASK-048-B3 -> TASK-048-B5C
TASK-048-B2M + B3 + B4M + B5C -> family module work
TASK-048-B2W + TASK-048-B4M completed + TASK-C2I -> family completion/admission

TASK-048-B6D + TASK-047-A5I -> TASK-048-B6W(A) -> TASK-048-B6B
TASK-048-B5C + TASK-048-B5L + TASK-048-B5T + TASK-048-B5V + TASK-048-B5S
  + TASK-048-B5A + TASK-048-B6A + TASK-048-B6B + TASK-C2I -> TASK-048-B7
TASK-047-A8 + TASK-048-B7 -> TASK-G1A(A) -> TASK-G1B -> TASK-G1R

TASK-C3C/TASK-C3I: P1 durable Build follow-up; not a current TASK-048/G1 blocker
```

B 组 contract spine 的 `merge_after` 写锁顺序为 B1 -> C1C -> A5C -> C2C；语义硬依赖
仍以各任务条目为准。B2 拆为 B 组 module (`B2M`) 与 A 组 runtime wiring (`B2W`)；B4M
可先实现 module，但 trusted E2E 必须等待 C1I+B3。C2 acquisition 可与 family module
开发并行，但 family completion、B6/B7 必须等待 C2I。任何 path 兼容入口都不能成为
registered-table publication 的临时信任来源。

## 4. Track A - TASK-047 全链 bounded-memory

### WP-A1 Core 前置资产解析流式化

**分支**：`fix/dataset-asset-stream-hash`

**状态**：已实现并验证（2026-08-18）。实现要点：`resolveReferencedAsset()`
改为 `sha256FileStreamWithSize()`（256 块/约 16 MB 粒度 yield，abort 可中断
GB 级文件）；`execute()` 先做 spec 校验再做任何 stat/hash（无效 spec 零文件
读取）；多文件串行解析；每绑定经 `onAssetResolved` 回调记录 bytes + hash wall
time（不记录内容；bridge wire shape 冻结，统计不进入响应）；hash 前 stat 的
size 与流式实读 bytes 不一致（TOCTOU）时抛 BuildError → fail-closed
`core_execution_error` envelope，不进入 Core。`resolveReferencedAsset` 导出供
受限 heap 子进程验收使用（64 MB heap 完成 256 MiB hash）。

**改动**：

- `server/src/dataset/service/dataset-core.ts`
- 将 `resolveReferencedAsset()` 的 `readFile()` hash 改为流式 hash，支持 AbortSignal；
- spec validation 必须早于文件 hash；多文件按受控并发/串行处理；
- 记录 bytes、hash wall time，不记录内容。

**验收**：

- 受限 heap 子进程对大 synthetic source/mapping hash 不 OOM；
- abort 中断 hash 且不进入 Core；
- hash/size/asset id 与旧实现 parity；
- 无效 spec 零文件读取。

### WP-A2 统一流式 SourceAdapter 输入

**分支**：`refactor/stream-source-adapters`

**改动**：

- `SourceAdapter.extract(rows[])` 改为 `AsyncIterable<DelimitedRow>`；
- GDC、Xena 不再走 Buffer -> gunzip Buffer -> string -> rows[]；
- 保持行号、空行、注释、数值拒绝和 golden parity。

**验收**：

- GDC/Xena gzip/plain 都流式；
- 低 heap 大 synthetic fixture 完成 parse；
- adapter golden byte/semantic parity；
- timeout/cancel 在输入扫描中生效。

### WP-A3 GEO supplementary/metadata bounded parser

**分支**：`fix/geo-supplementary-streaming`

**改动**：

- supplementary 首个有效行 sniff delimiter 后继续逐行；
- SOFT/sample metadata 只保留需要字段；
- 将 `metadata_files` 从 Tool/Service DTO 真正接入 `ExecuteContext` 和 GEO adapter；
- 加最大列数、单行长度、sample 数和 metadata bytes 限制；
- series-matrix/tximport 现有流式路径不回退。

**验收**：

- supplementary 不调用 `readSourceTextAsync()`；
- metadata asset 从 Tool 到 adapter 的 E2E 测试证明真实消费，而非 DTO 空转；
- metadata 边界超限产生 typed rejection；
- fixture parity 与 cancellation 通过。

### WP-A4 probe mapping 磁盘化

**分支**：`refactor/disk-backed-probe-mapping`

**改动**：

- annotation 流式解析至 task-local SQLite/分区文件；
- probe distinct、one-to-many/ambiguous、batch join 用磁盘索引；
- audit 用 bounded writer；canonicalizer 不持有全量 JS object map；
- temp store 受任务路径、quota、cancel 和清理约束。

**验收**：

- 现有 mapping parity；
- 高 probe cardinality 低 heap 完成；
- ambiguity/coverage/audit 完整；
- cancel/失败清理 temp store，不删可恢复 checkpoint。

### WP-A5 Operation Result Manifest 与恢复

拆分为：

- `TASK-047-A5C`（B owner，`feat/dataset-operation-result-contracts`）：ADR 与 versioned
  `OperationResultManifest` contracts；依赖 B1 + A2 文件形态反馈；
- `TASK-047-A5I`（A owner，`feat/dataset-operation-results`）：executor/checkpoint 实现；
  依赖 A5C + A2。

**实现改动**：

- parse/canonicalize/integrate/validate 成功时写 `result.json` + file receipts；
- checkpoint 保存 result ref；恢复时流式校验 receipt 后加载 metadata；
- 删除 `REHYDRATE_RUNNER_KINDS` 的 expensive replay；
- fully completed build 能从 result refs 恢复 manifest/validation/publication summary；
- operation output file hash 校验本身必须流式。

**验收**：

- restart 后 parse/canonicalize/integrate runner 调用次数为 0；
- 删除/篡改 result file 会使 reuse fail-closed 并仅重跑最小依赖闭包；
- publish 永不 replay；
- 6 GB canonical output 的 checkpoint 校验不整文件读入。

### WP-A6 disk-backed integrate

**分支**：`refactor/disk-backed-integrator`

**改动**：

- 用 SQLite temp table 或 external sort/merge 替换 O(unique rows) `Map`；
- 保留 canonical identity、first-source deterministic winner、dedup/conflict audit；
- 设 temp disk quota 和明确 `resource_limit` 失败。

**验收**：

- integrator parity（顺序、dedup、conflict、hash）；
- 多源高基数低 heap 完成；
- peak JS heap 与 row count 不线性增长；
- temp disk/batch 数可观测。

### WP-A7 bounded validation/provenance/publish

**分支**：`fix/bounded-release-tail`

**改动**：

- confidence overrides/provenance JSON 改分片或流式 sidecar；
- validation 合并可共享的 primary scans，所有扫描有列/行长度边界；
- manifest assembly 避免无必要的重复全 artifact hash；
- publisher 边 copy 边 hash/计数，copy 后与 manifest receipt 比对；
- `BuildStore.artifact()` 和 HTTP 下载只从 immutable publication root 读取，预验证
  receipt 后流式响应，不对多 GB artifact 使用 `readFile()`；
- publish 前评估 package disk budget，abort 不提升 version dir。

**验收**：

- confidence/provenance/validation/publish 各自低 heap 测试；
- hash 后源文件变化、copy 中变化、目标损坏均拒绝发布；
- disk quota/abort 无伪 publication；
- 大 artifact 下载 RSS bounded，下载后 hash 与 manifest 一致；可变 build 目录同名文件
  无法影响正式下载；
- artifact API 完整性测试保持通过。

### WP-A8 真实 GEO benchmark 与 TASK-047 封板

**硬依赖**：A1-A7 全部合并到同一基线。

**分支**：`eval/gold-large-geo-benchmark`

**脚本输出**（不提交原始大数据）：

- frozen eval manifest、prompt/schema hashes、accession/build id 与 source asset hashes；
- 精确 compressed/uncompressed bytes、commit、Node 版本、RuntimeLimits 和采样周期；
- peak RSS / heap used；
- 每 operation wall time；
- source/compressed/uncompressed/temp/published bytes；
- batches/parts/rows；
- artifact paths、sizes、hashes；
- validation/provenance closure；
- 默认 RuntimeLimits 和 Node 默认 heap。

**验收**：

- 约 6.1 GB 解压矩阵在默认配置完成 integrate -> validate -> publish；
- 正式四/五张表可读、manifest receipt 和 provenance 闭合；
- 不使用 `--max-old-space-size` 扩容作为修复；
- Artifact API 实际下载后 hash 与 publication manifest 一致；
- 结果写入 `docs/runs-log.md`，TASK-047 只有在此时勾选。

## 5. Track B - TASK-048 多表可信 Publication

### WP-B0 FamilyRegistry admission foundation

**状态**：completed（`main@b43c145`）

**交付**：ADR-027；Agent tool schema、默认 Schema Registry、生产 SpecValidator 共用
`DatasetFamilyRegistry`；严格 spec parser；真实 Schema/Adapter/Profile registration；
仅启用 expression family。此 WP 不宣称 Gold3-Gold6 artifact pass。

### WP-B1 Multi-table contracts v2

**分支**：`feat/multitable-dataset-contracts`

**先决**：新增 ADR；先改 `@biomed/contracts`。

**契约**：

- `TableDefinition`：table id、schema ref、role、required、allow_empty；
- `RelationDefinition`：from/to table+fields、cardinality、missing policy；
- `PublicationCandidate` / refs：primary、supporting、relations、provenance、confidence、audit；
- Manifest 2.0 `tables[]/relations[]`，reader 同时支持 1.0；
- SchemaField 分离 column required 与 nullable；
- SourceLocator 扩展 JSON pointer、XML/table cell、PDF page/table/figure、image bbox。

**验收**：exact-key parser、路径/ref 安全、PK/FK 引用、重复 table id、无 primary、
未知 schema/relation field 全部 fail-closed；1.0 publication 兼容。

### WP-B2 新增 assemble operation

拆分为 `TASK-048-B2M`（B 组 assembly module）和 `TASK-048-B2W`（A 组
runtime/checkpoint/publisher wiring），避免双方同时修改 runtime spine。

**改动**：

- 固定骨架为 canonicalize -> compatibility -> integrate[*] -> assemble -> validate -> publish；
- expression integrator 输出单表，expression assembler 包装单表 candidate；
- family definition 此时才绑定真实 canonicalizer/compatibility/integrator/assembler/
  validation/confidence/provenance handlers；
- Publisher 只消费 candidate/manifest，不出现 family `if/else`。

**验收**：expression publication 字节/布局兼容；operation topology/version 使旧 checkpoint
在 integrate/assemble 边界正确失效；缺 handler 的 family 无法注册。

### WP-B3 Generic table validation 与 relation gate

**分支**：`feat/multitable-validation`

**检查**：严格 header 顺序/宽度、数据类型/nullability、PK 唯一、FK/cardinality、
单位与 relation 操作符保留、每表 allow-empty、逐行 provenance/confidence/HIL。

**验收**：Gold reference schema 的正/负 fixtures；`<, >, =` activity relation 不丢失；
chart points 空表仅在 schema 明确 allow_empty 时通过；blocking VLM review 不发布。

### WP-B4 受信任通用 registered-table ingestion

执行 ID 为 `TASK-048-B4M`。Module 可在 B1+A2+C1C 后开始；trusted E2E 必须等待
B3+C1I。`adapters/adapters.ts` 仅在 A2 合并后的单一接线窗口临时交给 B 组。

**分支**：`feat/registered-table-adapter`

**改动**：CSV/TSV/JSON 结构化 SourceAsset -> registered table adapter；只接受
Core 登记 asset id/schema/locator，不接受任意 workspace path；来源专用 adapter 负责
官方响应到 canonical source table，不负责发布编排。

**验收**：workspace CSV 无法晋升；registered asset hash/locator/parser version 闭合；
JSON/CSV 行宽/类型错误有 audit；不执行 Agent 提供代码。

### WP-B5 可复用 biomedical schemas

**分支策略**：按 family 分支，不按 Gold case 分支。

建议最小 family：

- `target_evidence`；
- `variant_evidence`；
- `protein_structure`；
- `bioactivity_measurement`；
- `literature_evidence`。

Supporting schemas 可复用 entity、compound、assay、trial、paper、structure chain/ligand、
entity/compound crosswalk。`paper/figure/PubMed/PDB` 不直接作为 family 名。

每个 family 必须回答：主表是什么、一行是什么、PK/FK、measurement/unit/relation、
locator、confidence、validation、允许来源。每个 family 独立 merge，不能一次批量注册
没有 adapter/profile 的 22 张 schema。

### WP-B6a chart/VLM evidence 可信路径

**分支**：`feat/chart-vlm-evidence-publication`

**硬依赖**：`TASK-048-B3` + `TASK-048-B4M` completed + `TASK-048-B5C` +
`TASK-048-B5L` + `TASK-048-B5A` + `TASK-C2I`。

- chart series/points 带 estimated/exact、axis/legend status、model/version、bbox、review；
- confidence gate 与 Durable HIL 复用；人工接受只解除 review block，不自动提高证据等级。

**验收**：未审 low-confidence primary 不发布；axis/legend unclear 保留；人工 correction
产生 transform/review provenance。

### WP-B6b deterministic derive 可信路径

**分支**：`feat/deterministic-derived-evidence`

**硬依赖**：`TASK-048-B2W` + `TASK-048-B3` + `TASK-048-B5C` +
`TASK-048-B5V` + `TASK-048-B5S` + `TASK-048-B6D` + A-owner
`TASK-048-B6W` + `TASK-C2I`。

- 固定 derive operation slot，不开放动态节点；
- 记录注册算法、参数、输入 asset/reference version、output digest；
- PDB distance、sequence alignment 等衍生表不得伪装为 source record。

**验收**：derive 可复算；未注册算法和 Agent 代码拒绝；参数或 reference version 改变使
cache/checkpoint identity 失效。

### WP-B7 Gold3-Gold6 原样重跑

- prompt 不改、来源不降级、成功标准不放宽；
- 每 case 必须有 Publisher publication id、可下载 artifact、manifest/table/relation/
  provenance/confidence closure；
- workspace summary 只计 research evidence，不计 artifact pass；
- TASK-048 只有 Gold3-Gold6 全部满足严格验收后勾选。

## 6. Track C - 持久引用与 Build 生命周期

### WP-C1 Core-owned asset references

拆分为：

- `TASK-C1C`（B owner，`feat/core-source-asset-contracts`）：依赖 `TASK-048-B1` +
  `TASK-047-A1` 接口反馈；
- `TASK-C1I`（A owner，`feat/core-source-asset-registry`）：依赖 `TASK-C1C` +
  `TASK-047-A1`。

不依赖 B2。

- 新增 `register_source_asset` 或 acquisition registration contract；
- DatasetBuildSpec binding 引用 `asset_id`/acquisition query，不传 filesystem path；
- 路径参数保留一轮只读兼容并有退役遥测；
- Core 解析 asset id 到 immutable SourceAsset，Agent 不管理真实路径。

### WP-C2 Core-owned acquisition

拆分为：

- `TASK-C2C`（B owner，`feat/core-acquisition-contracts`）：依赖 `TASK-C1C`；
- `TASK-C2I`（A owner，`feat/core-owned-acquisition`）：依赖 `TASK-C2C` + `TASK-C1I`。

- `builtin`/`workflow_recipe` binding 由 acquire operation 真正执行 provider；
- browser/PDF/VLM 先 register immutable asset，再由 spec 引用；
- DownloadAttempt、cache identity、retry/resume 和 provenance 一致。

### WP-C3 Durable BuildScheduler 与异步 API（P1 后续）

拆分为：

- `TASK-C3C`（B owner，`feat/durable-build-contracts`）：依赖 C1C + A5C；
- `TASK-C3I`（A owner，`feat/durable-build-scheduler`）：依赖 C3C + A5I + C1I。

当前不阻塞 TASK-048/G1；若产品改变最终门禁，必须先更新 ADR/TODO。

**契约优先**：

```text
validate_dataset_build(spec)
start_dataset_build(spec) -> build_id
get_dataset_build(build_id)
cancel_dataset_build(build_id)
```

进程内 scheduler + durable filesystem/DB state；启动扫描非终态 Build 并恢复。不引入
Redis/Celery/BullMQ。Pi tool call 不持有 6 GB build 生命周期；terminal BuildResult 通过
durable task event 唤醒/继续 Pi。

**验收**：server restart 后 Build 独立存活；重复 start 幂等；cancel terminal ack；
Pi Session/Task/Run/Build 状态保持正交；前端/API 不从错误文本推断 Build 状态。

## 7. 冻结评测输入与最终 G1

在开发 family 或 benchmark 前，先提交受版本控制的 Gold eval manifest，包含 6 个原始
prompt、期望 family/granularity、允许来源标准、schema refs、输入/source hashes 和成功
定义。`data/gold` 被忽略且当前缺少 `SCHEMA_GAP.md`，不能作为唯一验收依据；大原始数据
不入库，但其 accession、bytes 和 SHA-256 必须冻结。

A8 与 B7 只是分轨证据。二者完成后必须在**同一 commit、默认资源限制、同一冻结 eval
manifest** 上执行 G1：Gold1-Gold6 全部原样重跑，并逐例记录 task/run/build/publication
ID、artifact inventory/hash、下载复核和最终答案。只有 G1 允许报告 Gold 6/6。

严格 Gold 6/6 必须同时满足：

1. Agent 正确规划并使用真实来源；
2. 所有 source values 可定位到 immutable SourceAsset；
3. Core 全链 bounded-memory；
4. family/schema/granularity/key/measurement/unit 明确；
5. relation 和 derivation 显式；
6. validation + confidence + HIL policy 通过；
7. provenance closure；
8. Publisher 原子提升并可通过 Artifact API 下载/复核；
9. 用户得到最终答案；
10. 同一组 6 Gold 原样运行，不修改 prompt/规模/标准。

在 G1 完成前，项目报告只能分别陈述 runtime、research、core scalability 和 trusted
publication coverage，禁止写“Gold 6/6”。

## 8. 当前可直接领取的 worktree

| Owner | 任务 ID | 分支 | 状态 | 下一任务 |
| --- | --- | --- | --- | --- |
| A | `TASK-047-A1` | `fix/dataset-asset-stream-hash` | ready | `TASK-047-A2` |
| B | `TASK-G0` | `docs/freeze-gold-eval-manifest` | ready | `TASK-048-B1` |

其余任务均有 prerequisite，不得提前领取。B 组完整队列与 contract spine 写锁见
[开发者 B 落实计划](2026-08-18-developer-b-trusted-publication-plan.md)。

开始每个 WP 前必须重新同步 `main`、检查 `git worktree list` 和远端分支，避免共享目录
切分支或重复 worktree。
