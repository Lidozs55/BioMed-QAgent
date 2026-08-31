# 修复面分流总表（triage 视图）

> 本文件是 docs/evaluation/model-blockers.md 拆出的**修复面分流视角**（2026-08-31）：A/B 两分类分流表（以此为准）。收集期纪律、条目模板、案例逐条登记与十案全景见 [model-blockers.md](model-blockers.md)。各 run 表格里历史标注的"prompt/产品/接口陷阱"归类只作记录，不作为修复依据。

## 修复面分流（两分类总表，以此为准）

> **2026-08-30 注**：B3（无墙钟时限）、B4/C5/D5（同路止损）、K3 的同签名止损/最小化定位、L1（计划句绑定调用）已作为通用行为面先行沉淀进主提示词开头的 `[System briefing]` 段（`phase1-prompt.ts` 新增 `SYSTEM_BRIEFING`，`PiAgentAdapter.createSession` 置首拼接）；本表各条其余建议修法仍待批量分流复核，不因已沉淀而关闭条目。
>
> **2026-08-31 框架修复落点**（谨慎选择性落地，未提交）：
> - **wire 缺陷 → 已修**：根因=1336428a 起存储对象为无 `.projection` 的 wire 形状，提交端 `resolveSubmission` 直返存储对象从不重建 `.projection`（与 a98a151a 无关，已排除）。修法=`phase3-composition.ts` 的 resolveSubmission 改为对存储 wire 重跑 `parseDynamicFamilyPublicationSubmission`；`dynamic-family-preflight.test.ts` 相应从"存 parsed"改为"存 wire"并断言重建，`dynamic-family-phase3-composition.test.ts` 改为纯 receipt-only e2e（未经 echo）。
> - **链 1 低风险子集 → 已修**：`core-asset-tools.ts` gzip preview/extract（1F 8B 魔数 + `zlib.gunzipSync`，extract 无 member 解整流并按脱壳名标 media type）；`pubmed/geo/browser` 下载工具成功后登记到 task-owned `SourceAssetRegistry`（D3/H4/I3 直击）；workspace deny 响应附 `read_path_hint`（保守指引，不承诺可读性）。
> - **B6（后半）→ 已修**：`gdc.ts` search 收齐 hits 后按 token 命中密度 + project_id/disease_type/primary_site/name 加权排序再截断，"breast cancer TCGA" 首结果回归正确。
> - **G3 → 半修**：BioC 空文档抛结构化 `NoFullTextError`（`literature-evidence/provider.ts`）以区分"无全文=终态"与"畸形输入"；Europe PMC `http_client_error` 对照修复仍需真实复现，暂缓。
> - **其余 B 类条目 → 暂缓**：B7 剩余（activate 已反向同步 settings、UI 全走 registry，剩余 legacy 路径一致性自洽）、H1（无 ChEMBL target 发现工具是产品缺口，validator 拒 parameters 是正当防线）、H2（字段多属"发错表"非"schema 不可表达"，需真实复现再定）、C3/K1/K2/L5/I1/L3/D2/C4/E1/E2/I2/J1/J2/H3/supervisor 500 均为跨层架构或需真实网络复现的大工作，按"整体系统更好、避免过拟合"原则不在此轮动。

各 run 表格里历史标注的"prompt/产品/接口陷阱"归类保留作记录，分流修复时**以本节为准**。

### A 类：模型认知 & 工具描述不清 → 提示词可解

