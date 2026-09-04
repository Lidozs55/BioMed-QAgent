# LEFTOVERS 实施路线图（2026-08-09 快照）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement these plans task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 docs/archive/LEFTOVERS-2026-08-09.md 中所有未实施项（A2d / B 类 4 项 / C 类 20 项 / D 类 5 项 / E 类 5 项）转化为可独立交付、可验证的子系统计划。

**Architecture:** 按子系统边界拆分，每份计划可独立执行与合并，互不阻塞。执行顺序按依赖与价值：P1（后端运行时，含唯一 P0 与唯一 Important 项）→ P2（构建/发布层）→ P3（前端）→ P4（测试补强与性能）。P2-P4 中的"接受级"技术债每项都带明确验收断言，执行者按验收即可，无需产品决策。

**Tech Stack:** Python 3.12 / FastAPI / Pydantic v2 / OpenAI Agents SDK；React 19 / Vite / Tailwind v4；pytest / vitest。

## Global Constraints

- 后端命令一律在 `backend/` 下运行（`source .venv/bin/activate`）；前端在 `frontend/`（pnpm，**禁用 npm**）。
- 每个修复先写失败测试（TDD red），再实现（green），再提交。
- 质量门：后端 `pytest -q`（基线 2257 passed）、`ruff check app/ tests/ launcher.py`（0 warning）；前端 `pnpm lint && pnpm tsc && pnpm test && pnpm build`（基线 726 passed）。
- TypeScript 严格模式：禁止 `as any` / `@ts-ignore` / `@ts-expect-error`。
- 手术式改动：只动计划列出的文件；不顺手重构；不删除计划外的死代码。
- 提交信息：`feat/fix: <一句话>`，一次功能一个提交；分支名 `feat/leftovers-<batch>`。
- 每个 Task 完成后更新 `docs/archive/LEFTOVERS-2026-08-09.md` 对应条目状态（✅ 已修 + commit hash）。
- 权威来源：`docs/archive/LEFTOVERS-2026-08-09.md`（A2d ⏳、B1-B5、C1a-C6a、D1-D5、E）与 `docs/TODO.md`（63/278/365/367）。

---

## 分批表

| 批次 | 文件 | 子系统 | 覆盖项 | 优先级 |
|---|---|---|---|---|
| P1 | `2026-08-09-leftovers-p1-backend-runtime.md` | 后端运行时 | B1（P0）、C1a（Important）、C1c、C5c、C5d、C5e | ✅ **已合并 main @ be91dc9（2026-08-09）** |
| P2 | `2026-08-09-leftovers-p2-build-publish.md` | 构建/发布/API | A2d、B4、C1b、C1e、C2b、C2c、C3a、C3b、C3d、C4b、C4c | ✅ 已合并（main @ 2becfca） |
| P3 | `2026-08-09-leftovers-p3-frontend.md` | 前端 | B3、B5、C2a、C3e、E 类 UI 5 项 | 第三批 |
| P4 | `2026-08-09-leftovers-p4-tests-perf.md` | 测试补强/性能 | D1-D5、C5a、C5b、C6a | 可并行 |

**依赖关系**：P1 已完成；P2 的 C1e 依赖 P1 的 B1（specification 投影，仅共享 RunRecord 扩展点，可独立先行）；P3 的 C3e 依赖 P2 的 C3d（非硬依赖）；P4 全独立。每批合并后必须全量回归（后端 2257+ / 前端 726+ 基线只增不减）。
