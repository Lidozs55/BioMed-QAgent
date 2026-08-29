# BioMed-QAgent 开发 TODO

> 本文件只记录当前可执行工作与验收条件。架构边界见 [`ARCHITECTURE.md`](ARCHITECTURE.md)，已知缺陷见 [`ISSUES.md`](ISSUES.md)，历史任务快照见 [`archive/TODO-2026-08-24-before-governance.md`](archive/TODO-2026-08-24-before-governance.md)。

## 当前目标

显式 `in_process_unisolated` Family Host/Core publication chain 已是 `main` 稳定基线，但它不是 sandbox 或安全边界。当前工作集中在同一冻结 commit 的 Gold release 证据、identity/recovery hardening 和产品闭包；除非新增 ADR，不开发 sandbox/container/IPC backend。

## P0 — Release evidence

- [ ] **冻结单 Host Gold1–Gold6 证据。** 在同一 commit、同一 Host 与同一 data root 上记录 task/run/requirement、registered input、OperationResult、B3、ProductAssessment、Publication 与 Artifact API hash 证据；缺失证据必须标为 blocked/unknown，不能用历史产物补齐。
  - 验收：Gold1–Gold5 的每项结论可回溯到同提交证据；Gold6 只有在真实 `publication_acceptance` HIL 后才可通过。
  - 前置：应用 provider 账户与 live source 可用；运行期间不得并行启动第二个 Host。

## P1 — Runtime and evidence hardening

- [ ] **权威 dataset/revision identity 接入生产路径。** 从 `DatasetCore` 传递 task-owned registration receipts，基于冻结 provider revision 与 asset closure 生成 identity；通过显式 V2 schema/PK 迁移 expression adapters。
  - 验收：`dataset_id`/`dataset_revision_id` 不来自 requirement ID、注册时间或调用方自报；V1 schema 不静默扩列；缺少权威事实时 fail closed。
- [ ] **checkpoint/reuse/restart 闭环。** 持久化 implementation/release identity，在真实 reuse 前调用 verifier，并补齐 owner fencing、orphan cleanup、restart 与 TOCTOU 回归测试。
  - 验收：input/params/FamilySpec/implementation/runtime/policy 任一 digest 改变都会使 checkpoint 失效；cancel/timeout/restart/stale generation 不能提交或复用旧 Publication。
- [ ] **统一 HIL Questionnaire。** 将 `UserInputDialog` 迁移到现有 Questionnaire 基础设施。
  - 验收：现有权限和 publication acceptance 流程行为不回退；历史事件仍可重放。
- [ ] **数据集请求 formal-route scaffold。** 只读 capability preflight 已接入；继续由服务端生成 digest-bound dynamic execution skeleton，并为候选 semantic family/projection、单一行粒度、可用 Core providers 和缺失 blockers 提供确定性输入。
  - 验收：gold7 类复合请求可拆为多个 projection/requirement；无 provider 时形成结构化 blocker，且不把 workspace 文件提升为正式产物；事件重放结果一致。
- [ ] **图表 evidence 到正式 Publication 闭环。** Core profile scaffold、正式 VLM evidence asset、supplementary ZIP member/parser、JATS/BioC carrier parser、`literature_experiment_chart` 六表投影与 publication 前 manifest/HIL 校验已落地；非 Gold fixture 已由 `literature-experiment-chart-e2e.test.ts` 跑通完整六表 Publication 与 Artifact SHA-256 校验。仍需在同一 Host/commit 上重跑 Gold6，记录真实 `vlm_extraction` 与 `publication_acceptance` HIL、B3、OperationResult、Manifest 和 Artifact API SHA-256 证据。
- [ ] **可验证的 QueryPlan / SourceCoverage 证据。** 在 `@biomed/contracts` 先定义稳定 wire DTO，由 Core 拥有并生成检索计划与覆盖结果；覆盖证据作为 Manifest 的 `audit_report` artifact 发布，不冒充逐行 provenance 或主数据。
  - 验收：记录 source universe、source、query、filters、time window、requested/succeeded pages、raw/deduplicated/selected counts、失败与排除原因及 `retrieved_at`；只在预先定义的 source universe 内计算 coverage/recall，不允许 Agent 文本自行宣称“全网查全”。
  - 测试：覆盖 hostile wire、分页中断、重复来源、部分来源失败、事件重放和 artifact hash；任何部分失败都在正式结果中显式可见。

## P2 — Product and developer experience

- [ ] **主 Prompt 可复现迭代。** 建立固定样例、指标和成本记录后再优化 `PHASE1_SYSTEM_PROMPT`。
  - 验收：变更有可复现实验对照，不引入 Gold case 特判，不放宽 Core 门禁。
- [ ] **模型设置分页与搜索。** 为供应商/模型列表增加后端分页和搜索，并更新前端调用。
  - 验收：契约先进入 `@biomed/contracts`；边界、空页和 hostile-wire 用例有测试。
- [ ] **Trait association / genomic annotation 可复用 family 闭包。** 按 [`architecture/trait-association-and-genomic-annotation-design.md`](architecture/trait-association-and-genomic-annotation-design.md) 实现来源无关的 projections 与 GWAS Catalog、supplementary archive、RefSNP 通用 providers；provider 与 family 保持多对多。
  - 验收：至少一个非 Alzheimer trait、两个不同数据库证明复用；variant/gene/region 粒度分别构建；不兼容 assembly、effect scale、allele/model 或 mapping method 的输入 fail closed；正式 Publication 通过 provenance/B3/ProductAssessment/Artifact hash 门。

## Deferred / 非当前工作

- **Isolated Transform Host / 通用 sandbox：** 除非新的 ADR 明确恢复该方向，否则不实施 container、IPC worker 或独立低权限进程；不得把 `node:vm` 或同进程执行改称 sandbox。
- **Publication 驱动 Run 终态闭包：** 不实施“只有产生 Publication 时 Run 才完成”。非数据汇报无需 Publication；简短 Run progress context 仅作软提示，数据产品的正式完成由 ProductAssessment + Publication 证明。
- **通用 Agent DAG、Transform 市场、一次性删除静态 Registry：** 不属于当前发布闭环。

## 完成规则

每个任务按 [`../AGENTS.md`](../AGENTS.md) 执行：测试先行、Commonly/board 同步、专用分支、质量门（定向测试优先）、文档与 TODO 同步。完成项从本文件删除；只有需要保留的重要决策或证据才进入 ADR、`audit/` 或 `archive/`。
