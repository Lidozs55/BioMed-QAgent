# 遗留问题统一清单（LEFTOVERS）

> **唯一权威索引**：汇聚 TODO.md 未完成项、各阶段 REVIEW 遗留节、ISSUES.md 开放项
> 与 review-loop 记录的可选补强。细节与根因见各来源文档（本清单只做摘要+指针，
> 不重复内容，避免漂移）。**修改 TODO / REVIEW / ISSUES 时须同步本清单。**
>
> 快照：2026-08-09，main @ bdd23a6 → 分支 `feat/v2-mainline-v1-removal`（8 commits，已推送）。
> 状态图例：🔴 阻塞决策 · 🟠 产品/功能未完成 · 🟡 技术债（已评估）· ⚪ 可选补强 · ⚫ 已知问题（ISSUES.md）

---

## 🔴 A. 阻塞决策（已执行，分支合入中）

### A1. V1 生产路径退役（**已拍板：V1 全移除，主线只留 V2** — REVIEW_2026-08-09-v2-gap-audit.md，分支 `feat/v2-mainline-v1-removal`）

**执行状态（2026-08-09）**：✅ **已合并 main @ 9a7f19d**。Phase A 全部完成（A2a/A2c/A2e，A2d 延后）；Phase B 完成（V1 生产代码全删 + 测试迁移/删除）；Phase C 完成 C1d；T2 residual 与 v1_bridge legacy 镜像 409 bug 顺手修复；review loop 双 PASS（R1A ACCURATE / R1B ADEQUATE）。终态：后端 2252 passed / ruff clean / 前端 726 / 冒烟 OK。

### A2. V2 纵向链缺口（REVIEW_2026-08-09 §2）

| ID | 缺口 | 状态 |
| --- | --- | --- |
| A2a | 无 Agent-facing `validate_dataset_build_spec` 工具 | ✅ 完成（SpecValidator 包装 + 注册 + 4 TDD 用例） |
| A2b/c | V2 acquisition 血缘伪造 | ✅ 完成（真实 DownloadAttempt 登记 + provenance 暴露 + 2 TDD 用例） |
| A2d | Acquisition Dispatcher 接线（WorkflowRecipeSourceFetcher 生产消费者） | ⏳ **延后**（agent skills 已覆盖取数，不阻塞主线；待后续架构增强） |
| A2e | V1/V2 混用无 fail-fast | ✅ 完成（V1 工具已删除，混用面不复存在） |

### A3. V1 已知缺陷（2026-08-09 日志调试，**不修复，已随 V1 删除** — REVIEW_2026-08-09 §3）

| # | 缺陷 | 处置 |
| --- | --- | --- |
| A3a-e | GDC source_id 断链 / Reactome 解析 / Xena hub 键 / fixture 缺资产 / 单文件下载 | ✅ 随 V1 五阶段链删除（已不存在） |

### A4. 删除子项（随 Phase B 一并完成）

| 子项 | 状态 |
| --- | --- |
| A4a `_STAGES` / `StageName` 业务依赖 / `SUPPORTED_PIPELINE_SOURCE_COMBINATIONS` 门禁 | ✅ 删除（StageName 枚举本身保留——runtime/skills/events 仍用；兼容门禁及其守卫测试已随 review R2 删除） |
| A4b 22 列缓存写入接口 + `domain/processing.py` | ✅ V1 直写调用面已删（`domain/processing.py` 随退役删除）；`CacheStore.commit_dataset` 写入接口仍保留（`cache_tools`/`import_agent` 生产调用），随 B 类 P2 重审 |
| A4c `alignment.merge_datasets` 正式路径 | ✅ 删除（V2 自有 merge_strategy） |
| A4d `run_research_pipeline` 旧参数面 | ✅ 删除（agent 工具表无 V1 工具） |

---

## 🟠 B. 产品/功能未完成（TODO 未勾选）

