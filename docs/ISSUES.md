# 已知问题追踪

### Agent `read_file` 读取超大文件 → 磁盘/内存膨胀（已修复）

- [x] 根因：`read_file` 无大小守卫，Agent 对 parsed/ 下 GB 级长表（如 GSE183795 `*_series_matrix_long.csv`，244 样本 × 19,246 探针 ≈ 470 万行）直接 `read_text` 全文读取，全文进入工具返回值并作为 `function_call_output` 原样写入 `session_items.jsonl`（单行 1.74 GB）。单任务日志可膨胀至 3+ GB。
- [x] 修复（2026-08-04）：`read_file` 增加 256KB 守卫（拒绝并引导替代工具）；新增流式工具 `read_file_head`（读前 N 行看表头/结构）与 `search_file`（grep 式按关键词定位行，流式扫描不加载全文），已注册到主 Agent + Import Agent；配套 14 项测试。已清理受影响任务目录（释放 ~4.1 GB）。

### 设置界面 skill 管理不可用

- [ ] 设置界面 skill 选项卡下无法正常调整 skill（用户 skill 引入、已引入 skill 的启停）。

### 模型上下文窗口显示固定为 0

- [ ] 所有模型的上下文窗口固定显示 0，失去参考价值。

### 对话红色标识逻辑不合理

- [ ] 模型记录部分将对话左侧标注为红色"问题对话"标识，但判断逻辑存在不合理：未生成产物并不代表模型未完成工作。当给出综述性问题时（如"请帮我研究有哪些蛋白可能诱发糖尿病"），模型判断无需给出结构化产物，此时对话仍被标注为红色。

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

### `read_file` 256KB 硬上限过于激进（已调整）

- [x] `app/tools/io.py:84` — `read_file` 原先 256KB 硬上限是在 `parsed/` 下 1.74 GB JSONL 导致 LLM API 400 错误时紧急加入的。现已提供 `read_file_head`（流式读前 N 行）和 `search_file`（grep 式检索）作为大文件专用工具，256KB 硬拒过于激进——Agent 无法读取 500KB-2MB 的中等文件（JSON 配置、小型 CSV）。
- **修复（2026-08-04）**：上限提升至 1 MB（`_READ_FILE_MAX_BYTES = 1024 * 1024`），覆盖大多数中等文件；超过 1 MB 仍硬拒并引导到 `read_file_head`/`search_file`。1 MB ≈ 250k tokens，在大多数模型上下文窗口内。

### `@cache` → `@lru_cache` 修复诊断修正

- [x] `app/runtime/compaction_history.py:129` — 先前将 `@cache` 改为 `@lru_cache(maxsize=4096)` 时，ISSUES.md 诊断"跨 task 累积缓存条目导致内存增长"是**误诊**。`mapping_count` 是定义在 `align_groups_to_records` 内部的嵌套函数，每次调用 `align_groups_to_records` 会创建新的函数对象 + 新的 cache，调用结束后随函数对象一起 GC。原 `@cache` 不会跨 task 累积。`@lru_cache(maxsize=4096)` 的实际作用是限制单次调用内的缓存上限（防止极端 case 如 1000 groups × 1000 records = 1M 条目），是合理的安全优化但非内存泄漏修复。
