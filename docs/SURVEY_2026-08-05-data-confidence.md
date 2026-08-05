# SURVEY — 数据置信度（Data Confidence）功能调研与先期设计（2026-08-05）

> 阶段：调研与先期设计（SURVEY + 设计草案）。
> 关联：PROBLEM.md "清洗整合可靠性 / 输出格式可用性" 评分维度；
> 触发：REVIEW_2026-08-05 数据管线审查（P0 静默截断等）与本功能规划。
> 参考方法：学术打假实践（统计学、AI 图像比对、原始数据溯源）。
>
> 本轮调整（2026-08-05）：置信度标注重心从"pipeline 数据统计打假"重新定位为
> **模型介入的采集路径**（模型读图读论文、浏览器工具访问网页）；成熟大型数据库
> 走结构化 API + 确定性解析，默认高置信度。同时确认 Agent 图片截取/理解能力链路
> 已就位并作为置信度首个落地对象；在置信度支撑下开放 Agent 自主调研数据进入
> 独立 CSV 产物，与 pipeline 产物通过 `provenance_level` 区分。

---

## 1. 背景与动机

### 1.1 赛题评分维度

PROBLEM.md 初赛评价四维度中，"清洗整合可靠性"与"输出格式可用性"直接要求：
产出数据**可分析、可追溯、可复用**。当前 pipeline 已有 validation gate、
cleaning_report、warnings、SourceLocator 等机制，但**缺少对数据"看起来
是否合理"的置信度评估**——数据可能"通过全部校验却仍不可信"（如 GSE102238
的 950MB probe 数据通过验证但无法定位目标基因）。

### 1.2 置信度标注的定位：模型介入的采集路径是主战场

本项目的数据来源按"谁在负责数值正确性"分为两类，置信度系统的设计重心随之不同：

| 采集通道 | 数值正确性由谁负责 | 置信度处理方式 |
|---|---|---|
| 成熟大型数据库（PubMed/GEO/GDC/Xena/Reactome 等）结构化 API + 确定性 pipeline 解析 | 数据库官方口径 + 确定性代码 | **默认高置信度**，无需逐条标注 |
| 模型读图读论文（VLM 图表提取、PDF 表格/图注、LLM 事实抽取） | 视觉/语言模型 | **置信度标注主战场**：逐条标注 + 抽取档位 |
| 浏览器工具访问网页（`navigate_page` 解析、截图后再理解） | 渲染引擎 + 解析 + 模型 | **置信度标注主战场**：URL 溯源 + 解析可靠性 |

设计理由：

- 成熟数据库的数值由数据库官方口径保证，pipeline 只做确定性搬运与清洗，
  出错概率低——直接打高置信即可，在确定性通道上做逐条统计反而浪费；
- 模型读图/读论文/网页理解存在**理解偏差与幻觉**，正是"通过校验却不可信"
  的主要来源，必须逐条给出置信度，让用户可分辨哪些数值是"模型目测"的、
  哪些是"数据库确定性给出"的。

因此本 SURVEY 将置信度系统定位为：**为模型介入的采集路径提供逐条置信度标注，
为确定性通道提供来源等级默认值**；学术打假式统计检测（§4）降级为确定性通道的
补充校验层，不与标注主战场混淆。

### 1.3 学术打假方法的启示（确定性通道的补充校验层）

近期学术打假实践提供了可迁移的"数据可信度"检测思路，适用于确定性通道
（pipeline 数据）的批量校验，与 §2 的通道分级标注正交：

| 方法 | 原理 | 迁移到本项目的形态 |
|---|---|---|
| 统计学检测 | 真实数据分布符合自然规律；造假数据常有异常规律（小数位过于规律、异常等差/重复、首位数字分布偏差） | pipeline 确定性统计检测器（Benford、末位数字、常数/等差检测） |
| AI 图像比对 | 不同实验组图片经翻转/裁剪后被重复使用 | 本项目以 CSV 为主，映射为"跨源/跨样本数值重复模式检测" |
| 原始数据溯源 | 粗糙编造在原始数据（supplemental materials）中漏洞百出 | 已有 SourceLocator + lineage 抽样校验；强化为"不可溯源条目不得发布" |

