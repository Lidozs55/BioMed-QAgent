# Gold6 `literature_experiment_chart` 修复与正式重跑实验报告

**报告日期：2026-09-03**  
**实验执行日期：2026-08-30—2026-09-02**  
**最终成功轮次：Gold6 R7c3（2026-09-02）**  
**最终状态：`succeeded_publication`**

> 本报告按实验报告口径重建 Gold6 从首轮受治理重跑到首个正式 Publication 的修复过程。
> 事实来自版本化 Gold 证据包、R6/R7 系列 closure、R7c3 运行目录、Git 历史以及本次对
> R7c3 文件字节、SHA-256、CSV 记录数和 JSON 内容的独立复核。历史轮次的 workspace
> 临时文件和 `ua_*` 隔离产物不被当作 Publication 证据。

## 摘要

Gold6 要求系统从三篇论文（PMC10408569、PMC5355725、PMC5094958）中形成 EGFR
突变体抑制实验数据产品，并闭合论文、实验、活性值、图表系列、图表点和补充材料的
可追溯关系。2026-08-30 至 2026-09-02，项目先后完成受治理 PDF/VLM 获取、动态六表
profile、正式 source binding、candidate/reviewed VLM carrier、确定性
`evidence.manifest`、精确模型/提示词/定位器身份、持久 semantic route fence、监督器与
HIL 恢复、以及可合法为空的 supplementary/chart topology。

版本化 R1—R4 和正式 R6、R7b、R7c 均以 `blocked_no_publication` 结束；R7 初次尝试因
两个 Host 同写 `events.jsonl` 被判无效，R7c2 又因机器意外关机丢失 `/tmp` 运行态。
2026-09-02 的 fresh、single-Host R7c3 最终在冻结产品提交
`ae271a790b0ace726d6e80f976a4c5df996d2ec9` 上产生首个正式 Publication：
`pub_egfr_mutant_inhibition_literature_chart_6cc6bc09c71ca8c5`。最终包包含 3 篇论文、
9 个实验和 138 条 activity 记录；全部 activity 来自确定性 JATS/XML 表格解析
`article_table_deterministic_parse_v1`，并非 VLM 估数。`chart_series`、
`chart_points`、`supplementary_asset_records` 为合法的 header-only 空表；因此本实验
证明了受治理视觉尝试、失败降级、HIL、确定性数据提取和正式发布闭包，但不构成“已成功
数字化曲线坐标”的证明。

## 1. 实验目的与成功判据

### 1.1 目的

1. 用一个 fresh task/run 在同一冻结产品提交上完成 Gold6。
2. 让论文 PDF/XML、补充材料和 VLM 派生 evidence 全部经过 Dataset Core 的资产、回执和
   provenance 边界。
3. 验证 VLM carrier 的候选态、复核态、终态选择和 `evidence.manifest` 一致性。
4. 保证图表坐标 exact-only：不得把 OCR、插值、marker 读数或轴估计提升为 exact。
5. 获得真实 `publication_acceptance`、B3/ProductAssessment、不可变 Publication、Manifest
   和 Artifact API 的字节级 SHA-256 闭包。

### 1.2 判定规则

一次运行只有同时满足下列条件才算成功：

- fresh request、task、run；不得复制历史事件、HIL、workspace、quarantine 或资产身份；
- Host 健康状态固定为 TS Application Host / Pi Agent / TS Dataset Core；
- expected/observed product commit 完全相同；
- frozen prompt、case、manifest、runtime profile 哈希与运行 execution context 一致；
- 动态 Family 路由一旦选定，不得切回 static 路由绕过 Core 拒绝；
- 产出正式 OperationResult、Publication、Dataset Manifest、ProductAssessment；
- `publication_acceptance` 已解决；
- 每个正式 artifact 的下载字节数和 SHA-256 与 manifest 相等；
- `ua_*`、workspace CSV、provisional 文件只能作为不可信或诊断材料，不能替代上述对象；
- 估算图表点不得作为 exact 数据发布。

