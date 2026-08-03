# 生物医学研究系统综合评估报告

> **日期**：2026-08-03
> **范围**：系统产物审查 → 独立科研工作流比对 → 研究主题分类泛化 →
> 数据流架构分析 → Pipeline 能力短板 → 工具能力评估

---

## 一、执行摘要

基于 AD/OP 共病案例的产物审查和同主题独立科研比对，发现系统在**来源可追溯性**
方面达标，但在**数据查找完备性**（覆盖率 ~2.5%）、**清洗整合可靠性**（核心数据
100% 缺失却通过验证）和**输出内容实质性**（main_data 全空）三个维度严重不足。

本轮工作聚焦四个方向：

1. **研究主题分类泛化**：将"共病双侧分解"泛化为五类主题策略，调研 RAGFlow 确认
   该模式与 Agentic RAG 的 query routing 同构
2. **数据流架构分析**：确认 RESEARCH_ONLY 数据库无法进入 artifacts 是架构设计而非
   bug，核心矛盾是 pipeline 能力太弱而非数据流断裂
3. **Pipeline 能力短板**：识别 5 大确定性短板，按 ROI 排序设计改进
4. **工具能力评估**：区分"必须工具实现"与"可 prompt 引导"，补充高价值工具建议

---

## 二、系统产物审查结论（详见 0802 报告）

### 2.1 核心缺陷

| # | 缺陷 | 根因 | 已修复 |
|---|------|------|--------|
| 1 | 表达数据下载 404，Pipeline 以空数据继续 | 无下载回退策略 | ❌ 见 §六 |
| 2 | main_data.csv 核心字段 100% 缺失 | `_build_minimal_parsed_dataset` 占位符 | ❌ 见 §六 |
| 3 | 验证门禁未检测核心数据缺失 | `main_data_nonempty` 仅查行数 | ✅ `core_data_existence` |
| 4 | dataset_catalog database 字段错误 | sources[0] 取 PubMed 而非 GEO | ✅ catalog.py |
| 5 | GEO 数据集与主题不匹配 | Agent 未充分 vetting GSE | ⚠️ prompt 引导 |

### 2.2 数据覆盖率

| 数据类别 | 系统发现 | 独立科研发现 | 覆盖率 |
|----------|---------|-------------|--------|
| PubMed 文献 | 1 篇 | 15+ 篇 | ~7% |
| GEO 数据集 | 1 个(仅 AD) | 23+ 个(AD+OP) | ~4% |
| GWAS/PDB/Reactome/PubChem | 0 | 36+ | 0% |
| **总计** | **2 来源** | **80+ 数据点** | **~2.5%** |

---

## 三、独立科研工作流与阻力分析（详见 0802 报告 §十一-十二）

### 3.1 七阶段闭环工作流

```
问题边界界定 → 文献锚定(综述优先) → 机制假设生成
→ 基因-疾病双向验证 → 多数据库交叉发现
→ 数据可用性预检 → 覆盖率自评估(闭环门禁)
```

### 3.2 阻力分层

| 层级 | 阻力 | Agent 表现 | 对策 |
|------|------|-----------|------|
| 认知层 | 主题分类、策略选择 | 不区分共病 vs 单疾病 | ✅ prompt 五类策略 |
| 认知层 | 覆盖率自评估 | 找到 2 源即停止 | ✅ prompt 覆盖门禁 |
| 工具层 | 数据可用性预检 | 无工具，404 后才知 | ❌ 见 §七 |
| 工具层 | PDB/PubChem 数据进产物 | RESEARCH_ONLY 无法进入 | 见 §五 |
| 流程层 | 下载失败无回退 | 空数据继续 | ❌ 见 §六 |
| 流程层 | series matrix 仅元数据 | 表达值无法提取 | ❌ 见 §六 |

---

## 四、研究主题分类与策略泛化

### 4.1 RAGFlow 调研结论

