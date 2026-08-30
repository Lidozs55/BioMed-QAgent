# 模型卡点收集（gold 正式运行观察）

> 目的：集中收集各 gold 案例正式运行中暴露的 **Agent 行为卡点**（提示词、产品、接口陷阱三类），供后续**批量**修复与提示词优化对照。
> **当前处于收集期：只登记，不修改代码。** 等组员把其余案例测完后再统一分流修复（跟踪项见 [TODO](../TODO.md)）。
> 纪律：每条卡点必须给出证据（事件 seq / 证据包路径 / 正文原话），不可证的不进表；证据包在 `data/gold-runs/`（git 忽略，随 run 机器保留）；用量与终态见各包 `closure.json`（`run_usage`）。

## 条目模板

```markdown
### <case> @ <model>（<日期>，main@<commit>，task_ts_…）

| # | 卡点 | 归类 | 证据 | 建议修法（暂不执行） |
| - | ---- | ---- | ---- | -------------------- |
```

归类：**模型面**（知识不足/奇怪想法/工具描述不清可提示词解）/ **框架面**（框架限制死需动代码）/ 源边界（非损失）。

## 修复面分流（两分类总表，以此为准）

各 run 表格里历史标注的"prompt/产品/接口陷阱"归类保留作记录，分流修复时**以本节为准**。

### A 类：模型认知 & 工具描述不清 → 提示词可解

| ID | 一句话病因 | 提示词切入点 |
|---|---|---|
| B2 / E4 | 动态路由零调用（想象复杂度/包装成"范围决策"） | **穷尽界**：blocked/上交前必须实际调用一次 dynamic preflight 并附结果 |
| B3 | 幻觉外部时限（预算 240 只用 35 就"等用户指示"） | 提示词写明 turn 预算事实；禁止以"时间限制"作放弃理由 |
| B4 / C5 / D5 | 同路重复撞墙；检索变体空转；不扩池就断言"唯一候选" | 同一约束重试 ≤2 次止损；断言池枯竭前 ≥N 个不同检索式 |
| B5 | 未 activate 直接调用，吃 Tool-not-found（工具懒加载规则未学会） | 教学 skill→tool 映射与先激活后调用；工具报错文案内联激活用法 |
| D4 | `scaffold_dataset_execution_spec` 空参调用 | 教学 schema 必填约束（工具描述不清属此面） |
| B6（前半） | search_gdc 首结果不对路就直接放弃整个 GDC 线 | 候选被证实存在时必须完成一次最小 formal 尝试 |
| C2 / G4 | 发布后无界复核（gold1-r3 烧 79% token；gold4 试 58 调用撞同一堵墙 20 次才停） | **收敛界**：发布后核验预算 ≤N 调用；同一通道连续 2 次失败即止损并以 publication 事件为核验终点 |
| E3 | 四个发现工具全激活零调用，向用户要本可自得的清单（PDB 子集/NCT） | **穷尽界**："请用户提供 X"前必须实际调用能拿到 X 的已激活工具并附证据 |
| I1(模型半) | **可行方案不执行、上交待确认**：模型自己诊断出"拆三次独立 build"是正解且完全在其权限内（prepare/submit 自家工具），却写进"需要您的协助"第 3 条终止——因权限面 deny 经验（C1/D1）错误泛化为"改构建形态需请示"；63/240 轮即收尾 | **执行优先条款**：凡不超出已激活工具权限、不需要外部凭证的方案，进求助清单前必须本 run 内实际执行一次并报告成败；求助清单只放真正的用户输入（凭证/文件/口径决策） |
| I4 | **单点探测失败即判整通道死**：gold7 对 `dbsnp.files.v1` 只试 1 个 rsID 空回就归因"provider 不可用"；无法区分"全灭 vs 该记录缺失"，也给框架立项报了过重的诊断 | 归因前 ≥2-3 个独立样本探测，终答按样本粒度报告失败率 |

