# 模型卡点收集（gold 正式运行观察）

> 目的：集中收集各 gold 案例正式运行中暴露的 **Agent 行为卡点**（提示词、产品、接口陷阱三类），供后续**批量**修复与提示词优化对照。
> 纪律：每条卡点必须给出证据（事件 seq / 证据包路径 / 正文原话），不可证的不进表；证据包放 `data/gold-runs/<commit>-<case>-<model>-rN/`——**`data/` 整体保持 git 忽略（无白名单），每个 run 归档完必须手动 `git add -f data/gold-runs/<该目录>` 入库**（已 tracked 的 62 件为 gold1-r3…gold10 全部证据 + `data/gold/` 历史 log；漏 add 的新包不会被 git status 提示，静默丢失）；用量与终态见各包 `closure.json`（`run_usage`）。

## 文件结构（2026-08-31 按内容位置拆分）

> 拆分前全文留档于 `docs/archive/model-blockers-2026-08-31-before-split.md`（未提交；若精简过程中发现丢失决策依据，可从此恢复）。

- [triage.md](triage.md) —— **修复面分流总表**（A/B 两分类，含 2026-08-30「已沉淀」与 2026-08-31「框架修复落点」注）+ 兄弟事实登记。**分流修复时以此文件为准**。
- 本文件 —— 各 gold 案例逐条卡点登记（同一案例多 run 合并记录）+ 条目模板 + 十案全景对比 + 跨案恒等式。

修改纪律：新增/修订卡点 → 本文件对应案例段落；分流/汇总结论 → triage.md。
## 条目模板

```markdown
### <case> @ <model>（<日期>，main@<commit>，task_ts_…）

| # | 卡点 | 归类 | 证据 | 建议修法（暂不执行） |
| - | ---- | ---- | ---- | -------------------- |
```

归类：**模型面**（知识不足/奇怪想法/工具描述不清可提示词解）/ **框架面**（框架限制死需动代码）/ 源边界（非损失）。

## gold1 @ qwen3.7-plus（2026-08-29，main@5ac29b1dbf7d，task_ts_374f1e07-7255-41c3-92b7-6357c04ff12d）

> ⚠️ 模型身份更正：此 run 标称 qwen3.8-flash，**实际执行 qwen3.7-plus**（原因见 B7）。B1–B6 观察均基于 3.7-plus 行为；qwen3.8-flash 的真实行为以复跑 r3 为准。
> **2026-08-29 证据清理**：按操作员指示仅保留 r3；本 run 的 `data/gold-runs/...qwen37plus-misrun-r1`、`data/gold-runs/...qwen38flash-r2`（中断的 3.8-flash 早期尝试）及对应 durable 任务目录均已删除。B1–B7 保留为已记录结论（seq/数字为本机实测后归档前抄录）。
> 证据包 `data/gold-runs/5ac29b1dbf7d-gold1-qwen37plus-misrun-r1/`；终态 completed / **blocked_no_publication**；35 次模型调用、275s、input 663,823 / output 6,510 / cache_read 2,012,800、上下文峰值 109,936。

| # | 卡点 | 归类 | 证据 | 建议修法（暂不执行） |
| - | ---- | ---- | ---- | -------------------- |
| B1 | **无法检视下载内容 → 全程盲猜适配器参数**。`preview_core_asset` 对 `.gz` 只返回 gzip 二进制（"无法直接读取文本"）；`extract_core_archive` 对刚下载的补充文件报 `registered asset was not found`（seq 754）；同一 matrix asset preview 首次 not found（seq 209/224）、execute 走过一遍后才可解析（seq 548）。模型对 4.2MB 补充 CSV 的列结构零感知，`format/value_semantics/value_scale/expression_unit` 全靠文件名猜（rpkm 被拒→log2_expression 过 validate→execute 仍 parse_error/build_error） | 产品 | events-durable.jsonl seq 209/224/548/677/754；正文"看起来资产可能不在当前任务上下文中" | preview 自动解包 gzip 文本成员；download 成功即注册可解析 asset；`execute` 失败 detail 透出适配器期望布局 |
| B2 | **动态路由零调用（想象复杂度）**。正文 4+ 次说"让我尝试动态路由"，下一段总以"考虑到时间和复杂性"收回；`prepare_dynamic_family_publication` / submit 调用数 = 0，尽管 [Dynamic publication mechanics] 已教学、receipt-referenced submit 已上线、preflight 成本极低 | prompt | assistant-messages.md 134/162/166/194 行"尝试→收回"循环；`prepare_dynamic: false` | 提示词加硬阈值：静态 execute 同类失败 ≥2 次后，blocked 终态前必须至少实际调用一次 dynamic preflight |
| B3 | **幻觉外部时限**。终答"由于时间限制和复杂性…暂停等待用户指示"；实际 `agent_max_turns=240` 仅用 35 次，系统亦无墙钟限制 | prompt | 终答原文；runs-log.md 用量表 | 提示词写明预算事实（回合数、无墙钟时限），禁止以"时间限制"作为放弃理由 |
| B4 | **同路重复撞墙**。GSE318780 静态路由猜参 4 连败（seq 432/460/474/521）后换 GSE343732 仅换数据集不换路线，再吃 `no_primary_data`（seq 659）；7 次 is_error 才开始考虑策略变化，最终也没换成 | prompt | tool_completed is_error 序列：seq 474/521/659 + validate 失败 432/460/645 | 换参重试 ≤2 次的止损规则；换数据集前先判定"路线能力边界" |
| B5 | **未先 activate 就调用工具**。`search_geo not found`（seq 38）、`preview_core_asset not found`（seq 209），随后共 6 次 `activate_agent_tools` 分批解锁；每案例固定损耗 ~2 回合 | 接口陷阱 | `not_found errors: search_geo@38, preview_core_asset@209`；activate ×6 | 提示词交代懒加载工具面规则（先查 skill→tool 映射再调用）；或工具报错文本内联提示 activate 用法（现已部分存在，观察是否可见性不足） |
| B6 | **GDC 替代源浅尝辄止 + 搜索结果相关性差**。`search_gdc("breast cancer TCGA")` 首结果 TCGA-**LUAD**（肺癌，seq 809）；`describe_gdc(TCGA-BRCA)` 已确认 1098 病例 / 4876 转录组文件（seq 823，可行路径！），模型一句"需要更多配置"放弃，零次 validate 尝试 | prompt + 产品 | seq 809/823 输出；正文 150→160 行 | search_gdc 查询词到 project 的映射排序修复；提示词：候选源已被证实存在时必须完成一次最小 formal 尝试再比较成本 |
| B7 | **【环境陷阱】settings PUT 与实际执行模型不一致 → 静默跑错模型**。`PUT /api/v1/settings {model_name}` 只改 `settings.model_name`（显示层），但 `resolveActiveConfig` 用 `active_model_id` 指向的 registry model 记录（`model?.model_id ?? settings.model_name`）。Host 启动时 `bootstrapEnvironmentDefaults` 从 env 引导出一个 `model_dashscope_env_default`（model_id=当时的 qwen3.7-plus、context_window=1M、active=true）；之后 PUT 只改 `settings.model_name=qwen3.8-flash`，未动 active model 记录→**35 次调用全部实际打到 qwen3.7-plus、窗口 1M**（Pi session `model_change` 条目与 assistant.message.model 均为 qwen3.7-plus，铁证），与控制台 qwen3.7-plus 扣费一致。`GET /api/v1/settings` 又回显 `settings.model_name`，看似"已切 3.8-flash"，掩盖了不一致 | 产品（设置接线） | pi-session jsonl `model_change provider=dashscope modelId=qwen3.7-plus`；assistant `model:"qwen3.7-plus"`；registry active=`model_dashscope_env_default`(qwen3.7-plus/1M) 而 settings.model_name=qwen3.8-flash/256k | 正确做法：走 `POST /api/v1/model-registry/models` 建 3.8-flash 记录 + `.../activate`（会同步 settings）；**修复方向**：PUT settings.model_name 若与 active model 冲突应拒绝或级联切换 active；`GET /settings` 应回显真正解析出的 `resolveActiveConfig().modelId` 而非 `settings.model_name`；运行前用 session `model_change` 条目做身份断言。**部分修复（2026-08-29）**：`store.ts` 两处硬编码 `?? "qwen3.7-plus"` 已删除——无 env 模型名时 bootstrap 只注册 provider+key、绝不臆造 active model，`resolveActiveConfig` fail-closed；PUT/active 级联与显示层 truth 化仍待分流修复 |

