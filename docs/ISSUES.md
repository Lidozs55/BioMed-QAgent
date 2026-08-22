# 已知问题追踪

> 仅保留未解决项；已修复项的根因与修复说明见 git 历史（commit message 含根因）。
> 标注"审查结论：暂缓"的条目为已评估、优先级极低或无需处理的项。
>
> **维护记录（2026-08-17）**：legacy Python Runtime（`backend/`）已于 Phase 8
> 物理删除，指向 `app/runtime/*`、`app/pipeline/*`、`app/subagents/*`、
> `app/agent_loop/*` 的条目一律失效，已关闭归档于文末「已关闭」小节。
> 当前开放问题仅剩前端交互两项。

## 开放问题

### 按键响应异常（待验证）

- [ ] 点击界面深浅风格按键时，可能出现一次点击两次判定或未判定问题。其他按键也存在同样问题，一般在突然的快速点击时触发。

### 工作区右上角按钮缺少 tooltip

- [ ] 主界面工作区右上角三个 UI 按钮缺少 tooltip 说明。
      **状态（2026-08-17）**：侧栏底部已简化（`fddf6911`，设置入口复用
      Sidebar 菜单原语）；右上角按钮现状需复验，若仍缺 tooltip 则补。

### 测试稳定性：`build-lock.test.ts` 全量跑偶发失败（自 LEFTOVERS 历史快照迁移）

- [ ] 2026-08-14 复现：`server/tests/phase5/build-lock.test.ts` 在 `pnpm test` / `vitest run` 并行负载下偶发失败（真实子进程对文件锁的时序竞争 + CPU 争抢），单文件隔离 8/8 通过；与 settings/http/contracts/artifacts 分层重构无关。根治方向：进程间同步闩或放宽时窗/重试（详见 `docs/archive/LEFTOVERS-2026-08-09.md` §K1）。

### Family Host M1 wire contract 安全阻塞（ADR-039 activation blocker）

- [ ] `packages/contracts/src/family-transform.ts` 与 `runtime/primitives.ts` 的
      `808279ac` 草案仍需关闭：prototype/accessor smuggling（parser 不得执行 getter）、
      sparse array、`NaN`/Infinity、unsafe integer、identity scheme 静默纠正、无界/不安全
      ID 与 receipt/digest closure。BuildSpec 2.0 还没有 proposal/resolved DTO 分离。
- **当前风险状态**：ADR-039 仍 Proposed，动态 transform 未接生产，所以不是已上线 P0；
  但在 adversarial contracts tests 与独立 Core re-admission 通过前，M1 不得标记 frozen，
  B/C 只能落 disabled fixture 或纯模块。
- **验收锚点**：`docs/TODO.md` A-T1/A-T3、`docs/plans/family-host/01-family-transform-contracts.md`、
  `10-consistency-review.md`；至少覆盖 `__proto__`、getter reads=0、dense array、finite/safe number、
  strict scheme/hash/time/cancel、known digest vector、1.0/2.0 hybrid rejection。

### Family Host 候选执行面需重做（不得原样合入）

- [ ] `3f1cfdd3`：publish 仍可走 generic checkpoint shortcut；production release identity 未在
      startup 闭合，dev fallback 跨重启不诚实，reuse/rehydrate 仍缺 output/sidecar/dependency/TOCTOU
      全闭包。最小门：publish shortcut 禁用 + honest release identity + typed receipted rehydrate。
- [ ] `64f43602`：Core transform admission 信任 caller/Host 自报上下文，且重哈希后没有原子复制到
      Core-owned immutable root；不得生成 `core_admitted` trust-bearing receipt。必须由 Core-owned
      expected invocation 对 task/build/generation/digest/input/output/resource/cancel 全量比对，再复制、
      fsync、重开重哈希；仍不得直接创建 Publication。
- [ ] `f261f6f6`：SQLite tuple index 未接 B3，TEXT key 会在 lone surrogate 上碰撞，quota/取消/cleanup
      不是 hard fail-closed，`entries().all()` 会回载全部 key。需 BLOB canonical encoding、poison-on-error、
      transaction quota、bounded query 与 memory/disk parity 后才能接 `multitable.ts`。
- [ ] `9778de1d`：caller 声明的 canonical digest/scope/resource/exact refs 被包装成 `admitted`，
      不能作为 semantic admission。只可缩减为不含 digest/trust/authorization 的 pure topology linter；
      完整 admission 等待 canonical digest 与 authoritative resolver receipts。
- [ ] `2566efd1`：仅可作为 all-platform `sandbox_unavailable` fixture；caller-provided emitted bundle /
      allowlist、source→bundle provenance、hardlink/symlink/junction/TOCTOU 和 opaque-handle ownership 未闭合。
      未有独立低权限 OS/container backend 前不得提升为 production sandbox。

