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
- [ ] **通用 Web 搜索工具（gold8 枚举行为的根因缺口）。** Agent 目前只有单库 API 搜索（PubMed/ChEMBL/UniProt…）与 `navigate_page`/`download_from_page`，没有通用搜索引擎入口；官方入口 404 时只能顺序枚举 URL（gold8 曾对 `www.fda.gov/media/1341xx` 暴力枚举 555 次，见 [ISSUES](ISSUES.md)）。本项是上方"替代源自动发现"的使能原语。新增受控通用搜索工具：供应商选型与 API key 接线先 `[Q]` 决策（Bing/Google/Serper/DuckDuckGo 等），复用既有 PublicHttpClient 限速与 egress 策略，返回有界结构化结果（title/url/snippet），查询与命中计入覆盖证据。
  - 2026-08-29 决策/进展：本机（即 run 环境）实测 `google.serper.dev` 与 `api.tavily.com` 可达但**均需注册 key**（无 key 403/401），无 key 不能直接落地；Brave/Google CSE/DuckDuckGo 不可达，Bing Search API 已于 2025-08 退役。兜底路线已先落地：`web_search_discovery` 提醒 skill 引导 Agent 经受控浏览器访问搜索结果页发现入口（调用细节在 browser skill）。同日移除 prompt/skill 对浏览器通道的劝退文本（`main@b4ef99c9`）后，gold8 重跑（qwen3.8-flash）实测生效：Agent 主动走 Bing SERP 发现 LiverTox 官方通道，16 次页面读取 + 13 次取证下载 + 5 次 openFDA 查询，零绕路零权限请求（见 ISSUES gold8 browser-unblock rerun）。API 工具待 key 配置后实现。
  - 验收：官方入口不可达时 Agent 可经搜索发现等价官方/权威入口并进入 formal 路线；搜索调用有结构化证据、速率限制与结果上限；无结果时显式 NO_DATA；搜索结果不直读为正式证据（仍经 browser/download 工具取证）。
- [ ] **Recipe 格式宽路径：DOCX/XLS/HTML/PDF 与"通用 CSV/TSV + 人审字段映射"。** 现有 registered parser 均为 family 特定形状（`server/src/dataset/adapters/registered/default-registry.ts`），浏览器 formalization 无法消费这些媒体类型，Agent 遇到即绕路（gold8 rerun3 的 openpyxl 探测被拒）。按 canonical-evidence 发布路线新增 registered 通用格式 parser：CSV/TSV 宽路径起步（列名 → 目标 schema 字段映射经既有 field_mapping HIL 门禁），再扩 DOCX/XLS/HTML/PDF；recipe 仍只从 Core-owned registered registry promote，不为 Agent 输入开放任意映射。
  - 验收：标准表格/文档文件可经 recipe → parser → schema 绑定进入正式维度；未知列/字段映射经人审后落表；media type 校验、implementation digest 与 hostile 用例（错位列、BOM、合并单元格等）覆盖；不放宽既有 family 解析器门禁。

## P2 — Product and developer experience

- [ ] **主 Prompt 可复现迭代。** 建立固定样例、指标和成本记录后再优化 `PHASE1_SYSTEM_PROMPT`。
  - 验收：变更有可复现实验对照，不引入 Gold case 特判，不放宽 Core 门禁。
- [ ] **Trait association / genomic annotation 可复用 family 闭包。** 按 [`architecture/trait-association-and-genomic-annotation-design.md`](architecture/trait-association-and-genomic-annotation-design.md) 实现来源无关的 projections 与 GWAS Catalog、supplementary archive、RefSNP 通用 providers；provider 与 family 保持多对多。
  - 验收：至少一个非 Alzheimer trait、两个不同数据库证明复用；variant/gene/region 粒度分别构建；不兼容 assembly、effect scale、allele/model 或 mapping method 的输入 fail closed；正式 Publication 通过 provenance/B3/ProductAssessment/Artifact hash 门。