核心教训：**"通过校验" ≠ "数据可信"**。该层作为 validation gate 的补充
信号，不是置信度标注的主来源。

---

## 2. 置信度评估模型：采集通道分级与记录级标注

### 2.1 采集通道分级（一级判定）

| 通道 | 代表技能/工具 | 默认置信度 | 依据 |
|---|---|---|---|
| 结构化数据库 API | `pubmed` / `geo` / `gdc` / `xena` / `reactome` | high | 官方接口 + 确定性解析，数值由数据库负责 |
| 浏览器 HTML 解析 | `browser_fallback`（`navigate_page` / `download_from_page`） | medium | 页面渲染/解析质量波动，保留 URL 可复核 |
| 模型读图（VLM） | `web_visual_capture` + `extract_chart_data_vlm` | low–medium | 数值来自 VLM 目测，存在读错/幻觉；按档位与跨源验证升降 |
| 模型读论文 | `pdf_extraction`（`extract_pdf_tables` / `extract_pdf_metadata`）、Agent 对 PDF 文本的抽取归纳 | medium（表格确定性提取）/ low（LLM 自由归纳） | pdfplumber 表格为确定性提取；LLM 归纳存在偏差 |

### 2.2 记录级置信度字段

每条进入最终 CSV 产物的记录（无论通道）携带：

- `confidence`：high / medium / low；
- `confidence_reason`：通道等级 + 触发信号（如 `vlm_l1`、`cross_source_consistent`、
  `html_parse`、`statistical_anomaly`）；
- `extraction_tier`：模型提取路径的实际降级档位（`L1_vlm` / `L2_pdfplumber` /
  `L3_caption` / `html_parse` / 确定性通道为空）；
- `provenance_level`：`pipeline_validated`（pipeline 产物）/ `agent_research_annotated`
  （Agent 调研产物，§5）；
- `source_id`：URL / DOI / 文件路径 + 获取时间戳（复用并扩展 SourceLocator）。

字段语义：

- `confidence` 由通道等级 + 提取档位 + 跨源/统计信号共同决定；
- `provenance_level` 用于前端筛选与下游分析区分"确定性"与"模型标注"数据；
- 二者独立：pipeline 数据也可能因统计异常降为 low，Agent 数据可经跨源验证升到
  medium——标注的是"这条记录有多可信"，而不是"它属于哪条通道"。

### 2.3 辅助校验维度（确定性通道的补充信号）

对 pipeline 数据，在通道默认值之上叠加以下维度（检测方法见 §4）：

| 维度 | 检测内容 | 现状 | 缺口 |
|---|---|---|---|
| 完整性 | 行数截断（`truncated_rows`）、缺失率、重复率 | ✅ 本轮已加 truncated 可见；cleaning_report 已有缺失/重复 | 无"缺失率超阈值即降置信度"的评分 |
| 统计合理性 | Benford 首位数分布、末位数字均匀性、常数行/等差序列、异常取整 | ❌ 无 | **§4 补充层** |
| 溯源可审计性 | 每条记录可回溯到 source asset + 原始行；不可溯源条目计数 | ✅ SourceLocator + lineage 抽样（100 行） | lineage 抽样可能漏检（P2-5）；不可溯源条目无显式计数 |
| 跨源一致性 | 多源同一指标数值交叉验证（如 TCGA vs GEO 同一基因表达） | ❌ 无 | 仅多源合并路径启用 |
| 解析可靠性 | probe→gene 映射状态（`probe_gene_mapping`）、解析器版本 | ✅ `geo_probe_unmapped` warning 已注入 | 无"unmapped 影响面"的量化 |

---

## 3. Agent 图片截取与理解能力链路（置信度首个落地对象）

### 3.1 现状盘点：能力已就位

Agent 的"读图"能力链路已完整接线（本轮确认，无需新增基建），置信度标注
直接叠加在现有产物上：

