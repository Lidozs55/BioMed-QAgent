# 已知问题

> 这里只保留尚未解决、可复现或明确待验证的问题。计划性工作放在 [`TODO.md`](TODO.md)；2026-08-24 前的关闭记录见 [`archive/ISSUES-2026-08-24-before-governance.md`](archive/ISSUES-2026-08-24-before-governance.md)。

## 前端交互

### 快速点击可能重复或丢失

- **状态：** 待复现。
- **现象：** 快速点击主题切换或其他按钮时，可能出现一次点击触发两次或未触发。
- **下一步：** 用 pointer/click 事件测试确定是否为重复 handler、事件穿透或状态节流问题；确认后先提交失败测试。

## 数据族与 Gold 评测

### gold7 trait association 请求没有形成正式 publication

- **状态：** 2026-08-25 在 fresh run `task_ts_65211501-9abc-42c4-8f3b-178e104b8dc2` 再次复现，仍待 dynamic scaffold、supplementary extraction carrier 与终态门闭环。
- **现象：** 当前 production static Registry 缺少可复用的 trait-association 与 genomic-annotation 语义能力；不能按数据库建立 `gwas_association` family，现有 `variant_evidence` 也不等价。GWAS Catalog 和 RefSNP 已有 Dynamic Family Core provider，但 Bellenguez supplementary ZIP/XLSX 尚无 dynamic transform 可消费的可信解析后载体。
- **证据：** rerun `task_ts_ae9b71f9-02af-44ae-a3b4-f75ba8a98d02` 的 1,238 个事件中，`validate_dataset_build`、`execute_dataset_build` 和 `submit_dynamic_family_build` 调用均为 0，最后为 `run_completed(build_result=null)`。动态工具当时已注入，prompt 也要求正式产物经 Core；Agent 却从首段计划起直接采用 workspace/Python 三表流程。本次没有 `conversation_compacted`，不能把失败归因于上下文耗尽。
- **影响：** 复合 biomedical 请求可能在没有可用 family/provider 时退化为 workspace 草稿，任务状态却仍显示 completed；不能形成可追溯的 formal DatasetPublication，也容易诱发模拟数据。
- **局部缓解：** discovery 已能获取官方 supplementary ZIP、GWAS Catalog association 和 RefSNP 记录；GWAS Catalog/RefSNP provider 也已进入由 `provider-catalog.ts` 派生的 Dynamic Family schema/runtime 闭包。首轮只读工具 `inspect_dataset_build_routes` 现从 production static Registry 与统一 provider catalog 投影 exact static match、dynamic-bindable input 和 acquisition-only carrier，不再要求模型从 static enum 或大型 Dynamic schema 反推接线。它明确将 `europepmc.supplementary.v1` 报告为“Core 可获取、仍缺 provenance-bound UTF-8 extraction”，因此不会把 provider wiring 冒充完整 publication closure。
- **根因分层：** (1) 已有 capability inspection，但路径选择和 semantic projection 仍依赖模型，尚无终态门；(2) 动态工具输入复杂：单次提交要求完整 FamilySpec、Projection、transform、proposal、bindings 和 digest readmission，缺少服务端 scaffold；(3) supplementary extraction closure 缺失：Core 可登记官方 ZIP archive，但 phase3 dynamic binding 不能选择 provenance-bound XLSX-to-CSV extraction asset；(4) runtime 把未产生 BuildResult 的 dataset request 仍标为 completed。
- **下一步：** 修订设计见 [`architecture/trait-association-and-genomic-annotation-design.md`](architecture/trait-association-and-genomic-annotation-design.md)。先用 fresh gold7 验证 capability inspection 是否被调用；随后另行评审 server-generated scaffold、supplementary extraction carrier 与只针对 dataset-producing request 的终态闭包。未来 static family 仍须来源无关并以非 Alzheimer trait/多数据库复用证明；能力缺失必须形成明确 `no_data`/`spec_rejected`/blocked outcome，不得把 workspace 文件自动提升为 Artifact。

