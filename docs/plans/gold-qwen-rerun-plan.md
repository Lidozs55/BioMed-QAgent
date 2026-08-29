# Gold 用 Qwen 复跑 + 报告整改计划（2026-08-29）

> 目的：把报告三个样例（gold7/8/9）换成 Qwen 模型复跑证据、验证 256k 窗口下的
> 自动压缩与上下文管理、补齐"性能与资源消耗"数据、修正报告三处表述问题
> （QueryPlan/SourceCoverage 诚实声明、gold8 能力缺口、gold9 跨源空列）。
> 本文档自足，供并行 session 对齐。

## 0. 环境现状（2026-08-29 核实）

- Host 单实例运行在 `127.0.0.1:8000`，前端 root 200；git 干净 @ `8b2b7737` (main)。
- 激活模型：注册表 `qwen3.7-flash`（`model_1466dff7…`），`context_window=256000`，
  `safety_reserve_ratio=0.05`，`compaction_trigger_ratio=0.85`（≈217.6k 触发），
  `compaction_target_ratio=0.6`（≈153.6k 压缩目标），压缩 enabled。
  三个 gold 在 1M 窗口下的峰值分别为 766k / 380k / 751k，256k 下**全部必然触发压缩**。
- 注册表现有：deepseek-v4-pro/flash、qwen3.8-27b（**窗口仅 100k**）、qwen3.8-flash(256k)、
  qwen3.7-flash(256k)。**缺** qwen3.7-plus / qwen3.7-max / qwen3.8-max——
  需先在 MaaS 控制台确认部署 id 再注册。
- token 记账缺口：事件流有 `context_usage`（token 估算+窗口百分比）与压缩事件
  （含 summaryTokens），但**无逐轮 provider 用量累计**（input/output tokens）。
  成本只能先估算，或做小改造（见 §2 P2）。
- 前端实时性：`frontend/src/runtime/transport.ts` 对打开的任务做连续 HTTP 轮询订阅
  （`after_sequence` 续传 + 断线重连），**无需手动刷新**；页面重开从事件历史回放。

## 1. 测试矩阵

### Phase 1 — qwen3.7-flash@256k 三连跑（必做；报告主样例换血 + 压缩验证）

顺序 **gold7 → gold9 → gold8**：

1. gold7（旗舰样例，1M 下峰值最高 766k → 压缩证据最强；打样成功后再投入后两例）。
2. gold9（验证跨源列修复，见 §2 P1-a）。
3. gold8（验证来源失效韧性链，见 §2 P1-b）。

- 冻结基线 = 当前 main 提交；证据包 `data/gold-runs/<baseline>-goldN-qwen37flash-r1/`，
  沿用 gold-formal-supervisor 协议（TOPIC 输入、事件捕获、产物重下载+哈希复核）。
- 每跑必录（直接喂报告"性能与资源消耗"小节）：
  端到端墙钟时间（首/末事件时间戳）、上下文峰值、压缩次数+每次回收量、
  事件总数、下载数据量（ContentCache 字节）、发布 id + 哈希链复核、HIL 次数。

### Phase 2 — 昂贵档矩阵（额度允许时；每模型单 gold）

| 模型 | 窗口 | 备注 |
| --- | --- | --- |
| qwen3.8-27b | 100k | 压缩压力最大（gold8 峰值 380k → 至少 4+ 次压缩），注册表已有 |
| qwen3.7-plus | 待注册 | 控制台确认 id |
| qwen3.7-max | 待注册 | 控制台确认 id |
| qwen3.8-max | 待注册 | 控制台确认 id |

- 单 gold 推荐 **gold8**（三例中最便宜），看 Phase 1 单例成本读数再决定是否升级 gold7。
- 是否全开以额度为准；跑不成不硬跑，报告如实写矩阵覆盖范围。

## 2. 复跑前/伴随的整改项

### P1-a gold9 跨源空列（run 说明层修复，随 Phase 1 第 2 跑验证）

