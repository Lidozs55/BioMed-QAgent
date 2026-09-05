# BioMed-QAgent 开发 TODO

> 本文件只记录当前可执行工作与验收条件。架构边界见 [`ARCHITECTURE.md`](ARCHITECTURE.md)，已知缺陷见 [`ISSUES.md`](ISSUES.md)，历史任务快照见 [`archive/TODO-2026-08-24-before-governance.md`](archive/TODO-2026-08-24-before-governance.md) 与 [`archive/TODO-2026-08-29-governance-closure.md`](archive/TODO-2026-08-29-governance-closure.md)。

## 当前目标

显式 `in_process_unisolated` Family Host/Core publication chain 已是 `main` 稳定基线，但它不是 sandbox 或安全边界。当前工作集中在同一冻结 commit 的 Gold release 证据、identity/recovery hardening 和产品闭包；除非新增 ADR，不开发 sandbox/container/IPC backend。

## P0 — Release evidence

- [ ] **参考集对照准确性评测（G1 evaluator 落地，报告最高权重项零量化）。** 评分标准"科学事实表达准确性（0-15）"与"数据查找完备性"目前没有任何对照参考数据的量化证据：gold7 正式发布 88/3,109 参考 locus 行、gold8 覆盖 9/约 50 请求药物，报告均只作定性披露；`docs/evaluation/gold-v1/` 的 manifest 已预留 final G1 evaluator，但对照评测未实现（strict 计分 0/6）。实现 publication-vs-reference 对照评测：行级覆盖率、字段命中率、数值一致性抽样（可先为 gold7/8/9 冻结参考 + 脚本化，后续并入 gold-v1 全六例），并顺带完成三案例（冻结提交 `e8d03589`，早于占位符筛查 `22d87d15`）的内容级复核，回应时间线质疑。来源见 `reports/2026-08-30-architecture-and-report-review.md`（评审报告待提交入库） §4.2。
  - 验收：每案例产出可复核对照表（覆盖行数、字段命中率、数值一致率 + 不一致样例）并可直接引用进报告第五章；gold-v1 strict 计分推进，或在报告中显式说明未全量重跑的原因。

## P1 — Runtime and evidence hardening

- [ ] **全局 exact-only 图表坐标迁移（ADR-043）。** Prompt/skill 已将正式图表数值限定为正文表格、补充数值文件、官方出版社 source data 或论文/作者明确关联仓库中的显式数值；旧 VLM 图像估计点 + HIL 发布路径仅为迁移期兼容代码，已过时。按 [`architecture/chart-exact-data-policy.md`](architecture/chart-exact-data-policy.md) 的文件所有权并行：(1) 新增 exact source-data acquisition/parser/semantic mapping 正向路径；(2) 移除 producer/review、contracts/profile/validator、frontend 和 evaluator 旧估计行为。冻结 `gold-v1` 不原地修改，另建 successor evaluation。
  - 验收：任何 pixel/vector/OCR/interpolation/fitting estimate 即使 accepted/corrected 也被 Core 硬拒；无精确 point source 时 `chart_points` 可空且留有有界检索审计，独立精确表格值仍可部分发布；最终报告列出跳过 figure/panel、已搜索来源和联系作者/提供 source-data 建议；正向 source-data、正确弃权、已知但不可访问、hostile reviewed estimate、部分发布五类回归通过。

- [ ] **权威 dataset/revision identity 接入生产路径。** 从 `DatasetCore` 传递 task-owned registration receipts，基于冻结 provider revision 与 asset closure 生成 identity；通过显式 V2 schema/PK 迁移 expression adapters。
  - 验收：`dataset_id`/`dataset_revision_id` 不来自 requirement ID、注册时间或调用方自报；V1 schema 不静默扩列；缺少权威事实时 fail closed。
- [ ] **checkpoint/reuse/restart 闭环。** 持久化 implementation/release identity，在真实 reuse 前调用 verifier，并补齐 owner fencing、orphan cleanup、restart 与 TOCTOU 回归测试。
  - 验收：input/params/FamilySpec/implementation/runtime/policy 任一 digest 改变都会使 checkpoint 失效；cancel/timeout/restart/stale generation 不能提交或复用旧 Publication。
- [ ] **统一 HIL Questionnaire。** 将 `UserInputDialog` 迁移到现有 Questionnaire 基础设施。
  - 验收：现有权限和 publication acceptance 流程行为不回退；历史事件仍可重放。
- [ ] **数据集请求 formal-route scaffold。** 只读 capability preflight 已接入；继续由服务端生成 digest-bound dynamic execution skeleton，并为候选 semantic family/projection、单一行粒度、可用 Core providers 和缺失 blockers 提供确定性输入。
  - 验收：gold7 类复合请求可拆为多个 projection/requirement；无 provider 时形成结构化 blocker，且不把 workspace 文件提升为正式产物；事件重放结果一致。