## gold1-r3 @ qwen3.8-flash（2026-08-29，main@c22eb2452af7，task_ts_b5dccb47-29af-4668-896f-e210d9e8169d）

> 身份断言通过（settings/registry 双层 + Pi session `model_change` 铁证）。终态 **succeeded_publication**：`pub_brca_gse15852_gene_v1_86b05b62073c9e82`（GSE15852/GPL96 长表，8 artifacts，run 绑定）。0 压缩、1 次权限停审、0 HIL。
>
> **Token 消耗**（来源：`closure.json.run_usage`，即 usage 记账特性；发布前后拆分来自事件流逐调用 usage）：
>
> | 阶段 | 调用 | input | output | cache_read | 总计费 token | 墙钟 |
> | --- | --- | --- | --- | --- | --- | --- |
> | 发布前（发现→构建→Publication） | 19 | 207,693 | 3,967 | 987,136 | 1,198,796 | 663s |
> | 发布后（回执验证+报告） | **41** | 326,906 | **10,503** | 4,171,136 | **4,508,545** | 592s |
> | 合计 | 60 | 534,599 | 14,470 | 5,158,272 | 5,707,341 | 1463s |
>
> 上下文峰值 136,294 / 256k；首轮 29,157。**发布后阶段占 79% 计费 token、一半墙钟、73% 输出**——C2 的定量代价。

| # | 卡点 | 归类 | 证据 | 建议修法（暂不执行） |
| - | ---- | ---- | ---- | -------------------- |
| C1 | **检视 gzip 平台注释的诉求走向 shell 绕路**。seq 185 `process.exec bash.exe -lc "gzip -dc GPL96.annot.gz \| sed \| cut"` 被 supervisor fail-closed 停审（操作员 deny 后 run 恢复，模型改走 workspace_read/preview 正常完成任务）。核心资产预览/解压工具链只覆盖 zip，不覆盖单文件 gzip，模型看 .gz 内容只剩 bash 一条路 | 产品 | events seq 185 permission_requested；permissions.jsonl；deny 后 seq 200+ 正常推进 | extract/preview 支持 gzip 成员或加 `read_core_asset_text(decompress=auto)`；提示词明示"gz 载体勿走 shell" |
| C2 | **发布后验证循环冗长（定量：41/60 次调用、79% 计费 token、592/1463s 墙钟花在 Publication 之后）**。`publication_created`(seq435) 之后又烧了 ~570 事件：`workspace_read`×27 逐回执反复读、5+ 次重复同一句"I'll verify the remaining receipts"自述、`workspace_edit`×2 修订自己的措辞（其中 1 次失败 seq724）。诚实复核是好行为，但**无界重复**——已验证过的回执被再读 2-3 遍 | prompt | tools 计数：workspace_read 28 vs r1 全 run 仅 33 tool_started；上方阶段拆分表 | 提示词加收敛规则："每个 artifact/回执验证一次即记录结论；发布后回合预算 ≤N 次工具调用；发现重复读同一文件即停止" |
| C3 | **basic_statistics 对 536MB 主表字符串溢出**。工具报 `Cannot create a string longer than 0x1fffffe8 characters`（V8 单串上限），导致主表描述性统计未执行，模型如实标注"数值有效性仅依赖 Core expression_value_numeric 检查" | 产品（工具） | 终答"需要你协助"第 4 点；events 中 basic_statistics err 输出 | basic_statistics 改流式/分块解析或声明行数上限 + 抽样统计 |
| C4 | **无 SOFT 注释平台在 gene 级 schema 下直接不可闭合**。`download_geo_platform_annotation(GPL17586)` 返回 no downloadable annotation table → GSE76250（398 样本，最大配对系列）无法进 gene 级主表；模型未猜映射（正确），但该数据获取面在 gold 标准集上直接封顶 | 产品（覆盖面） | 终答阻塞清单第 2 点；tool_completed GPL17586 输出 | geo_platform adapter 支持 from library/探针命名推断的替代映射源（GeneCards/UniProt gene symbol 表）或提供 probe 序列比对通道 |
| C5 | **发现查询收窄空转**。追加 3 次 `search_geo`（GPL96/HGU133A 变体）total_count 0/1/0——在已知无同平台第二系列的方向上重复碰瓷 | prompt（轻） | 终答"发现查询收窄失败"段 | 同一约束变体重试 ≤2 次即止损（与 r1-B4 同族，正样本对照下影响小） |

- **行为正样本（值得保留进 prompt 教学）**：单平台同粒度设计优先（43T+43N/GPL96）、拒绝跨 GSE 拼行、发现"probe-mapping 行数未独立验证"后主动修订而非宣称、Benford/末位数偏差如实保留并解释为 MAS5 log2 平台特征、pairing 推导规则交人确认——r1 的 B2/B3（动态路由零调用、时限幻觉）在 r3 未复现。

### gold1 卡点状态刷新（2026-08-31，依据 r4 post-fix 复测；对齐评测规范 `data/gold/README.md`）

| 卡点 | 最新状态（r4 活体复验） |
|---|---|
| C1 gzip 视检→shell 绕路 | **已修+复验通过**：`core-asset-tools` gunzip 落地（triage「2026-08-31 框架修复落点」链 1 子集）；r4 中 bash 被 deny 后 `preview_core_asset` **一次通过 ×2**，无绕路无循环 |
| C2 发布后无界复核 | **大幅缓解**：回执读回通道打开（链 1 修复③+deny 附 hint）后 r4 post-pub 仅 15 calls/361s 且全为有效逐行验证（r3：41 calls/4.51M token 撞墙）；「预算上限」硬收敛仍开放；通用行为面已沉淀 `[System briefing]` |
| C3 basic_statistics 溢出 | 未复现（模型没再试）；**风险仍在**：r4 主表 870–909 MB，同工具再试必炸，条目保持开放 |
| C4 无 SOFT 平台不可闭合 | **仍存在（r4 再确认）**：GPL27630 无注释表（源侧事实），D2/C4 表达能力立项不变 |
| C5 检索变体空转 | 未复现：r4 仅 `search_geo`×1 即锁定候选（同路止损已沉淀 briefing） |
| （关联）B7 配置双轨 | r4 前双层断言（settings=registry=执行层）一次通过；activate→settings 反向同步已落地，legacy PUT 一致性仍开放 |

**r4 与评测规范的合规偏差（如实记录，正式对照实验前须修正）**：① 规范上下文**统一 1M**，r4 实际 256k（峰值 142k 未触发压缩，方向结论有效，但 gold1–10 全部历史 run 均为 256k，不满足新规范，后续重测须先改配置）；② 规范输入=各案例 `TOPIC.txt` 原文，`data/gold/gold1_*/` 目录尚未建立，r3/r4 用 `docs/evaluation/gold-v1/prompts/gold1.txt`（r3 另附加过交付描述，不合规）；③ 规范 run 记录入 `data/gold/<case>/runs-log.md`——待 case 目录建立后把 r3/r4 记录补入（本文两节即素材，避免与队友建目录的命名冲突暂不代建）；④ r4 未挂 supervisor（其 events-500 脆性未修），采用人工监控+durable 归档，证据链完整。

