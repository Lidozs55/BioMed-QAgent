# BioMed-QAgent 开发 TODO

> 当前主线：**FamilySpec + Core deterministic primitives** 收敛；ADR-039 Transform Host 路线已 **Deferred**。
> 详细设计见 `docs/plans/family-host/`（`00-overview` … `09-execution-matrix`）。
> 本文件将计划拆为 4 个开发者组 A/B/C/D，按「**冻结契约类型**」一层解耦，使各组尽量并行推进。
> 文档 `10-consistency-review` 为一致性审查，不单独列任务。
>
> 当前范围不开发sandbox backend、IPC worker或Agent-authored transform execution；已有disabled Host/fixture/proof modules保持fail closed，**不得**接默认build route、不得激活Agent-authored transform、不得删除static runtime。
> 当前承诺截止：完成A/C非-sandbox contracts、identity、B3、fixed slot、checkpoint/release/publication verification；Host execution与其shadow/release evidence移入Deferred backlog。
>
> **2026-08-22 red-team 状态**：`808279ac` 仅是初始 DTO/计划草案；其 wire-parser 缺口已由
> `76df8008`、`3ed0ade5`、`f32f563f` 关闭：descriptor-safe own-data parsing、dense/finite/safe-number
> 检查、strict identity scheme、bounded safe ID/ref、receipt terminal/resource/output/cancel closure、
> BuildSpec 2.0 proposal/resolved 分离、FamilySpec canonical digest known vector 均有 adversarial tests。
> M1 仍等待独立 post-hardening review、纯 Core BuildSpec re-admission，以及未来 HTTP/JSON ingress 的
> raw duplicate-key decoder边界；因此 B/C 仍只可做 disabled/isolated fixture 或 staging pure module，
> ADR-039 与 M3 activation 继续阻塞。

## 全局质量门（每次提交必过）

- 代码：`pnpm test` / `pnpm lint` / `pnpm typecheck` / `pnpm build`；涉及 `database/` 时另跑 Python bridge gates。
- Deferred Transform Host代码不得新增production wiring；若未来恢复，须重新启用sandbox/red-team、resource、cancel/restart、digest/replay、Artifact API hash全套门禁（来源 `09-execution-matrix.md §9`）。
- 每个实现分支合并前须提供：契约版本/digest、trust/status、resource evidence、tests、same-commit artifact refs、rollback plan，并明确冻结的 `submitted / sandbox_executable / fixture_verified / shadow_verified / trusted_e2e_verified / activated / revoked / retired` 状态；retrieval-only example 表示为 `scope=example + status=submitted`，不是另一个 trust status（来源 `04 §2`、`09 §8`）。

## 分支命名（来源 `09-execution-matrix.md §8`）

| 组 | 建议分支 | 覆盖任务 |
|---|---|---|
| A | `feat/transform-contracts` | T0-T3 |
| B | `feat/transform-host-sandbox` | T5-T7 |
| C | `feat/core-transform-admission` + `feat/dataset-validation-disk-index` | T4/T8-T11 |
| D | `feat/expression-host-shadow` + `feat/bioactivity-host-shadow` | E1/E2/E3/R1 |

## 并行模型（最大化并行，最小化组间阻塞）

- **解耦原则**：组间依赖只发生在「冻结契约类型」一层，**不发生在实现层**。计划文档 `01/02/03` 定义目标形状；
  hardened contracts 可驱动 isolated fixture / staging pure-module 开发，但在 Core re-admission 与独立复核关闭前仍不可视为 production activation ABI。
- **A 是唯一被依赖的组**，但只交付冻结的 DTO/parser/digest 算法/identity/B3 接口（一个小而明确的首批 PR），随后 B/C/D 并行。
- **B（Host 生产者）与 C（Core 消费者）互相并行**：两者都针对 A 冻结的 `TransformExecutionReceipt` / `FamilySpec` /
  identity 类型编码；C 的 admission/checkpoint 用冻结 Receipt 类型 + 测试夹具驱动，**不依赖 B 的 worker 实现**。
  B 与 C 仅在 D-E2 集成执行时汇合。
- **D 的示例/目录编写与 B/C 并行**（对照冻结契约）；只有 E2 的 shadow 执行、E3 的 go/no-go、R1 的 release 核对
  在 B+C 合入后作为**集成闸门**进行。

### 当前里程碑

