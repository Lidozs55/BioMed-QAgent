# 流水线调度详细调用流程（函数级追踪）

> 本文档记录从 API 端点到 Agent 执行的完整函数级调用链，用于定位调度层 bug。
> 生成日期：2026-07-09

---

## 一、入口层：API → Orchestrator

### 1.1 创建任务
```
POST /api/v1/tasks
  → routes/tasks.py: create_task(payload: TaskCreate)
    → store.create_task(research_goal, ...)
    → return task.to_summary()
```

### 1.2 启动任务
```
POST /api/v1/tasks/{task_id}/start
  → routes/tasks.py: start_task(task_id, from_stage=None)
    → store.get_task(task_id)
    → _get_orchestrator()  # 全局单例
    → loop.create_task(_run())  # 异步后台执行
      → _run():
        → progress_cb(msg): asyncio.ensure_future(broadcast(task_id, msg))
        → orchestrator.run(task, progress=progress_cb)  # 或 run_resume
        → except: store.update_task(task); broadcast(error)
        → finally: _running_tasks.pop(task_id)
    → return {status: "started"}
```

### 1.3 人工确认
```
POST /api/v1/tasks/{task_id}/confirm
  → routes/tasks.py: confirm_task(task_id, body: ConfirmRequest)
    → body.decision == "approve":
      → orchestrator.run_export(task, progress=progress_cb)
    → body.decision == "reject":
      → orchestrator.run_resume(task, from_stage, progress=progress_cb)
```

---

## 二、Orchestrator.run() — 多轮迭代主循环

文件：`backend/app/agents/orchestrator.py`

### 2.1 主流程
```
Orchestrator.run(task, progress):
  1. task.status = PLANNING
  2. _emit(progress, type="task_start")  → WS 广播
  3. context = await _stage_planning(task, progress)  # LLM 实体识别
  4. context["max_rounds"] = MAX_ROUNDS  # = 3

  5. all_records: list[dict] = []
     seen_ids: set[str] = set()
     round_new_counts: list[int] = []

  6. for round_idx in range(1, MAX_ROUNDS + 1):  # 1, 2, 3
       a. context["round_idx"] = round_idx
       b. _emit(progress, type="iteration_round", round=round_idx, max_rounds=3)  → WS 广播 ★
       c. round_records, context = await _run_pipeline_round(task, context, progress, round_idx)
       d. new_records = _dedup_round(round_records, seen_ids)
       e. all_records.extend(new_records)
       f. round_new_counts.append(len(new_records))
       g. if round_idx >= MAX_ROUNDS: break
       h. IterationDecisionAgent.execute(task, all_records, context, progress)
          → context["iteration_decision"] = {should_continue, reason, next_round_queries}
       i. if not should_continue: break
       j. context["search_queries"] = next_round_queries

  7. if _needs_confirmation(task, all_records, review):
       task.status = AWAITING_CONFIRMATION
       store.set_records(task_id, all_records)
       store.save_task_to_file(task_id)
       _emit(progress, type="awaiting_confirmation", payload=payload)
       return task  # 暂停，等用户 confirm

  8. await _stage_export(task, all_records, context, review, progress)
  9. task.status = COMPLETED
     task.total_records = len(all_records)  # ★ 只在此处设置
     store.save_task_to_file(task_id)
     _emit(progress, type="task_complete", summary=task.to_summary())
```

### 2.2 关键发现：total_records 设置时机
- `task.total_records` **只在任务完成时**（run line 159 / run_export line 364）设置
- 任务运行中 `task.total_records` 始终为 0
- 前端 `PipelineStatus.tsx` line 69 显示 `task.total_records`，运行中始终为 0
- **这就是"总记录数=0"bug 的根因**

### 2.3 关键发现：iteration_round 事件可靠性
- 每轮开始时发送 `iteration_round` 事件（run line 90-91）
- 前端 `taskStore.handleWSMessage` 正确处理该事件（taskStore.ts line 139-148）
- **但如果 WS 连接断开重连**，重连后只收到 `snapshot` 消息，不包含 `round_idx`
- `roundIdx` 不会被更新，保持上一次的值
- **这就是"轮次不更新"bug 的根因**

---

## 三、_run_pipeline_round() — 单轮流水线

```
_run_pipeline_round(task, context, progress, round_idx):
  records: list[dict] = []  # 每轮从空开始
  stage_retries: dict[str, int] = {}

  for stage_name in PIPELINE:  # ("search","acquire","parse","clean","analyze","review")
    if stage_name == "analyze" and not task.enable_analysis: continue

    agent = _get_agent(stage_name)  # AgentRegistry.get(name, llm, tools, store)

    records, context, decision = await _execute_stage_with_error_handling(
        task, stage_name, agent, records, context, progress,
        stage_retries, round_idx)

    # decision: None=成功 | skip_stage | escalate | fail
    if decision == "fail": raise RuntimeError(...)
    # else continue

  return records, context
```

### 3.1 _execute_stage_with_error_handling()
```
_execute_stage_with_error_handling(task, stage_name, agent, records, context, progress, ...):
  max_retries_per_stage = 2
  while True:
    try:
      records, context = await agent.execute(task, records, context, progress)
      return records, context, None  # 成功
    except Exception as e:
      decision = ErrorDecisionAgent.decide(task, stage_name, e, records, ...)
      action = decision.get("action", "fail")
      if action == "retry": continue (with exponential backoff)
      if action == "skip_stage": return records, context, "skip_stage"
      if action == "escalate": return records, context, "escalate"
      if action == "fail": return records, context, "fail"
```

