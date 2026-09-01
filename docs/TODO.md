# BioMed-QAgent 开发 TODO

> 本文件只记录当前可执行工作与验收条件。架构边界见 [`ARCHITECTURE.md`](ARCHITECTURE.md)，已知缺陷见 [`ISSUES.md`](ISSUES.md)，历史任务快照见 [`archive/TODO-2026-08-24-before-governance.md`](archive/TODO-2026-08-24-before-governance.md) 与 [`archive/TODO-2026-08-29-governance-closure.md`](archive/TODO-2026-08-29-governance-closure.md)。

## 当前目标

显式 `in_process_unisolated` Family Host/Core publication chain 已是 `main` 稳定基线，但它不是 sandbox 或安全边界。当前工作集中在同一冻结 commit 的 Gold release 证据、identity/recovery hardening 和产品闭包；除非新增 ADR，不开发 sandbox/container/IPC backend。

## P0 — Release evidence

- [ ] **冻结单 Host Gold1–Gold6 证据。** 在同一 commit、同一 Host 与同一 data root 上记录 task/run/requirement、registered input、OperationResult、B3、ProductAssessment、Publication 与 Artifact API hash 证据；缺失证据必须标为 blocked/unknown，不能用历史产物补齐。
  - 验收：Gold1–Gold5 的每项结论可回溯到同提交证据；Gold6 只有在真实 `publication_acceptance` HIL 后才可通过。
  - 前置：应用 provider 账户与 live source 可用；运行期间不得并行启动第二个 Host（并行 Host 现已由 tasks-root 独占租约在代码层拒绝，见 `server/src/runtime/host-lease.ts`）。
  - 进展（2026-08-30，`feat/gold6-t8-closure`）：Gold6 vision pipeline 修复（T1–T7）之后，代码级闭环已由 `server/tests/gold6-current-head-e2e.test.ts` 在假 provider/假 VLM/真 HIL 门下全程验证（冻结 prompt + execution_context → 三 PMCID 注册载体 → 受治理抽取 → accept/correct 评审 → 六表候选 → 真实 `publication_acceptance` → Host 重启续跑恰好一次 Publication → Artifact API SHA-256 重算）。前置 XML 获取通道随后已通过 `europepmc.fulltext_xml.v1` 闭合。
  - 进展（2026-08-31，`fix/gold6-governed-pdf-rendering`）：R1 live 暴露的 embedded-image-only 与 VLM `paper.title` 依赖已修：正式抽取改用已验摘要 PDF 字节的 216 DPI 完整页面渲染（有界选页/像素闸），注册 JATS XML 提供权威元数据和 paper identity；三份 R1 PDF/XML 真件离线回归全部成功。
  - 进展（2026-08-31，R2 `main@e17409ef`）：完整页面+真实 VLM 已产出 PMC5355725/PMC5094958 两份 governed carrier，但 run 仍为 `blocked_no_publication`：formal submit 缺 derived `vlm_extraction` provenance，PMC10408569 单页缺 `protein` 令整篇失败，成功 carriers 又均为 `chart_points=0`；assert 事件分页和 supervisor adopt/resume race 同时暴露。
  - 进展（2026-08-31，`fix/gold6-r3-closure` + 唯一 R3 `main@e680d423`）：五项代码修复已集成并完成 live 复验：三篇 exact-byte `vlm_extraction` derived carriers 均通过 formal provenance，page-local schema 失败不再连坐整篇，assert 分页与 supervisor adopt/resume 生效；定向回归既有 41/41。R3 仍为 `blocked_no_publication`（task `task_ts_b674…d9c1`、run `run_ts_be6…d993`，17,497 events、0 artifacts、0 acceptance HIL）：真实三篇合计 121 experiments / 221 activity values / 103 series / **0 points**；dynamic publication 被“必须 Core-owned supplementary member”与“registered input 必须 UTF-8 文本”两道互斥 gate 阻塞。证据已归档至 `data/gold-runs/e680d4232531-gold6-qwen38flash-r3-standard/`；R1/R2/R3 均不得补记为通过。