## 2. 材料、环境与方法

### 2.1 固定材料

- Gold case：`gold6`。
- 论文选择：PMC10408569、PMC5355725、PMC5094958。
- 主要来源：PubMed、PubMed Central、Europe PMC；RCSB PDB 仅用于核验。
- 模型：R1—R7c3 的正式后段重跑均使用 qwen3.8-flash。
- 历史 prompt（R1—R7b）：SHA-256
  `f30ab31099da23c75a3e0037ee303b8814c7c124bc1e84be149d2c6f4c8fc298`。
- 操作员批准后的 R7c/R7c3 prompt：CRLF、无末尾换行，SHA-256
  `2267815c0bab859bc0b7488837bd4682ca4248d6fcf84b15e4af8414ab34c92e`。

### 2.2 正式运行隔离

- 每轮建立独立 task/run；后期轮次使用独立 worktree 和独立 `OUTPUT_DIR`。
- 启动前杀死旧 Host、确认端口空闲、删除失效 lease，并验证只有一个 listener/lease holder。
- `scripts/gold-formal-supervisor.mjs` 从 sequence 0 分页保存事件，并记录 expected commit、
  observed commit、HIL stop、终态和 artifact 重哈希结果。
- R7c3 worktree：`/tmp/BioMed-QAgent-r7c3`。
- R7c3 runtime：`/tmp/BioMed-QAgent-r7c3-runtime`。
- R7c3 开始时间：2026-09-02 22:14:29 +08:00；最后 durable event：
  2026-09-02 15:27:57.944Z（23:27:57.944 +08:00），墙钟约 1 小时 13 分 29 秒。

### 2.3 HIL 方法

操作员对 R7c/R7c3 给出“所有 HIL 均批准”的 standing policy。实际 wire shape 必须区分：

- permission：`"decision": "approve"`；
- data review / publication acceptance：`"decision": {"action":"accept"}`。

R7c3 曾把 publication acceptance 误写为字符串 `approve`，Host 返回 HTTP 422。修复方式是
直接对同一 run 的 resume API 发送 `{"action":"accept"}`，然后以 `--resume` 重新挂接
Supervisor；没有创建第二个 run。

## 3. 修复路线

### 3.1 视觉与正式数据路径基础（2026-08-30）

早期 Gold6 工作完成以下基础设施：

- 冻结 prompt/checksum，修复 CRLF/LF 字节漂移；
- 建立 `literature_experiment_chart.release.v1` 六表 profile；
- 新增受治理的 Europe PMC PDF、全文 XML、补充材料获取与 archive-member 路径；
- 接通 JATS/XML、registered parser、正式 VLM evidence asset 和 source locator；
- 动态 prepare/submit 改为 receipt-first、receipt-only；
- 明确 `image_bbox`、`pdf_region`、`json_pointer` 等 locator wire；
- 严格拒绝从曲线、柱高或 OCR 坐标估读后冒充 exact 的数值。

这一阶段非 Gold E2E 已能产生六表 Publication 并复算 hash，但 live Gold 仍未闭环，不能
以 fixture 能力代替正式运行证据。

### 3.2 R5 manifest 与终态 carrier 修复

R4 暴露出 producer/validator 对 VLM carrier 的结构性契约错位。R5 的核心修复为：

1. 将 `review_evidence` 加入一等 `CoreDerivedAssetOperationKind`。
2. registered-paper 与 generic `extract_chart_data_vlm` 路径统一采用：
   candidate carrier → `review_evidence` → reviewed terminal carrier。
3. `evidence.manifest` 不接受模型自述，而是从验证后的 carrier rows 确定性投影。
4. publication 传递真实选中的 terminal receipt IDs；validator 在逐行校验前先验证所选终态
   closure，堵住“空 chart_points + candidate-only carrier”绕过。
