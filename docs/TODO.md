# BioMed-QAgent 开发 TODO

> 当前状态：迁移主线 **Phase 0-9 全部完成**（2026-08-12 ~ 2026-08-16）；
> Agent I/O 可观测性与权限交互修正主体完成（2026-08-17）。本清单只保留
> **开放条目**与当前约束；已完成阶段的详细清单与验收证据归档于
> [archive/TODO_MIGRATION_COMPLETED.md](archive/TODO_MIGRATION_COMPLETED.md)
> （Phase 0-9 / M2 / 独立维护项完成部分 / 前端 UI 合规 / 已登记 issue
> 已解决部分），本文件不重复。
>
> - 架构权威见 [ARCHITECTURE.md](ARCHITECTURE.md)；迁移执行记录见
>   [migration/README.md](migration/README.md) 与
>   [migration/BioMed-QAgent_Pi_Migration_Plan.md](migration/BioMed-QAgent_Pi_Migration_Plan.md)；
> - 决策依据见 [adr/README.md](adr/README.md) 与
>   [BioMed-QAgent_Architecture_Decisions_and_Lessons.md](BioMed-QAgent_Architecture_Decisions_and_Lessons.md)；
> - 旧主线「V2 Pipeline Refactor」清单归档于
>   [archive/TODO_PIPELINE_REFACTOR_COMPLETED.md](archive/TODO_PIPELINE_REFACTOR_COMPLETED.md)；
> - 赛题背景与评分见 [PROBLEM.md](../PROBLEM.md)。

## 总进度（迁移主线，全部完成）

| Phase | 内容 | 状态 |
| --- | --- | --- |
| 0 | 冻结边界与迁移 ADR | ✅ 完成（2026-08-12） |
| 1 | 引入 Pi Main Agent（不动 Dataset Core） | ✅ 完成（2026-08-12） |
| 2 | 迁移 Skills 与通用 Agent 工具 | ✅ 完成（2026-08-13） |
| 3 | 拆出 TS Application Runtime | ✅ 完成（2026-08-12；Phase 7 已转默认） |
| 4 | 迁移 Dataset Deterministic Core | ✅ 完成（2026-08-13；运行接线 M2 已闭环） |
| 5 | 迁外部能力与 Python 数据处理依赖 | ✅ 完成（2026-08-14） |
| 6 | 迁模型设置与 Settings API | ✅ 完成（2026-08-13） |
| 7 | 正式切换 Frontend → TS Host | ✅ 完成（2026-08-14） |
| 8 | 删除 Python Runtime（仅留 DB bridge） | ✅ 完成（2026-08-14） |
| 9 | Agent Workspace 与权限系统重构 | ✅ 完成（2026-08-16，ADR-026） |

