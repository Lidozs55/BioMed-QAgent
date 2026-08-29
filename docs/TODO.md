# BioMed-QAgent 开发 TODO

> 本文件只记录当前可执行工作与验收条件。架构边界见 [`ARCHITECTURE.md`](ARCHITECTURE.md)，已知缺陷见 [`ISSUES.md`](ISSUES.md)，历史任务快照见 [`archive/TODO-2026-08-24-before-governance.md`](archive/TODO-2026-08-24-before-governance.md) 与 [`archive/TODO-2026-08-29-governance-closure.md`](archive/TODO-2026-08-29-governance-closure.md)。

## 当前目标

显式 `in_process_unisolated` Family Host/Core publication chain 已是 `main` 稳定基线，但它不是 sandbox 或安全边界。当前工作集中在同一冻结 commit 的 Gold release 证据、identity/recovery hardening 和产品闭包；除非新增 ADR，不开发 sandbox/container/IPC backend。

## P0 — Release evidence

- [ ] **冻结单 Host Gold1–Gold6 证据。** 在同一 commit、同一 Host 与同一 data root 上记录 task/run/requirement、registered input、OperationResult、B3、ProductAssessment、Publication 与 Artifact API hash 证据；缺失证据必须标为 blocked/unknown，不能用历史产物补齐。
  - 验收：Gold1–Gold5 的每项结论可回溯到同提交证据；Gold6 只有在真实 `publication_acceptance` HIL 后才可通过。
  - 前置：应用 provider 账户与 live source 可用；运行期间不得并行启动第二个 Host（并行 Host 现已由 tasks-root 独占租约在代码层拒绝，见 `server/src/runtime/host-lease.ts`）。

## P1 — Runtime and evidence hardening

- [ ] **图表 evidence 到正式 Publication 闭环。** 将现有 `bioactivity-measurement/chart-evidence` 模块接入受控的 Family Registry、Adapter/Assembler、Validation、ProductAssessment 与 Publisher 路线；VLM/PDF/caption 输出必须先成为 task-owned、摘要绑定的 evidence asset，不能让任意 workspace CSV 直接获得正式发布权。
  - 验收：正式证据保留 source asset、page/bbox、模型及版本、prompt/transform digest、点级 confidence 与 review state；provenance 不闭合或需要复核时 fail closed；至少一个点级 Gold 覆盖 HIL correction、事件重放和 Publication artifact hash 端到端验证。
  - 前置：实现前先在对应 architecture topic 中固定 evidence asset ownership、review 状态机和现有 chart-evidence schema 的兼容策略；若改变 Core publication trust boundary，必须新增 ADR。
- [ ] **可验证的 QueryPlan / SourceCoverage 证据。** 在 `@biomed/contracts` 先定义稳定 wire DTO，由 Core 拥有并生成检索计划与覆盖结果；覆盖证据作为 Manifest 的 `audit_report` artifact 发布，不冒充逐行 provenance 或主数据。
  - 验收：记录 source universe、source、query、filters、time window、requested/succeeded pages、raw/deduplicated/selected counts、失败与排除原因及 `retrieved_at`；只在预先定义的 source universe 内计算 coverage/recall，不允许 Agent 文本自行宣称“全网查全”。
  - 测试：覆盖 hostile wire、分页中断、重复来源、部分来源失败、事件重放和 artifact hash；任何部分失败都在正式结果中显式可见。
- [ ] **Digest-bound 动态 execution skeleton（scaffold 动态侧）。** 2026-08-29 归档核查：已落地的 `scaffold_dataset_execution_spec` 只从 live Family Registry 组合静态 validate-ready spec 骨架；原文设想的服务端 digest-bound dynamic execution skeleton——为候选 semantic family/projection、单一行粒度、可用 Core providers 和缺失 blockers 提供确定性输入——尚未实现，从已完成的 formal-route scaffold 条目拆出。
  - 验收：gold7 类复合请求可拆为多个 projection/requirement；无 provider 时形成结构化 blocker，且不把 workspace 文件提升为正式产物；事件重放结果一致。

## P2 — Product and developer experience

- [ ] **主 Prompt 可复现迭代。** 建立固定样例、指标和成本记录后再优化 `PHASE1_SYSTEM_PROMPT`。
  - 验收：变更有可复现实验对照，不引入 Gold case 特判，不放宽 Core 门禁。
- [ ] **Trait association / genomic annotation 可复用 family 闭包。** 按 [`architecture/trait-association-and-genomic-annotation-design.md`](architecture/trait-association-and-genomic-annotation-design.md) 实现来源无关的 projections 与 GWAS Catalog、supplementary archive、RefSNP 通用 providers；provider 与 family 保持多对多。
  - 验收：至少一个非 Alzheimer trait、两个不同数据库证明复用；variant/gene/region 粒度分别构建；不兼容 assembly、effect scale、allele/model 或 mapping method 的输入 fail closed；正式 Publication 通过 provenance/B3/ProductAssessment/Artifact hash 门。
- [ ] **Dynamic submit 免巨型回显（receipt-referenced submit）。** 2026-08-28 gold9 r3/r4 实测：prepare 返回 ~97KB JSON，submit 要求逐字回显，deepseek-v4-flash 在 32,768 输出预算边缘丢字段（空 registered_sources / >128 逐记录角色），见 [ISSUES §代码质量](ISSUES.md)。服务端 prepare 已持有 task/requirement/generation 绑定状态，submit 改为回传 `receipt_digest` 引用 + 可选覆盖项；wire 契约先进 `@biomed/contracts` 并带 hostile 用例。
  - 验收：小模型在 gold9 级（≥5 源）spec 上无需回显全量 prepared_submission 即可完成 submit；>64 bindings 早拒信息（`f83ceca0`）保持不变。
- [ ] **设置接线审计整改（剩余待认领）。** 报告见 [`audit/2026-08-28-settings-wiring-audit.md`](audit/2026-08-28-settings-wiring-audit.md)。P0/P1 主体与 P2 大部分已于 2026-08-28 修复（`main@523e0f29`）。剩余待认领：P1 personalization 接线（需产品决策，先 `[Q]`）、`safety_reserve_ratio` 语义统一；P2 api_key 掩码边角、compaction 参数前端编辑入口。
  - 验收：整改后重放设置审计报告的“主要可疑问题汇总”逐项可勾。

## Deferred / 非当前工作

- **Isolated Transform Host / 通用 sandbox：** 除非新的 ADR 明确恢复该方向，否则不实施 container、IPC worker 或独立低权限进程；不得把 `node:vm` 或同进程执行改称 sandbox。
- **Publication 驱动 Run 终态闭包：** 不实施“只有产生 Publication 时 Run 才完成”。非数据汇报无需 Publication；简短 Run progress context 仅作软提示，数据产品的正式完成由 ProductAssessment + Publication 证明。
- **通用 Agent DAG、Transform 市场、一次性删除静态 Registry：** 不属于当前发布闭环。

## 完成规则

每个任务按 [`../AGENTS.md`](../AGENTS.md) 执行：测试先行、Commonly/board 同步、专用分支、质量门（定向测试优先）、文档与 TODO 同步。完成项从本文件删除；只有需要保留的重要决策或证据才进入 ADR、`audit/` 或 `archive/`。
