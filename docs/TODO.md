# BioMed-QAgent 开发 TODO

> 当前主线：**FamilySpec + Core deterministic primitives + 显式非隔离动态执行** 收敛；ADR-039 已接受 `in_process_unisolated` production route。
> 详细设计见 `docs/plans/family-host/`（历史批次计划）与当前约束 `docs/architecture/FAMILY-HOST-03-execution-constraints.md`。
>
> 当前范围明确**不开发** sandbox/container/IPC worker/独立低权限process backend。`in_process_unisolated` 不是sandbox、隔离机制或安全边界；`node:vm`只用于同步timeout。
> 当前动态流程已接入：registered receipts → compile/digest closure → unisolated execute → quarantine/native OperationResult → B3/ProductAssessment → evidence-bound HIL → immutable Publication。该 Host/Core 主链已达到可合入 `main` 的稳定基线；后续 hardening、identity/recovery/resource wiring、专用前端 UX 与 family 产品闭包继续使用独立分支/worktree。
> 当前仍未满足 release：必须在一个最终冻结 commit、单 Host 上完成 Gold1–Gold6 可信证据，Gold6 必须等待真实 publication acceptance；应用 provider 的账户可用性是 live rerun 的外部前置条件。
>
> **2026-08-22 red-team 状态**：初始 DTO/计划草案的 wire-parser 缺口已关闭：descriptor-safe own-data parsing、dense/finite/safe-number 检查、strict identity scheme、bounded safe ID/ref、receipt terminal/resource/output/cancel closure、BuildSpec 2.0 proposal/resolved 分离、raw duplicate-key ingress、纯 Core re-admission 与 FamilySpec canonical digest known vector 均有 adversarial tests。当前未关闭项以 A-T2/A-T3、C-T4/C-T10/C-T11 和 Gold release gate 为准，不再把已落地的 non-isolated production route 描述为 staging-only。

## 全局质量门（每次提交必过）

- 代码：`pnpm test` / `pnpm lint` / `pnpm typecheck` / `pnpm build`；涉及 `database/` 时另跑 Python bridge gates。
- 动态production wiring必须诚实声明`in_process_unisolated`并保留registered input、digest、resource/cancel、quarantine、native result、B3、ProductAssessment、Publication与Artifact API hash全套门禁。未来isolated backend须独立ADR，不得把当前backend改名为sandbox。
- 每个实现分支合并前须提供：契约版本/digest、trust/status、resource evidence、tests、same-commit artifact refs、rollback plan，并明确冻结的 `submitted / sandbox_executable / fixture_verified / shadow_verified / trusted_e2e_verified / activated / revoked / retired` 状态；retrieval-only example 表示为 `scope=example + status=submitted`，不是另一个 trust status（来源 `04 §2`、`09 §8`）。

## 分支命名（来源 `09-execution-matrix.md §8`）

| 组 | 建议分支 | 覆盖任务 |
|---|---|---|
| A | `feat/transform-contracts` | T0-T3 |
| B | `feat/family-host-runtime-hardening` | T5/T7 与 non-isolated runtime hardening；isolated T6 Deferred |
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
- **M3（当前release gate）**：显式非隔离Host execution与Core publication flow已落地；等待同一冻结commit/单Host的Gold1–Gold6证据，Gold6另需真实HIL acceptance。

## 目录归属（各组独立目录，减少 merge 冲突）

| 组 | 主要目录 |
|---|---|
| A | `packages/contracts/**`、`server/src/dataset/contracts/**`、`docs/adr/039-*` |
| B | `server/src/dataset/transform-host/**`（新建） |
| C | `server/src/dataset/execution/**`、`server/src/runtime/**`、`server/src/dataset/validation/**`、`server/src/dataset/integration/**` |
| D | `examples/families/**`（新建）、`server/src/dataset/adapters/**`、expression/bioactivity runtime、Publisher、集成测试 |

## 全局 guardrail（违反即回退，来源 `10-consistency-review.md §5` / `08-activation-release.md §7`）