- **M1（A contracts）**：`@biomed/contracts` DTO/parser/digest/identity/B3接口。
- **M2（C + D静态资产）**：Core admission/validation/disk/fixed-slot/release verification；examples保持retrieval-only。
- **Deferred M3**：真实Host execution、D-E2 shadow执行、E3真实第二消费者与R1 activation核对；不计入当前完成条件。

## 目录归属（各组独立目录，减少 merge 冲突）

| 组 | 主要目录 |
|---|---|
| A | `packages/contracts/**`、`server/src/dataset/contracts/**`、`docs/adr/039-*` |
| B | `server/src/dataset/transform-host/**`（新建） |
| C | `server/src/dataset/execution/**`、`server/src/runtime/**`、`server/src/dataset/validation/**`、`server/src/dataset/integration/**` |
| D | `examples/families/**`（新建）、`server/src/dataset/adapters/**`、expression/bioactivity runtime、Publisher、集成测试 |

## 全局 guardrail（违反即回退，来源 `10-consistency-review.md §5` / `08-activation-release.md §7`）

**停止条件（任一触发立即停 activation，回到 contract/security/closure 修复）：**
Host 不是实际 OS sandbox；implementation digest 不覆盖 bundle/dependency/runtime；quarantine output 能绕过 Core；B3 大表仍无界 `Map`；只有一个真实消费者；或 ProductAssessment 与 Publication identity 不一致。

**禁止提案：** ① `workspace_exec node/tsx transform.ts`；② 同进程 `eval/import` Agent code；③ transform 自报 digest 或只用 ID/version；④ output receipt 直接转 Publication artifact；⑤ memory B3 扫大表到 OOM；⑥ 所有 ambiguity 交 LLM（须 typed decision + policy + Core replay）；⑦ 以六 example 目录存在证明 capability 已迁移；⑧ Batch 2 前设计 promotion 市场/全六族删除/通用 DAG。

**每 PR 必答（来源 `10 §6`）：** 变更属于 contract/Host/Core/example/release 哪层？输入是否 exact asset/result handle + ownership/hash closure？代码是否在批准隔离 backend？output 是否 quarantine→重哈希→strict parse→Core committed？digest 是否进入 checkpoint identity？大数据是否 bounded/disk-backed？cancel/timeout/restart/late worker 有测试？ProductAssessment 与 Publication 是否同 selected run/build/candidate？是否至少第二真实消费者才称 generic？legacy 删除条件/shadow evidence/rollback 是否具备？

---

## 开发者 A — Contracts & Foundations（首批 PR，解除 B/C/D 阻塞）

> 本组交付**冻结契约类型**，是 M1 的唯一产出；不依赖其他组。B/C/D 对照本文档与计划直接开工。

- [x] **A-T0** ADR-039 proposal + 威胁模型 + 平台/沙箱 backend 支持矩阵
      - 设计：`00-overview.md §7`、`03-transform-host-security.md §1/§3`
      - 产物：Proposed ADR-039、threat-model 文档、sandbox backend decision（含 Windows 达标/不达标结论）
      - 验收：明确 production 仅允许独立低权限 OS/容器 backend；Windows 不达标则该平台禁激活
      - ⚠ 不得修改已 accepted ADR 的历史 Decision 文字以隐藏冲突（`09 §3` 禁止）
- [x] **A-T1** FamilySpec / DatasetTransform / TransformExecutionReceipt / BuildSpec 2.0 契约（依赖 A-T0）
      - 状态：strict DTO/parser/canonical digest、raw JSON duplicate-key ingress、proposal/resolved wire shape 与纯 Core readmission 已落地；readmission绑定 exact capability/asset/result、task/build/generation/receipt evidence；不代表已接生产 runtime
      - 设计：`01-family-transform-contracts.md`（全）、`09 §2 T1`
      - 产物：`@biomed/contracts` strict DTO + parser、canonical digest fixtures（**冻结形状，供 B/C 消费**）
      - 验收：`DatasetBuildSpec 1.0` snapshot 不变；2.0 proposal 与 resolved spec 分离、Core re-admission 可独立测试；unknown field fail closed
      - ⚠ FamilySpec **禁止**含源码/函数/任意 validator/merge expression/文件路径/网络权限/Publisher threshold/Core nodes（`01 §1.1`）；**禁止**把 `schema_refs` 塞入 BuildSpec 1.0
