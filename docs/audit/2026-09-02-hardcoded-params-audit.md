# 硬编码参数审计(2026-09-02)

> 基准:`origin/main@998fe232`(分支 `research/settings-audit`)。
> 与 [`2026-08-28-settings-wiring-audit.md`](2026-08-28-settings-wiring-audit.md) 互补:那份审计
> 「已有设置但不生效」,本份审计「**未纳入设置、写死在代码里的参数**」并评估哪些应纳入设置。
> 本报告仅为评估,不含代码改动。

## 范围与方法

- 扫描范围:`server/src/**`(agent / dataset / external / runtime / http / persistence /
  processing / evaluation / analysis / product / settings)、`frontend/src/**`、
  `database/**`、`packages/contracts/src/**`。
- 排除:测试文件、纯 UI 样式、i18n 文案、安全/密码学不变量、模块连线。
- 已纳入设置、不再报告的基线(`packages/contracts/src/settings.ts`):模型
  base_url/api_key/model_name/max_tokens/temperature/top_p 等高级参数、视觉模型指派、
  上下文预算(context_window / safety_reserve / compaction 比例)、`RuntimeLimits`
  14 项时限额、个性化、HIL 审批、Agent 权限、编辑器、技能迭代、外观、数据库连接。

**评估维度**(判断一个写死参数是否应纳入设置):

1. 是否随部署环境变化(机器速度/网络/磁盘/内存)——是则倾向设置或 env;
2. 用户是否因任务差异需要调整(领域、竞赛、供应商)——是则倾向设置;
3. 是否已有同类设置先例(`RuntimeLimits`)——一致性要求;
4. 是否为正确性/安全/溯源不变量——是则保持硬编码;
5. 是否 parity 锁定(与 Python 历史实现摘要绑定)——是则改动需版本化,不宜暴露。

## 结论总览

| 等级 | 定义 | 数量(约) |
| ---- | ---- | ---- |
| P0 | 双源真相:应消费现有设置却另行硬编码 | 12 处 |
| P1 | 强烈建议新增设置(直接影响结果或运维) | ~20 项 |
| P2 | 建议 env/配置文件而非 Web 设置(主机级) | ~10 项 |
| 保持 | 不变量/parity/安全/溯源冻结,保持硬编码 | 其余全部 |

---

## 一、P0:双源真相 —— 应消费现有 `RuntimeLimits` 却另行硬编码

这些地方已有对应设置项,但存在第二份硬编码默认值,**用户调整设置不一定生效**,
是最应优先整改的一类(整改方向是"接线",不是"新增设置"):

