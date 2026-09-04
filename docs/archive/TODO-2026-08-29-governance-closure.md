# BioMed-QAgent 开发 TODO — 2026-08-29 归档（治理后 hardening 期已完成项）

> 本文件收录 2026-08-29 从 [`../TODO.md`](../TODO.md) 删除的已完成条目，时间跨度为
> 2026-08-24 治理重建线（见
> [`TODO-2026-08-24-before-governance.md`](TODO-2026-08-24-before-governance.md)）
> 之后到 2026-08-29。条目保留完成时的原文与证据引用，仅供追溯，不作为当前工作依据。

## P0 — Release evidence

- [x] **Gold10 肠道微生物组正式发布闭包（分支 `fix/gold10-publication-closure`）。** 2026-08-28 深夜达成四表闭包（IBD 表型，main@d084a7e4 基线）：fresh run 内 supervisor closure `succeeded_publication`，Publication `pub_gm_integrated_ibd_v1_91478ba5aee43f43`，8 artifacts 全部字节/SHA-256 验证（证据 `data/gold-runs/d084a7e4-gold10-r1`，前序 r1-r3 见 runs-log）。四表：study 1 行（MGnify 官方 API）、taxon crosswalk 30 行（新 schema `gut_microbiome.taxon_name_crosswalk.v1`，esearch/efetch 配对，真实同义/历史名展开与改名标记）、差异表 19 行（Morgan 2012 S9 LEfSe 真实数据，经新 `paper_supplement_differential_abundance_csv` 适配器：双层表头 β/p/q 面板 + 单行 LEfSe 变体）、prevalence 598 行（GMRepo per-taxon）。已落地 Core 片：crosswalk schema+transform（abfbd739）、论文 CSV 版面解析（b92aec8e + d084a7e4）、NCBI verbatim 文献名（9b58f21f）、source 名对齐与 study 载体身份（f57e3647/b2eef980）。**诚实局限（终答显式标注，非零值/模拟行）**：仅 IBD 表型闭合——T2D/CRC 差异表源经逐一排查不可达（forslund2017 面板在 Springer static 主机、EPMC 归档内无该文件；其余候选为 PDF/非OA/无数值效应列）；agent 拒绝跨表型错标归属（正确）；GMRepo 适配器为表型内检出流行率而非病例 vs 对照。**剩余（后续立项）**：(a) T2D/CRC 差异表可达源（Springer static provider 或等价 OA 候选）；(b) GMRepo case/control 差异流行率端点接线；(c) 对参考全量（3 表型/14 研究）的覆盖扩展。

## P1 — Runtime and evidence hardening

- [x] **权威 dataset/revision identity 接入生产路径。** 从 `DatasetCore` 传递 task-owned registration receipts，基于冻结 provider revision 与 asset closure 生成 identity；通过显式 V2 schema/PK 迁移 expression adapters。
  - 验收：`dataset_id`/`dataset_revision_id` 不来自 requirement ID、注册时间或调用方自报；V1 schema 不静默扩列；缺少权威事实时 fail closed。
- [x] **checkpoint/reuse/restart 闭环。** 持久化 implementation/release identity，在真实 reuse 前调用 verifier，并补齐 owner fencing、orphan cleanup、restart 与 TOCTOU 回归测试。
  - 验收：input/params/FamilySpec/implementation/runtime/policy 任一 digest 改变都会使 checkpoint 失效；cancel/timeout/restart/stale generation 不能提交或复用旧 Publication。
- [x] **统一 HIL Questionnaire。** 将 `UserInputDialog` 迁移到现有 Questionnaire 基础设施。
  - 验收：现有权限和 publication acceptance 流程行为不回退；历史事件仍可重放。
- [x] **数据集请求 formal-route scaffold。** 只读 capability preflight 已接入；继续由服务端生成 digest-bound dynamic execution skeleton，并为候选 semantic family/projection、单一行粒度、可用 Core providers 和缺失 blockers 提供确定性输入。
  - 验收：gold7 类复合请求可拆为多个 projection/requirement；无 provider 时形成结构化 blocker，且不把 workspace 文件提升为正式产物；事件重放结果一致。
  - 遗留（2026-08-28）： 该功能合入带入 2 个 main 红测（dispatch guard + skill map），见 [ISSUES §代码质量](../ISSUES.md)；已于同日由 `d829c387` 清零（skill map 收录注册名 + spec-scaffold 改用 registry API）。
  - **2026-08-29 归档注：** 实际落地为只读 capability preflight 与服务端 scaffold 工具 `scaffold_dataset_execution_spec`（`server/src/dataset/scaffold/spec-scaffold.ts`，从 live Family Registry 组合**静态** validate-ready spec 骨架）。原文所述 digest-bound **动态** execution skeleton 与候选 semantic family/projection 分解未在代码中实现，已拆回 [`../TODO.md`](../TODO.md) P1 继续跟踪。

## P2 — Product and developer experience

- [x] **上下文压缩整改遗留（`main@1a62cfba`）。** 已合并：预算取较小值、压缩遥测、fail-closed（`766395c3`）、已发布 run 让路（`a48c5ebd`，gold9 r16 场景）；run 入口 preflight 已实现（`main@05f43592`，`e8d03589+` 基线，session 预算 `context_window - max_tokens - reserve <= 0` 时首个 Pi turn 前落盘 `run_failed(context_budget_exhausted)`，RED→GREEN 回归测试）；gold9 live 复验已完成——deepseek-v4-flash 1M 窗口在 `e8d03589` 产出 `pub_iei_pid_v1_bafb191e69327e34` 的 `succeeded_publication` closure（r5，证据 `data/gold-runs/e8d03589-gold9-dsflash-r5`），全程零 `CONTEXT_COMPACTION_INEFFECTIVE`、零压缩（1M 窗口未触阈值）。
- [x] **模型设置分页与搜索。** 为供应商/模型列表增加后端分页和搜索，并更新前端调用。
  - 验收：契约先进入 `@biomed/contracts`；边界、空页和 hostile-wire 用例有测试。