- [x] **Gold6 live 图表 evidence 到正式 Publication 证据归档。** **2026-09-02 R7c3 达成 `succeeded_publication`：** `pub_egfr_mutant_inhibition_literature_chart_6cc6bc09c71ca8c5`（commit `ae271a79/dev`，19,884 events，10.28M tokens，约 1h12m），9 artifacts 全部字节+SHA-256 复验通过，137 行精确 activity 值（`article_table_deterministic_parse_v1` 确定性 XML 表格解析），`publication_acceptance` HIL 由 user 正式接受。空 chart_series/chart_points/supplementary 按操作员批准的 optional 拓扑合法（exact-only 政策守住，无估算点发布）。验收链 `publication_acceptance`→B3→OperationResult→Manifest→Artifact SHA-256 全部闭环。关键运营能力：watcher 子代理全量 HIL 自动批准（data_review 用 `{"action":"accept"}` 对象形态）；supplementary/chart_series optional 拓扑；gate relaxations（dev-only）。
- [ ] **Gold6 历史路线（R4–R7c）归档记录。** R4 manifest 契约错位（R5 双 carrier 投影修复，R6 live 验证零漂移）；R6 Europe PMC 500 定性为文章级缺档（PMC4315625 对照 `media_mismatch`）；R7 attempt-1 双 Host 并发损坏（INCIDENT.md）；R7c 停机丢失后从 origin/dev 重建（R7c3 模式）。历史证据包随各 worktree 归档。
- [ ] **QueryPlan / SourceCoverage 完整检索语义与生产 ledger 接线。** 在 `@biomed/contracts` 先定义稳定 wire DTO，由 Core 拥有并生成检索计划与覆盖结果；覆盖证据作为 Manifest 的 `audit_report` artifact 发布，不冒充逐行 provenance 或主数据。
  - 验收：记录 source universe、source、query、filters、time window、requested/succeeded pages、raw/deduplicated/selected counts、失败与排除原因及 `retrieved_at`；只在预先定义的 source universe 内计算 coverage/recall，不允许 Agent 文本自行宣称“全网查全”。
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
- [ ] **Qwen 高档位正式发布案例（赛题模型导向证据）。** 赛题导向"基于国产开源大模型（如 Qwen）"，但报告三个旗舰案例均由 DeepSeek-V4-Flash 完成；Qwen 侧仅 qwen3.8-27B 的 gold8 一例，qwen3.7-plus 在 gold7 多轮失败（`data/gold/gold7_alzheimer_gwas/runs-log.md` 2026-08-25~27：不走正式路线、谎报完成、Catalog 端点 404）。在 Qwen 非 flash 档（plus/max）于 gold7 或 gold9 完成正式发布并留完整事件流，作为报告"模型能力分层表"的 Qwen 侧证据。来源见 `reports/2026-08-30-architecture-and-report-review.md`（评审报告待提交入库） §4.3。
  - 验收：至少一个 Qwen 非 flash 档正式 Publication（逐件 SHA-256 重验通过）；与 deepseek 结果的结构差异（若有）有解释；不为此放宽任何门禁。
- [ ] **HIL 交互案例级证据归档（创新点三的实证缺口）。** 报告自述三旗舰案例"零权限暂停"，"更早轮次已单独验证"无可引用档案，创新点三目前只有旧测试级与组件级证据。把一次真实 HIL 闭环全程留档（请求/暂停/决策/恢复事件流 + 前端截图 + 决策记录），候选场景：exact source-data 的歧义字段/series mapping、单位结构化修正、发布验收 accept；**图像估计点 correct 已被 ADR-043 取代，不再作为候选。**前置：P0 端到端图表 Gold 案例或 Gold1-6 冻结证据项中的真实 `publication_acceptance`。来源见评审报告 §3.3。
  - 验收：形成可引用证据包（含事件流与截图），报告 4.9 与创新点三可指向该档案；HIL 三档审批策略（含 llm_pre_review 的 fail-safe 回退）在报告中有一句话说明。

## P2 — Product and developer experience

- [ ] **主 Prompt 可复现迭代。** 建立固定样例、指标和成本记录后再优化 `PHASE1_SYSTEM_PROMPT`。基线注记（2026-08-30）：已在 PHASE1 前新增 `[System briefing]` 系统简介段——系统设定、无墙钟时限、防空转止损、工作流；独立导出 `SYSTEM_BRIEFING` 并于 `PiAgentAdapter.createSession` 置首拼接，PHASE1 机制段文字零改动、≤8k 预算不变；回归测试见 `server/tests/pi-adapter.test.ts` system briefing 用例。后续优化以该基线做可复现对照。
  - 验收：变更有可复现实验对照，不引入 Gold case 特判，不放宽 Core 门禁。
