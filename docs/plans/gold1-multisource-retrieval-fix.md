# Gold1 多源整合失败——修复设计（简化版）

> 状态：设计定稿，未实施。根因：r4 单次 `search_geo` 字面 AND 查询仅 29 命中，三个
> 参考 GSE 从未入池；池内次优死于平台无注释；无任何规则要求 ≥2 系列。
> 完整根因分析见 2026-10-12 排查记录（agent 记忆 gold1-single-dataset-root-cause）。

## 约束（用户已定）

- **系统提示词不改（用户裁定：方案 1 不做）**；搜索工具的描述与 geo skill 可以改。
  gold-v1 的 TOPIC/prompt 文件仍不动。"整合=≥2 源"的规则改由 geo SKILL.md 承载。
- 走提示/文档路线，**不改检索行为代码**（确定性放宽阶梯方案已否决——过度设计）。

## 改动（2 处文本；2026-10-12 已实施，分支 feat/geo-search-strategy-guidance）

### 1. `server/src/agent/tools/geo.ts` — `search_geo` 的 description 重写 ✅

现描述只说"search keyword like 'METTL5'"，未告知字面 AND 语义。改为要点式：

- 查询是**字面词 AND**（ESearch 翻译），词越多池越小——首轮用少量宽词
  （疾病 + 组织 + normal），不要把 paired/profiling 等方法学词放进首轮查询；
- 看返回的 `total_count`：**<50 说明查询过窄**，去掉方法学词或换同义词族
  （tumor/tumour、paired/matched/adjacent、expression/transcriptome）再查；
- 扫宽池时把 `max_results` 调大（可到 200）；
- 禁止从单次窄查询的结果推断"不存在其他合格数据集"。

作用：模型在调用前就能看到（工具描述常驻），r4 的 29 命中查询在第一步就会被自己纠正。

### 2. `.pi/skills/geo/SKILL.md` — 加 "Search strategy" 小节 ✅

同上要点展开成一个短小节（含一个具体例子：breast cancer 整合任务的首轮宽查询
与过窄后的放宽重查），外加两行决策规则：

- 整合类任务目标 ≥2 个合格系列；平台无注释的候选先降级 probe 级发布
  （`gene_expression.probe_release.v1` 允许），不得因注释缺失直接放弃该系列。
- GSE318780 型测序系列：series matrix 可能只是元数据壳，真数据在 suppl
  （`supplementary_matrix` 路线已有支持）。

## 实测依据（为什么这样教就够）

2026-10-12 真实 ESearch 验证：原查询 29 命中（零参考集）；同义词扩展+去 profiling
后 **409 命中，GSE318780 rank 11、GSE113865 rank 60**——即"宽词 + 大 max_results"
即可召回 2/3 参考集。GSE42568 文本检索不可达，不作为目标。r3/r4 的行为证明模型
对 skill/tool 文本是严格照办的（per-GSE 独立 build、probe 映射强制等规则全部被执行），
提示路线的执行风险可控。

## 验收（round3 = r5，2026-10-12 已复跑，通过）

新 task `task_ts_6ba028e5…`、冻结 prompt 原文复跑（qwen3.8-flash，与 r3/r4 同模型
单变量对照；dev@f495aba9）。**通过**：发布 2 个正式 Publication（GSE31192 +
GSE26910，均 GPL570 基因级），首轮检索即为宽查询（`breast cancer tumor normal`，
max_results=200），后续同义词族补查，vetting 6 个候选（含参考集 GSE318780），
最终报告无单系列局限。墙钟 69.9 min、峰值 414k tokens、压缩 2 次。
参考三系列未全中的遗留属产品级阻塞（RNA-seq 补充矩阵无正式载体路径：
series matrix 元数据壳 + extract_core_archive 拒收 agent 资产；cohort_filters
不过滤行），对应下方 P3/ADR 范畴，非提示层问题。完整证据：
`data/gold-runs/f495aba9-gold1-qwen38flash-r5/`（closure/runs-log/事件流/产物）。

## 门禁

改动触及 `server/src/`（两个文件均纯文本字符串）：lint/typecheck + server 定向测试
（phase5 geo-tools 契约有 description 快照时同步更新）；skill md 改动跑 docs:check。
