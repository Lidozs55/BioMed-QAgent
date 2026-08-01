# 轮次限制移除与防重复劳动方案（REVIEW 2026-07-31）

> 审计日期：2026-07-31。基于对 `main` 分支代码的审计，提出移除/放宽轮次限制、
> 减少主 Agent 与子代理被频繁打断、以及避免模型重复无意义劳动的方案。
> 关联 TODO §4.5（Agent max_turns 后续）。
> 状态：**方案文档，未实施**。实施时按 §7 决策记录执行。

---

## 1. 结论摘要

- 主 Agent 当前以 `AGENT_MAX_TURNS=15` + `MAX_TURNS_RESUME_LIMIT=3` 构成
  **每 15 轮强制人工打断、60 轮后整轮作废**的机制。轮数不衡量进展（10 轮重复
  查询同样消耗 10 轮），也不衡量成本（token 才是钱）。
- 子代理 `CHILD_AGENT_MAX_TURNS=10` + 900s 墙钟超时是**硬失败**而非暂停；
  子代理会话是一次性的，重派不携带 parent 检索上下文 → 必然重复劳动。
- 方案：以 **token 预算 + 无进展检测** 取代轮数作为硬边界；轮次与超时全部
  参数化并放宽；子代理默认超时 1h；重复检测采用"短时密集窗口 + 用户指令中断"
  语义（§7 用户已确认）。

## 2. 审计现状：轮次/时间限制清单

| # | 限制 | 位置 | 机制 | 后果 |
|---|---|---|---|---|
| L1 | `AGENT_MAX_TURNS = 15` | `app/agent_loop/agent.py:37` | 每次 `Runner.run_streamed` 的 turn 上限 | 主 Agent 每 15 轮暂停 |
| L2 | `MAX_TURNS_RESUME_LIMIT = 3` | `app/agent_loop/runner.py:76` | 超过 3 次暂停-续跑后，第 4 次 `MaxTurnsExceeded` 直接 `RuntimeError` → **RunFailed**（`runner.py:778-782`） | 60 轮后整轮失败，产物作废 |
| L3 | 暂停-续跑循环 | `runner.py:735-832` | 每次 `MaxTurnsExceeded` → 发射 `max_turns_reached` HITL → 用户点"继续"才续跑 | **主 Agent 每 15 轮被打断一次**，等待人工 |
| L4 | `ATTACHMENT_PARSING_MAX_TURNS = 40` | `app/agent_loop/import_agent.py:46` | Import 双阶段 agent 的 turn 上限 | 附件解析同样每 40 轮暂停 |
| L5 | `CHILD_AGENT_MAX_TURNS = 10` | `app/subagents/agents.py:28` | `Runner.run` 传入；子代理无 pause-resume | **子代理 10 轮即硬失败**（`agents.py:146-156` 捕获为 `FAILED/INTERNAL_ERROR`），无重试 |
| L6 | `timeout_seconds = 900`（15 分钟墙钟） | `app/subagents/supervisor.py:93` | 子代理超时 → `FAILED/TIMED_OUT`（`supervisor.py:544-548`） | 多下载任务 15 分钟即失败 |
| L7 | `max_turns=1`（summarizer/compaction） | `app/runtime/compaction_summary.py:50` | 压缩摘要只给 1 轮 | 摘要 LLM 一旦截断 → 走降级路径（保留最近 20 条 runs） |
| L8 | 上下文预算触发压缩 | `app/model_config/context_budget.py:18-20`（trigger 0.85/0.95，target 0.60） | 接近窗口上限时压缩会话 | **良性机制**，不是打断，保留 |

其它相关常量：`QWEN_FUNCTION_ARGS_RETRY_LIMIT=2`（`runner.py:78`）、
`KEEP_RECENT=5` / `COMPRESS_THRESHOLD_CHARS=8000`（`summarizer.py:21-22`）、
`TOOL_OUTPUT_MAX_BYTES=4096`（`runner.py:456`）。