### Expression dataset/revision identity 尚未接 authoritative Core path

- [ ] expression adapters 当前 V1 rows 仍使用 `buildId` 作为 `dataset_id`。候选 `1b3dca3b` 不能原样合入：
      它允许 caller 传可选 identity context，并在仍声明 `gene_expression.*.v1` schema 时增加
      `dataset_revision_id` 列。正确迁移需先定义显式 V2 schema/PK，再把 task-owned
      `SourceAssetRegistrationReceipt` 从 `DatasetCore` service 传给 TS Core，由 Core 从 frozen binding +
      registered source/mapping/metadata carrier closure 构造 context；缺事实 fail closed，V1 不静默扩列。

### 可选测试补强（自 LEFTOVERS 历史快照迁移，非阻塞）

- [ ] D1：`GET /builds/{id}` 损坏 manifest 仍返回 409 的测试 + 中间页损坏分页测试。
- [ ] D2：operation 事件顺序无关性测试 + 部分镜像 run 语义测试。
- [ ] D3：双读 API 对真实 `execute_dataset_build` 产物 e2e 断言；build_result 全量重启回放测试。
- [ ] D4：NO_DATA `非红` 改 `data-variant` 断言；`runId===null` reducer 测试。
- [ ] D5：`/cache/datasets?limit=` 页帽测试；hook 负向用例。

## 已关闭（历史留档）

> 2026-08-17 全量文档维护时按代码现状逐一复核并关闭；关闭原因见各条。

### 设置界面 skill 管理不可用

- [x] 设置界面 skill 选项卡下无法正常调整 skill（用户 skill 引入、已引入 skill 的启停）。
      **已关闭**：Phase 2 决策退役设置页「技能」分区与 Skill 运行时
      （`SkillCatalog` / `find_skill` / `invoke_skill` / 用户 Python 包上传），
      `.pi/skills` 为 curated 唯一来源；该 UI 面不再存在
      （[migration/phase2-skills-tools-migration.md](migration/phase2-skills-tools-migration.md)）。

### 模型上下文窗口显示固定为 0

- [x] 所有模型的上下文窗口固定显示 0，失去参考价值。
      **已关闭**：Phase 6 模型设置重构后，前端按模型导入的 `context_window`
      展示（`frontend/src/components/settings/sections/ModelSettingsSection.tsx`），
      不再固定为 0。

### 对话窗口滚动不稳定（待验证）

- [x] 模型进行思考工作时，如果窗口未跟随最新进度，可能跳转到最初对话条目。触发条件未查明。
      **已修复（2026-08-17）**：聊天流稳定性工作（移除滚动锚点、增量合并、
      replay 批量提交，`docs/archive/superpowers/plans/2026-08-17-chat-stream-stability.md`）
      已消除跳转与重复渲染。

### Xena S3 hub 返回 HTTP 403

- [x] `search_xena` 通过 crawler facade 请求 `https://toil-xena-hub.s3.us-east-1.amazonaws.com/?list-type=2&prefix=download/` 返回 HTTP 403（S3 桶策略拒绝）。
      **已修复（2026-08-08，见 docs/TODO.md 独立维护项）**：`search_xena` 改走官方 hub 查询 API
      `POST https://toil.xenahubs.net/data/`（xenaPython 同款查询），S3 XML 列表保留为兜底；
      `test_all_data_sources_live.py` xfail 移除，END-TO-END 实测返回 27 个 TCGA 数据集。

### DurableTaskSession `_replay_cache` 全量历史驻留 + 深拷贝放大

- [x] `app/runtime/session.py:182-204` — 每个 task 的 `DurableTaskSession` 持有 `_replay_cache`，缓存该 task 完整对话历史的内存副本。`get_items()` 每次调用 `copy.deepcopy` 全量历史，压缩 preflight 每轮触发一次。
      **已关闭（2026-08-17）**：`app/runtime/` 已随 Phase 8 物理删除；TS 侧
      durable runtime 以 append-only `events.jsonl` + 纯 reducer 重建，无该形态的
      `_replay_cache` 深拷贝问题。

### 压缩流程多次全量深拷贝

- [x] `app/runtime/compaction_execution.py:64-88` + `app/runtime/compaction_history.py:47-59,163-175` — 压缩 preflight 链路存在 5-6 处 `copy.deepcopy`。
      **已关闭（2026-08-17）**：legacy Python 压缩链路已随 Phase 8 删除。

### TaskManager `_task_locks` 字典永不清理

- [x] `app/runtime/manager.py:718` — `_task_locks: dict[str, asyncio.Lock]` 每个 task ID 永久持有一个 `asyncio.Lock`，`setdefault` 创建后永不 `pop`。
      **已关闭（2026-08-17）**：legacy Python TaskManager 已删除；TS 侧
      TaskRepository 事件溯源，无该内存态锁表。