| # | 位置 | 硬编码值 | 应消费的设置(默认) | 分歧 |
| - | ---- | ---- | ---- | ---- |
| 1 | `server/src/persistence/db-client.ts:116` | `timeoutMs ?? 120_000` | `database_timeout_seconds`(600) | 120s vs 600s;bootstrap 创建的客户端未传显式超时,全走 120s |
| 2 | `server/src/external/browser/pool.ts:58` | `DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS = 60_000` | `browser_timeout_seconds`(300) | 池级回退 60s;设置只在部分调用点按次传入 |
| 3 | `server/src/external/crawler/crawler.ts:35` | `MAX_CRAWLER_DOWNLOAD_BYTES = 4 GiB` | `max_download_mib`(8192) | 4 GiB vs 8 GiB |
| 4 | `server/src/external/crawler/rate-limit.ts:14`、`external/sources/fallback.ts:41` | 限速默认 `2.0 s` | `request_interval_ms`(500) | 省略参数时静默得到 2s |
| 5 | `server/src/agent/workspace/context.ts:10-24` | `DEFAULT_WORKSPACE_LIMITS` 全套 | `workspace_read_kib`(256)等 | 回退默认比设置默认更严(read 64KiB vs 256KiB、search-file 128KiB vs 16MiB、search-files 200 vs 2000);且 `maxListDepth/maxListEntries/maxSearchResults/maxSearchLineChars/maxSearchOutputChars` **没有任何设置映射**;`maxExecTimeoutMs` 在 `phase3-composition.ts:485` 再次硬编码 86_400_000 |
| 6 | `server/src/dataset/acquisition/gold9-providers.ts:138-139` | Orphanet 计划级超时 45min/20min | `http_timeout_seconds`(300)/`download_timeout_seconds`(3600) | 注释记录 300s 默认曾在 92% 完成度时杀死三次尝试;调大设置也到不了这些 provider |
| 7 | `server/src/dataset/acquisition/expression-providers.ts:17-18`、`extended-providers.ts:34-37`、`gold9-providers.ts:27`、`biomedical-providers.ts:38-39`、`chembl-provider.ts:17`、`gmrepo-provider.ts:46`、`ncbi-taxonomy-provider.ts:26` | 各 provider `maxBytes`(4 GiB/256 MiB/64 MiB/32 MiB/16 MiB…) | `max_download_mib` | 全部不随设置缩放;用户调低到 512 MiB 仍放行 4 GiB 下载,调高也超不过 16 MiB JSON 上限。建议至少 `min(providerCap, max_download_mib * 1 MiB)` |
| 8 | `server/src/agent/tools/geo.ts:479-520,628-649`、`pubmed.ts:377-388` | `max_size_mb` 工具参数默认 4096 + 回退 8 GiB | `max_download_mib`(8192) | 4096 硬编码独立于设置 |
| 9 | `server/src/external/gdc/api.ts:30` | `GDC_JSON_TIMEOUT_MS = 30_000`(死常量,经 `gdc/index.ts` 导出无人用) | `http_timeout_seconds` | 注释自称对应 Python 默认,实为陷阱;应删除或改为派生 |
| 10 | `server/src/config.ts:28` | `DATASET_OPERATION_TIMEOUT_MS` env 旁路 | `dataset_operation_timeout_seconds` | 注释自认"设置层稳定后移除"的遗留旁路 |
| 11 | NCBI 请求身份:`server/src/external/ncbi/client.ts:38-43`(env 可覆盖)与 `server/src/agent/tools/business-tools.ts:131-135` | 两套不同的 email/tool/UA(`biomed-qagent@example.com` vs `biomed-agent@example.com`,`/0.1` vs `/1.0`) | — | GEO eutils 客户端无视 `NCBI_EMAIL`;NCBI 礼仪合规上应统一并允许部署级覆盖(真实联系邮箱) |
| 12 | 默认值四处重复 | `safety_reserve_ratio 0.05`、`max_tokens 8192` | contracts `DEFAULT_*` | `store.ts:202,204`、`model-registry/service.ts:83`、`pi-adapter.ts:156,555` 共 4+ 份副本;改设置默认值时极易漂移 |

---

## 二、P1:建议新增设置项

### 2.1 模型 / VLM 行为(竞赛敏感 —— 图表提取是 TODO P0 的最高权重缺口)

视觉模型身份已由设置管理,但其**行为参数全部写死**:

