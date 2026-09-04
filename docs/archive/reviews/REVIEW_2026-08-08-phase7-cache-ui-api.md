# REVIEW — Phase 7 Cache、前端与 API 完整迁移

日期：2026-08-08
分支：`feat/phase7-cache-ui-api`（base main @ 8fb8c32）
结论：**P0×4 / P1×3 / P2×2 完成（P2 §3.5 部分完成），Design §16 Phase 7 验收达成。** 终态：后端 **2702 passed** / ruff 全量门 clean / import OK；前端 **712 passed (45 files)** / lint 0 / tsc 0 / build OK。

## 交付映射（T1–T6 + fix wave，全部 TDD 红→绿，dsv4-flash）

| # | TODO | 交付 |
| --- | --- | --- |
| T1 | P0 API 状态分离 + builds 端点 | `GET /builds`（分页 BuildResult+manifest 指针）、`GET /builds/{build_id}`（+`?task_id=` 消歧）、`GET /builds/{build_id}/artifacts/{artifact_id}`；**durable `execution.build_result`**（`execute_dataset_build` 安装 `PendingDatasetBuild` → executor `_transfer_dataset_build_outcome` 写入 + 真实 `PublicationCreatedPayload`，e2e 过 manager/executor 且回放存活）；**F4**：V2 probe-primary 发布发射 `PlatformRecord`（`platform_audit.csv` V1 同列 + NOT_ATTEMPTED） |
| T2 | P0/P1 Cache API + 双读双写 | `GET /cache/datasets`（namespace+keyword，V2+legacy 合并）、`GET /cache/datasets/{id}`（404）、缓存 artifact 下载（sha/size 校验 + path 守卫）；**双读双写**：V2 构建镜像 `artifacts/` + V1 `run_manifest.json`（`v1_bridge.py`，无 `.runtime-publication.json` 标记——避免 runtime reconcile 伪造 `pub-<run_id>`）；artifact API 双读（cache 优先、legacy 回退）；`main_data.csv` 包装为 `gene_expression.long.legacy.v1`（`legacy_cache.py` 只读投影，22 列与 long.v1 字段一致） |
| T3 | P0 operation events 后端 | 复用既有 `operation_started/progress/completed/failed` 事件类型（label/category 可选 → pydantic 默认 `""`，旧 events.jsonl 回放纯游标推进）；pipeline stage 发射侧镜像（`stage_*` 保留） |
| T4 | P0/P1 Manifest-driven ResultsViewer + Tabs | `BuildResultsViewer`：family/grain/schema 徽章、有效行数、来源覆盖、validation、confidence、provenance 覆盖率；NO_DATA/partial/spec-rejected 横幅带原因（NO_DATA sky/info 绝不为红）；`useTaskBuildId` 从最新 run 派生；Tabs 主数据/来源/处理/警告；legacy 回退保留；11 测试 |
| T5 | P0/P1 operation 渲染 + 自动折叠 | operation 事件按 `operation_id` 归组 `OperationItem`（label→id→category 回退、分类图标/色、状态徽章）；完成后自动折叠为可展开摘要（`tool_completed` 归组，手动开关保留）；失败徽章始终可见；6+1 测试 |
| T6 | P2 toolLabels / 模型搜索框 / UI 改进 | §3.2 核实已含 invoke_skill/find_skill（19 测试）；§3.3 删除死 `LEGACY_MODELS`，搜索框走真实 `GET /models` + 4 项离线回退；§3.5 缓存导出按钮已接线；command/menubar 跳过 + 对话路由延后（见 §5） |
| Fix | F7-01/02/05 | 双读按 build-dir shape `tasks_dir/<task_id>/datasets_build/<build_id>/` 匹配（生产 shape 回归测试）；builds API `?task_id=` 过滤 + viewer 透传；2 个 traversal pin 测试 |

## 验证

- 后端 `pytest -q`：**2702 passed**（2658 → +44：T1 +10 / T2 +20 / fix +4），2 skipped，28 deselected
- 前端 `pnpm test`：**712 passed (45 files)**（687/42 → +25），lint/tsc 0，build OK
- 后端 ruff 全量门 clean；`import app.main` OK；uvicorn 冒烟 OK（T2 验证 `/cache/datasets`）
- 前端未破坏后端、后端未破坏前端；无 live 网络测试

## Review loop（1 轮 whole-phase + fix wave）