### RunContext 字段在 run 期间只追加不清理

- [x] `app/agent_loop/context.py:148-156,690-734` — `RunContext` 的 `sources`、`raw_assets`、`parsed_datasets`、`records`、`query_log` 列表在整个 run 生命周期内只追加不清理。
      **已关闭（2026-08-17）**：legacy Python Agent loop 已删除。

### Pipeline `events` 列表在 run 期间无限增长

- [x] `app/pipeline/runner.py:232,1226-1234` — `PipelineRunner.events: list[EventEnvelope]` 在整个 run 期间只追加不清理。
      **已关闭（2026-08-17）**：legacy Python Pipeline 已删除；TS Dataset Core
      事件经 event sink 直写 durable 流，无进程内累积列表。

### SubagentSupervisor 异常退出时字典泄漏

- [x] `app/subagents/supervisor.py:115-127` — `_entries`、`_run_semaphores`、`_admissions`、`_owner_lifecycle_sinks` 字典在 `start_batch` 中 `setdefault` 创建，仅 `release_run` 清理。
      **已关闭（2026-08-17）**：legacy Python subagents 已删除（Phase 8）。

### Processing 阶段 `_CLEANING_MAX_ROWS` 硬截断数据（治标）

- [x] `app/pipeline/stages/processing.py:41,59-62,165-170` — 数据清洗阶段对 CSV 行数硬截断。
      **已关闭（2026-08-17）**：legacy Python 清洗阶段已删除；TS canonicalizer /
      integrator 已改为流式（生成器式 `delimitedRowsFromFileAsync` +
      按 processed 行数协作式 checkpoint，见 TASK-047 状态），无全量载入截断形态。

### `search_geo` 对个别 GSE 记录 `n_samples=""` 崩溃

- [x] **已修复（2026-08-10，见 docs/REVIEW_2026-08-10-task-9ce0124f.md §5.1 T1）**：`app/integrations/ncbi/parsers.py:153` — `sample_count=int(item.get("n_samples", len(samples)))`：NCBI esummary 对个别 GSE 返回 `n_samples` 为空字符串时 `int("")` 抛 `ValueError`，整个 esummary batch 解析失败，`search_geo` 向 Agent 返回 `error: invalid literal for int() with base 10: ''`，触发无效换词重试。
- **根因**：对 esummary 字段做了无守卫的 `int()` 转换。
- **修复**：新增 `_safe_int()`（空/非数字回退 `len(samples)`），单条记录失败不拖垮整批；新增回归测试 `test_parse_geo_esummary_tolerates_empty_n_samples`。

### GEO series matrix 元数据-only 无内容预检（fail-fast 缺失）

- [x] **已修复（2026-08-10，见 docs/REVIEW_2026-08-10-task-9ce0124f.md §5.1 T2）**：`app/skills/builtin/acquisition/geo.py` `download_geo_adapter` / `_resolve_download` — 下载 matrix 类型只校验 HTTP/大小/哈希，不校验 gzip 内容是否含 `!series_matrix_table_begin`。NCBI 对 RNA-seq（2021 起）及部分阵列系列只生成"元数据头"矩阵文件（实测 GSE173954/GSE327021/GSE266328/GSE160389 全部如此），下载被报告为"成功"，数据问题推迟到 build parse 阶段才以 `no_primary_data` 暴露。
- **根因**：下载成功 ≠ 数据表存在，内容级校验缺失。
- **修复**：`download_geo_adapter` 对 `matrix` 类型下载后解压头部校验 `!series_matrix_table_begin`，缺失时返回结构化 `reason_code: empty_series_matrix` 并提示改用 `file_type='soft'/'suppl'`，且不登记为可用 source asset；`read_file_head` 支持 .gz 解压；`unsupported file_type` 错误信息列出合法值；系统提示补多 binding 兜底 + supplementary 路径。新增回归测试 `test_download_geo_matrix_fails_fast_on_metadata_only_gzip`、`test_download_geo_unsupported_file_type_lists_valid_values`、`test_read_file_head_decompresses_gzip`。

### 后端测试在 Windows 上的 3 个环境性失败（非本次改动引入）

- [x] `tests/test_config.py::test_output_dir_default_is_absolute` — 期望 `Settings.output_dir` 是绝对路径，但 Windows 下 `Path('data/output')` 相对路径断言为 False。
- [x] `tests/api/test_artifact_api.py::test_legacy_loaded_none_downloads_corrections_todo` / `test_legacy_normal_branch_lists_and_downloads_corrections_todo` — 断言失败，疑似 Windows 路径/编码差异。
      **已关闭（2026-08-17）**：`backend/` 测试已随 Phase 8 物理删除，
      `database/tests/` 在 Windows 全绿。