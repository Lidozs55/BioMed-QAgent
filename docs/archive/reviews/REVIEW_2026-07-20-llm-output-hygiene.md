# LLM 输出卫生与思维链呈现优化（2026-07-20）

> 本文档记录 2026-07-20 第三轮用户反馈的 4 个前端呈现问题排查与修复决策。
> 涉及代码：`backend/app/agent_loop/agent.py`、`backend/app/skills/builtin/discovery/pubmed.py`。
> 配套测试：`backend/tests/integration/test_ncbi_skill_adapters.py`。
> 本文档与 `docs/TODO.md` 双向同步（待补条目）。

---

## 0. 背景与症状

用户在前端对话流重构完成后进行真实测试（task_30c11243，研究主题：阿尔茨海默病与骨质疏松症共病机制），发现 4 个问题：

1. **思维链过长**：LLM 输出的研究思路叙述占据大量屏幕空间，用户不友好。
2. **工具调用未显示**：LLM 文本中提到"PubMed搜索返回了空结果"和"现在我有了一个...文献集"，但其前面没有显示 PubMed 工具调用卡片。
3. **工具调用潜在逻辑 bug**：怀疑 search_pubmed/search_geo 显示冲突或阻塞。
4. **前端异常 JSON**：对话区出现大量 JSON 内容（`{"query": "..."}`、`{"records": [...]}`）。

---

## 1. 根因分析

### 1.1 事件流证据

通过分析 `backend/data/output/tasks/task_30c11243.../events.jsonl`（282 条事件），确认：

| sequence 范围 | event 类型 | 内容 |
|---|---|---|
| 1-2 | run_queued + run_started | 正常启动 |
| 3-8 | assistant_delta | LLM 正常叙述研究思路 |
| **9-13** | assistant_delta | **LLM 输出 `{"query": "Alzheimer's...", "max_results": 20}` 参数 JSON 文本** |
| 14 | tool_started | search_pubmed（第一次） |
| 15 | tool_completed | is_error=False，output=184 bytes（NCBI 失败但 adapter 吞异常返回 error JSON）|
| 16-22 | assistant_delta | LLM 说"PubMed搜索返回了空结果" |
| **23-25** | assistant_delta | **LLM 再次输出工具参数 JSON 文本** |
| 26 | tool_started | search_pubmed（第二次） |
| 28 | tool_completed | is_error=False，output=4110 bytes（成功，20 篇论文完整 JSON）|
| **29-281** | assistant_delta | **LLM 把工具返回的 records JSON 完整复述到文本中**（title/abstract/authors/journal/pmid 字段逐条复制） |
| 282 | run_failed | Windows `[WinError 5]` 拒绝访问（task_snapshot.json 写入失败，已另修） |

### 1.2 根因定性

**问题 2/3/4 都是 Qwen LLM 的 function_call 行为问题，不是前端/后端 bug：**

- **问题 2（工具调用未显示）**：前端 reducer 逻辑正确，tool_call item 按 sequence 插入。用户被 LLM 输出的大量 JSON 文本淹没，没注意到工具卡片。参见 `frontend/src/runtime/reducer.ts` 的 `tool_started`/`tool_completed` 处理。
- **问题 3（工具调用逻辑 bug）**：上一轮已修复 `search_pubmed_adapter` 吞异常问题（commit 已合并到 main）。当前没有 search_pubmed/search_geo 显示冲突。
- **问题 4（前端异常 JSON）**：Qwen 在 function_call 前将参数 JSON 作为 assistant 文本输出（seq 9-13、23-25），在收到工具结果后将完整 JSON 复述到文本中（seq 29-281）。这是 Qwen 的已知行为模式。

**问题 1（思维链过长）不是 bug：**
- Qwen-plus 默认未开启思维链，无 `assistant_reasoning_delta` 事件。
- 用户看到的长文本是 `assistant_segment`（设计不折叠，参见 `frontend/src/components/conversation/AssistantSegment.tsx`）。
- 这部分文本是 LLM 的"研究思路叙述"，确实过长但不属于思维链范畴。

---

## 2. 修复方案

### 2.1 INSTRUCTIONS 强化（问题 2/3/4）

在 `backend/app/agent_loop/agent.py` 的 `INSTRUCTIONS` 中新增"文本输出纪律（重要）"小节，4 条规则：