| 位置 | 现值 | 控制 |
| ---- | ---- | ---- |
| `server/src/processing/vlm/vlm-client.ts:143` | `temperature: 0.1` | 每次 VLM 提取的采样温度;主模型 temperature 设置传不到它 |
| `server/src/processing/vlm/vlm-client.ts:33` | `VLM_TIMEOUT_MS = 60_000` | VLM 单请求超时;`RuntimeLimits` 覆盖了 http/browser/database 却没有模型请求超时 |
| `server/src/processing/vlm/vlm-client.ts:83,215` | `MAX_VLM_ATTEMPTS = 3`,退避 `attempt * 1000ms` | VLM 传输重试;TODO P1 已把"VLM DNS/断流重试"登记为反复出现的现场失败类 |
| `server/src/agent/pi-adapter.ts:567-583` | `resolvePiRetryOverrides()`:maxRetries 6 / baseDelayMs 3000 / maxRetryDelayMs 60000 | 全部模型调用的供应商重试策略 |
| `server/src/agent/pi-adapter.ts:172-179,924-944` | 流恢复 3 次 / 供应商恢复 3 次 / 延迟 60s / 退避 `3s * 2^n` | durable run 的断流/429-503 恢复 |
| `server/src/runtime/hil-pre-review.ts:33` | `REVIEW_TIMEOUT_MS = 60_000` | HIL 预审 LLM 请求超时 |
| `server/src/settings/model-registry/service.ts:783` | `AbortSignal.timeout(10_000)` | /models 发现探测超时 |
| `server/src/agent/skill-iteration/service.ts:468` | 180s abort | 技能演化单次模型调用硬上限(独立于 `http_timeout_seconds`=300) |
| `server/src/agent/pi-adapter.ts:552,555,629,784,970-971,993` | `contextWindow ?? 131_072`、`maxTokens ?? 8192`(六处散落) | 配置缺失时的会话预算回退 |

建议:在模型设置域新增 `model_request_timeout_seconds`(或进 `RuntimeLimits`)与
vision 作用域的 temperature;重试策略收敛为一个可配置策略对象(当前三层各写一套,见下
"横切观察")。

**图表提取管线的产出形状参数**(直接影响数据完备性,即评审打分维度):

- `server/src/processing/vlm/pdf-pages.ts:34` — `MAX_PDF_PAGES_PER_FILE = 12`,超出部分
  静默跳过(仅计 `skippedPages`)→ 图多论文丢数据。
- `server/src/processing/vlm/pdf-images.ts:30` — `MAX_PDF_IMAGES_PER_FILE = 10`(L1 层)。
- `server/src/processing/vlm/pdf-pages.ts:37` — 探索层 `RENDER_DPI = 144`,而受治理路线
  `registered-paper-chart-extraction.ts:82` 用 216;**TODO P0 记录"把 DPI 提到 216 正是
  Gold6 视觉失败的修复"** —— 两层默认不一致本身就是问题。
- `server/src/processing/vlm/pdf-pages.ts:48,94-104` — 页选 caption token 表
  `["fig","dose","response"]` 及打分权重,生物活性域偏置,其他领域论文得分 0 静默回退前 12 页。
- `server/src/processing/vlm/chart-json.ts:45-46` — 冻结提示词内 "at most 100 data_points"
  (密集图采样上限;prompt_digest 入证,调整需提示词版本升级,建议先登记)。
- `server/src/processing/vlm/registered-paper-chart-extraction.ts:479-481,1096-1098` —
  `MAX_RETRY_DEFICITS = 4`、纠正性重试恰好 1 次、`DOSE_RESPONSE_TERMS` 正则(IC50/EC50/Ki 域偏置)。
- `server/src/processing/vlm/chart-extraction.ts:306-350` — 置信度分量写死
  (`medium`/`high` 等级指派),喂给 confidence 产物与 HIL 门槛;至少应提为命名常量+理由注释。

> 注意:`REGISTERED_PAPER_RENDER_DPI = 216` 与版本/提示词字符串
> (`registered-paper-chart-extraction.ts:66-70`)参与 `implementation_digest`/`parameters_digest`
> 溯源,**不宜**做成随手套的设置;若要动需走版本化流程。

### 2.2 采集与外部源运维

- `server/src/dataset/acquisition/runtime.ts:281` — `maxAttempts ?? 3` 且**无重试间退避**;
  唯一构造点 `phase3-composition.ts:394` 不传覆盖。建议新增
  `acquisition_max_attempts` + 退避(可与 `request_interval_ms` 挂钩)。重试码表见 `:330-343`(含 429)。