## gold1-r4 @ qwen3.8-flash（2026-08-31，main@07962047，post-fix 复测，task_ts_393e5b8b-2640-43c0-a03f-2ddc9367f782）

> **修复后回归样本**：与 r3 同 TOPIC、同模型、同 Host 姿势（重建→双层配置断言→`model_change` 铁证）。36 calls / 2193s / **3.73M token（r3 的 65%）** / 峰值 142k / **工具错误仅 2**（r3 为 7+，且十案普遍两位数起步）。
>
> | 阶段 | 调用 | token | 墙钟 | 对比 r3 |
> | --- | --- | --- | --- | --- |
> | 发布前 | 21 | 1,838,570 | 1536s | 大降（r3 发布前已烧一半） |
> | 发布后 | 15 | 1,893,629 | 361s | **自检有效完成而非漫游**（r3：41 调用/4.51M/592s 撞墙） |
>
> 终态 `pub_breast_tumor_normal_gse15852_d6614644a0eb07e5`（GSE15852/GPL96，9 artifacts 含新 `source_coverage_report.json`），86 样本 43T+43N **逐行回读确认**，5.06% 探针无映射/Benford 平台特征/单系列局限全部如实申报。

**已修项的活体复验（本次跑中直接目击）**：
1. **链 1 视检**：workspace_exec(bash zcat) 被 deny 后模型**一次即转向** `preview_core_asset` → **gz 预览一次通过 ×2（err=false）**。r3/D1/L2 的死墙实测消失。
2. **G1/E5 回执读取**：发布后 `inspect_source_coverage`×2 + `workspace_list/read` ×11 全部成功——模型第一次真正读回并逐行验证了自己发布的表（十案里从未有过），发布后开销从"撞墙"变成"验证"。
3. **wire `$projection`**：本 run 无动态路线，未覆盖（**该修复仍需一个动态案复验**，如 gold7/9/10 重跑）。
4. **B7 配置双轨**：run 前 settings/registry 双层断言一次通过（PUT 语义修复的行为面未深测）。
5. 队友新工具 `inspect_source_coverage`（a98a151a）已被模型自发采用——发现性良好。

**残留观察**：execute 第一次把发现阶段的 workspace asset 路径塞 `source_files` → `formal dynamic carrier lacks exact Core acquisition provenance`（retryable），模型自我诊断正确（"交付数据不依赖那次字节"）且一次修正成功——D2 类"Core acquisition provenance"门槛仍会对模型产生一次可预期的困惑税，guidance 未变。bash 冲动（第 2 次跨案复现）仍在，被政策正确接住。

**新退化风险记录（供组员测其余 case 时留意）**：`merged/primary.csv` 报告为 **870–909 MB** 主表——gene_expression.long.v2 全展开后体量巨大，`basic_statistics` 的 V8 单串上限（C3）在这种表上必炸；r4 模型未尝试跑它（进步），但该尺寸对下游下载/预览链是新压力点。

## gold2 @ qwen3.8-flash（2026-08-30，main@74b81a19c1ff，task_ts_183292cd-0e9d-439d-a5ae-2786fa9eba34）



> 身份断言通过（`model_change`=dashscope/qwen3.8-flash）。终态 **succeeded_publication（部分交付）**：`pub_luad_egfr_gse31852_probe_v1_8c9cb8a834cae23b`，probe-level 长表 4,128,828 行（33,297 探针×124 样本），validation 10/10 passed，coverage 1.0，7 artifacts。
> **但 gold2 题面三要求只闭合 1/3**：probe-level ✔；样本临床/EGFR 分组 ✘（NO_DATA）；gene-level 映射表 ✘（blocked）。模型对后两项给出了逐项尝试日志与请求清单，零虚构、零临时 CSV 冒充。
>
> **Token 消耗**（`closure.json.run_usage`）：
>
> | 阶段 | 调用 | input | output | cache_read | 总计费 token | 墙钟 |
> | --- | --- | --- | --- | --- | --- | --- |
> | 发布前（发现→验证→构建） | 39 | 550,645 | 6,244 | 3,239,040 | 3,795,929 | 1552s |
> | 发布后（回执+报告） | 30 | 165,667 | 4,681 | 3,705,856 | 3,876,204 | **267s** |
> | 合计 | 69 | 716,312 | 10,925 | 6,944,896 | 7,672,133 | 2414s（40min） |
>
> 上下文峰值 148,116/256k；0 压缩；1 次权限停审 + 1 次 workspace_exec 工具层直接拒绝（seq 848）；0 HIL。发布后 token 占 50% 但墙钟仅 11%——gold1 的 C2（无界验证环）规模显著缩小但仍存在（workspace_list×11 + workspace_read×11 复查回执）。

| # | 卡点 | 归类 | 证据 | 建议修法（暂不执行） |
| - | ---- | ---- | ---- | -------------------- |
| D1 | **gzip 载体检视五路全封 → 题面核心字段（EGFR 状态）无法核实**（C1 升级版）。模型想看 GSE31852 series_matrix 的 `!Sample_characteristics_*` 头：① bash/python gzip → 权限停审 deny（seq 698）+ 二次 workspace_exec 被工具层直接拒（seq 848）② curl → 生产快速拒绝 ③ preview_core_asset → 3 次失败 ④ navigate_page(E-utilities) → **本机 Chromium 未装** ⑤ scaffold → 不支持。结果 124 样本 `sample_group` 全 unknown，"突变 vs 野生"比较无法成立，只能报 NO_DATA | 产品 + 环境 | permission events；终答"尝试过的合法途径"清单（逐条带拒绝原因）；`npx playwright install chromium` 是其明示请求 | 同 C1（gzip 检视通道）+ run 机装 Playwright 浏览器；提示词可教"series_matrix 头可用 GEO SOFT 端点替代"（若 SOFT 通道存在） |
| D2 | **gene-level 映射在正式路线中不可表达**：GPL6244 注释已成功下载并 SHA-256 校验（7.19MB asset），但 mapping_files 传 workspace 路径被拒（`authoritative dataset identity requires Core acquisition provenance`），probe_long.v2 schema 无 gene 维度承载 → 题面"可追溯 gene-level 映射表"结构性无法闭合。模型没有伪造，正确 blocked | 产品（表达能力） | 终答未闭合项 2；execute@1009 err（带 mapping_files 的首次尝试） | gene_expression family 增加 probe→gene crosswalk 支撑表形态（gold10 taxon crosswalk 同族方案）或 mapping_files 支持 Core-acquired 资产绑定 |
| D3 | **`preview_core_asset` "registered asset was not found" 复现**（seq 799，下载后的资产首查不可解析）——r1-B7/B1、r3-C1 同一注册时序缺口未修，每次 run 都在重新付学费 | 产品 | events seq 783/799 两次 preview 失败对照 | 修 download→register 原子性（已在 B7/C1 建议内，此处是第 N 次实证） |
| D4 | **scaffold_dataset_execution_spec 空参调用 + gene_expression 不支持**：seq 967 先以 `args={}` 空调用失败，seq 973 带参仍失败（gene_expression 无 scaffold 路径） | prompt（轻）+ 产品 | events seq 969/973 | 工具 schema 必填校验前置提示；scaffold 支持面在 guidance 里写清 |
| D5 | **发现候选池枯竭无第二方案**：模型如实报告"搜过的 5 个系列中同时满足（人+LUAD+组织+矩阵+显式 WT/mut）仅 GSE31852，其余为小队列 PDX/细胞系/miRNA"——诚实，但未尝试"换检索式扩池"后再断言池枯竭 | prompt（轻） | 终答请求协助第 4 点 | 断言"唯一候选"前要求 ≥N 个不同检索式扩池（可与 gold8 搜索发现工具联合） |

