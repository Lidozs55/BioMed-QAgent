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

- [ ] **P0 / TASK-047** 大型 GEO 表达矩阵在 TS Core 解析/规范化阶段触发
      `Invalid string length` 或 Node heap OOM。评测已确认 GSE31852/GSE109169
      级别文件需要流式读取、有限输出缓冲、可恢复 checkpoint 与资源上限；当前
      parser、canonicalizer、probe mapping、integrator 已改为流式并通过全量门。
      剩余验收：6.1 GB 解压矩阵在默认运行限制下完成 integrate/validate/publish，
      正式四/五张表可读且 provenance 闭合。
- [ ] **P0 / TASK-048** 非 gene-expression 研究任务（target/variant/
      structure/activity/paper/figure）缺少受信任的多表 schema、validation 和
      Publication family。gold3–gold6 真实 run 只能写 workspace 摘要，不能按
      artifact 计分；验收：严格表头/行宽/source locator/单位与 relation 保留，
      图表估读带 estimated/low-confidence 和 axis/legend 不清标记，workspace
      文件不得绕过 Publisher。

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
> **无法走受信任 Dataset Core publication 路径**。证据链与 reference schema
> 见 `data/gold/SCHEMA_GAP.md` 与 `data/gold/gold{3..6}_*/schemas/`。

- [ ] **P1** SchemaRegistry 仅有 2 个内建表达 schema（`gene_expression.long.v1`
      / `probe_long.v1`，`server/src/dataset/schema/registry.ts`），spec
      validator 对其余 schema_id 一律 `unknown_schema` 拒绝。分级推进：
      **方案 B**（半天–1 天）——把 gold3–6 已备的 4 个 family / 22 张
      reference schema 注册进 registry（含 `ENTITY_LEVEL_BY_GRANULARITY`
      补映射），使非表达 spec 至少通过 validate；**方案 A**（数天，需 ADR）
      ——为新 family 建 canonicalizer / publisher 全管线支持，含 golden
      fixture parity。
- [ ] **P1** 非 GEO 类源无受信任 SourceAdapter：受信任管线 adapter 仅覆盖
      GEO / GDC / Xena / STAR counts（`server/src/dataset/adapters/`），
      UniProt / ClinVar / RCSB PDB / ChEMBL / PubChem / ClinicalTrials.gov /
      Europe PMC 只有 agent 业务 Tool（Phase 5 P5-02…08，产物停在
      workspace/cache），检索结果无法进入 DatasetBuild。gold3/4/5/6 用到的
      源全部命中此缺口。方案 B 打通 schema 后此缺口成为主要阻塞，需按
      family 逐源评估：结构化 API 响应 → SourceAsset → adapter 的最小路径。
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
      可与方案 B 一并设计 `entity_link` 类 row_granularity。

---

## 跨阶段约束（延续到后续所有工作）

- Pi Session ≠ BioMed Task ≠ Run ≠ DatasetBuild（ADR-019）。
- Pipeline/Core 保持受信任 Tool，不降级为纯 Skill；Validation Gate 是程序约束
  而非提示词约束（ADR-020）。
- Agent 不得直写 `artifacts/` / publications；只有 Core Publisher 可以发布。
- Pi 依赖只经 `server/agent/pi-adapter.ts`；业务代码不直接依赖 Pi 内部类型。
- 每阶段可独立回滚（Plan §24）；不同时重写前端 + Pipeline + DB + Agent Runtime。
