# REVIEW — Phase 4c HIL `request_human_correction`（Agent 层工具 + 超时退化）

日期：2026-08-07
分支：`feat/phase4c-hil-correction`（T1 `6e9881e` → T2 `4c95f75` → T3 `e3bbb2e` → T4 `fe9a930`+`9ce4ca0` → T5 本文）
结论：**TODO Phase 4 的 P2（HIL）全部落地并有测试**。T1–T5 实现完毕，T5 全量验证通过
（后端 2298 passed、前端 656 passed、冒烟 ok、ruff 全量门零告警）。
规格：`docs/archive/superpowers/specs/2026-08-07-phase4c-hil-correction-design.md`（25932d5）。
关键约束落实：**HIL 为 Agent 层工具；pipeline 内自动 HIL 维持否决**（`pipeline/runner.py`
的 `data_correction` 仅保留在 union 中，无人发射——未改动）。

## 1. 交付内容

对应 `docs/TODO.md` Phase 4 P2 与 Design §1.7（原 §1.7 语义 + 4c 规格 §1 验收）：

| spec 目标 | 交付 | 对应任务 |
| --- | --- | --- |
| 主 run input broker（工具 → execution 通道） | `RunContext.main_input_broker` + `request_main_input()`；runner 每 run 安装；fixture 模式立即合成 approve（`fixture_exempt=True`，永不阻塞）；live 模式 deadline 等待；cancel 抛 `CompactionCancelledError`；subagent 上下文显式报错 | T1 |
| `request_human_correction` FunctionTool | `agent.py` 主工具区注册（`run_research_pipeline` 之后）；调 broker；返回人类答复文本（approve/reject + correction）、超时降级消息、缺 broker 明确失败文本；描述引导调用纪律 | T2 |
| 超时退化 `corrections_todo.csv` | 超时原子追加一行（`request_id, requested_at, expires_at, summary, detail_json, status=timed_out`，utf-8-sig + `csv.DictWriter` 匹配管线约定）；跨 run 累积；resume 到达不写；写失败降级不崩溃（T5 补 `artifacts_dir=None` warning） | T3（+T5） |
| 前端 `data_correction` 分支 | `UserInputDialog` 专用弹窗（修正 textarea + 提交修正/跳过并继续 + 只读 detail + expires_at 提示）；`promptKey` 含 `promptKind`（T4 复评修复）；T5 去重 summary 渲染 + fixtureExempt 文案按 prompt 种类区分 | T4（+T5） |
| 端到端 + 文档 | 后端真实 agent turn E2E（修正影响最终结果）；前端真实 transport/reducer/controller 全链 E2E；REVIEW 文档；TODO 勾选 | T5 |

测试：后端覆盖于 `tests/agent_loop/test_main_input_broker.py`（18，含 3 个 manager 级 E2E）、
`tests/agent_loop/test_request_human_correction_tool.py`（9）、`test_agent_build.py`（tools 列表 pin）；
前端 `tests/` 覆盖 `hil-data-correction-e2e.test.tsx`（新）、`user-input-dialog.test.tsx`（14）。
全量门见 §4。

## 2. 实现事实

### 2.1 T1 主 run input broker（commit 6e9881e）

- 新模块 `app/agent_loop/main_input_broker.py`：`MainInputBroker`（每 run 安装，request-id
  counter 每 run 重置）+ `MainInputDecision`（`request_id/summary/detail/requested_at/expires_at/
  timeout_seconds/timed_out/resumed/corrections_path`）。镜像 `_await_max_turns_resume` 的
  submitter + `asyncio.Event` 通道，但带 deadline；`request_id = data_correction-{run_id}-{n}`。
- `app/agent_loop/context.py`：`RunContext._main_input_broker`（init=False）+ `bind_main_input_broker`
  （exactly-once）+ `request_main_input()`；broker 未安装时 raise 明确 RuntimeError（子代理上下文）。
- `app/agent_loop/runner.py`：`_bind_main_input_broker` 在 `_bind_subagent_runtime` 后安装。
- fixture：立即合成 approve（`fixture_exempt=True` + `fixture_note`），不安装 submitter、不等待。
- 超时：发射合成 auto-approved resume（`auto_approve_reason="data_correction_timeout"`，镜像
  plan-confirmation 超时约定 REVIEW 2026-08-05 §3.3）——reducer 禁止从 `AWAITING_USER_INPUT`
  直接 FINALIZING，合成 resume 让 Run 可离开暂停。
