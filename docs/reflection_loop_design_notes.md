# reflection_loop 设计备忘：现状问题与 LLM 在环反思方向

> 创建日期：2026-07-08
> 范围：[backend/app/tools/optimization/reflection_loop.py](../backend/app/tools/optimization/reflection_loop.py)
> 关联模块：[stage_evaluator.py](../backend/app/tools/optimization/stage_evaluator.py)、[iteration_decision.py](../backend/app/agents/iteration_decision.py)、[ARCHITECTURE.md](../ARCHITECTURE.md) §四/§八
> 决策：保留 `reflection_loop.py` 文件不删除，本文档说明其现状问题与期望演进方向。

---

## 一、当前状态

`reflection_loop.py` 是达尔文反思循环的"文件版"控制器，提供三个领域函数（对应原 CLI 的 `record/decide/finalize` 子命令）：

| 函数 | 职责 | 输入/输出 |
|------|------|-----------|
| `record(evaluation_path, action, reflection_log_path, ...)` | 读取评估 JSON 文件，追加一次迭代条目到 ReflectionLog JSON 文件 | 文件 → 文件 |
| `decide(evaluation_path, reflection_log_path, task_id)` | 读取评估与反思日志，按固定优先级输出 `accept/expand_search/add_source/...` 决策 | 文件 → dict |
| `finalize(reflection_log_path, output_path, task_id)` | 汇总反思日志，计算收敛分、生成 lessons_learned 与 summary | 文件 → 文件 |

`_decide_action` 内的决策逻辑是**纯规则**：`passed=true` → accept；达 `MAX_ITERATIONS=3` → force_accept；否则按 `request_user_input > add_source > expand_search > deepen_analysis > refine_keywords` 的静态优先级取第一条 suggestion。

[backend/app/tools/registry.py](../backend/app/tools/registry.py) 为上述三个函数注册了 ToolRegistry facade：`reflection_record` / `reflection_decide` / `reflection_finalize`（L781–L834），并在 `_TOOLS_METADATA` 的 optimization 类目下登记 `{"name": "reflection_loop", "description": "反思循环（record/decide/finalize）"}`（L1070）。

**运行期状态：dormant。**
- 全局 grep `reflection_record|reflection_decide|reflection_finalize` 仅命中 `registry.py`（facade 定义）与本审查文档，**Orchestrator 与 8 个 Agent 零引用**。
- `reflection_loop` 模块本身也未被任何 Agent import；`iteration_decision.py` 直接 `from app.tools.optimization.stage_evaluator import evaluate` 内存直调，绕过 reflection_loop。
- 与 [ARCHITECTURE.md](../ARCHITECTURE.md) §八一致："reflection_loop 文件版仍 dormant（CLI 导向，内存直调 evaluate 已覆盖核心价值）"。

即：`stage_evaluator`（量化指标 + gaps + suggestions）+ `IterationDecisionAgent`（多轮收敛判断 + LLM gap 分析 prompt 增强）已替代 reflection_loop 的核心职能。

---

## 二、存在的问题

1. **`reflection_decide` / `reflection_finalize` 是完全死代码**
   facade 已注册但无任何调用者；`decide` 的规则优先级逻辑与 `IterationDecisionAgent` 的收敛条件重叠，`finalize` 的收敛分/lessons 在内存直调路径下无人产出。

2. **`reflection_record` 仅在 skills 元数据中登记但无调用**
   `_TOOLS_METADATA` 把 `reflection_loop` 列为 optimization 工具之一，但生产路径（Orchestrator/Agents）从不调用 `reflection_record`，反思日志 JSON 文件从未被写入。

3. **基于文件的 reflection_log 机制与当前内存直调的 stage_evaluator 不一致**
   `record/decide/finalize` 全部以 `evaluation_path` / `reflection_log_path` / `output_path` 文件路径为入参，是 CLI 导向设计；而 `IterationDecisionAgent._evaluate_stage` 内存直调 `evaluate(records, ...)` 返回 dict 直接消费。两套接口风格不统一，reflection_loop 无法接入当前事件循环。

4. **缺少 LLM 在环的反思能力**
   `_decide_action` 仅做规则驱动的 `accept/reject/revise` 三选一，suggestions 由 `stage_evaluator._generate_suggestions` 的硬编码阈值产生（如 `coverage<0.6` → expand_search）。整个过程**无 LLM 参与**，无法对"为什么没覆盖""如何改进已有输出质量"做定性分析与策略生成，仅能驱动"是否继续检索更多数据"。