### B 类：框架限制 → 需动代码

| ID | 一句话病因 | 修复入口（立项建议） |
|---|---|---|
| B1 / D1 / D3 / E5 / G1 / H4 / I3 | **载体检视与发布回执链**（同一根因链，最高优先）：preview/extract 不认 gzip；download 后资产首查 "not found"（D3/H4/I3 三个入口实例）；execute 不回传 artifact `asset_id`；已发布产物全工具面零读取通道（artifact_32hex/裸 digest/workspace 路径全不可达）——gold4 实证烧 81% token 撞墙，gold2 因此把题面字段判成不可核实 | 一个代码立项：① execute/publication detail 返回 artifact asset_ids（最小修）② preview/extract 支持 gzip ③ 所有 download/acquire 工具落盘+登记同事务原子化 |
| E1 / E2 / G2 | **变异/试验发现链缺失**：clinvar.files.v1 要逐条 VCV 但无 accession 发现工具；clinicaltrials provider 要具体 NCT 但无检索工具；`variant_evidence` 静态族无 live provider | 补 esearch 家族发现工具 + variant_evidence 接 live provider（同族合并） |
| D2 / C4 | **表达能力缺口**：gene-level 映射在正式路线中不可表达（mapping_files 拒 workspace 路径、probe_long.v2 无 gene 维度）；无 SOFT 注释平台直接不可闭合 | gene_expression family 增加 crosswalk 支撑表（参照 gold10 taxon crosswalk 方案）+ mapping_files 支持 Core-acquired 绑定 |
| B7 | **配置双轨**：PUT settings 只改显示层、registry active 记录才是执行层（r1 整场跑错模型计费）。硬编码 default 那半已修（`fix/no-hardcoded-model-defaults`） | 剩余：PUT/active 级联或冲突拒绝；GET /settings 回显 `resolveActiveConfig()` 真值 |
| C3 | basic_statistics 对大表字符串溢出（V8 单串上限） | 流式/分块解析或声明上限+抽样 |
| G3 | literature_evidence provider 可靠性：Europe PMC `http_client_error` 双复现、BioC 空文档回 `invalid_input` 误导重试 | 复现对照 headers；空全文应回结构化 `no_fulltext` |
| B6（后半） | search_gdc 查询 "breast cancer TCGA" 首结果 TCGA-LUAD | provider 查询→project 映射排序修复 |
| H1 | **ChEMBL 发现→绑定断链**：`search_chembl` 拿到的真 CHEMBL ID 喂不进 `chembl.files.v1` 固定 provider 的 validity 门（~11 种参数形态全拒），gold5 题面 activity 数据结构性进不来 | 复现并修复 provider accession 校验门，接受自家发现工具的输出形态（链 2 合并立项） |
| H2 | **`validate_dataset_execution` 假绿灯**：valid:true 但 schema 表达不了需求字段（`activity.v1` 对 assay 条件/单位/跨源列全 `unknown_required_field`）——校验层与表达层脱节 | validate 增加"spec 需求字段 × schema 能力"覆盖检查，不可表达直接 invalid 并指路 |
| I1 | **Dynamic 单 projection 全表耦合**：一张空表（variant_genes）拖死同 build 内数据已全部核实的 studies 表，gold7 因此 2/3 交付 | per-table partial publish，或拒绝信息直接指路"拆独立 build"；另：模型给出拆建方案后停手等确认——穷尽界提示词一并覆盖 |
| I2 | `dbsnp.files.v1` Core provider 返回空载荷（工具面 lookup_dbsnp 正常）→ GRCh38 坐标核验进不了正式链 | 复现 provider egress/解析；并入链 2 变异发现立项 |
| I3 | staging 资产命名空间割裂新增实例：`download_supplementary` 的 ZIP 落 source_assets 但 preview "registered asset was not found"（链 1 断点的又一入口） | 链 1 修复时覆盖 download_supplementary 登记原子性 |
| — | **wire 缺陷（gold7 新证）**：全量重建后 receipt-only submit 仍现 `Expected object at $projection`×3，随后自行消失进入实质迭代——stale-build 之外存在 stored-submission 重解析缺陷（疑与 a98a151a proposal 变更相关） | 写复现用例钉死（receipt-only + 无 echo 形态），修 contracts/proposal 版本兼容 |
| — | supervisor 对 Host events 瞬时 HTTP 500 零容错（3 连败，均在 operation_progress 风暴时段）+ Host 端 500 本身 | 运维面：supervisor 加重试；查 server events 端点 500 根因（疑似独立 bug） |
| H3 | **stale-build 撕裂**：`node dist/index.js --static` 裸启动绕过 `prestart/build-contracts-if-needed`，contracts dist 落后 server 源码一个 rename（c005e323）→ gold5-r1 全场 thrash 报废 | 运维纪律：重启 static Host 前强制 `pnpm build`；或给 supervisor/runner 加 dist-vs-src mtime 启动断言 |