- [ ] **端到端图表 Gold 案例（对齐加分项"自动识别图表坐标轴或图例解析错误"）。** 图表证据已接通正式发布闭环（见下方已完成项），但 gold7–9 未有含图表场景的端到端案例；评审明确将其列为最高优先级失分点（"图表数据处理"是赛题核心能力）。补一个自然语言 TOPIC 出发、含论文图表抽取与坐标轴/图例核验的端到端 Gold 案例。
  - 验收：TOPIC → VLM/PDF/caption 抽取 → chart 四表（chart_series / chart_points / papers / sources）→ 正式 Publication；坐标轴名/单位/刻度与图例状态经 `axis_validation_status` / `legend_validation_status` 门禁；exact 点与 unclear 轴/图例语义冲突 fail-closed；单位 token 不漂移；低置信度点经 HIL 修正后保留 original 值；评审可经报告 5.5 所述 API/前端复现。
  - 当前边界（2026-08-30）：现有闭环从已注册的富 `chart-evidence.json` 开始，`extract_chart_data_vlm` 的 workspace CSV 尚无生产转换/注册路径；Gold6 runner 也未把冻结 source/schema 约束送入 Run。先按 [Gold6 图像链修复实施计划](superpowers/plans/2026-08-30-gold6-vision-pipeline-repair.md) 闭合当前 Gold6，再决定是否新增 gold7–9 图表案例。
  - 进展（2026-08-30，`feat/gold6-t8-closure`，Task 8 steps 1–4）：Gold6 侧 runner 已把冻结约束送入 Run（T1），prompt/skill 已教学"冻结 execution_context 绑定任务语义但绝非发布权威、carrier/VLM/locator/review 不可用即结构化 blocker"；e2e 已验证低置信度点经 HIL correct 后 original 值保留并进入正式 Publication。剩余同上条：live run + 真人 HIL + `assert-current-run` 证据包。
- [ ] **参考集对照准确性评测（G1 evaluator 落地，报告最高权重项零量化）。** 评分标准"科学事实表达准确性（0-15）"与"数据查找完备性"目前没有任何对照参考数据的量化证据：gold7 正式发布 88/3,109 参考 locus 行、gold8 覆盖 9/约 50 请求药物，报告均只作定性披露；`docs/evaluation/gold-v1/` 的 manifest 已预留 final G1 evaluator，但对照评测未实现（strict 计分 0/6）。实现 publication-vs-reference 对照评测：行级覆盖率、字段命中率、数值一致性抽样（可先为 gold7/8/9 冻结参考 + 脚本化，后续并入 gold-v1 全六例），并顺带完成三案例（冻结提交 `e8d03589`，早于占位符筛查 `22d87d15`）的内容级复核，回应时间线质疑。来源见 `reports/2026-08-30-architecture-and-report-review.md`（评审报告待提交入库） §4.2。
  - 验收：每案例产出可复核对照表（覆盖行数、字段命中率、数值一致率 + 不一致样例）并可直接引用进报告第五章；gold-v1 strict 计分推进，或在报告中显式说明未全量重跑的原因。

## P1 — Runtime and evidence hardening

- [ ] **权威 dataset/revision identity 接入生产路径。** 从 `DatasetCore` 传递 task-owned registration receipts，基于冻结 provider revision 与 asset closure 生成 identity；通过显式 V2 schema/PK 迁移 expression adapters。
  - 验收：`dataset_id`/`dataset_revision_id` 不来自 requirement ID、注册时间或调用方自报；V1 schema 不静默扩列；缺少权威事实时 fail closed。