| ID | 一句话病因 | 提示词切入点 |
|---|---|---|
| B2 / E4 | 动态路由零调用（想象复杂度/包装成"范围决策"） | **穷尽界**：blocked/上交前必须实际调用一次 dynamic preflight 并附结果。**gold3-r2（08-31）复验：E4 的"PDB 需逐 ID 动态绑定"被证伪（静态 execute 即成功发表 structures），briefing 后本 run 无零调用/想象复杂度类错误** |
| B3 | 幻觉外部时限（预算 240 只用 35 就"等用户指示"） | 提示词写明 turn 预算事实；禁止以"时间限制"作放弃理由 |
| B4 / C5 / D5 | 同路重复撞墙；检索变体空转；不扩池就断言"唯一候选" | 同一约束重试 ≤2 次止损；断言池枯竭前 ≥N 个不同检索式 |
| B5 | 未 activate 直接调用，吃 Tool-not-found（工具懒加载规则未学会） | 教学 skill→tool 映射与先激活后调用；工具报错文案内联激活用法 |
| D4 | `scaffold_dataset_execution_spec` 空参调用 | 教学 schema 必填约束（工具描述不清属此面） |
| B6（前半） | search_gdc 首结果不对路就直接放弃整个 GDC 线 | 候选被证实存在时必须完成一次最小 formal 尝试 |
| C2 / G4 | 发布后无界复核（gold1-r3 烧 79% token；gold4 试 58 调用撞同一堵墙 20 次才停） | **收敛界**：发布后核验预算 ≤N 调用；同一通道连续 2 次失败即止损并以 publication 事件为核验终点 |
| E3 | 四个发现工具全激活零调用，向用户要本可自得的清单（PDB 子集/NCT） | **穷尽界**："请用户提供 X"前必须实际调用能拿到 X 的已激活工具并附证据 |
| I1(模型半) | **可行方案不执行、上交待确认**：模型自己诊断出"拆三次独立 build"是正解且完全在其权限内（prepare/submit 自家工具），却写进"需要您的协助"第 3 条终止——因权限面 deny 经验（C1/D1）错误泛化为"改构建形态需请示"；63/240 轮即收尾 | **执行优先条款**：凡不超出已激活工具权限、不需要外部凭证的方案，进求助清单前必须本 run 内实际执行一次并报告成败；求助清单只放真正的用户输入（凭证/文件/口径决策） |
| I4 | **单点探测失败即判整通道死**：gold7 对 `dbsnp.files.v1` 只试 1 个 rsID 空回就归因"provider 不可用"；无法区分"全灭 vs 该记录缺失"，也给框架立项报了过重的诊断 | 归因前 ≥2-3 个独立样本探测，终答按样本粒度报告失败率 |
| J4 | **可达面自我设限（穷尽界新亚型）**：gold8 FAERS 绑定不依赖已阵亡的名册（逐药 openFDA 可查，历史成功 9 药 68 行），本次只绑 1 药即以"仅 acetaminophen 有可溯源记录"收尾——与历史事实矛盾，成功形态未复制到达可及样本上限 | 穷尽界条款扩展：**已在本案跑通一次的绑定形态，须复制到全部已核实可达样本或在终答逐样本说明放弃原因**；终答"只有 X 可行"前须列尝试矩阵 |
| K3（调试半） | **同错误签名连续重复不最小化定位**：gold9 从首次 `OUTPUT_BYTES_MISMATCH` 到自检出 JSON 换行符 bug（`\n`→字面 backslash-n）用了约 15 轮、~10+ 次同型失败，靠灵感而非二分复现 | 调试纪律条款：**同一错误签名连续 ≥3 次即停止常规重试，改用单变量最小化复现**；把该能力写进 [Control and recovery] 段（此 bug 最终由模型自行定位，教学只为省成本不是救正确性） |
| L1 | **回声死循环（退化形态，gold10 末段）**：~20 轮复读同一句"I'll test the two decisive facts"零工具调用，run 在"明知三表可发"状态下自我终止 0 发布；模型侧无法自纠（复读本身消耗了停止线） | 提示词只救一半（"计划句必须绑定工具调用"）；主修在框架行（runtime 相似度检测→steer/no_progress 护栏） |
| Q1 | **语义 requirement 已锁 dynamic 后仍靠改 requirement_id 切 static**（gold6-r3）：冻结规则已明禁同一语义需求跨 route，模型仍将六表需求拆成新 id 做 7 次 static execute；全部失败且未污染正式结果，但说明文字约束不足 | 明示“换 requirement_id 不改变 semantic requirement”；主修为 Host 持久化 route choice 并对同语义跨 route submit fail-closed（见 B 类 P5 邻近工作） |

### B 类：框架限制 → 需动代码