- Agent 工具侧四个**私有限速器**,不吃 `request_interval_ms`:
  `server/src/agent/tools/dbsnp.ts:22`、`clinvar.ts:12`、`openfda.ts:12`、`gwas-catalog.ts:11`。
- 四个工具文件复制粘贴同一段重试+退避公式(`min(30, max(0.5 * 2**attempt + jitter, retryAfter))`):
  `clinvar.ts:125,101`、`dbsnp.ts:144,175`、`gwas-catalog.ts:147,166`、`openfda.ts:180,143`(次数 3/3/3/2)。
- 六个工具各自的 JSON 响应上限(同 `max_download_mib` 一类):`mgnify.ts:9`(8MiB)、
  `gwas-catalog.ts:10`(8MiB)、`openfda.ts:11`(4MiB)、`dbsnp.ts:10`(2MiB)、
  `clinvar.ts:10`(1MiB)、`declarative-db.ts:18`(10MiB)——建议统一为一个共享上限设置。
- `server/src/agent/tools/xena.ts:47-61`、`gdc.ts:48-50` — 下载重试次数/基础退避写死。
- `server/src/external/ncbi/client.ts:97-109`、`geo/client.ts:18-20` — 连接/读取超时
  5s/30s、重试 3 次、总超时 60s。
- `server/src/dataset/archive/zip-members.ts:25-29` — ZIP 解压预算
  (512 成员/256 MiB/1 GiB;zip-bomb 姿态属运维决策)。
- 浏览器池并发:`server/src/bootstrap.ts:109` `new NodeBrowserPool({ maxContexts: 4 })` —
  全主机浏览器并发上限,强设置候选(并发类)。
- UA 字符串 Chrome/131 四处重复(`pool.ts:60-62`、`gdc/api.ts:23-26`、
  `europe-pmc.ts:28-31`、`sources/fallback.ts:29-30`)——会随时间失效,应收敛为单一常量。

### 2.3 发布门槛与置信度阈值(竞赛敏感,需产品决策:设置 or 文档化常量)

这一组**直接决定哪些数据集能发布、confidence 产物长什么样**,即评分维度
"清洗整合可靠性"的背后常数。当前全部写死:

- `server/src/dataset/validation/confidence.ts:27-36` — Benford/末位检测阈值全家
  (`min_benford_samples 30`、`benford_chi2_limit 15.51`、`last_digit_chi2_limit 16.92` 等);
  注释自述"阈值标定前仅告警",`ConfidenceThresholds` 接口可注入但生产路径写死默认。
- `server/src/dataset/confidence/digit-anomaly.ts:30-46` — 反伪造数字筛查常数
  (`MIN_SAMPLE_SIZE 30`、χ² 临界值、`MAX_DUPLICATE_RATIO 0.8` 等);"flagged"→confidence low→
  触发 `allow_low_confidence_primary: false` 拒绝发布。
- `server/src/dataset/validation/profile.ts:345` — `REQUIRED_GENE_COVERAGE = 0.8`
  (探针→基因覆盖发布门槛,注释已论证取值理由)。
- `server/src/dataset/validation/profile.ts:369-389` — `ExpressionValidationProfile`
  门槛字面量(`max_low_confidence_fraction 0`、`allow_low_confidence_primary false`、
  `block_pending_human_review true`、`require_review_for_channels [vlm,llm,ocr,web_extraction]`)。
- `server/src/dataset/confidence/evaluator.ts:11-16` — `NONDETERMINISTIC_CHANNELS`
  封顶 medium 的业务规则。
- `server/src/dataset/cleaning/string-similarity.ts:4-5` — `STRING_SIMILARITY_THRESHOLD = 0.7`
  (字段映射自动接受/存疑分界;0.7 以下转人工审)。
