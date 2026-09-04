# P2 构建/发布层实施计划（A2d / C1b / C1e / C2c / C3a / C3b / C3d / C4b / C4c）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收敛构建/发布/artifact API 层的 11 个遗留项：坏 manifest 列表容错、artifact_id 碰撞、digest 缓存、NO_DATA 投影关联、reducer 状态校验、WORKFLOW_RECIPE 接线、corrections_todo 产物暴露、UniProt/ChEMBL Agent-only 来源、per-binding 排除、阈值校准决策。

**Architecture:** 全部为局部、手术式改动，逐项独立可验证。多数项已有清晰的失败路径（磁盘损坏、碰撞、超 50 条），改动方向已在 LEFTOVERS 记录。A2d 与 C4c 为"设计先行"任务：先产出决策记录，再实现或显式关闭。

**Tech Stack:** Python 3.12 / FastAPI / Pydantic v2 / pytest。

## Global Constraints

- 每个 Task 先写失败测试再实现；后端质量门 `ruff check app/ tests/ launcher.py`（0 warning）+ 全量 `pytest -q`（基线 2257）。
- 契约/响应格式改动必须向后兼容（旧前端不破坏）；`artifact_id` 变更需同步 `tests/api/test_artifact_api.py` 的断言。
- 每项完成后更新 `docs/archive/LEFTOVERS-2026-08-09.md` 条目。

---

### Task 1: C2c — list_artifacts 对 cache 坏条目回退 legacy 面

**Files:**
- Modify: `backend/app/api/routes.py`（`_cache_artifacts_for_task` / list 路径，文件完整性校验 409 处 :879/:914/:968/:994）
- Test: `backend/tests/api/test_artifact_api.py`（坏文件参数化：现有 `hash_mismatch`/`size_mismatch` 用例的 409 断言改为回退断言）

**Interfaces:**
- Consumes: 现有 cache-first + legacy 回退结构（manifest 解析失败已 continue 回退；本任务补文件校验失败路径）
- Produces: 文件完整性校验失败 → 跳过该 cache entry（`continue`）→ 回退 legacy 镜像面 200；**仅当 legacy 面也不存在时才 409**

- [ ] **Step 1: 写失败测试**（在 `test_artifact_api.py` 的 `test_artifact_api_preserves_manifest_and_integrity_conflicts` 参数化中，把 `size_mismatch`/`hash_mismatch` 的期望从 `(409, "Artifact integrity check failed")` 改为 `(200, "")` + 回退断言——与 `invalid_json` 用例同构）
- [ ] **Step 2: 运行确认失败** — 当前 409，用例红
- [ ] **Step 3: 实现** — 把 :879 等处的 `raise HTTPException(409, ...)` 改为 `continue`（保持 `_verified_cache_artifact_path` 的 traversal 检查为 409 不变）
- [ ] **Step 4: 运行确认通过** — `pytest tests/api/test_artifact_api.py -q` 全绿
- [ ] **Step 5: 提交** — `fix(C2c): list_artifacts cache 文件校验失败回退 legacy 面（traversal 仍 409）`

---

### Task 2: C3a — artifact_id digest 含 relative_path（去碰撞）

**Files:**
- Modify: `backend/app/datasets/build/manifest.py:56`（`artifact_id=f"artifact_{checksum[:32]}"` → digest 含 `relative_path`）
- Modify: `backend/app/datasets/build/v1_bridge.py`（镜像面 id 生成：`sha256(relative_path)` 已 path-unique，核对不受影响）
- Test: `backend/tests/test_dataset_expression_runner.py` / `tests/api/test_artifact_api.py`（新增同字节双路径用例）

**Interfaces:**
- Consumes: manifest 构建入口 `build_dataset_manifest`（manifest.py）
- Produces: `artifact_id = artifact_{sha256(relative_path + "\x00" + sha256(content))[:32]}`；旧 id 不再产生（历史产物重放不受影响，id 每次由 manifest 计算）