### gold8-gold10 仍缺正式 family/provider，部分上游来源不可达

- **状态：** 2026-08-24 已修复可控 discovery 阻塞，正式 publication 能力仍缺失。
- **gold8：** 新增 `lookup_openfda_dili_counts`，以有界官方查询替代超时的 Agent 脚本；live 变体复核发现 openFDA 聚合前 999 项会漏掉真实低频 PT，现已对聚合未返回的请求 PT 做 exact fallback，并区分官方 no-match 与 fallback 失败。ibuprofen 的 `HEPATIC INFARCTION`（7）和 `VANISHING BILE DUCT SYNDROME`（101）已通过 fallback 找回。当前环境访问任意 `www.fda.gov` 页面均返回 404，而 `api.fda.gov` 正常；DILIrank 完整文件不能因此改用论文附件或模拟分类冒充。正式 DILI family/provider 仍不存在。
- **gold9：** Europe PMC supplementary ZIP 优先链已对 IUIS PMID 41608114 live 成功（97,147 bytes，SHA-256 `7dfa5873…d9a277a`）；新增 `lookup_clinvar_counts`，BTK live 返回 total 1158、pathogenic/likely pathogenic 583。Orphadata/HGNC/ClinGen 仍需 provenance-bound provider，不能由 Agent 直接拼表。
- **gold10：** 新增 `search_mgnify_studies` 绕过动态 browse 页面；live 变体复核发现官方字段实际为 `bioproject`，publications 则是 relationship 而非 attribute count，现已修正 BioProject 映射并输出官方 publications URL，不再产生假性 null count。T2D study `MGYS00000322` 返回 145 samples 与 `PRJEB1786`。`gmrepo.humandisease.info` 当前 DNS 解析失败；MGnify metadata 不能替代 GMRepo prevalence 或论文 differential abundance 数据。
- **影响：** 三案现在可获取更多真实 discovery evidence，但仍不能产生 Dataset Core publication；外部失败必须保留为 `NO_DATA`/missing source，而不是零值或模拟行。
- **下一步：** 分别设计 DILI、IEI multi-source、microbiome association family/provider；为不可达的 FDA DILIrank 与 GMRepo 确认可审计的官方镜像或新入口后再接入 Core。
- **[P1] 限制（2026-08-26）：** browser evidence formalization 的 Core-promoted recipe 覆盖已落地：`browser.json.v1` 之类 catch-all 永不注册（fail-closed 测试覆盖真实 default catalog 下的 pre-HIL 拒绝）；首个生产 XLSX parser recipe（`browser.registered.registered_protein_structure_xlsx.1_0_0@1`）已通过证据接受 HIL -> formalization -> carrier parse 全链测试。**仍阻塞：** DOCX（`application/vnd.openxmlformats-officedocument.wordprocessingml.document`）与 legacy XLS（`application/vnd.ms-excel`）没有 Core-owned registered parser，任何 recipe 都 fail-closed（无 recipe 可注册/解析），直至有显式 promoted parser；Gold10 的 GMRepo 上游仍 DNS 不可达，MGnify metadata 不能替代 prevalence/differential-abundance 数据。详见 `docs/plans/trusted-browser-acquisition/DECISION-LOG.md` D-035。
- **[P1] 新增（2026-08-25 live run `e2e-gold8-002`）：** 当 DILIrank 上游不可达时，Agent 退化到 `download_from_page` 暴力循环（555 次对 `www.fda.gov/media/1341xx` 顺序 ID），且从未调用已就绪的 `lookup_openfda_dili_counts`、也未进入文档约定的 “stop / report NO_DATA” 分支。说明 Agent 缺少“上游持续失败即终止并报 NO_DATA”的护栏与工具选择约束。此缺陷是任何有效重跑的前提：要么加 loop/turn 与持久失败护栏，要么在 discovery 阶段把不可达来源显式标记为 NO_DATA 并继续用可达来源产出部分维度。修复后需以复现测试覆盖，改前不改数据源（外部 404 已复确认，FDA 与 NIEHS 双镜像均不可达，api.fda.gov 仍可达）。
- **[P1] 修复（2026-08-25，TDD + live 复测均已通过；⚠️ 该项设计已于同日按用户决定移除，勿重新实现）：** `server/src/runtime/durable-agent-runtime.ts` 的 `consumeRun` 新增护栏：连续工具失败达到 `GUARDRAIL_MAX_CONSECUTIVE_FAILURES = 8` 次时，追加 `run_guardrail_triggered` 事件（reason 含工具名与失败次数）并 `task.session.cancel(reason)` 终止 run。`packages/contracts/src/events.ts` 新增 `run_guardrail_triggered` payload；`server/tests/durable-agent-runtime.test.ts` 新增复现测试（13/13 通过，lint/typecheck 通过）。**live 复测已通过（e2e-gold8-004）**：真实环境下护栏在第 8 次连续 `download_from_page` 失败时触发（`run_guardrail_triggered` seq 733，reason 含 `download_from_page`/`8 consecutive times`）→ `run_cancelled` seq 738，6 分 46 秒内自动终止（对比 e2e-gold8-002 的 555 次循环/~23 分钟）。配套 tool-honesty 修复：`server/src/agent/tools/browser.ts` 的 `navigate_page` 失败分支与 `download_from_page` HTTP 非 2xx 分支现在返回 `isError: true`，此前 404 被持久化为 `is_error:false` 成功事件导致护栏无法计数（`server/tests/phase5/browser.test.ts` 新增 404 用例）。**剩余根因未关闭**：Agent 仍会绕开已就绪的 `lookup_openfda_dili_counts` 去 `download_from_page` 不可达的 FDA DILIrank 源、也不进入 NO_DATA 分支——护栏只限制损害，下一步需在 discovery 阶段把不可达来源显式标记 NO_DATA 并继续用可达来源产出部分维度（见下方 [P1] 新增条目与 TODO）。
- **[P1] 修复（2026-08-25，discovery 阶段 NO_DATA 标记，unit 级完成，TDD 通过；待 live 重跑）：** `server/src/agent/tools/browser.ts` 新增每任务闭包级 per-host transport 失败计数（`HOST_FAIL_FAST_THRESHOLD = 2`）：`download_from_page` 对同一主机连续 2 次 DNS/连接/超时等 transport 失败后短路（第 3 次起不再触网），返回结构化 `no_data: true` + `error: "host is unreachable: <hostname>"` + `isError: true`；下载成功即复位计数。HTTP 4xx/5xx 是端点级响应，不冻结整个主机，允许 Agent 修正 URL/参数后重试；校验类错误（unsafe filename / 已有 asset）也不计数（以 `transportStarted` 门控）。同时补齐 tool-honesty 缺口：DNS 解析失败/超时/空下载/超限等 catch 块错误现在与 HTTP 404 一样返回 `isError: true`（此前哨兵无法计数），`navigate_page` catch 块同步补 `isError: true`。TDD 覆盖 transport fail-fast、per-host 隔离、HTTP 404 不冻结主机与 unresolvable host 错误语义。**效果**：持续不可达主机第 3 次调用即返回结构化 no_data，同时不阻断同一可达主机上的端点修正。**live `e2e-gold8-005`（2026-08-25）** 不再出现 555 次顺序 ID 暴力循环；全部 8 次浏览器失败均持久化为 `is_error:true`。该 run 每主机仅 1 次失败，未触发 per-host fail-fast，且 `lookup_openfda_dili_counts` 仍未被调用——见下方 [P1] 新增条目。
- **[P1] 新增（2026-08-25 live run `e2e-gold8-005`）：** 护栏与 tool-honesty 已 live 验证，但“用可达来源产出部分维度”仍未实现。Agent 在被取消前推理始终锁定在寻找 DILIrank 替代镜像（LTKB FTP / GitHub），从未调用已激活的 `lookup_openfda_dili_counts`；per-host fail-fast 的 `no_data:true` 结构化短路因每主机仅 1 次失败而从未命中。另发现护栏语义是**跨工具全局**连续失败计数：6 次 `navigate_page` + 2 次 `download_from_page`（分属不同主机）被合并判定为 “navigate_page failed 8 consecutive times”，有损多源 discovery 的合理性。**下一步**：(a) discovery 阶段对被标记不可达的浏览器调用显式注入“切换到可达来源工具（`lookup_openfda_dili_counts`）/ 报 NO_DATA”的引导（prompt 或 runtime 提示）；(b) 或把护栏改为 per-tool/per-host 计数，使多源探测不被全局计数误杀。改前不改数据源（外部 404 已复确认）。**2026-08-25 决定：guardrail 设计整体移除（跨工具全局计数 + `run_guardrail_triggered` + cancel 均有损多源探测合理性）、路线2（per-tool/per-host 计数）被用户否决，仅采纳路线1（引导 Agent）——见下方新增修复条目标记。**
- **[P1] 修复（2026-08-25，路线1引导实现，TDD RED→GREEN 通过；配套移除 guardrail）：** `server/src/agent/phase1-prompt.ts` 的 `[Control and recovery]` 节写入固定恢复顺序：① 取数失败先调参重试同一路线（诊断错误并修正 URL/tool query/filename，仅对真瞬态 HTTP 429/5xx/timeout 重试；绝不重复未改动的失败调用）；② 调参重试仍失败才切换到真正独立的可靠来源验证同一事实（FDA 药物事件反应计数 → openFDA FAERS 聚合 `lookup_openfda_dili_counts`）；③ 换源失败或数据真实缺失才报 `NO_DATA`/来源不可用——不得提前放弃、避免滥用换源或误报。`server/tests/pi-adapter.test.ts` 新增契约测试 "guides adjusted-parameter retries before switching source or reporting NO_DATA"（RED→GREEN；正则锁定“调参重试 → 独立换源 → NO_DATA”的顺序与 openFDA FAERS 措辞；pi-adapter 29/29，prompt ≤7000 长度约束保持）。`server/src/runtime/durable-agent-runtime.ts` 的 `GUARDRAIL_MAX_CONSECUTIVE_FAILURES=8` 连续失败取消逻辑、`packages/contracts/src/events.ts` 的 `run_guardrail_triggered` 事件类型与 `server/tests/durable-agent-runtime.test.ts` 相关用例已全部移除。per-host fail-fast（`HOST_FAIL_FAST_THRESHOLD=2`、结构化 `no_data:true` 短路）与 tool-honesty（`isError:true`）作为引导的配套机制保留（不取消 run，只让 Agent 感知主机不可达）。质量门禁：contracts 120/120、server pi-adapter 29/29、browser 48/48 通过，workspace typecheck/lint 干净。**待 live 重跑验证引导生效**。

## 可选测试缺口

这些是非阻塞的覆盖增强，不代表已观察到生产故障：

- `GET /builds/{id}` 损坏 manifest 返回 409，以及中间页损坏分页。
- operation 事件顺序无关性与部分镜像 run 语义。
- 双读 API 对真实 `execute_dataset_build` 产物的 E2E，以及 `build_result` 全量重启回放。
- NO_DATA `data-variant` 与 `runId === null` reducer。
- `/cache/datasets?limit=` 页帽与 hook 负向用例。

## 维护规则

新增条目必须写出状态、影响、最小复现和下一步。修复从失败测试开始；合并后从本文件删除，由测试和提交历史承担关闭证据。架构 hardening 或产品里程碑不得重复登记在这里和 `TODO.md`。
