# 已知问题追踪

> 仅保留未解决项；已修复项的根因与修复说明见 git 历史（commit message 含根因）。
> 标注"审查结论：暂缓"的条目为已评估、优先级极低或无需处理的项。

### 设置界面 skill 管理不可用

- [ ] 设置界面 skill 选项卡下无法正常调整 skill（用户 skill 引入、已引入 skill 的启停）。

### 模型上下文窗口显示固定为 0

- [ ] 所有模型的上下文窗口固定显示 0，失去参考价值。

### 对话窗口滚动不稳定（待验证）

- [ ] 模型进行思考工作时，如果窗口未跟随最新进度，可能跳转到最初对话条目。触发条件未查明。

### 按键响应异常（待验证）

- [ ] 点击界面深浅风格按键时，可能出现一次点击两次判定或未判定问题。其他按键也存在同样问题，一般在突然的快速点击时触发。

### 工作区右上角按钮缺少 tooltip

- [ ] 主界面工作区右上角三个 UI 按钮缺少 tooltip 说明。

### Xena S3 hub 返回 HTTP 403

- [ ] `search_xena` 通过 crawler facade 请求 `https://toil-xena-hub.s3.us-east-1.amazonaws.com/?list-type=2&prefix=download/` 返回 HTTP 403。可能是 S3 区域限制、UA 被拒或临时限流。影响：Agent 无法通过 Xena 发现 TCGA PAAD 等数据集。修复方向：调查 UA 是否被 S3 拒绝；考虑使用 browser_fallback 作为 Xena API 后备；若 S3 持续 403，考虑使用 Xena 的 HTTPS 网页接口替代 S3 REST API。

### DurableTaskSession `_replay_cache` 全量历史驻留 + 深拷贝放大

- [ ] `app/runtime/session.py:182-204` — 每个 task 的 `DurableTaskSession` 持有 `_replay_cache`，缓存该 task 完整对话历史的内存副本。`get_items()` 每次调用 `copy.deepcopy` 全量历史，压缩 preflight 每轮触发一次。
- **审查结论（2026-08-04）**：**暂缓**。`read_file` 256KB 守卫已从源头阻止 1.74 GB JSONL 写入，`session_items.jsonl` 典型大小回落到 5-50 MB/task。`_replay_cache` 是性能必要缓存（避免每轮重读 JSONL），不宜移除。`get_items` 的 `copy.deepcopy` 是防御性契约（允许调用方修改返回值不影响内部状态），移除需审计全部调用方——当前仅在压缩 preflight 路径调用，风险可控但收益有限（4 并发 × 50 MB × 2 ≈ 400 MB 峰值，非 16 GB 来源）。修复方向（低优先级）：`get_items` 增加只读模式参数跳过 deepcopy。

### 压缩流程多次全量深拷贝

- [ ] `app/runtime/compaction_execution.py:64-88` + `app/runtime/compaction_history.py:47-59,163-175` — 压缩 preflight 链路存在 5-6 处 `copy.deepcopy`。
- **审查结论（2026-08-04）**：**暂缓**。深拷贝是防御性的（SDK 可能修改 item 引用），移除有破坏 SDK 契约的风险。单次 preflight 峰值 = 历史 × 3-4 倍深拷贝，但是瞬态（preflight 完成后 GC 回收），且 `read_file` 守卫后历史已受限。修复方向（低优先级）：压缩流程改为流式处理，仅在写出压缩后历史时做一次拷贝；需先验证 SDK 不修改 `get_items` 返回值。

### TaskManager `_task_locks` 字典永不清理

- [ ] `app/runtime/manager.py:718` — `_task_locks: dict[str, asyncio.Lock]` 每个 task ID 永久持有一个 `asyncio.Lock`，`setdefault` 创建后永不 `pop`。
- **审查结论（2026-08-04）**：**暂缓**。每个 `asyncio.Lock` ≈ 128 字节，10,000 task ≈ 1.2 MB，可忽略。ISSUES.md 原文提到的 "`_running` 泄漏 `RunExecution` 50-500 MB" 是理论性的：`_finalize_run` 在 `_execute` 的 `finally` 中无条件执行（manager.py:1490-1491），`_running` 在 `retain_cancellation=False` 时必然 `pop`（manager.py:1755）。进程崩溃后 `_running` 是内存态、重启即空。修复方向（极低优先级）：task 进入终态后从 `_task_locks` 移除，但需确认无后续操作（如 `delete_task`）仍需该锁。