5. `chart_series.transform_provenance` 同时绑定 row/manifest 的模型名、模型版本和实际幸存
   VLM 调用的 `prompt_digest`。
6. generic 和 registered-paper 两条抽取路径执行同一候选/复核/终态合同。

主要实现提交为 `ed8d1a95`；R6 独立审计随后重建三个 carrier manifest，得到
16/0、9/0、91/0（series/points），与注册 provenance 逐字节相等，证明 manifest 漂移已
消除。

### 3.3 持久路由 fence

R4 中 Agent 在动态路由被拒后尝试 static 路由。虽然 static 执行也失败且未产生 Publication，
这仍是语义路由纪律问题。提交 `9022d8ed`、`ad4bc65e` 等把路由选择固化为 Host-owned、
task-scoped、durable semantic route state：一旦 Dynamic Family 承诺成立，同 task 后续静态
validate/execute 在重启前后都 fail-closed。

### 3.4 重试可观测性

R6 证明 PMC10408569 页 10、11 的 corrective retry 实际发生，但正式 tool output 的
200 字符 sanitization 截断了位于后部的 warnings。提交 `27d96c08` 将紧凑
`retry_summary` 前置到输出开头，暴露 `pages_with_retry` 与
`pages_degraded_no_points`；29 个 registered-paper 测试通过，并在 R7c live 输出中观察到。

### 3.5 Optional topology

正式来源事实表明，并非每篇论文都存在可由 Core 获取的补充 archive，也并非每次严格
exact-only 视觉提取都会生成可接受 series/points。经操作员明确批准：

- `01f68727`：`supplementary_asset_records` 改为 optional/allow-empty；只要存在 staged
  supplementary rows，仍必须有对应 Core archive-member provenance。
- `46799d1f`：`chart_series` 改为 optional/allow-empty；仅当 series 和绑定 VLM input 都为空
  时走 chart-less path。一旦有任一 series 或 VLM input，完整 reviewed-carrier closure 仍
  必须执行。

该调整不是放宽 exact-only，也不是把来源缺失当作零值；它允许在论文确有精确表格数据、
但没有可发布视觉点时发布表格型产品。

## 4. 正式轮次与观察结果

### 4.1 轮次总览

| 轮次 | 日期（UTC） | 产品提交 | Events | Tokens | 终态 | 最终诊断 |
| --- | --- | --- | ---: | ---: | --- | --- |
| R1 | 2026-08-31 05:08–05:34 | `38d1fe20` | 2,438 | 1,124,683 | blocked | VLM 页级标题/渲染链无法形成合法 `chart_series` |
| R2 | 2026-08-31 08:26–09:27 | `e17409ef` | 8,847 | 4,690,205 | blocked | carrier 绑定缺 exact Core acquisition provenance；0 points |
| R3 | 2026-08-31 12:37–14:03 | `e680d423` | 17,497 | 9,166,315 | blocked | supplementary member 的二进制/UTF-8 binding 约束冲突 |
| R4 | 2026-08-31 23:00—2026-09-01 00:36 | `42984ecb` | 10,478 | 9,390,409 | blocked | VLM `evidence.manifest` 缺失/descriptor output closure 错位 |
| R6 | 2026-09-01—09-02 | `68deb3d6` | 17,589 | 9,075,184 | blocked | manifest 已闭合；最终被 supplementary-member gate 拦截 |
| R7 attempt 1 | 2026-09-02 | `eb1ff91e`→`eaf86de2` | 无效 | 不计 | invalid | 两个 Host 交错写入，sequence 1582–1777 损坏；commit 亦漂移 |
| R7b | 2026-09-02 | `eaf86de2` | 16,423 | 7,035,927 | blocked | 修复空 activity/transform ref 后仍被 supplementary gate 拦截 |
| R7c | 2026-09-02 | `632c70bd` | 9,749 | 3,116,726 | blocked | supplementary 可空后到达 reviewed-terminal VLM carrier gate |
| R7c2 | 2026-09-02 | `7c746ed0` | 未闭合 | 不计 | lost | 机器意外关机，`/tmp` worktree/runtime/evidence 全失 |
| **R7c3** | **2026-09-02 14:14–15:27** | **`ae271a79`** | **19,884** | **10,279,486** | **succeeded** | **首个正式 Publication；9 artifacts 全部 hash match** |