- 各家族解析上限(硬准入上限,决定各家族能吃多大的载荷):
  `gut-microbiome/registered.ts:10-14`(64MiB/50 万行/256KiB 行)、
  `inherited-disease-evidence/registered.ts:5-9`(256MiB/200 万行/2MiB)、
  `bioactivity-measurement` 与 `paper-evidence`(16MiB/25 万行)、
  `variant-evidence` 与 `target-evidence`(8MiB/10 万行)、
  `literature-evidence/schema.ts:165-168`(8MiB/5 万行)、
  `literature-experiment-chart/validation.ts:16-18`(行 1MiB/字段 512KiB/128 列)。

评估:阈值类(前五项)若开放设置,竞赛产物会随设置漂移、且 confidence 语义需同步文档;
**推荐方案**:先收敛为带理由的命名常量 + 文档(本报告),把"是否开放设置"作为产品决策
挂 `[Q]` 讨论;家族解析上限类则是典型运维旋钮,适合进设置(或按家族目录一份配置)。

### 2.4 运行时/主机级(建议 env 或本地配置文件,而非 Web 设置)

- `server/src/config.ts:24-30` — `HOST 127.0.0.1` / `PORT 5173` /
  `SHUTDOWN_TIMEOUT_MS 10000`(env 可覆盖,回退写死)。
- `server/src/app/create-app.ts:100-112` — `EADDRINUSE` 静默回退 OS 随机端口(值得一个开关)。
- `server/src/runtime/durable-agent-runtime.ts:79-85` — 任务 API 体上限 64KiB、输入上限
  64KiB、导入 `MAX_IMPORT_FILES 10` / 单文件 500MiB / 总量 2GiB、WS 命令 8KiB/积压 64KiB;
  注意前端 `AgentComposer.tsx:52-54` **复制了同一套导入上限**,双侧需同步(漂移陷阱)。
- `server/src/runtime/task-repository.ts:81,91` — `EVENT_CACHE_MAX_BYTES 256MiB`
  (2026-08-29 OOM 事件后引入的内存预算;大内存机器可放宽)。
- `server/src/agent/permissions/broker.ts:92` — `maxPendingMs ?? 30min`
  (权限/HIL 审批卡待决超时;HIL 设置只管模式不管 TTL)。
- `server/src/external/browser/pool.ts:72` — 渲染进程 V8 堆顶 2048MB;
  `pool.ts:77` 会话关闭 5s 等运维边界。
- API 分页默认:`durable-agent-runtime.ts:1561,1598`(50/100,上限 100/1000)、
  `task-repository.ts:378-380,513-519`(events 默认/上限 1000)、
  `product/product-api.ts:233,263` 与 `cache-api.ts:195,198`(50/200;exportZip 内存整装 10000 上限)。
- `server/src/http/body.ts:16` — host API JSON 体上限 1MiB(与 runtime 64KiB、WS 8KiB 三套并存)。
- `server/src/runtime/task-file.ts:15` — `MAX_TASK_FILE_BYTES 4MiB`。

### 2.5 前端(低优先级,多数与 server 侧成对)

- `frontend/src/runtime/transport.ts:1006` — WS 重连延迟默认 500ms(无退避)。
- `frontend/src/runtime/controller.ts:24-26` — 任务列表首屏 15、展开 10、事件重放 1000;
  `:780` 消息页 100。
- `frontend/src/components/conversation/DownloadProgress.tsx:45-47` — 停滞判定 60s、刷新 15s。
- 导入上限(见 2.4,需与 server 保持成对)。

评估:均为体验层,若 server 分页/上限进入设置,前端应读同一份而不是继续写死;
单独为它们开设置价值低。

---

## 三、横切观察(结构性问题,与单个参数无关)

1. **重试/退避策略存在三个互不相干的层级**(供应商重试 `pi-adapter.ts:567`、断流恢复
   `pi-adapter.ts:924`、工具 HTTP 重试四个复制粘贴副本),无共享配置 —— 建议设计一个
   统一的 retry-policy 设置域再接线。