[RAGFlow](https://github.com/infiniflow/ragflow) 是 InfiniFlow 开发的 RAG 引擎
（74k+ Star），核心定位是"基于深度文档理解构建 AI Agent 上下文层"。

**协作者提到的"主题分类"指 RAGFlow 的 Categorize 组件**——Agent 工作流中的
查询意图分类节点，将用户问题路由到不同知识库：

```
Begin → Categorize
├─ "技术问题" → Retrieval(技术知识库) → Generate
├─ "商务咨询" → Retrieval(商务知识库) → Generate
└─ "闲聊" → Message → Answer
```

这是 Agentic RAG 的标准 **Query Routing** 模式：LLM 分析查询意图 → 分类 →
路由到最优检索策略。业界已有成熟分类体系（factual / analytical / comparison /
temporal / opinion）和结构化输出方案（Pydantic schema + LLM classification）。

**与我们的系统对比**：

| 维度 | RAGFlow | BioMedQAgent |
|------|---------|-------------|
| 分类对象 | 查询意图（技术/商务/闲聊） | 研究主题（单疾病/共病/靶点/标志物/通路） |
| 路由目标 | 预索引文档知识库 | 实时生物医学 API |
| 实现方式 | 可视化工作流编排（Categorize 组件） | prompt 内嵌策略指南 |
| 分类确定性 | LLM 分类 + 确定性路由 | LLM 自主选择策略 |

**结论**：
- 我们的五类主题分类与 RAGFlow 的 Categorize 同属 Agentic RAG 模式，方向正确
- RAGFlow 检索预索引文档，我们检索实时 API，架构不同，无需照搬 RAGFlow 的
  文档解析/RAG 管道
- RAGFlow 的确定性路由（分类后固定路由）可启发我们：未来若 prompt 引导不足，
  可考虑系统级主题分类器（确定性分类 → 策略模板注入），但当前 prompt 方案
  足够，无需增加系统复杂度
- **本轮不做实质修改**，仅记录调研结论

### 4.2 五类研究主题策略（已实施于 agent.py prompt）

| 类型 | 典型表述 | 核心策略 | 关键数据库 |
|------|---------|---------|-----------|
| 单疾病机制 | "METTL5 在胰腺癌中的作用" | 聚焦单疾病，多数据类型交叉 | GEO+PubMed+Reactome |
| 共病/多表型关联 | "AD 与骨质疏松共病" | 双侧分解 + 共享机制验证 | GEO(双侧)+PubMed+Reactome |
| 药物靶点发现 | "X 疾病的潜在药物靶点" | 基因→化合物→通路三角 | GEO+PubMed+PubChem+Reactome |
| 生物标志物筛选 | "X 疾病的诊断标志物" | GWAS+表达+临床交叉 | GEO+PubMed+GDC |
| 通路网络分析 | "Wnt 信号在 Y 中的作用" | 通路→基因→表达→结构 | Reactome+GEO+PubMed+PDB |

实现方式：prompt 内嵌策略指南（非硬编码 skill），agent 根据主题特征自主选择。
理由：主题分类不互斥，硬编码 skill 会导致边界情况无人覆盖。

---

## 五、数据流架构分析

### 5.1 数据流现状

```
Agent 调研路径                    Pipeline 产物路径
───────────────                   ─────────────────
search_pubmed → 对话上下文         run_research_pipeline
search_geo   → 对话上下文              ↓
find_skill(pdb) → 对话上下文        discovery → acquisition → processing
find_skill(pubchem) → 对话上下文        → artifact_build → validation
                                        ↓
                                   artifacts/*.csv（正式产物）
```

**关键事实**：Agent 通过 `find_skill`/`invoke_skill` 调研 PDB/PubChem/GWAS 的
数据仅存在于对话上下文中，无法进入 `artifacts/` 正式 CSV 产物。

### 5.2 这是设计而非 Bug

ARCHITECTURE.md §2.5 明确规定：

> Agent-only 数据源不自动等同于 Pipeline 支持；`pipeline_supported` 只表示该来源
> 已经完成相应的搜索、元数据、下载、解析和验证闭环。

`SOURCE_CAPABILITIES` 单一事实表声明：
- **PIPELINE_SUPPORTED**：PubMed, GEO, GDC, UCSC_XENA, Reactome
- **RESEARCH_ONLY**：PDB, PubChem, Browser

`run_research_pipeline` 的 tool.py 按 capability 表拒绝 RESEARCH_ONLY 数据库。
这是为了保持 Pipeline 的确定性特质——每个数据源都有完整的 search → metadata →
download → parse → validate 闭环。

### 5.3 核心矛盾：Pipeline 能力不足，而非数据流设计错误

用户洞察（2.2）准确：**即使 LLM 注入了有关参数，pipeline 也无法获取足够完整的
科研数据**。问题不在数据流设计（RESEARCH_ONLY 隔离是合理的），而在 pipeline
自身能力太弱：

1. GEO 仅支持单数据集，无法处理多数据集交叉
2. 下载失败无回退，一个 404 就导致整个产物空心化
3. series matrix 仅提取样本 ID，表达值无法解析
4. PubMed 仅处理单篇文献
5. Reactome 仅支持单通路且必须作为唯一来源

**因此本轮优先提升 pipeline 工作能力（用户指示 2.3），数据流通道扩展（方案 B）
暂缓**。

### 5.4 方案 B 设计（暂不实施，记录备查）

当 pipeline 能力提升后，可增加 `agent_research_notes.csv` 产物通道：
- Pipeline 完成后，agent 调用 `write_research_notes` 工具
- 将 PDB/PubChem/GWAS 调研结果写入 `artifacts/agent_research_notes.csv`
- 该文件通过宽松验证（仅校验 source_id 可追溯）
- 不混入 main_data.csv（保持 pipeline 产物的确定性）

与 ARCHITECTURE.md §5 的 `agent_results/` 概念一致，但升级为正式产物。

---

## 六、Pipeline 能力短板与改进优先级

### 6.1 能力短板清单

| # | 短板 | 影响 | 当前代码位置 | 严重度 |
|---|------|------|-------------|--------|
| 1 | 下载失败无回退 | 404 → 空数据 → 空心产物 | acquisition.py | P0 |
| 2 | series matrix 仅解析样本元数据 | 表达值无法提取 | processing.py `_build_minimal_parsed_dataset` | P0 |
| 3 | GEO 单数据集限制 | 无法交叉验证 | discovery.py `_resolve_gse` | P1 |
| 4 | PubMed 仅单篇文献 | 覆盖率极低 | discovery.py `_search_pubmed_with_fallback` | P1 |
| 5 | 无数据可用性预检 | Agent 无法提前判断 GSE 是否可下载 | 无（需新增） | P1 |

### 6.2 关键代码证据

**短板 1：下载失败无回退**

[acquisition.py](file:///d:/Code/BioMedQAgent/backend/app/pipeline/stages/acquisition.py)
构建 GEO supplemental counts URL 后直接下载，404 时不尝试替代 URL 或数据集。

**短板 2：series matrix 仅解析样本元数据**

[processing.py](file:///d:/Code/BioMedQAgent/backend/app/pipeline/stages/processing.py)
的 `_build_minimal_parsed_dataset` 在 tximport 解析失败时，从 series matrix 提取
样本 ID 作为 `metadata_only` 行，表达值字段全部留空。

**短板 3：GEO live 模式刻意拒绝 topic 搜索**

[discovery.py](file:///d:/Code/BioMedQAgent/backend/app/pipeline/stages/discovery.py)
`run_discovery` 函数在 live 模式下当 `gse is None` 时直接 `raise LookupError`，
注释标明"Issue #2: the pipeline must not auto-search GEO by topic"。
`_search_geo_with_fallback` 函数存在但因前置检查而成为死代码。

### 6.3 改进优先级（按 ROI 排序）

| 优先级 | 改进 | ROI 理由 | 改动规模 |
|--------|------|---------|---------|
| P0 | series matrix 表达值解析器 | 直接解决 main_data 空心化 | 中 |
| P0 | 下载失败回退 + HIL | 防止单点 404 导致全产物废弃 | 中 |
| P1 | 数据可用性预检工具 | Agent 提前 vetting GSE，减少无效 pipeline 调用 | 小 |
| P1 | PubMed 多篇文献支持 | 覆盖率从 ~7% 提升 | 中 |
| P2 | GEO 多数据集支持 | 交叉验证能力 | 大 |

---

## 七、工具能力评估

### 7.1 必须工具实现（确定性，不可依赖 LLM 推理）

| 能力 | 理由 | 当前状态 |
|------|------|---------|
| 下载失败回退 | 404 是确定性事件，LLM 无法干预 | ❌ 未实现 |
| series matrix 表达值解析 | 解析是确定性操作，非推理 | ❌ 仅元数据 |
| 数据可用性预检 | HTTP HEAD 检查是确定性操作 | ❌ 未实现 |
| 核心数据存在性验证 | 验证门禁必须确定性 | ✅ 已实现 |
| 覆盖率确定性统计 | 统计 query_log 是确定性操作 | ⚠️ 部分（reviewer） |

### 7.2 可由 prompt 引导（LLM 推理能力）

| 能力 | 理由 | 当前状态 |
|------|------|---------|
| 研究主题分类 | LLM 推理能力足够 | ✅ 五类策略 |
| 机制驱动检索策略 | LLM 从综述提取候选基因 | ✅ prompt 指导 |
| 覆盖率自评估 | LLM 检查"已查询/未查询" | ✅ 覆盖门禁 |
| 基因-疾病双向验证 | LLM 多步推理 | ✅ prompt 指导 |

### 7.3 高价值工具建议（未实现）

| # | 工具 | 价值 | 实现代价 |
|---|------|------|---------|
| 1 | GEO supplementary 文件可用性检查 | 防止 404 空心化，Agent 可提前 vetting | 小（HTTP HEAD） |
| 2 | GEO series matrix 表达矩阵解析器 | 从 series_matrix.txt 提取表达值，不依赖 tximport | 中（解析器） |
| 3 | PubMed 批量检索 + 综述优先 | 覆盖率从 1 篇提升到多篇 | 中（discovery 扩展） |
| 4 | 下载失败 HIL 机制 | Agent 可请求用户选择替代数据集 | 中（HIL 集成） |
| 5 | Reactome 多通路支持 | 通路网络分析类主题需要 | 中（去掉单源限制） |

---

## 八、本轮已实施的改动

| 改动 | 文件 | 类型 |
|------|------|------|
| 验证门禁 `core_data_existence` 检查 | validation/checks/main_data.py | P0 已实施 |
| 修复 catalog.py database 字段错误 | artifact_build/catalog.py | P0 已实施 |
| Agent prompt 连贯化重构（五类策略 + 数据流） | agent_loop/agent.py | P1 已实施 |
| 更新 test_validation_split.py 黄金序列 | tests/pipeline/test_validation_split.py | P0 已实施 |
| 更新 test_agent_build.py 断言 | tests/agent_loop/test_agent_build.py | 配套 |

### 8.1 Agent prompt 重构详情

将补丁式独立小节（"多数据库联合检索要求"、"共病双侧分解"、"数据可用性预检"）
重构为连贯的六步工作流：

1. **理解问题并选择研究策略**：内嵌五类主题分类
2. **制定检索策略**：机制驱动，非关键词驱动
3. **检索发现**：多数据库覆盖门禁（≥3 个）
4. **数据获取与可用性预检**：成熟数据集优先
5. **结构化整理**：调用 run_research_pipeline
6. **汇报发现**：引用产物实际文件名

新增"数据库与数据流"小节，明确 RESEARCH_ONLY 数据库的调研结果不进入正式产物。

---

## 九、后续设计（需确认后实施）

### 9.1 series matrix 表达值解析器（P0，建议优先）

**问题**：当 tximport counts 文件 404 时，`_build_minimal_parsed_dataset` 仅从
series matrix 提取样本 ID，表达值全部留空。

**方案**：解析 `series_matrix.txt` 中的表达矩阵块（`!series_matrix_table_begin`
到 `!series_matrix_table_end`），提取基因 × 样本表达值。

**改动**：扩展 `processing.py` 的 GEO 处理路径，当 tximport 失败时回退到
series matrix 解析（而非仅提取元数据）。

### 9.2 下载失败回退 + HIL（P0）

**问题**：HTTP 404 后无替代策略，空数据继续。

**方案**：
1. 下载失败时，在 `download_log.csv` 标记 failed
2. Pipeline 返回 `status="download_failed"` + 失败详情
3. Agent 收到后可选择替代 GSE 重试，或请求 HIL 让用户选择

### 9.3 数据可用性预检工具（P1）

**问题**：Agent 无法提前判断 GSE 的 supplementary 文件是否可下载。

**方案**：新增 `check_geo_availability(gse)` 工具，HTTP HEAD 检查
supplementary 文件 URL，返回可用性报告。

### 9.4 方案 B：agent_research_notes 产物通道（暂缓）

当 pipeline 能力提升后实施，详见 §5.4。

---

## 十、结论

系统的核心问题不是数据流设计错误（RESEARCH_ONLY 隔离是合理的），而是 **pipeline
自身能力不足**——即使 Agent 完美执行多数据库调研，pipeline 也无法将调研成果
转化为完整的正式产物。

改进优先级：
1. **series matrix 表达值解析器**（P0）——直接解决 main_data 空心化
2. **下载失败回退 + HIL**（P0）——防止单点 404 废弃整个产物
3. **数据可用性预检工具**（P1）——Agent 提前 vetting，减少无效调用
4. **PubMed 多篇 + GEO 多数据集**（P1-P2）——提升覆盖率

研究主题分类（五类策略）已通过 prompt 实施，与 RAGFlow 的 Categorize 同属
Agentic RAG 模式，方向正确，本轮不做实质修改。