> R5 是实现/回归修复阶段，不是一个被计为成功或失败的正式 Gold task。R7 attempt 1 和
> R7c2 也不进入结果合并：前者日志完整性已破坏，后者没有可恢复 closure。

### 4.2 R1：真实来源可达，但视觉链不能构建

R1 获取了三篇论文的 Core carrier，并核对 PMC10408569 的直接 IC50 文本；但
`extract_registered_paper_chart_evidence` 五次均不可重试失败，包括“page paper title is
required”和“no page images could be extracted”。由于当时 `chart_series` required 且至少一
行，系统正确返回 `blocked_no_publication`，没有把 XML 中的值伪装成图表坐标。

### 4.3 R2：正式 provenance binding 仍不成立

R2 的 9 个 `(PMCID, provider)` 获取组合最终全部成功，部分全文 XML 经 5xx 重试恢复。
两篇 VLM evidence carrier 成功，但 submit 两次拒绝：`formal dynamic carrier lacks exact Core
acquisition provenance`。临时 CSV 仅保存已逐字读取的 20 行 PMC5094958 activity；正式
Publication 为 0，98 条 series 仍 pending，`chart_points=0`。

### 4.4 R3：补充材料的 binding 类型冲突

R3 抽到 221 个 activity、103 个 series，但所有 series 都因轴单位/图例不明确而无点。
三份补充包的成员主要是 jpg/gif，PMC10408569 另有一份约 14 MB PDF；正式 transform input
要求 UTF-8 或 gzip UTF-8，而 provenance 又要求实际 supplementary member binding，两个约束
对这些二进制成员无法同时满足。结果为 17,497 events、0 Publication。

### 4.5 R4：精确定位到 manifest/descriptor 契约错位

R4 已有 3 papers、107 experiments、185 activity values、86 chart series、0 chart points；
9 个获取 carrier 和两个解包成员均在 Core provenance 中。五次 submit 在两个签名间切换：

- `Core VLM provenance requires an embedded evidence manifest`；
- `OUTPUT_CLOSURE_MISMATCH: receipt output 0 does not match its Core descriptor`。

R4 产生 10,478 durable events、5 次 credential HIL、30 个全部不可信的 quarantine 条目，
但 Publication/Artifact/Publication acceptance 全为 0。该轮直接驱动 R5 的 manifest、reviewed
terminal 与 output-closure 修复。

### 4.6 R6：manifest 修复已 live 验证，瓶颈移至来源拓扑

R6 的 expected/observed commit 均为 `68deb3d6`；60 次模型调用、17,589 events、
9,075,184 tokens。三个 VLM carrier 均成功形成正式 manifest，独立审计按 row 顺序重建出：

- PMC10408569：16 series / 0 points；
- PMC5094958：9 / 0；
- PMC5355725：91 / 0。

总计 116 series 均 axis unclear，106 条 legend unclear；渲染页在 216 DPI 下存在且可定位，
因此根因更符合 qwen3.8-flash 在 v3 prompt 下的响应质量，而非 PDF 渲染失败或最终 point
validator 过严。prepare 成功，submit 最终被“requires a Core-owned supplementary member
asset”拦截。Europe PMC `supplementaryFiles` 对目标论文返回 500；这一轮证明 R4 manifest
问题已解决，但 required supplementary topology 与真实来源不匹配。

### 4.7 R7：监督完整性事故与重跑纪律

R7 attempt 1 同一 runtime 中残留旧 Host，新 Host 又因 watch reload 启动。两个 writer 从
sequence 1582/1583 分别继续，造成 1582–1777 重复、乱序，并出现多个 `run_started` 和
`run_failed: Pi turn failed`。Supervisor 保存到 1581 的干净前缀并因产品 commit 不匹配
fail-closed。该尝试被明确标记为 **invalid**，没有修补日志或续跑。