- **正样本（保留进教学素材）**：execute 一次失败后自纠参数重试成功；124 样本组标签拒绝用模型知识填充（宁 NO_DATA）；拒绝 provisional CSV；请求清单可直接执行（含安装命令与授权选项）；发布后收敛比 gold1 快 2.2 倍（267s vs 592s）。
- 基础设施观察：supervisor 第 3 次死于 `operation_progress` 事件风暴时段的 Host 瞬时 HTTP 500（journal 停在 seq≤200）；本 run 起改用"人工监控+durable 归档"，证据完整性不再依赖 supervisor 存活。

## gold2-r2 @ qwen3.8-flash（2026-08-31，main@236e3c8f8a2a，**规范版复测**，task_ts_f696876d-f559-40e6-a074-fd348b1028c6）

> 首案按 `data/gold/README.md` 全流程执行：TOPIC=prompts 原文、上下文调至规范 1M、supervisor --adopt 挂账（2 次停审人工 deny 后续挂成功，journal 全程无断档）。62 calls / 45.9min / **6.96M token** / 峰值 158,674（1M 下压缩路径未触发）/ **工具错误仅 6**（上案 10+）。
> 终态 **succeeded_publication（1/3）**：`pub_gse31852_probe_93b14dd03566dacf`（4,128,828 行 probe 长表，validation 10/10，provenance 1.0，8 artifacts 含 source_coverage_report，**发布回执逐行回读验证**——抽样 raw_value 对上 GSM）。

**复验结果——已修项确认（+3 项新活体证据）**：
1. **D1/gzip 视检 → 已修生效**：`preview_core_asset` gz 解码一次通过 ×2（上案"五路全封"的最初一环）；模型仍先后两次伸手 `bash -c` / 纯 `zcat`（seq77/134 停审 deny）——**能力修好了，行为冲动残留**（briefing 止损条款管住了循环：两次被拒即弃，未再第三次）。
2. **D3/下载即登记 → 已修生效**：本 run preview 未再出现"registered asset was not found"（上案 seq799 死点）。
3. **G1/发布回执 → 活体打开通道**：post-pub 22×`workspace_read`+4×`inspect_source_coverage` 全成功，上案 4 种 ID 命名空间混乱一次未现；发布后 942s 全部用于**有效**审计对账（对照上案同款时间做无头漫游）。
4. **D2 gene-level 形态刷新（仍未闭合，但阻塞点后移了）**：mapping_files 注册通道这次**被接受**（validate 双绿灯+执行），死在基因级覆盖率闸门 `probe_coverage_required_gene_level`：GPL6244 是基因级 ST 阵列、ID_REF 本身是 Entrez ID，Core 折叠不进 symbol/ENSG，coverage 0.6666 < 0.80 → 判不发布。**新框架条目**：gene-required 闸门对"原生基因型探针平台"无折叠路径（K-编号 2 见下）。
5. **EGFR per-sample 状态 → 从"不可知"变"已证不可达"**（质变）：gz preview 已能开卷，但 SOFT 解码 153MB 的 `!Sample_characteristics` 区块在 ~21MB 之后，**preview 固定 head window 无随机寻址** → 模型判三条路（exec 被拒/preview 窗口/PDF 抓取无工具）全封，**明确拒绝引用记忆中的 BATTLE 名单造替换行**。新框架条目：大文件中段读取缺口（链 1 最后一段）。

| # | 卡点 | 归类 | 证据 | 建议 |
| - | ---- | ---- | ---- | ---- |
| M1 | gene-level 覆盖率闸门不认"Entrez-ID 即探针"平台（GPL6244 类），0.6666<0.80 连坐拒发 | 框架 | `probe_coverage_required_gene_level` failed 详情（终答原文） | 折叠规则加 Entrez→symbol 通道或此类平台 floor 特判 |
| M2 | preview head 固定窗口，无 offset/分块——大 SOFT/matrix 中段字段（正是题面所需）读不到 | 框架（链 1 尾段） | 终答"三条读取途径均被封死"②；153,415,533 B 载体 | preview_core_asset 支持 offset/length 分块读（workspace_read 已有，移植即可） |

**行为面记功**：`search_xena`×4 含控制查询（TCGA LUAD）全 0 → 判"本环境 provider 无响应"且**不再重试**（对上案 I4"单点判死"的完全反向修正）；样本分组宁缺不造。
**与上案对照**：46min/6.96M ≈ 40min/7.67M（耗时持平、错误减半、交付同档但验证深度质变——上案 probe 表发出去没读回，本案逐行抽样）。规范偏差记录：本次 supervisor 挂账成功（无 500 事件），但两次停审仍需人工；`data/gold/gold2_*/` 目录未建，本段即 runs-log 素材。

## gold3 @ qwen3.8-flash（2026-08-30，main@2c511efc5080，task_ts_307966b1-4398-4600-94c8-6c6886290b39）

> 身份断言通过。终态 **succeeded_publication（1/5 交付）**：`pub_egfr_uniprot_target_cefd96a001558066`（target_evidence 族，UniProt P00533 蛋白身份 + 3 supporting 表，7 artifacts）。题面五类数据：UniProt ✔ 正式；ClinVar 变异 ✘；COSMIC ✘（源边界，合理）；临床试验 ✘；PDB 结构 ✘；药物信息 ✘。
> 全程仅 137s / 20 calls / 峰值上下文 44k——三案最省，但**省的原因是提前收手**（见 E3/E4），不是高效。
>
> | 阶段 | 调用 | input | output | cache_read | 总计费 token | 墙钟 |
> | --- | --- | --- | --- | --- | --- | --- |
> | 发布前 | 13 | 53,555 | 3,783 | 427,008 | 484,346 | 95s |
> | 发布后 | 7 | 23,798 | 1,893 | 273,408 | 299,099 | 36s |
> | 合计 | 20 | 77,353 | 5,676 | 700,416 | **783,445** | 137s |

| # | 卡点 | 归类 | 证据 | 建议修法（暂不执行） |
| - | ---- | ---- | ---- | -------------------- |
| E1 | **ClinVar 变异行结构性不可闭合**：`clinvar.files.v1` 固定 provider 要求逐条 variant UID（VCV/SCV）绑定，gene 级工具只回计数；会话内**无变异 accession 发现通道** → 模型拒绝臆造 accession，整类报 blocker（判断正确，路是死的） | 产品（工具链缺口） | 终答 blocker 表行 2；tools 计数无任何 clinvar 发现调用 | 补 ClinVar esearch/efetch 受控发现工具（gene→VCV 列表），同 GEO esearch 家族 |
| E2 | **临床试验 NCT 发现通道缺失**：`clinicaltrials.files.v1` 只接受具体 NCT；无 NCT 检索工具；唯一替代探测 navigate_page(clinicaltrials API) → 400（Chromium 未装，D1-④ 环境复现） | 产品 + 环境 | seq 187-190；终答 blocker 表行 4 | 补 controlled trial 检索工具（query→NCT 列表）或装浏览器后教走 API 页 |
| E3 | **已激活的发现工具零使用（本轮最重行为卡点）**：`search_uniprot`/`search_chembl`/`search_pdb`/`lookup_clinvar_counts` 全部激活（seq 27），实际调用数 = 0。其中 PDB 结构表本可自解：search_pdb 枚举 EGFR-TKI 复合物 → 选 top-8/15 → 动态 protein_structure 构建——模型却把"需要 PDB 子集"作为"范围决策"上交用户；正文写"Let me verify controlled IDs"之后并未调用任何 lookup | prompt + 模型 | tools 计数 vs seq 27 激活清单；终答求助清单 1/2/4 条 | 提示词规则：**把"需要用户提供 X"写进终答前，必须先穷尽已激活的对应发现工具并在正文附调用证据** |
| E4 | **动态路线 0 调用复现（B2 变种，包装更精致）**：PDB（动态族可用）与 ChEMBL 药物信息（bioactivity family 可建，CHEMBL203 现成）均被声明"须单独 build/超合理轮次"而未尝试一次 `prepare_dynamic_family_publication`；模型特意注明"不把它包装成 NO_DATA"——诚实但仍是零尝试 | prompt | 终答"本轮没有任何一次 prepare_dynamic 调用"自述；20 次调用时间线 | 同 B2 修法（blocked/上交前至少一次实际 preflight/构建尝试） |
| E5 | **执行结果不回传产物 asset_id → 模型无法字节级自检自己刚发布的表**：execute 成功只返回 publication/manifest id；模型试猜 `asset_<16hex>`（manifest 后缀）被 schema 拒，遂如实声明"不能声称逐行核验"（对照 gold1-r3 靠 workspace_read 绕过——本 run 连 workspace 路径都没探）。观察缺口家族第 4 个变体（B1/C1/D1/D3 同族） | 产品 | seq 200-202；终答"未能读取产物字节"段 | execute/publication detail 返回 artifact asset_ids；或 publication artifacts 提供 preview 通道 |
| E6 | COSMIC 受保护源（登录/API key）按边界规则拒绝访问 | 非损失（合理阻断） | 终答 blocker 表行 3 | 无需修；如纳入标准集需授权导出 |

