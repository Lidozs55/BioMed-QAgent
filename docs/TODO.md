# BioMed-QAgent 开发 TODO

> 本文件只记录当前可执行工作与验收条件。架构边界见 [`ARCHITECTURE.md`](ARCHITECTURE.md)，已知缺陷见 [`ISSUES.md`](ISSUES.md)，历史任务快照见 [`archive/TODO-2026-08-24-before-governance.md`](archive/TODO-2026-08-24-before-governance.md) 与 [`archive/TODO-2026-08-29-governance-closure.md`](archive/TODO-2026-08-29-governance-closure.md)。

## 当前目标

显式 `in_process_unisolated` Family Host/Core publication chain 已是 `main` 稳定基线，但它不是 sandbox 或安全边界。当前工作集中在同一冻结 commit 的 Gold release 证据、identity/recovery hardening 和产品闭包；除非新增 ADR，不开发 sandbox/container/IPC backend。

## P0 — Release evidence

- [ ] **冻结单 Host Gold1–Gold6 证据。** 在同一 commit、同一 Host 与同一 data root 上记录 task/run/requirement、registered input、OperationResult、B3、ProductAssessment、Publication 与 Artifact API hash 证据；缺失证据必须标为 blocked/unknown，不能用历史产物补齐。
  - 验收：Gold1–Gold5 的每项结论可回溯到同提交证据；Gold6 只有在真实 `publication_acceptance` HIL 后才可通过。
  - 前置：应用 provider 账户与 live source 可用；运行期间不得并行启动第二个 Host（并行 Host 现已由 tasks-root 独占租约在代码层拒绝，见 `server/src/runtime/host-lease.ts`）。
- [ ] **端到端图表 Gold 案例（对齐加分项"自动识别图表坐标轴或图例解析错误"）。** 图表证据已接通正式发布闭环（见下方已完成项），但 gold7–9 未有含图表场景的端到端案例；评审明确将其列为最高优先级失分点（"图表数据处理"是赛题核心能力）。补一个自然语言 TOPIC 出发、含论文图表抽取与坐标轴/图例核验的端到端 Gold 案例。
  - 验收：TOPIC → VLM/PDF/caption 抽取 → chart 四表（chart_series / chart_points / papers / sources）→ 正式 Publication；坐标轴名/单位/刻度与图例状态经 `axis_validation_status` / `legend_validation_status` 门禁；exact 点与 unclear 轴/图例语义冲突 fail-closed；单位 token 不漂移；低置信度点经 HIL 修正后保留 original 值；评审可经报告 5.5 所述 API/前端复现。

## P1 — Runtime and evidence hardening

- [x] **图表 evidence 到正式 Publication 闭环。** 将现有 `bioactivity-measurement/chart-evidence` 模块接入受控的 Family Registry、Adapter/Assembler、Validation、ProductAssessment 与 Publisher 路线；VLM/PDF/caption 输出必须先成为 task-owned、摘要绑定的 evidence asset，不能让任意 workspace CSV 直接获得正式发布权。
  - 验收（2026-08-29 达成）：chart 四表进入生产 `bioactivity_measurement` family（schema + registered JSON parsers + 组装分派），点级 provenance/review 门在组装前 fail-closed（结构化 `chart_evidence:chart_evidence_gate` 检查写入 validation_report，不产生 Publication），经 B3 + Publisher 走既有原子发布。点级 Gold（`server/tests/chart-evidence-publication-closure.test.ts`）覆盖 accepted/corrected（HIL correction 保留 original 值与 human_correction 步骤）、artifact bytes 与 SHA-256 重算、pending review 与缺表拒绝；`publication_created`/`artifact_produced` 事件重放由既有 durable-runtime 测试锁定。evidence ownership、review 状态机与 schema 兼容策略见 `architecture/canonical-evidence.md` § figure/chart evidence publication route；未改变 Core publication trust boundary，无需新 ADR。
- [ ] **可验证的 QueryPlan / SourceCoverage 证据。** 在 `@biomed/contracts` 先定义稳定 wire DTO，由 Core 拥有并生成检索计划与覆盖结果；覆盖证据作为 Manifest 的 `audit_report` artifact 发布，不冒充逐行 provenance 或主数据。
  - 验收：记录 source universe、source、query、filters、time window、requested/succeeded pages、raw/deduplicated/selected counts、失败与排除原因及 `retrieved_at`；只在预先定义的 source universe 内计算 coverage/recall，不允许 Agent 文本自行宣称“全网查全”。
  - 测试：覆盖 hostile wire、分页中断、重复来源、部分来源失败、事件重放和 artifact hash；任何部分失败都在正式结果中显式可见。
- [ ] **Digest-bound 动态 execution skeleton（scaffold 动态侧）。** 2026-08-29 归档核查：已落地的 `scaffold_dataset_execution_spec` 只从 live Family Registry 组合静态 validate-ready spec 骨架；原文设想的服务端 digest-bound dynamic execution skeleton——为候选 semantic family/projection、单一行粒度、可用 Core providers 和缺失 blockers 提供确定性输入——尚未实现，从已完成的 formal-route scaffold 条目拆出。
  - 验收：gold7 类复合请求可拆为多个 projection/requirement；无 provider 时形成结构化 blocker，且不把 workspace 文件提升为正式产物；事件重放结果一致。