| ID | 级别 | 项 | 来源 |
| --- | --- | --- | --- |
| B1 | P0 | ~~新 Run 携带版本化 `TaskSpecification`（原 §1.6）~~ ✅ **已修（2026-08-09, feat/leftovers-p1, commits 767d0ba/f69537c）**：`RunQueuedPayload`/`RunRecord`/`StartTaskRequest` 携带可选 `specification`（向后兼容 None），reducer 投影；`POST /tasks` 接受并持久化到 run（TDD 3 用例） | TODO:63 |
| B2 | ~~P2~~ | ~~删除 `validated_intermediate`/`validated_final` 状态（ADR-010 否决，任务/会话改 `current_publication_id`）~~ **已过时**：2026-08-09 审计确认仓库已无旧状态实现（当前即 `current_publication_id` 模型） | TODO:71 |
| B3 | P2 | Agent INSTRUCTIONS 增加"达 max_turns 输出 `[MAX_TURNS_REACHED]`" | TODO:365 |
| B4 | P2 | UniProt / ChEMBL Agent-only 来源能力（不接入 Pipeline） | TODO:367 |
| B5 | P2 | §3.5 通用 UI：**command/menubar 跳过、对话路由延后**（缓存导出按钮已完成） | TODO:278 `[~]` |

---

## 🟡 C. 技术债 / forward seam（已评估，多为"接受"级）

### C1. publication 完整性（REVIEW phase4-bug-sweep §3，Important）
- **C1a A2**：发布先于终态可持久化——publication 提交与 run_completed 非同一事务，取消/崩溃窗口产生"已发布但 run 非成功"孤立产物 → 需 finalize 事务化重构 ✅ **已修（2026-08-09, feat/leftovers-p1）**：finalize 在 task 锁内收敛 publication 落盘与 run_completed 事件；in-process 事件追加失败在发布事实（publication_created 事件已落盘）存在时幂等补发 run_completed 收敛 COMPLETED（判定 `RunExecution._publication_persisted`，不再用 committer 返回）；重启 `_recover` 按 `PublicationSummary.run_id == active_run_id` 关联发布事实（兼容 AGENT `pub-{run_id}` 与 V2 `pub_{build_id}_{sha}` 两种格式）闭合 FINALIZING run。**残余窗口（记录不修）**：进程崩溃于事件完全未持久化前 → run INTERRUPTED + 产物存在但无发布事件（builds API 仍按 manifest 投影展示）；AGENT 路径崩溃于 `pending.publish` 执行中 → FAILED + 部分发布文件；崩溃于 publish 完成后事件持久化前 → 发布文件无事件记录、重启不闭合（既有窗口，未恶化）
- **C1b A3**：reducer 不校验 run 状态即接受 `publication_created`（随 A2 设计）
- **C1c A4**：重启丢弃 pending HIL prompt（无 prompt-invalidated 事件）✅ **已修（2026-08-09, feat/leftovers-p1, commit 2d99ed9）**：`_recover` 对 AWAITING_USER_INPUT run 在 `run_interrupted` 前显式发 `WarningPayload(code="prompt_invalidated", message 含 run_id)`，前端 warning 渲染可见；run 收敛 INTERRUPTED 且保留重放 input 行为（集成测试断言恰 1 条 warning + 顺序）。**残余（延后）**：崩溃窗口在 warning 与 run_interrupted 之间 → 下次重启重复发 prompt_invalidated（极窄窗口，重复信息性 warning）；同进程 broker 移除导致的 pending 丢弃不在重启路径（超出 C1c 范围）
- **~~C1d V2-validation_ref~~** ✅ 已修复（2026-08-09）：`validation_report.json` 拷入 immutable version dir（TDD 测试）
- **C1e F7-03**：NO_DATA 信封 `user_summary`/`reason_codes` 因 `publication_id=None` 无法关联 → API 通用投影（phase7 §5）