---

## 四、各阶段 Agent execute() 签名与 records 传递

所有 Agent 继承 BaseAgent，统一签名：
```python
async def execute(self, task: Task, records: list[dict], context: dict,
                  progress: ProgressCallback | None) -> tuple[list[dict], dict]
```

### 4.1 SearchAgent (search.py)
- 输入：`records=[]`（每轮从空开始）
- 逻辑：多查询并行检索 + 引用追溯 + Darwinian fallback
- 输出：`return all_records, context`（all_records 可能达数百条）
- `_set_stage(records_count=len(all_records))` ✓

### 4.2 AcquireAgent (acquire.py)
- 输入：`records`（来自 search 的返回值）
- 逻辑：检查 `context["crawl_targets"]`，无则直接返回
- 输出：`return records, context`（原样传递）
- `_set_stage(records_count=len(records))` ✓

### 4.3 ParserAgent (parser.py)
- 输入：`records`（来自 acquire）
- 逻辑：PDF 解析 + 爬虫 LLM 提取 + 图表 Qwen-VL + 生物数据解析
- 输出：`records.extend(parsed_records); return records, context`
- `_set_stage(records_count=len(records))` ✓

### 4.4 CleanerAgent (cleaner.py)
- 输入：`records`（来自 parse）
- 逻辑：字段对齐 + 单位归一化 + 去重
- 输出：`return cleaned, context`（`store.set_records(task_id, cleaned)`）
- `_set_stage(records_count=len(cleaned))` ✓

### 4.5 AnalysisAgent (analysis.py)
- 输入：`records`（来自 clean）
- 逻辑：PPI/富集/药物靶点/Hub基因/上游调控/差异表达
- 输出：`return records, context`（原样传递，分析结果存 context["analysis"]）
- `_set_stage(records_count=len(records))` ✓（已修复）

### 4.6 ReviewerAgent (reviewer.py)
- 输入：`records`（来自 analyze）
- 逻辑：LLM 审查数据质量
- 输出：`return records, context`（原样传递，审查结果存 context["review"]）
- `_set_stage(records_count=len(records))` ✓（已修复）

---

## 五、前端显示层

### 5.1 总记录数显示
```
PipelineStatus.tsx:
  line 69: <Statistic title="总记录数" value={task.total_records} />
  ↑ task 来自 useTaskStore().selectedTask
  ↑ selectedTask 在 stage_complete 时通过 api.getTask() 刷新
  ↑ 但 task.total_records 运行中始终为 0（只在完成时设置）
```

### 5.2 轮次显示
```
PipelineStatus.tsx:
  line 57: const { roundIdx, maxRounds } = useTaskStore()
  line 150-161: {roundIdx > 0 && `第 ${roundIdx}/${maxRounds} 轮`}

taskStore.ts:
  line 139-148: if (msg.type === 'iteration_round') set({ roundIdx: msg.round })
  ↑ 依赖 WS iteration_round 事件
  ↑ WS 断开重连后不收 iteration_round，roundIdx 不更新
  ↑ snapshot 消息不含 round_idx，无法恢复
```

### 5.3 WS 连接与重连
```
useTaskWebSocket.ts:
  ws.onclose → 3 秒后自动重连
  重连后收到 snapshot 消息（ws.py line 87-93）
  snapshot: { type, task_id, status, stages, total_records }
  ↑ 不含 round_idx → 重连后轮次丢失
```

---

## 六、Bug 根因与修复方案

### Bug 1: 总记录数=0
**根因**：`task.total_records` 只在任务完成时设置（orchestrator.py line 159/364），运行中为 0。

**修复**：在每轮完成时（orchestrator.py run() line 99-102 附近）更新：
```python
task.total_records = len(all_records)
self.store.update_task(task)
```
这样前端在 `stage_complete` 刷新 `selectedTask` 时能获取到最新的 `total_records`。

### Bug 2: 轮次不更新
**根因**：轮次依赖 WS `iteration_round` 事件，WS 重连后该事件丢失，`roundIdx` 不更新。

**修复**：在 Task 模型添加 `current_round` 字段，orchestrator 每轮开始时更新：
```python
# Task 模型
current_round: int = 0

# orchestrator run()
task.current_round = round_idx
self.store.update_task(task)

# ws.py snapshot
"current_round": task.current_round

# to_summary()
"current_round": self.current_round

# 前端 PipelineStatus.tsx
const roundIdx = task.current_round || useTaskStore().roundIdx
```
这样不依赖 WS 事件可靠性，重连后也能恢复轮次。

---

## 七、完整事件序列（正常运行时）

```
task_start
iteration_round(round=1)
  stage_start(planning)
  stage_complete(planning)
  stage_start(search) → stage_progress(...) → stage_complete(search)
  stage_start(acquire) → stage_complete(acquire)
  stage_start(parse) → stage_progress(...) → stage_complete(parse)
  stage_start(clean) → stage_progress(...) → stage_complete(clean)
  stage_start(analyze) → stage_progress(...) → stage_complete(analyze)
  stage_start(review) → stage_complete(review)
  stage_gate_evaluation(round=1)
  iteration_decision(round=1, should_continue=true)
iteration_round(round=2)
  stage_start(search) → ... → stage_complete(review)
  iteration_decision(round=2, should_continue=false)
iteration_converged(round=2, reason="...")
stage_start(export) → stage_progress(...) → stage_complete(export)
task_complete(summary=...)
```
