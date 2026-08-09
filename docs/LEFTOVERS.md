# 遗留问题统一清单（LEFTOVERS）

> **唯一权威索引**：汇聚 TODO.md 未完成项、各阶段 REVIEW 遗留节、ISSUES.md 开放项
> 与 review-loop 记录的可选补强。细节与根因见各来源文档（本清单只做摘要+指针，
> 不重复内容，避免漂移）。**修改 TODO / REVIEW / ISSUES 时须同步本清单。**
>
> 快照：2026-08-08，main @ 3b87877；基线 后端 2722 passed / 前端 726 passed (47 files)。
> 状态图例：🔴 阻塞决策 · 🟠 产品/功能未完成 · 🟡 技术债（已评估）· ⚪ 可选补强 · ⚫ 已知问题（ISSUES.md）

---

## 🔴 A. 未决架构/产品决策（唯一阻塞项）

### A1. V1 生产路径退役（TODO Phase 8 `[~]`×4，REVIEW phase8 §5）
V2 `execute_dataset_build` 已闭环（四种必测结果 e2e 覆盖）但 **agent INSTRUCTIONS 仍引导 V1
`run_research_pipeline` 为正式产物入口**（仅注册零引导）。退役候选方案 4 步已写入
REVIEW §5（INSTRUCTIONS 切换 → V1 降级/删除 → 测试迁移 → 全量回归）。依赖 A1 的删除子项：

| 子项 | 现状 |
| --- | --- |
| A1a `_STAGES` / `StageName` 业务依赖 / `SUPPORTED_PIPELINE_SOURCE_COMBINATIONS` 门禁 | V1 runner 主线 + 36 测试文件依赖；门禁本身符合"可保留 allowlist" |
| A1b 22 列缓存写入接口（`CacheStore.commit_dataset`）+ `domain/processing.py` 旧 ParsedDataset | 写入接口仍被生产 import_agent 调用；ParsedDataset 链挂 A1c |
| A1c `alignment.merge_datasets` 正式路径（**非死代码**，`stages/processing.py:630` 生产合并） | 删除=行为变更；`test_multisource_merge.py` 守卫 |
| A1d `run_research_pipeline` 旧参数面（9 参数全活） | agent 主线 + 12+ 测试 |

---

## 🟠 B. 产品/功能未完成（TODO 未勾选）

| ID | 级别 | 项 | 来源 |
| --- | --- | --- | --- |
| B1 | P0 | 新 Run 携带版本化 `TaskSpecification`（原 §1.6） | TODO:63 |
| B2 | P2 | 删除 `validated_intermediate`/`validated_final` 状态（ADR-010 否决，任务/会话改 `current_publication_id`） | TODO:71 |
| B3 | P2 | Agent INSTRUCTIONS 增加"达 max_turns 输出 `[MAX_TURNS_REACHED]`" | TODO:365 |
| B4 | P2 | UniProt / ChEMBL Agent-only 来源能力（不接入 Pipeline） | TODO:367 |
| B5 | P2 | §3.5 通用 UI：**command/menubar 跳过、对话路由延后**（缓存导出按钮已完成） | TODO:278 `[~]` |

---

## 🟡 C. 技术债 / forward seam（已评估，多为"接受"级）

### C1. publication 完整性（REVIEW phase4-bug-sweep §3，Important）
- **C1a A2**：发布先于终态可持久化——publication 提交与 run_completed 非同一事务，取消/崩溃窗口产生"已发布但 run 非成功"孤立产物 → 需 finalize 事务化重构
- **C1b A3**：reducer 不校验 run 状态即接受 `publication_created`（随 A2 设计）
- **C1c A4**：重启丢弃 pending HIL prompt（无 prompt-invalidated 事件）→ 需决策重启恢复或显式事件
- **C1d V2-validation_ref**：`validation_result_ref → validation_report.json` 未拷入 version 目录（发布引用闭包缺口）
- **C1e F7-03**：NO_DATA 信封 `user_summary`/`reason_codes` 因 `publication_id=None` 无法关联 → API 通用投影（phase7 §5）

### C2. 前端 artifact 归属与可见性
- **C2a C7**：NO_DATA banner/预览按 role 存在性推断归属（task 级聚合无法按 run/publication 过滤）→ 前端 store 引入 artifact 归属元数据（REVIEW phase4-bug-sweep §3）
- **C2b**：`corrections_todo.csv` 仍是任务工作目录文件、不进 `list_artifacts`（phase4c §5 遗留）→ 按 artifact role 纳入发布清单
- **C2c F7-06**：`list_artifacts` cache 路径首个坏条目 409 而非回退 legacy 面（phase7 §5）

### C3. cache/builds 一致性（REVIEW phase7 §5）
- **C3a F7-04**：content-addressed `artifact_id` 不含 path → 同字节双路径碰撞（修复方向：digest 含 `relative_path`）
- **C3b T1 residual**：V2 build 不发 `artifact_produced`（builds API 为 serving surface）；单 run 单 outcome slot
- **C3c T2 residual**：build-tool cache root（模块 `settings.output_dir`）与 API 配置 root 可能不一致
- **C3d R1C-04**：`list_artifacts` 每请求重哈希 artifact（O(bytes)，GB CSV 慢）→ 缓存已验证 digest
- **C3e R1C-05/R1S-03**：`useTaskBuildId` 只取 `/builds` 首页（limit 50）→ 超 50 条静默 legacy 回退

### C4. GEO / V1 seam（REVIEW phase5 §5）
- **C4a**：provider dispatcher（`geo.series/geo.platform` `resolve_provider` + `acquire_series_asset`）**零 production 消费者**（Phase 7 未接线）
- **C4b F5**：coverage<1.0 时 per-binding 排除未实现（整 build NO_DATA，与 wave-7 一致，接受）
- **C4c**：probe 覆盖阈值校准门槛（`probe_coverage_required_gene_level` 语义检查已交付，门槛校准留后续）

### C5. 运行时健壮性（review-loop 记录）
- **C5a R1C-02**：混合 run（V1+V2 工具）`take_pending()` 非 None 时 V2 outcome 不转移 → "V1 wins"，REVIEW 声称 "last build wins" 不符（doc 偏差，无数据丢失）
- **C5b R1C-03**：`_load_build_publication` 吞损坏 `publication.json` → 已发布 build 误报 NO_DATA（安全方向下报，磁盘损坏才触发）
- **C5c R1C-06**：`reduce_task_event` 对 terminal 后 run_id 事件抛"immutable"——replay 安全，晚到 operation 事件会崩（今日不可达，建议硬化）
- **C5d A6**：`_task_locks`/repository `_task_locks`/EventStore `_checkpoints` 强键字典永不清除（内存增长，Minor）
- **C5e A7**：`TaskIndex.list_tasks` active 列表不受 limit 约束（长会话 API 序列化无界，Minor）

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
