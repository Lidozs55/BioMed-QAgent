# P3 前端实施计划（B3 / B5 / C2a / C3e / E 类 UI）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成前端 9 项遗留：build 翻页、artifact 归属元数据、max_turns 标记、通用 UI 跳过项、5 个已知 UI 问题。

**Architecture:** 全部为局部改动。C3e 在 `useTaskBuild` 内翻页聚合；C2a 在 store 层引入 artifact 归属元数据；B3 是 INSTRUCTIONS 文案（后端 agent.py，随前端联调验证）；B5/E 为 UI 组件层修复。每项先写失败测试（vitest/jsdom）。

**Tech Stack:** React 19 / Vite / Tailwind v4 / vitest / pnpm。

## Global Constraints

- 前端命令一律在 `frontend/` 下：`pnpm lint`（--max-warnings 0）、`pnpm tsc`（--noEmit）、`pnpm test`（基线 726）、`pnpm build`。
- 禁止 `as any` / `@ts-ignore` / `@ts-expect-error`；组件遵循 shadcn 模式（先查现有组件再实现）。
- 每项完成后更新 `docs/LEFTOVERS.md`。

---

### Task 1: C3e — useTaskBuild 翻页聚合（超 50 条不再静默回退）

**Files:**
- Modify: `frontend/src/hooks/useTaskBuild.ts`（现取 `/builds` 首页，key 含 latestRunId）
- Test: `frontend/src/test/build-results-viewer.test.tsx` 或新建 `frontend/src/test/use-task-build-pagination.test.tsx`

**Interfaces:**
- Consumes: `GET /api/v1/builds?limit=&cursor=`（`BuildPage`：`items` + `next_cursor`，后端已支持）
- Produces: `useTaskBuild` 在首页未覆盖时按 cursor 翻页聚合全部 builds（或至少聚合到目标 build）；`hasBuildResult` 判定基于聚合结果而非首页

- [ ] **Step 1: 写失败测试** — mock `/builds` 返回两页（第一页 50 条无 build X，第二页含 build X）→ hook 断言最终解析到 build X（当前首页缺失 → legacy 回退）
- [ ] **Step 2: 运行确认失败** — `pnpm test` 新用例红
- [ ] **Step 3: 实现** — 在 hook 内循环 `next_cursor` 聚合（上限保护：最多 N 页或任务 builds 数）
- [ ] **Step 4: 运行确认通过** — `pnpm lint && pnpm tsc && pnpm test`
- [ ] **Step 5: 提交** — `fix(C3e): useTaskBuild 按 cursor 翻页聚合，>50 builds 不再静默回退`

---

### Task 2: C2a — store 引入 artifact 归属元数据（NO_DATA 归属）

**Files:**
- Modify: `frontend/src/runtime/`（reducer/selectors：artifact 条目携带 `run_id`/`publication_id` 归属）
- Modify: `frontend/src/components/`（NO_DATA banner/预览按归属渲染，先查现有组件）
- Test: `frontend/src/test/runtime-reducer.test.ts`（归属元数据投影断言）

**Interfaces:**
- Consumes: 后端 `GET /tasks/{id}/artifacts` 现有条目字段（`artifact_id/name/role/size/sha256/media_type`）
- Produces: store 的 artifact 条目增加 `run_id: string | null`（由 `run_manifest` 首条目归属或 builds API 关联）；NO_DATA banner 按 run 归属判定

- [ ] **Step 1: 写失败测试** — 喂入含两 run 归属的 artifact 事件流 → reducer 投影 run_id（当前无）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — reducer 投影 + banner 归属过滤
- [ ] **Step 4: 运行确认通过** — `pnpm lint && pnpm tsc && pnpm test`
- [ ] **Step 5: 提交** — `feat(C2a): artifact 归属元数据投影 + NO_DATA banner 按 run 过滤`

---

### Task 3: B3 — Agent INSTRUCTIONS 增加 max_turns 标记指令