### C2. 前端 artifact 归属与可见性
- **C2a C7**：NO_DATA banner/预览按 role 存在性推断归属（task 级聚合无法按 run/publication 过滤）→ 前端 store 引入 artifact 归属元数据（REVIEW phase4-bug-sweep §3）
- **C2b**：`corrections_todo.csv` 仍是任务工作目录文件、不进 `list_artifacts`（phase4c §5 遗留）→ 按 artifact role 纳入发布清单
- **C2c F7-06**：`list_artifacts` cache 路径首个坏条目 409 而非回退 legacy 面（phase7 §5）

### C3. cache/builds 一致性（REVIEW phase7 §5）
- **C3a F7-04**：content-addressed `artifact_id` 不含 path → 同字节双路径碰撞（修复方向：digest 含 `relative_path`）
- **C3b T1 residual**：V2 build 不发 `artifact_produced`（builds API 为 serving surface）；单 run 单 outcome slot
- **~~C3c T2 residual~~** ✅ 已修复（2026-08-09）：build-tool cache root 改从 workdir 推导（`work_dir.root.parents[2] / "cache"`），与 API `_cache_root` 恒等
- **C3d R1C-04**：`list_artifacts` 每请求重哈希 artifact（O(bytes)，GB CSV 慢）→ 缓存已验证 digest
- **C3e R1C-05/R1S-03**：`useTaskBuildId` 只取 `/builds` 首页（limit 50）→ 超 50 条静默 legacy 回退

### C4. V1 seam（REVIEW phase5 §5，V1 退役后收口）
- **C4a**：~~provider dispatcher（`geo.series/geo.platform` `resolve_provider` + `acquire_series_asset`）零 production 消费者~~
  ✅ **已随 V1 退役关闭**（`geo_provider.py` / `acquire_series_asset` / `resolve_provider` 已删除，无残留引用）
- **C4b F5**：coverage<1.0 时 per-binding 排除未实现（整 build NO_DATA，与 wave-7 一致，接受）
- **C4c**：probe 覆盖阈值校准门槛（`probe_coverage_required_gene_level` 语义检查已交付，门槛校准留后续）

### C5. 运行时健壮性（review-loop 记录）
- **C5a R1C-02**：混合 run（V1+V2 工具）`take_pending()` 非 None 时 V2 outcome 不转移 → "V1 wins"，REVIEW 声称 "last build wins" 不符（doc 偏差，无数据丢失）
- **C5b R1C-03**：`_load_build_publication` 吞损坏 `publication.json` → 已发布 build 误报 NO_DATA（安全方向下报，磁盘损坏才触发）
- **C5c R1C-06**：`reduce_task_event` 对 terminal 后 run_id 事件抛"immutable" ✅ **已修（2026-08-09, feat/leftovers-p1, commit c5a0901）**：可容忍迟到事件（assistant/operation/stage 镜像/tool/warning/artifact_produced 等 17 类）忽略并累加 `dropped_late_events` 计数；权威状态事件（run 生命周期/subagent/user_input/publication）保持严格抛错；白名单外新事件默认严格（forward seam，state.py 注释记录）
- **C5d A6**：`_task_locks`/repository `_task_locks`/EventStore `_checkpoints` 强键字典永不清除 ✅ **已修（2026-08-09, feat/leftovers-p1, commit d7342b6）**：删除任务路径（终态校验后、admission 锁内）pop 锁 + `EventStore.forget(task_id)`
- **C5e A7**：`TaskIndex.list_tasks` active 列表不受 limit 约束 ✅ **已修（2026-08-09, feat/leftovers-p1, commits d7342b6/8a083e3）**：active 查询加 `LIMIT ?`（历史分页语义不变）；新增无界 `list_active_tasks()` 供 `_recover` 扫描，饱和队列（104 活跃 > limit 100）重启不漏恢复（TDD 2 用例）
- **C5f ✅ 已修（2026-08-09, main @ 783784b）**：续跑 preflight compaction 崩溃——no_progress/max_turns 续跑时当前 RUNNING run 的活动组（SDK 输入副本 + 工具调用）无 terminal record，`align_groups_to_records` 恒抛 impossible → fallback 空会话 → SDK `Prepared model input is empty` → run_failed(internal_error)。修复：尾部无 record 组 peel 为在飞段原样保留（不警告/不摘要/不压缩），marker 分支同处理；`compact_view` 无可压缩内容守卫；`select_coverage_prefix`/弹段循环跳过在飞段；fallback 保底至少保留最新组。TDD 5 用例（`tests/runtime/test_compaction_inflight.py`）。**残余**：真超窗会话（在飞组 > input_capacity）→ 显式 `ContextBudgetOverflowError`（run 失败但错误明确；活动会话不可压缩是硬约束）。
- **C5g B1 残余（延后）**：`_request_fingerprint` 不含 `specification`——同 `request_id` 重试携带不同 spec 时静默首写胜（input 冲突有检测，spec 冲突无；first-write-wins 可辩护，最终 review [low] 记录）
- **C5h C1c 残余（延后）**：重启 `_recover` 崩溃于 prompt_invalidated warning 与 run_interrupted 事件之间 → 下次重启重复发 warning（极窄窗口，重复信息性 warning，最终 review [low] 记录）