- **正样本**：6 次 execute 失败每次只修一个具体输入事实（"Fixing only that fact"，对照 gold1-r1 的乱猜参数是质变）；拒绝臆造 VCV/NCT/asset；终答逐 blocker 标注路由判定+归因+求助清单，且明确区分"失败事实 vs 范围决策"。
- 行为形态变化（三案对比）：gold1-r1=乱撞墙后幻觉时限放弃；gold1-r3=成功但发布后无界复核（79% token）；gold3=**未撞墙但提前收手**（工具在手不用）。C2 与 E3/E4 是两个方向的极端，提示词需要同时含"发布后收敛界"与"上交前穷尽界"。

## gold4 @ qwen3.8-flash（2026-08-30，main@0b534ce30d5a，task_ts_7d6e45c2-e136-4cbf-80f5-4d32cc06d1f5）

> 身份断言通过。**首次跑前安装 Playwright Chromium**（D1-④/E2 环境项消除；本 run 未依赖浏览器通道）。终态 **succeeded_publication ×2（2/4 交付）**：`pub_sarscov2-spike-ace2-structures_ef36631509d5bf32`（4 PDB 载体：6M0J/6LZG/6XM5/7JWY，含链/配体/pH 实验条件）+ `pub_sarscov2-spike-ace2-targets_edb3ace3986bf001`（Q9BYF1+P0DTC2），各 7 artifacts，走静态族路线。
> 未交付：文献表（acquisition 全败，G3）；变异表（静态族无 live provider，G2）。
>
> | 阶段 | 调用 | input | output | cache_read | 总计费 token | 墙钟 |
> | --- | --- | --- | --- | --- | --- | --- |
> | 发布前 | 21 | 70,742 | 2,483 | 756,736 | 829,961 | 82s |
> | 发布后 | **58** | 184,839 | 7,246 | 3,472,384 | **3,664,469** | 260s |
> | 合计 | 79 | 255,581 | 9,729 | 4,229,120 | 4,494,430 | 352s |
>
> 峰值上下文 74,245/256k；0 压缩；0 权限停审；0 HIL。20 次 tool 错误中 18 次发生在发布后。**发布后 58 次调用/81% token 全部花在"试图回读已发布回执"上**——终答自己总结："execute 只回 publication id，从不返回 `asset_…`；preview/cache reader 拒绝一切非 asset 标识 → stop probing"。

| # | 卡点 | 归类 | 证据 | 建议修法（暂不执行） |
| - | ---- | ---- | ---- | -------------------- |
| G1 | **已发布产物零读取通道（E5 的定量铁证）**：发布成功后，模型想用受治理通道核验自己产物字节——`workspace_list`×12（publication 文件不在 workspace 视图）、`preview_core_asset`×5（pub/manifest id 被 schema 拒）、cache readers×数（无 receipt 入口）共 20 错，烧 58 调用/3.66M token 后才停。E5 从"小不便"升级为**已证实的高成本产品缺口** | 产品（可观察性） | phase_split + tool_errors 序列；终答"Verification attempt … not supported by the exposed tool surface"段 | execute/publication detail 返回 artifact `asset_id` 列表（最小修），或提供 publication→preview 的受治理读取工具 |
| G2 | **`variant_evidence` 静态族无 live provider**：sources 仅 `registered_variant_*`（要求先有 task-owned Core 资产）→ 题面"关键变异表"静态路结构性不通；正确路线（dynamic over dbsnp/clinvar）模型自己找对了并要求确认 | 产品（family 设计） | 终答"no registered static source"段 | variant_evidence 接入 live provider（dbsnp esearch 家族），与 gold3-E1 同一根因（变异发现链缺失）合并立项 |
| G3 | **文献载体获取全军覆没**：`literature_evidence` validate 通过但 3/3 PMCID 采集失败——PMC13342853 Europe PMC fullTextXML `http_client_error`（两次复现，疑 http client 兼容性而非端点故障：PubMed 元数据显示 OA 存在）；PMC13059109/13213839 `BioC collection contains no document`（解析器对该类文章空返回） | 产品（provider 可靠性） | 终答未交付段 1；execute@343/356/785 err | 单独复现 http_client_error（带 headers 对照）；BioC 空文档应回结构化 `no_fulltext` 而非 invalid_input |
| G4 | **自检无界复发（C2 变种）**：对比 gold1-r3 有进步（最终主动 stop probing 并总结原因），但止损仍花了 58 调用；若提示词写明"回执通道不可用时，以 publication 事件+artifact roles 为核验终点"，可省 ~80% token | prompt | phase_split 比例 | 提示词加"发布后核验预算 ≤N 次；连续 2 次同类工具失败即停止该通道尝试" |

- **正样本（本四案最强）**：载体甄别——search_pdb 假命中 5 件（7AN4 弯曲菌差向异构酶、6VN2 USP7、7NX3 ALK…）**全部剔除且给出物种/蛋白理由**；保留结构逐条带分辨率+PMID；"载体获取失败 ≠ 文献不存在"的区分；拒绝臆造变异行；Dynamic 变异构建给出完整方案后请求范围确认（对比 gold3-E4 的"要清单但工具在手不用"，这次的确认请求附了具体 provider/位点方案，属合理边界）。

## gold5 @ qwen3.8-flash（2026-08-30，main@1a9c070dfb1b）

### r1（task_ts_9046f9e7，已取消）＝ stale-build 灾难样本（H3）

Host 的 `contracts/dist`（21:38 构建）落后于队友 `c005e323`（23:07，receipt 字段 `sandbox_backend`→`execution_backend`）；重启 Host 时只重编 server 没重编 contracts → **producer（server，新）生成的 receipt 被 consumer（contracts dist，旧）判 `Unknown field "execution_backend"`**。模型 146 轮/89 错/48% 错误率，prepare×22 / submit×23 全灭，峰值上下文 237k/256k 贴线挣扎后被操作员取消。证据保留于 `data/gold-runs/1a9c070dfb1b-gold5-qwen38flash-r1-stalebuild/`。
**运维纪律见 [triage.md](triage.md) B 类 H3**（重启 static Host 前必须 `pnpm build`；此错误分布即"撕裂版本"铁证，不记为模型卡点）。

### r2（task_ts_090c5c7c，全量重建后）＝ succeeded_publication（1/3 交付）

