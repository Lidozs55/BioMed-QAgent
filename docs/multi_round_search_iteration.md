# 多轮数据检索迭代设计

> 状态：**待实施**（本文档仅做方案设计，暂不落地代码）
> 创建时间：2026-07-08
> **需要调整 ARCHITECTURE.md**：本文档涉及流水线从"单轮线性"改为"多轮迭代"，需在 ARCHITECTURE.md 中新增章节

---

## 一、动机

当前流水线是**单轮线性**执行：

```
planning → search → acquire → parse → clean → analyze → review → export
```

LLM 审查报告（reviewer 阶段）或 LLM 综合报告（export 阶段）经常给出这样的建议：

> "进一步验证 MMP9、STAT1 和 NFKB1 在胰腺癌肝转移中的具体作用机制"

这暗示：**这些基因在规划阶段被识别，但在分析阶段未能充分验证**（可能因为数据不足、
检索的文献未覆盖这些基因的实验数据）。当前架构下，这个建议只能作为"未来工作"输出给用户，
系统不会主动追加检索。

**核心问题**：能否让系统根据 LLM 的反馈，自动进行多轮检索迭代，直到无法获得更多信息？

---

## 二、设计目标

1. **LLM 驱动的迭代决策**：每轮结束后，LLM 评估"是否还有可补充的信息"
2. **收敛性保证**：每轮必须有新增信息才继续，否则终止（避免无限循环）
3. **可追溯**：每轮的检索-分析-审查结果都记录到 Provenance
4. **用户可控**：可设置最大轮数、可中途暂停

---

## 三、整体架构

### 3.1 流水线从线性改为迭代

```
┌─────────────────────────────────────────────────────────┐
│  Round 1                                                │
│  planning → search → acquire → parse → clean →          │
│  analyze → review → [IterationDecisionAgent]            │
│                                   │                     │
│                          ┌────────┴────────┐            │
│                          │                 │            │
│                       继续(有gap)       终止(收敛)       │
│                          │                 │            │
│                          ▼                 ▼            │
│  Round 2: search'(补充) → ... → review'    │            │
│                          │                 │            │
│                          ▼                 ▼            │
│                     [IterationDecision]   export        │
│                          │                              │
│                          ▼                              │
│  Round 3: ... (直到收敛或达到 max_rounds)               │
└─────────────────────────────────────────────────────────┘
```

### 3.2 新增 Agent：IterationDecisionAgent

**职责**：每轮 review 后，决定是否需要下一轮检索

**输入**：
- 研究目标
- 当前所有轮次的累计记录数、数据源覆盖
- planning 阶段识别的实体 vs 各轮 analysis 实际验证的实体
- reviewer 的质量评估与建议
- 已执行的轮数

**输出**（JSON）：
```json
{
  "should_continue": true,
  "reason": "MMP9/STAT1/NFKB1 三个规划基因未在 PPI 网络中出现，需补充检索",
  "next_round_queries": [
    "MMP9 pancreatic cancer liver metastasis",
    "STAT1 signaling pancreatic cancer",
    "NFKB1 metastasis mechanism"
  ],
  "next_round_sources": ["pubmed", "openalex"],
  "target_entities": ["MMP9", "STAT1", "NFKB1"],
  "convergence_signals": [
    "前 3 轮新增记录数递减：269 → 45 → 8",
    "核心基因已全部在 PPI 网络中验证"
  ]
}
```

### 3.3 收敛条件（任一满足即终止）

| 条件 | 说明 |
|------|------|
| 新增记录数 < 阈值 | 如第 N 轮新增 < 5 条，说明检索已饱和 |
| 规划实体全部验证 | planning 识别的基因/化合物都在 analysis 中出现 |
| LLM 判断无 gap | IterationDecisionAgent 返回 `should_continue=false` |
| 达到最大轮数 | 默认 `max_rounds=3`，防止无限循环 |
| 新增信息重复 | 新一轮记录与已有记录去重后，重复率 > 80% |

---

## 四、实施细节

### 4.1 Orchestrator 改造

```python
# orchestrator.py
class Orchestrator:
    MAX_ROUNDS = 3

    async def run(self, task: Task, progress):
        context = await self._stage_planning(task, progress)

        verified_entities: set[str] = set()
        all_records: list[dict] = []

        for round_idx in range(1, self.MAX_ROUNDS + 1):
            # 执行一轮完整流水线
            records = await self._run_pipeline_round(
                task, context, progress, round_idx
            )
            all_records.extend(records)

            # 迭代决策
            decision = await self._iteration_decision(
                task, context, all_records, verified_entities, round_idx
            )

            if not decision["should_continue"]:
                logger.info("迭代收敛于第 %d 轮: %s", round_idx, decision["reason"])
                break

            # 准备下一轮的查询
            context["search_queries"] = decision["next_round_queries"]
            context["target_entities"] = decision["target_entities"]

        # 最终 export
        await self._stage_export(task, all_records, context, ...)
```

### 4.2 每轮的检索策略

| 轮次 | 检索策略 |
|------|----------|
| Round 1 | 用 planning 阶段 LLM 生成的 search_queries（广撒网） |
| Round 2 | 用 IterationDecisionAgent 针对"未验证实体"生成的精准查询 |
| Round 3 | 引用追溯（前两轮关键文献的参考文献/被引文献） |

