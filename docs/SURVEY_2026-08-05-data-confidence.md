# SURVEY — 数据置信度（Data Confidence）功能调研与先期设计（2026-08-05）

> 阶段：调研与先期文档（TODO/SURVEY/PLAN 任选其一，本文选 SURVEY + 设计草案）。
> 关联：PROBLEM.md "清洗整合可靠性 / 输出格式可用性" 评分维度；
> 触发：REVIEW_2026-08-05 数据管线审查（P0 静默截断等）与本功能规划。
> 参考方法：学术打假实践（统计学、AI 图像比对、原始数据溯源）。

---

## 1. 背景与动机

### 1.1 赛题评分维度

PROBLEM.md 初赛评价四维度中，"清洗整合可靠性"与"输出格式可用性"直接要求：
产出数据**可分析、可追溯、可复用**。当前 pipeline 已有 validation gate、
cleaning_report、warnings、SourceLocator 等机制，但**缺少对数据"看起来
是否合理"的置信度评估**——数据可能"通过全部校验却仍不可信"（如 GSE102238
的 950MB probe 数据通过验证但无法定位目标基因）。

### 1.2 学术打假方法的启示（"耿同学打假"事件）

近期学术打假实践提供了可直接迁移的检测思路：

| 方法 | 原理 | 迁移到本项目的形态 |
|---|---|---|
| 统计学检测 | 真实数据分布符合自然规律；造假数据常有异常规律（小数位过于规律、异常等差/重复、首位数字分布偏差） | pipeline 确定性统计检测器（Benford、末位数字、常数/等差检测） |
| AI 图像比对 | 不同实验组图片经翻转/裁剪后被重复使用 | 本项目以 CSV 为主，映射为"跨源/跨样本数值重复模式检测" |
| 原始数据溯源 | 粗糙编造在原始数据（supplemental materials）中漏洞百出 | 已有 SourceLocator + lineage 抽样校验；强化为"不可溯源条目不得发布" |

核心教训：**"通过校验" ≠ "数据可信"**。置信度评估应作为 validation gate
的补充层，而非替代。

---

## 2. 数据置信度定义与评估维度

对 pipeline 每条产物（数据集/记录）输出一个确定性置信度画像：

| 维度 | 检测内容 | 现状 | 缺口 |
|---|---|---|---|
| 完整性 | 行数截断（`truncated_rows`）、缺失率、重复率 | ✅ 本轮已加 truncated 可见；cleaning_report 已有缺失/重复 | 无"缺失率超阈值即降置信度"的评分 |
| 统计合理性 | Benford 首位数分布、末位数字均匀性、常数行/等差序列、异常取整 | ❌ 无 | **Phase 1 核心** |
| 溯源可审计性 | 每条记录可回溯到 source asset + 原始行；不可溯源条目计数 | ✅ SourceLocator + lineage 抽样（100 行） | lineage 抽样可能漏检（P2-5）；不可溯源条目无显式计数 |
| 跨源一致性 | 多源同一指标数值交叉验证（如 TCGA vs GEO 同一基因表达） | ❌ 无 | **Phase 3** |
| 解析可靠性 | probe→gene 映射状态（`probe_gene_mapping`）、解析器版本 | ✅ `geo_probe_unmapped` warning 已注入 | 无"unmapped 影响面"的量化 |

---

## 3. 检测方法调研（打假"武器"迁移设计）

### 3.1 统计学检测器（确定性、纯函数、可测试）

**A. Benford 定律（首位数字分布）**
- 原理：自然数据集的首位数字 1 出现 ~30%，9 仅 ~5%；造假/人造数据常偏离。
- 适用：`expression_value` 等大数值列。
- 实现：`stats.py` 或新 `pipeline/processing/confidence.py` 纯函数
  `benford_distance(column_values) -> float`（如 χ² 距离），超阈值打 warning。
- 注意：**Benford 对受边界约束的数据不适用**（如 0-1 归一化值）——需
  `is_benford_applicable` 前置判定（值域跨越 ≥2 个数量级、非负、非归一化）。

**B. 末位数字均匀性（数字指纹）**
- 原理：真实测量值的末位数字近似均匀；造假者常人工输入，末位分布偏斜
  （如大量 0/5 结尾）。
- 适用：非整数测量列。
- 实现：`last_digit_chi2(column_values)` 检验均匀性。

**C. 异常规律检测**
- 常数行/常数段（整列相同值但非标注字段）、等差序列（行间差值恒定且非
  时间/索引列）、重复模式（跨样本数值完全相同）。
- 实现：`detect_constant_column`、`detect_arithmetic_progression`、
  `detect_duplicate_pattern_across_samples`。

### 3.2 原始数据溯源强化（与 data-lineage-and-provenance 对齐）

当前 lineage：`source_id / asset_id / source_line_number / source_column_index`
→ `check_source_value_lineage` 抽样 100 行。
- **缺口 1**：抽样漏检（REVIEW P2-5）→ 抽样数随行数增长（sqrt/对数）。
- **缺口 2**：不可溯源条目不显式计数 → `main_data` 增加
  `lineage_unverified_count` 统计并入置信度。
- **缺口 3**：Agent 层数据（非 pipeline 下载）无 source-of-record → 见 §5。

### 3.3 AI/图像比对（本项目适配）

- 本项目主产物为 CSV，图像比对直接适用面窄；映射为：
  - **跨样本数值重复模式检测**（同列多行值完全相同且非标注）——已归入 3.1C。
  - **跨源数据相似度**（同基因两来源表达谱相关性）——归入"跨源一致性"。

---

## 4. 设计方案（分阶段，最小实现优先）