---

## 三、期望方向：LLM 在环多轮反思循环

### 3.1 设计目标

通过 LLM 参与的多轮反思循环来**完善已有输出的质量**，而非仅决定"要不要再搜一轮"。反思循环应让 LLM 承担"质量缺口识别 + 改进策略生成"的定性角色，与 `stage_evaluator` 的量化指标形成互补。

### 3.2 与 `IterationDecisionAgent` 的职责切分

| 维度 | IterationDecisionAgent（现状） | reflection_loop（期望） |
|------|-------------------------------|------------------------|
| 核心问题 | 是否继续检索**更多数据**？ | 如何改进**已有输出**的质量？ |
| 触发时机 | 每轮 pipeline 末尾，决定 next round | 单阶段内部或跨阶段，针对输出本身 |
| 决策对象 | should_continue（继续/收敛） | 改进策略（重写/补全/重排序/纠错） |
| 数据流向 | 向前反馈到 search 阶段 | 就地改进当前阶段产物 |

### 3.3 期望的 LLM 在环流程

```
评估(stage_evaluator 量化指标)
   ↓
LLM 识别质量缺口（定性分析：覆盖了什么、缺什么、哪里置信度低、哪里冲突）
   ↓
LLM 生成改进建议（具体到字段/记录/分析维度的修订策略）
   ↓
执行改进（调用对应 Agent 的局部修订能力）
   ↓
再评估（回到第一步）
   ↓
收敛（LLM 判定无新增质量缺口，或达 MAX_ITERATIONS）
```

关键差异点：当前 `decide` 仅返回 `action` 字符串，期望 LLM 输出**结构化改进策略**（如"对记录 X 的 confidence 字段重新校验""对 analysis 阶段补做生存分析"），并由执行环节消费。

### 3.4 与 `stage_evaluator` 的关系

`stage_evaluator` 提供**量化指标**（coverage / avg_confidence / conflict_rate / source_diversity + gaps + suggestions），是反思循环的输入而非替代。期望中 reflection_loop 应：
- 消费 `evaluate()` 返回的 dict 作为 LLM prompt 的量化上下文；
- 在此基础上让 LLM 做**定性分析**（为什么 coverage 低？是查询词不当还是数据源缺失？）与**改进策略生成**（suggestion 是模板化的，LLM 策略应更具体）。

### 3.5 与 reviewer 阶段的区别

| 维度 | reviewer 阶段 | reflection_loop（期望） |
|------|--------------|------------------------|
| 位置 | pipeline 终点（review 阶段） | 贯穿多阶段的迭代改进 |
| 时机 | 单次质量审查，产出 review 报告 | 多轮闭环，每轮触发改进并再评估 |
| 输出 | 质量评估报告（不直接改数据） | 改进策略 + 触发实际改进动作 |

reviewer 是"事后审查员"，reflection_loop 应是"贯穿迭代的改进教练"。

---

## 四、实施建议（简要）

1. **激活路径**：二选一。
   - 方案 A：将 `record/decide/finalize` 接入 `IterationDecisionAgent`，作为其"质量改进子流程"，与现有"是否继续检索"逻辑并列。
   - 方案 B：新建 `ReflectionAgent`（在 `agents/` 下），独立承担 LLM 在环反思循环，与 `IterationDecisionAgent` 解耦。建议选 B，职责更清晰。

2. **LLM 在环**：在 `decide` 阶段引入 LLM 调用，输入为 `stage_evaluator.evaluate()` 的量化结果 + 当前阶段产物摘要，输出为结构化改进策略（JSON schema 约束）。无 LLM 时降级为现有规则优先级逻辑。

3. **内存模式**：将 `record/decide/finalize` 的文件路径入参改为内存 dict（`evaluation: dict`、`reflection: dict`），与 `stage_evaluator` 内存直调风格一致；保留文件持久化作为可选导出能力（如 `finalize` 落盘 summary 供溯源）。

4. **facade 清理**：激活后保留 `reflection_record/decide/finalize` facade 供外部调用；若暂不激活，应在 `_TOOLS_METADATA` 中标注 dormant 以免误导。

5. **收敛判据**：LLM 判定"无新增质量缺口"或达 `MAX_ITERATIONS` 即收敛；与 `IterationDecisionAgent` 的轮级收敛判据互补，不冲突。