### 4.3 去重与累积

- 每轮的新记录与 `all_records` 去重（用 `duplicate_detector`）
- 累积记录数用于收敛判断
- Provenance 记录每轮的检索参数与结果

---

## 五、需要调整 ARCHITECTURE.md 的部分

> **标注**：以下章节需要新增/修改到 ARCHITECTURE.md

### 5.1 新增章节：多轮迭代流水线

在"三、核心架构"之后新增"3.5 多轮迭代流水线"：

```
## 3.5 多轮迭代流水线（Multi-Round Iterative Pipeline）

### 设计动机
单轮流水线无法根据 LLM 审查反馈补充检索。多轮迭代允许系统在每轮 review 后，
由 IterationDecisionAgent 决定是否针对"未验证实体"或"信息缺口"追加检索。

### 流程
planning → [Round N: search → analyze → review → IterationDecision] → export

### 收敛条件
- 新增记录数 < 阈值
- 规划实体全部验证
- LLM 判断无 gap
- 达到 max_rounds（默认 3）

### 新增组件
- IterationDecisionAgent（backend/app/agents/iteration_decision.py）
- Orchestrator 改为循环结构
- Provenance 支持记录每轮迭代
```

### 5.2 修改章节：3.1 流水线架构

当前 3.1 描述的是单轮线性流水线，需改为：

```
PIPELINE = ('planning',)  # planning 只执行一次
ROUND_PIPELINE = ('search', 'acquire', 'parse', 'clean', 'analyze', 'review', 'iteration_decision')
# ROUND_PIPELINE 循环执行，直到收敛
FINAL_PIPELINE = ('export',)  # export 只在最后执行一次
```

### 5.3 修改章节：3.1.9 Orchestrator

Orchestrator 从"单轮调度"改为"迭代调度"，新增：
- `MAX_ROUNDS` 配置
- `_run_pipeline_round()` 方法
- `_iteration_decision()` 方法
- 收敛判断逻辑

### 5.4 新增 Agent：3.1.10 IterationDecisionAgent

```
## 3.1.10 IterationDecisionAgent

职责：每轮 review 后，基于 LLM 决定是否继续迭代。

输入：研究目标、累计记录、规划实体、已验证实体、reviewer 建议、轮次
输出：{
  should_continue: bool,
  reason: str,
  next_round_queries: [str],
  target_entities: [str]
}

LLM Prompt 策略：
- 列出"规划但未验证"的实体（gap 分析）
- 列出前几轮的新增记录趋势（是否收敛）
- 让 LLM 判断是否值得继续，以及下一轮该查什么
```

### 5.5 修改章节：Provenance

Provenance 需支持记录每轮迭代：

```
operation_type 新增：
- "iteration_round"：标记一轮迭代的开始/结束
- "iteration_decision"：记录 IterationDecisionAgent 的决策
```

---

## 六、与现有组件的关系

| 现有组件 | 多轮迭代下的变化 |
|----------|-----------------|
| Orchestrator | 从单轮线性改为循环调度 |
| SearchAgent | 每轮用不同查询（Round 1 广撒网，Round 2+ 精准补充） |
| AnalysisAgent | 每轮重新分析累积记录，输出"已验证实体"集合 |
| ReviewerAgent | 每轮审查，输出建议供 IterationDecisionAgent 使用 |
| LLMReporter | 只在最终轮执行，整合所有轮次的记录与分析 |
| Provenance | 记录每轮的检索参数、新增记录、决策结果 |
| **新增** IterationDecisionAgent | 核心决策组件 |

---

## 七、风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 无限循环 | `MAX_ROUNDS=3` 硬限制 + 收敛条件判断 |
| LLM 误判"需要继续"导致冗余检索 | 新增记录数阈值 + 重复率判断 |
| 每轮重新分析开销大 | 增量分析：只分析新增记录，与旧结果合并 |
| 多轮记录膨胀 | 每轮去重 + 最终 export 时按相关性排序截断 |

---

## 八、实施路线图

| 阶段 | 内容 | 依赖 |
|------|------|------|
| 1 | 实现 IterationDecisionAgent | 无 |
| 2 | Orchestrator 改为循环结构 | 阶段 1 |
| 3 | SearchAgent 支持每轮不同查询 | 阶段 2 |
| 4 | Provenance 记录迭代轮次 | 阶段 2 |
| 5 | 更新 ARCHITECTURE.md（按第五节） | 阶段 2 |
| 6 | 前端展示多轮迭代进度 | 阶段 4 |

---

## 九、与漏检分析文档的关系

[literature_search_gap_analysis.md](file:///d:/Code/BioMedQAgent/docs/literature_search_gap_analysis.md)
聚焦**单轮检索的覆盖度**，本文档聚焦**多轮迭代的决策**。

建议实施顺序：
1. 先落地漏检分析的 P0（多查询并行 + 增加 max_results）—— 提高单轮命中率
2. 再落地本文档的多轮迭代 —— 在单轮不足时基于 LLM 反馈追加检索

两者结合后，系统具备"单轮广覆盖 + 多轮精准补充"的能力。