**停止条件（任一触发立即停 activation，回到 contract/security/closure 修复）：**
把`in_process_unisolated`宣称为sandbox；implementation digest不覆盖bundle/dependency/runtime；registered input或quarantine output能绕过Core；B3越过resource gate；或ProductAssessment与Publication identity不一致。

**禁止提案：** ① `workspace_exec node/tsx transform.ts`；② 把`node:vm`/同进程执行称为隔离；③ transform自报digest或只用ID/version；④ output receipt直接转Publication artifact；⑤ memory B3扫大表到OOM；⑥ ambiguity交LLM代替typed/Core replay；⑦以example/static fixture称trusted E2E；⑧通用Agent DAG。

**每 PR 必答（来源 `10 §6`）：** 变更属于contract/Core/example/release哪层？输入是否exact asset/result handle + ownership/hash closure？output是否strict parse→Core committed？digest是否进入checkpoint identity？大数据是否bounded/disk-backed？cancel/timeout/restart有测试？ProductAssessment与Publication是否同selected run/build/candidate？不得以example/fixture称generic。若未来恢复Host路线，才额外回答批准隔离backend、quarantine/late-worker、第二真实消费者、shadow/rollback等Deferred门禁。

---

## 开发者 A — Contracts & Foundations（首批 PR，解除 B/C/D 阻塞）

> 本组交付**冻结契约类型**，是 M1 的唯一产出；不依赖其他组。B/C/D 对照本文档与计划直接开工。

- [x] **A-T0** ADR-039 proposal评估 + 威胁模型 + 平台/沙箱backend支持矩阵
      - 状态：ADR-039已Accepted；当前明确接受显式`in_process_unisolated`风险，isolated backend不继续开发
      - 设计：`00-overview.md §7`（历史）与`architecture/FAMILY-HOST-03-execution-constraints.md`（当前）
      - 产物：Accepted ADR-039、threat-model文档、未来isolated backend适用的decision矩阵
      - 验收：当前Host诚实fail open only under explicit opt-in但不声称隔离；未来isolated backend须独立ADR和OS/容器证据
      - ⚠ 不得修改已 accepted ADR 的历史 Decision 文字以隐藏冲突（`09 §3` 禁止）
- [x] **A-T1** FamilySpec / DatasetTransform / TransformExecutionReceipt / BuildSpec 2.0 契约（依赖 A-T0）
      - 状态：strict DTO/parser/canonical digest、raw JSON duplicate-key ingress、proposal/resolved wire shape 与纯 Core readmission 已落地；readmission绑定 exact capability/asset/result、task/build/generation/receipt evidence；不代表已接生产 runtime
      - 设计：`01-family-transform-contracts.md`（全）、`09 §2 T1`
      - 产物：`@biomed/contracts` strict DTO + parser、canonical digest fixtures（**冻结形状，供 B/C 消费**）
      - 验收：`DatasetBuildSpec 1.0` snapshot 不变；2.0 proposal 与 resolved spec 分离、Core re-admission 可独立测试；unknown field fail closed
      - ⚠ FamilySpec **禁止**含源码/函数/任意 validator/merge expression/文件路径/网络权限/Publisher threshold/Core nodes（`01 §1.1`）；**禁止**把 `schema_refs` 塞入 BuildSpec 1.0
- [ ] **A-T2** identity / projection / relation / audit 契约（依赖 A-T0）
      - 状态：三层identity、revision-scoped V2 schema primitives、probe mapping validator、staging authoritative identity context与strict `ProviderRevisionEvidenceV1`已落地；仍缺`DatasetCore` task-owned evidence transport和production adapter wiring
      - 设计：`02-product-identity-relations.md`（全）、`09 §2 T2`
      - 产物：`dataset_id` / `dataset_revision_id` / `asset_id` 三层身份、sample 复合键、`probe_gene_mapping` coverage relation（`many_to_many` + `profile_defined`）、`AuditArtifactDefinition`（**不新增** `audit` TableRole）
      - 验收：同 sample 不同 revision 不碰撞；audit row 不计入产品 table/row count 或 assessment requirement；`integrator.ts` 中 `dataset_id = buildId` 路径有红灯测试与迁移计划
      - ⚠ 一个 Schema 不能同时表达 gene_sample 与 probe_sample（`02 §1`）
