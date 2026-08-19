# BioMed-QAgent 架构 — Skill 自生成 / 自迭代（流程固化 + 可拆卸工具包）

> 本文是本仓库 Skill 自生成与自迭代能力的架构落点记录（对应
> [docs/TODO.md](../TODO.md) 的 P2 项「流程固化 / 可拆卸工具包 / Darwin 主 skill
> 迭代」）。它只解释「怎么做、边界在哪、为什么这样守约束」；执行任务见 TODO，
> 具体工具实现以 `scripts/solidify-run.mjs` 与测试为准。

## 目标

在不破坏现有架构的前提下，把「agent 每完成一次任务后产生的东西」沉淀为可复用资产：

1. **流程固化**：把一次已完成 Run 的工具调用流（工具时间线）固化为**可复用脚本**，
   使同类任务不必从头让 agent 重新一步步调用，降低调用成本。
2. **SKILL.md 固化**：把验证过的稳定流程沉淀为 Skill 知识候选，供人工评审后提升进
   curated 的 `.pi/skills/`。
3. **可拆卸工具包**：为已登记的工具/技能生成**独立文档**，使单个工具可以被其他 agent
   单独调用（不强制完整启动整个项目）。
4. **自迭代闭环**：每次 Run 结束后可触发分析，产出上述固化产物并回填到任务目录，
   形成「执行 → 分析 → 固化 → 复用」的闭环。

## 与现有架构的关系 / 硬约束

- `.pi/skills/` 仍是 **curated 单一事实源**；本能力**不**重新引入
  learned-skill 运行时、`SkillBuilderAgent`、`create_skill`（Phase 2 D3 已退役，
  由 `server/tests/phase8-architecture-guard.test.ts` 守卫）。
- 本能力**不属于** Dataset Core 契约：它不产出 `SourceAsset`、不产生
  Canonical DataBatch、不执行集成/Validation/发布，也不构成数据集级 `BuildRecipe`，
  因此不违反 §19 顶层不变量（尤其 4/24）。
- 固化到生产路径（写入 `scripts/`、提升 `.pi/skills/`）**必须经过人工评审/HIL**；
  引擎只负责产出生成候选到任务目录 `solidification/`，不擅自写生产路径。
- Python 仍只存在于 `database/`；固化脚本采用 **纯 Node `.mjs`**（同 `scripts/`
  既有约定，stdlib-only），避免引入任何运行时依赖。

## 实现载体

单一、自包含、可复用脚本：`scripts/solidify-run.mjs`（shebang + 手写参数解析 +
`fail()` + 纯 `node:*` 内建，符合现有脚本约定与测试体系）。

### 子命令 / 模式

| 模式 | 输入 | 产物 | 目的 |
| --- | --- | --- | --- |
| 默认 | `<taskId|taskDir>` | `events.jsonl` 的工具流摘要 + 固化石（可复用脚本候选 + SKILL.md 候选）写到该任务的 `solidification/` | 流程固化 + SKILL.md 固化 + 自迭代分析 |
| `--toolkit <outDir>` | `.pi/skills/*/SKILL.md` | 每技能独立 Markdown 文档 + `README.md` 索引到 `outDir`（默认 `docs/toolkit/`） | 可拆卸工具包 |

### 纯函数设计（供 vitest 直接测试）

- `traceFlow(eventsLines) → FlowStep[]`：从 `events.jsonl` 按 `sequence` 还原有序
  工具调用（名称/参数/起始时间/时长/是否出错），复用 `task-log-summary.mjs` 的
  解析惯用法。
- `classifyStep(step) → "deterministic" | "acquire" | "skip"`：按工具族判定是否可
  确定性重放。`deterministic`（analysis/统计/绘图/本地数据集执行等）可固化为脚本；
  `acquire`（search/download/web_delegate/VLM 等需网络或凭据）只记录不作为可自动
  重放主干，避免把不稳定/需授权/需凭据的流程伪装成可复用结果。
- `renderScriptCandidate(steps, meta) → string`：把确定性子流程渲染为一个自包含
  `.mjs` 可复用脚本骨架（占位参数化，剥离任务专属路径/run id）。
- `renderSkillCandidate(steps, meta) → string`：渲染带 frontmatter
  （`name`/`description`）的 SKILL.md 候选，供人工评审后提升进 `.pi/skills/`。
- `scanSkills(skillsRoot) → SkillInfo[]` / `renderToolkitDoc(info)` /
  `renderToolkitIndex(list) → string`：生成可拆卸工具包文档。

### 闭环工作流

```text
Run 完成
  -> 调用 scripts/solidify-run.mjs <taskId>          (自迭代分析)
  -> 产出 <taskDir>/solidification/ 下的可复用脚本 + SKILL.md 候选 + 分析报告
  -> 人工评审：通过则 (a) 固化到 scripts/ (b) 提升 .pi/skills/    (HIL 门)
  -> 复用：后续 agent 直接用固化脚本降低同类任务成本   -> 回正文首行
```

固化到生产路径始终经人工评审；引擎仅在任务目录自动产出候选（安全、可审计、不越权）。
这也意味着 `solidify-run.mjs` 本身就是一个「固化为可复用脚本」的最小闭环样例。

## 一致性

- 不新增 Python / FastAPI / experimental Pi 面；不触碰 trusted runtime 的
  `onRunEnd`/权限 broker；不把固化产物接入正式构建路径。
- 每个纯函数配 vitest 用例（`server/tests/solidify-run.test.ts`）；脚本本身遵守
  `scripts/` 命名与调用约定，可被 `node scripts/...` 直接运行。
- 设计存量：本文；执行状态：`docs/TODO.md` 对应 P2 勾选；工具实现：代码为准。