| ID | 一句话病因 | 修复入口（立项建议） |
|---|---|---|
| B1 / D1 / D3 / E5 / G1 / H4 / I3 | **载体检视与发布回执链**（同一根因链，最高优先）：preview/extract 不认 gzip；download 后资产首查 "not found"（D3/H4/I3 三个入口实例）；execute 不回传 artifact `asset_id`；已发布产物全工具面零读取通道（artifact_32hex/裸 digest/workspace 路径全不可达；gold9-K5 五件 artifact 全读不回，模型如实画界"ID-form gate + Core storage isolation"）——gold4 实证烧 81% token 撞墙，gold2/gold8 把题面字段判成不可核实。**gold1-r4（2026-08-31）活体复验：gzip preview 一次通过、发布回执读回全通、post-pub 成本降为有效验证——子集①③④生效；②（execute 返回 asset_ids）仍未落地**；**gold2-r2 再证（workspace_read×22 回执验证全通、零 not found）；**gold4-r2（08-31）销案级：post-pub 20 calls 全部有效、navigate 23→0、行为回归正常——本链对模型行为的税已基本停征，剩 ② + M2（preview offset 分块）** | 一个代码立项：① execute/publication detail 返回 artifact asset_ids（最小修）② preview/extract 支持 gzip ③ 所有 download/acquire 工具落盘+登记同事务原子化 ④ permission deny 响应附"无此读取通道"语义 |
| O1 | **序列域无正式来源**（gold4-r2）：UniProt 序列 research-only 禁为 build 源（政策正确）、NCBI Virus/GISAID 无 provider 无发现工具 → "病毒株序列"类题面结构性不可闭合 | 序列 provider 立项（NCBI Virus）或受控参考序列 accession 通道 |
| O2 | **`scaffold_dataset_profile` 无 usage 引导**（gold4-r2 两次误用）：cleaning proposal 新套件缺 SKILL/guidance/description 示例（D4 同族） | cleaning 套件补 skill+guidance 主题；description 加最小示例 |
| E1 / E2 / G2 / N1 | **变异/试验发现链缺失**：clinvar.files.v1 要逐条 VCV 但无 accession 发现工具；clinicaltrials provider 要具体 NCT 但无检索工具；`variant_evidence` 静态族无 live provider。**gold3-r2（08-31）复测收窄为 N1：fixed provider 参数契约自相矛盾——"does not accept binding parameters" 与 "/result/uids(/studies) must be a non-empty array" 互斥，任何输入形态都无法同时满足，两源结构不可绑定（比"缺发现工具"更准的立项靶点）** | 修 provider 参数契约（接收 uids/studies 数组入参即等价发现绑定），补 esearch 家族发现工具 + variant_evidence 接 live provider（同族合并） |
| D2 / C4 | **表达能力缺口**：gene-level 映射在正式路线中不可表达（mapping_files 拒 workspace 路径、probe_long.v2 无 gene 维度）；无 SOFT 注释平台直接不可闭合。**gold2-r2（08-31）复测更新：mapping_files 注册通道已放行（validate 双绿灯+执行），阻塞点后移为 gene 覆盖率闸门对 Entrez-ID 原生平台折叠失败（新条目 M1）** | ①M1：折叠规则加 Entrez→symbol 通道或平台类型特判 floor；②probe_long.v2 crosswalk 支撑表方案不变；C4 源侧无注释仍开放 |
| M1 | gene-level 覆盖率闸门（floor 0.80）不认 GPL6244 类"ID_REF 即 Entrez 基因 ID"平台，coverage 0.6666 连坐拒发整表 | 见上行 ①；gold2-r2 终答含完整 check_id 证据 |
| M2 | **preview head 固定窗口、无 offset 分块**：大载体（SOFT 153MB）中段字段（`!Sample_characteristics` EGFR 状态，正是题面所需）不可达——链 1 最后一段缺口 | preview_core_asset 支持 offset/length（workspace_read 已具备该形态，移植）；**gold2-r2 实证：模型因此无法核实而宁缺不造** |
| B7 | **配置双轨**：PUT settings 只改显示层、registry active 记录才是执行层（r1 整场跑错模型计费）。硬编码 default 那半已修（`fix/no-hardcoded-model-defaults`） | 剩余：PUT/active 级联或冲突拒绝；GET /settings 回显 `resolveActiveConfig()` 真值 |
| C3 | basic_statistics 对大表字符串溢出（V8 单串上限） | 流式/分块解析或声明上限+抽样 |
| G3 | literature_evidence provider 可靠性：Europe PMC `http_client_error` 双复现、BioC 空文档回 `invalid_input` 误导重试。**gold4-r2（08-31）第 2 案复现**：模型准确归因"host-side 非输入侧"并建议 retry window——NoFullTextError 分型已落，http_client_error 本体仍开放 | 复现对照 headers；空全文应回结构化 `no_fulltext` |
| B6（后半） | search_gdc 查询 "breast cancer TCGA" 首结果 TCGA-LUAD | provider 查询→project 映射排序修复 |
| H1 | **ChEMBL 发现→绑定断链**：`search_chembl` 拿到的真 CHEMBL ID 喂不进 `chembl.files.v1` 固定 provider 的 validity 门（~11 种参数形态全拒），gold5 题面 activity 数据结构性进不来。**gold5-r2（08-31）再证且精化**：模型将死锁总结为"单 target-ID（静态 entities）vs 1-32 compound-IDs（fixed provider）二律背反"——立项表述采用之 | 复现并修复 provider accession 校验门，接受自家发现工具的输出形态（链 2 合并立项） |
| H2 | **`validate_dataset_execution` 假绿灯**：valid:true 但 schema 表达不了需求字段（`activity.v1` 对 assay 条件/单位/跨源列全 `unknown_required_field`）——校验层与表达层脱节 | validate 增加"spec 需求字段 × schema 能力"覆盖检查，不可表达直接 invalid 并指路 |
| I1 | **Dynamic 单 projection 全表耦合**：一张空表（variant_genes）拖死同 build 内数据已全部核实的 studies 表，gold7 因此 2/3 交付 | per-table partial publish，或拒绝信息直接指路"拆独立 build"；另：模型给出拆建方案后停手等确认——穷尽界提示词一并覆盖 |
| I2 | `dbsnp.files.v1` Core provider 返回空载荷（工具面 lookup_dbsnp 正常）→ GRCh38 坐标核验进不了正式链 | 复现 provider egress/解析；并入链 2 变异发现立项 |
| P2 | **`source_files` 绑定契约三向死锁**（gold7-r2）：bare asset-id→"须相对路径"，相对路径→"无已注册资产 id"，text/csv 成员→"media type not allowed"——三条校验互斥，无任何输入形态可同时满足；D3（登记原子化）与 a5a6003d（真实 media-type）两修复未对齐的夹缝，GWAS/衍生表静态闭合结构性不可能（模型 13 连败后转动态） | 三校验对齐为一个自洽契约（相对路径⇄注册 id 双轨解析 + 按适配器声明允许介质）；与 H1/I2/D2 链 2 合并立项 |
| **P3** | **动态 Family 拓扑不可定制（十案总根因浮出水面）**：prepare_dynamic 的闭包由 Core 写死为 bioactivity-chart 六表模板（activity_value_records+chart bbox/人审），GWAS/名册/临床类拓扑合法出口为零——gold7-r1 发 383B 探针、r2 直接 0 发布（模型拒绝把真统计值伪装成 assay/figure），**"动态族=表达任意拓扑"的核心承诺未兑现**。此前被 wire 死锁遮蔽，修复后立即现形 | **架构级立项**：prepare 接受声明式 family topology（表名/列/粒度/关系 by request），chart 模板只是其中一个可选闭包；gold 系列通过率全卡在此 |
| **P5** | **Gold6 supplementary member admission 契约互斥**：`literature_experiment_chart` 要求 Core-owned supplementary member，registered source 又必须是 UTF-8/gzip-UTF-8 transform input；三篇官方归档仅 PDF/JPG/GIF。JSON-only→缺 member，binary member→UTF-8 拒绝，只注册不绑定→undeclared binding，三种真实形态均无合法出口 | 增加 binary member 的 provenance-only 非文本绑定，或由 Core-owned parser 生成 UTF-8 derivative member 并绑定 parent/member OperationResult；不得把二进制冒充文本。证据 `data/gold-runs/e680d4232531-gold6-qwen38flash-r3-standard/` |
| P4 | **1M 规范下验证密度无成本闸**（gold7-r2）：177 calls/41.7M token（95% cache_read）+12 万字符终答，非空转但无预算边界 | 发布前自审预算 + 终答摘要化协议（详情入 workspace 文件，正文只留结论） |
| I3 / J3 | staging 资产命名空间割裂新增实例：`download_supplementary` 的 ZIP 落 source_assets 但 preview "registered asset was not found"；**gold8 把该链的发布回执端放大到极限——为读回 1 个发布回执烧 29 调用/71% 墙钟，preview×17 全拒、4 次 `/publications/*` 外部锚定停审 deny**（链 1 断点最全形态） | 链 1 修复时覆盖 download_supplementary 登记原子性 + permission deny 响应附"无此读取通道"语义 |
| J1 | **名册类外部源零 provider + 官方站全灭 + 无"用户上传→Core 权威资产"通道**：DILIrank 六通道逐 URL 实证不可达（DNS/404/401/ETIMEDOUT），题面 2/4 表 NO_DATA；quarantine 旁路明确非权威、进不了正式链 | 定义"用户上传→task-owned Core 资产→绑定"受治理正式通道（区别于 quarantine 非权威旁路）；DILIrank 镜像准入 |
| J2 | **Bookshelf/LiverTox HTML 无 formalize provider**：页面可读（navigate 成功）但无 Core provider 把 HTML 变不可变载体 → "not publishable"。即 TODO"Recipe 格式宽路径（HTML/PDF）"的实测代价 | 按 Recipe 宽路径立项：HTML→registered parser→field_mapping HIL |
| — | ~~wire 缺陷~~ **已修+活体复验通过（2026-08-31，gold5-r2 第 6 动态案）**：receipt-only submit 直达业务校验并进入 publication_acceptance HIL，全程 0 次 `$projection`；5/5 复现史终结（gold10-L4 为末案） | **销案**。保留回归用例：prepare→纯 receipt submit 金路径 |
| P1 | **HIL reject 理由不透传到模型**（gold5-r2 首例 HIL）：toolResult 仅回 "not accepted: reject"，`user_input_resumed.detail.reason` 里的审查理由模型看不到 → 模型请求"reviewer statement"，"人审后定向修正"闭环断在最后一公里 | HIL 决议注入 continuation 消息时携带 reason 全文（一行 wire 改动）；赛题加分项"寻求人类建议后修正"的前置 |
| K1 | **静态适配器 32MiB 容量上限**：Orphadata 54MB XML 物理进不了 registered 文件通道，题面起点（疾病目录）只剩动态 transform 硬啃 | 大 XML 分块/流式 provider 或容量分级准入 |
| L2 | **DA 载体 media-type 断链（gold10）**：论文补充 xlsx 经 acquire/extract 全链路 media type 恒为 `application/octet-stream`，DA 适配器只收 `text/csv`/真 xlsx → 唯一现实数据源进不去；`paper_supplement_differential_abundance` xlsx 解析通道存在但 guidance 未覆盖，模型外围试探 20+ 次不可见 | extract 解码产物按成员真实类型标注 media type；research_data_guidance microbiome 段点名 xlsx→DA 绑定姿势 |
| L5 | **spec-as-string 4096 字符 transport 限制**（与 K2 同族）：多绑定四表 spec 逼近上限，压缩 transform 表达 | 与 K2 信封提升合并立项 |
| K2 | **transform_source 尺寸天花板**：完整四表 integrator 装不进一次 prepare/submit 信封，多次截断失败后模型被迫发 383 字节"通路探针"代替产品 | prepare 分步传模块 / 提上限 / receipt 端存代码、submit 只传引用 |
| K3（方言半） | **transform 沙箱方言陷阱**：禁 bracket access + JSON 内 `\n` 到 Core 变字面 backslash-n，同一 OUTPUT_BYTES_MISMATCH 烧 ~10+ 轮，是 20M token 主要来源 | admission 报错附最小可复现样例 + 官方 workaround 清单（换行用 String.fromCharCode(10) 等）写进 transform 工具描述 |
| — | supervisor 对 Host events 瞬时 HTTP 500 零容错（3 连败，均在 operation_progress 风暴时段）+ Host 端 500 本身。**gold5-r2 新案：`--adopt` 不持久化 run_id → HIL 后 `--resume` 拒绝续挂，需手工补 state**（首踩；任何走到 HIL 的 case 都会必经此路）。**gold7-r2（1M 规范）：默认 --timeout 1h 不够，本案 95min 触发超时，1M 下至少 3h（10800000）** | 运维面：supervisor 加重试；adopt 分支同步 writeState(run_id)；默认 timeout 提至 3h；查 server events 端点 500 根因 |
| H3 | **stale-build 撕裂**：`node dist/index.js --static` 裸启动绕过 `prestart/build-contracts-if-needed`，contracts dist 落后 server 源码一个 rename（c005e323）→ gold5-r1 全场 thrash 报废 | 运维纪律：重启 static Host 前强制 `pnpm build`；或给 supervisor/runner 加 dist-vs-src mtime 启动断言 |

### 不属于两类（外部源边界，合理阻断）

- E6：COSMIC 需登录/API key，按边界规则拒绝——非损失。

## 已登记的兄弟事实（不重复展开）

- gold8 枚举 555 次 / DILIrank 404 韧性缺口 → [ISSUES](../ISSUES.md) 与 [TODO](../TODO.md) 已各有条目；本文档只在案例复跑暴露**新的行为面**卡点时补条目。
- gold9 跨源空列（回答宣称与发布表不符）→ TODO "gold9 跨源数值列行级填充率门"。
- 行为观察类（浏览器绕路、思考模式等）历史细节见 `data/gold/` 各案例 runs-log（本机）。
