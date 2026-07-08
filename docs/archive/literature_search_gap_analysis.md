# 文献检索漏检分析与改进方案

> 状态：**P0/P1/P2(部分) 已实施**（R5 中文数据库待爬虫基础设施）
> 创建时间：2026-07-08
> 最后更新：2026-07-08（P1 组合查询 + 引用追溯 / P2 MeSH + 智能 fallback 落地）
> 关联问题：LLM 报告中"引入更多数据源，比如 PubMed"建议与实际矛盾 → 暴露检索覆盖不足

---

## 一、问题背景

在"健脾散结方对胰腺癌肝转移"任务中，LLM 报告建议"引入 PubMed 等医学数据库"，
但实际日志显示已检索 PubMed/OpenAlex/Semantic Scholar。经排查，根因有二：

1. **LLM 报告层**：未明确告知 LLM 已检索的数据源（已在 `llm_reporter.py` 修复）
2. **检索算法层**：虽然检索了 PubMed，但检索方式存在显著漏检风险，导致实际命中的
   相关文献很少，LLM 从记录样本中看不出"已充分检索 PubMed"的特征

本文档聚焦第 2 点：**检索算法的漏检风险与改进方案**。

---

## 二、当前检索流程

```
planning 阶段：LLM 生成 search_queries（通常 3-5 个）
  ↓
SearchAgent.execute():
  Step 1: 文献数据源用 primary_query（queries[0]）并行检索
    - pubmed / openalex / semantic_scholar / arxiv
    - 每个源 max_results=15 条
  Step 2: 实体数据源用 gene/compound/disease 查询
  Step 3: 若记录 < 5 条，用 fallback_queries 重试（最多 4 个）
```