- [ ] **A-T3** implementation identity digest（依赖 A-T1）
      - 状态：strict six-component implementation identity、Core release identity与fixed-operation checkpoint identity verifier已落地；仍缺checkpoint persistence/reuse composition wiring
      - 设计：`01-family-transform-contracts.md §3`、`09 §2 T3`
      - 产物：bundle/compiler/dependency/runtime/policy digest 算法 + checkpoint invalidation 规则（**B 计算、C 校验共用**）
      - 验收：同 version 不同 source/dependency/compiler → 不同 implementation digest；checkpoint reuse 同时匹配 input/params/FamilySpec/implementation/runtime/policy digest
      - ⚠ digest **必须由 Host 计算**，而非信任 Agent 声明（`01 §3`）

---

## 开发者 B — Transform Host（non-isolated active；isolated backend deferred）

> 当前只支持显式`in_process_unisolated`。sandbox/container/IPC backend仍Deferred；当前runtime不得冒充安全边界。

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
- [x] **B-T7** in-process Host protocol / receipt（依赖 A-T1、A-T3）
      - 状态：invocation/generation/quota/cancel、terminal reason、registered input bytes、bounded output/log与`TransformExecutionReceipt`已接production route；backend诚实标记`in_process_unisolated`
      - 验收：Host success不自动创建OperationResult/Publication；receipt缺任一input/output/runtime digest时Core拒绝
      - ⚠ receipt只证明bytes由该非隔离runtime产生，不证明隔离、安全或科学语义

---

## 开发者 C — Core Admission, Execution Slot & B3 Disk（信任平面，与 B 并行）

> 依赖 **A 冻结类型**（T1/T2/T3）。**不依赖 B 实现**：针对冻结 `TransformExecutionReceipt` 类型 + 测试夹具实现
> admission/checkpoint；与 B 仅类型耦合，M3 前不汇合。

- [ ] **C-T4** B3 / resource baseline（依赖 A-T2 冻结 identity 类型）
      - 状态：Core-receipted bytes bounded measurement、cancel-aware preflight、Map前阈值拒绝、v2 telemetry与explicit staging PK disk selection已落地；production measured threshold与immutable descriptor snapshot仍缺
      - 设计：`05-core-execution-product-gate.md §4 B3-D0`、`09 §2 T4`
      - 产物：现有 `validation/multitable.ts` benchmark/telemetry（row/key estimate、validator mode、heap/temp/duration/failure reason）、阈值、large-input benchmark harness（memory parity oracle）
      - 验收：超阈值强制 disk mode 或 fail closed，不再无界 `Map` 到 OOM
- [x] **C-T8** Core quarantine admission（依赖 A 冻结类型 T1/T2/T3）
      - 设计：`05-core-execution-product-gate.md §1/§6`、`03 §6 quarantine handoff`、`09 §2 T8`
      - 产物：Host 输出重哈希、schema/locator/output closure 校验、native OperationResultManifest 构造
      - 验收：未声明文件/table/schema 拒绝；locator 不得指向未知输入；failed/cancelled Host 不产生 committed Core output
      - ⚠ 针对**冻结 Receipt 类型**解码，用测试夹具驱动单测；Host output receipt **不得**直接转 Publication artifact（`10 §5#4`）
- [x] **C-T9** fixed transform slot（依赖 A-T1 冻结类型、C-T8）
      - 状态：server-owned fixed-slot admission、hostile-input tests与`submit_dynamic_family_build` production route已落地；不经`registered_multitable.runtime.v1`旁路
      - 设计：`05-core-execution-product-gate.md §6`、`09 §2 T9`
      - 产物：server-owned plan slot、transform capability admission、不引入 DAG
      - 验收：`registered_multitable.runtime.v1` 旁路问题登记并有统一 executor 修复门，不在旁路继续叠加 transform
      - ⚠ Batch 1 不得接默认 Agent build tool；Transform 不能决定 merge winner/validation threshold/ProductAssessment/Publication（`01 §1.2`、`03 §6`）
