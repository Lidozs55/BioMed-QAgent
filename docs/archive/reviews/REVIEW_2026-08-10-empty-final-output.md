# REVIEW — 空 final_output 导致 internal_error（2026-08-10）

> 审查对象：`task_aa09258a-2622-418f-9e36-a179ab5f410b` / `run_16195c14-2280-4685-a4d4-faf7f3b72eb1`
> 用户输入：`老年痴呆症和骨质疏松症往往并发出现的相关数据`
> 表现：前端错误码 `internal_error` + 消息 `agent returned empty final_output;
> refusing to silently complete without output`
> 结论：**不是崩溃，不是 WebSocket 层错误，也不是网络/工具异常**——是执行器
> 对"模型 reasoning-only 回合"的 fail-loud 守卫被触发，随后 TaskManager 把
> 未分类 RuntimeError 统一映射为 `internal_error`。

---

## 1. 根因链（事件级证据）

重放 `events.jsonl`（396 事件）+ `backend/logs/app.jsonl`（该 run 全部请求）：

| 轮次 | SDK 输出项 | 结果 |
| --- | --- | --- |
| Turn 1 | reasoning + `find_skill` ×2 | 工具成功 → `NextStepRunAgain` |
| Turn 2 | reasoning + `invoke_skill` ×2（search_pubmed / search_geo） | 两个都返回 `invalid_arguments`（`limit` 不在 schema）→ `NextStepRunAgain` |
| Turn 3 | **仅 reasoning item**（草拟修正后的 JSON query），无 message、无 tool_call | SDK 判 `NextStepFinalOutput`，`final_output = ""` → 守卫抛 RuntimeError |

关键事实：

1. Turn 3 的响应只包含 `ResponseReasoningItem`（session_items ordinal 13：
   `{"query": "Alzheimer's disease osteoporosis comorbidity co-occurrence elderly"}`），
   **没有** `ResponseOutputMessage`、**没有** function call。
2. Agents SDK 0.18.2 对无 message item 的响应计算 final output：
   `turn_resolution.py:801-912` —
   `potential_final_output_text = ItemHelpers.extract_text(message_items[-1].raw_item) if message_items else None`，
   随后 `final_output = potential_final_output_text or ""` → **空串**。
3. `AgentRunExecutor._run_agent_loop` 的 2026-07-18 空输出守卫
   （commit `0c2ea15`，REVIEW_2026-07-18 §2）检测到空 `final_output` →
   `RuntimeError("agent returned empty final_output; refusing to silently complete without output")`。
4. `TaskManager._classify_error` 把未分类异常映射为 `ErrorCode.INTERNAL_ERROR`
   → `run_failed` 事件携带该消息与 `internal_error`。
5. 流式 chunk 从未带 `finish_reason`（日志无 `[RAW_DONE]` 记录），events 无
   `llm_output_truncated` warning —— 排除截断路径；这是模型**正常结束**但
   只输出思考内容的回合。

**诱因（次要）**：Turn 2 的工具错误是模型在 `search_pubmed`/`search_geo`
参数里附加了 `limit`（schema `additionalProperties: false` 拒绝）。模型在
Turn 3 的 reasoning 中仍在草拟修正后的查询，随后直接结束——工具报错后的
瞬时抖动 + 模型偶发 reasoning-only 收尾。

## 2. 修复

`backend/app/agent_loop/runner.py`：

- 新增 `EMPTY_OUTPUT_RETRY_LIMIT = 2`：空 `final_output`（未取消）时发射
  `WarningPayload(code="llm_empty_output_retry")` 并追加修正指令重新提示
  （"你上一轮没有产生任何文本或工具调用，请立即继续……"），最多 2 次。
- 重试耗尽后仍由原守卫 fail-loud（保留 REVIEW_2026-07-18 §2 语义，不静默完成）。
- 复用既有 Qwen function-args 重试的循环结构，无新增状态面。

回归测试（`tests/agent_loop/test_silent_completion.py`）：

- `test_executor_recovers_from_empty_final_output_with_retry`：前 2 次空输出 →
  2 条 `llm_empty_output_retry` warning → 第 3 次产出文本正常收尾，
  `agent_executed` 标记。
- 既有 `test_executor_raises_when_final_output_empty` 补充耗尽断言
  （warning 数 == `EMPTY_OUTPUT_RETRY_LIMIT` 后才抛 RuntimeError）。

验证：聚焦 14 passed；全量 `uv run pytest` 2313 passed / 3 failed
（3 个失败为既有环境问题：`OUTPUT_DIR=data/output` 相对路径注入导致
`test_config::test_output_dir_default_is_absolute`，`test_artifact_api` ×2
为 REVIEW_2026-08-10-task-9ce0124f §7 已记载的既有失败；修复前后失败集
完全一致，零回归）；`ruff check` 0 告警。

## 3. 遗留建议（未在本轮实施）

- **P2** `search_pubmed` / `search_geo` 的 schema 拒绝 `limit`：模型反复附加
  `limit` 是本次工具报错诱因。建议在工具描述中显式列出可用参数
  （或 schema 增加可选 `limit`），减少 LLM 试错轮（与
  REVIEW_2026-08-10-task-9ce0124f §5.1 T4 同类）。