**结构性事实**：主 Agent 总上限 = 15 × (1+3) = **60 轮**，但过程被打断 3 次、
第 4 次超限直接整轮失败。子代理重派时 `_ChildSession` 全新、
`create_child_context` 只继承 `preferred_sources`（`context.py:306-318`），
**parent 的 query_log 完全不传给 child**，重派 = 从头重搜。

## 3. 打断与重复劳动根源

1. **轮数 ≠ 进度/成本**：复杂研究任务合法需要 40-100 次工具调用（检索×N +
   下载×N + pipeline + 策略审查），15 轮不够，于是每 15 轮强制人工介入。
2. **子代理硬失败**：`CHILD_AGENT_MAX_TURNS=10` + 900s 超时是失败而非暂停，
   parent 拿到 `FAILED` 后重派（重复劳动）或放弃。
3. **Qwen 400 重试从头跑**（`runner.py:801-821`）：malformed function args 时
   `agent_input = execution.input` 重新执行，**先前所有工具调用全部重放一遍**。
4. **子代理重派丢上下文**：child 看不到 parent 已完成的检索。
5. **review 结果只追加不合并**（`reviewer.py`）：长跑后审查摘要无限累积。

已有防重复机制（**保留**）：查询清单注入（"已完成的检索"权威节）、"同一 query
不重试"指令、每 source 3 轮 follow-up 上限（`agent.py:91-94`，语义级防重复，
与轮数解耦）、`not_found` 禁止触发 create_skill、Pipeline digest 复用 checkpoint、
`compress_query_log`。

## 4. 方案

### 4.1 阶段 A：参数化并放宽（低风险，先行）

| 项 | 现状 | 目标 | 改动点 |
|---|---|---|---|
| A1 | `AGENT_MAX_TURNS=15` | 默认 60，可配置 | `agent.py:37`；由 `ContextBudget` 派生剩余轮数（`input_capacity / 每轮均耗`），不再硬编码 |
| A2 | `MAX_TURNS_RESUME_LIMIT=3` 硬失败 | **删除硬失败**：第 4+ 次 `MaxTurnsExceeded` 自动续跑 + 发 `WarningPayload`；真实护栏为预算门控与无进展检测 | `runner.py:778-782` |
| A3 | `CHILD_AGENT_MAX_TURNS=10` | 默认 30，可配置 | `subagents/agents.py:28` |
| A4 | 子代理 `timeout_seconds=900` | **默认 3600（1h）**，可配置 | `supervisor.py:93` |

全部收进设置项（建议 `runtime_limits` 段），per-model 可调，不动代码调优。
L7/L8 保持不变（summarizer `max_turns=1` 是刻意的单轮有界调用；预算压缩是
良性机制）。

### 4.2 阶段 B：结构性改造

**B1. token 预算为唯一硬边界。** 主循环不再以轮数为停止条件：只要 compaction
preflight 通过（预算内）且有进展就继续。压缩循环（L8）已天然阻止上下文无限
膨胀，`MAX_TURNS_RESUME_LIMIT` 的存在意义被预算机制取代。`max_turns_reached`
HITL 分支保留为可选（用户手动"暂停"仍可用），但不再强制每 15 轮打断。

**B2. 无进展/重复检测器（替代轮数防死循环，语义见 §7）。** 在
`_consume_events` 流上维护 `(tool_name, args_hash)` 指纹计数：

- **仅检测"大量短时密集重复"**：同一指纹在滑动时间窗口 `W`（默认 5 分钟，
  可配置）内出现 ≥ `REPEAT_THRESHOLD`（默认 3 次）→ 触发；
- **长时间间隔不累计**：两次同指纹调用间隔 > `W` 时，先前计数作废（可能是
  复查，不算重复）；
- **用户指令中断不算重复**：两次调用之间若出现用户指令（新用户 turn，
  `agent_input` 非空），清空该指纹计数（可能是用户指令导致的）；
