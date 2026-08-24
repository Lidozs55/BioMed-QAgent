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

### gold7 Alzheimer GWAS 请求没有可用的正式 family/provider

- **状态：** 2026-08-24 在真实 run `task_ts_c93256a6-f374-4bc8-9795-d0a5ff3bc109` 复现，待架构设计与实现。
- **现象：** 当前 production Dataset Family Registry 没有 Alzheimer GWAS family，也没有覆盖 GWAS Catalog、Bellenguez supplementary table、dbSNP/Ensembl 坐标整合的 Core Acquisition Provider。现有 `variant_evidence` family 的语义和表结构不等价，不能直接套用。
- **证据：** run 事件流未出现 `validate_dataset_build`、`execute_dataset_build` 或 `submit_dynamic_family_build`；最终 `run_completed` 携带 `build_result: null`、`artifact_count=0`、`current_publication_id=null`。Agent 在浏览器/补充材料请求失败后改写 workspace CSV，并明确采用“已知/代表性”位点，未进入正式发布链。
- **影响：** 复合 biomedical 请求可能在没有可用 family/provider 时退化为 workspace 草稿，任务状态却仍显示 completed；不能形成可追溯的 formal DatasetPublication，也容易诱发模拟数据。
- **局部缓解：** `fix/gold7-real-source-acquisition` 已让 discovery 工具优先获取 Europe PMC 官方 supplementary ZIP，并新增按规范数字路径调用 NCBI RefSNP API 的 `lookup_dbsnp`。2026-08-24 live smoke 成功获取 Bellenguez PMC9005347 的 27,656,649-byte ZIP（SHA-256 `a2902ab4…6ed26`）和 rs429358 RefSNP 记录。真实复测 `e2e-gold7-010` 成功命中两条新工具路径；同时发现并修复并行 dbSNP 批次缺少共享 NCBI 配额/重试的问题，并禁止把部分成功描述成全量验证。这些只修复调研/获取阻塞，不构成 Core provider 或正式 publication 能力。
- **下一步：** 设计草案已记录于 [`architecture/gold7-alzheimer-gwas-family-design.md`](architecture/gold7-alzheimer-gwas-family-design.md)，提出独立 `gwas_association` family、三类 Core provider、五表 provenance topology、GRCh38/dbSNP 完整性门和可扩展 trait/provider/resolver 版本边界；下一轮先按分期 1-2 实现并写复现测试。在能力缺失时让 Agent/运行时产生明确的 `NO_DATA` 或 `spec_rejected` 结果。不得把 workspace 文件自动提升为 Artifact，不得以 `variant_evidence` 代替 GWAS family。

### gold8-gold10 仍缺正式 family/provider，部分上游来源不可达

- **状态：** 2026-08-24 已修复可控 discovery 阻塞，正式 publication 能力仍缺失。
- **gold8：** 新增 `lookup_openfda_dili_counts`，以有界官方查询替代超时的 Agent 脚本；live 变体复核发现 openFDA 聚合前 999 项会漏掉真实低频 PT，现已对聚合未返回的请求 PT 做 exact fallback，并区分官方 no-match 与 fallback 失败。ibuprofen 的 `HEPATIC INFARCTION`（7）和 `VANISHING BILE DUCT SYNDROME`（101）已通过 fallback 找回。当前环境访问任意 `www.fda.gov` 页面均返回 404，而 `api.fda.gov` 正常；DILIrank 完整文件不能因此改用论文附件或模拟分类冒充。正式 DILI family/provider 仍不存在。
- **gold9：** Europe PMC supplementary ZIP 优先链已对 IUIS PMID 41608114 live 成功（97,147 bytes，SHA-256 `7dfa5873…d9a277a`）；新增 `lookup_clinvar_counts`，BTK live 返回 total 1158、pathogenic/likely pathogenic 583。Orphadata/HGNC/ClinGen 仍需 provenance-bound provider，不能由 Agent 直接拼表。
- **gold10：** 新增 `search_mgnify_studies` 绕过动态 browse 页面；live 变体复核发现官方字段实际为 `bioproject`，publications 则是 relationship 而非 attribute count，现已修正 BioProject 映射并输出官方 publications URL，不再产生假性 null count。T2D study `MGYS00000322` 返回 145 samples 与 `PRJEB1786`。`gmrepo.humandisease.info` 当前 DNS 解析失败；MGnify metadata 不能替代 GMRepo prevalence 或论文 differential abundance 数据。
- **影响：** 三案现在可获取更多真实 discovery evidence，但仍不能产生 Dataset Core publication；外部失败必须保留为 `NO_DATA`/missing source，而不是零值或模拟行。
- **下一步：** 分别设计 DILI、IEI multi-source、microbiome association family/provider；为不可达的 FDA DILIrank 与 GMRepo 确认可审计的官方镜像或新入口后再接入 Core。

## 可选测试缺口

这些是非阻塞的覆盖增强，不代表已观察到生产故障：

- `GET /builds/{id}` 损坏 manifest 返回 409，以及中间页损坏分页。
- operation 事件顺序无关性与部分镜像 run 语义。
- 双读 API 对真实 `execute_dataset_build` 产物的 E2E，以及 `build_result` 全量重启回放。
- NO_DATA `data-variant` 与 `runId === null` reducer。
- `/cache/datasets?limit=` 页帽与 hook 负向用例。

## 维护规则

新增条目必须写出状态、影响、最小复现和下一步。修复从失败测试开始；合并后从本文件删除，由测试和提交历史承担关闭证据。架构 hardening 或产品里程碑不得重复登记在这里和 `TODO.md`。