2. **设置默认值多处复制**(safety_reserve 0.05 ×3、max_tokens 8192 ×4、上下文预算默认在
   contracts/store/pi-adapter 三处)—— 设置默认值应单源导出。
3. **`RuntimeLimits` 覆盖面缺口**:模型请求超时(VLM/HIL/发现探测)、采集重试次数、
   API 响应上限都不在 14 项之内,导致各自写死。
4. `server/src/agent/workspace/tools.ts:117,127` 工具描述文案写死 "65536 characters",
   与实际设置驱动的限制不符(文档漂移)。

---

## 四、明确建议保持硬编码(附理由)

- **协议/身份不变量**:`transform-host/protocol.ts:6-8`(协议形状上限)、各类
  `slice(0,16/24/32)` 哈希截断与 ID 派生、`PROTOCOL_VERSION "1"`、ZIP 规范常数(EOCD 等)。
- **溯源冻结物**:`REGISTERED_PAPER_CHART_EXTRACTION_VERSION`、
  `REGISTERED_PAPER_CHART_PROMPT_VERSION`、冻结的 `VLM_PROMPT`(prompt_digest 入证)。
- **parity 锁定**:`analysis/` 全部(scipy/pandas 对齐的 ibeta 常数、小数位、画布尺寸)、
  `processing/pdf/` 表格几何与元数据启发式、各 provider 的外部 API base URL(钉进
  `allowedHosts` 与 `implementation_digest`,换源本就应是代码变更事件)。
- **安全/敌意输入上限**:`evaluation/` 的 `MAX_JSON_BYTES 16MB`、`MAX_JSON_NODES` 等、
  `transform-host/proof-gate.ts`、`admission.ts`。唯一保留意见:单次 Gold6 run 已产出
  1.7 万事件,evidence JSON 若超 16MB 会被判 malformed 计 fail —— 该上限值得登记观察。
- **数值/性能内部常数**:协同让步步长、SQLite page 常数、事件载荷截断(`MAX_TEXT 4096` 等)、
  限速器实现内部、供应商目录与模型目录(是"数据"不是"旋钮")。

---

## 五、落地建议(如获批准实施)

1. **P0 接线整改**(不动设置面,只删第二真相):上表 12 项逐项改为消费现有设置;
   `GDC_JSON_TIMEOUT_MS` 死常量删除;`DATASET_OPERATION_TIMEOUT_MS` 旁路按其注释退役。
2. **`RuntimeLimits` 扩容**:新增 `model_request_timeout_seconds`、
   `acquisition_max_attempts`(及退避)、`api_response_max_mib`(统一六处工具响应上限);
   provider `maxBytes` 一律 `min(providerCap, max_download_mib)`。
3. **模型行为设置**:vision 作用域 temperature + 模型重试策略(收敛三层为一)。
4. **主机级 env 清单**:`HOST/PORT/SHUTDOWN_TIMEOUT_MS`、`EVENT_CACHE_MAX_BYTES`、
   浏览器 `maxContexts`、导入上限 —— 建议 `.env.example` 统一登记(它们是部署属性,
   不属于多用户 Web 设置)。
5. **发布门槛域**:先文档化常量+理由,开放设置作 `[Q]` 产品决策(防止竞赛产物随设置漂移)。
6. 前端分页/重连参数随对应 server 设置走,不单独开面。

## 六、与 2026-08-28 设置接线审计的衔接

- 8-28 审计的 P1 `safety_reserve_ratio` 半死设置:本审计在 `pi-adapter.ts:156`
  找到其写死副本(`DEFAULT_SAFETY_RESERVE_RATIO = 0.05`)——即行为实际由代码常数驱动,
  设置值未接线,两份报告指向同一根因,可合并整改。
- 8-28 审计剩余待办(compaction 参数前端编辑入口、api_key 掩码边角)与本报告不重叠。
- 本报告的"落地建议"若获批准,建议在 `docs/TODO.md` 增设对应条目并建看板任务。
