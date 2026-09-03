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
- 后续新增的同用途内容（agent runbook、评测证据、内部计划）。

## 2. 排除 dev-only 能力（按能力与路径识别，不按哈希）

源码**只读**访问是正式产品能力，可以随产品代码合并到 `main`，不属于本节
dev-only 清单。受支持的发布包必须保留 Agent 运行时的源码根：
`server/src/` 与 `packages/contracts/src/`。standalone 包由
`scripts/pack-release.mjs` 显式复制并校验这两个目录；CI bundle 由
`.github/workflows/package.yml` 显式 staging。

以下能力仍只在 `dev` 可见可用：

- Agent 自行编写 FamilySpec 拓扑；`server/src/agent/phase1-prompt.ts` 中该项
  执行授权在 release 分支须恢复为未授权措辞，`pi-adapter.test.ts` 的断言须同步。
- Agent 修改仓库代码（任何 write/edit 工具或等价能力）。治理边界见
  `docs/AGENT_SELF_MODIFICATION_CHARTER.md`；该能力未启用，宪章本身也必须随
  发布剪枝，永不进入 `main`。

历史来源：分支 `feat/relax-publication-gates`，提交 `cef17009`、`b1fd4e4b`
——仅作注记；哈希会因 amend/rebase 失效，以能力与路径为准。

校验：release 分支不得把 Agent 自行编写拓扑或任何代码 write/edit 能力带入
`main`；但不得因本节而删除 `read_dataset_core_source` 或源码只读授权。

## 3. 必须发布（不得与 dev-only 集一起回退）

- 其余一切已落入 `dev` 的正常产品修复。

## 4. 开 PR 前的验证

1. 从 `dev` 切发布分支，执行第 1–3 节；
2. 对照 `main` 做 diff 审计：新增方向无 dev-only 路径，删除方向覆盖内部清单；
3. 发布分支上跑 `pnpm lint`、`pnpm typecheck`、`pnpm build` 与**定向**测试；
4. PR 上的 CI 是权威门；绿了才合并。