```text
web_visual_capture 技能                        extract_chart_data_vlm 技能
capture_web_page / capture_page_section ──► source_assets/figures/fig_<sha256[:12]>.png
  （Playwright 截图；真实 UA/Referer/stealth/2s 限速）        │
                                                             ▼
pdf_extraction 技能（extract_pdf_tables / extract_pdf_metadata）  Qwen-VL（qwen-vl-max）
  论文 PDF 表格 / 元数据                              L1 VLM → L2 pdfplumber 表格 → L3 图注
                                                             │
                                                             ▼
                                          parsed/chart_data/chart_data.csv
                                          parsed/chart_data/chart_data_points.csv
```

- **截图**：`web_visual_capture`（`capture_web_page` 全页 / `capture_page_section`
  DOM 裁剪），产物为内容寻址 PNG + `capture_meta.json` sidecar，注册
  `SourceRecord(database=BROWSER)`，可作视觉证据或 VLM 输入；
- **图表理解**：`extract_chart_data_vlm` 用 `qwen-vl-max` 提取 chart_type / axes /
  data_points / legend，三档降级（L1 VLM → L2 pdfplumber → L3 图注），
  全档失败抛异常（不静默空成功）；
- **论文读取**：`pdf_extraction`（`extract_pdf_tables` 确定性表格 /
  `extract_pdf_metadata` 元数据）+ VLM 读图 + 图注佐证。

**置信度系统第一个明确落地对象**：`chart_data_points.csv` 已含 `confidence`
列但当前恒为空——VLM 提取的每个数据点都应写入该列（规则见 §3.2）。

### 3.2 模型提取路径的置信度标注规则

| 路径 | 默认 | 升级条件 | 降级条件 |
|---|---|---|---|
| VLM 图表提取（L1） | low | 带 `hint` 且 JSON 结构完整 → medium；与 L2 表格或另一图提取结果一致 → 升级；**无跨源佐证的数值不得标 high** | 无提示单次提取、图表类型为 other → low |
| pdfplumber 表格（L2） | medium | 表头/列对齐解析成功且无合并单元格 → high | 表格结构异常（缺表头、错位）→ low |
| 图注/文字（L3） | 仅佐证 | — | 不产出数值入主表；如需保留标 low |
| HTML 页面解析（`navigate_page`） | medium | 关键数值经 `capture_page_section` 截图 + VLM 复核一致 → high | 仅文本段落、无结构化标记 → low |
| LLM 论文事实抽取 | medium | 提供原文页码/段落引用 → medium（有引用）；跨源一致 → high | 无引用、纯归纳 → low |

通用规则：

- 模型提取路径**不得无标注入表**——`confidence` 为空视为未完成标注，门禁拒绝；
- 同一数值多路径一致（VLM + 表格、浏览器 + 截图复核、多篇论文互证）自动升级；
- `extraction_tier` 与 `confidence_reason` 随记录写入，用户可追溯"这个数是怎么
  来的、是谁读出来的"。

### 3.3 能力缺口（本阶段不新增）

- 截图→理解目前由 Agent 分两次工具调用完成（先 `capture_*` 再 invoke
  `extract_chart_data_vlm`），链路已通，无需新增工具；
- 如需"整图语义理解"（非图表，如显微镜照片描述）可后续扩展通用 VLM 描述工具
  ——**当前无评分场景，不做超前设计**。

---

## 4. 检测方法调研（pipeline 数据补充打假层）

### 4.1 统计学检测器（确定性、纯函数、可测试）

**A. Benford 定律（首位数字分布）**
- 原理：自然数据集的首位数字 1 出现 ~30%，9 仅 ~5%；造假/人造数据常偏离。
- 适用：`expression_value` 等大数值列。
- 实现：`pipeline/processing/confidence.py` 纯函数 `benford_distance(column_values)
  -> float`（如 χ² 距离），超阈值打 warning。
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

### 4.2 原始数据溯源强化（与 data-lineage-and-provenance 对齐）