由此固化启动顺序：杀死所有旧 Host → 确认端口空闲 → 验证单一 lease holder 与 health
commit → 再创建 fresh task/run → Supervisor `--adopt`。同时说明为什么不能把“第二个 Host
作为保险”。

### 4.8 R7b：来源缺失被定性

R7b 在 single Host 和 commit `eaf86de2` 上完成 16,423 events、7,035,927 tokens。三次
submit 依次暴露并修复：空 activity table、Host-compiled transform_ref 不匹配、Core-owned
supplementary member 缺失。控制 PMCID 返回 `media_mismatch`，而目标论文在全部治理路径上
返回 500/无 EBI archive，支持“文章没有该 Core provider 可交付 archive”而非“整个 endpoint
完全离线”的解释。该轮推动 supplementary optional topology。

### 4.9 R7c：到达 reviewed-terminal gate

R7c 使用新 prompt SHA `2267815c…` 和 optional supplementary topology，9,749 events、
3,116,726 tokens。三篇 VLM 调用成功，但抽取的 102 series 全部因轴单位缺失降级，仍为
candidate stage；`chart_points=0`。prepare 通过，submit 正确拒绝没有
candidate→`review_evidence`→reviewed terminal closure 的 VLM carrier。Agent 没有伪造 review。
该轮推动 chart-less topology：无 series 且无绑定 VLM input 时，允许由精确论文表格数据
独立发布。

### 4.10 R7c2：易失运行态丢失

R7c2 已在 commit `7c746ed0` 启动并配置 blanket HIL watcher，但机器意外关机清空了 `/tmp`；
worktree、runtime 和尚未归档的 evidence 均消失。它没有 terminal closure，因此不判成功或
失败。R7c3 从 `origin/dev` 和空 runtime 全新创建，未复制 R7c2 task 状态。

## 5. R7c3 最终实验结果

### 5.1 身份与资源消耗

| 项目 | 值 |
| --- | --- |
| Request | `gold-v1-gold6-mtk68za3-r7c3` |
| Task | `task_ts_cc589f9a-271b-4ea2-85a6-470c1c50a822` |
| Run | `run_ts_4ca4e52a-d921-4c04-807d-67c1ad5c4952` |
| Expected/observed commit | `ae271a790b0ace726d6e80f976a4c5df996d2ec9` / 完全相等 |
| 终态 | `succeeded_publication` |
| Durable events | 19,884；7,829,057 bytes；SHA-256 `30e977c8…217aa0` |
| 模型调用 | 75 |
| Input / output tokens | 653,471 / 163,999 |
| Cache-read / cache-write | 9,462,016 / 0 |
| Reasoning tokens | 103,529 |
| Total tokens | 10,279,486 |
| 墙钟 | 约 1 小时 13 分 29 秒 |

### 5.2 HIL 与发布链

本轮共出现 5 个 blocking HIL：1 个 VLM credential permission、4 个
`publication_acceptance` data review。全部按操作员 standing policy 解决；最终接受记录为：

- request：`hil_f7b3e3a7ccb6f6f18ea1b54923a9be91`；
- policy：`dynamic_family_hil_acceptance.v1`；
- reviewer：`user`；decision：`accept`；
- reviewed at：2026-09-02 15:26:11.439Z。

同一 run 内形成四次不可变 Publication，后三次通过 `supersedes_publication_id` 串联；最终
`current_publication_id` 为 `pub_…6cc6bc09c71ca8c5`。这表明运行中的迭代不是修改旧
Publication，而是产生新的不可变版本。最终 Publication 于 15:26:11.509Z 建立。

### 5.3 最终数据

对最终 CSV 使用 Python `csv.reader` 复核（不是 `wc -l - 1`，因为空表可能没有末尾换行）：