### Phase 1 — 确定性统计检测器（P1，纯函数 + 接入 pipeline）

- 新增 `app/pipeline/processing/confidence.py`：
  - `benford_distance(values) -> float`
  - `last_digit_chi2(values) -> float`
  - `detect_constant_column(rows, col) -> bool`
  - `detect_arithmetic_progression(rows, col) -> bool`
  - `aggregate_confidence_metrics(cleaning_report, stats) -> ConfidenceModel`
- `ConfidenceModel`：`benford_distance / last_digit_chi2 / constant_columns /
  arithmetic_columns / lineage_unverified_count / overall_score(0-1)`
- processing 阶段对表达值列运行检测器，异常写 `anomaly_flags` +
  `warnings.csv`（code=`statistical_anomaly_*`）；
- 产出新 artifact `confidence_report.csv`（每数据集一行画像）。

### Phase 2 — 置信度评分与门禁（P1）

- `overall_score` 聚合各维度；`confidence_report.csv` 写入 `artifacts/`；
- validation gate 增加 `data_confidence` 检查：`overall_score < 阈值` 时
  `valid_with_warnings`（不阻断发布但强制显式标记）；
- 前端 `ResultsViewer` 展示置信度画像。

### Phase 3 — 跨源一致性（P2）

- 同基因/同指标的多源数值（TCGA vs GEO）相关性检验；
- 仅在多源合并路径（GDC+Xena）启用，不新增单源负担。

### 与 validation gate 的关系

- 置信度是 validation 的**补充信号**，不替代现有 gate；
- 静默截断类问题（P0）由 warning 显式化，置信度评分使其**量化可比较**。

---

## 5. 依赖设计：非 pipeline 数据进入最终成果（与 §3.1 联动）

> 用户规划：实现数据置信度后，推进"非 pipeline 数据进入最终成果"相关 TODO
> （当前 TODO §1.5.5 Agent↔Pipeline 桥接、§2.4 SourceAsset 契约等）。
> 两者存在强依赖，需统一重新设计。

### 5.1 现状与冲突

- pipeline 产物：完整 lineage（SourceLocator）+ validation gate（确定性）；
- Agent 调研数据（`write_file` 保存、`RESEARCH_ONLY` 数据源）：**无
  source-of-record、无 validation**，当前被 agent.py 铁律 2 禁止写入 `artifacts/`；
- 一旦放开"非 pipeline 数据进入最终成果"，必须防止**伪成功通道**
  （LLM 生成内容冒充结构化产物）。

### 5.2 统一设计原则（source-of-record 铁律）

1. **每条进入 `artifacts/` 的记录必须有 source-of-record**：
   - pipeline 下载 → source asset（现有）；
   - Agent 手动调研 → 必须携带 `source_id`（URL/DOI/文件路径）+ 获取时间戳；
2. **置信度评估是准入门槛**：非 pipeline 数据通过 `aggregate_confidence_metrics`
   评估（完整性/统计合理性/溯源）后才能进入最终产物，且**标记 provenance
   等级**（`pipeline_validated` / `agent_research_annotated`）；
3. **派生链记录**：每条非 pipeline 记录携带 `derived_from`（来源）+ 生成
   process 版本（复用 REVIEW 数据溯源模型）；
4. **可重算**：任何来源错误时可按 `source_id` 定位受影响记录（blast radius）。

### 5.3 TODO 重构建议（§1.5.5 + §1.4 + §2.4 关联项合并设计）

将现有分散 TODO 重构为一条主线"**产物来源分级与准入**"：
- **P1** 数据置信度 Phase 1+2（§4）——先决条件；
- **P1** `SourceRecord`/`SourceAsset` 契约扩展到 Agent 手动来源
  （替换 §1.5.5"Agent 获取的原始文件统一注册"）；
- **P1** `provenance_level` 字段（`pipeline_validated` /
  `agent_research_annotated`）+ validation gate 对 annotated 记录的宽松校验
  （必须有 source_id + 时间戳，否则拒绝——防伪成功）；
- **P1** 非 pipeline 数据产出 `confidence_report.csv` 条目（沿用 §4 Phase 2）；
- **P2** Agent 决策日志持久化（现有 §1.5.5 `agent_results/`）。

### 5.4 已否决 / 不推荐

- 放宽 validation gate 使 LLM 内容无来源通过 —— 否决（伪成功通道）；
- 对非 pipeline 数据完全拒绝 —— 现状维持，但阻碍"调研→成果"闭环价值；
- 图像比对作为主检测手段 —— 本项目产物以 CSV 为主，优先数值统计。

---

## 6. 风险与待确认

- **Benford 适用性误报**：需 `is_benford_applicable` 前置判定，避免对
  归一化/边界约束数据误报（P0 级设计细节，实现前确认）。
- **置信度阈值**：初版仅 warning + `valid_with_warnings`，不阻断发布；
  阈值经真实数据集标定后再收紧。
- **性能**：检测器为确定性纯函数，流式单遍可完成；`detect_arithmetic_progression`
  仅在列值域较小时启用，避免 O(n²)。
- **与 0802/0805 REVIEW 的衔接**：lineage 抽样增强（P2-5）、truncated_rows
  （本轮已实现）均为置信度输入，避免重复实现。

---

## 7. 后续行动

1. 本 SURVEY 评审确认后，将 §4 Phase 1 拆为 TODO P1 条目（见 docs/TODO.md 新增 §6）；
2. Phase 1 实现：`confidence.py` 纯函数 + 单元测试（TDD）；
3. Phase 2 实现：`confidence_report.csv` + validation 补充检查 + 前端展示；
4. §5 主线（来源分级准入）在 Phase 1 完成后重新设计合并 TODO。
