# Phase 4c 设计：HIL `request_human_correction`（Agent 层工具）

> 日期：2026-08-07 ｜ 状态：已批准，待实施 ｜ 对应 `docs/TODO.md` Phase 4 P2
> 推进顺序：4a（终态语义）→ 4b（空表语义）→ **4c（本文档，HIL）**
> 权威依据：`docs/TODO.md` Phase 4 P2、`docs/BioMed-QAgent_Pipeline_Refactor_Design.md` 原 §1.7
> 关键约束：**HIL 为 Agent 层工具；pipeline 内自动 HIL 已否决**（TODO 原文）

## 1. 背景与目标

V1 Agent 在研究执行中遇到数据源/参数歧义或需要人类澄清时，没有结构化渠道向用户
请求修正：Agent 只能继续自行假设或产出有误的候选。Phase 4c 落地 Agent 层的人类
在环（HIL）工具：

1. **`request_human_correction` FunctionTool**（Agent 层）：Agent 调用 → 暂停 Run →
   前端弹窗收集人工修正 → 恢复并将人类答复注入 Agent 上下文继续执行；
2. **UserInputDialog `data_correction` 分支**：前端专用弹窗（修正输入框 + 提交/跳过）；
3. **超时退化 `corrections_todo.csv`**：人类在 `expires_at` 内未答复 → 写入待办修正
   文件，Agent 优雅继续（不阻塞、不失败）。

**验收**（TODO Phase 4 P2 + 原 §1.7 语义）：

- Agent 可在运行中途请求人工修正，Run 暂停为 `AWAITING_USER_INPUT`（事件
  `user_input_required` prompt_kind=`data_correction`），前端弹窗可提交修正；
- 恢复后 Agent 拿到人类答复（approve/reject + detail）并继续同一会话；
- 超时（无人答复）→ `corrections_todo.csv` 落盘，Agent 收到降级提示继续执行，
  不产生失败；fixture 模式永不阻塞（自动合成答复）；
- 不引入新事件类型、不改状态机（复用 4a/既有 HIL 事件链）；
- pipeline 内自动 HIL 不启用（`pipeline/runner.py` 的 `data_correction` 类型仅保留
  在 union 中，无人发射——维持否决结论）。

## 2. 现状代码足迹（4c 改造点）

| 位置 | 现状 | 4c 动作 |
| --- | --- | --- |
| `domain/contracts/events.py:284-310` | `UserInputRequiredPayload.prompt_kind` 已含 `"data_correction"`；`expires_at`/`fixture_exempt`/`detail` 字段在位 | 无改动（复用） |
| `api/routes.py:688-720` resume API | `POST /runs/{id}/resume`：request_id + decision(approve/reject) + detail | 无改动（detail 已支持结构化修正） |
| `runtime/manager.py:276-300` | 非 fixture 的 user_input_required 阻塞 + pending request_id 去重；resume 路由 submitter | 无改动（复用） |
| `agent_loop/runner.py:1141-1230` | `_await_max_turns_resume`/`_await_no_progress_resume`：submitter + event.wait() **无超时** | 新增通用 `_await_agent_input_resume`（带 timeout）供 data_correction 复用；max_turns/no_progress 行为不变 |
| `agent_loop/context.py` RunContext | 有 `subagent_runtime`（子代理 input broker）；**无主 run input broker** | 新增 `main_input_broker` 字段 + `request_main_input()` 方法（runner 安装，镜像子代理 broker 模式） |
| `agent_loop/agent.py:454-466` tools 列表 | find_skill/invoke_skill/run_research_pipeline/文件工具/... | 新增 `request_human_correction` FunctionTool |
| `frontend/src/components/UserInputDialog.tsx` | plan_confirmation/max_turns_reached/no_progress 分支 + 泛化 fallback（"请补充信息"） | 新增 `data_correction` 专用分支 |
| `frontend/src/runtime/contracts.ts:305-309` | `"data_correction"` 在 prompt_kind union；`UserInputDecision` approve/reject | 无改动 |
| `pipeline/runner.py:479` | `_await_user_input` prompt_kind union 含 data_correction（pipeline 内 HIL 否决） | 不动（维持否决） |

## 3. 设计决策

### D1. 主 Run input broker（工具 → execution 通道）

工具经 SDK 收到 `ctx: RunContextWrapper[RunContext]`，但 RunContext 目前不暴露主 run
的 emit/submitter（子代理有 `subagent_runtime`）。4c 新增与子代理对称的主 run broker：

- `RunContext.main_input_broker: MainInputBroker | None`（runner 每 run 安装，
  init=False）；
- `RunContext.request_main_input(*, summary, detail=None, timeout_seconds=None) ->
  MainInputDecision`——broker 为 None 时 raise（工具描述告知不可用场景）；
- broker 实现（runner 侧，镜像 `_await_max_turns_resume`）：
  1. `request_id = f"data_correction-{execution.run_id}-{counter}"`（每 run 递增）；
  2. `execution.set_user_input_submitter(submitter)`（复用既有机制）；
  3. 发射 `UserInputRequiredPayload(prompt_kind="data_correction", summary,
     detail, expires_at=now+timeout, fixture_exempt=(execution.mode==FIXTURE))`；
  4. fixture 模式：**不等待**，立即返回合成 approve（detail 标记
     `fixture_exempt=True` + 合成修正文本）——fixture 测试永不阻塞；
  5. live 模式：`asyncio.wait(event, deadline)`；resume → 返回人类决策；
     timeout → 走 D3 退化（**不 raise**）；cancel → 抛既有取消异常。

