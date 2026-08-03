# Agent 系统改进设计：问题分类、数据流、模型能力与 Prompt 重构

> **⚠️ 本文档已整合至 [RESEARCH_SYSTEM_REVIEW_2026-08-03.md](RESEARCH_SYSTEM_REVIEW_2026-08-03.md)**
>
> 以下内容保留为历史参考，最新综合分析（含 RAGFlow 调研、Pipeline 能力短板、
> 工具能力评估）见上述整合报告。
>
> 日期：2026-08-03
> 背景：基于 ARTIFACT_ANALYSIS 报告的独立科研工作流比对，进一步分析泛化性、
> 数据流架构、模型能力瓶颈，并设计 prompt 的连贯化重构方案。

---

## 一、研究主题分类与策略体系

### 1.1 为什么需要分类

上轮报告中的"共病双侧分解"策略仅适用于"X 与 Y 关联/共病"类主题，无法泛化到
全部研究。不同主题需要不同的检索策略和数据库组合。将初始问题分类，为每类提供
研究思路，能显著提升 agent 工作质量。

### 1.2 五类研究主题与策略

| 类型 | 典型表述 | 核心策略 | 关键数据库 |
|------|---------|---------|-----------|
| **单疾病机制** | "METTL5 在胰腺癌中的作用" | 聚焦单疾病，多数据类型交叉 | GEO+PubMed+Reactome |
| **共病/多表型关联** | "AD 与骨质疏松共病" | 双侧分解 + 共享机制验证 | GEO(双侧)+PubMed+Reactome |
| **药物靶点发现** | "X 疾病的潜在药物靶点" | 基因→化合物→通路三角 | GEO+PubMed+PubChem+Reactome |
| **生物标志物筛选** | "X 疾病的诊断标志物" | GWAS+表达+临床交叉 | GEO+PubMed+GDC |
| **通路网络分析** | "Wnt 信号在 Y 中的作用" | 通路→基因→表达→结构 | Reactome+GEO+PubMed+PDB |

### 1.3 实现方式：prompt 策略指南（非硬编码 skill）

不为每类创建独立 skill——这会增加系统复杂度且分类边界模糊。改为在 prompt 中
提供"研究策略选择指南"，让 agent 根据主题特征自主选择策略模式。

理由：
- 主题分类不是互斥的（一个主题可能同时是"共病"和"通路分析"）
- agent 已有 LLM 推理能力，可以做主题分类
- 硬编码 skill 会导致边界情况无人覆盖
- prompt 指南更灵活，可随模型能力提升逐步简化

---

## 二、Agent 自主调研数据流架构审查

### 2.1 核心发现：数据流断裂

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

**关键问题**：Agent 通过 `find_skill`/`invoke_skill` 调研 PDB/PubChem/GWAS 的
数据**仅存在于对话上下文中**，无法进入 `artifacts/` 目录的正式 CSV 产物。

### 2.2 数据库能力分层（enums.py）

| 数据库 | 能力 | 能否进入 artifacts/ |
|--------|------|-------------------|
| PubMed, GEO, GDC, UCSC_XENA, Reactome | `PIPELINE_SUPPORTED` | ✅ |
| PDB, PubChem, BROWSER | `RESEARCH_ONLY` | ❌ |

`run_research_pipeline` 的 tool.py 会拒绝 `RESEARCH_ONLY` 数据库：
```python
if capability is not SourceCapability.PIPELINE_SUPPORTED:
    rejected.append({...})
```

### 2.3 影响

即使 agent 完美执行多数据库调研（查了 PDB 结构、PubChem 化合物），这些数据：
- ❌ 无法出现在 `main_data.csv` / `dataset_catalog.csv` 等正式产物中
- ❌ 无法通过 Validation Gate 校验
- ✅ 仅能在 agent 的最终文本汇报中口头引用

**这意味着比赛评分时，agent 的多数据库调研成果可能无法计入正式产物。**

### 2.4 解决方案选项

| 方案 | 改动规模 | 效果 |
|------|---------|------|
| A. 将 PDB/PubChem 升级为 PIPELINE_SUPPORTED | 大（需 processing+artifact_build 支持） | 结构化产物完整覆盖 |
| B. 增加 `agent_research_notes.csv` 产物 | 中（新产物 + 验证检查） | agent 调研结果结构化记录 |
| C. 允许 agent write_file 到 artifacts/ | 小（权限调整） | 灵活但绕过验证 |
| **推荐：B** | 中 | 平衡完整性与改动量 |

方案 B 设计：
- Pipeline 完成后，agent 可调用一个 `write_research_notes` 工具
- 将 PDB/PubChem/GWAS 调研结果写入 `artifacts/agent_research_notes.csv`
- 该文件通过一个宽松的验证检查（仅校验 source_id 可追溯）
- 不混入 main_data.csv（保持 pipeline 产物的确定性）

---

## 三、Qwen 模型能力分析与 Prompt 补偿

### 3.1 观察到的模型能力瓶颈

| 瓶颈 | 表现 | 根因 |
|------|------|------|
| **多步推理断裂** | 总结中提到"Wnt/Reactome"但不执行检索 | LLM 在长上下文中丢失中间意图 |
| **假设-验证闭环缺失** | 生成假设后不主动验证 | 模型倾向于"回答"而非"验证" |
| **覆盖率自评估薄弱** | 找到 2 个来源即停止 | 缺少结构化停止条件 |
| **主题分类能力** | 不区分共病 vs 单疾病 | 训练数据中缺少研究方法论 |