- [ ] **Step 1: 写失败测试** — 构造两个 relative_path 不同、内容相同的 artifact → 断言 id 不同（当前相同）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — 更新 digest 组合；同步任何硬编码 id 的测试断言（grep `artifact_` 前缀断言）
- [ ] **Step 4: 运行确认通过** — `pytest tests/test_dataset_expression_runner.py tests/api/test_artifact_api.py -q`
- [ ] **Step 5: 提交** — `fix(C3a): artifact_id digest 含 relative_path，同字节双路径不再碰撞`

---

### Task 3: C3d — list_artifacts 已验证 digest 缓存

**Files:**
- Modify: `backend/app/api/routes.py`（list 路径的 `_file_sha256` 调用点）
- Test: `backend/tests/api/test_artifact_api.py`（新增：同一任务连续两次 list，第二次不再读文件——用 monkeypatch 计数 `open`/`read_bytes`）

**Interfaces:**
- Consumes: `_file_sha256(path)` 现有签名
- Produces: 模块级 LRU（`functools.lru_cache(maxsize=256)` 或等价）缓存 `(path, mtime_ns, size) → digest`，文件变更（mtime/size）自动失效；缓存键含 mtime 避免陈旧

- [ ] **Step 1: 写失败测试** — 首次 list 读文件 N 次；二次 list 读文件 0 次（monkeypatch 计数）
- [ ] **Step 2: 运行确认失败**（当前每请求全量重哈希）
- [ ] **Step 3: 实现** — 包装 `_file_sha256` 为带 mtime 失效的缓存函数（仅 list 路径使用；下载路径仍实时校验）
- [ ] **Step 4: 运行确认通过** — 新用例 + `pytest tests/api/test_artifact_api.py -q`
- [ ] **Step 5: 提交** — `perf(C3d): list_artifacts digest 缓存（mtime+size 失效）`

---

### Task 4: C1e — NO_DATA 信封经 API 通用投影关联

**Files:**
- Modify: `backend/app/api/routes.py`（NO_DATA build 投影处 :1322-1332 区域）
- Modify: `backend/app/runtime/manager.py:1879`（NO_DATA 信封来源，如需补 `user_summary`/`reason_codes` 到 BuildResult）
- Test: `backend/tests/api/test_builds_api.py`（新增：NO_DATA build 的 listing 项携带 `user_summary`/`reason_codes`）

**Interfaces:**
- Consumes: `BuildResult` 契约（`reason_codes` 字段存在性以 contracts 为准）
- Produces: `GET /builds` 的 `BuildSummary` 对 NO_DATA build 投影 `reason_codes`/`user_summary`（替代当前因 `publication_id=None` 丢失）

- [ ] **Step 1: 写失败测试** — seed NO_DATA build（参考现有 builds API 测试）→ `GET /builds` 断言 `reason_codes == ["no_primary_data"]`（当前缺失）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — NO_DATA 分支把信封字段投影进 BuildSummary（读 :1322 上下文找缺口）
- [ ] **Step 4: 运行确认通过** — `pytest tests/api/test_builds_api.py -q` 全绿
- [ ] **Step 5: 提交** — `fix(C1e): NO_DATA build 经 API 投影携带 reason_codes/user_summary`

---

### Task 5: C1b — reducer 校验 run 状态后接受 publication_created

**Files:**
- Modify: `backend/app/runtime/state.py`（`publication_created` 分支）
- Test: `backend/tests/runtime/test_task_snapshot.py`（新增：run 非 RUNNING/FINALIZING 时收到 `publication_created` → 拒绝/忽略）

**Interfaces:**
- Consumes: `reduce_task_event` 现有签名
- Produces: `publication_created` 仅在 run 处于 RUNNING/FINALIZING/AWAITING_USER_INPUT 时接受；否则忽略并计数（与 C5c 的迟到容忍同机制）

- [ ] **Step 1: 写失败测试** — COMPLETED run 后注入 `PublicationCreatedPayload` → 不抛错且不产生 second publication（当前直接接受）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — 复用 C5c 的容忍分流（P1 Task 4 产出）
- [ ] **Step 4: 运行确认通过** — 全量 `pytest tests/runtime/ -q`
- [ ] **Step 5: 提交** — `fix(C1b): reducer 校验 run 状态后接受 publication_created`