### D2. `request_human_correction` FunctionTool

`agent.py` tools 列表新增（agent 主工具区）：

- 签名：`summary: str`（向人类提出的修正问题/澄清请求）、
  `detail: dict | None`（可选：建议选项/待修正字段/上下文）、
  `timeout_seconds: float | None`（可选覆盖，默认取运行级 HIL 超时配置）；
- 描述引导：**仅在需要人类决策/澄清时才调用**（数据源选择歧义、参数确认、
  候选 GSE 无法判断等）；同一轮不要重复调用（等人类答复后再继续）；
- 返回：人类答复的文本摘要（approve/reject + detail 内容），Agent 据此继续；
  退化时返回"超时，已记录 corrections_todo.csv，位置 <path>"；
- fixture 模式返回合成答复。

### D3. 超时退化 → `corrections_todo.csv`

- 落盘位置：`ctx.context.work_dir.artifacts / "corrections_todo.csv"`（任务 artifact
  目录，磁盘可见；追加语义——同 run 多次超时逐行追加，跨 run 累积时保留历史行；
  原子写）；
- 行字段：`request_id, requested_at, expires_at, summary, detail_json, status`；
  status=`timed_out`（resume 到达的请求不写该文件）；
- 返回降级消息给 Agent（含文件路径），Run 继续（COMPLETED 正常收尾）；
- **已知限制**：Agent 侧文件不进 publication manifest（发布链为 deterministic
  pipeline 独占，4a/4b 架构）——corrections_todo.csv 以任务工作目录文件存在，
  不进 `list_artifacts`；完整 manifest-driven 产物迁移属 Phase 7。REVIEW 文档记录。

### D4. 前端 `data_correction` 分支

`UserInputDialog` 增加 `pending.promptKind === "data_correction"` 分支：

- 标题："需要人工修正"；展示 `summary`（修正问题）；
- 输入区：textarea（修正内容/答复文本），必填校验（空不可提交）；
- 操作：**"提交修正"** → resume(decision="approve", detail={correction: text})；
  **"跳过并继续"** → resume(decision="reject", detail={correction: ""})；
  有 `expires_at` 时显示剩余时间提示（只读，超时后由后端降级，前端可提示"已超时"）；
- 提交后关闭弹窗，复用既有 submission store 与 resume API（无新 API）。

### D5. 事件/状态机

复用既有链：`user_input_required(data_correction)` → Run `AWAITING_USER_INPUT` →
（resume）`user_input_resumed` → `RUNNING` → 继续。不新增事件类型、不改 reducer、
不改 manager 阻塞逻辑（已支持）。`tool_started`/`tool_completed` 事件由既有
执行层自动发出（工具调用包装），前端无需新增。

## 4. 任务划分（TDD，每任务先写 repro 测试）

| # | 任务 | 关键改动 | 测试 |
| --- | --- | --- | --- |
| T1 | 主 run input broker | RunContext.main_input_broker + request_main_input；runner 安装；fixture auto-approve；带 timeout 的等待 | fixture 不阻塞合成答复；live resume roundtrip（submitter 收到 decision）；timeout 触发 |
| T2 | request_human_correction 工具 | agent.py 注册 FunctionTool；调 broker；返回人类答复文本/降级消息 | 工具单测（mock broker）：approve/reject/detail 透传、降级消息 |
| T3 | corrections_todo.csv 退化 | 超时写文件（追加/原子）；返回降级消息；resume 到达不写 | 超时写文件内容/位置；多次追加；resume 到达不写 |
| T4 | 前端 data_correction 分支 | UserInputDialog 分支 + textarea + 提交/跳过；expires_at 提示 | 渲染；提交 detail 载荷；空输入校验；跳过走 reject |
| T5 | 端到端 + 文档 | agent_loop 集成测试（pause→resume→继续；timeout 降级→COMPLETED）；REVIEW 文档；TODO 勾选 | fixture E2E 全链路；REVIEW_2026-08-07-phase4c |

**实施顺序**：T1→T2→T3→T4→T5（严格依赖序）。每任务独立子代理，规格评审
（对照本文档）+ quality 评审。

## 5. 风险与注意

- **fixture 模式行为**：实施者需核实 agent_loop 在 fixture 下 max_turns/no_progress
  pause 的实际行为（是否触发、是否 fixture_exempt），4c 的 fixture auto-approve 必须
  与之一致（不引入 fixture 回归）；
- **max_turns/no_progress 回归**：D1 抽取通用 `_await_agent_input_resume` 时，
  max_turns/no_progress 的 prompt_kind/request_id 格式/行为必须字节级不变
  （既有 fixture E2E pin 它们）；
- **工具描述纪律**：`request_human_correction` 描述必须引导 Agent 仅在真正需要
  人类决策时调用（避免 Agent 滥用打断）；tools 顺序影响模型行为——放主工具区
  靠后（run_research_pipeline 之后）或按需；
- **timeout 默认值**：运行级 HIL 超时（参考 pipeline `USER_INPUT_TIMEOUT`）作为
  默认；工具可覆盖；`expires_at` 必须与前端展示一致；
- **subagent 内调用**：RunContext 在子代理中也有实例——broker 未安装时工具应
  明确报错（不可用），不得静默假成功。