- 测试（9）：无 broker 报错、委托、fixture 不阻塞、live resume roundtrip、timeout 降级不 raise、
  paused 取消抛错、request-id 递增、runner 安装、manager 级 pause→resume→COMPLETED E2E。

### 2.2 T2 `request_human_correction` 工具（commit 4c95f75）

- 新模块 `app/agent_loop/request_human_correction.py`：`@function_tool(name_override=...,
  strict_mode=False)`（dict 参数沿用 `invoke_skill`/`delegate_research` 约定）；签名
  `summary: str`、`detail: dict | None`、`timeout_seconds: float | None`。
- 返回文本：approve+correction → `用户已确认：<correction>`；reject+correction →
  `用户已拒绝并继续：<correction>`；无 correction → verb + 其余 detail JSON dump（不丢人类答复）；
  超时 → 降级消息（含 `corrections_path`，T3 类型化接入）；缺 broker → 明确失败文本（不 raise 进 SDK）；
  paused 取消 → re-raise `CompactionCancelledError`（不被 RuntimeError 兜底吞掉）。
- `app/agent_loop/agent.py`：注册到主工具区（`run_research_pipeline` 之后、文件工具之前）；
  INSTRUCTIONS 直接工具节枚举该工具（保持"每个直接 FunctionTool 都枚举"原则）。
- 测试（9 + tools 列表 pin）：approve/reject/no-correction/empty-detail/timeout/缺 broker/
  注册与 schema/序列化、fixture 合成模式。

### 2.3 T3 corrections_todo.csv 超时退化（commit e3bbb2e）

- `MainInputDecision.corrections_path: Path | None`（类型化，替代 T2 的 `getattr` 缝）；
  `MainInputBroker(artifacts_dir=...)`；超时路径先写文件、再发射合成 resume、再返回降级决策。
- `_write_corrections_todo`：先读历史行（append 语义、跨 run 累积）→ 追加新行 → 临时文件 +
  `os.replace` 原子替换 → utf-8-sig BOM；失败（OSError/csv.Error/TypeError/ValueError）warning +
  返回 `None`，Run 永不崩溃。
- `runner._bind_main_input_broker` 传 `context.work_dir.artifacts`。
- 测试（6 + 改写 1）：落盘字段/原子性、同 run 多次追加、跨 run 历史保留、resume 不写、
  写失败优雅降级、manager 级 timeout E2E（`AWAITING_USER_INPUT` → 合成 resume → `RUNNING` →
  `COMPLETED` + csv 落盘 + 降级消息经工具输出）。

### 2.4 T4 前端 data_correction 分支（commit fe9a930 → 9ce4ca0）

- `frontend/src/components/UserInputDialog.tsx`：标题 `需要人工修正`；专用卡片（summary 突出 +
  `renderDetailValue` 只读 detail + 受控 Textarea + expires_at 静态提示）；`提交修正` →
  `submit("approve", {correction})`（空输入禁用）、`跳过并继续` → `submit("reject", {correction: ""})`；
  `submit(decision, detail={})` 默认参数使既有分支 resume 载荷字节级不变。
- **T4 复评 MUST-FIX（9ce4ca0）**：`promptKey` 加入 `promptKind`
  （`taskId:runId:requestId:promptKind`）——同 task/run/request id 下 prompt 种类切换不再泄漏
  上次输入的修正文本；重置 effect 与 in-flight 提交匹配共用同一 identity。回归测试先红后绿。
- 测试（4 + 2 回归 + 既有全绿）：渲染、空输入校验、approve/reject 载荷、expires_at 提示、
  cross-kind 文本重置、新 request-id 重置。

### 2.5 T5 端到端 + 收尾（本次 commit）

- **后端真实 agent turn E2E（T4 复评残余，核心交付）**
  `test_agent_loop_data_correction_influences_outcome_e2e`：新增 `_CorrectionAwareModel`——第二轮
  从**真实 SDK 会话历史**（`stream_response` 收到的 `function_call_output` 项）提取
  `detail.correction` 并写入最终消息（`使用 GPL570 继续分析`）。修正值只能经真实 agent 循环到达
  模型（工具暂停 → `manager.resume_run` → broker 返回决策 → 工具输出进会话 → 下一轮模型看到），
  证明**人工修正影响了最终结果**，而非仅被工具返回。断言：`AWAITING_USER_INPUT` → resume →
  COMPLETED；最终助手消息含 GPL570；工具输出事件含决策；无 RunFailed。变异校验：提取逻辑
  找不到修正时测试红（harness 诚实）。