1. **不要在文本中输出工具调用的参数 JSON**——通过 function_call 传入参数，用户在工具卡片中可见。
2. **不要在文本中复述工具返回的结果 JSON**——用自然语言简述结论，不要复制 records 字段。
3. **工具失败时不要伪造调用**——如实说明错误，不要编造未发生的工具调用。
4. **文本应面向用户解释研究思路和发现**——更高层次的叙述，工具细节由前端卡片呈现。

这是**主要防线**。但 INSTRUCTIONS 不能 100% 约束 LLM 行为，需要**次要防线**配合。

### 2.2 工具输出格式优化（问题 4 次要防线）

修改 `backend/app/skills/builtin/discovery/pubmed.py:search_pubmed_adapter` 的返回 JSON 结构：

**修改前**（4110 bytes）：
```json
{
  "source": "pubmed",
  "query": "...",
  "query_translation": "...",
  "total_count": 234,
  "records": [{...}, {...}, ...]
}
```

**修改后**：
```json
{
  "summary": "找到 20 篇相关文献（共 234 篇匹配）。前 3 篇标题：\n1. ...\n2. ...\n3. ...",
  "source": "pubmed",
  "query": "...",
  "query_translation": "...",
  "total_count": 234,
  "records_count": 20,
  "records": [{...}, {...}, ...],
  "usage_hint": "完整记录在 records 字段，可传给 analyze_papers 工具进行结构化分析。不要在 assistant 文本中复述 records 内容——工具卡片已自动展示。"
}
```

**设计意图**：
- `summary` 字段让 LLM 第一眼看到自然语言概览，降低复述 records 的诱惑。
- `usage_hint` 字段明确告诉 LLM 如何使用 records（传给 analyze_papers）以及不要复述。
- 保留 `records` 完整字段，因为 `analyze_papers` 工具需要 LLM 传入 papers_json 参数。

**为什么不直接去掉 records？** 因为 `analyze_papers`（`backend/app/skills/builtin/discovery/understanding.py`）的接口是 `papers_json: str`，需要 LLM 把 records 传给它进行结构化线索提取（accession、数据类型、物种等）。如果 LLM 看不到 records，就无法调用 analyze_papers。

**未来更彻底的方案**（见 §3）：让 `search_pubmed` 内部把 records 写入 RunContext，让 `analyze_papers` 从 RunContext 读取，LLM 只看到 summary。

### 2.3 工具描述强化

同步更新 `search_pubmed` 的 `description_override` 和 docstring，明确告知 LLM：
- 返回 JSON 包含 `summary` 和 `records` 两个字段
- 用 summary 向用户简报，把 records 传给 analyze_papers
- **不要在 assistant 文本中复述 records**——前端工具卡片已自动展示

### 2.4 已合并的相关修复

- **`search_pubmed_adapter` 异常吞没**（上一轮已合并到 main）：NCBI 失败时 `raise` 而非返回 error JSON，让 SDK 标记 `is_error=True`，前端 ToolCallStep 正确渲染错误状态。
- **Windows WinError 5 task_snapshot.json 写入失败**（上一轮已合并）：`os.replace` 重试 5 次指数退避（50ms→800ms）。
- **`run_queued` 不创建 UserMessageItem**（上一轮已合并）：导致 items 为空，前端显示"该任务暂时没有消息"。

---

## 3. 未来优化方向（思维链分类，问题 1）

> **用户指示**：本节为后续处理，本轮仅写文档记录方案。

### 3.1 问题本质

当前所有 `assistant_delta` 都归为 `assistant_segment`（不折叠）。LLM 的文本输出混合了三类内容：

| 类别 | 内容 | 当前呈现 | 期望呈现 |
|---|---|---|---|
| A. 研究思路 | "我将系统性地研究..."、"接下来我将..." | 完整展示 | 完整展示 |
| B. 工具调用意图 | "我将调用 search_pubmed 搜索..." | 完整展示 | 折叠为单行摘要 |
| C. 工具结果复述 | "PubMed 返回了 20 篇文献，标题分别是..." | 完整展示 | 折叠或隐藏（工具卡片已展示）|

用户看到的"思维链过长"实际是 B/C 类内容淹没了 A 类内容。

### 3.2 方案 A：LLM 主动分类（推荐）

**思路**：让 LLM 在输出时主动标记文本类别，前端按类别折叠。