- [ ] **gold9 跨源数值列行级填充率门。** crosswalk 中 ClinVar/ClinGen 数值列整体为空仍通过结构校验（偏差已记入案例档案；评审指出"结构校验不检查可选列填充率"会让质量门禁形同虚设）。在 Validation/ProductAssessment 增加可选列行级填充率检查（空值超阈即显式 warning 或 blocker），或当载体已绑定但数值未落表时自动生成 LLM 补齐候选 + HIL 确认。
  - 验收：gold9 复测时两列整体为空触发显式检查结论（warning/blocked 或人工候选），不再"照常通过"；修复经 4.9 反馈-修正-换版闭环产出 v2，保留 v1 历史。
- [ ] **gold8 DILIrank 404 的替代源自动发现。** 官方文件持续 404 时，系统自动检索等价官方通道或文献补充（如 LiverTox 网页表格、其他 DILI 参考列表、PubChem/ChEMBL assay），并把尝试过程计入覆盖证据，而非仅等待用户提供文件后定向续跑。
  - 验收：替代源候选列表随阻断信息交付；候选经既有 Core 采集绑定可进入正式维度；不编造行、不静默降级。

## P2 — Product and developer experience

- [ ] **主 Prompt 可复现迭代。** 建立固定样例、指标和成本记录后再优化 `PHASE1_SYSTEM_PROMPT`。
  - 验收：变更有可复现实验对照，不引入 Gold case 特判，不放宽 Core 门禁。
- [ ] **Trait association / genomic annotation 可复用 family 闭包。** 按 [`architecture/trait-association-and-genomic-annotation-design.md`](architecture/trait-association-and-genomic-annotation-design.md) 实现来源无关的 projections 与 GWAS Catalog、supplementary archive、RefSNP 通用 providers；provider 与 family 保持多对多。
  - 验收：至少一个非 Alzheimer trait、两个不同数据库证明复用；variant/gene/region 粒度分别构建；不兼容 assembly、effect scale、allele/model 或 mapping method 的输入 fail closed；正式 Publication 通过 provenance/B3/ProductAssessment/Artifact hash 门。
- [x] **Dynamic submit 免巨型回显（receipt-referenced submit）。** 2026-08-29 已实现（分支 `feat/receipt-referenced-submit`）：preflight coordinator 在 commitPrepare 存储完整 prepared submission；`submit_dynamic_family_publication` 接受 `{schema_version, preflight_receipt}` 最小 wire，服务端按 receipt 解析存储的 submission（回显全量仍兼容接受）；工具 schema 必填键降为两项，系统提示词 [Dynamic publication mechanics] 段同步教学。原描述（2026-08-28 gold9 r3/r4 实测）：prepare 返回 ~97KB JSON，submit 要求逐字回显，deepseek-v4-flash 在 32,768 输出预算边缘丢字段（空 registered_sources / >128 逐记录角色），见 [ISSUES §代码质量](ISSUES.md)。 2026-08-28 gold9 r3/r4 实测：prepare 返回 ~97KB JSON，submit 要求逐字回显，deepseek-v4-flash 在 32,768 输出预算边缘丢字段（空 registered_sources / >128 逐记录角色），见 [ISSUES §代码质量](ISSUES.md)。服务端 prepare 已持有 task/requirement/generation 绑定状态，submit 改为回传 `receipt_digest` 引用 + 可选覆盖项；wire 契约先进 `@biomed/contracts` 并带 hostile 用例。
  - 验收：小模型在 gold9 级（≥5 源）spec 上无需回显全量 prepared_submission 即可完成 submit；>64 bindings 早拒信息（`f83ceca0`）保持不变。
- [ ] **设置接线审计整改（剩余待认领）。** 报告见 [`audit/2026-08-28-settings-wiring-audit.md`](audit/2026-08-28-settings-wiring-audit.md)。P0/P1 主体与 P2 大部分已于 2026-08-28 修复（`main@523e0f29`）。剩余待认领：P1 personalization 接线（需产品决策，先 `[Q]`）、`safety_reserve_ratio` 语义统一；P2 api_key 掩码边角、compaction 参数前端编辑入口。
  - 验收：整改后重放设置审计报告的”主要可疑问题汇总”逐项可勾。
- [ ] **输出格式扩展：宽表/合并导出（评审建议，待产品决策）。** 下游统计（pandas/tidyverse）常用合并宽表；评审指出过度拆分多表会降低”输出格式可用性”。评估在既有 CSV 多表基线之上提供可选的宽表展平视图（按 schema 声明的 join 键展平），不改动确定性多表存储。实施前先 [Q] 征求产品决策。
  - 验收：存在可选宽表导出且与多表 Manifest 逐表可对账；现行单表交付（如 gold8 FAERS 计数）不受影响。

## Deferred / 非当前工作

- **Publication 驱动 Run 终态闭包：** 不实施“只有产生 Publication 时 Run 才完成”。非数据汇报无需 Publication；简短 Run progress context 仅作软提示，数据产品的正式完成由 ProductAssessment + Publication 证明。
- **通用 Agent DAG、Transform 市场、一次性删除静态 Registry：** 不属于当前发布闭环。

## 完成规则

每个任务按 [`../AGENTS.md`](../AGENTS.md) 执行：测试先行、Commonly/board 同步、专用分支、质量门（定向测试优先）、文档与 TODO 同步。完成项从本文件删除；只有需要保留的重要决策或证据才进入 ADR、`audit/` 或 `archive/`。