### 3.2 Prompt 补偿策略

模型能力不足时，prompt 应提供**结构化脚手架**而非自由推理指南：

1. **结构化检查清单**（替代自由文本"覆盖率自评估"）：
   - 进入 Pipeline 前，agent 必须在文本中明确回答：
     "已查询数据库：[列出]。未查询但相关的：[列出或'无']。"
   - 这比"在心里过一遍清单"更可执行

2. **强制策略审查节点**（已有 review_query_strategy，需增强）：
   - 当前 reviewer 只审查 query log
   - 增强：reviewer 应检查"是否有与主题相关但未查询的数据库类型"

3. **研究策略选择指南**（替代补丁式的"共病分解"小节）：
   - 提供五类主题的识别特征和对应策略
   - agent 根据主题特征自主选择，而非硬编码"如果是共病则..."

### 3.3 不依赖模型能力的确定性保障

某些关键检查不应依赖 LLM 推理，应由系统确定性执行：
- 验证门禁的 `core_data_existence`（已实现）
- Pipeline 返回值中的 `download_log` 失败检测（已有）
- 数据库覆盖数统计（可由 review_query_strategy 工具确定性计算）

---

## 四、Prompt 重构方案

### 4.1 当前 prompt 的补丁式问题

上轮修改在 `INSTRUCTIONS` 中硬加了三个独立小节：
- "多数据库联合检索要求（数据查找完备性）"
- "共病/多表型主题的双侧分解"
- "数据可用性预检"

这些小节与原有的"工作流程"、"主题→数据库决策参考"等不连贯，是典型的补丁式修改。

### 4.2 重构原则

1. **连贯化**：将分散的规则整合进工作流程的自然阶段
2. **泛化**：将"共病分解"泛化为"研究策略选择"（覆盖五类主题）
3. **结构化**：用检查清单替代自由文本指南
4. **精简**：去除重复内容，合并同类规则

### 4.3 重构后的结构

```
## 你的角色（精简，强调项目经理+研究员双角色）
## 工作流程（6步，每步内嵌策略指导）
  1. 理解问题 → 主题分类（五类）+ 策略选择
  2. 制定策略 → 数据库选择 + 机制驱动检索
  3. 检索发现 → 多数据库覆盖门禁（≥3个）+ 覆盖率检查清单
  4. 数据获取 → 数据可用性预检
  5. 结构化整理 → run_research_pipeline
  6. 汇报发现 → 引用产物 + 调研发现
## 检索策略与失败处理（合并原有内容）
## Pipeline 调用与失败处理（合并原有内容）
## 上下文管理（保留）
## 工具使用协议（合并动态 skill + 图表 + 视觉采集）
## 输出精简指南（保留）
```

关键变化：
- "主题→数据库决策参考" + "多数据库联合检索要求" → 合并进工作流程第1-3步
- "共病/多表型主题的双侧分解" → 泛化为工作流程第1步的"主题分类与策略"
- "数据可用性预检" → 融入工作流程第4步
- 删除独立的补丁式小节

### 4.4 数据流问题的 prompt 处理

由于 PDB/PubChem 数据无法进入 artifacts/（§二），prompt 应明确指导 agent：
- RESEARCH_ONLY 数据库（PDB/PubChem）的调研结果用于**汇报发现**，不进入正式产物
- 调研结果可用 `write_file` 保存到工作目录供汇报引用
- 正式产物（artifacts/）由 Pipeline 的 PIPELINE_SUPPORTED 数据库生成

---

## 五、工具侧覆盖差距分析

### 5.1 独立科研工作流 → 工具映射

| 工作流阶段 | 需要的能力 | 当前工具状态 | 差距 |
|-----------|-----------|-------------|------|
| 问题边界界定 | 主题分类 + 策略选择 | ❌ 无工具，靠 prompt | prompt 指南 |
| 文献锚定 | PubMed 综述检索 | ✅ search_pubmed | - |
| 机制假设生成 | 从综述提取候选机制 | ❌ 无结构化工具 | 靠 LLM 推理 |
| 基因-疾病双向验证 | 基因×疾病交叉检索 | ❌ 无专门工具 | 靠多次 search |
| 多数据库交叉发现 | PDB/Reactome/PubChem 检索 | ✅ find_skill/invoke_skill | 数据无法进产物 |
| 数据可用性预检 | GSE supplementary 文件检查 | ❌ 无工具 | 需新增 |
| 覆盖率自评估 | 数据库覆盖矩阵 | ⚠️ review_query_strategy 部分 | 需增强 |
| 跨组织整合 | 多源字段对齐 | ✅ Pipeline processing | 仅限 PIPELINE_SUPPORTED |

### 5.2 优先补齐的工具（按 ROI 排序）

1. **数据可用性预检工具**（高 ROI，防止 404 空心化）
2. **覆盖率报告增强**（中 ROI，让 reviewer 确定性计算数据库覆盖数）
3. **agent_research_notes 产物**（中 ROI，让 PDB/PubChem 数据进入正式产物）
4. **共享基因交叉验证工具**（低 ROI，LLM 多步推理可部分替代）
