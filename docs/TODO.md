# BioMed-QAgent 开发 TODO

> 本文件只记录当前可执行工作与验收条件。架构边界见 [`ARCHITECTURE.md`](ARCHITECTURE.md)，已知缺陷见 [`ISSUES.md`](ISSUES.md)，历史任务快照见 [`archive/TODO-2026-08-24-before-governance.md`](archive/TODO-2026-08-24-before-governance.md)。

## 当前目标

显式 `in_process_unisolated` Family Host/Core publication chain 已是 `main` 稳定基线，但它不是 sandbox 或安全边界。当前工作集中在同一冻结 commit 的 Gold release 证据、identity/recovery hardening 和产品闭包；除非新增 ADR，不开发 sandbox/container/IPC backend。

## P0 — Release evidence

- [ ] **Gold10 肠道微生物组正式发布闭包（分支 `fix/gold10-publication-closure`）。** 已完成：路由披露 `required_entities`、dispatch 层 entities 补救报错、`gmrepo.files.v1` 迁移到存活的 per-taxon phenotype 端点（`gut_microbiome.gmrepo_taxon_phenotypes_json.v1`）、固定 provider 拒绝信息可操作化、技能文档静态优先/动态闭包规则；Playwright 浏览器本机可用。剩余：(a) 差异丰度载体闭合 —— ZIP 成员提取与 `acquire_core_carrier` 已落地（xlsx 成员提取时即转 CSV 文本，可作动态 registered sources），剩余仅"版面灵活解析"（把任意论文补充表映射到 promoted schema，或以动态 FamilySpec 消费 CSV 成员）；(b) NCBI 旧名→现行名 crosswalk schema 注册；(c) 多绑定 spec 授权：formal-route scaffold 已落地（`scaffold_dataset_execution_spec`，bd4c990d）；弱模型验证已切换到 `qwen3.8-flash`（4 轮：2 个真实动态正式发布 + 全程零编造，见 runs-log Phase C）。待决策（ADR 级，已探明 MGnify `/analyses/{MGYA}/taxonomy/ssu` 与 OTU TSV 均无 NCBI taxid，旧分析该端点为空）：taxon 表 taxid 来源三选一 —— (α) esearch 逐名解析绑定（现有能力，scaffold 可拼，abundance=0 解析参考行）；(β) 新增 lineage_abundance 表（lineage+count 无 taxid，契约变更进 @biomed/contracts）；(γ) Core 批量 name→taxid 解析 provider。另已修复 `ncbi.taxonomy.files.v1` 实体键误报（study_id 等必需键不再被拦，e59bfefe）。进展（kimi-k3 验证）：`e2e-gold10-20260827-08b` 已完成首个终态正式发布（`pub_gutmb_payload_probe_…`，ProductAssessment publishable，动态路线端到端可用），但主表为结构探针，非 TOPIC 四表；`-09` 在最终提交阶段被共享 checkout 的 watch 重启打断。验收：单一 fresh run 内 `completed` 且 `artifact_count>0`、`current_publication_id` 非空、产物经 Artifact API 校验，且在独立 worktree/安静窗口执行以避免并行活动打断。

- [ ] **冻结单 Host Gold1–Gold6 证据。** 在同一 commit、同一 Host 与同一 data root 上记录 task/run/requirement、registered input、OperationResult、B3、ProductAssessment、Publication 与 Artifact API hash 证据；缺失证据必须标为 blocked/unknown，不能用历史产物补齐。
  - 验收：Gold1–Gold5 的每项结论可回溯到同提交证据；Gold6 只有在真实 `publication_acceptance` HIL 后才可通过。
  - 前置：应用 provider 账户与 live source 可用；运行期间不得并行启动第二个 Host。

## P1 — Runtime and evidence hardening

- [x] **权威 dataset/revision identity 接入生产路径。** 从 `DatasetCore` 传递 task-owned registration receipts，基于冻结 provider revision 与 asset closure 生成 identity；通过显式 V2 schema/PK 迁移 expression adapters。
  - 验收：`dataset_id`/`dataset_revision_id` 不来自 requirement ID、注册时间或调用方自报；V1 schema 不静默扩列；缺少权威事实时 fail closed。
- [x] **checkpoint/reuse/restart 闭环。** 持久化 implementation/release identity，在真实 reuse 前调用 verifier，并补齐 owner fencing、orphan cleanup、restart 与 TOCTOU 回归测试。
  - 验收：input/params/FamilySpec/implementation/runtime/policy 任一 digest 改变都会使 checkpoint 失效；cancel/timeout/restart/stale generation 不能提交或复用旧 Publication。
- [x] **统一 HIL Questionnaire。** 将 `UserInputDialog` 迁移到现有 Questionnaire 基础设施。
  - 验收：现有权限和 publication acceptance 流程行为不回退；历史事件仍可重放。
- [x] **数据集请求 formal-route scaffold。** 只读 capability preflight 已接入；继续由服务端生成 digest-bound dynamic execution skeleton，并为候选 semantic family/projection、单一行粒度、可用 Core providers 和缺失 blockers 提供确定性输入。
  - 验收：gold7 类复合请求可拆为多个 projection/requirement；无 provider 时形成结构化 blocker，且不把 workspace 文件提升为正式产物；事件重放结果一致。
  - **遗留（2026-08-28）：** 该功能合入带入 2 个 main 红测（dispatch guard + skill map），见 [ISSUES §代码质量](ISSUES.md)；已于同日由 `d829c387` 清零（skill map 收录注册名 + spec-scaffold 改用 registry API）。