- [ ] **checkpoint/reuse/restart 闭环。** 持久化 implementation/release identity，在真实 reuse 前调用 verifier，并补齐 owner fencing、orphan cleanup、restart 与 TOCTOU 回归测试。
  - 验收：input/params/FamilySpec/implementation/runtime/policy 任一 digest 改变都会使 checkpoint 失效；cancel/timeout/restart/stale generation 不能提交或复用旧 Publication。
- [ ] **统一 HIL Questionnaire。** 将 `UserInputDialog` 迁移到现有 Questionnaire 基础设施。
  - 验收：现有权限和 publication acceptance 流程行为不回退；历史事件仍可重放。
- [ ] **数据集请求 formal-route scaffold。** 只读 capability preflight 已接入；继续由服务端生成 digest-bound dynamic execution skeleton，并为候选 semantic family/projection、单一行粒度、可用 Core providers 和缺失 blockers 提供确定性输入。
  - 验收：gold7 类复合请求可拆为多个 projection/requirement；无 provider 时形成结构化 blocker，且不把 workspace 文件提升为正式产物；事件重放结果一致。
 - [ ] **Gold6 live 图表 evidence 到正式 Publication 证据归档。** Core profile scaffold、正式 VLM evidence asset、supplementary ZIP member/parser、JATS/BioC carrier parser、`literature_experiment_chart` 六表投影与 publication 前 manifest/HIL 校验已落地；非 Gold fixture 已由 `literature-experiment-chart-e2e.test.ts` 跑通完整六表 Publication 与 Artifact SHA-256 校验。2026-08-30 live 修复轮已按用户指令终止，仍无 Publication；未闭环问题与复现证据见 [`reports/2026-08-30-gold6-live-analysis.md`](reports/2026-08-30-gold6-live-analysis.md)。仍需在同一 Host/commit 上重跑 Gold6，记录真实 `vlm_extraction` 与 `publication_acceptance` HIL、B3、OperationResult、Manifest 和 Artifact API SHA-256 证据。
  - 进展（2026-08-31）：prepared submission 已持久化到 task-owned 原子状态，未消费 receipt 可跨 Host 重启继续 submit；health 现暴露 `product_commit`，Gold supervisor 在指定 expected commit 时对缺失或不匹配均 fail closed。仍需 fresh live run 关闭真实来源、VLM/HIL 与 Publication 证据。
  - 进展（2026-09-01，`fix/gold6-postmerge-stabilization`）：live Terra-high 逐层复现并修复 JATS 元数据权威、完整页 PDF 渲染、pdf.js 对象等待、并发 acquisition/registry 持久化、adopt/resume 与断言分页/退出、坏页隔离、VLM DNS/断流重试、局部 supplement 空表、跨页 experiment 去重及无点 carrier formal provenance。`c4ea4ee5` fresh run 三篇 evidence carrier 均成功、prepare 成功且 submit 已越过 provenance 门；最终仅因该窗口三条 Core supplementary 获取持续 5xx、合并后 `supplementary_asset_records` 为空而被严格拒绝。legacy helper 随后下载成功但未越权提升。仍需在 Europe PMC Core supplement 可用窗口 fresh rerun并完成 `publication_acceptance`/Artifact hash 闭环。
 - [ ] **Gold6 live 图表 evidence 到正式 Publication 证据归档。** 代码级 fixture 闭环已存在，R3 又证明三篇真实 VLM evidence carrier 的 acquisition + exact-byte derived provenance 可成立；但正式 Publication 仍未出现。R3 实证根因是 `literature_experiment_chart` 强制 Core-owned supplementary member，而 transform host 把每个 registered source 都当 UTF-8 文本输入；三篇 supplementary archives 只有 PDF/JPG/GIF，binary member 无 provenance-only binding 形态。先对齐这两道 gate（或增加 Core-owned binary→UTF-8 parser carrier），再补 103 series / 0 points 的 axis-unit/review closure；修复前不启动 R4。验收仍是同一 Host/commit 下真实 `vlm_extraction` 数据审查、`publication_acceptance`、B3、OperationResult、Manifest 与 Artifact API SHA-256 全链，workspace provisional 文件不得替代。