- [ ] **C-T10** checkpoint / lease / recovery（依赖 A-T3 冻结 digest、C-T9）
      - 状态：publish shortcut已禁用；strict Core release/implementation identity reuse verifier与publication verifier已落地，checkpoint持久化接线仍进行中
      - 设计：`05-core-execution-product-gate.md §6`、`08-activation-release.md §4 R4`、`09 §2 T10`
      - 产物：Host/Core owner fencing、orphan cleanup、publish reuse 修复
      - 验收：cancel/timeout/restart/stale worker/late commit 不误提交；publish 必须重验证 authoritative receipt，或禁止 publish shortcut；固定 operation 的 implementation identity 绑定真实部署版本
- [ ] **C-T11** B3 disk mode（PK/FK first hotspot）（依赖 A-T2 冻结 identity 类型、C-T4）
      - 状态：explicit staging PK path已真实调用disk TupleIndex，覆盖owner/quota/cancel/cleanup/no-fallback与memory check parity；FK/cardinality index reuse仍缺，default/production path保持不变
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
- [x] **model-registry wire-boundary 校验**：`@biomed/contracts` 已增加 `parseProvidersEnvelope` / `parseManagedModelsEnvelope` runtime parsers并替换frontend list casts；focused hostile-wire tests已覆盖。
- [ ] **Phase 9 后续 — HIL/Questionnaire**：`UserInputDialog` 迁移到同一 Questionnaire 基础设施。
- [x] **Phase 9 后续 — 权限设置页重排**：默认层与高级 ACL 编辑器。
- [x] **AI用户支持文档与配套脚本**：`docs/AGENT_API_QUICKSTART.md` 已说明安装、`.env`、HTTP/WS调用和结果获取；stdlib-only `scripts/run-driver.mjs` 已支持 health 重试、create/submit/snapshot/events durable replay，并有进程级HTTP测试。

### P2
- [x] **createPhase3ToolHooks并发identity bug**：query lifecycle已使用per-source call-scoped sequence；不同query可乱序准确闭合，identical legacy queries显式FIFO，不再覆盖同一UI card。
- [x] **Phase 9后续 — 权限事件进入历史Conversation timeline**：permission request/resolution按request identity投影为durable item，resolved后保留原timeline位置与grant scope；stale resolution不清新pending request。
- [x] **Agent INSTRUCTIONS**：现行Pi `PHASE1_SYSTEM_PROMPT` 已要求用户批准max-turn续跑后以下一轮 `[MAX_TURNS_REACHED]` 开头，并有prompt-shape test。
- [ ] **主 prompt 迭代优化（类 Darwin 进化式迭代）**：Family Host 稳定主链合入 `main` 后，对 `PHASE1_SYSTEM_PROMPT` 做可复现的变异/选择评测，优化完成度、速度与成本；不得以 Gold-specific 条件污染 production prompt。
- [ ] **设置页供应商/模型列表分页与搜索后端**（当前全量返回）。

### P3
- [ ] **可拆卸工具包实现纠错**：`scripts/solidify-run.mjs --toolkit` 不应重复摘要 SKILL.md；应为 `server/src/agent/tools/` 下的 TS 工具生成独立使用文档（用途、参数、返回、依赖、独立调用方式），方便其他 agent 在受限环境直接使用。
- [ ] **沙箱环境 [Deferred]**：通用数据安全sandbox及Transform Host隔离均暂缓；未经新的明确ADR/决策不开发，当前 `in_process_unisolated` 不得称为安全边界。

---

## 并行工作流（不在本拆分内，但为 D-R1 的 release gate）

- **Gold 可信 Publication 收敛（TASK-047 / TASK-048）**：TASK-047 大型 GEO 矩阵流式化 A8 基线已合并（`59b8b6af`），剩余 A1-A7 收尾；TASK-048 多表 family publication（B2W/B5*/B6*/B7）在飞；G1B/G1R 为最终同 commit 复跑与报告。严格 Gold 仍为 0/6，same-commit evidence 是 D-R1 的 release gate 之一。继续按原 board 推进，不在 family-host 分支修改 Gold prompt/source inventory/acceptance threshold。