### 不属于两类（外部源边界，合理阻断）

- E6：COSMIC 需登录/API key，按边界规则拒绝——非损失。

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
> 上下文峰值 136,294 / 256k；首轮 29,157。**发布后阶段占 79% 计费 token、一半墙钟、73% 输出**——C2 的定量代价。成本 = 各列 × DashScope 单价（手工价格表）。
> 记账缺口（待分流）：usage 目前只聚合到 run 级（`RunSummary.usage`），阶段/单轮拆分每次要手写脚本扫 `context_usage.usage` 事件——应补一条持久聚合命令（如 `gold:usage <evidence-dir>` 输出 pre/post 与逐轮表）。

| # | 卡点 | 归类 | 证据 | 建议修法（暂不执行） |
| - | ---- | ---- | ---- | -------------------- |
| C1 | **检视 gzip 平台注释的诉求走向 shell 绕路**。seq 185 `process.exec bash.exe -lc "gzip -dc GPL96.annot.gz \| sed \| cut"` 被 supervisor fail-closed 停审（操作员 deny 后 run 恢复，模型改走 workspace_read/preview 正常完成任务）。核心资产预览/解压工具链只覆盖 zip，不覆盖单文件 gzip，模型看 .gz 内容只剩 bash 一条路 | 产品 | events seq 185 permission_requested；permissions.jsonl；deny 后 seq 200+ 正常推进 | extract/preview 支持 gzip 成员或加 `read_core_asset_text(decompress=auto)`；提示词明示"gz 载体勿走 shell" |
| C2 | **发布后验证循环冗长（定量：41/60 次调用、79% 计费 token、592/1463s 墙钟花在 Publication 之后）**。`publication_created`(seq435) 之后又烧了 ~570 事件：`workspace_read`×27 逐回执反复读、5+ 次重复同一句"I'll verify the remaining receipts"自述、`workspace_edit`×2 修订自己的措辞（其中 1 次失败 seq724）。诚实复核是好行为，但**无界重复**——已验证过的回执被再读 2-3 遍 | prompt | tools 计数：workspace_read 28 vs r1 全 run 仅 33 tool_started；上方阶段拆分表 | 提示词加收敛规则："每个 artifact/回执验证一次即记录结论；发布后回合预算 ≤N 次工具调用；发现重复读同一文件即停止" |
| C3 | **basic_statistics 对 536MB 主表字符串溢出**。工具报 `Cannot create a string longer than 0x1fffffe8 characters`（V8 单串上限），导致主表描述性统计未执行，模型如实标注"数值有效性仅依赖 Core expression_value_numeric 检查" | 产品（工具） | 终答"需要你协助"第 4 点；events 中 basic_statistics err 输出 | basic_statistics 改流式/分块解析或声明行数上限 + 抽样统计 |
| C4 | **无 SOFT 注释平台在 gene 级 schema 下直接不可闭合**。`download_geo_platform_annotation(GPL17586)` 返回 no downloadable annotation table → GSE76250（398 样本，最大配对系列）无法进 gene 级主表；模型未猜映射（正确），但该数据获取面在 gold 标准集上直接封顶 | 产品（覆盖面） | 终答阻塞清单第 2 点；tool_completed GPL17586 输出 | geo_platform adapter 支持 from library/探针命名推断的替代映射源（GeneCards/UniProt gene symbol 表）或提供 probe 序列比对通道 |
| C5 | **发现查询收窄空转**。追加 3 次 `search_geo`（GPL96/HGU133A 变体）total_count 0/1/0——在已知无同平台第二系列的方向上重复碰瓷 | prompt（轻） | 终答"发现查询收窄失败"段 | 同一约束变体重试 ≤2 次即止损（与 r1-B4 同族，正样本对照下影响小） |