| 表 | 列数 | 数据记录数 | 字节 |
| --- | ---: | ---: | ---: |
| `paper_records.csv` | 7 | 3 | 999 |
| `experiment_records.csv` | 10 | 9 | 9,257 |
| `activity_value_records.csv` | 13 | 138 | 98,008 |
| `chart_series.csv` | 21 | 0 | 351 |
| `chart_points.csv` | 15 | 0 | 265 |
| `supplementary_asset_records.csv` | 13 | 0 | 231 |

138 条 activity 全部为 `article_table_deterministic_parse_v1`、`confidence=high`、
`review_status=not_required`；当前 family wire 的 `raw_relation=IC50`、单位 µM，并来自两个
Core source assets。其中
PMC10408569 为 42 条，PMC5355725 为 96 条；PMC5094958 作为 paper row 保留，但最终没有
activity row。示例：

- PMC10408569 / EGFR WT：`0.358 ± 0.16 µM`；
- PMC10408569 / EGFR T790M：`0.61 ± 0.005 µM`。

Manifest 的 `row_count=138` 表示 primary table 粒度，并非六张表行数总和。provenance coverage
为 138/138，ratio=1；8 个正式 source assets；validation report 共 94 checks，0 failed；
ProductAssessment 六个维度全部 score=1，`product_status=publishable`、blockers 为空。

### 5.4 正式 Publication 文件量

- Manifest 声明的 9 artifacts：167,274 bytes（163.35 KiB）。
- 加上单独下载和重哈希的 dataset manifest：181,551 bytes（177.30 KiB）。
- Publication 目录全部 12 个文件（再含 `publication.json`、`validation_report.json`）：
  203,794 bytes（199.02 KiB）。
- Supervisor evidence pack：17 个文件，8,084,948 bytes（7.710 MiB）。
- 整个 task 目录的逻辑文件字节和为 52,486,987 bytes；其中还包含输入 carrier、状态、候选
  transform 和被 supersede 的早期 publication，不应与最终 Publication 大小混为一谈。

逐文件大小与完整 SHA-256 见同日清单：
[2026-09-03 Gold6 R7c3 产物与证据清单](2026-09-03-gold6-r7c3-artifact-inventory.md)。

## 6. 验证结果

### 6.1 实现修复的质量门

R5/R6 整合树最终通过：

- server：2,176 passed / 20 skipped；
- contracts：167/167；
- frontend：938/938；
- database：88/88，bridge self-test 与 Ruff 通过；
- workspace lint、typecheck、build 全通过。

manifest-focused 回归覆盖 candidate-only 拒绝、reviewed terminal closure、generic path parity、
模型/版本/prompt digest/locator 精确匹配和空 points 预检。Optional topology 相关 targeted
测试为 72/72，后续受影响组合为 150/150。

### 6.2 最终字节验证

Supervisor 对 9 个 artifacts 和 dataset manifest 分别比较 expected size/actual size 与
expected SHA-256/actual SHA-256，10 项 `file_digest_match` 全为 true。最终 manifest 文件：

- 文件 SHA-256：`69d9795817293036610e94626cf61b7b5bffb4e7382710b07f08489ae2d7fb35`；
- package digest：`6cc6bc09c71ca8c56eb7b525bad1367bc703ee8bfb4257adaca4098896b8988e`；
- validation：94 passed / 0 failed；
- B3：schema、relations、identifiers、provenance、confidence、reproducibility 均满足。

## 7. 讨论

### 7.1 修复不是“放过 validator”

R4 的 manifest 错位通过确定性投影和 terminal closure 修复；R6 的独立审计证明 producer 与
validator 完全一致。Optional topology 只表达现实来源可能没有 supplementary 或可接受视觉
series。若 staged supplementary rows 存在，archive-member provenance 仍必需；若有
chart series 或绑定 VLM input，reviewed terminal closure 仍必需。因此来源/视觉数据存在时
没有绕过原有信任边界。

