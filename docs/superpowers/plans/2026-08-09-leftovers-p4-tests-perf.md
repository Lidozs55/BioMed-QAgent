# P4 测试补强与性能实施计划（D1-D5 / C5a / C5b / C6a）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 review-loop 记录的测试盲区（D1-D5）、修两个小的运行时一致性偏差（C5a 文档对齐、C5b 损坏 publication 显式化）、推进 `_CLEANING_MAX_ROWS` 流式化（C6a）。

**Architecture:** 全独立、可并行。D 类纯加测试（不动生产代码）；C5a 是 doc/语义对齐（极小）；C5b 改错误处理路径（加显式 warning + 保留安全下报）；C6a 改 processing 行流式化（较大，需评估）。

**Tech Stack:** Python 3.12 / pytest / vitest；前端仅 D 类相关用例。

## Global Constraints

- D 类只加测试：不改生产代码（除非测试暴露真实 bug——暴露时按 TDD 修复并记录）。
- 每项完成更新 `docs/LEFTOVERS.md`。
- 质量门同前：后端 `pytest -q`（2257 基线只增）+ ruff 0 warning；前端 `pnpm test`（726 基线只增）。

---

### Task 1: D1 — corrupt build 详情与分页测试

**Files:**
- Test: `backend/tests/api/test_builds_api.py`（追加）

**Interfaces:**
- Consumes: `GET /builds/{build_id}`（损坏 manifest → 409 响亮失败，R2C-03 确认的语义）、`GET /builds` 分页
- Produces: 两个用例：① 损坏 build 的 detail 端点仍 409；② 含损坏 build 的中间页仍返回正常分页（该页 underfull，游标来自最后一个有效项）

- [ ] **Step 1: 写测试**（参考现有 `test_builds_api.py` 的 seed 模式；损坏 = 截断 `dataset_manifest.json`）
- [ ] **Step 2: 运行** — `pytest tests/api/test_builds_api.py -q`，Expected: PASS
- [ ] **Step 3: 提交** — `test(D1): corrupt build detail 409 + 分页 underfull 断言`

---

### Task 2: D2 — operation/stage 顺序无关性测试

**Files:**
- Test: `backend/tests/api/test_websocket_replay.py`（或现有 operation 镜像测试文件，追加）

**Interfaces:**
- Consumes: 双发事件流（stage_* + operation_* 镜像），`operation_id` 稳定串
- Produces: ① operation_started 先于 stage_started 的顺序无关用例；② 部分镜像 run（只有 stage 无 operation）的兼容用例

- [ ] **Step 1: 写测试**（参考现有 replay 测试的事件构造）
- [ ] **Step 2: 运行** — Expected: PASS
- [ ] **Step 3: 提交** — `test(D2): operation 事件顺序无关 + 部分镜像 run`

---

### Task 3: D3 — 双读 API 真实产物 e2e + 重启回放

**Files:**
- Test: `backend/tests/api/test_artifact_api.py`（或 `tests/test_dataset_expression_runner.py` 追加）

**Interfaces:**
- Consumes: `execute_dataset_build` 真实执行产物（fixture GDC 数据，非 seed 注入）
- Produces: ① 真实构建 → cache-first 与 legacy 镜像内容一致（digest 断言）；② build_result 全量事件重启回放（重建 repository 后 snapshot 等价）

- [ ] **Step 1: 写测试**（复用 `tests/runtime/test_fixture_executor.py` 的 fixture 驱动模式）
- [ ] **Step 2: 运行** — Expected: PASS
- [ ] **Step 3: 提交** — `test(D3): 双读 API 真实产物 e2e + build_result 重启回放`

---

### Task 4: D4 — NO_DATA data-variant + runId===null 分支测试

**Files:**
- Test: `frontend/src/test/`（NO_DATA banner 相关）+ `frontend/src/test/runtime-reducer.test.ts`

**Interfaces:**
- Consumes: NO_DATA 渲染组件（`data-variant` 属性）、reducer 的 `runId===null` 分支（legacy）
- Produces: ① NO_DATA 非红样式改为 `data-variant` 断言（防 refactor 脆断）；② legacy 事件（runId null）的 reducer 投影用例

- [ ] **Step 1: 写测试**（jsdom）
- [ ] **Step 2: 运行** — `pnpm test`，Expected: PASS
- [ ] **Step 3: 提交** — `test(D4): NO_DATA data-variant + legacy runId null 分支`