- [ ] **图表 evidence 到正式 Publication 闭环。** 将现有 `bioactivity-measurement/chart-evidence` 模块接入受控的 Family Registry、Adapter/Assembler、Validation、ProductAssessment 与 Publisher 路线；VLM/PDF/caption 输出必须先成为 task-owned、摘要绑定的 evidence asset，不能让任意 workspace CSV 直接获得正式发布权。
  - 验收：正式证据保留 source asset、page/bbox、模型及版本、prompt/transform digest、点级 confidence 与 review state；provenance 不闭合或需要复核时 fail closed；至少一个点级 Gold 覆盖 HIL correction、事件重放和 Publication artifact hash 端到端验证。
  - 前置：实现前先在对应 architecture topic 中固定 evidence asset ownership、review 状态机和现有 chart-evidence schema 的兼容策略；若改变 Core publication trust boundary，必须新增 ADR。
- [ ] **可验证的 QueryPlan / SourceCoverage 证据。** 在 `@biomed/contracts` 先定义稳定 wire DTO，由 Core 拥有并生成检索计划与覆盖结果；覆盖证据作为 Manifest 的 `audit_report` artifact 发布，不冒充逐行 provenance 或主数据。
  - 验收：记录 source universe、source、query、filters、time window、requested/succeeded pages、raw/deduplicated/selected counts、失败与排除原因及 `retrieved_at`；只在预先定义的 source universe 内计算 coverage/recall，不允许 Agent 文本自行宣称“全网查全”。
  - 测试：覆盖 hostile wire、分页中断、重复来源、部分来源失败、事件重放和 artifact hash；任何部分失败都在正式结果中显式可见。

## P2 — Product and developer experience

- [ ] **主 Prompt 可复现迭代。** 建立固定样例、指标和成本记录后再优化 `PHASE1_SYSTEM_PROMPT`。
  - 验收：变更有可复现实验对照，不引入 Gold case 特判，不放宽 Core 门禁。
- [x] **模型设置分页与搜索。** 为供应商/模型列表增加后端分页和搜索，并更新前端调用。
  - 验收：契约先进入 `@biomed/contracts`；边界、空页和 hostile-wire 用例有测试。
- [ ] **Trait association / genomic annotation 可复用 family 闭包。** 按 [`architecture/trait-association-and-genomic-annotation-design.md`](architecture/trait-association-and-genomic-annotation-design.md) 实现来源无关的 projections 与 GWAS Catalog、supplementary archive、RefSNP 通用 providers；provider 与 family 保持多对多。
  - 验收：至少一个非 Alzheimer trait、两个不同数据库证明复用；variant/gene/region 粒度分别构建；不兼容 assembly、effect scale、allele/model 或 mapping method 的输入 fail closed；正式 Publication 通过 provenance/B3/ProductAssessment/Artifact hash 门。
- [ ] **上下文压缩整改遗留（`main@1a62cfba`）。** 已合并：预算取较小值、压缩遥测、fail-closed（`766395c3`）、已发布 run 让路（`a48c5ebd`，gold9 r16 场景）。剩余：(a) run 入口 preflight——发起 Pi turn 前检查 `context_window - max_tokens - reserve > 0`，不足时以明确的 `context_budget_exhausted` 拒绝而非等 provider 400；(b) Gold live 复验——gold9 在 `a48c5ebd+` 基线重跑，确认 `succeeded_publication` closure 与真实 provider usage/Pi 估值一致。
  - 验收：preflight 有复现测试（预算不足的 run 被结构化拒绝）；gold9 单次 fresh run 产出 `succeeded_publication` 且无 `CONTEXT_COMPACTION_INEFFECTIVE` 误杀。
- [ ] **设置接线审计整改（2026-08-28，报告 [`audit/2026-08-28-settings-wiring-audit.md`](audit/2026-08-28-settings-wiring-audit.md)）。** **进展（2026-08-28 晚，`main@523e0f29`）：P0 已修（updateModel 与 activate 共享派生、活动模型参数编辑即时生效）；P1 已修跨字段校验（target≥trigger/max_tokens 预算/params 范围 422）与 activate max_tokens 残留；P2 已修 tmp 清扫、recursive 布尔校验、死代码、前端三项（比对基准/非法窗口报错/参数越界 JS 拦截含 JSON 通道）、删除 provider/model 脏残留（重置为未配置语义）、base_url 写入端 URL 结构校验（含 updateProvider 原子性修复）、加载端与迁移端统一钳制校验（坏值回退默认并告警）、env 引导改查模型目录。** 剩余待认领：P1 personalization 接线（需产品决策，先 `[Q]`）、`safety_reserve_ratio` 语义统一；P2 api_key 掩码边角、compaction 参数前端编辑入口。
  - 验收：P0/P1 各有 RED→GREEN 回归测试；整改后重放设置审计报告的"主要可疑问题汇总"逐项可勾。

## Deferred / 非当前工作

- **Isolated Transform Host / 通用 sandbox：** 除非新的 ADR 明确恢复该方向，否则不实施 container、IPC worker 或独立低权限进程；不得把 `node:vm` 或同进程执行改称 sandbox。
- **Publication 驱动 Run 终态闭包：** 不实施“只有产生 Publication 时 Run 才完成”。非数据汇报无需 Publication；简短 Run progress context 仅作软提示，数据产品的正式完成由 ProductAssessment + Publication 证明。
- **通用 Agent DAG、Transform 市场、一次性删除静态 Registry：** 不属于当前发布闭环。

## 完成规则

每个任务按 [`../AGENTS.md`](../AGENTS.md) 执行：测试先行、Commonly/board 同步、专用分支、质量门（定向测试优先）、文档与 TODO 同步。完成项从本文件删除；只有需要保留的重要决策或证据才进入 ADR、`audit/` 或 `archive/`。