---

### Task 6: C3b — V2 build 镜像 artifact_produced（或决策记录）

**Files:**
- Modify: `backend/app/runtime/manager.py`（V2 finalize 处，或 expression_runner 发布点）
- Test: `backend/tests/runtime/test_fixture_executor.py`（新增：fixture 构建完成产生 `artifact_produced` 事件）

**Interfaces:**
- Consumes: `ArtifactProducedPayload` 契约（存在性以 contracts 为准）
- Produces: V2 构建成功时镜像一条 `artifact_produced`（指向 publication 主产物）；若实现成本 > 收益，产出 LEFTOVERS 决策记录"关闭"并写明理由（前端 builds API 已是 serving surface）

- [ ] **Step 1: 读代码确认事件缺口**（`git grep artifact_produced`）
- [ ] **Step 2: 写失败测试**（若选择实现）或写决策记录（若选择关闭）
- [ ] **Step 3: 实现 / 记录**
- [ ] **Step 4: 运行确认**
- [ ] **Step 5: 提交** — `fix(C3b): ...` 或 `docs: C3b 决策记录 — 关闭/实现`

---

### Task 7: A2d — WORKFLOW_RECIPE acquisition 接线

**Files:**
- Modify: `backend/app/pipeline/dataset_build_tool.py`（per-binding acquisition 分发处）
- Modify: `backend/app/runtime/executor.py`（如 acquisition 处理在 executor）
- Test: `backend/tests/test_dataset_build_tool.py`（新增：`AcquisitionMode.WORKFLOW_RECIPE` binding → 经 `WorkflowRecipeSourceFetcher.fetch` 获取并登记血缘）

**Interfaces:**
- Consumes: `app.recipes.source_fetcher.WorkflowRecipeSourceFetcher.fetch(binding, workspace) -> RecipeExecutionResult`（已存在，仅处理 WORKFLOW_RECIPE 模式，PROMOTED 限制内置）
- Produces: `execute_dataset_build` 对 WORKFLOW_RECIPE binding 走 fetcher；非 PROMOTED 拒绝原因进入 `rejected_sources`（与现有拒绝语义一致）

- [ ] **Step 1: 写失败测试** — WORKFLOW_RECIPE binding + mock fetcher → 断言 fetcher 被调用、SourceAsset 血缘登记
- [ ] **Step 2: 运行确认失败**（当前该模式无消费者）
- [ ] **Step 3: 实现** — 在 acquisition 分发点插入 fetcher 分支（`AcquisitionMode.BUILTIN` 现有路径不动）
- [ ] **Step 4: 运行确认通过** — `pytest tests/test_dataset_build_tool.py -q`
- [ ] **Step 5: 提交** — `feat(A2d): WORKFLOW_RECIPE acquisition 经 WorkflowRecipeSourceFetcher 接线`

---

### Task 8: C4b/C4c — per-binding 排除 + 阈值校准（设计先行）

**Files:**
- Modify: 决策后确定（候选：`backend/app/datasets/build/integrator.py` per-binding 结果聚合；`backend/app/datasets/build/profiles.py` 阈值）
- Test: 决策后确定（候选 `backend/tests/test_dataset_expression_runner.py`）
- Docs: `docs/archive/LEFTOVERS-2026-08-09.md` 更新决策记录

**Interfaces:**
- Consumes: LEFTOVERS C4b（coverage<1.0 per-binding 排除未实现）与 C4c（probe 覆盖阈值校准门槛）
- Produces: 两份决策：C4b 实现 per-binding 排除（部分 binding NO_DATA 时其余 binding 正常发布）或确认"整 build NO_DATA"为接受行为并关闭；C4c 给出阈值校准的验收标准（基于真实数据集分布）或关闭