- [ ] **A-T2** identity / projection / relation / audit 契约（依赖 A-T0）
      - 状态：三层 identity、revision-scoped V2 schema primitives、probe mapping validator 与 staging authoritative identity context 已落地；仍缺 `DatasetCore` task-owned registration receipt 传递和生产 adapter wiring
      - 设计：`02-product-identity-relations.md`（全）、`09 §2 T2`
      - 产物：`dataset_id` / `dataset_revision_id` / `asset_id` 三层身份、sample 复合键、`probe_gene_mapping` coverage relation（`many_to_many` + `profile_defined`）、`AuditArtifactDefinition`（**不新增** `audit` TableRole）
      - 验收：同 sample 不同 revision 不碰撞；audit row 不计入产品 table/row count 或 assessment requirement；`integrator.ts` 中 `dataset_id = buildId` 路径有红灯测试与迁移计划
      - ⚠ 一个 Schema 不能同时表达 gene_sample 与 probe_sample（`02 §1`）
- [ ] **A-T3** implementation identity digest（依赖 A-T1）
      - 设计：`01-family-transform-contracts.md §3`、`09 §2 T3`
      - 产物：bundle/compiler/dependency/runtime/policy digest 算法 + checkpoint invalidation 规则（**B 计算、C 校验共用**）
      - 验收：同 version 不同 source/dependency/compiler → 不同 implementation digest；checkpoint reuse 同时匹配 input/params/FamilySpec/implementation/runtime/policy digest
      - ⚠ digest **必须由 Host 计算**，而非信任 Agent 声明（`01 §3`）

---

## 开发者 B — Transform Host（Deferred，不再开发）

> B-T5已落地的disabled fixture保留为fail-closed guard。B-T6/B-T7及任何sandbox/IPC/Agent-code execution整体暂缓，不阻塞A/C非-sandbox任务完成。

- [x] **B-T5** compiler / admission spike（依赖 A-T1、A-T3 冻结类型）
      - 状态：Host-owned source normalization/AST policy/transpile/digest/content-addressed store已落地；结果固定为 `fixture_only_unexecutable`，不等于B-T6 sandbox
      - 设计：`03-transform-host-security.md §2`、`01 §2 SDK`、`09 §2 T5`
      - 产物：source normalization、AST/import policy、content-addressed bundle receipt（产出符合 A-T1 冻结形状）
      - 验收：v1 仅允许 Transform SDK/Host allowlist；无任意 npm/native addon/dynamic import/eval
      - ⚠ 静态检查只缩小攻击面、**不能替代隔离**（`03 §2`）
- [ ] **B-T6 [Deferred]** isolated Transform Host MVP（依赖 A-T0、B-T5）
      - 设计：`03-transform-host-security.md §3`、`09 §2 T6`
      - 产物：独立低权限 worker/backend、opaque asset handles、quarantine output、hard kill
      - 验收：无网络/DNS/代理、不继承凭据、不挂载 repo/workspace/settings/Publication；symlink/junction/device escape fail closed
      - ⚠ `worker_threads` / `node:vm` / 同账户 `child_process` / workspace `process.exec` **均不能**当安全边界（`03 §1`、README 永久边界）；Windows 不达标则禁激活
- [ ] **B-T7 [Deferred]** Host protocol / receipt（依赖 A-T1、A-T3、B-T6）
      - 设计：`03-transform-host-security.md §4`、`01 §1.3`、`09 §2 T7`
      - 产物：framed versioned IPC、invocation/generation/quota/cancel、terminal reason、TransformExecutionReceipt 签发（符合 A-T1 冻结形状，含全 digest + input/output receipts + resource usage）
      - 验收：Host success 不自动创建 OperationResult/Publication；receipt 缺任一 input/output/runtime digest → Core 拒绝
      - ⚠ 执行前后重新核验 code/input digest 关闭 TOCTOU；receipt 只证明“bytes 在该隔离策略下产生”，不证明科学语义（`03 §4/§6`）

---

## 开发者 C — Core Admission, Execution Slot & B3 Disk（信任平面，与 B 并行）

> 依赖 **A 冻结类型**（T1/T2/T3）。**不依赖 B 实现**：针对冻结 `TransformExecutionReceipt` 类型 + 测试夹具实现
> admission/checkpoint；与 B 仅类型耦合，M3 前不汇合。