当前 lineage：`source_id / asset_id / source_line_number / source_column_index`
→ `check_source_value_lineage` 抽样 100 行。
- **缺口 1**：抽样漏检（REVIEW P2-5）→ 抽样数随行数增长（sqrt/对数）。
- **缺口 2**：不可溯源条目不显式计数 → `main_data` 增加
  `lineage_unverified_count` 统计并入置信度。
- **缺口 3**：Agent 调研数据（非 pipeline 下载）无 source-of-record → 见 §5。

### 4.3 图像比对适配

- 本项目主产物为 CSV，图像比对直接适用面窄；映射为：
  - **跨样本数值重复模式检测**（同列多行值完全相同且非标注）——已归入 4.1C；
  - **跨源数据相似度**（同基因两来源表达谱相关性）——归入"跨源一致性"。

---

## 5. 自主调研扩展：置信度支撑下的非 pipeline 数据进入 CSV 产物

### 5.1 动机与定位

引入置信度后，Agent 被**鼓励**进行更广的自主调研（浏览网页、读论文图表、
提取 supplementary 数据、查跨源佐证），即使部分数据置信度不高——因为：

- 每条记录都带 `confidence` + `confidence_reason` + `source_id`，用户可分辨
  哪些是"确定性高置信"、哪些是"模型标注、需谨慎使用"；
- 调研数据拓宽覆盖（论文图表数值、网页表格、supplementary 数据），弥补纯
  pipeline 下载的覆盖盲区（如 PDB/PubChem/Browser 类 research-only 来源）。

**与 pipeline 的区分**（明确要求）：pipeline 产物 = 确定性 + validation gate；
Agent 调研产物 = 模型标注 + 置信度门槛。两者通过 `provenance_level` 区分，
并采用**独立 CSV artifact** 输出（`agent_research_data.csv`），不写入
`main_data.csv`——后者保持 22 固定列 + `measurement_type` 语义与 validation
gate 语义不变（project_memory 硬约束）。

### 5.2 准入规则（source-of-record 铁律 + 置信度门槛）

1. **source-of-record 必带**：每条记录携带 `source_id`（URL/DOI/文件路径）+
   获取时间戳；缺失即拒绝（防伪成功通道——LLM 内容冒充结构化产物）；
2. **置信度必填**：`confidence` / `confidence_reason` / `extraction_tier`
   三者齐备才可入表；`confidence` 为空视为未完成标注；
3. **派生链记录**：`derived_from`（来源）+ 生成 process 版本（复用 REVIEW
   数据溯源模型）；
4. **可重算**：来源错误时按 `source_id` 定位受影响记录（blast radius）。

### 5.3 产物形态

- 独立 artifact：`agent_research_data.csv`（与 `main_data.csv` 并列于
  `artifacts/`），列 = 通用实体列（主/次实体 ID + 测量类型）扩展 +
  `confidence` / `confidence_reason` / `extraction_tier` / `provenance_level`；
  - 说明：pipeline 22 列 schema 语义为"主/次实体 ID + 测量类型"，论文图表数值等
    调研行可兼容；跨列语义不兼容的调研结论（如通路描述、机制归纳）不入表，
    保留在文本汇报中；
- 每条记录进 `confidence_report.csv` 画像（按通道/档位聚合，供前端展示）；
- 前端结果查看器按 `provenance_level` 分组/筛选，并展示置信度徽标。

### 5.4 合并视图（可选，不改变 pipeline 语义）

若评分要求"单一 CSV 交付"，可提供合并视图：`main_data.csv` + 调研行
（带 `provenance_level` 列），但**合并仅发生在展示/导出层，不改变 pipeline
的 validation gate 语义**。

### 5.5 TODO 重构建议

将分散 TODO 重构为一条主线"**置信度标注 + 产物来源分级**"：

- **P1** 置信度基础设施（§2 字段 + §3.2 规则落地，先填 `chart_data_points.csv`
  的 `confidence` 列）；
- **P1** `agent_research_data.csv` 独立产物 + §5.2 准入校验；
- **P1** `SourceRecord`/`SourceAsset` 契约扩展到 Agent 手动来源
  （替换 §1.5.5"Agent 获取的原始文件统一注册"）；