**实现步骤**：
1. 在 INSTRUCTIONS 中新增规则：LLM 输出文本时用特定前缀标记类别，如 `[PLAN]`、`[TOOL_INTENT]`、`[SUMMARY]`。
2. 后端 `runner.py` 的 `_AssistantTextBuffer` 在 `add(delta)` 时识别前缀，发射不同 `stream_id`（如 `assistant:run_x:plan:0`、`assistant:run_x:tool_intent:0`）。
3. 前端 `reducer.ts` 根据 `stream_id` 后缀创建不同 ConversationItem kind（`assistant_segment` vs `assistant_meta`）。
4. 前端组件 `AssistantSegment` 默认展开，`AssistantMeta` 默认折叠（点击可展开）。

**优点**：
- 不需要新增前端组件，复用现有 stream_id 分段机制。
- LLM 自主决策，分类更准确。

**缺点**：
- 依赖 LLM 遵守标记规则（Qwen 可能不稳定）。
- 需要新增 ConversationItem kind（schema 变更）。

### 3.3 方案 B：后端启发式分类

**思路**：后端按文本特征自动分类，不依赖 LLM 配合。

**实现步骤**：
1. 在 `_AssistantTextBuffer.add()` 中检测文本特征：
   - 包含 `{"`、`"query"`、`"records"` 等 JSON 模式 → C 类
   - 包含 "我将调用"、"我将搜索"、"接下来我将" → B 类
   - 其他 → A 类
2. 根据分类发射不同 `stream_id`。
3. 前端按 stream_id 后缀折叠/展开。

**优点**：
- 不依赖 LLM 配合，行为稳定。
- 不需要 INSTRUCTIONS 改动。

**缺点**：
- 启发式规则可能误判（如 LLM 在自然语言中引用 JSON 字段名）。
- 需要维护关键词列表。

### 3.4 方案 C：彻底分离——工具结果不进 assistant_segment

**思路**：从根本上消除 C 类内容——让 LLM 看不到工具结果 JSON。

**实现步骤**：
1. `search_pubmed_adapter` 返回 summary 字符串给 LLM，把 records 写入 `RunContext.cached_records`。
2. `analyze_papers` 改为从 `RunContext.cached_records` 读取，不再需要 `papers_json` 参数。
3. LLM 只看到 summary，自然不会复述 records。
4. 其他 discovery/acquisition 工具同样改造。

**优点**：
- 彻底消除 LLM 复述工具结果的诱因。
- LLM 上下文更短，决策更聚焦。

**缺点**：
- 改造范围大，涉及多个 adapter 和 analyze_papers 接口变更。
- 需要设计 RunContext 中 records 的生命周期（按 source? 按 query?）。
- 失去 LLM "看到完整数据后自主决策"的能力（如 LLM 可能根据 abstract 内容决定换关键词）。

### 3.5 推荐路径

短期（本轮）：方案 A 的 INSTRUCTIONS 部分（已实施 §2.1），方案 B 的 stream_id 分类作为后续迭代。

中期（下个迭代）：实施方案 B（后端启发式分类），不需要 LLM 配合，行为稳定。

长期（如果问题持续）：评估方案 C（彻底分离），但需要权衡 LLM 决策能力的损失。

---

## 4. 验证清单

- [x] INSTRUCTIONS 新增"文本输出纪律"4 条规则
- [x] `search_pubmed_adapter` 返回 JSON 包含 `summary` / `usage_hint` / `records_count` 字段
- [x] `search_pubmed` 工具 description 与 docstring 说明新输出格式
- [x] 回归测试：`test_ncbi_skill_adapters.py` 18 个测试全部通过
- [x] 全量测试：`pytest` 1257 passed, 1 skipped
- [x] Lint：`ruff check` 0 warnings
- [ ] **真实环境验证**：用户在浏览器中重新运行研究任务，确认：
  - LLM 不再输出参数 JSON 文本
  - LLM 不再复述 records JSON
  - 工具调用卡片正常显示
  - 如仍有问题，按 §3.2/3.3 实施下一步方案

---

## 5. 关联文档

- `docs/ARCHITECTURE.md` — 系统架构与前端对话流设计
- `docs/TODO.md` §1.5 — PubMed download_supplementary 合规化（已合并）
- `docs/REVIEW_2026-07-18.md` — 前一轮审查报告
- `docs/superpowers/specs/2026-07-20-conversation-redesign-design.md` — 对话流重构设计