- [ ] **QueryPlan / SourceCoverage 完整检索语义与生产 ledger 接线。** 在 `@biomed/contracts` 先定义稳定 wire DTO，由 Core 拥有并生成检索计划与覆盖结果；覆盖证据作为 Manifest 的 `audit_report` artifact 发布，不冒充逐行 provenance 或主数据。
  - 验收：记录 source universe、source、query、filters、time window、requested/succeeded pages、raw/deduplicated/selected counts、失败与排除原因及 `retrieved_at`；只在预先定义的 source universe 内计算 coverage/recall，不允许 Agent 文本自行宣称“全网查全”。
- [x] **Agent 消费 SourceCoverage 并按覆盖缺口补源。** 静态/registered publication 的 `source_coverage_report.json` 现在有受信只读 Agent 工具 `inspect_source_coverage`；工具只从最新 immutable manifest 定位并重算 artifact SHA-256，再返回 scope note、汇总和 failed/not_attempted 绑定摘要。Dataset execute 成功摘要也携带有界 coverage view；Agent skill 已要求仅按声明绑定范围决定独立补源，Dynamic Family 无报告时显式 coverage unavailable。候选排序/清洗预检另见 P2 记录；本项不宣称全网查全。
- [x] **清洗规则提议与候选排序基础。** 新增 `preflight_cleaning_rules` Agent 工具、严格 `CleaningRuleProposal` contracts、Core 侧 schema/unit whitelist 预检和 `string_similarity.v1` 稳定排序/歧义判定；唯一相似候选没有注册语义规则仍进入 HIL。NormalizationProfile 在注册时拒绝重复路由、越界目标单位和非线性公式。Core execute 现在要求 task/run/requirement/binding 绑定的 digest receipt，重算预检事实并以 task-owned 原子消费标记拒绝跨重启重放；注册单位规则沿用 canonicalizer 的 `value * factor + offset` 路径。任意字段 transform 仍不执行，未注册/歧义映射继续 HIL。

- [x] **Canonical 图表 evidence 到正式 Publication 闭环（代码能力）。** 将现有 `bioactivity-measurement/chart-evidence` 模块接入受控的 Family Registry、Adapter/Assembler、Validation、ProductAssessment 与 Publisher 路线；VLM/PDF/caption 输出必须先成为 task-owned、摘要绑定的 evidence asset，不能让任意 workspace CSV 直接获得正式发布权。
  - 验收（2026-08-29 达成）：chart 四表进入生产 `bioactivity_measurement` family（schema + registered JSON parsers + 组装分派），点级 provenance/review 门在组装前 fail-closed（结构化 `chart_evidence:chart_evidence_gate` 检查写入 validation_report，不产生 Publication），经 B3 + Publisher 走既有原子发布。点级 Gold（`server/tests/chart-evidence-publication-closure.test.ts`）覆盖 accepted/corrected（HIL correction 保留 original 值与 human_correction 步骤）、artifact bytes 与 SHA-256 重算、pending review 与缺表拒绝；`publication_created`/`artifact_produced` 事件重放由既有 durable-runtime 测试锁定。evidence ownership、review 状态机与 schema 兼容策略见 `architecture/canonical-evidence.md` § figure/chart evidence publication route；未改变 Core publication trust boundary，无需新 ADR。
