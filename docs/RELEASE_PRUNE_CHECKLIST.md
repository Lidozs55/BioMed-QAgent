# Release PR checklist（dev → main）

> 发布 PR 的唯一权威清单，仅在切发布分支时使用，从不注入 agent prompt。
> `main` 只承载公开内容；存疑时的判据：凡是为协调 agent 而存在、或记录内部
> 评测的材料，都是 dev-only。本清单自身也在 `docs/` 内，随发布剪枝。

## 1. 剪枝内部内容（在发布分支上删除）

- `docs/` — 内部文档（含本清单，它只在 dev 存在）
- `AGENTS.md`、`PROBLEM.md`、`frontend/AGENTS.md`
- `.agents/`、`.superpowers/`、`.playwright-mcp/` — agent 工具
- `.husky/` 及 `package.json` 中的 `husky` devDependency 与 `prepare` 脚本
  （同步 `pnpm-lock.yaml`）
- `data/gold-runs/`、`data/gold/` — 内部评测证据
- `skills-lock.json`
- 内部专用测试套件：`server/tests/gold-v1-*`、`server/tests/gold6-*`、
  `server/tests/reference-requirements.test.ts`
- 后续新增的同用途内容（agent runbook、评测证据、内部计划）。历史规范执行
  样例：`main@a3b820e9`。

## 2. 排除 dev-only 能力（按能力与路径识别，不按哈希）

Agent 自代码访问设计只在 `dev` 可见可用：

- `read_dataset_core_source` 工具：`server/src/agent/tools/core-source.ts`；
  注册点 `business-tools.ts`、`tools/index.ts`、`skill-tool-map.ts`、
  `.pi/skills/dataset-construction/SKILL.md` 段落；相关测试
  （`tools-deterministic.test.ts` 的测试块、`skill-tool-map.test.ts` 的条目）。
- `server/src/agent/phase1-prompt.ts` 中的两项执行授权：Agent 自行编写
  FamilySpec 拓扑、读 Core 源码修 rejection——恢复授权前措辞；
  `pi-adapter.test.ts` 的断言须与恢复后的措辞一致。
- Agent 自修改宪章（`docs/AGENT_SELF_MODIFICATION_CHARTER.md`）与任何为
  Agent 注册的代码写入工具：宪章与能力同进退，都是 dev-only。

历史来源：分支 `feat/relax-publication-gates`，提交 `cef17009`、`b1fd4e4b`
——仅作注记；哈希会因 amend/rebase 失效，以能力与路径为准。

校验：`git diff main..<release-branch>` 中不得出现 `read_dataset_core_source`
及授权措辞的任何实例。

## 3. 必须发布（不得与 dev-only 集一起回退）

- Dataset Core 门槛放宽（源头 `d7f7e8ec`）：空表部分发布、基因覆盖转报告制、
  自设计拓扑的需求推导——涉及 `publication-candidate.ts`、`dynamic-family/*`、
  `validation/profile.ts`、`phase3-composition.ts`、`validation-parity.ts`。
- 随之落地的结构守卫：primary 表不得 `allow_empty`（family-spec 拓扑准入的
  `ALLOW_EMPTY_PRIMARY`）。
- 其余一切已落入 `dev` 的正常产品修复。

## 4. 开 PR 前的验证

1. 从 `dev` 切发布分支，执行第 1–3 节；
2. 对照 `main` 做 diff 审计：新增方向无 dev-only 路径，删除方向覆盖内部清单；
3. 发布分支上跑 `pnpm lint`、`pnpm typecheck`、`pnpm build` 与定向测试；
4. PR 上的 CI 是权威门；绿了才合并。