- **后端收尾（T3 review 可选两项）**：
  - `artifacts_dir=None` 时 `_write_corrections_todo` 记录 warning（`test_corrections_todo_without_
    artifacts_dir_warns_and_degrades`，先红后绿）；
  - CSV 转义 pin：summary/detail 携带逗号/换行/双引号时逐字节无损往返
    （`test_corrections_todo_csv_escapes_comma_newline_quotes`）。
- **前端真实路径 E2E（新文件 `hil-data-correction-e2e.test.tsx`）**：真实
  `AgentEventTransport`（envelope 校验、subscribe 命令、applyEvent 分发——仅 socket 伪造）
  + 真实 store reducer + 真实 `RuntimeController.resumeRun` + **渲染的 UserInputDialog**：
  live `user_input_required(data_correction)` → 弹窗打开 → 输入修正 → 提交 → resume API 载荷
  精确断言 → `user_input_resumed` + `run_completed` 经 socket 到达 → 弹窗关闭、Run COMPLETED。
  该测试在开发中真实暴露了 summary 重复渲染问题（getMultipleElementsFoundError）并驱动修复。
- **前端收尾（T4 review 可选两项，均落地）**：
  - summary 去重：`data_correction` 的 `DialogDescription` 不再重复 summary（卡片突出展示；
    其他分支描述字节级不变）；测试改为断言恰 1 次（`toHaveLength(1)` pin）。
  - fixtureExempt Alert 文案按 prompt 种类区分：`data_correction` →
    "当前为固定验收模式，仅供查看修正请求，提交修正仅触发流程继续。"；其他分支保留原计划文案。
  - cross-kind 过期提交测试（T4 复评运行时孪生）：同 task/run/request id 下
    `data_correction` → `no_progress` 切换后，旧 onResumeRun 拒绝的错误不得出现在新 prompt。
    变异校验：`promptKey` 去掉 `promptKind`（T4 bug）时测试红。

## 3. 与规格的偏差

1. **fixtureExempt Alert 文案 polish（T4 review 可选，T5 落地）**：原共享文案
   （"仅供查看计划，确认按钮仅触发流程继续"）对 `data_correction` 不准确；现按 `promptKind`
   区分：`data_correction` 用修正语义文案，其余分支（plan_confirmation/max_turns/no_progress）
   保留原文案不变。实践中 fixture broker 立即合成答复，弹窗几乎不可见，该分支为防御性准确。
2. **summary 渲染去重（T4 review 可选，T5 落地）**：`data_correction` 的 summary 原先
   在 `DialogDescription` 与卡片各渲染一次；现描述改为分支提示语（"Agent 在研究中请求人工修正，
   请在下方输入你的修正并提交。"），卡片保留突出展示。其他分支描述字节级不变（回归测试 pin）。
3. **`corrections_todo.csv` 不进 publication manifest（规格 §3-D3 已知限制）**：Agent 侧文件以
   任务工作目录文件存在（`<task>/artifacts/corrections_todo.csv`），**不进** `list_artifacts` /
   发布链（发布为 deterministic pipeline 独占，4a/4b 架构）。完整 manifest-driven 产物迁移属
   Phase 7（见 §5）。
4. **timeout/resume 竞态仲裁（最终复评 FIX 2 + 终波修正，确定性替代原接受窗口）**：broker 在请求
   入口捕获**单一不可变 monotonic deadline**，与 submitter 和等待循环共享同一个过期边界；
   submitter 在 `loop.time() > deadline` 或请求已声明超时（claimed-timed-out）时拒绝提交。
   `asyncio.wait` 返回后**重检赢家**：若已有被接受的提交（`decision_holder` 非空——submitter
   同步追加、先于事件置位，故持有人集合在 wait 返回后即为权威），该提交**必胜**——发射其
   resumed 事件，**不写** `corrections_todo.csv`、不发射合成 resume；仅当**没有**任何被接受的
   提交时才宣告超时——写待办行 + 发射合成 resume。claimed 标记仅在确认超时路径同步置位
   （重检与置位之间无 await，被接受决策不可能丢失）；submitter 仅在赢家确定**且** resumed
   事件发射后才清理（原实现先清 submitter 再发射）。由此确立的赢家规则：**accepted ⇒ 人类赢**
   ——即使 wait 在 deadline 同 tick 以空 done 集返回超时，恰在 `loop.time() <= deadline` 被
   接受的提交也绝不丢弃；**unaccepted timeout ⇒ 合成**——被拒绝/迟到的提交绝不产生人类路径
   resumed 事件；边界竞争解析为**恰好一个赢家**（无双重 resume 事件、无丢失决策）。
   `resume_run` 对迟到提交返回拒绝（submitter 已清 / Run 已离开 `AWAITING_USER_INPUT`），
   前端按 API 错误处理——既有模式保留。测试：`test_late_resume_after_deadline_is_rejected_and_timeout_wins`
   （时钟拨快 + claimed 标记双路径）、`test_resume_before_deadline_wins_and_no_synthetic_resume`、
   `test_resume_racing_timeout_resolves_to_single_deterministic_winner`（20 轮竞态不变量）、
   `test_submission_accepted_exactly_at_deadline_wins_over_timeout`（确定性边界复现：wait 返回
   超时 + 已接受提交 ⇒ 人类赢，无 CSV 行、无合成 resume）。