- [x] **QueryPlan / SourceCoverage 基础闭环（已完成范围）。** 在 `@biomed/contracts` 先定义稳定 wire DTO，由 Core 拥有并生成检索计划与覆盖结果；覆盖证据作为 Manifest 的 `audit_report` artifact 发布，不冒充逐行 provenance 或主数据。
  - 验收（交付范围见下方完成记录与遗留项）：记录 source universe、source、query、失败与
    排除原因及 `retrieved_at`；覆盖 hostile wire、分页中断、重复来源、部分来源失败、事件
    重放和 artifact hash，任何部分失败都在正式结果中显式可见；只在预先定义的 source
    universe 内计算 coverage/recall，不允许 Agent 文本自行宣称“全网查全”。完整检索
    `filters`、`time_window`、requested/succeeded pages 与 raw/deduplicated/selected
    counts 未进本次交付，单列为遗留项。
  - 测试：覆盖 hostile wire、分页中断、重复来源、部分来源失败、事件重放和 artifact hash；任何部分失败都在正式结果中显式可见。
  - 完成（2026-08-30，`feat/source-coverage-evidence`）：`@biomed/contracts` 新增 `SourceCoverageReport` wire DTO 与 hostile parser（summary 强制与条目一致，汇总撒谎即拒绝）；Core 在发布装配时确定性生成 `source_coverage_report.json` 并以 `audit_report` 入 Manifest（V1 静态 `auditPaths` + V2 注册式发布条目两路线）；`query_plan` 由规格绑定确定性投影，`acquisition_coverage` 携带回执（asset_id/SHA-256/字节/media_type/`registered_at`）、行数记账（解析/规范化保留/拒绝）与排除原因；runtime 检索台账经 ToolHooks 累积、恢复路径由既有 `operation_*` 事件投影重建（`discovery-ledger.ts`），未新增事件类型，台账为审计输入、不进 authoritative identity。测试：`packages/contracts/tests/source-coverage.test.ts`（hostile wire/一致性/形状冻结）、`server/tests/source-coverage-report.test.ts`（字节确定性、部分失败显式、重复 operation_id fail-closed、事件重放投影、V2 e2e 逐件 SHA-256）。遗留：(1) 动态 Family 路线发布层无规格绑定与完整回执，暂不产出报告（`architecture/dataset-execution.md` §9）；(2) 完整检索语义未入 DTO——`filters`、`time_window`、requested/succeeded pages 与 raw/deduplicated/selected counts 仍是遗留（DTO 当前仅含 `requested_limit` 与解析/规范化行数记账）；(3) 生产构建未持有 ToolHooks ledger 时 `discovery_queries` 为 null，恢复时把生产 ledger 重新注入具体构建的完整接线仍属部分完成。
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
- [ ] **HIL 交互案例级证据归档（创新点三的实证缺口）。** 报告自述三旗舰案例"零权限暂停"，"更早轮次已单独验证"无可引用档案，创新点三目前只有测试级（`server/tests/chart-evidence-publication-closure.test.ts` 的 corrected 路径）与组件级证据。把一次真实 HIL 闭环全程留档（请求/暂停/决策/恢复事件流 + 前端截图 + 决策记录），候选场景：图表低置信度点 correct、单位结构化修正、发布验收 accept。前置：P0 端到端图表 Gold 案例或 Gold1-6 冻结证据项中的真实 `publication_acceptance`。来源见评审报告 §3.3。
  - 验收：形成可引用证据包（含事件流与截图），报告 4.9 与创新点三可指向该档案；HIL 三档审批策略（含 llm_pre_review 的 fail-safe 回退）在报告中有一句话说明。

## P2 — Product and developer experience

- [ ] **主 Prompt 可复现迭代。** 建立固定样例、指标和成本记录后再优化 `PHASE1_SYSTEM_PROMPT`。基线注记（2026-08-30）：已在 PHASE1 前新增 `[System briefing]` 系统简介段——系统设定、无墙钟时限、防空转止损、工作流；独立导出 `SYSTEM_BRIEFING` 并于 `PiAgentAdapter.createSession` 置首拼接，PHASE1 机制段文字零改动、≤8k 预算不变；回归测试见 `server/tests/pi-adapter.test.ts` system briefing 用例。后续优化以该基线做可复现对照。
  - 验收：变更有可复现实验对照，不引入 Gold case 特判，不放宽 Core 门禁。