- [ ] **C-T4** B3 / resource baseline（依赖 A-T2 冻结 identity 类型）
      - 状态：`d2153aa1` 已由 Core-receipted bytes 做 bounded measurement、cancel-aware preflight、Map 前阈值拒绝和 v2 telemetry；disk wiring、production measured threshold 与 immutable descriptor snapshot仍缺
      - 设计：`05-core-execution-product-gate.md §4 B3-D0`、`09 §2 T4`
      - 产物：现有 `validation/multitable.ts` benchmark/telemetry（row/key estimate、validator mode、heap/temp/duration/failure reason）、阈值、large-input benchmark harness（memory parity oracle）
      - 验收：超阈值强制 disk mode 或 fail closed，不再无界 `Map` 到 OOM
- [ ] **C-T8** Core quarantine admission（依赖 A 冻结类型 T1/T2/T3）
      - 设计：`05-core-execution-product-gate.md §1/§6`、`03 §6 quarantine handoff`、`09 §2 T8`
      - 产物：Host 输出重哈希、schema/locator/output closure 校验、native OperationResultManifest 构造
      - 验收：未声明文件/table/schema 拒绝；locator 不得指向未知输入；failed/cancelled Host 不产生 committed Core output
      - ⚠ 针对**冻结 Receipt 类型**解码，用测试夹具驱动单测；Host output receipt **不得**直接转 Publication artifact（`10 §5#4`）
- [ ] **C-T9** fixed transform slot（依赖 A-T1 冻结类型、C-T8）
      - 状态：server-owned fixed-slot admission 与 hostile-input tests 已落地为 staging-only；未接 `registered_multitable.runtime.v1` 或默认 Agent build route
      - 设计：`05-core-execution-product-gate.md §6`、`09 §2 T9`
      - 产物：server-owned plan slot、transform capability admission、不引入 DAG
      - 验收：`registered_multitable.runtime.v1` 旁路问题登记并有统一 executor 修复门，不在旁路继续叠加 transform
      - ⚠ Batch 1 不得接默认 Agent build tool；Transform 不能决定 merge winner/validation threshold/ProductAssessment/Publication（`01 §1.2`、`03 §6`）
- [ ] **C-T10** checkpoint / lease / recovery（依赖 A-T3 冻结 digest、C-T9）
      - 设计：`05-core-execution-product-gate.md §6`、`08-activation-release.md §4 R4`、`09 §2 T10`
      - 产物：Host/Core owner fencing、orphan cleanup、publish reuse 修复
      - 验收：cancel/timeout/restart/stale worker/late commit 不误提交；publish 必须重验证 authoritative receipt，或禁止 publish shortcut；固定 operation 的 implementation identity 绑定真实部署版本
- [ ] **C-T11** B3 disk mode（PK/FK first hotspot）（依赖 A-T2 冻结 identity 类型、C-T4）
      - 设计：`05-core-execution-product-gate.md §4 B3-D1/D2`、`09 §2 T11`
      - 产物：disk-backed tuple index（quota/cancel/batch tx/cleanup、确定性 key encoding）、memory parity
      - 验收：memory/disk B3 fixture 的 checks/ordering/digest parity；复用同一 index 支持 cardinality/relation；不新增 `family.id ===` 语义分支
      - ⚠ 不一次性重写 B3，也不将 scientific validation 混入 B3（`05 §4`）

---

## 开发者 D — Examples Catalog & Vertical Slices（编写与 B/C 并行，执行为集成闸门）

> **编写阶段**（examples/fixtures/catalog/retrieval-metadata）依赖 **A 冻结类型**，与 B/C 并行。
> **执行/核对阶段**（E2 shadow、E3 go/no-go、R1 release）为 M3 集成闸门，需 B+C 合入。

- [x] **D-E1** expression examples（编写依赖 A-T2 冻结 identity 类型；fixture执行仍受B-T6阻塞）
      - 状态：GEO gene/probe + GDC gene retrieval fixtures、revision/identity/mapping assertions与metadata已落地并由真实contracts/helper验证；scope=example/status=submitted，无DatasetTransform/Registry副作用
      - 设计：`06-expression-vertical-slice.md`、`07-family-examples-migration.md §4`、`04-catalog-scope-resolution.md`、`09 §2 E1`
      - 产物：`examples/families/gene-expression/`（GEO gene/probe、GDC gene）、projection examples、dataset revision、mapping assertion fixtures、`retrieval-metadata.json`
      - 验收：example 目录不产生 Registry side effect、不自动注册为 production capability；`examples/` 不被 `server/src` import 或扫描
      - ⚠ 不得以目录名/文件名代替 exact digest；example 不直接执行（`07 §2`、`04 §6`）