- **P1** 前端 `provenance_level` 分组/筛选 + 置信度展示；
- **P2** Agent 决策日志持久化（现有 §1.5.5 `agent_results/`）；
- **P2** §4 统计检测器接入 pipeline（`confidence.py` 纯函数 + 聚合画像）。

### 5.6 已否决 / 不推荐

- 放宽 validation gate 使 LLM 内容无来源通过 —— 否决（伪成功通道）；
- 对非 pipeline 数据完全拒绝 —— 现状维持，但阻碍"调研→成果"闭环价值；
- 图像比对作为主检测手段 —— 本项目产物以 CSV 为主，优先数值统计与通道标注；
- 调研行直接写入 `main_data.csv` —— 否决（破坏 22 列 schema 与 validation
  语义，只允许 §5.4 的展示层合并视图）。

---

## 6. 分阶段实施

### Phase 1（P1）— 置信度基础设施（通道分级 + 记录级标注落地）

- 字段定义与 `ConfidenceModel`：`confidence` / `confidence_reason` /
  `extraction_tier` / `provenance_level`；
- `extract_chart_data_vlm` 的 `chart_data_points.csv` `confidence` 列落地
  （按 §3.2 规则：档位映射 + hint + 跨源升级）；PDF 表格（L2）与 HTML 解析
  （`navigate_page`）同步标注；
- 确定性通道默认值：pipeline 数据默认 `high` + `provenance_level=
  pipeline_validated`；
- 前端展示置信度。

### Phase 2（P1）— 自主调研准入

- `agent_research_data.csv` 独立产物 + §5.2 准入校验（缺 source/confidence 拒绝）；
- Agent 指令调整：鼓励在置信度支撑下进行更广自主调研（调研数据=标注数据，
  可入表；pipeline 产物仍由 `run_research_pipeline` 生成，二者不互斥）；
- 前端 `provenance_level` 分组/筛选。

### Phase 3（P2）— 补充层与跨源一致性

- §4 统计检测器接入 pipeline（`pipeline/processing/confidence.py` 纯函数 +
  `confidence_report.csv` 聚合）；
- 跨源一致性检验（TCGA vs GEO 等）作为 `confidence` 升级信号。

### 与 validation gate 的关系

- 置信度是 validation 的**补充信号**，不替代现有 gate；
- 静默截断类问题（P0）由 warning 显式化，置信度评分使其**量化可比较**；
- 模型提取路径的门禁是"无标注拒绝入表"，与 pipeline 的"不过 gate 不发布"并列，
  两者共同守住"产物必须有来源、有可信度"的底线。

---

## 7. 风险与待确认

- **VLM 置信度标定**：`low` 默认是否过于保守？需用真实图表样本标定（L1 提取
  与原文表格比对正确率），再决定是否允许 medium 默认；
- **浏览器渲染差异**：同一页面不同时间截图/VLM 读图可能不一致——截图内容
  寻址 + `capture_meta.json` 已留存证据，可复核；
- **置信度阈值**：初版仅 warning + 标注，不阻断发布；阈值经真实数据标定后收紧；
- **性能**：检测器为确定性纯函数，流式单遍可完成；`detect_arithmetic_progression`
  仅在列值域较小时启用，避免 O(n²)；
- **Benford 适用性误报**：需 `is_benford_applicable` 前置判定，避免对归一化/
  边界约束数据误报（P0 级设计细节，实现前确认）；
- **与 0802/0805 REVIEW 的衔接**：lineage 抽样增强（P2-5）、truncated_rows
  （本轮已实现）均为置信度输入，避免重复实现。

---

## 8. 后续行动

1. 本 SURVEY 评审确认后，将 Phase 1 拆为 TODO P1 条目（docs/TODO.md 新增）；
2. Phase 1 实现：字段落地 + `extract_chart_data_vlm` confidence 列（TDD）；
3. Phase 2 实现：`agent_research_data.csv` + 准入校验 + 前端展示；
4. Phase 3 实现：`confidence.py` 统计检测器 + 跨源一致性。