> **当前拓扑**：唯一正式拓扑是 TypeScript Host（`pnpm dev` / `pnpm start`）
> + Pi Agent + TS Dataset Core + 按需 `database/bridge.py` JSONL persistence。
> 启动说明见 [README.md](../README.md)，权威架构见
> [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 开放条目（2026-08-17 收尾审计后）

### P0

> TASK-047/048 的 work package、硬依赖、分支边界和逐项验收统一见
> [Gold 可信 Publication 收敛执行计划](superpowers/plans/2026-08-18-gold-trusted-publication-closure.md)。
> 当前严格 Gold 为 0/6；只有计划中的 G1 同 commit 六例原样重跑闭环后才能报告 6/6。

- [ ] **P0 / TASK-047** 大型 GEO 表达矩阵在 TS Core 解析/规范化阶段触发
      `Invalid string length` 或 Node heap OOM。评测已确认 GSE31852/GSE109169
      级别文件需要流式读取、有限输出缓冲、可恢复 checkpoint 与资源上限。局部
      parser/canonicalizer/writer 已流式化，integrator 去重状态已磁盘化
      （WP-A6 的 `node:sqlite` temp table + quota，见下），但审计仍确认 Core
      前置 hash、GDC/Xena 输入、GEO supplementary/metadata、probe mapping、
      checkpoint rehydrate 和 release/download tail 存在全量读取或随行数增长的
      内存边界。
      剩余验收：计划 A1-A7 全部完成后，A8 在默认运行限制下使约 6.1 GB 解压矩阵
      完成 integrate/validate/publish；记录 RSS/wall/temp/batches/artifact，并通过
      immutable Publication Artifact API 下载复核 hash。
      **A8 基准已完成并合并进 main（59b8b6af）**：`server/tests/bench-a8.run.ts`
      + `docs/runs-log.md`。采用最大的**可行**真实 bulk GEO 矩阵 GSE325735
      （58,676 genes × 807 samples，解压 117.87 MB，~75× 最大 gold 规模，精确
      6.1GB 绝对最大检出不可行）；在 frozen 默认 RuntimeLimits + Node 默认堆
      （无 `--max-old-space-size`）下完整跑通 integrate→validate→publish：
      peak_rss 305.8 MB / peak_heap 122 MB，最长 op validate_profile
      1,593,643 ms（< 3600s 默认超时），provenance coverage_ratio=1
      （47,351,532 行，0 untraced/conflict/dedup/rejected），validation
      11/11 passed，`artifacts_hash_parity=true`（7 个 artifact 磁盘重哈希与
      manifest 一致）。权威指标见
      `data/bench/a8-run-ByPP9F/result.json`（metric_source=live）。
- [ ] **P0 / TASK-048** 非 gene-expression 研究任务（target/variant/
      structure/activity/paper/figure）缺少受信任的多表 schema、validation 和
      Publication family。gold3–gold6 真实 run 只能写 workspace 摘要，不能按
      artifact 计分；验收：按计划 B0-B7/C1-C2 落地 family admission、multi-table
      contracts、assemble、registered asset ingestion、Validation/Provenance/Confidence
      和图表/衍生数据可信路径；严格表头/行宽/source locator/单位与 relation 保留，
      workspace 文件不得绕过 Publisher。

#### 开发者 B 任务台账

> B 组详细 ownership、依赖类型、分支、交接窗口和逐任务验收见
> [开发者 B：可信多表 Publication 落实计划](superpowers/plans/2026-08-18-developer-b-trusted-publication-plan.md)。
> B 组 contracts（含 C3C）、B2M、B3、B5C、B6D 已完成，B4M、B5L/T/V/S/A、B6A、B6B
> module 已完成；A 组 `TASK-047-A1/A2/A3/A4/A5I` 已部分合并。A 组仍需接线
> C1I/C2I/C3I/B2W/B6W，随后推进 B7/Gold 验收。
> A5I 增量 1+2 已合并进 main：增量 1（9dcceeca）为 `loadOperationOutput`
> 流式校验（async + `sha256FileStream` + `cancellationSignal`，取消传播而非吞掉）；
> 增量 2（14aceeed）为 executor 成功路径写入类型化 ADR-030 `OperationResultManifest`
> （native 模式 + committed 收据、dependency closure 含确定性 upstream manifest
> ids/input asset ids），round-trip 经 strict parser 校验，digest 复用不重写 manifest。
> A5I 增量 3（f1d05292→c198592e，rehydrate 命中 typed checkpoint 时不再
> `rehydrateCompletedRunners` 走 RAW/逐 operation 重放，直接恢复 typed runner state）
> 与 WP-A6（disk-backed integrate：`integrator` 的 O(unique)`seen` Map 替换为
> `node:sqlite` 磁盘 temp table + `tempStore.quotaBytes` 上限，fail-closed
> `IntegratorResourceLimitError`，批量事务保证增量大小可观测；T7-T12 含 heap/quota/
> cancel 红绿测试）均已合并进 main，A5I 不再 open。

- [x] **TASK-G0 / completed**：Gold v1 eval manifest、六个原始 prompt、reference schema/source
      inventory、默认运行参数、checksum verifier 与 manifest run driver 已冻结于
      `docs/evaluation/gold-v1/`；当前 strict Gold 仍为 0/6。
- [x] **TASK-048-B0 / completed @ b43c145**：FamilyRegistry admission foundation。
- [x] **TASK-048-B1 / completed**：Manifest/DatasetSchema 2.0、Table/Relation/Candidate refs、
      SourceLocator 2.0 与 ADR-028；Manifest 1.0 / Publication 1.0/1.1 兼容测试保留。
- [x] **TASK-C1C / completed**：SourceAsset roles、task-owned asset ref、registration receipt、
      immutable hash/size/media type 和 legacy-path telemetry；ADR-029。
- [x] **TASK-047-A5C / completed**：OperationResultManifest、typed output/file receipts、
      dependency closure、atomic commit receipt 与 legacy read-only migration；ADR-030。
- [x] **TASK-C2C / completed**：CoreAcquisitionRequest、PROMOTED recipe ref、DownloadAttempt/
      retry/resume/cache lineage 与 registered extraction asset ref；ADR-031。
- [x] **TASK-C3C / completed（ADR-037）**：Durable Build start/get/cancel DTO、exact idempotency、
      独立状态机/terminal result/cancel ack、Task/Run/Build identity、durable event refs 与共享
      runtime parser 已冻结；scheduler/lease/recovery/API 接线仍属 A owner TASK-C3I，且当前不阻塞
      TASK-048/G1。
- [x] **TASK-048-B2M / completed**：Core-only PublicationCandidate 与 family assembler module；expression integration result 可确定性包装，candidate 仅引用 committed Core result receipts/registered asset IDs，缺 handler 的 family 无 assembly capability；ADR-033。
- [ ] **TASK-048-B2W / A owner, blocked by TASK-048-B2M + TASK-047-A5I**：assemble runtime/checkpoint/publisher wiring。
- [x] **TASK-048-B3 / completed**：Generic multi-table validation/relation gate；严格结构/关系、token/evidence closure 与 Agent workspace bypass fail-closed 已完成（ADR-032）。
- [ ] **TASK-048-B4M / module complete（ADR-034）；trusted E2E blocked by TASK-C1I**：
      schema-driven CSV/TSV/JSON RegisteredSourceAsset adapter、严格行宽/类型、locator/parser
      version/rejected-row audit 与 fail-closed receipt/hash 已完成；`adapters.ts`/runtime 接线、
      Core asset registry E2E 与 Publication admission 未完成，不得标记整体 completed。
- [x] **TASK-048-B5C / completed（ADR-035）**：共享 biomedical tables/relation vocabulary；参数化
      builders 覆盖 entity/paper/compound/assay/structure dimension/trial/source/entity+compound
      crosswalk，受控 ID/relation/cardinality/unit vocabulary，crosswalk 保留匹配证据、冲突和置信度；
      未注册 production family。
- [ ] **TASK-048-B5L / module complete；trusted E2E blocked by B2W/B4M/C2I**：`literature_evidence` vertical slice。
- [ ] **TASK-048-B5T / module complete；trusted E2E blocked by B2W/B4M/C2I**：`target_evidence` vertical slice。
- [ ] **TASK-048-B5V / module complete；trusted E2E blocked by B2W/B4M/C2I**：`variant_evidence` vertical slice。
- [ ] **TASK-048-B5S / module complete；trusted E2E blocked by B2W/B4M/C2I**：`protein_structure` vertical slice。
- [ ] **TASK-048-B5A / module complete；trusted E2E blocked by B2W/B4M/C2I**：`bioactivity_measurement` vertical slice。
- [ ] **TASK-048-B6A / module complete；trusted Gold6 blocked by B2W/B4M/C2I**：Chart/VLM evidence module 已完成；低可信/axis/legend/review gate 已覆盖，runtime/publication 接线未完成。
- [x] **TASK-048-B6D / completed**：Deterministic derive contract、固定 slot、算法 registry 与 ADR-036；
      PDB distance/sequence alignment 共用 contract，参数/reference/input/output digest provenance
      完整，Agent code/通用 DAG fail-closed。
- [ ] **TASK-048-B6W / A owner, blocked by TASK-047-A5I**：fixed derive slot runtime wiring。
- [ ] **TASK-048-B6B / module complete；trusted E2E blocked by B6W/B2W/C2I**：注册 deterministic derive algorithm handlers、`protein_structure` PDB interface derived consumer/schema/profile、`variant_evidence` sequence/reference mapping derived consumer/schema/profile 已完成；A-owned runtime/plan/checkpoint/ts-core/publish wiring 未完成。
- [ ] **TASK-048-B7 / blocked by all family/VLM/derive + TASK-C2I**：Gold3-Gold6 原样重跑。
- [ ] **TASK-G1B / blocked by TASK-048-B7 + TASK-047-A8 + TASK-G1A**：最终 Gold3-Gold6 同基线复跑。
- [ ] **TASK-G1R / blocked by TASK-G1A + TASK-G1B**：严格 Gold 最终报告。

### P1

- [ ] **P1 / Phase 9 后续**：`UserInputDialog` / HIL 迁移到同一 Questionnaire
      基础设施。
- [ ] **P1 / Phase 9 后续**：权限设置页重排默认层与高级 ACL 编辑器。
- [ ] **P1** model-registry 响应未做 wire-boundary 校验：`frontend/src/api/modelRegistry.ts`
      仍用窄化 cast（`b as ProviderInfo[]` 等）。下一步为 `packages/contracts`
      runtime 增加 `parseProvidersEnvelope` / `parseManagedModelsEnvelope` 等解析器，
      与其余 endpoint 组一致（ADR-025 后续项，2026-08-14 层抽取时发现）
- [ ] **P1** `search_local_cache` 与下载/构建流程脱节：research 任务下载的
      数据只写入 `source_assets/` 与 content-addressed `cache/blobs`，从不
      `CacheStore.commit_dataset` 写入 SQLite `cache.search` 索引，导致
      LLM 报告 "Local cache: empty"、缓存复用完全失效。应评估：下载/构建
      完成后自动注册缓存数据集（manifest 级）或调整工具描述避免误引导
      （2026-08-16 排查 `task_ts_9f9dddbb`，TASK-045）
- [ ] **P1** AI 用户支持：编写一份面向 AI 用户的调用文档及配套脚本（服务启动 +
      HTTP/WS 驱动封装），方便其他 agent 调用本项目。

### P2

- [ ] **P2 / Phase 9 后续**：已解决权限事件进入历史 Conversation timeline。
- [ ] **P2** Agent INSTRUCTIONS 增加"达到 max_turns 后输出 `[MAX_TURNS_REACHED]`"
      指导（原 Pipeline Design §4.5）
- [ ] **P2** 设置页供应商/模型列表分页与搜索后端支持（当前全量返回）
- [ ] **P2** `createPhase3ToolHooks()` 的 operation 并发 identity：同一来源所有
      查询共用 `operation_id: tool:<source>:query`，并发同源查询的
      started/progress/completed 会互相覆盖（UI 表现为同源多查询只有一个
      operation 总卡片）。应改为 call-scoped ID（2026-08-15 对话流时序
      修复时发现，`fix/runtime-timeline-sequence` 未包含此改动）
- [ ] **P2** 框架整体完成后，使用 Darwin 或类似 skill 对主 skill 进行迭代处理，达成三项指标：
      (1) 高完成度——搜索的数据全且准确；(2) 高速度；(3) 低成本；并完成与通用 agent 框架的对比评估。
- [ ] **P2** 流程固化：每次执行完成后将流程固化为可复用脚本，可重复使用，降低第 2 项的调用成本。
- [ ] **P2** 可拆卸工具包：每个工具拥有独立文档，可被其他 agent 单独调用；当前环境受限或不便完整启动
      整个项目时，可作为独立工具包使用。

### P3

- [ ] **P3**（可选）沙箱环境：为数据安全提供沙箱保证。

---

## gold3–6 揭露的非表达数据受信任 Publication 缺口（2026-08-17）

> 背景：gold3–6（EGFR 靶点多源 / Spike–ACE2 / ChEMBL 活性 / 论文图表抽取，
> 由 AI agent 直连公开 API 生产）作为参考输出揭露：这些主题在当前系统中
> **无法走受信任 Dataset Core publication 路径**。历史评测数据位于被忽略的
> `data/gold/`，当前仓库没有可追踪的 `SCHEMA_GAP.md`；它不能作为唯一验收依据。
> 计划要求先提交冻结的 Gold eval manifest（prompt/schema/source hashes），再开发和复跑。

- [ ] **P1** SchemaRegistry 仅有 2 个内建表达 schema（`gene_expression.long.v1`
      / `probe_long.v1`，`server/src/dataset/schema/registry.ts`），spec validator 对其余
      schema_id 一律 `unknown_schema` 拒绝。按计划 B0-B5 推进：reference schema 不能
      单独注册进 production default registry 来制造“可 validate”的假能力；family
      admission 必须能解析真实 Schema/Adapter/Profile，并在 multi-table contracts +
      assemble + validation/publication handlers 闭环后才启用。
- [ ] **P1** 非 GEO 类源无受信任 SourceAdapter：受信任管线 adapter 仅覆盖
      GEO / GDC / Xena / STAR counts（`server/src/dataset/adapters/`），
      UniProt / ClinVar / RCSB PDB / ChEMBL / PubChem / ClinicalTrials.gov /
      Europe PMC 只有 agent 业务 Tool（Phase 5 P5-02…08，产物停在
      workspace/cache），检索结果无法进入 DatasetBuild。gold3/4/5/6 用到的
      源全部命中此缺口。按 `TASK-C1C`、`TASK-C1I`、`TASK-C2C`、`TASK-C2I`、
      `TASK-048-B4M` 和 `TASK-048-B5C/L/T/V/S/A` 逐 family、逐来源接入：结构化 API
      响应 → immutable SourceAsset → trusted adapter；不得让 Agent workspace path
      成为临时发布入口。
- [ ] **P2** 图表数字化产物无受信任落点：Qwen-VL chart extraction 工具
      （P5-08）可估读图表，但 chart_series / chart_points 类产物（含
      `estimated` / `axis_unclear` / `legend_unclear` /
      `human_review_status` 质量字段，见 gold6 schema）没有 schema 与
      publication 路径；可与既有 Durable HIL / Confidence 协议复用
      （低可信估读值天然适合 confidence gate + 人工审核流）。
- [ ] **P2** 计算衍生数据无 operation 类型：gold4 `interface_records` 是
      PDB 坐标距离计算的**衍生**数据（非检索所得），同类还有序列比对映射
      （gold4 参考编号用 NW 全局比对）。受信任管线目前只有"parse →
      canonicalize → integrate"检索整合型 operation，无 compute/derive 类；
      若纳入需 ADR 明确确定性与 provenance 语义（参数、参考序列版本）。
- [ ] **P2** 跨库实体对齐表无 family 承载：entity_crosswalk /
      compound_crosswalk（gold3/5）这类"行=实体关系"而非"行=测量记录"的
      表，现有 schema 形状（measurement/unit 中心）不适配；且对齐证据
      （InChIKey 精确匹配、冲突保留不合并）需要专用 provenance 字段。
      在计划 B1/B5 中作为可复用 `entity_link` 粒度与 relation schema 设计。

---

## 跨阶段约束（延续到后续所有工作）

- Pi Session ≠ BioMed Task ≠ Run ≠ DatasetBuild（ADR-019）。
- Pipeline/Core 保持受信任 Tool，不降级为纯 Skill；Validation Gate 是程序约束
  而非提示词约束（ADR-020）。
- Agent 不得直写 `artifacts/` / publications；只有 Core Publisher 可以发布。
- Pi 依赖只经 `server/agent/pi-adapter.ts`；业务代码不直接依赖 Pi 内部类型。
- 每阶段可独立回滚（Plan §24）；不同时重写前端 + Pipeline + DB + Agent Runtime。