| Reviewer | 结论 | 处理 |
| --- | --- | --- |
| F7（whole-phase，dsv4-flash） | **PASS，无 MUST-FIX** | F7-01 双读生产失效（manifest.task_id 永为 build_id → 双读永不触发，bridge 兜底掩盖）→ **修复**；F7-02 build_id 跨 task 碰撞 → **修复**（`?task_id=`）；F7-05 traversal 测试 → **补齐**；F7-03 NO_DATA 相关性 / F7-04 artifact_id 非 path 唯一 / F7-06 坏条目 409 → 接受为文档化 seam（§5） |

## 已核验（reviewer 实证）

- 三个下载表面的 path 守卫（resolve+containment）、404/422 语义、游标分页、现有端点未动
- build_result 持久性真实 e2e；manager zero-artifact 分支优先 executor 附加 BuildResult
- 回放纯性（`run_id:null` informational、stage_* 保留、旧 events.jsonl reducer 绿）
- NO_DATA 横幅 sky/amber 非红（测试断言无 destructive/red 类）；4 项离线回退体量小

## 遗留（§5）

1. **F7-03（接受）**：NO_DATA 信封带更丰富的 `user_summary`/`reason_codes`，但 API 相关性按 `publication_id`（NO_DATA 为 None）→ 显示通用投影；信封仍在 `run_completed` 可见。Phase 8 前可键 run+operation 细化。
2. **F7-04（接受）**：content-addressed `artifact_id` 不含 path，同字节双路径碰撞 → 下载取首个匹配 + React key 碰撞；v1_bridge 已缓解 legacy 侧。修复方向：digest 含 `relative_path`。
3. **F7-06（接受）**：`list_artifacts` cache 路径首个坏条目 409 而非回退 legacy 面。
4. **T6 延后**：command/menubar（无现有模式、成本高）、对话路由（§3.5 剩余）——TODO 标注 `[~]` 部分完成。
5. **T1 residual（接受）**：V2 build 文件不发 `artifact_produced` 事件（V1 `ArtifactManifestEntry` 需 `artifacts/` 前缀路径）——builds API 为 serving surface；单 run 单 outcome slot（多 build run 保留最后 build 的 BuildResult）。
6. **T2 residual**：build-tool cache root 用模块 `settings.output_dir`，与 API 读的 app 配置 root 可能不一致（测试不依赖，Phase 8 可统一）。

---

## §6 Parent-orchestrated review loop（round 1 + fix + round 2，subagent 工具）

Round 1（3 平行 fresh-context reviewers @ main 94316f4）：**均 PASS、无 BLOCKER**，双端全门复核 2718/712。

| 发现 | 级别 | 处置 |
| --- | --- | --- |
| R1C-01 `list_builds` 一个坏 manifest 拖垮整个 `/builds` | Should-Fix | **修复**（F1） |
| R1S-01 托管 run 中 stage_*/operation_*/progress 同台三行（§17.2 要求按 operation 身份渲染） | Should-Fix | **修复**（F2，父核验为真） |
| R1S-02 `useTaskBuildId` 二次 build run 后不重取（key 缺 latestRunId） | Should-Fix | **修复**（F3） |
| R1C-02..06、R1T-01..08、R1S-03..07 | Optional/Note | 延后（§5 遗留扩容：混合 run V1 优先、publication 损坏下报、artifact 逐请求重哈希、/builds 首页 50 条限制、reducer terminal 硬化、测试补强） |

Fix wave（1 async worker，TDD 红→绿）：F1 `list_builds` 捕 409 跳过坏 build（detail 仍响亮 409，红测真）；F2 reducer 后置 `pruneStageItemsForOperationRuns`——带 operation 事件的 run 仅保留归组 operation 行，legacy 无 operation 事件的 run 保留 stage/progress（兼容测试保绿，无既有测试依赖旧双行前提）；F3 fetch key/effect deps 加 `latestRunId`（红测：bug 代码停在 build_x，修复后取 build_y，断言 2 次 fetch）。

Round 2（2 平行 fresh-context reviewers，仅 fix diff）：**均 PASS、无 Should-Fix**。红测实证（对 pre-fix main 源码重跑新测试）：3 个新测试均真红→绿；断言全为行为级；门输出精确匹配（2719/715）。R2C/R2T 剩余均为 Optional/Note：父直接应用 R2T-01（import 行拆分）、R2T-02（docstring 同步）；可选测试（detail-409、中间页损坏、顺序无关、部分镜像 run、负向用例）记入 §5 延后。

**终态：main @ aab17a0，后端 2719 / 前端 715，全门绿。**