> 身份断言通过。终态：动态路线正式发表 `pub_egfr_pubchem_structure_v1_35f249ec7077b0ee`（erlotinib 完整结构记录：CID 176870、分子式/MW/SMILES/InChIKey/IUPAC，绑定 `pubchem.files.v1` receipt+carrier 闭环）。
> 题面交付：PubChem 结构 ✔（仅 1 药）；**ChEMBL assay/activity ✘ NO_DATA（0 行）**；L858R/T790M 变异语境 ✘；跨源整合 ✘。零臆造、无 provisional CSV、未发布候选（gefitinib/afatinib/osimertinib CID + 7 个 ChEMBL ID）如实列发现级。
>
> | 阶段 | 调用 | input | output | cache_read | 总计费 token | 墙钟 |
> | --- | --- | --- | --- | --- | --- | --- |
> | 发布前（含 19×prepare） | 74 | 317,011 | 45,100 | 4,595,712 | 4,957,823 | 850s |
> | 发布后 | 9 | 11,533 | 2,403 | 1,191,936 | 1,205,872 | 93s |
> | 合计 | 83 | 328,544 | **47,503** | 5,787,648 | 6,163,695 | 963s |
>
> 峰值上下文 136,407/256k；0 压缩/停审/HIL。**成本形态反转**：动态路线把开销推前到构建段（prepare×19、output 47.5k 为五案最高），发布后黑洞（G1）本次仅 9 轮。

| # | 卡点 | 归类 | 证据 | 建议修法（暂不执行） |
| - | ---- | ---- | ---- | -------------------- |
| H1 | **ChEMBL 发现→绑定断链（题面核心死锁）**：`search_chembl` 能拿到真实 CHEMBL ID（5 次成功），但 `chembl.files.v1` 动态绑定校验门 ~11 种参数形态全拒（"does not accept binding parameters; fixed provider"、"requires 1-32 valid ChEMBL compound IDs"、comma-list/entities-carried 均不行）——**发现工具的输出喂不进同源的 fixed provider**，activity 数据结构性进不来 | 框架（与链 2 同族） | prepare×19 错误分布；终答 blocker 段 | 复现 `chembl.files.v1` accession 校验逻辑，接受 search_chembl 产出的 ID 形态；不通则 B 类新增"ChEMBL 绑定门"实例 |
| H2 | **validate 假绿灯**：静态 `bioactivity_measurement` `validate_dataset_execution` 返回 `valid:true`，但 `activity.v1` schema 对题面明列字段（`assay_condition/assay_description/canonical_smiles/document_doi/pchembl_value/published_*`）全报 `unknown_required_field`，跨源 spec `entity_level_schema_mismatch`——**validate 通过 ≠ 需求可表达**，模型依绿灯走了弯路才发现 | 框架（校验语义） | 终答"Exact blocker"段；validate/execute 矛盾记录 | validate 应把 spec 需求字段与 schema 能力做覆盖检查，表达不了直接 invalid + 指路动态/替代族 |
| H3 | （r1，见上）stale-build 撕裂 + 裸启动绕过构建钩子 | 运维纪律 | r1 错误分布 + dist/src mtime 对照 | gold 流程文档加一条：重启 static Host 前必须全量 `pnpm build` |
| H4 | **发布产物读取四命名空间混乱再实证（E5/G1 续）**：模型试 `workspace_read(tables/…)`（发布表不在 Agent 视图）→ `preview(artifact_32hex)`→ `preview(裸 digest)`→ 只有 `preview(carrier asset_64hex)` 通 | 框架 | 终答自述 4 种失败与各自原因 | 同链 1 修复：publication detail 直接给可 preview 的 asset_id |

- **正样本（显著成长）**：发布后自检仅 9 轮即止损——逐一试探 4 种 ID 命名空间、**主动修正自己上一条的 overstatement**（"Correction: … 那言过其实了"）、明确"没有读取路径我就不声称读过"；突变体处理给出专业判断（L858R/T790M 应为 assay 的 variant_context 列而非独立 target ID，并请用户确认口径）；候选药物 CID/InChIKey 全部真值留档不冒充已发布。

## gold7 @ qwen3.8-flash（2026-08-30，main@9e90eb252089，task_ts_ce0f3f8e-f864-4501-8b13-9382f5b3f2a1）

> 题面依据 gold789-case-chapter §5.2 重建（无 prompts 文件）。历史死点（"GWAS family/Core provider 缺失，只能 workspace staging"）本次被**动态 Family 路线突破**：`pub_ad_gwas_risk_map_e76103f1b9751ace`（risk_loci 89 行正式发表，逐行 association_id+source_url 可溯）。
> **本 run 同时是 H3 修正证据**：receipt-only submit 在全新构建下仍报 `Expected object at $projection`×3（seq294/314/388，模型入参顶层确为 `{schema_version, preflight_receipt}`），之后同型错误自行消失、进入实质迭代——**stale-build 不是该错误的唯一成因，wire 存在真缺陷**（疑与 stored-submission 重解析或 a98a151a proposal DTO 变更有关，待复现）。
>
> | 阶段 | 调用 | input | output | cache_read | 总计费 token | 墙钟 |
> | --- | --- | --- | --- | --- | --- | --- |
> | 发布前（16×prepare+18×submit 迭代） | 56 | 425,951 | 90,496 | 6,031,360 | 6,547,807 | 1247s |
> | 发布后 | 7 | 7,865 | 1,535 | 1,383,424 | 1,392,824 | 151s |
> | 合计 | 63 | 433,816 | **92,031** | 7,414,784 | 7,940,631 | 1445s |
>
> 峰值上下文 200,214/256k（贴线未压缩）；0 压缩/停审/HIL；navigate_page×3+download_from_page×2 **浏览器通道首战全通**（今日 `npx playwright install chromium` 生效）。**output 92k 为七案最高——动态构建的结构性成本**：transform 源码整段重写 ×16+。

| # | 卡点 | 归类 | 证据 | 建议修法（暂不执行） |
| - | ---- | ---- | ---- | -------------------- |
| I1 | **Dynamic 单 projection 全表耦合（all-or-nothing）**：`studies` 表数据已全量核实（39,106+46,828+401,577 队列/平台/imputation），但同一 projection 内 `variant_genes` 空表把整个 build 拖死（`table 'variant_genes' must not be empty` 拒绝传导）→ studies 连带不能发布。模型提出"拆三次独立构建"的正确方案后**停手等确认**而非自行拆分重试（拆建完全在其权限内） | 框架（拓扑设计）+ 模型（穷尽界边缘） | submit seq476/609/652 序列；终答未完成项 1 | 框架：allow per-table partial publish 或明确提示"拆 build"路径；提示词：自己给出的可行方案应在本 run 内执行，不许上交待办 |
| I2 | **`dbsnp.files.v1` Core 内返回空载荷**：rs6733839 的 refsnp JSON provider 未取回（工具面 `lookup_dbsnp` 历史正常，Core provider 形态空回）→ GRCh38 逐条核验与 gene 映射两项停在 staging | 框架（provider 缺陷） | 终答未完成项 2；attempt 记录 | 复现 `dbsnp.files.v1` egress/解析路径；与链 2 变异发现合并立项 |
| I3 | **staging 资产命名空间割裂再现（D3/B1/E5 同族）**：`download_supplementary` 成功取回 27.6MB 官方 ZIP 落 `source_assets/`，`preview_core_asset` 报 "registered asset was not found"——下载即注册断链的**新实例**（这次连 execute 补登记的旁路都没触发，因为后续没再 execute 该载体） | 框架 | 终答未完成项 2 原话；asset_b2103d7d… 路径 | 链 1 修复时覆盖 `download_supplementary` 路径的登记原子性 |
| I4 | **单点探测即判通道死**：`dbsnp.files.v1` 仅试 rs6733839 一个位点空回就归因"provider 不可用"（区分不了全灭 vs 单记录缺失），给框架报了偏重诊断 | 模型 | 终答未完成项 2 措辞 | 归因前 ≥2-3 个独立样本探测，按失败率报告 |