症状：`gene_evidence_crosswalk` 的 ClinVar/ClinGen 数值列为空——载体已下载绑定，
但变换未把值落入交叉表；最终回答却声称 BTK 有值（与发布表不符，已在 r5 复核记录）。
修复：修订 gold9 run 说明，要求交叉表逐行 join 载体记录中的 ClinVar/ClinGen 字段；
若源记录确无该字段/值，必须显式写空原因进 provenance，不得静默置空、不得虚构。
报告 5.4 节按复跑结果改写（修好→四源实整合；仍缺→如实写"两源整合+两源绑定"）。

### P1-b gold8 来源失效韧性（run 说明层修复，随 Phase 1 第 3 跑验证）

症状：DILIrank 404 + LiverTox 无结构化导出 → 四表只发布 FAERS 一张；
"诚实阻断"暴露对非 API/非结构化网页来源的获取缺口。
系统其实有浏览器池（navigate_page 等）工具，但上一轮 run 未用它产出可发布产物。
修复：修订 gold8 run 说明，要求失效来源按链路尝试并记录每步证据：
镜像/替代主机检索 → 浏览器抓取 LiverTox 网页正文+表格（带 URL+抓取时间 provenance）→
确实不可得才结构化 blocked（附完整尝试日志）。
这正对赛题加分项"能够完成修正或寻求人类建议后修正"。红线：只记录真实尝试，不得零填充。

### P2 token 用量记账（小改造，可选但直接服务报告）

若 Pi 上游响应暴露 usage（compaction 已读到 `event.result.usage.output`），
在会话层累计 input/output tokens 写入 run 汇总 + 测试；不可行则报告用
`context_usage` 估算值并明确标注"估算"。成本 = tokens × 手工价格表。

### P3 报告整改（与复跑并行）

1. 插入全局诚实声明（用户指定要点）：统一 artifact 目前是评审建议，代码尚未形成
   完整的全局 QueryPlan/SourceCoverage 产品——当前系统能证明"用了什么正式来源"，
   但不能仅凭现有运行产物严格证明"在问题子领域内查全了所有来源"。
2. gold8 / gold9 章节按 P1-a/P1-b 复跑结果改写；能力缺口如实写。
3. 新增"性能与资源消耗"小节：§1 的每跑必录字段表格 + 与人工整理时间的粗略对比
   （标注为估计值）。
4. 模型声明改口：主链路为 Qwen 系列（复跑后为真），DeepSeek-V4-Flash 作为
   模型无关性复验。

## 3. 截图清单（复跑完成后集中采集）

- **样例展示**：任务详情页中发布的表格渲染（gold7 locus 表 / gold8 FAERS 计数 /
  gold9 四表）、schema、provenance（input_asset_receipts）、validation_report、
  事件时间线里的 `context_usage` 与压缩事件（压缩证据截图）。
- **前端展示**：主页/TOPIC 创建、任务列表、任务详情实时流（run 进行中拍）、
  HIL 审批卡片、产物/发布视图、设置页（密钥必须处于掩码态才可截图）。
- 截图由本 session 用自动化浏览器指向同一 `127.0.0.1:8000` 采集；操作者浏览器
  看到的是同一 Host 状态。

## 4. 浏览器操作者（用户）职责

1. 保持现有 8000 Host 运行；**不要**再起第二个实例（单租约约束，多实例会互相杀 run）。
2. 围观方式：打开任务详情页即可，前端持续拉事件流，无需刷新。
3. run 进行中不要切模型/改设置；模型切换由本 session 在两跑之间确认无活跃 run 后进行。
4. HIL 审批默认走 API；若想以"人类操作者"身份出镜点击审批（加分项素材），
   提前说明，HIL 出现时本 session 暂停等待人工点击。
5. 在 MaaS 控制台确认 qwen3.7-plus / qwen3.7-max / qwen3.8-max 的准确部署 id
   （以及现激活 `qwen3.7-flash` 是否就是预期模型名），告知后注册。
6. 截图成片后做审美取舍。

## 5. 红线

- 单 Host 单数据目录；任何 Host 重启会扫掉他人活跃 run。
- 诚实阻断语义不破：韧性链记录真实尝试，绝不零填充或虚构数值。
- 每跑冻结基线提交 + 产物哈希复核，未复核不进报告。
- 昂贵档（3.8-27b/max）跑前先看 Phase 1 单例成本，超预算即收缩矩阵并在报告注明。