- **行为正样本（值得保留进 prompt 教学）**：单平台同粒度设计优先（43T+43N/GPL96）、拒绝跨 GSE 拼行、发现"probe-mapping 行数未独立验证"后主动修订而非宣称、Benford/末位数偏差如实保留并解释为 MAS5 log2 平台特征、pairing 推导规则交人确认——r1 的 B2/B3（动态路由零调用、时限幻觉）在 r3 未复现。
- 基础设施观察（非模型问题，不入模板）：supervisor 死于 Host 瞬时 HTTP 500（seq≤207 journal 断档）；watcher 进程被控制台会话回收。durable 存储为唯一权威记录（1005 事件完整）。

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
- 四案纵向（同模型同 Host）：gold1-r3 24min/60calls/5.71M → gold2 40min/69calls/7.67M → gold3 2.3min/20calls/0.78M（提前收手）→ gold4 5.9min/79calls/4.49M（构建高效+死墙实证）。行为方差极大，提示词需要"穷尽界+收敛界"双向约束。

## gold5 @ qwen3.8-flash（2026-08-30，main@1a9c070dfb1b）

### r1（task_ts_9046f9e7，已取消）＝ stale-build 灾难样本（H3）

Host 的 `contracts/dist`（21:38 构建）落后于队友 `c005e323`（23:07，receipt 字段 `sandbox_backend`→`execution_backend`）；重启 Host 时只重编 server 没重编 contracts → **producer（server，新）生成的 receipt 被 consumer（contracts dist，旧）判 `Unknown field "execution_backend"`**。模型 146 轮/89 错/48% 错误率，prepare×22 / submit×23 全灭（错误分布：`$projection undefined`×10、`Unknown field execution_backend`×4、缺字段×3、receipt superseded×2、carrier provenance×2），峰值上下文 237k/256k 贴线挣扎后被操作员取消。证据保留于 `data/gold-runs/1a9c070dfb1b-gold5-qwen38flash-r1-stalebuild/`。
**教训（运维纪律）**：`node dist/index.js --static` 裸启动绕过了 `prestart/build-contracts-if-needed` 钩子——重启 static Host 前必须 `pnpm build`（或至少 contracts+server 同批构建）。此错误分布本身即"撕裂版本"的铁证，不记为模型卡点。

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

## gold8–gold10 @ 复跑（待组员执行）



（空。每完成一个案例，按模板追加；同步把 `closure.json` 的 `run_usage` 抄入本表上方案例头部，便于比较提示词/路线变化对 token 的影响。）

## 已登记的兄弟事实（不重复展开）

- gold8 枚举 555 次 / DILIrank 404 韧性缺口 → [ISSUES](../ISSUES.md) 与 [TODO](../TODO.md) 已各有条目；本文档只在案例复跑暴露**新的行为面**卡点时补条目。
- gold9 跨源空列（回答宣称与发布表不符）→ TODO "gold9 跨源数值列行级填充率门"。
- 行为观察类（浏览器绕路、思考模式等）历史细节见 `data/gold/` 各案例 runs-log（本机）。