- [ ] **End-of-run publication gate（数据类任务完成前发布闸门，P2）。** 2026-08-29 gold7 直问 campaign 实证：qwen3.7-flash 在零正式尝试时会直接交付"临时工作区结果+伪阻塞"（伪造穷尽前提），supervisor 只能事后诚实分类。拟在 runtime 接受 agent 完结前检查：数据产出意图 + 零 formal-route 调用 + 无结构化 blocker → 注入一次有界系统 nudge 给补跑机会。来源见 [reports/2026-08-29-gold-qwen-direct-validation-study.md](reports/2026-08-29-gold-qwen-direct-validation-study.md) 直问2。
- [x] **Dynamic submit 免巨型回显（receipt-referenced submit）。** 2026-08-29 已实现（分支 `feat/receipt-referenced-submit`）：preflight coordinator 在 commitPrepare 存储完整 prepared submission；`submit_dynamic_family_publication` 接受 `{schema_version, preflight_receipt}` 最小 wire，服务端按 receipt 解析存储的 submission（回显全量仍兼容接受）；工具 schema 必填键降为两项，系统提示词 [Dynamic publication mechanics] 段同步教学。原描述（2026-08-28 gold9 r3/r4 实测）：prepare 返回 ~97KB JSON，submit 要求逐字回显，deepseek-v4-flash 在 32,768 输出预算边缘丢字段（空 registered_sources / >128 逐记录角色），见 [ISSUES §代码质量](ISSUES.md)。 2026-08-28 gold9 r3/r4 实测：prepare 返回 ~97KB JSON，submit 要求逐字回显，deepseek-v4-flash 在 32,768 输出预算边缘丢字段（空 registered_sources / >128 逐记录角色），见 [ISSUES §代码质量](ISSUES.md)。服务端 prepare 已持有 task/requirement/generation 绑定状态，submit 改为回传 `receipt_digest` 引用 + 可选覆盖项；wire 契约先进 `@biomed/contracts` 并带 hostile 用例。
  - 验收：小模型在 gold9 级（≥5 源）spec 上无需回显全量 prepared_submission 即可完成 submit；>64 bindings 早拒信息（`f83ceca0`）保持不变。
- [ ] **设置接线审计整改（剩余待认领）。** 报告见 [`audit/2026-08-28-settings-wiring-audit.md`](audit/2026-08-28-settings-wiring-audit.md)。P0/P1 主体与 P2 大部分已于 2026-08-28 修复（`main@523e0f29`）。剩余待认领：P1 personalization 接线（需产品决策，先 `[Q]`）、`safety_reserve_ratio` 语义统一；P2 api_key 掩码边角、compaction 参数前端编辑入口。
  - 验收：整改后重放设置审计报告的”主要可疑问题汇总”逐项可勾。
- [ ] **输出格式扩展：宽表/合并导出（评审建议，待产品决策）。** 下游统计（pandas/tidyverse）常用合并宽表；评审指出过度拆分多表会降低”输出格式可用性”。评估在既有 CSV 多表基线之上提供可选的宽表展平视图（按 schema 声明的 join 键展平），不改动确定性多表存储。实施前先 [Q] 征求产品决策。
  - 验收：存在可选宽表导出且与多表 Manifest 逐表可对账；现行单表交付（如 gold8 FAERS 计数）不受影响。
- [ ] **极低风险正式化免人审路径（待产品决策，先 `[Q]`）。** `propose_browser_evidence_acceptance` 目前一律 blocking HIL（policy `browser.acquisition.evidence-acceptance.v1`）。对确定性可校验的极低风险证据（例如 media type 为 JSON 且与 PROMOTED recipe 的 registered parser/schema 双 digest 绑定）可考虑免人审自动过。该路径削弱 fail-closed 评审门，实施前需先 `[Q]` 明确风险边界（限定媒体类型与 digest 绑定、上线初期抽审、可回滚开关）。
  - 验收：符合限定条件的证据自动 formalize 并在事件流记录 auto-accept 依据与 policy ref；其余路径门禁不变；有复现测试与开关回退验证。

## 模型卡点收集期（只登记，暂不修）

- [ ] **gold 案例批量测完后统一分流修复模型卡点。** 收集清单见 [`evaluation/model-blockers.md`](evaluation/model-blockers.md)（gold1@qwen3.8-flash 已登记 B1–B6：观察缺口盲猜参数、动态路由零调用、时限幻觉、同路撞墙、activate 摩擦、GDC 浅尝辄止）。等组员把其余 gold 案例跑完补齐清单后，再按 prompt/产品/接口陷阱分流立项修复；期间**不改** `phase1-prompt.ts`、适配器或工具行为。
  - 验收：清单每条有证据（seq/正文）与归类；修复立项后逐条回写去向（prompt 提交 / TODO 新项 / ISSUES）。

## Deferred / 非当前工作

- **Publication 驱动 Run 终态闭包：** 不实施“只有产生 Publication 时 Run 才完成”。非数据汇报无需 Publication；简短 Run progress context 仅作软提示，数据产品的正式完成由 ProductAssessment + Publication 证明。
- **通用 Agent DAG、Transform 市场、一次性删除静态 Registry：** 不属于当前发布闭环。

## 完成规则

每个任务按 [`../AGENTS.md`](../AGENTS.md) 执行：测试先行、Commonly/board 同步、专用分支、质量门（定向测试优先）、文档与 TODO 同步。完成项从本文件删除；只有需要保留的重要决策或证据才进入 ADR、`audit/` 或 `archive/`。
