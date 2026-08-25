# 已知问题

> 这里只保留尚未解决、可复现或明确待验证的问题。计划性工作放在 [`TODO.md`](TODO.md)；2026-08-24 前的关闭记录见 [`archive/ISSUES-2026-08-24-before-governance.md`](archive/ISSUES-2026-08-24-before-governance.md)。

## 前端交互

### 快速点击可能重复或丢失

- **状态：** 待复现。
- **现象：** 快速点击主题切换或其他按钮时，可能出现一次点击触发两次或未触发。
- **下一步：** 用 pointer/click 事件测试确定是否为重复 handler、事件穿透或状态节流问题；确认后先提交失败测试。

## 测试稳定性

### `build-lock.test.ts` 全量运行偶发失败

- **状态：** 2026-08-14 在并行负载下复现，单文件连续 8 次通过。
- **影响：** `pnpm test` 可能因真实子进程文件锁时序与 CPU 争抢偶发失败。
- **下一步：** 增加进程间同步闩，或基于测量调整重试/时窗；不得仅隐藏失败。
- **历史上下文：** [`archive/LEFTOVERS-2026-08-09.md`](archive/LEFTOVERS-2026-08-09.md) §K1。

### `main@a884b159` 全仓测试存在两个确定性失败

- **状态：** 2026-08-24 在干净的 `origin/main` 基线复现；与本轮文档内容无关。
- **B3 parity proof：** `server/tests/b3-memory-disk-parity.test.ts` 计算证据文件 SHA-256 为 `a5534621…1609`，但 `PRODUCTION_B3_PARITY_PROOF.digest` 仍为 `324b8cf1…b610`。
- **solidify-run：** `server/tests/solidify-run.test.ts` 在 Vitest collect 阶段对合法的 vitest import 报 `SyntaxError: Invalid or unexpected token`；文件与 HEAD blob 一致且 `tsc` 通过，需继续定位 Vite/Vitest transform 输入。
- **下一步：** 分别核对 B3 证据生成/提交闭包；用最小 transform reproduction 定位 solidify-run collect failure。不得在不重生证据的情况下只改 digest，也不得跳过测试。

## 数据族与 Gold 评测

### gold7 trait association 请求没有形成正式 publication

- **状态：** 2026-08-24 在真实 run `task_ts_c93256a6-f374-4bc8-9795-d0a5ff3bc109` 复现，待架构设计与实现。
- **现象：** 当前 production Registry 缺少可复用的 trait-association 与 genomic-annotation 语义能力，也没有覆盖 GWAS Catalog、Bellenguez supplementary table、dbSNP/Ensembl 坐标整合的 Core Acquisition Provider。不能按数据库建立 `gwas_association` family；现有 `variant_evidence` 也不等价。
- **证据：** rerun `task_ts_ae9b71f9-02af-44ae-a3b4-f75ba8a98d02` 的 1,238 个事件中，`validate_dataset_build`、`execute_dataset_build` 和 `submit_dynamic_family_build` 调用均为 0，最后为 `run_completed(build_result=null)`。动态工具当时已注入，prompt 也要求正式产物经 Core；Agent 却从首段计划起直接采用 workspace/Python 三表流程。本次没有 `conversation_compacted`，不能把失败归因于上下文耗尽。
- **影响：** 复合 biomedical 请求可能在没有可用 family/provider 时退化为 workspace 草稿，任务状态却仍显示 completed；不能形成可追溯的 formal DatasetPublication，也容易诱发模拟数据。
- **局部缓解：** `fix/gold7-real-source-acquisition` 已让 discovery 工具优先获取 Europe PMC 官方 supplementary ZIP，并新增按规范数字路径调用 NCBI RefSNP API 的 `lookup_dbsnp`。2026-08-24 live smoke 成功获取 Bellenguez PMC9005347 的 27,656,649-byte ZIP（SHA-256 `a2902ab4…6ed26`）和 rs429358 RefSNP 记录。真实复测 `e2e-gold7-010` 成功命中两条新工具路径；同时发现并修复并行 dbSNP 批次缺少共享 NCBI 配额/重试的问题，并禁止把部分成功描述成全量验证。主 Prompt 现进一步用显式 dataset completion contract 规定“完成”由任务语义而非 CSV 输出格式决定，每个语义产品必须有当前 Run 的 BuildResult + immutable Publication；缺 provider/carrier 时只能 blocked/NO_DATA/求助，不能降级交付 workspace CSV。这些仍只是调研与模型路径选择的局部缓解，不构成 Core provider、runtime 终态门或正式 publication 能力。
- **根因分层：** (1) 路径选择失败：没有 preflight/终态门强制 Agent 先选择 formal projection；(2) 动态工具可用性不足：单次提交要求完整 FamilySpec、Projection、transform、proposal、bindings 和 digest readmission，缺少服务端 scaffold；(3) acquisition closure 缺失：dynamic route 不接受 discovery/workspace bytes，而 Core 当时没有 GWAS Catalog、supplementary archive 或 RefSNP provider；(4) runtime 把未产生 BuildResult 的 dataset request 仍标为 completed。
- **下一步：** 修订设计见 [`architecture/trait-association-and-genomic-annotation-design.md`](architecture/trait-association-and-genomic-annotation-design.md)。候选新增 `trait_association_evidence` 与 `genomic_annotation_evidence`，每个 projection 单独 Build；GWAS/非 GWAS 来源与 family 必须多对多。先实现 capability preflight、server-generated scaffold、通用 providers 和非 gold 复用/拒绝测试，再重跑 gold7。能力缺失必须形成明确 `no_data`/`spec_rejected`/blocked outcome；不得把 workspace 文件自动提升为 Artifact。