- [ ] **D-E2 [Deferred]** expression shadow vertical slice（依赖未来恢复的B-T6..T7）
      - 设计：`06-expression-vertical-slice.md`、`08-activation-release.md §3`、`09 §5`
      - 产物：Host→Core→assessment→artifact 奇偶比对、shadow publication/artifact hash parity、rollback 演练
      - 验收：GEO/GDC 共享 integration framework 但仅兼容 partition 内 merge；GDC 无 probe mapping 时诚实声明 unsupported/allow-empty；大输入不走全量 Buffer/object[] 或无界 B3 Map；task/run/build/Host receipt/Core result/validation/publication 证据完整
      - ⚠ shadow 失败不自动 fallback 成功；通过只代表 shadow verified，不自动激活 family（`08 §3`、`06 §5`）
- [ ] **D-E3 [Deferred]** second real consumer — bioactivity_measurement（依赖未来恢复的B-T6..T7）
      - 设计：`07-family-examples-migration.md §4.2`、`09 §6`
      - 产物：bioactivity example 复用相同 Host/Core path 的证据
      - 验收：输入/output topology 可由 FamilySpec 描述，不依赖新 family-specific Core branch；至少一个 capability 可做独立 shadow/rollback
      - ⚠ 不满足则退回 contract/primitive 修复，不扩展到其余四族（`09 §6`）
- [ ] **D-R1 [Deferred]** Transform Host release / go-no-go（依赖未来恢复的D-E2、D-E3）
      - 设计：`08-activation-release.md`（全）、`09 §5-6`
      - 产物：trusted E2E、rollback、activation 建议、release gates **R1-R5** 核对（contract/security/Core gate/operational recovery/representative E2E）
      - 验收：仅当 R1-R5 全过且至少两个真实消费者才建议 activation；legacy 删除须满足 `08 §6` 七条件
      - ⚠ 触发 `08 §7` 停止条件时立即停

---

## 保留项（非 family-host 高价值未完成，从旧 TODO 迁入）

> 以下与 family-host 正交，不受 ADR-039 冻结影响，按原优先级推进。

### P1
- [ ] **model-registry wire-boundary 校验**：`frontend/src/api/modelRegistry.ts` 仍用窄化 cast（`b as ProviderInfo[]`）；在 `packages/contracts` 增加 `parseProvidersEnvelope` / `parseManagedModelsEnvelope` 解析器（ADR-025 后续项）。
- [ ] **Phase 9 后续 — HIL/Questionnaire**：`UserInputDialog` 迁移到同一 Questionnaire 基础设施。
- [ ] **Phase 9 后续 — 权限设置页重排**：默认层与高级 ACL 编辑器。
- [ ] **AI 用户支持文档**：面向其他 agent 的调用文档 + 启动/HTTP-WS 封装脚本。

### P2
- [ ] **createPhase3ToolHooks 并发 identity bug**：同源多查询共用 `operation_id: tool:<source>:query` 互相覆盖 UI 卡片；应改为 call-scoped ID（hangs on `fix/runtime-timeline-sequence` 未含）。
- [ ] **Phase 9 后续 — 权限事件进入历史 Conversation timeline**。
- [ ] **Agent INSTRUCTIONS**：增加“达到 max_turns 后输出 `[MAX_TURNS_REACHED]`”指导。
- [ ] **设置页供应商/模型列表分页与搜索后端**（当前全量返回）。

### P3
- [ ] **沙箱环境 [Deferred]**：通用数据安全sandbox及Transform Host隔离均暂缓；未经新的明确决策不开发。

---

## 并行工作流（不在本拆分内，但为 D-R1 的 release gate）

- **Gold 可信 Publication 收敛（TASK-047 / TASK-048）**：TASK-047 大型 GEO 矩阵流式化 A8 基线已合并（`59b8b6af`），剩余 A1-A7 收尾；TASK-048 多表 family publication（B2W/B5*/B6*/B7）在飞；G1B/G1R 为最终同 commit 复跑与报告。严格 Gold 仍为 0/6，same-commit evidence 是 D-R1 的 release gate 之一。继续按原 board 推进，不在 family-host 分支修改 Gold prompt/source inventory/acceptance threshold。