- 触发后发射 `UserInputRequiredPayload(prompt_kind="no_progress")`，复用现有
  HITL 基础设施（`max_turns_reached` 同款 pause-resume）；同一 run 对同一
  指纹至多触发一次，避免循环打断。

实现位置：主 Agent 状态放 executor 实例（`__call__` 的 while 循环跨续跑存活）；
子代理在 `_run_agent` 单次 `Runner.run` 内检测。影响面：
- `events.py:242-257` `PromptKind` 联合新增 `"no_progress"`；
- reducer / `UserInputDialog` 新增分支渲染。

**B3. 子代理 `MaxTurnsExceeded` 单独捕获。** `agents.py:146` 现在是
`except Exception` 一把抓。拆出 `except MaxTurnsExceeded` → 复用
`SubagentInputRequiredPayload`（`context.py:449-469` 已有原语）暂停等用户，
或自动续派一次并附 parent query_log 压缩摘要 + "已完成步骤清单"，明确要求
"不要重复已完成检索"。

**B4. 修复 Qwen 400 重试的全量重放**（`runner.py:820`）：改为向 session 追加
一条修复指令（"上一工具调用参数非法，仅修正该调用后重发"），而非
`agent_input = execution.input` 从头重放。

### 4.3 阶段 C：重复劳动强化

- **C1** child context 注入 parent 的压缩 query_log（`context.py:create_child_context`），
  子代理直接看到哪些 query 已搜过，杜绝重派重搜；
- **C2** review 结果改为滚动合并（最新替换最旧），而非无限追加；
- **C3** 保留并强化 per-source 3 轮 follow-up 语义预算（`agent.py:91-94`）——
  这是**语义级**防重复，按 source 计数、与轮数解耦，最有效。

## 5. 风险与护栏

| 风险 | 护栏 |
|---|---|
| LLM 无限循环 | B2 无进展检测器（指纹短时密集重复 → 干预），比轮数更精准 |
| 上下文爆炸 | 现有 compaction 预算门控（L8）不变 |
| 用户失去控制 | 保留手动暂停/停止（`cancel` API 已存在）；`no_progress` HITL |
| 子代理失控 | 保留墙钟超时兜底（A4：默认 1h） |
| 成本失控 | 预算门控 + 无进展检测双保险；B4 消除 400 重试的全量重放 |

## 6. 落地顺序与影响面

**顺序**：阶段 A（参数化 + 放宽 + 删硬失败）→ B2/B3（结构性）→ B1/B4 → C。

**受影响测试**（实施时逐项更新）：

- `tests/agent_loop/test_max_turns_continue.py`：
  `test_max_turns_resume_limit_enforced`（302 行）需重写——删除硬失败后改为
  断言自动续跑 + warning；
- `tests/subagents/test_agents.py:77`：`assert observed["max_turns"] == 10` →
  新常量；
- `tests/agent_loop/test_import_agent.py:123-125`（20 ≤ ATTACHMENT ≤ 80）：
  仍有效，无需改；
- `tests/subagents/test_supervisor.py`：超时测试均显式传小值（如
  `timeout_seconds=0.01`），不依赖默认 900，改默认不影响；
- `tests/agent_loop/test_followup_reviewer.py`：follow-up 3 轮语义保留，不改。

## 7. 决策记录（2026-07-31 用户确认）

1. **子代理默认最大超时 = 1h**（`timeout_seconds` 默认 3600s，可配置）。
2. **工具调用重复检测仅检测大量短时密集重复**：长间隔（超过窗口）不计算重复，
   因为可能只是复查。
3. **两次调用之间若有用户指令，不算重复**：可能是用户指令导致的调用。

## 8. 后续动作

- [x] 阶段 A 实施（参数化 + A4 默认 1h）
- [x] `no_progress` 事件类型 + reducer + 前端分支
- [x] B3/B4/C 防重复强化
- [x] TODO §4.5 勾选同步（已实施并合并 4adaade）