- **正样本（继续保持高水准）**：`_embedded.associations` 嵌套路径探测失败后写出**根因说明**（顶层键探测→0 行）供后续复用；明确拒绝"从未可读出的压缩包臆测 75 位点"；终答自带**证据分级提示**（"勿据已发布表宣称复现分阶段结果"）；发布后 7 轮即收。
- 提交侧错误谱（18 次 submit 全记录在 assistant-messages/closure）：$projection×3（wire 缺陷，见上）→ digest drifted×2 → transform 只读赋值错误 → OUTPUT_BYTES_MISMATCH → 空表×4 → TS 语法 → receipt superseded → 成功。形态=有效学习曲线，与 gold5-r1 的平线 thrash 形成对照（那次是撕裂构建，这次错误每轮变化）。

## gold8 @ qwen3.8-flash（2026-08-30，main@0335ce92a1f8，task_ts_304c82c8-7dfe-4372-8479-d99efa121e0a）

> 题面依 §5.3 重建（无 prompts 文件）。终态 **succeeded_publication（1/4 表，且仅 1 药）**：`pub_dili_faers_counts_15070cb556142758`（动态 Family，acetaminophen 的 FAERS PT 计数，4 artifacts，载体经 `openfda.files.v1` Core 采集）。历史对照：e2e-rerun3 同题发过 9 药 68 行——本次回退到 1 药（J4）。
> 78 calls / 1864s / 6.42M token；4 次人工权限裁决（全 deny，外部锚定）；0 HIL/压缩。
>
> | 阶段 | 调用 | input | output | cache_read | token | 墙钟 |
> | --- | --- | --- | --- | --- | --- | --- |
> | 发布前 | 49 | 166,036 | 16,304 | 3,011,968 | 3,194,308 | 538s |
> | 发布后 | 29 | 140,340 | 3,815 | 3,079,168 | 3,223,323 | **1316s（71%）** |
> | 合计 | 78 | 306,376 | 20,119 | 6,091,136 | 6,417,631 | 1864s |
>
> 峰值上下文 121,086/256k。

| # | 卡点 | 归类 | 证据 | 建议修法（暂不执行） |
| - | ---- | ---- | ---- | -------------------- |
| J1 | **名册类外部源零 provider + 官方站全灭**：DILIrank 六通道逐一实证不可达（`dilibank.ncats.io` DNS ENOTFOUND、GitHub 页 404、ftp 镜像 404、DOI 404、code search 401、论文闭源无 OA 附表）→ 名册/标签两表 NO_DATA，题面 2/4 表依赖它。系统只有"用户提供文件"一条路，而**用户上传→Core 权威资产**的正式通道不存在（quarantine 旁路明确非权威、不进发布链） | 框架（覆盖面）+ 外部事实 | 终答 §3 逐 URL 列表；navigate_page 错误谱 | 定义"用户上传→task-owned Core 资产→绑定"的受治理正式通道（区别于 quarantine）；DILIrank 镜像准入 |
| J2 | **Bookshelf HTML 无 formalize provider**：LiverTox 专论页面**可读**（navigate 成功）但没有 Core provider 把 HTML 变不可变载体 → "not publishable"。即 TODO"Recipe 格式宽路径（HTML/PDF+人审字段映射）"的实测代价 | 框架（覆盖面） | 终答 §3 Table 3 行 | 按 TODO 宽路径立项，先打通 HTML→registered parser→field_mapping HIL |
| J3 | **G1 回执黑洞的最大形态**：发布后 29 调用/71% 墙钟全花在"想读回自己发布的回执"——`preview_core_asset`×17（16 拒：artifact 32hex≠asset_64hex）、workspace 探测×12、`/publications/*` 外部锚定 4 次权限停审全 deny。终答结论健康（"receipt-asserted, not independently confirmed"），但代价 22 分钟 | 框架（链 1 定量） | tool_errors 25+；permissions.jsonl 4 条；终答 §2 | 链 1 修复（execute 返回 asset_ids）同时消掉此形态；权限拒绝响应应附"该路径不存在读取通道"语义（现在只有 denied，模型只能继续猜） |
| J4 | **可达面自我设限**：FAERS 计数不依赖名册（逐药 openFDA 可查），历史 9 药 68 行成功；本次只绑 1 药即收尾，终答解释"只有 acetaminophen 有可溯源真记录"与历史事实矛盾（amox-clav 404 是名称形态问题，其余药物未见逐个尝试记录） | 模型（穷尽界）+ 待复现区分 | tool 计数 lookup×2/acquire×2 vs 历史 9 绑定 | 复现确认：若动态绑定 per-drug 成本过高→框架（批量绑定）；若模型没试→穷尽界条款覆盖"同类可复制的成功绑定应做到样本上限再收" |
| J5 | **`$projection` wire 缺陷第 3 案**：submit@796/815 同错复现（全新构建），模型再次绕路成功 | 框架 | 本案 + gold5-r1 + gold7 | 同"wire 缺陷"行，优先级升高（3/3 动态案全中） |

- **正样本**：browser 韧性首次全面生效——官方源探测六通道**逐 URL 带失败原因**（对比历史上 555 次暴力枚举是行为质变）；拒绝用模型记忆臆造 50 药名册；两个无匹配 PT 记 unavailable 不记 0；求助清单含可执行域名/文件类型。
- 诚实边界与历史一致：FAERS 计数=MedDRA PT 报告次数语义已在终答声明；部分维度正式+其余结构化阻断仍是该上游条件下的正确终态。

## gold9 @ qwen3.8-flash（2026-08-30，main@0335ce92a1f8，task_ts_ea697df6-40a4-46b5-aab0-52db247419c2）

> 题面依 §5.4 重建。**全九案成本之王：20.49M token（次高 2.6 倍）/ 118 calls / 90 分钟 / output 217.6k**。终态 succeeded_publication——**但正式物本身是 383 字节的通路探针**（transform=`pid.nlfix_probe`，BTK 单基因 2 行，row_count 硬编码），模型自己在终答里这么定性："该发布证明 Dynamic 路线可对 Core-acquired 载体执行发布——**不是**已完成的 PID 产品，我不作超额宣称"。四表实际状态：T1 基因/T4 跨源证据 有行（provisional workspace 层，回读验证）；T2 疾病/T3 关联 **故意留空 NO_DATA**（无可达源，填=造假）。
> 前 35 分钟：Orphadata 官方端点 ~15KB/s 爬完 74MB（execute 下载阶段**零进度事件**，与挂死无法区分——观测点）。
>
> | 阶段 | 调用 | input | output | cache_read | token | 墙钟 |
> | --- | --- | --- | --- | --- | --- | --- |
> | 发布前（prepare×22+submit×15） | 98 | 1,628,412 | **211,798** | 14,336,128 | 16,176,338 | 5035s |
> | 发布后 | 20 | 68,541 | 5,804 | 4,240,512 | 4,314,857 | 325s |
>
> 42 次工具错误；0 压缩/停审/HIL。**模型对 42 失败做了逐类对账表**（见正样本）。