**关键代码位置**：[backend/app/agents/search.py](file:///d:/Code/BioMedQAgent/backend/app/agents/search.py#L49-L58)

---

## 三、漏检风险分析

| # | 风险点 | 当前实现 | 漏检场景 | 严重度 |
|---|--------|---------|----------|--------|
| R1 | **只用 primary_query 检索文献** | `queries[0]` | LLM 生成 5 个查询，但只用第 1 个。queries[1:] 仅在记录<5 时才作为 fallback 使用 | **高** |
| R2 | **单次查询无分页** | `max_results=15` | PubMed 实际有数百篇相关文献，只取前 15 篇 | **高** |
| R3 | **无 MeSH/关键词组合** | 单字符串查询 | "健脾散结方 胰腺癌 肝转移"作为单查询，无法利用 PubMed MeSH 术语精准检索 | 中 |
| R4 | **无引用追溯** | 仅直接检索 | 找到关键文献后，不追溯其参考文献/被引文献（系统综述核心方法） | 中 |
| R5 | **无中文数据库** | 仅英文源 | CNKI/万方有大量健脾散结方相关中文文献，完全未覆盖 | 中 |
| R6 | **实体查询不深入** | 单基因查询 | "TP53" 单独查询，无 "TP53 AND pancreatic cancer" 组合 | 中 |
| R7 | **无 PMID 直接获取** | 无 | 用户已知关键 PMID 时无法直接获取 | 低 |
| R8 | **fallback 阈值过低** | `< 5 条` | 269 条记录但全是不相关文献时不会触发 fallback | 低 |

---

## 四、改进方案（按优先级）

### P0 — 多查询并行检索（改动小，收益大）

**问题**：R1，只用 `queries[0]`

**方案**：对 LLM 生成的每个查询都检索，合并去重

```python
# search.py Step 1 改进
all_lit_records = []
for q in queries[:5]:  # 用前 5 个查询
    results = await self._to_thread(
        self.tools.run_datasources_parallel,
        lit_sources, q,
        max_results=task.max_sources,
        task_id=task.task_id,
    )
    # 合并结果，后续由 duplicate_detector 去重
    for src_name, result in results.items():
        if result.success:
            all_lit_records.extend(result.data or [])
```

**预期收益**：检索覆盖率提升 3-5 倍（5 个查询 vs 1 个查询）

### P0 — 增加 max_results

**问题**：R2，`max_results=15` 太少

**方案**：
- 默认 `max_results=30`
- planning 阶段 LLM 可根据研究领域动态决定（如综述类任务设 50）

### P1 — 组合查询生成

**问题**：R3、R6，单字符串查询精度不足

**方案**：在 planning 阶段或 search 阶段生成组合查询

```python
# 基因 × 疾病 组合
for gene in entities["genes"][:5]:
    for disease in entities["diseases"][:2]:
        combo_queries.append(f"{gene} AND {disease}")

# 复方成分 × 疾病
for compound in entities["compounds"][:3]:
    combo_queries.append(f"{compound} AND pancreatic cancer")
```

### P1 — 引用追溯（需新工具）

**问题**：R4，无引用网络

**方案**：
- 对前 5 篇关键文献，用 OpenAlex API 获取 `referenced_works`（参考文献）
- 对前 5 篇关键文献，用 `cited_by_api_url` 获取被引文献
- 新增 `backend/app/tools/analysis/citation_trace.py`

### P2 — 中文数据库（需爬虫）

**问题**：R5，无中文源

**方案**：
- CNKI/万方无公开 API，需浏览器爬虫
- 对接 AcquireAgent（已有爬虫隔离占位）
- 关键词用中文，结果由 parser 阶段解析

### P2 — MeSH 术语查询

**问题**：R3，未利用 MeSH

**方案**：
- 用 NCBI E-utilities 的 MeSH 数据库把"胰腺癌"转成 `MeSH:Pancreatic Neoplasms`
- PubMed 查询时用 `MeSH Terms` 字段精准检索

### P2 — 智能 fallback 阈值

**问题**：R8，`< 5 条`阈值过低

**方案**：
- 不只看数量，还看相关性（title 抽样判断是否与研究目标相关）
- 若 269 条但前 20 条 title 都不含关键词，触发 fallback

---

## 五、实施路线图

| 阶段 | 内容 | 预期收益 | 状态 |
|------|------|----------|------|
| 第一波 | P0：多查询并行 + 增加 max_results | 覆盖率 3-5x | ✅ 已实施（search.py Step 1） |
| 第二波 | P1：组合查询 + 引用追溯 | 精度提升 + 系统综述能力 | ✅ 已实施（search.py Step 3/4 + citation_trace.py） |
| 第三波 | P2：MeSH + 智能 fallback | 精准检索 + 质量保障 | ✅ 已实施（search.py Step 4 + _build_mesh_queries） |
| 第四波 | P2：中文数据库（CNKI/万方） | 中文文献覆盖 | ⏳ 待爬虫基础设施（AcquireAgent 对接） |

### 实施细节

**P1 组合查询**（[search.py:_build_combo_queries](file:///d:/Code/BioMedQAgent/backend/app/agents/search.py)）：
- top 3 基因 × top 1 疾病 → `"TP53 AND pancreatic cancer"`
- top 2 化合物 × top 1 疾病 → `"curcumin AND pancreatic cancer"`

**P1 引用追溯**（[citation_trace.py](file:///d:/Code/BioMedQAgent/backend/app/tools/datasources/citation_trace.py)）：
- 取已检索文献中含 openalex_id 的 top 5 高被引作为种子
- 批量获取种子 `referenced_works`（参考文献）+ `filter=cites:Wxxx`（被引文献）
- 新增 `ToolRegistry.trace_citations()` facade 方法
- 在 SearchAgent Step 3 调用，需 ≥3 篇种子才触发

**P2 MeSH 术语查询**（[search.py:_build_mesh_queries](file:///d:/Code/BioMedQAgent/backend/app/agents/search.py)）：
- 疾病实体转英文后生成 `"{disease}[MeSH]"` 限定查询
- 仅对 PubMed 执行（MeSH 是 PubMed 特有字段）

**P2 智能 fallback 阈值**（[search.py:_compute_relevance](file:///d:/Code/BioMedQAgent/backend/app/agents/search.py)）：
- 触发条件：`len(records) < 10` 或 `relevance < 0.3`
- 相关性 = 前 20 条采样中 title/abstract 含关键词的比例
- 关键词来源：research_goal 分词 + 实体（基因/化合物/疾病英文）

---

## 六、与多轮迭代的关系

本文档聚焦**单轮检索的覆盖度改进**。[multi_round_search_iteration.md](file:///d:/Code/BioMedQAgent/docs/multi_round_search_iteration.md)
聚焦**多轮检索迭代**（基于 LLM 审查报告决定是否继续检索）。两者互补：

- 单轮改进 = 提高每一轮的命中率
- 多轮迭代 = 在单轮不足时，基于 LLM 反馈追加检索

建议先落地本文档的 P0，再推进多轮迭代设计。