- [ ] **Trait association / genomic annotation 可复用 family 闭包。** 按 [`architecture/trait-association-and-genomic-annotation-design.md`](architecture/trait-association-and-genomic-annotation-design.md) 实现来源无关的 projections 与 GWAS Catalog、supplementary archive、RefSNP 通用 providers；provider 与 family 保持多对多。
  - 验收：至少一个非 Alzheimer trait、两个不同数据库证明复用；variant/gene/region 粒度分别构建；不兼容 assembly、effect scale、allele/model 或 mapping method 的输入 fail closed；正式 Publication 通过 provenance/B3/ProductAssessment/Artifact hash 门。
- [ ] **End-of-run publication gate（数据类任务完成前发布闸门，P2）。** 2026-08-29 gold7 直问 campaign 实证：qwen3.7-flash 在零正式尝试时会直接交付"临时工作区结果+伪阻塞"（伪造穷尽前提），supervisor 只能事后诚实分类。拟在 runtime 接受 agent 完结前检查：数据产出意图 + 零 formal-route 调用 + 无结构化 blocker → 注入一次有界系统 nudge 给补跑机会。来源见 [reports/2026-08-29-gold-qwen-direct-validation-study.md](reports/2026-08-29-gold-qwen-direct-validation-study.md) 直问2。
- [x] **生产 Host 端口冲突恢复与单实例。** 2026-08-30 已实现（分支 `feat/host-port-single-instance`）：首选端口只有在真实 `EADDRINUSE` 时才回退到 OS 原子分配的端口并输出 `BIOMED_QAGENT_URL`；`pnpm start` / `--static` 在资源初始化前申请每用户原子目录租约，已有实例时正常 no-op，死 holder 可恢复且旧 token 不能删除 successor；开发模式仍由 tasks-root lease 保护单一 durable writer。发布 bundle smoke 覆盖预占 5173、实际 URL 健康检查、第二实例拒绝和关闭后重启。
- [x] **Dynamic submit 免巨型回显（receipt-referenced submit）。** 2026-08-29 已实现（分支 `feat/receipt-referenced-submit`）：preflight coordinator 在 commitPrepare 存储完整 prepared submission（**Host 进程内状态，非跨重启 durable store**）；`submit_dynamic_family_publication` 接受 `{schema_version, preflight_receipt}` 最小 wire，服务端按 receipt 解析存储的 submission（回显全量仍兼容接受）；工具 schema 必填键降为两项，系统提示词 [Dynamic publication mechanics] 段同步教学。原描述（2026-08-28 gold9 r3/r4 实测）：prepare 返回 ~97KB JSON，submit 要求逐字回显，deepseek-v4-flash 在 32,768 输出预算边缘丢字段（空 registered_sources / >128 逐记录角色），见 [ISSUES §代码质量](ISSUES.md)。 2026-08-28 gold9 r3/r4 实测：prepare 返回 ~97KB JSON，submit 要求逐字回显，deepseek-v4-flash 在 32,768 输出预算边缘丢字段（空 registered_sources / >128 逐记录角色），见 [ISSUES §代码质量](ISSUES.md)。服务端 prepare 已持有 task/requirement/generation 绑定状态，submit 改为回传 `receipt_digest` 引用 + 可选覆盖项；wire 契约先进 `@biomed/contracts` 并带 hostile 用例。
  - 验收：小模型在 gold9 级（≥5 源）spec 上无需回显全量 prepared_submission 即可完成 submit；>64 bindings 早拒信息（`f83ceca0`）保持不变。
- [ ] **设置接线审计整改（剩余待认领）。** 报告见 [`audit/2026-08-28-settings-wiring-audit.md`](audit/2026-08-28-settings-wiring-audit.md)。P0/P1 主体与 P2 大部分已于 2026-08-28 修复（`main@523e0f29`）。剩余待认领：P1 personalization 接线（需产品决策，先 `[Q]`）、`safety_reserve_ratio` 语义统一；P2 api_key 掩码边角、compaction 参数前端编辑入口。
  - 验收：整改后重放设置审计报告的”主要可疑问题汇总”逐项可勾。