---

### Task 5: D5 — /cache 页帽 + hook 负向用例

**Files:**
- Test: `backend/tests/api/test_cache_api.py`（页帽）+ `frontend/src/test/use-task-build-pagination.test.tsx`（负向）

**Interfaces:**
- Consumes: `GET /cache/datasets?limit=`、`useTaskBuild` 的 key/effect 语义
- Produces: ① limit 页帽边界用例；② hook 负向：store churn（无关更新）不触发重取

- [ ] **Step 1: 写测试**
- [ ] **Step 2: 运行** — 后端 `pytest tests/api/test_cache_api.py -q` + 前端 `pnpm test`，Expected: PASS
- [ ] **Step 3: 提交** — `test(D5): /cache 页帽 + hook 负向不重取`

---

### Task 6: C5a — take_pending "V1 wins" 文档对齐

**Files:**
- Modify: `backend/app/runtime/manager.py`（`take_pending` 行为注释或 docstring，:1400 附近）
- Modify: `docs/REVIEW_2026-08-09-v2-gap-audit.md` 或对应 REVIEW 文档中 "last build wins" 表述
- Test: 无需新测试（行为不变，纯文档）

**Interfaces:**
- Consumes: 现状（混合 run 时 `take_pending()` 非 None → V2 outcome 不转移）
- Produces: 文档如实描述 "V1 wins" 语义；LEFTOVERS C5a 置 ✅（doc 偏差已消）

- [ ] **Step 1: 改注释/docstring + REVIEW 文档表述**
- [ ] **Step 2: 回归** — `pytest -q`（无行为变化）
- [ ] **Step 3: 提交** — `docs(C5a): take_pending V1-wins 语义如实记录`

---

### Task 7: C5b — _load_build_publication 损坏显式化

**Files:**
- Modify: `backend/app/api/routes.py`（`_load_build_publication`，吞损坏 `publication.json` 处）
- Test: `backend/tests/api/test_builds_api.py`（新增：损坏 publication.json → build 项携带显式 warning 或 error_code，而非静默 NO_DATA）

**Interfaces:**
- Consumes: 现有 `_load_build_publication` 返回语义
- Produces: 损坏 `publication.json` → `BuildSummary` 带 `status="failed"` + `error` 描述（"publication manifest is invalid"），前端可见；磁盘完好路径不变

- [ ] **Step 1: 写失败测试** — 损坏 publication.json → 断言 listing 项不再伪装 NO_DATA
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — 解析失败时返回显式失败结果而非 NO_DATA 投影（保持安全方向：不产生假数据）
- [ ] **Step 4: 运行确认通过** — `pytest tests/api/test_builds_api.py -q` 全绿
- [ ] **Step 5: 提交** — `fix(C5b): 损坏 publication.json 显式 failed，不再伪装 NO_DATA`

---

### Task 8: C6a — _CLEANING_MAX_ROWS 流式化评估与推进

**Files:**
- Modify: `backend/app/processing/`（清理行处理处，`_CLEANING_MAX_ROWS` 引用点）
- Test: `backend/tests/`（现有 _CLEANING_MAX_ROWS 测试 + 流式断言）
- Docs: `docs/LEFTOVERS.md` C6a 决策记录

**Interfaces:**
- Consumes: 现有清理管线入口（读代码定位 `_CLEANING_MAX_ROWS` 引用）
- Produces: 评估结论 +（若可行）行流式处理替代内存全载截断；若评估确认不可行（下游需要全量排序），产出决策记录关闭并写明原因

- [ ] **Step 1: 读代码** — `grep -rn _CLEANING_MAX_ROWS backend/app`，确认清理管线结构
- [ ] **Step 2: 写评估记录**（`docs/REVIEW_<date>-c6a.md`）：流式化收益 vs 排序/去重依赖
- [ ] **Step 3: 按结论实现或关闭**（实现：分批处理 + 行数守卫测试；关闭：记录原因）
- [ ] **Step 4: 回归** — `pytest -q`
- [ ] **Step 5: 提交** — `perf(C6a): ...` 或 `docs: C6a 决策记录`

---

## P4 收尾

- [ ] 后端全量回归 + ruff；前端 `pnpm test`
- [ ] 更新 `docs/LEFTOVERS.md`：D1-D5 ✅、C5a ✅、C5b ✅、C6a ✅/🔒
- [ ] 合并 `feat/leftovers-p4` 到 main