### 7.2 exact-only 政策的效果

多个轮次中 VLM 能识别 figure、series、bbox，但无法可靠给出轴单位和有限坐标。系统把这些
结果降级为 unclear/no-points，没有把插值、OCR 或视觉估数写入 `chart_points`。R7c3 的成功
来自精确 XML 表格数据，不是降低数值标准。这正是“缺视觉点仍可发布精确表格产品”和
“视觉数字化成功”之间必须保留的区别。

### 7.3 运维完整性与可恢复性

- 双 Host 会破坏 append-only sequence；必须依赖单实例 lease 并在启动前主动核验进程。
- watch reload 会改变 Host commit；Supervisor 的 expected/observed guard 正确阻断了 R7。
- `/tmp` 不可作为持久证据库；R7c2 的丢失说明 terminal 后必须立即复制并生成 SHA inventory。
- HIL decision DTO 不是通用字符串；permission 和 data review 的 wire shape 不同。
- Supervisor 输出可能截断后部 warnings；关键 telemetry 应位于有界输出前部。

### 7.4 数据计数更正

早期摘要曾把最终结果写成 paper 2 / experiment 8 / activity 137。对当前保留的最终
Publication bytes 使用 CSV parser 复核后，权威计数是 **3 / 9 / 138**。前者属于人工摘要的
off-by-one/版本误读；本报告与清单以实际 publication 文件、manifest `row_count=138` 和
provenance coverage 138/138 为准。

## 8. 局限与后续工作

1. **视觉坐标仍未产出。** `chart_series=0`、`chart_points=0`；不能声称已完成 dose-response
   曲线数字化。若评测目标要求非空视觉点，应建立独立 benchmark，并提供官方数值曲线源或
   可复核的 point-bearing VLM carrier。
2. **来源覆盖不等于 activity 覆盖。** 3 篇 paper 中只有 PMC10408569 和 PMC5355725 贡献
   最终 activity rows。
3. **R7c3 使用 dev-only 能力。** 产品 commit 含 `read_dataset_core_source` 和 agent-authored
   topology 等 dev-only 自代码访问能力；按当前分支治理，不得原样发布到 `main`。发布 PR
   必须剪除此能力，同时保留合法的 Dataset Core gate/topology 产品修复。
4. **dirty-build caveat。** R7c3 worktree 当时有一行未提交的 TS2731 构建兼容修复：
   `runtime_limits.${String(key)}`。Health 报告 commit 仍为 `ae271a79`；若要求 release-grade
   可重现性，应从包含该修复的干净不可变 dev commit 重跑。
5. **chart-less validator 需继续 hostile audit。** 当前 `finishWithoutVlmEvidence()` 路径必须
   确认不会跳过 staged archive/parser/supplementary provenance；成功 Gold 不能替代这类负面
   回归。
6. **证据耐久化。** 本报告写作时完整 R7c3 evidence/runtime 仍位于 `/tmp`。清单已经记录
   每个文件的 SHA-256，但仍需复制到非易失归档位置；Git 文档只保存摘要，不保存 7.7 MiB
   事件包。

## 9. 结论

Gold6 的修复不是单一 bug 修复，而是一个逐层收敛过程：先打通治理获取和六表动态发布，
再解决 carrier provenance、manifest、output closure、reviewed terminal、route identity、
retry telemetry 和真实来源拓扑；同时由 Supervisor/HIL/单 Host 协议保证运行证据可判定。

2026-09-02，R7c3 首次完成真实 `publication_acceptance` → B3/ProductAssessment →
OperationResult/Manifest → Artifact download/re-hash 的正式链路，全部 9 artifacts 加 manifest
通过字节和 SHA-256 复验。Gold6 因此可判为 **正式表格数据 Publication 成功**。但本结论
严格限定为 138 条确定性 XML 表格 activity 数据；图表 series/points 为空，视觉坐标抽取仍
是待单独证明的能力。