**Files:**
- Modify: `backend/app/agent_loop/agent.py`（INSTRUCTIONS "汇报发现"段附近，加一条规则）
- Test: `backend/tests/test_prompt_shape_integration.py`（INSTRUCTIONS 内容断言）

**Interfaces:**
- Consumes: 现有 max_turns pause-resume 机制（`_await_max_turns_resume`，runner.py:1181）
- Produces: INSTRUCTIONS 明确："达到 max_turns 且用户选择继续时，下一轮输出必须以 `[MAX_TURNS_REACHED]` 开头标记续跑意图"——让前端可识别续跑轮

- [ ] **Step 1: 写失败测试** — 断言 INSTRUCTIONS 含 `[MAX_TURNS_REACHED]`（当前不含）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — INSTRUCTIONS 加一条 bullet（中文，与现有风格一致）
- [ ] **Step 4: 运行确认通过** — `pytest tests/test_prompt_shape_integration.py -q` + 后端全量
- [ ] **Step 5: 提交** — `feat(B3): INSTRUCTIONS 增加 max_turns 续跑标记指令`

---

### Task 4: B5 — 通用 UI：command/menubar 跳过、对话路由

**Files:**
- Modify: `frontend/src/`（先读 TODO.md:278 原文与现有导航/命令面板代码定位入口）
- Test: 对应组件测试（找到命令面板/菜单测试文件）

**Interfaces:**
- Consumes: 现有路由表与命令面板注册点
- Produces: 命令面板与 menubar 中跳过（或不显示）Pipeline 相关入口；对话路由保持延后状态并在 TODO 记录

- [ ] **Step 1: 读代码定位** — 找到命令面板/menubar 注册入口与对应测试
- [ ] **Step 2: 写失败测试** — 断言命令面板不含已废弃入口（当前含）
- [ ] **Step 3: 实现** — 移除/隐藏对应入口
- [ ] **Step 4: 运行确认通过** — `pnpm lint && pnpm tsc && pnpm test`
- [ ] **Step 5: 提交** — `feat(B5): command/menubar 跳过废弃入口，对话路由标注延后`

---

### Task 5: E 类 — 5 个已知 UI 问题排查修复

**Files:**（按问题逐个定位）
- `frontend/src/`：设置界面 skill 管理；模型上下文窗口显示 0；对话滚动不稳定；按键响应异常；工作区右上角按钮 tooltip
- Test: 每项一个失败测试或修复后验证

**Interfaces:**
- Consumes: `GET /api/v1/settings`（masked settings）、模型配置 store
- Produces: 5 项各自修复 + LEFTOVERS E 类逐项置 ✅

- [ ] **Step 1: 逐项复现**（手动 + 读代码确认根因；不确定的项先加调试日志/临时断言再修）
  - E1 skill 管理：设置界面列表/启用开关不可用 → 查 skill 设置 API 与前端调用
  - E2 上下文窗口显示 0：查 context budget 计算与展示组件
  - E3 对话滚动不稳定：查滚动容器与消息增量渲染（`runtime/transport.ts` 事件流）
  - E4 按键响应异常：查全局 keydown 处理与冲突
  - E5 tooltip：工作区右上角按钮补 title/tooltip
- [ ] **Step 2: 每项写失败测试**（jsdom 可测的写测试；纯视觉项以存在性断言）
- [ ] **Step 3: 实现修复**（每项一个提交）
- [ ] **Step 4: 运行确认通过** — `pnpm lint && pnpm tsc && pnpm test && pnpm build`
- [ ] **Step 5: 提交** — `fix(E-n): <问题简述>`

---

## P3 收尾

- [ ] 前端四门全过（lint/tsc/test/build）；后端因 B3 改动全量回归
- [ ] 更新 `docs/LEFTOVERS.md`：C3e/C2a/B3/B5/E 类置 ✅；`docs/TODO.md:278/365/367` 同步勾选
- [ ] 合并 `feat/leftovers-p3` 到 main