### C6. 性能暂缓（ISSUES.md，审查结论"暂缓"，低优先级）
- `_replay_cache` 深拷贝放大（session.py:182-204）；压缩流程 5-6 处 deepcopy；`_task_locks` 永不清理（128B/锁可忽略）；RunContext 只追加不清理；Pipeline `events` 无限增长（1-10MB 瞬态）；SubagentSupervisor 异常退出字典泄漏
- **C6a `_CLEANING_MAX_ROWS`**：硬截断 5,000,000 行（REVIEW 2026-08-05 P0-1 从 500k 提高）——仍治标，未流式化（ISSUES.md 已更新）

---

## ⚪ D. 可选补强（review-loop 记录，非阻塞）

| ID | 项 | 来源 |
| --- | --- | --- |
| D1 | `GET /builds/{id}` 损坏 manifest 仍响亮 409 的测试 + 中间页损坏分页测试 | R2C-03 |
| D2 | operation 事件顺序无关性测试（op 先于 stage）+ 部分镜像 run 语义测试 | R2T-03/04 |
| D3 | 双读 API 对**真实** `execute_dataset_build` 产物 e2e 断言；build_result 全量重启回放测试 | R1T-02/03 |
| D4 | NO_DATA "非红"改 `data-variant` 断言（防 refactor 脆断）；`runId===null` 分支 reducer 测试 | R1T-04/05 |
| D5 | `/cache/datasets?limit=` 页帽测试；hook 负向用例（store churn 不重取） | R1T-06, R2T-06 |

---

## ⚫ E. 已知问题（ISSUES.md 开放项，无阻塞）

- **UI 5 项**：设置界面 skill 管理不可用；模型上下文窗口固定显示 0；对话滚动不稳定（待验证）；按键响应异常（待验证）；工作区右上角按钮缺 tooltip
- **_CLEANING_MAX_ROWS**（见 C6a）

---

## ✅ 已闭合（曾列入遗留，现已解决——勿重复跟踪）

| 项 | 闭合方式 |
| --- | --- |
| V2-dup `execute_dataset_build` → durable `execution.build_result` | Phase 7 T1 接线（manager `set_build_result` + e2e 回放存活） |
| F4 probe-primary `PlatformRecord` 发射 | Phase 7 T1（`platform_audit.csv` + NOT_ATTEMPTED） |
| Xena S3 403 | 官方 hub API（`toil.xenahubs.net/data/`），ISSUES.md 已标 `[x]` |
| metadata-only 占位 | Phase 4b 删除，回归测试守卫保留 |
| parse_pdb/parse_geo/parse_excel/tools.cleaning 死代码 | 已不存在（Phase 8 审计确认） |
| V2 DatasetRequest/BuildRecipe 临时实现 | 已不存在 |
| R2T-01/02 import 行 + docstring | 父直接修复（Phase 7 §6） |
