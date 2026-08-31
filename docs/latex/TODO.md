# 论文 TODO（2026-08-31 整理）

> 本文仅保留与论文相关的**待办项**，由一份论文讨论（含审查报告 reaction）整理而来。

---

## 一、顶层实验决策

- [ ] 在 qwen3.8 27B 与 flash 二选一中选一个，把 10 个 gold **完整跑一遍**；以实际效果为准（预期 27B 更好）
- [ ] 跑完后确定评测主力模型并在论文中更新（当前主力为 deepseek-v4-flash）

## 二、后续对照实验

- [ ] **能力对照**：对单一案例输出 3×3 对照表 —— 模型（3.8flash / 27b / max）× 实现（qoder / pi 轻量 / BioMed QAgent）
- [ ] **消融实验**：27b 去掉 Core 流水线产物后结果如何变化（量化"安全收益—交互成本"）

---

## 三、审查整改（P0：先补实验，改写无法解决）

- [ ] **建立 Publication 对 Reference 的自动评估器**（论文 [ch05](docs/latex/chapters/ch05-experiments.tex#L206) 自述尚未脚本化）
  - 对 gold7/8/9 至少输出：reference 总行数、publication 总行数、matched / missing / extra、行级 precision / recall、字段非空率、字段准确率、数值一致率及容差、3–5 个具体错误样例
- [ ] **完成一个 Qwen-VL 端到端图表案例**（gold6 `chart_points.csv` 目前只有表头，见 [chart_points.csv](data/gold/gold6_egfr_paper_extraction/chart_points.csv)）
  - 覆盖：真实自然语言需求 → 真实论文 PDF/图像 → Qwen-VL 实际响应 → 轴/单位/图例识别 → 低置信点人工修正 → 正式 Publication → hash 重验 → 下游绘图复现
- [ ] **重跑 gold9 v2**（当前仅有 r1，`data/gold-runs/fbe93ae-gold9-qwen38flash-r1`）
  - 新增 source-to-column completeness 门：声明使用某源必须产生相应列值或明确记录不可达原因；整列为空不能标为完整可发布；输出每个来源维度覆盖率
  - 保留 v1 / v2 / supersedes / 修正原因 / 修正事件 / 两版差异
- [ ] **用当前高档 Qwen 重跑一个完整案例**（同一冻结提交、同一数据根目录：任务 → 检索 → HIL → 正式发布 → hash 重验 → 参考集评估）
- [ ] **最小真实用户研究**（3–5 名有生物医学数据经验的用户；非开发人员 fixture）
  - 每人完成一个多源整合任务 + 一个审查/纠错任务；记录任务成功率、到 Publication 时间、人工介入次数、首次预检通过率、用户卡点、简化 SUS、一条反馈改进后复测
- [ ] **归档可复核证据包**（每个旗舰案例：TOPIC、frozen commit、events.jsonl、source assets、transform receipts、HIL decisions、manifest、artifacts、SHA256SUMS、reference evaluation、前端截图）
  - 若原始材料无法恢复则重跑，不能只依赖 `runs-log.md` 二手摘要

## 四、审查整改（P1：重构报告叙事）

- [ ] 第 3–4 章从约 9 页压缩到 5–6 页，节省篇幅交给实验与应用
- [ ] 第 5 章新增四类内容：科学问题、整合逻辑、量化结果（coverage/accuracy/completeness）、下游消费（一段 Notebook 或分析截图）
- [ ] 第 5 章按新结构重写：5.1 评测问题与指标（RQ1–RQ6）/ 5.2 参考集和评估器 / 5.3 三个代表案例（一页表格）/ 5.4 图表与人工纠错案例 / 5.5 基线与消融 / 5.6 下游消费与用户研究
- [ ] 增加两个指标：`preflight first-pass success rate`、`median rejected attempts before acceptance`（gold7 11 次拒绝若属离群值，补中位数）

## 五、审查整改（P2：文风与主张强度）

- [ ] 增加一页术语表（fail closed / digest-bound / closed-world admission / capability honesty / execution hallucination / content-addressed 统一中文）
- [ ] 将第 5.10 节 7 条边界收敛为一张"未完成项 × 影响 × 后续措施"表格，不再逐条解释"为什么不是缺陷"
- [ ] 创新点标题从"创新点"调整为"面向科学数据 Agent 的三项系统性贡献"，强调组合后的任务级保证而非原语原创
- [ ] 补"开放规划、闭合执行"（贡献二）的消融：无预检时错误规格的后果 / 有预检时拦截的具体错误 / 代价（轮次与时间）
- [ ] 降级绝对表述：唯一信任边界→正式发布的主要信任边界；全部操作可审计→正式任务事件可持久化重建+审计实例；零编造→限定检查范围；模型无关→有限跨模型验证；科学数据编译器→编译器式受控数据构建流程（注：论文中多数已按此降级，见文末核对）
- [ ] 修订"编译器"类比定位为定位比喻，避免"科学数据编译器已经实现 / 完整编译 / 保证科学语义正确"

---

## 核对清单（2026-08-31，整理时对照论文与仓库）

| 审查点 | 状态 |
|---|---|
| 边界表收敛为"影响×措施"表 | ⚠️ 论文已有边界表（[tab:boundaries](docs/latex/chapters/ch05-experiments.tex#L276)），但为"性质×处置"口径，未直接采纳审查的"未完成项×影响×后续措施"三列 → 保持 P2 待办 |
| 参考集对照为手工冻结数字（边界 7） | ⚠️ 论文自述仍为手工冻结（[ch05:208](docs/latex/chapters/ch05-experiments.tex#L208)）→ 即 P0 评估器待办 |
| gold6 图表数字化 | ❌ `chart_points.csv` 仅表头 → 待办（Qwen-VL 端到端） |
| 行级覆盖率 / 字段命中率 / 数值一致性脚本化 | ❌ 未产出 → P0 评估器待办 |
| qwen3.8-27B / max 完整正式复验 | ❌ `data/gold-runs/` 无 27b/max 目录 → 顶层决策 + P0 复验待办 |
| 3×3 能力对照、消融实验 | ❌ 未做 → 第二节待办 |
| 真实用户研究 / SUS | ❌ 无 → P0 用户研究待办 |
| 术语表 | ❌ 论文无 → P2 待办 |
| 下游消费设计（CSV / join key / R / Python / 知识图谱） | 缺实际消费演示 → 并入 P1 下游 Notebook 待办 |