### RunContext 字段在 run 期间只追加不清理

- [ ] `app/agent_loop/context.py:148-156,690-734` — `RunContext` 的 `sources`、`raw_assets`、`parsed_datasets`、`records`、`query_log` 列表在整个 run 生命周期内只追加不清理。
- **审查结论（2026-08-04）**：**暂缓**。`RunContext` 生命周期 = 单次 run（`_prepare_execution` 创建，`_finalize_run` 后随 `RunExecution` 一起 GC）。单 run 内 `query_log` 每条 ≈ 100-200 字节，1,000 条 ≈ 100-200 KB，可忽略。`records` 取决于 `DataRecord` 内容，但同样随 run 结束而释放。修复方向（低优先级）：`query_log` 超过阈值时自动触发 `compress_log`，而非依赖 LLM 主动调用。

### Pipeline `events` 列表在 run 期间无限增长

- [ ] `app/pipeline/runner.py:232,1226-1234` — `PipelineRunner.events: list[EventEnvelope]` 在整个 run 期间只追加不清理。
- **审查结论（2026-08-04）**：**暂缓**。`PipelineRunner` 生命周期 = 单次 pipeline run（`FixtureRunExecutor.__call__` 创建，结束后 GC）。`FixtureRunExecutor` 在 `streams_events=True`（正常路径，runner.py:1402）时跳过 `list(runner.events)` 遍历（runner.py:1409-1411），仅在 legacy 非 streaming 路径才二次遍历。单 run 数千事件 ≈ 1-10 MB 瞬态。修复方向（低优先级）：streaming 路径下 `_publish_event` 后不追加 `self.events`，仅在 legacy 路径保留。

### SubagentSupervisor 异常退出时字典泄漏

- [ ] `app/subagents/supervisor.py:115-127` — `_entries`、`_run_semaphores`、`_admissions`、`_owner_lifecycle_sinks` 字典在 `start_batch` 中 `setdefault` 创建，仅 `release_run` 清理。
- **审查结论（2026-08-04）**：**暂缓**。清理路径已存在且被调用：`_terminate_owned_subagents`（manager.py:2032-2068）在 `_append_status` 和 `_append_completion_status` 中对 `RunCompleted/Failed/Cancelled/Interrupted` payload 无条件调用 `cancel_run` + `release_run`。`_finalize_run` 的 `finally` 保证 `_append_completion_status` 必然执行。泄漏仅在工作线程被强制取消且 `finally` 未跑完时发生——此时进程通常也在关闭（`shutdown` 会清理全部 entry）。修复方向（极低优先级）：在 `manager.close` 中增加 supervisor 兜底清理断言。

### Processing 阶段 `_CLEANING_MAX_ROWS = 500_000` 静默截断数据（治标）

- [ ] `app/pipeline/stages/processing.py:41,165-170` — 数据清洗阶段对 CSV 行数硬截断在 500,000 行，超出部分仅 `logger.warning` 后 `break`，不进入清洗产物。GSE183795（4,695,780 行）等大型表达谱矩阵会被截断到 500k 行，导致产物数据不完整。
- **根因**：`_clean_csv` 使用 `csv.DictReader` 全量加载行到 `all_rows: list[dict]`，4.7M 行 × 每行 dict 开销 → 内存溢出 + 超时。500k 截断是紧急止血，不是正确解。
- **影响**：Agent 对大型数据集的产物缺少后 4.2M 行数据，但不会报错——用户可能不知道数据被截断。
- **修复方向**：改为流式清洗（`csv.reader` 逐行处理 + 流式写出），不累积 `all_rows` 列表；或在截断时向 `RunContext.warnings` 追加用户可见警告，让 Agent 知晓数据不完整。