### gold8-gold10 仍缺正式 family/provider，部分上游来源不可达

- **状态：** 2026-08-24 已修复可控 discovery 阻塞，正式 publication 能力仍缺失。
- **gold8：** 新增 `lookup_openfda_dili_counts`，以有界官方查询替代超时的 Agent 脚本；live 变体复核发现 openFDA 聚合前 999 项会漏掉真实低频 PT，现已对聚合未返回的请求 PT 做 exact fallback，并区分官方 no-match 与 fallback 失败。ibuprofen 的 `HEPATIC INFARCTION`（7）和 `VANISHING BILE DUCT SYNDROME`（101）已通过 fallback 找回。当前环境访问任意 `www.fda.gov` 页面均返回 404，而 `api.fda.gov` 正常；DILIrank 完整文件不能因此改用论文附件或模拟分类冒充。正式 DILI family/provider 仍不存在。
- **gold9：** Europe PMC supplementary ZIP 优先链已对 IUIS PMID 41608114 live 成功（97,147 bytes，SHA-256 `7dfa5873…d9a277a`）；新增 `lookup_clinvar_counts`，BTK live 返回 total 1158、pathogenic/likely pathogenic 583。Orphadata/HGNC/ClinGen 仍需 provenance-bound provider，不能由 Agent 直接拼表。
- **gold10：** 新增 `search_mgnify_studies` 绕过动态 browse 页面；live 变体复核发现官方字段实际为 `bioproject`，publications 则是 relationship 而非 attribute count，现已修正 BioProject 映射并输出官方 publications URL，不再产生假性 null count。T2D study `MGYS00000322` 返回 145 samples 与 `PRJEB1786`。`gmrepo.humandisease.info` 当前 DNS 解析失败；MGnify metadata 不能替代 GMRepo prevalence 或论文 differential abundance 数据。
- **影响：** 三案现在可获取更多真实 discovery evidence，但仍不能产生 Dataset Core publication；外部失败必须保留为 `NO_DATA`/missing source，而不是零值或模拟行。
- **下一步：** 分别设计 DILI、IEI multi-source、microbiome association family/provider；为不可达的 FDA DILIrank 与 GMRepo 确认可审计的官方镜像或新入口后再接入 Core。
- **[P1] 新增（2026-08-25 live run `e2e-gold8-002`）：** 当 DILIrank 上游不可达时，Agent 退化到 `download_from_page` 暴力循环（555 次对 `www.fda.gov/media/1341xx` 顺序 ID），且从未调用已就绪的 `lookup_openfda_dili_counts`、也未进入文档约定的 “stop / report NO_DATA” 分支。说明 Agent 缺少“上游持续失败即终止并报 NO_DATA”的护栏与工具选择约束。此缺陷是任何有效重跑的前提：要么加 loop/turn 与持久失败护栏，要么在 discovery 阶段把不可达来源显式标记为 NO_DATA 并继续用可达来源产出部分维度。修复后需以复现测试覆盖，改前不改数据源（外部 404 已复确认，FDA 与 NIEHS 双镜像均不可达，api.fda.gov 仍可达）。

## 可选测试缺口

这些是非阻塞的覆盖增强，不代表已观察到生产故障：

- `GET /builds/{id}` 损坏 manifest 返回 409，以及中间页损坏分页。
- operation 事件顺序无关性与部分镜像 run 语义。
- 双读 API 对真实 `execute_dataset_build` 产物的 E2E，以及 `build_result` 全量重启回放。
- NO_DATA `data-variant` 与 `runId === null` reducer。
- `/cache/datasets?limit=` 页帽与 hook 负向用例。

## 维护规则

新增条目必须写出状态、影响、最小复现和下一步。修复从失败测试开始；合并后从本文件删除，由测试和提交历史承担关闭证据。架构 hardening 或产品里程碑不得重复登记在这里和 `TODO.md`。