| # | 卡点 | 归类 | 证据 | 建议修法（暂不执行） |
| - | ---- | ---- | ---- | -------------------- |
| K1 | **静态适配器 32MiB 容量上限**：Orphadata en_product1.xml 54MB 物理进不了 `registered` 文件通道 → 疾病目录这一题面起点只剩动态 transform 自己啃 | 框架（容量） | 终答 ledger reconciliation "static adapter caps (54 MB > 32 MiB)" | 大 XML 分块/流式 provider，或容量分级准入 |
| K2 | **transform_source 尺寸天花板 → 四表 integrator 装不进一次提交，被迫降级发探针**：完整变换（多 binding+列映射）超 envelope 被截断（模型多次 truncated echo 失败），最终只能发"通路证明"探针版 | 框架（提交面契约） | 终答求助 2（"Server-side preflight_receipt resolution, or a larger transform_source envelope"） | prepare 分步提交 transform 模块 / 提高上限 / receipt 端存代码只传引用 |
| K3 | **transform 方言限制的成本中心**：禁 bracket access（`a[0]`）+ 模型在 JSON 里写 `\n` 到 Core 变字面 backslash-n——**同一 OUTPUT_BYTES_MISMATCH 烧 ~10+ 轮** 才自检出 `String.fromCharCode(10)` workaround。九案 20M token 的主要来源是这 37 次 dynamic 迭代 | 框架（方言教学）+ 提示词（二分定位） | 终答收回声明 1；prepare/submit 错误谱 262→882 | 方言文档给出换行/下标的官方 workaround 清单； admission 报错附最小可复现样例 |
| K4 | **`$projection` wire 缺陷第 4 案实锤**：模型自己数出 "receipt-only `$projection undefined` ×3" 并列入对账表 | 框架 | 终答 ledger reconciliation | 同 wire 行，**优先级=最高**（4/4 动态案全中） |
| K5 | **G1 依旧**：发布物 5 件 artifact 全部读不回（"ID-form gate + Core storage isolation"），verification limits 段如实画界 | 框架（链 1） | 终答 verification limits | 链 1 |

- **正样本（九案诚实度峰值）**：**自我收回两个结论**（"Orphanet 空载体"撤回并归因自身换行 bug；"583=pathogenic+likely" 改标 "pathogenic-only，total 1158"）；对 42 失败做逐类别对账；探针发布不作产品宣称；T2/T3 宁空不造；ClinVar 复核 ADA/CARD11/RAG1 与 Table4 逐值一致后才写报告。

## gold10 @ qwen3.8-flash（2026-08-30，main@1a8161cd，task_ts_6da1b112-27e9-4a7b-9416-84140379da5e）

> 题面依 `docs/plans/gold10-four-table-closure.md` 重建。终态 **blocked_no_publication**——历史同题（main@d084a7e4）曾四表正式闭包，本次回退。108 calls / 1185s / 9.2M token 全烧在发布前（post=0）；峰值上下文 135k；44 工具错误（execute×22 失败）。
> 模型自己确认的关键事实链：① `gut_microbiome` 静态族 `registered_multitable_identity` **要求每次 run 四表全非空**（部分 build 结构性拒绝）；② 差异丰度（DA）表唯一输入=补充材料，但 **xlsx 成员与 extract_core_archive 解码产物 media type 全是 `application/octet-stream`**，DA 适配器只接受 `text/csv`/xlsx 真型 → DA 断链 → 四表整体 all-or-nothing 连坐；③ 模型退而求其次试 **三表 partial（转动态）——prepare×7/submit×2 全败**，其中 `Expected object at $projection` 第 5 案（seq1240）。

| # | 卡点 | 归类 | 证据 | 建议修法（暂不执行） |
| - | ---- | ---- | ---- | -------------------- |
| L1 | **模型回声死循环（十案未见的新退化形态）**：末段 ~20 轮把"I'll test the two decisive remaining facts (GMRepo reachability, plain text/csv members)"同句复读 10+ 次而**不产生对应工具调用**，最终 run 在"明知三表可发"（终答原话 "Three tables now close; only differential abundance blocks"）状态下自我终止、0 发布。GMRepo 可达性始终未实测 | 模型（退化）+ 框架（无 nudge 机制） | assistant-messages.md 尾部复读段；events 尾部 tool_started 空白区 | 运行时检测：连续 N 轮正文相似度高且零工具调用 → 注入一次 steer（"执行你反复声称要测的那一个调用"）或触发 no_progress 护栏；提示词侧：要求每段计划句必须绑定一个工具调用 |
| L2 | **DA 载体 media-type 断链**：论文补充 xlsx（该表现实世界主形态）经 acquire→preview/extract 全链路后 media type 停在 octet-stream，DA 适配器拒收；d084a7e4 落地的 `paper_supplement_differential_abundance` xlsx 解析通道**存在但 guidance 未覆盖**，模型找不到只能外围试探 20+ 次 | 框架（通道可见性）+ 提示词（guidance） | 终答 "Decoded worksheet is still application/octet-stream, not text/csv" | extract 解码产物按成员真实类型标注 media type；research_data_guidance 的 microbiome 段点名 xlsx→DA 适配器绑定姿势 |
| L3 | **静态多表族 all-or-nothing 的又一处实例**（I1 同族，静态侧）：四表强制齐闭合 → 一个载体的 media-type 缺陷连坐全案 | 框架 | "Confirmed: ...requires all four tables non-empty in every run" | I1 合并立项：partial publish + 缺失维度结构化声明 |
| L4 | **`$projection` wire 缺陷第 5 案**（seq1240），且这次连 3 表 partial 转动态也杀掉 | 框架 | submit@1240 | 同 wire 行（5/5 动态案全中，已是铁案） |
| L5 | **spec 作为 JSON string 有 4096 字符 transport 限制**（模型原话"named a transport limit (4096 chars), not data"）：多绑定四表 spec 逼近上限，进一步压缩 transform 表达空间（K2 同族） | 框架 | 终答三表尝试段 | 与 K2 信封提升合并 |

- **诚实面**：全程零臆造（DA 拿不到就明说 GMRepo 未测、xlsx-only pattern 如实标注）；对每次拒绝都按"Core 指名的精确事实"逐条修正（这句口头禅质量高）。但 L1 使诚实结论本身也没能送达（末段退化，终答不完整）。

## 十案全景（gold1–gold10 全部 @ qwen3.8-flash，除 r1 系 3.7-plus）

| case | 交付 | token | 墙钟 | 主病因 |
|---|---|---|---|---|
| gold1-r3 | 1 pub ✔ | 5.71M | 24min | C2 复核黑洞 |
| gold2 | 1/3 | 7.67M | 40min | D1 视检死路 + D2 表达缺口 |
| gold3 | 1/5 | 0.78M | 2.3min | E3 工具不用（提前收手） |
| gold4 | 2/4 | 4.49M | 5.9min | G1 回执黑洞 |
| gold5 | 1/3 | 6.16M | 16min | H1 发现-绑定断链 |
| gold7 | 1/3 | 7.94M | 24min | I1 projection 耦合 |
| gold8 | 1/4(1药) | 6.42M | 31min | J1 名册源全灭 + J4 设限 |
| gold9 | 探针 | 20.49M | 90min | K2 信封 + K3 方言 |
| gold10 | 0 | 9.20M | 20min | L1 回声死循环 + L2 media-type 断链 |

**跨案恒等式**：① `$projection` 5/5；② 链 1（视检/回执）9/9 案至少付一次税；③ all-or-nothing 在静态（L3）与动态（I1）两侧都存在；④ 行为两极（提前收手 gold3/J4 vs 无界烧钱 C2/G4/L1）需提示词双向约束。合计 10 案 ~69M token、≈3.4 小时 live run。



（空。每完成一个案例，按模板追加；同步把 `closure.json` 的 `run_usage` 抄入本表上方案例头部，便于比较提示词/路线变化对 token 的影响。）

## 已登记的兄弟事实（不重复展开）

- gold8 枚举 555 次 / DILIrank 404 韧性缺口 → [ISSUES](../ISSUES.md) 与 [TODO](../TODO.md) 已各有条目；本文档只在案例复跑暴露**新的行为面**卡点时补条目。
- gold9 跨源空列（回答宣称与发布表不符）→ TODO "gold9 跨源数值列行级填充率门"。
- 行为观察类（浏览器绕路、思考模式等）历史细节见 `data/gold/` 各案例 runs-log（本机）。