- [ ] **输出格式扩展：宽表/合并导出（评审建议，待产品决策）。** 下游统计（pandas/tidyverse）常用合并宽表；评审指出过度拆分多表会降低”输出格式可用性”。评估在既有 CSV 多表基线之上提供可选的宽表展平视图（按 schema 声明的 join 键展平），不改动确定性多表存储。实施前先 [Q] 征求产品决策。
  - 验收：存在可选宽表导出且与多表 Manifest 逐表可对账；现行单表交付（如 gold8 FAERS 计数）不受影响。
- [ ] **极低风险正式化免人审路径（待产品决策，先 `[Q]`）。** `propose_browser_evidence_acceptance` 目前一律 blocking HIL（policy `browser.acquisition.evidence-acceptance.v1`）。对确定性可校验的极低风险证据（例如 media type 为 JSON 且与 PROMOTED recipe 的 registered parser/schema 双 digest 绑定）可考虑免人审自动过。该路径削弱 fail-closed 评审门，实施前需先 `[Q]` 明确风险边界（限定媒体类型与 digest 绑定、上线初期抽审、可回滚开关）。
  - 验收：符合限定条件的证据自动 formalize 并在事件流记录 auto-accept 依据与 policy ref；其余路径门禁不变；有复现测试与开关回退验证。
- [ ] **闭世界准入不变量 ↔ 守卫测试映射（回应"需形式化"评审意见）。** 从 `ARCHITECTURE.md` §19 顶层不变量提炼动态 Family 准入相关不变量（输入角色闭包、输出精确闭合、闭世界校验只接受注册规则或绑定证据的变更、变换方不可选择校验/评估/发布模块、逐文件摘要重算），形成"不变量 → 守卫测试/实现位置"映射表，落 `docs/architecture/` 对应章节并作为论文素材。来源见 `reports/2026-08-30-architecture-and-report-review.md`（评审报告待提交入库） §3.2。
  - 验收：每条准入不变量可指到守卫测试或代码位置（如 `server/tests/phase8-architecture-guard.test.ts` 对应项）；映射表进架构文档并被报告引用。

## 模型卡点收集期（只登记，暂不修）

- [ ] **gold 案例批量测完后统一分流修复模型卡点。** 收集清单见 [`evaluation/model-blockers.md`](evaluation/model-blockers.md)（分流总表在 [`evaluation/triage.md`](evaluation/triage.md)；gold1@qwen3.8-flash 已登记 B1–B6：观察缺口盲猜参数、动态路由零调用、时限幻觉、同路撞墙、activate 摩擦、GDC 浅尝辄止）。等组员把其余 gold 案例跑完补齐清单后，再按 prompt/产品/接口陷阱分流立项修复；期间**不改** `phase1-prompt.ts`、适配器或工具行为。
  - 验收：清单每条有证据（seq/正文）与归类；修复立项后逐条回写去向（prompt 提交 / TODO 新项 / ISSUES）。

## Deferred / 非当前工作

- **Publication 驱动 Run 终态闭包：** 不实施“只有产生 Publication 时 Run 才完成”。非数据汇报无需 Publication；简短 Run progress context 仅作软提示，数据产品的正式完成由 ProductAssessment + Publication 证明。
- **通用 Agent DAG、Transform 市场、一次性删除静态 Registry：** 不属于当前发布闭环。

## 完成规则

每个任务按 [`../AGENTS.md`](../AGENTS.md) 执行：测试先行、Commonly/board 同步、专用分支、质量门（定向测试优先）、文档与 TODO 同步。待办项完成并从本文件删除；确需保留的**完成记录**（如上文带 `[x]` 与日期/提交来源的条目）明确标注为「完成记录」而非待办，可保留在对应小节，或在需要长期引用时整理进 `audit/`、`archive/` 或 `FEATURES.md`。