- [ ] **Trait association / genomic annotation 可复用 family 闭包。** 按 [`architecture/trait-association-and-genomic-annotation-design.md`](architecture/trait-association-and-genomic-annotation-design.md) 实现来源无关的 projections 与 GWAS Catalog、supplementary archive、RefSNP 通用 providers；provider 与 family 保持多对多。
  - 验收：至少一个非 Alzheimer trait、两个不同数据库证明复用；variant/gene/region 粒度分别构建；不兼容 assembly、effect scale、allele/model 或 mapping method 的输入 fail closed；正式 Publication 通过 provenance/B3/ProductAssessment/Artifact hash 门。
- [ ] **End-of-run publication gate（数据类任务完成前发布闸门，P2）。** 2026-08-29 gold7 直问 campaign 实证：qwen3.7-flash 在零正式尝试时会直接交付"临时工作区结果+伪阻塞"（伪造穷尽前提），supervisor 只能事后诚实分类。拟在 runtime 接受 agent 完结前检查：数据产出意图 + 零 formal-route 调用 + 无结构化 blocker → 注入一次有界系统 nudge 给补跑机会。来源见 [reports/2026-08-29-gold-qwen-direct-validation-study.md](reports/2026-08-29-gold-qwen-direct-validation-study.md) 直问2。
- [ ] **设置接线审计整改（剩余待认领）。** 报告见 [`audit/2026-08-28-settings-wiring-audit.md`](audit/2026-08-28-settings-wiring-audit.md)。P0/P1 主体与 P2 大部分已于 2026-08-28 修复（`main@523e0f29`）。剩余待认领：P1 personalization 接线（需产品决策，先 `[Q]`）、`safety_reserve_ratio` 语义统一；P2 api_key 掩码边角、compaction 参数前端编辑入口。
  - 验收：整改后重放设置审计报告的”主要可疑问题汇总”逐项可勾。
- [ ] **输出格式扩展：宽表/合并导出（评审建议，待产品决策）。** 下游统计（pandas/tidyverse）常用合并宽表；评审指出过度拆分多表会降低”输出格式可用性”。评估在既有 CSV 多表基线之上提供可选的宽表展平视图（按 schema 声明的 join 键展平），不改动确定性多表存储。实施前先 [Q] 征求产品决策。
  - 验收：存在可选宽表导出且与多表 Manifest 逐表可对账；现行单表交付（如 gold8 FAERS 计数）不受影响。
- [ ] **极低风险正式化免人审路径（待产品决策，先 `[Q]`）。** `propose_browser_evidence_acceptance` 目前一律 blocking HIL（policy `browser.acquisition.evidence-acceptance.v1`）。对确定性可校验的极低风险证据（例如 media type 为 JSON 且与 PROMOTED recipe 的 registered parser/schema 双 digest 绑定）可考虑免人审自动过。该路径削弱 fail-closed 评审门，实施前需先 `[Q]` 明确风险边界（限定媒体类型与 digest 绑定、上线初期抽审、可回滚开关）。
  - 验收：符合限定条件的证据自动 formalize 并在事件流记录 auto-accept 依据与 policy ref；其余路径门禁不变；有复现测试与开关回退验证。
- [ ] **闭世界准入不变量 ↔ 守卫测试映射（回应"需形式化"评审意见）。** 从 `ARCHITECTURE.md` §19 顶层不变量提炼动态 Family 准入相关不变量（输入角色闭包、输出精确闭合、闭世界校验只接受注册规则或绑定证据的变更、变换方不可选择校验/评估/发布模块、逐文件摘要重算），形成"不变量 → 守卫测试/实现位置"映射表，落 `docs/architecture/` 对应章节并作为论文素材。来源见 `reports/2026-08-30-architecture-and-report-review.md`（评审报告待提交入库） §3.2。
  - 验收：每条准入不变量可指到守卫测试或代码位置（如 `server/tests/phase8-architecture-guard.test.ts` 对应项）；映射表进架构文档并被报告引用。

## 论文整改遗留（2026-09-05 两轮评审核验后；表述类问题已落地，以下为需运行数据/实验支撑的硬项）