5. **max_turns/no_progress 字节级不变**：`_await_max_turns_resume` / `_await_no_progress_resume`
   **未修改**（broker 为平行实现复用同一 execution 辅助，未做规格 D1 提示的抽取）；既有 fixture
   E2E（`test_max_turns_continue.py`、`test_no_progress_detector.py`、`test_execution.py`、
   `test_fixture_executor.py`）全绿 pin。
6. **T5 前端 E2E 的覆盖边界（诚实声明）**：jsdom 无真实浏览器 WebSocket；采用
   `AgentEventTransport` + FakeSocket（真实协议层：envelope 校验/订阅命令/重连/applyEvent 分发，
   与 `useAgentStream` 的接线逐项一致）+ 真实 reducer/store + 真实 `controller.resumeRun` +
   渲染的 `UserInputDialog`。**未覆盖**真实服务器往返（REST 载荷由 mock 快照返回）——这是
   jsdom harness 的边界；后端真实 agent turn E2E 补足服务端全链。
7. **T3 review 可选两项（T5 落地）**：`artifacts_dir=None` warning；CSV 转义往返测试。
   原为"可选"，按 fix-if-trivial 规则落地（各 1 测试，行为最小增量）。

## 4. 验证结果（T5）

| 门 | 结果 |
| --- | --- |
| 后端 pytest（全量） | `2298 passed, 2 skipped, 28 deselected in 30.50s`（T3 基线 2295 + T5 +3） |
| 后端 ruff（全量 `app/ tests/ launcher.py`） | `All checks passed!`（零告警） |
| `python -c "import app.main"` | OK |
| uvicorn 冒烟（port 8131，timeout 起停） | `GET /api/v1/health` → `{"status":"ok","version":"1.0.0","arch":"agent_loop"}` |
| 前端 test | `656 passed`（T4 基线 653 + T5 +3：E2E 1 + dialog 2） |
| 前端 lint | 0 errors（`eslint . --max-warnings 0`） |
| 前端 build | `pnpm build`（tsc -b + vite）成功（pre-existing chunk-size 警告仅） |

后端新增测试明细（T5）：`test_agent_loop_data_correction_influences_outcome_e2e`、
`test_corrections_todo_without_artifacts_dir_warns_and_degrades`、
`test_corrections_todo_csv_escapes_comma_newline_quotes`（均在 `tests/agent_loop/test_main_input_broker.py`）。
前端新增：`hil-data-correction-e2e.test.tsx`（1）、`user-input-dialog.test.tsx`（+2：
fixtureExempt 文案、cross-kind 过期提交抑制；T4 渲染测试改为 summary 恰 1 次断言）。
变异校验（红→绿实证）：后端 influence E2E（提取逻辑断链）、前端 cross-kind 测试
（`promptKey` 去 `promptKind`）、`artifacts_dir=None` warning（实现前）。

## 5. 遗留

- **无阻塞遗留**。
- **Phase 7**：manifest-driven 产物迁移——`corrections_todo.csv` 以任务工作目录文件存在、
  不进 `list_artifacts`；届时按 artifact role 纳入发布清单使其对用户可见。
- 已知 UI 局限（接受，非阻塞）：`expires_at` 为静态提示（无倒计时，代码库无此模式）；
  "已超时" 状态不渲染（后端降级后由 API 快照/事件流自然收敛）。
- 前端 artifact 归属元数据进 store（4b 遗留，非 4c 范围）。
