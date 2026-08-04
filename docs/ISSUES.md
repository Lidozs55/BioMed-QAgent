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

- [ ] `app/runtime/session.py:182-204` — 每个 task 的 `DurableTaskSession` 持有 `_replay_cache`，缓存该 task 完整对话历史的内存副本（`session_items.jsonl` 可达 50-500 MB）。`get_items()` 每次调用 `copy.deepcopy` 全量历史，压缩 preflight 每轮触发一次，临时把整个历史再复制一份。4 并发 task × (缓存原始 + 深拷贝) ≈ 0.4-4 GB。是周期性内存膨胀（~16GB）的核心来源之一。修复方向：`get_items` 返回迭代器或按需切片而非全量深拷贝；preflight 估算 token 时仅需要条目数量和摘要长度，不需完整 item 内容。

### 压缩流程多次全量深拷贝

- [ ] `app/runtime/compaction_execution.py:64-88` + `app/runtime/compaction_history.py:47-59,163-175` — 压缩 preflight 链路存在 5-6 处 `copy.deepcopy`：`get_items()` 深拷贝 #1 → `EffectiveSession.__init__` 深拷贝 #2 → `EffectiveSession.get_items` 深拷贝 #3 → `flatten`/`flatten_segments`/`flatten_groups` 深拷贝 #4-6。单次 preflight 临时占用 = 历史 × 3-4 倍深拷贝 ≈ 150-2000 MB 峰值。修复方向：压缩流程改为流式处理，仅在写出压缩后历史时做一次拷贝；`EffectiveSession` 持有引用而非深拷贝。

### TaskManager `_task_locks` 字典永不清理

- [ ] `app/runtime/manager.py:718` + `app/runtime/repository.py:134` — `_task_locks: dict[str, asyncio.Lock]` 每个 task ID 永久持有一个 `asyncio.Lock`，`setdefault` 创建后永不 `pop`。服务器运行数月处理数万个 task 后字典持续增长。更严重的是，若 `_finalize_run` 未执行（进程崩溃恢复后），`_running` 中的 `RunExecution`（含 `RunContext` 的 query_log/records/sources）会泄漏，每个 50-500 MB。修复方向：task 进入终态后从 `_task_locks` 移除；`_running` 在 task recovery 时清理残留 entry。

### RunContext 字段在 run 期间只追加不清理

- [ ] `app/agent_loop/context.py:148-156,690-734` — `RunContext` 的 `sources`、`raw_assets`、`parsed_datasets`、`records`、`query_log` 列表在整个 run 生命周期内只追加不清理。`compress_query_log` 能压缩 `query_log`，但仅当 LLM 主动调用 `compress_query_log` 工具时才触发（常见情况下不触发）。240-960 轮对话可累积数千条 query_log 记录。修复方向：query_log 超过阈值时自动触发压缩；或改为环形缓冲 + 溢出落盘。

### Pipeline `events` 列表在 run 期间无限增长

- [ ] `app/pipeline/runner.py:232,1226-1234` — `PipelineRunner.events: list[EventEnvelope]` 在整个 run 期间只追加不清理。`FixtureRunExecutor.__call__` 还会 `for event in list(runner.events)` 二次遍历。单个长 Pipeline run 产生数千事件，`stage_progress`/`assistant_delta` 等事件无截断。修复方向：事件写入 JSONL 后从内存列表移除；或改为 `collections.deque(maxlen=N)` 只保留最近事件供二次遍历。

### SubagentSupervisor 异常退出时字典泄漏

- [ ] `app/subagents/supervisor.py:115-127` — `_entries`、`_run_semaphores`、`_admissions`、`_owner_lifecycle_sinks` 字典在 `start_batch` 中 `setdefault` 创建，仅 `release_run` 清理。若 run 异常退出未触发 `_terminate_owned_subagents`，`_SubagentEntry`（含 `task: asyncio.Task`、`result: SubagentResult`）泄漏。修复方向：在 `manager.py` 的 `_finalize_run` 中无条件调用 `_terminate_owned_subagents`；或使用 `contextlib.ExitStack` 绑定 supervisor 生命周期到 run。