- [ ] **M1 数据值正确性对照评测。** 主体即 P0"参考集对照准确性评测（G1 evaluator）"条目；补充三点：样例1 两环境互查需补抽样协议与共有记录数并更新报告 5.4.2；样例6 图表通道统计提取点数、误差分布与 `chart_evidence_gate` 排除量并写入 5.4.3（本版已声明为零量化）。
- [ ] **M3 完备性疑点核实。** 核实样例3/样例5 活性数据恰为 100 行是否为检索分页上限，结论写入报告；样例4 文献仅 2 行的完备性说明。
- [ ] **M5 架构图 4.1 表述。** 图中"Agent 不可编排 DAG"与"Agent 设计多表拓扑"并置易读作自相矛盾（正文 3.5 已加执行编排 vs 产品结构的澄清）；修改 drawio 源措辞并重导出（遵循 drawio-diagram-style skill）。
- [ ] **M6 反馈迭代与 HIL 细节。** 从样例6 flash 运行事件恢复 v1→v2 替代的错误原因、反馈来源与修改内容并写入 5.4.3（本版仅指向归档事件记录）；细分 3 次受控来源访问授权的人工/初审归属；测 LLM 初审准确率与同族自审偏差。相关：P1"HIL 交互案例级证据归档"。
- [ ] **M8 VLM 通道量化与配置依据。** VLM 置信度三档的校准与误差率；"降级失败"判定的显式定义；图表提取选用 qwen3.8-flash（轻量档）承担高精度数值提取的理由或档位调整。
- [ ] **M9 消融与测量口径。** 关键机制消融（完成规则、进度注入、准入检查单独关闭）；样例6 补同机同网声明（样例1 已有）；统一 B/Q 计时计量口径。
- [ ] **M12 泛化性检验（去预置能力演示）。** 在无注册数据家族/解析器的新领域运行动态路线端到端案例，检验 Agent 自主性对预注册能力的依赖程度；报告 6.4 已作权衡声明与边界标注。回应第二轮评审第 10、12 条。
- [ ] **M14 HIL 负载量化。** 每任务与每千条记录的人工审核次数与耗时、人工纠错率、全自动模式下的对照错误率；报告 5.2.2 与 6.4 可直接引用。回应第二轮评审第 14 条。
- [ ] **M16 报告篇幅再平衡。** 赛题权重为科学价值 40%/技术深度 30%/应用潜力 30%，当前第四章机制描述占比偏高，而"科学事实表达准确性"与"数据查找完备性"的直接证据为零；随 M1 对照评测落地后重排章节比重，正文 6.5 已先作证据边界声明。
  - 进展（2026-09-05）：ch04 工程细节已压缩（采集/规范化/发布合并精简，删 SSRF/原子切换等机制细节）；ch03 AI 侧已展开（需求编译样例1实例、来源发现样例8自主恢复实例、3.6.2 行为约束小节：时限幻觉/同路撞墙/发布后自检三类实测失败模式 + r3→r4 量化迭代 60→36 调用、5.71M→3.73M token、7+→2 工具错误）。章节比重终核待 M1 证据落地后进行。

## 模型卡点收集期（只登记，暂不修）

- [ ] **gold 案例批量测完后统一分流修复模型卡点。** 收集清单见 [`evaluation/model-blockers.md`](evaluation/model-blockers.md)（分流总表在 [`evaluation/triage.md`](evaluation/triage.md)；gold1@qwen3.8-flash 已登记 B1–B6：观察缺口盲猜参数、动态路由零调用、时限幻觉、同路撞墙、activate 摩擦、GDC 浅尝辄止）。等组员把其余 gold 案例跑完补齐清单后，再按 prompt/产品/接口陷阱分流立项修复；期间**不改** `phase1-prompt.ts`、适配器或工具行为。
  - 验收：清单每条有证据（seq/正文）与归类；修复立项后逐条回写去向（prompt 提交 / TODO 新项 / ISSUES）。

## Deferred / 非当前工作

- **shadcn vendored skill 整包 re-vendor：** `.agents/skills/shadcn/` 是 2026-07-12（`e50130fa`）的上游快照；2026-09-03 skill 冗杂审计只同步了 `SKILL.md`（toast 指引两处，本项目为 Base UI 系），并把 `skills-lock.json` 的 `computedHash` 约定固定为「上游 pinned 文件字节的 SHA-256」。其余参考文件（`cli.md`、`mcp.md`、`registry.md`、`customization.md`、`rules/*`、`evals/`、`agents/openai.yml`）相对上游已漂移约 4.7k 行，应作为独立任务整包 re-vendor 并逐文件过目，不与其它改动夹带。
- **Publication 驱动 Run 终态闭包：** 不实施“只有产生 Publication 时 Run 才完成”。非数据汇报无需 Publication；简短 Run progress context 仅作软提示，数据产品的正式完成由 ProductAssessment + Publication 证明。
- **通用 Agent DAG、Transform 市场、一次性删除静态 Registry：** 不属于当前发布闭环。

## 完成规则

每个任务按 [`../AGENTS.md`](../AGENTS.md) 执行：测试先行、Commonly/board 同步、专用分支、质量门（定向测试优先）、文档与 TODO 同步。待办项完成并从本文件删除；确需保留的**完成记录**（如上文带 `[x]` 与日期/提交来源的条目）明确标注为「完成记录」而非待办，可保留在对应小节，或在需要长期引用时整理进 `audit/`、`archive/` 或 `FEATURES.md`。