- [ ] **Step 1: 读现有 integrator/validation 覆盖逻辑，写决策记录草稿**（`docs/REVIEW_<date>-c4b-c4c.md`）
- [ ] **Step 2: 按决策实现或关闭**（关闭必须写明理由与引用证据）
- [ ] **Step 3: 更新 LEFTOVERS 条目**（✅ 或 🔒 关闭）
- [ ] **Step 4: 回归** — `pytest -q`（基线只增不减）
- [ ] **Step 5: 提交** — `feat/fix(C4b/c): ...` 或 `docs: C4b/c 决策记录`

---

### Task 9: C2b — corrections_todo.csv 纳入 list_artifacts

**Files:**
- Modify: `backend/app/agent_loop/main_input_broker.py`（`_write_corrections_todo` 写盘处，`_CORRECTIONS_TODO_FILENAME` 常量）
- Modify: `backend/app/api/routes.py`（list 扫描：任务 artifacts 目录存在 corrections_todo.csv 时追加登记）
- Test: `backend/tests/api/test_artifact_api.py`（新增：任务目录存在 corrections_todo.csv → list_artifacts 含该条目）

**Interfaces:**
- Consumes: `_CORRECTIONS_TODO_FILENAME` 常量、list_artifacts 现有条目结构
- Produces: `corrections_todo.csv` 以杂项 role（`ArtifactRole` 枚举中现有最近角色，执行时确认）出现在 `GET /tasks/{id}/artifacts`，前端可下载

- [ ] **Step 1: 写失败测试** — seed 一个含 corrections_todo.csv 的任务目录 → `GET /tasks/{id}/artifacts` 断言含该条目（当前不含）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — list 路径把存在的 corrections_todo.csv 追加为条目（digest/size 实时计算，与现有条目一致）
- [ ] **Step 4: 运行确认通过** — `pytest tests/api/test_artifact_api.py -q` 全绿
- [ ] **Step 5: 提交** — `feat(C2b): corrections_todo.csv 纳入 list_artifacts（辅助 role）`

---

### Task 10: B4 — UniProt / ChEMBL Agent-only 来源能力

**Files:**
- Modify: `backend/app/domain/contracts/enums.py`（`Database` 枚举：grep 现有成员后追加 `UNIPROT`/`CHEMBL`）
- Modify: `backend/app/skills/builtin/discovery/`（新增 `search_uniprot`/`search_chembl` skill，对齐现有 discovery skill 模式）
- Modify: `backend/app/domain/contracts/task.py`（`SourceCapabilityDeclaration`：Agent-only 来源声明 `research_only`——现有机制复用）
- Test: `backend/tests/`（skill 目录测试 + 契约测试）

**Interfaces:**
- Consumes: `Database` 枚举、discovery skill 注册表、`SourceCapabilityDeclaration`（task.py:52-60 已支持 capability 声明）
- Produces: `Database.UNIPROT`/`Database.CHEMBL` 成员 + 两个 discovery skill（agent 可检索、声明 `research_only`、永不进入 dataset build 的 verified 源）

- [ ] **Step 1: 写失败测试** — 契约：`Database.UNIPROT` 存在且 `DATABASE_IDENTIFIER_ALIASES` 含 `uniprot`；skill：注册表列出 `search_uniprot`
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — 枚举 + alias + skill 骨架（HTTP 检索 UniProt REST API / ChEMBL API，网络层复用现有 discovery skill 的 fetch 模式）
- [ ] **Step 4: 运行确认通过** — `pytest tests/ -q`（skill 测试用 mock 网络）
- [ ] **Step 5: 提交** — `feat(B4): UniProt/ChEMBL Agent-only 来源（research_only 声明 + discovery skill）`

---

## P2 收尾

- [ ] 全量回归 + ruff（0 warning）
- [ ] 更新 `docs/archive/LEFTOVERS-2026-08-09.md`：C2c/C3a/C3d/C1e/C1b/C3b/A2d/C4b/C4c 全部置 ✅ 或 🔒 关闭
- [ ] 合并 `feat/leftovers-p2` 到 main
