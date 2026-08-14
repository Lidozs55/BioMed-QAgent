# BioMed-QAgent Phase 5 补全与 Phase 0–6 收口实施计划

> 建议仓库路径：`docs/migration/phase5-external-capabilities-completion-plan.md`  
> 文档状态：Implemented + integration closure（2026-08-14；验收清单见下方，
> CI 门禁见 `.github/workflows/ci.yml`）
> 基线：`main @ d6224151e23821ca85ece004969aa469f638f08a`  
> 目标：补齐 Pi Migration Plan Phase 5，并完成一轮 Phase 0–6 集成收口，使“Phase 0–6 已完成”成为可测试、可回滚、可审计的事实，而不是仅指代码已移植。  
> 不包含：Phase 7 正式默认切换、Phase 8 Python Runtime 物理删除。

---

## 1. 背景与结论

截至基线提交，Pi 迁移主线状态如下：

| Phase | 内容 | 当前状态 |
| --- | --- | --- |
| 0 | 冻结边界与迁移 ADR | ✅ |
| 1 | Pi Main Agent + TS Host + Workspace + Core bridge | ✅ |
| 2 | Skills 与通用 Agent 工具迁移 | ✅ |
| 3 | TS Application Runtime | ✅，但 `AGENT_RUNTIME=pi` 仍为 opt-in |
| 4 | Dataset Deterministic Core TS 移植 | ✅，但正式运行接线尚未完成 |
| 5 | 外部能力与 Python 数据处理依赖迁移 | ❌ |
| 6 | 模型设置与 Settings API | ✅ |

当前缺口集中在两层：

1. **Phase 5 本体缺失**：业务 Tool 实现仍主要在 Python，包括外部数据源访问、浏览器、PDF/表格处理、视觉提取、统计分析等。
2. **Phase 4 运行接线尚未闭环**：TS Dataset Core 已存在，但 `DATASET_CORE=ts` 尚不能形成有效运行 profile；正式 Pi Runtime 仍通过 `DatasetCoreClient` 调 Python bridge。

因此，本计划拆成两个里程碑：

- **M1：严格完成 Phase 5**。达到迁移方案原始验收条件：Pi/TS 路径不再依赖 Python 执行 acquisition / parsing / analysis。
- **M2：完成 Phase 0–6 集成收口**。在不改变默认 profile 前提下，让 `AGENT_RUNTIME=pi + DATASET_CORE=ts` 成为可运行、可测试、可回滚的 opt-in 路径，为 Phase 7 正式切换提供可信基础。

M2 不改变 Phase 7 定义：默认流量切换、完整前端 E2E 与 FastAPI 默认关闭仍归 Phase 7。

---

## 2. 依据与现状约束

本计划以以下仓库事实为准：

- `docs/TODO.md` 将 Phase 5 标为待开始，并明确要求迁移 Playwright、crawler、HTTP acquisition、GEO/GDC/Xena/PubMed、PDF、表格解析、统计/绘图。
- `docs/BioMed-QAgent_Pi_Migration_Plan.md` 要求每项具备 live + fixture 双测试，禁止一次性删除 Python 科学依赖后再调试。
- `docs/migration/phase2-skills-tools-migration.md` 已冻结业务 Tool 的接入方式：嵌入式 Pi SDK 场景使用 `PiAgentAdapter.customTools`，不重新建立 `.pi/extensions` 第二套 Pi 依赖面，也不新增临时 Python skill-op bridge。
- `server/src/agent/skills/skill-tool-map.ts` 已成为 Skill ↔ Tool 稳定名称单一事实源。
- `server/src/runtime/phase3-composition.ts` 目前只给正式 Pi Session 注入 Workspace Tool 和 DatasetBuild bridge Tool，尚未注入 Phase 5 业务 Tool。
- `server/src/config.ts` 虽解析 `DATASET_CORE=ts`，但当前合法 profile 集合没有任何 TS Core profile。
- `server/src/dataset/runtime/executor.ts` 明确保留 operation timeout、build lock、straggler marker、event sink 等运行基础设施给后续 Host 集成。
- Python `backend/pyproject.toml` 仍包含 Playwright、pdfplumber、matplotlib、SciPy、seaborn 等 Phase 5 目标依赖。

迁移过程继续遵守既有跨阶段约束：

```text
Pi Session != BioMed Task != Run != DatasetBuild
Skill != Tool != Dataset Core
Agent Workspace != Publication boundary
staging/ 可工作
artifacts/ 与 publications/ 仅 Core Publisher 可发布
Pi 依赖只允许经 pi-adapter.ts
每个阶段必须可独立回滚
```

---

## 3. 本轮范围

### 3.1 必做范围：Phase 5

本轮必须覆盖以下能力：

1. 通用网络安全与 HTTP acquisition；
2. NCBI/PubMed 基础设施；
3. GEO；
4. GDC；
5. Xena；
6. 其余内置研究型数据源：ChEMBL、UniProt、PDB、PubChem、Reactome；
7. Browser fallback / crawler / web visual capture；
8. PDF 表格与元数据提取；
9. Qwen-VL 图表数据提取；
10. 统计与绘图；
11. local cache Tool；
12. 用户声明式数据库 HTTP Tool；
13. Pi 正式 Runtime 的业务 Tool 装配；
14. Python acquisition / parsing / analysis 在 Pi 路径中的退役。

### 3.2 强烈建议同时完成：Phase 0–6 集成收口

Phase 5 完成后继续完成一个独立 checkpoint：

- `DATASET_CORE=ts` 真实生效；
- TS Dataset Core 加入 operation timeout；
- 加入 build lock；
- 加入 Core event sink → durable EventEnvelope；
- cancel 能中止当前 Core operation；
- `validate_dataset_build` / `execute_dataset_build` 可直接调用 TS Core；
- 保留 `DATASET_CORE=python` 作为回滚路径；
- 四类 golden E2E 在 TS Core 路径通过。

### 3.3 明确不做

以下事项不纳入本计划，防止范围蔓延：

- 不将默认 `AGENT_RUNTIME` 改成 `pi`；
- 不将默认 `DATASET_CORE` 改成 `ts`；
- 不关闭 FastAPI 默认回滚路径；
- 不删除 `backend/app/agent_loop`、`backend/app/runtime`、`backend/app/api` 等；
- 不完成 Phase 8 Python 物理删除；
- 不重新实现 SubagentSupervisor；
- 不同时重写前端协议；
- 不改变 DatasetBuild JSON contract、Publication Gate 或 EventEnvelope 外形；
- 不因“方便迁 TS”而改变科研计算语义。

---

## 4. Definition of Done

### 4.1 Phase 5 完成条件

必须同时满足：

- `server` 能构造与 `SKILL_TOOL_MAP` 对齐的完整业务 Tool 集；
- 正式 Pi Session 可直接调用这些 Tool，不再经 Python skill/runtime 执行业务能力；
- GEO/GDC/Xena/PubMed acquisition 全部由 TS 负责；
- Browser/crawler/web capture 全部由 Node 负责；
- PDF/table/VLM processing 不调用 Python；
- analysis Tool 不调用 Python；
- local cache 仅允许经 TS DB Adapter → named-op Python DB bridge，或完全 TS 实现；
- 用户声明式 HTTP 数据库请求由 TS 执行，Python 不再负责网络调用；
- Python 只允许继续承担迁移期 legacy rollback runtime 与数据库 bridge 职责；
- 每个能力组均具备 fixture parity；
- 外部能力均具备显式 live smoke；
- 网络安全回归测试通过；
- Pi path 无任何“偷偷回退 Python 处理”的分支。

这里“Python 不再承担 acquisition / parsing / analysis”指**新 Pi/TS 产品路径的运行职责**已经退出 Python。为了 Phase 7 前可回滚，旧 Python 实现可以暂时保留在仓库中；其物理删除与相关依赖彻底清理放到 Phase 8。

### 4.2 Phase 0–6 收口条件

在 Phase 5 条件之上再满足：

```text
APP_HOST=ts
AGENT_RUNTIME=pi
DATASET_CORE=ts
```

成为合法 opt-in profile，并能完成：

```text
自然语言任务
→ Pi Session
→ TS business tools
→ TS Dataset Core
→ Validation
→ Publication
→ durable events
→ artifact API
```

同时：

- 不启动 Python Dataset Core bridge；
- Core 运行具备 timeout / lock / cancel / event sink；
- 四类 golden fixture 通过；
- `DATASET_CORE=python` 仍可回滚；
- 默认 profile 暂不改变。

---

## 5. 当前能力迁移矩阵

下表中“目标路径”为建议目录，不表示这些文件已经存在。

| 能力 | 当前 Python 位置 | 建议 TS 目标 | Phase 5 验收重点 |
| --- | --- | --- | --- |
| Public URL / SSRF 防护 | `app/tools/network_safety.py` | `server/src/external/network/` | DNS、公网 IP、redirect 逐跳校验 |
| Browser egress | `app/tools/egress_proxy.py` | `server/src/external/browser/egress-*` | HTTPS/443、DNS pin、per-context 权限 |
| HTTP acquisition | `app/integrations/acquisition.py` | `server/src/external/acquisition/` | streaming、大小、hash、media type、原子发布 |
| Content cache | `app/tools/content_cache.py` | `server/src/external/acquisition/content-cache.ts` | request/blob cache parity |
| NCBI | `app/integrations/ncbi/*` | `server/src/external/ncbi/` | retry、Retry-After、解析一致 |
| PubMed | `skills/builtin/discovery/pubmed.py` | `server/src/agent/tools/pubmed.ts` | search + supplementary fallback |
| GEO Tool | `skills/builtin/acquisition/geo.py` | `server/src/agent/tools/geo.ts` | search/describe/list/download |
| GEO Dataset parse | `datasets/build/geo_*.py`、`probe_mapping.py` | `server/src/dataset/adapters/geo/` | matrix/SOFT/platform/sample metadata |
| GDC | `skills/builtin/acquisition/gdc.py` | `server/src/agent/tools/gdc.ts` | search/describe/download + MD5 |
| Xena | `skills/builtin/acquisition/xena.py` | `server/src/agent/tools/xena.ts` | search/download + source semantics |
| ChEMBL | `skills/builtin/discovery/chembl.py` | `server/src/agent/tools/chembl.ts` | JSON parity |
| UniProt | `skills/builtin/discovery/uniprot.py` | `server/src/agent/tools/uniprot.ts` | JSON parity |
| PDB | `skills/builtin/acquisition/pdb.py` | `server/src/agent/tools/pdb.ts` | search/describe/download |
| PubChem | `skills/builtin/acquisition/pubchem.py` | `server/src/agent/tools/pubchem.ts` | search/get/download |
| Reactome | `skills/builtin/acquisition/reactome.py` | `server/src/agent/tools/reactome.ts` | search/get/download |
| Browser fallback | `skills/builtin/acquisition/browser.py` | `server/src/agent/tools/browser.ts` | declarative browser actions |
| Web capture | `web_visual_capture.py` | `server/src/agent/tools/web-visual-capture.ts` | screenshot limits + provenance |
| crawler | `app/tools/crawler.py` | `server/src/external/crawler/` | HTTP-first，browser fallback |
| PDF tables/meta | `processing/extract_tables.py` | `server/src/processing/pdf/` | 表格、metadata、CJK、扫描件提示 |
| VLM chart | `processing/extract_chart_data_vlm.py` | `server/src/processing/vlm/` | 严格 JSON、三层降级、provenance |
| Analysis | `analysis/stats.py` | `server/src/analysis/` | Welch、BH、correlation、plot |
| Guidance | `research_data_guidance.py` | `server/src/agent/tools/guidance.ts` | 只读 curated guidance |
| Local cache | `tools/cache_store.py` + `local_cache.py` | `server/src/persistence/db-client.ts` + Tool | named operations |
| User DB HTTP | `app/databases/declarative.py` | `server/src/databases/` | manifest、auth、SSRF、10MiB 限制 |
| Dataset Core Tool | Python bridge | `server/src/dataset/` | M2 切换 opt-in TS Core |

---

## 6. 编码前必须冻结的决策

Phase 5 不宜边写边猜。第一批 PR 先固定下列决策。

### P5-D1：统一 TS 网络策略

不能为 GEO、GDC、Browser、用户数据库分别写四套 URL 安全代码。需要一个底层网络策略模块，并在上层定义不同 policy。

建议至少分成：

```text
PublicHttpPolicy
- HTTP/HTTPS
- 禁止 URL credentials
- DNS 解析必须全部为 global address
- redirect 每跳重新验证
- 适用于无固定域名的声明式公开 HTTP Tool

CredentialedPublicHttpsPolicy
- PublicHttpPolicy
- 强制 HTTPS
- 适用于携带 secret 的请求

CuratedSourcePolicy
- 强制 HTTPS
- exact hostname allowlist
- 443 only
- 禁止 IP literal
- redirect 限制
- 正式 SourceAsset acquisition 默认禁止跨 host redirect

BrowserEgressPolicy
- HTTPS only
- 443 only
- DNS pin
- per-context authorized host
```

不能简单用 `fetch(url)` 替代现有防护。

### P5-D2：Tool 返回 contract 不随迁移漂移

TS Tool 必须先复制现有 Python Tool 的：

- 参数名；
- required/default 规则；
- JSON key；
- error/reason_code；
- records/accessions/local_files 等稳定字段；
- progress 事件语义。

若当前 Python 行为本身存在错误，应先形成独立 bugfix，Python 与 TS 同步改，再更新 golden fixture；不要只在 TS 侧“顺手修”。

### P5-D3：SourceAsset 只能通过统一 acquisition 服务产生

所有可进入 DatasetBuild 的下载必须走同一 TS acquisition service，不能由各个 Tool 自己：

```ts
await fetch(url)
await writeFile(...)
```

统一服务负责：

- policy；
- streaming；
- size limit；
- hash；
- expected checksum；
- media type；
- cache；
- source_assets 发布；
- DownloadAttempt；
- progress；
- cancellation；
- provenance。

### P5-D4：业务 Tool 与 Dataset Core 分层保持不变

例如：

```text
download_geo
= Agent-facing acquisition Tool

GeoSourceAdapter
= Dataset Core parser

SKILL.md
= 使用说明

三者不能合并
```

Agent Tool 不获得 Publication 权限。

### P5-D5：统计输出先解决 Publication 边界冲突

当前 Python `analysis/stats.py` 会直接写 `task/artifacts/`。这与迁移总方案“只有 Core Publisher 可以写 artifacts/publications”冲突。

TS 移植前必须决定其中一种方式：

**推荐方案：**

```text
analysis tool
→ staging/analysis/<run_id>/
→ 返回 AnalysisOutput descriptor
→ application artifact promotion / trusted publisher
→ 对前端暴露
```

不得直接照搬 Python 的 `artifacts/` 写法。

若决定“分析图不是 DatasetPublication artifact”，应另设稳定命名空间与 API，明确其不属于 Dataset Core publication；同样不能模糊复用 publication 目录。

### P5-D6：PDF 后端先做 spike，不预选库

迁移方案只要求“选择并验证 TS/CLI PDF 解析方案”，当前 Python 路径具有：

```text
pdfplumber
→ PyPDF2
→ raw PDF stream regex fallback
```

以及扫描件检测、CJK 文本处理、table CSV 输出。

因此先用现有 PDF fixtures 对候选方案做 spike，再决定依赖。候选实现必须能解释：

- 表格提取覆盖率；
- text metadata；
- CJK；
- image-only PDF；
- PDF page rasterization；
- Windows/Arch 安装与打包复杂度；
- 取消与超时；
- 是否引入额外 Python runtime。

本阶段不能为了“TS”重新依赖长期 Python CLI。

### P5-D7：local cache 属于 DB bridge，不属于业务 Python bridge

迁移方案允许：

```text
Skill
→ Tool
→ TS DB Adapter
→ Python database/bridge.py
→ SQLite
```

因此 `search_local_cache` 等可调用 named DB operations。禁止使用：

```text
Tool
→ Python local_cache.py
```

也禁止任意 SQL operation。

### P5-D8：用户声明式数据库 HTTP 执行迁 TS

Python 最终只保留数据库，因此：

- manifest 持久化可暂时由 DB bridge 管；
- HTTP request 必须在 TS 执行；
- auth secret 只能服务端读取；
- path placeholder 继续 percent-encode；
- header CR/LF 继续拒绝；
- response 继续限制 10 MiB；
- redirects 继续逐跳 public URL 校验。

### P5-D9：HIL 不移植 SubagentSupervisor

现有 credentialed declarative Tool 在 Python 通过 HIL approval gate 使用 secret。Phase 5 不应为了它恢复 SubagentSupervisor。

需要在 TS durable runtime 建一个最小 approval primitive：

```text
tool requests approval
→ Run enters waiting_for_input
→ durable event
→ frontend existing HIL surface
→ approve/reject
→ same run resumes
```

若当前前端协议不足，应只做最小兼容扩展，不重写整个交互协议。

### P5-D10：Reactome `pipeline_supported` 先对齐

当前 Phase 2 文档将 Reactome描述为调研能力，但 `backend/tests/test_builtin_tools.py` 的 `EXPECTED_PIPELINE_SUPPORTED` 含 `reactome`。

Phase 5 开工前必须确定哪个才是权威语义，并同步：

- `skill-tool-map.ts`；
- Python mirror test；
- `.pi/skills/reactome/SKILL.md`；
- 数据库选择逻辑；
- migration 文档。

不允许 TS 迁移时自行选择一种解释。

---

## 7. 目标架构

M1 完成后：

```text
React Frontend
      │
      ▼
TypeScript Application Host
      │
      ├─ Pi Agent Runtime
      │    │
      │    ├─ Workspace Tools
      │    ├─ BioMed Business Tools ───────────────┐
      │    ├─ User Declarative HTTP Tools         │
      │    └─ DatasetBuild Tool                   │
      │                                           │
      ├─ TS External Capability Layer             │
      │    ├─ network policy                       │
      │    ├─ HTTP acquisition                     │
      │    ├─ Node Playwright                      │
      │    ├─ NCBI/GDC/Xena/... clients            │
      │    ├─ PDF/VLM processing                   │
      │    └─ analysis                             │
      │                                           │
      ├─ TS DB Adapter ── JSONL ── Python DB bridge
      │
      └─ DATASET_CORE=python
           └─ legacy Dataset Core bridge
```

M2 完成后：

```text
React Frontend
      │
      ▼
TS Host
      │
      ├─ Pi Agent
      ├─ TS Business Tools
      ├─ TS External Capabilities
      ├─ TS DB Adapter ── Python DB bridge
      │
      └─ DATASET_CORE=ts
           └─ TS Deterministic Dataset Core
                acquire
                → parse
                → canonicalize
                → compatibility
                → integrate
                → validate
                → publish
```

此时 Python FastAPI 仍可存在作 legacy rollback，但不在 `ts/pi/ts` 产品路径上承担 Agent、acquisition、parsing、analysis、Dataset Core。

---

## 8. 实施顺序

建议采用小步 PR/checkpoint，不开一个超大 Phase 5 分支一次完成。

---

## Checkpoint P5-00：冻结 Phase 5 baseline 与 parity corpus

### 目标

先建立“迁什么、迁到什么程度”的可执行基线。

### 工作

新增：

```text
docs/migration/phase5-external-capabilities.md
server/tests/phase5/fixtures/
server/tests/phase5/contracts/
```

整理：

- `SKILL_TOOL_MAP` 全量 Tool；
- Python 参数 Schema；
- fixture 输入；
- fixture 输出；
- error/reason_code；
- QueryStatus/progress；
- SourceAsset/DownloadAttempt；
- external host policy；
- Python 依赖使用点。

为每个 Tool 生成一条 migration record：

```text
tool name
python implementation
category
network?
writes files?
can feed DatasetBuild?
credentials?
fixture
live test
TS implementation
status
```

同时解决 P5-D10 Reactome 语义漂移。

### 验收

- 所有稳定 Tool 均进入迁移矩阵；
- 没有“Phase 5 后再看看”的未分类 Python acquisition/parsing/analysis 模块；
- 关键 Python fixture 可在本地重复执行；
- baseline 不依赖真实网络。

---

## Checkpoint P5-01：TS 网络安全与 Acquisition 基础层

### 目标

先迁公共底座，再迁具体数据源。

### 建议目录

```text
server/src/external/
├── network/
│   ├── errors.ts
│   ├── dns.ts
│   ├── url-policy.ts
│   ├── redirect-policy.ts
│   └── http-client.ts
│
└── acquisition/
    ├── downloader.ts
    ├── content-cache.ts
    ├── source-assets.ts
    ├── hashing.ts
    ├── media-type.ts
    └── types.ts
```

### 必须保留的行为

#### URL / DNS

- 只接受允许 scheme；
- credentialed request 强制 HTTPS；
- 禁止 URL username/password；
- 禁止 localhost；
- DNS 解析出的**所有地址**必须为公网；
- 不能只检查第一个 DNS result；
- 正式 source URL 禁止 IP literal；
- curated source host exact-match；
- curated source port 仅 443。

#### Redirect

正式 acquisition：

```text
max redirects = 5
每跳重新校验 URL
每跳重新解析 DNS
默认禁止跨 host
```

声明式 public HTTP：

```text
每跳重新 public-address 校验
是否允许跨 host 由 manifest policy 决定
携带 credential 时禁止向未授权 host 泄露
```

#### Streaming download

- `Content-Length > max`：读取前失败；
- streamed bytes 超限：立即 abort；
- 空响应失败；
- Content-Length 与实际 bytes 不一致失败；
- expected size；
- expected SHA-256；
- expected MD5；
- expected media types；
- `AbortSignal`；
- progress callback。

#### 原子落盘

建议保持：

```text
download_tmp/<attempt>.part
→ fsync
→ verify hash
→ content-addressed cache
→ hardlink/copy
→ source_assets/<asset_id>/<filename>
```

失败后：

- `.part` 清理；
- 不留下半个 SourceAsset；
- 不污染 cache metadata。

### 测试

至少覆盖：

- localhost；
- 127.0.0.1；
- RFC1918；
- IPv6 local/private；
- DNS 返回 public + private 混合；
- malformed URL；
- URL credential；
- HTTP credential；
- redirect → private；
- redirect → other host；
- redirect loop；
- redirect > 5；
- declared oversize；
- streamed oversize；
- empty body；
- length mismatch；
- media mismatch；
- SHA mismatch；
- MD5 mismatch；
- abort；
- cache hit；
- cache corrupt；
- destination collision；
- partial file cleanup。

### 验收

后续任何 external source Tool 不再直接自己实现下载安全逻辑。

---

## Checkpoint P5-02：Tool 装配框架 + 低风险 deterministic Tool

### 目标

尽早证明“Phase 2 的稳定名称映射 → TS 实现 → Pi customTools”链路真实可用。

### 新增

建议：

```text
server/src/agent/tools/
├── registry.ts
├── business-tools.ts
├── literature-understanding.ts
└── research-data-guidance.ts
```

`business-tools.ts` 接收 task/run/session 相关依赖并生成：

```ts
BioMedAgentTool[]
```

最终继续通过：

```text
PiAgentAdapter
→ toPiCustomTools
→ createAgentSession(customTools)
```

不直接在业务模块 import Pi 类型。

### 首批迁移

#### `analyze_papers`

它当前是纯 regex、无网络、无模型，适合作为首个 parity Tool。

要求：

- accession regex parity；
- database detection parity；
- dedup/order parity；
- empty input parity；
- summary fields parity。

#### `get_research_data_guidance`

优先从仓库 curated resource 读取，不复制第二份指导文本。

### 测试

- Tool name 与 `SKILL_TOOL_MAP` 完全一致；
- 参数 Schema 稳定；
- Python vs TS fixture JSON parity；
- `PiAgentAdapter` session 中能实际执行；
- event adapter 可见 `tool_started/tool_completed`；
- duplicate tool name fail closed。

### 验收

正式 Pi Runtime 至少有非 Workspace/非 DatasetBuild 业务 Tool 实际工作。

---

## Checkpoint P5-03：NCBI + PubMed

### 目标

迁移 GEO 与 PubMed 共用的 NCBI 基础设施。

### 建议目录

```text
server/src/external/ncbi/
├── client.ts
├── query-utils.ts
├── parsers.ts
├── retry.ts
└── discovery.ts

server/src/agent/tools/pubmed.ts
server/src/external/publication/
├── unpaywall.ts
└── europe-pmc.ts
```

### 行为要求

迁移现有：

- NCBI E-utilities request；
- User-Agent / email / API key；
- bounded retry；
- 429/5xx；
- `Retry-After`；
- XML/JSON parser；
- PubMed record shape；
- query translation；
- supplementary retrieval；
- direct PDF → Unpaywall → Europe PMC fullTextXML fallback。

不得把 landing page 当成 PDF。

### fixture 测试

- esearch；
- esummary；
- malformed response；
- empty result；
- 429 + Retry-After；
- 500 retry；
- timeout；
- PubMed records；
- DOI/PMCID fallback chain；
- all tiers failed。

### live 测试

单独 marker：

```text
live:ncbi
live:pubmed
```

CI 默认不因公共服务暂时故障失败；release verification 显式跑一次。

### 验收

`search_pubmed`、`download_supplementary` 完全 TS 化。

---

## Checkpoint P5-04：GEO 完整迁移

### 目标

不只迁下载 Tool，还补齐 Phase 4 明确留下的 GEO Dataset parser。

### Agent Tool

迁移：

```text
search_geo
describe_geo
list_geo_supplementary_files
download_geo
download_geo_platform_annotation
```

### 必须保持的 GEO 行为

- accession 大写规范；
- `ftp://ftp.ncbi.nlm.nih.gov` 转 HTTPS；
- 只允许 official NCBI GEO HTTPS；
- `matrix | soft | suppl`；
- supplementary listing；
- 多文件时要求显式 filename；
- 错误中返回 available filenames；
- listing 429/5xx bounded retry；
- `describe_geo` 不伪造 NCBI 未提供字段；
- metadata-only series matrix 检测：
  - 无 `!series_matrix_table_begin`
  - 返回 `reason_code=empty_series_matrix`
  - 提示尝试 `soft` 或 `suppl`。

### Dataset Core

检查并迁移尚在 Python 的：

```text
geo_adapter.py
geo_relations.py
geo_sample_metadata.py
probe_mapping.py
```

根据真实依赖拆到：

```text
server/src/dataset/adapters/geo/
├── series-matrix.ts
├── soft.ts
├── sample-metadata.ts
├── relations.ts
└── probe-mapping.ts
```

不能只让 `download_geo` 工作，却让 `execute_dataset_build` 继续依赖 Python GEO parser。

### parity

至少准备：

- 标准 microarray series matrix；
- metadata-only matrix；
- SOFT；
- supplementary expression file；
- single/multi GPL；
- probe-level；
- sample metadata；
- malformed gzip；
- empty primary data；
- mixed valid/invalid bindings。

### live

至少：

- 一个稳定 GSE search；
- describe；
- supplementary list；
- 小文件 download；
- 一个可进入 DatasetBuild 的小型 fixture/live accession。

### 验收

GEO 从搜索到 SourceAsset 再到 TS parser 完整闭环。

---

## Checkpoint P5-05：GDC + Xena

### GDC

迁移：

```text
search_gdc
describe_gdc
download_gdc
```

重点保持：

- GDC API filter/query；
- result shape；
- expected file size；
- 官方 `md5sum` 校验；
- media type；
- SourceAsset provenance；
- rate/timeout 行为。

TS Phase 4 已有 GDC expression adapter，本 checkpoint 重点验证：

```text
TS acquisition output
→ TS GdcExpressionAdapter
```

端到端契约完全匹配。

### Xena

迁移：

```text
search_xena
download_xena
```

保持：

- hub/source 标识；
- matrix file semantics；
- S3 host policy；
- immutable SourceAsset。

验证：

```text
TS acquisition output
→ TS XenaMatrixAdapter
```

### 验收

GDC/Xena 不再需要 Python external implementation 才能完成完整 DatasetBuild source path。

---

## Checkpoint P5-06：其余研究型数据源

迁移：

```text
search_chembl
search_uniprot

search_pdb
describe_pdb
download_pdb

search_pubchem
get_compound
download_pubchem

search_reactome
get_pathway
download_reactome
```

这些 Tool 复用 P5-01 network/acquisition，不另造 HTTP client。

### 重点

- 搜索结果 JSON shape parity；
- empty result 不能伪 success records；
- download 统一产 SourceAsset；
- API payload 设大小上限；
- endpoint host 固定或 public policy 明确；
- cancellation。

### 验收

`SKILL_TOOL_MAP` 中外部数据库 Tool 无 Python-only 缺口。

---

## Checkpoint P5-07：Node Playwright、Browser fallback、Crawler、Web Capture

### 目标

替换：

```text
backend/app/tools/browser_pool.py
backend/app/tools/egress_proxy.py
backend/app/tools/crawler.py
browser_fallback
web_visual_capture
```

### Node Browser Pool

保持现有关键约束：

- 单 Chromium，可复用；
- 每 operation 独立 BrowserContext；
- context 结束即销毁；
- per-context egress authorization；
- 固定 UA；
- bounded navigation timeout；
- AbortSignal；
- 最多并发 context；
- shutdown 全部收敛。

### Browser actions

继续只允许声明式 operation：

```text
navigate
click
fill
select
wait_for
extract
```

不要引入：

```text
agent-generated arbitrary JavaScript
```

### 限制

至少延续当前数量级：

```text
page/extract: 10 MiB
screenshot: 25 MiB
screenshot pixels: 25,000,000
```

若调整数值，必须作为明确 ADR/bugfix，不随迁移暗改。

### Crawler

建议：

```text
HTTP-first
→ parser
→ Browser fallback only when needed
```

浏览器不能成为普通 API 抓取默认路径。

### Web visual capture

截图进入：

```text
source_assets/figures/
```

并记录：

- source URL；
- final URL；
- capture timestamp；
- SHA-256；
- viewport；
- selector/section；
- source asset id。

### 测试

- browser context isolation；
- cookie/session 不串任务；
- private DNS 拒绝；
- unauthorized host 拒绝；
- non-443 拒绝；
- redirect policy；
- oversize extraction；
- oversize screenshot；
- cancellation；
- pool close；
- page crash；
- selector missing；
- SSRF regression。

### 验收

Python Playwright 不出现在 Pi path。

---

## Checkpoint P5-08：PDF / Table / VLM

本 checkpoint 分两段，不直接先写最终实现。

### P5-08A：PDF 技术选型 spike

用固定 fixtures 比较候选方案，至少包含：

- 普通英文论文 PDF；
- CJK PDF；
- vector table；
- raster/scanned PDF；
- 多页；
- embedded image；
- malformed PDF。

记录：

```text
docs/migration/phase5-pdf-spike.md
```

评估项：

| 项 | 要求 |
| --- | --- |
| page count | 必须 |
| text | 必须 |
| metadata | 必须 |
| DOI/caption | 能保持现有行为 |
| table extraction | fixture parity |
| CJK | 不明显退化 |
| scanned detection | 必须 |
| image rasterization | VLM 需要 |
| Node/Windows/Arch | 都可安装 |
| cancellation | 可治理 |
| production packaging | 不要求额外 Python runtime |

### P5-08B：正式迁移

迁移：

```text
extract_pdf_tables
extract_pdf_metadata
extract_chart_data_vlm
```

#### PDF Tool

输出继续进入：

```text
task/parsed/
```

并包含 warning。

扫描 PDF 不允许 silent success；若没有文本表格且有图像，应明确提示走 VLM。

#### VLM Tool

保持三层降级：

```text
L1 Qwen-VL
L2 PDF table extraction
L3 caption text
```

若全部失败：

```text
error
!= empty success
```

保持：

- strict JSON parse；
- markdown fence tolerance；
- trailing text tolerance；
- required keys；
- source sha provenance；
- `parsed/chart_data/chart_data.csv`；
- `parsed/chart_data/chart_data_points.csv`；
- PDF image count cap；
- 不默认新增 OCR。

### 模型调用

VLM credential/config 应复用 TS Model Settings / server-side credential store，不再经过 Python `agent_loop.vl_model`。

### 验收

Pi path 中 PDF/VLM 不需要 Python 解释器。

---

## Checkpoint P5-09：统计与绘图

### 目标

迁移：

```text
run_differential_expression
generate_heatmap
basic_statistics
generate_correlation_matrix
```

### 第一步：冻结数学行为

先从 `stats.py` 提取真正使用的统计语义，建立 numeric fixtures。

至少包括：

- gene column autodetect；
- numeric column selection；
- missing value；
- log2FC；
- Welch two-sided t-test；
- group size < 2；
- zero variance；
- BH FDR；
- top_n；
- significance threshold；
- basic stats；
- correlation；
- heatmap matrix。

### Welch t-test

TS 实现必须与 SciPy 当前行为在约定 tolerance 内一致。不要换成 Student t-test。

### BH

BH correction 必须在**全量 p-value**上执行后再截取 top_n，且保持输入顺序映射。

### 绘图

绘图库选择单独 spike。原则：

- 不需要像素级复刻 Matplotlib；
- 图上表达的数值、阈值、series、labels 必须一致；
- 输出必须可在 Windows/Arch 运行；
- 不允许为画图继续常驻 Python。

### 输出路径

按 P5-D5 改到受控 staging/promotion，不再让 Agent Tool 直接写 `artifacts/`。

建议：

```text
staging/analysis/<run_id>/
├── differential_expression.json
├── volcano_plot.png
├── heatmap.png
└── correlation.csv
```

随后由 trusted application artifact publisher 提升。

### 验收

数值 parity 通过后，才可把 SciPy/matplotlib/seaborn 标记为 Phase 8 可删除依赖。

---

## Checkpoint P5-10：Local Cache + DB Bridge 前置

### 目标

让 Pi Tool 可使用缓存，但不把 SQLite/FTS5 迁移风险塞入 Phase 5 主体。

### 建议 DB bridge operations

```text
cache.search
cache.describe
cache.get
cache.put
cache.list
```

如果用户数据库 manifest 仍存 Python：

```text
database.list
database.get
database.save
database.delete
database.set_enabled
```

禁止：

```text
sql.exec
db.raw_query
```

### 协议

建议尽早采用最终协议形态：

```json
{"version":"1","id":"req_1","op":"cache.search","args":{"query":"TP53","limit":10}}
{"version":"1","id":"req_1","ok":true,"data":[...]}
```

TS 侧：

```text
server/src/persistence/db-client.ts
```

Python 侧：

```text
database/bridge.py
```

若一次迁出当前 cache store 风险过大，可先从现有 Python store 抽出 named-op facade，再逐步搬文件；但 TS 产品路径不能 import 或调用 Python Tool 模块。

### Tool parity

保持：

```text
search_local_cache
describe_local_cache
get_cache_dataset
```

以及 22 列 long-format schema、`max_rows`、truncated 字段。

### 验收

local cache 成为“DB bridge 能力”，而不是 Phase 5 业务 Python 残留。

---

## Checkpoint P5-11：用户声明式数据库 TS 化

### 目标

迁移 `app/databases/declarative.py` 的 HTTP 执行职责。

### TS manifest

保持当前主要规则：

```text
schema_version = 1.0
operation name: ^[a-z][a-z0-9_]*$
authority 不允许 placeholder
URL 不允许 credential
timeout <= 120s
Python requirements 必须为空
operation name 唯一
```

### Render

- URL path placeholder percent-encode；
- query/header/body 递归 render；
- header name 固定；
- header value CR/LF 拒绝。

### HTTP

- public URL policy；
- redirect 每跳校验；
- credentialed HTTPS；
- max response 10 MiB；
- JSON parse；
- extract path。

### Secrets

API 响应仍必须 redact；

客户端永远拿不到 secret value。

### HIL

实现 P5-D9 durable approval：

```text
credentialed tool start
→ approval_requested event
→ run waiting
→ user approve/reject
→ resume
```

批准后只对**本次 tool invocation**释放 secret，不长期暴露给模型 context。

### 验收

用户数据库 operation 能成为 Pi customTool；disabled database 不注册；credential 流程不降级。

---

## Checkpoint P5-12：正式 Pi Runtime 业务 Tool 全量接线

### 当前问题

`server/src/runtime/phase3-composition.ts` 当前只注册：

```text
workspace tools
dataset build bridge tools
```

这意味着 Phase 2 的 Skill 内容虽然已存在，正式 Pi Runtime 并没有对应完整业务工具。

### 目标

构造统一：

```ts
createBusinessToolBundle(context)
```

输入建议包含：

```text
taskId
runId
piSessionId
workspace
database settings
db client
network services
browser pool
model settings
event sink
```

输出：

```text
BioMedAgentTool[]
```

### 注册规则

最终工具集合：

```text
Workspace Tools
+ enabled curated business tools
+ enabled user declarative database tools
+ DatasetBuild Tools
```

必须保证：

- 无重名；
- curated name 与 `SKILL_TOOL_MAP` 对齐；
- disabled database 不注册对应 Tool；
- user Tool 与 builtin 冲突时 fail/skip 规则明确且测试固定；
- Pi 类型仍只在 adapter 层；
- experimental Pi 与 formal Pi 使用同一业务实现，不复制两套。

### Tool-map 测试

增加一项强验收：

```text
expected registered business tool names
==
SKILL_TOOL_NAMES
- explicitly unavailable tools
+ enabled dynamic user tools
```

Phase 5 完成时，`explicitly unavailable tools` 必须为空；若某 Tool 保留为 product-disabled，需从 map/Skill 一并移除或明确 capability gate。

---

## Checkpoint P5-13：Pi 路径 Python 依赖隔离

### 目标

证明：

```text
AGENT_RUNTIME=pi
```

时业务 Tool 不调用 Python acquisition/parsing/analysis。

### 方法

增加静态与运行时双门禁。

#### 静态

TS business tool 目录禁止：

- 调 legacy HTTP endpoint 执行业务 Tool；
- spawn `python`；
- import legacy client；
- `DatasetCoreClient` 除外，直到 M2；
- 任意 skill-op loopback bridge。

#### 运行时

测试启动 Pi runtime 时：

- 故意令 legacy external endpoint 不可用；
- 所有业务 fixture Tool 仍正常；
- 仅 `DATASET_CORE=python` 时 DatasetBuild bridge 需要 legacy core。

### 文档状态

达到这里后可将 `docs/TODO.md` Phase 5 改为：

```text
✅ 完成
```

但应保留一行说明：

```text
legacy Python runtime 仍保留作 Phase 7 前回滚；物理删除属 Phase 8。
```

---

# 9. M2：Phase 4 TS Core 运行接线与 0–6 集成收口

以下 checkpoint 不属于 Phase 5 原始验收，但建议在宣称“0–6 全部闭环”前完成。

---

## Checkpoint I-01：启用 `DATASET_CORE=ts` profile

### 当前缺口

`DATASET_CORE` 已解析，但合法 profile 不含 `ts`。

### 目标 profile

先只开放：

```text
ts/pi/ts/0
ts/pi/ts/1
```

暂不允许：

```text
ts/legacy/ts/*
```

避免 legacy Agent + TS Core 再造不必要组合。

### 验收

配置测试：

- 合法 profile；
- 非法混搭；
- default 仍是 `ts/legacy/python/1`；
- `DATASET_CORE=ts` 不再只是死配置。

---

## Checkpoint I-02：TS Core Service

建立 Application-facing Core 接口：

```ts
validateDatasetBuildSpec(...)
executeDatasetBuild(...)
cancelDatasetBuild(...)
getBuild(...)
listBuildArtifacts(...)
```

Agent-facing `dataset-build.ts` 只依赖此接口，不关心实现来自：

```text
PythonDatasetCoreAdapter
or
TypeScriptDatasetCore
```

建议：

```text
DatasetCore
├─ PythonDatasetCoreAdapter   # rollback
└─ TypeScriptDatasetCore      # new path
```

不要在 Tool 中到处 `if (DATASET_CORE === ...)`。

---

## Checkpoint I-03：异步 operation、timeout、cancel

当前 executor 为 synchronous port，接入 Host 前补：

- operation runner 可 async；
- per-operation timeout；
- AbortSignal；
- timeout 后记录 typed RuntimeErrorDetail；
- cancellation terminal acknowledgement；
- straggler/late completion 不得覆盖 cancelled result；
- partial output cleanup；
- cancel 与 durable Run 状态一致。

应继续保留 digest/reuse/checkpoint 语义。

---

## Checkpoint I-04：Build Lock

同一：

```text
task_id + build_id
```

不得并发执行两个 publisher。

需要：

- lock acquire；
- stale lock 策略；
- process crash recovery；
- cancel release；
- lock owner metadata；
- Windows 与 POSIX 行为测试。

不能依赖仅 POSIX 可用的 flock 语义。

---

## Checkpoint I-05：Core Event Sink

TS Core operation event 转成稳定 BioMed event：

```text
build_started
operation_started
operation_progress
operation_completed
operation_failed
validation_completed
artifact_published
build_completed
build_failed
build_cancelled
```

经：

```text
TaskRepository
→ append-only EventEnvelope
→ sequence
→ replay/live websocket
```

不能把 Dataset Core 内部 TS type 直接暴露给 frontend。

---

## Checkpoint I-06：DatasetBuild Tool 切换

当前：

```text
Pi Tool
→ DatasetCoreClient
→ private FastAPI bridge
```

改为：

```text
Pi Tool
→ DatasetCore interface
   ├─ DATASET_CORE=python → Python adapter
   └─ DATASET_CORE=ts     → TS core
```

Tool name 保持：

```text
validate_dataset_build
execute_dataset_build
```

`runId/piSessionId/buildId` 绑定继续保留。

---

## Checkpoint I-07：TS Core E2E parity

对 Phase 0 的四类黄金 fixture：

```text
SUCCESS
PARTIAL_SUCCESS
NO_DATA
FAILED / SPEC_REJECTED
```

比较：

- BuildResult；
- terminal status；
- row count；
- schema version；
- manifest；
- artifact roles；
- validation codes；
- provenance；
- content hashes；
- publication eligibility；
- event sequence；
- restart/resume；
- cancel。

### 验收

`APP_HOST=ts / AGENT_RUNTIME=pi / DATASET_CORE=ts` 可跑完整离线 E2E。

---

# 10. Python 依赖退役策略

不要在 Phase 5 一开始改 `pyproject.toml` 大删依赖。

分三种状态管理：

| 状态 | 含义 |
| --- | --- |
| active | Pi/TS 产品路径仍需要 |
| rollback-only | 仅 legacy profile/tests 需要 |
| removable-phase8 | 新路径与回滚验收均不再需要，等 Phase 8 物理删除 |

Phase 5 结束后预期：

| Python 依赖 | 状态 |
| --- | --- |
| playwright | rollback-only |
| pdfplumber | rollback-only |
| PyPDF2 extra | rollback-only |
| matplotlib | rollback-only |
| scipy | rollback-only |
| seaborn | rollback-only |
| beautifulsoup4 | rollback-only，若 crawler 全迁 |
| httpx | rollback-only / DB bridge 若仍需要则 active |
| fastapi | active rollback runtime，Phase 7/8 再处理 |
| uvicorn | active rollback runtime |
| openai-agents | active legacy rollback |
| pydantic | legacy/DB bridge 视实现而定 |

真正从 `pyproject.toml` 删除 FastAPI、Playwright、pdfplumber、SciPy 等，是 Phase 8 动作。

---

# 11. 测试体系

Phase 5 不采用“单元测试通过就算迁完”。

建议四层。

## 11.1 Contract / fixture parity

每个 Tool：

```text
same fixture input
→ Python reference
→ normalized result

same fixture input
→ TS implementation
→ normalized result
```

比较稳定字段。

对于时间、UUID、temporary path 等非确定字段，使用 normalization，不要弱化核心业务字段。

## 11.2 Security tests

独立：

```text
server/tests/security/
```

覆盖：

- SSRF；
- DNS rebinding/mixed DNS；
- redirect；
- credential leakage；
- path traversal；
- CRLF；
- download size；
- symlink/path escape；
- browser isolation；
- arbitrary JS/command absence；
- secret redaction。

## 11.3 Live smoke

按能力分 marker，不与普通 CI 强绑定：

```text
live:ncbi
live:geo
live:gdc
live:xena
live:pdb
live:pubchem
live:reactome
live:chembl
live:uniprot
live:browser
live:vlm
```

release verification 明确记录日期、endpoint、结果。

fixture test 才是确定性 CI gate，live test 用于证明外部 API 仍兼容。

### 2026-08-14 release verification run

命令（`server/` 目录）：`BIOMED_LIVE_SMOKE=1 pnpm exec vitest run tests/phase5/live-smoke.test.ts`。
CI 永不运行该套件（公开服务会瞬时失败）；本记录是 Phase 5 DoD “外部能力均具备显式 live
smoke”的一次性实跑证据。

| marker | endpoint | 结果 |
| ------ | -------- | ---- |
| live:ncbi | eutils.ncbi.nlm.nih.gov（esearch + esummary） | ✅ 2.3s，返回 PubMed 记录 |
| live:geo | ncbi.nlm.nih.gov/geo（search + describe） | ✅ 1.8s，返回 accession |
| live:gdc | api.gdc.cancer.gov（projects） | ✅ 3.3s，返回 TCGA 记录 |
| live:xena | ucsc xena datahub（hub search） | ✅ 1.4s，返回数据集 |
| live:pdb | data.rcsb.org（search） | ✅ 6.5s，返回结构命中 |
| live:pubchem | pubchem.ncbi.nlm.nih.gov（PUG REST） | ✅ 3.2s，返回化合物 |
| live:reactome | reactome.org content service | ✅ 1.4s，返回通路命中 |
| live:chembl | www.ebi.ac.uk/chembl（REST API） | ✅ 2.1s，返回分子 |
| live:uniprot | rest.uniprot.org（REST API） | ✅ 3.3s，返回蛋白 |
| live:browser | Playwright chromium pool 导航 https://example.com/ | ✅ 4.4s，status 200 |
| live:vlm | dashscope.aliyuncs.com qwen-vl-max（extract_chart_data_vlm） | ⏭ skipped：本机无 `DASHSCOPE_API_KEY`；客户端路径由 fixture tier（vlm.test.ts 假服务器 + 真实 HTTP 客户端）覆盖，配置了凭证的机器上按同一命令实跑即可 |

10 passed / 1 skipped（无凭证）——Phase 5 全部外部能力（含 browser pool、ChEMBL、UniProt）
已实跑验证；VLM 是唯一依赖外部凭证的项。

## 11.4 Integrated E2E

至少：

```text
Pi + business tools + Python Core
Pi + business tools + TS Core
```

分别运行。

在 Phase 7 前 legacy profile 也保留回归：

```text
legacy + Python Core
```

---

# 12. 质量门禁

每个 checkpoint 合并前至少：

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

由于 Phase 8 尚未发生，Python legacy rollback 仍是受支持路径，因此还应保留：

```bash
cd backend
uv run pytest
uv run ruff check app/ tests/ launcher.py
```

如果全量 Python suite 过慢，可以按 PR 跑受影响测试，但 M1/M2 最终验收必须全量跑一次。

live suite 单独记录，不与 fixture CI 混淆。

---

# 13. Feature Flag 与回滚

Phase 5 不新增每个数据源一个永久 feature flag。

允许短期开发开关，但合并 Phase 5 最终结果前应收敛。

长期迁移 flag 继续只使用架构级：

```text
APP_HOST
AGENT_RUNTIME
DATASET_CORE
PI_EXPERIMENTAL
```

推荐迁移期间 profile：

| Profile | 用途 |
| --- | --- |
| `ts/legacy/python` | 当前稳定回滚 |
| `ts/pi/python` | M1：验证 Pi + TS business tools |
| `ts/pi/ts` | M2：验证完整 TS 主路径 |

Phase 7 才决定：

```text
默认 → ts/pi/ts
```

Phase 8 才删除 legacy flag/代码。

---

# 14. PR / 合并顺序

建议分支/PR 顺序如下，前一个 PR 给后一个提供稳定底座：

```text
P5-00 baseline + contract matrix
P5-01 network + acquisition foundation
P5-02 tool registry + deterministic tools
P5-03 NCBI + PubMed
P5-04 GEO
P5-05 GDC + Xena
P5-06 remaining data sources
P5-07 browser + crawler + visual capture
P5-08 PDF + VLM
P5-09 analysis
P5-10 DB bridge + local cache
P5-11 declarative DB + HIL
P5-12 formal Pi business-tool wiring
P5-13 Phase 5 retirement/verification
I-01~I-07 TS Core runtime wiring
DOC final sync
```

不建议并行修改同一底层 network/acquisition 模块。可以在 P5-01 合并后并行开发：

```text
PubMed/GEO
GDC/Xena
research-only sources
PDF spike
analysis spike
```

但各分支都应基于同一个 network foundation。

---

# 15. 每个 PR 的完成模板

每个 Phase 5 PR 描述统一包含：

```text
Scope
- 本 PR 迁移哪些 capability/tool

Python reference
- 原实现文件
- 原测试
- fixture

TS implementation
- 新文件
- Tool names
- contract

Behavior parity
- 保持项
- 明确差异
- 差异为何允许

Security
- URL policy
- credentials
- path policy
- output limit

Tests
- fixture
- parity
- live
- security

Rollback
- 如何回到 legacy path

Deletion/retirement
- 哪些 Python 模块进入 rollback-only
```

这样 Phase 8 删除时可以直接按记录清理，不必重新审计一遍。

---

# 16. 风险与控制

## 16.1 “迁 TS”导致科研数值漂移

最高风险在统计与 GEO parser。

控制：

- numeric fixtures；
- tolerance 明确；
- Python reference 保留到 Phase 8；
- 任何统计方法变化单独决策。

## 16.2 Node HTTP 默认行为弱化 SSRF 防护

控制：

- 自己掌握 DNS/policy；
- redirect 手动处理；
- 不直接 `follow: redirect`；
- mixed-DNS regression test。

## 16.3 Browser 绕过 HTTP policy

控制：

- 浏览器请求走专用 egress enforcement；
- context 级 allowlist；
- HTTPS/443；
- request interception + proxy 双层；
- 不只在首次 `page.goto()` 检查 URL。

## 16.4 PDF 换库后覆盖率下降

控制：

- spike；
- fixture corpus；
- 明确 warning；
- no silent empty；
- VLM fallback；
- CJK fixture。

## 16.5 Analysis 继续绕过 Publication Gate

控制：

- P5-D5 先决策；
- workspace path policy 测试；
- Analysis Tool 无 `artifacts/` 写权限；
- promotion 单独 trusted service。

## 16.6 为 HIL 重建旧 Subagent 架构

控制：

- 只建 minimal durable approval primitive；
- 不迁 SubagentSupervisor；
- approval 与 Run/EventStore 绑定。

## 16.7 Phase 5 过大导致长期分叉

控制：

- 小 checkpoint；
- 每个 source 可独立合并；
- stable tool map 不改名；
- shared foundation 先合并。

---

# 17. 最终验收清单

> 状态更新：2026-08-14 与 `fix/m2-final-closure` 一并收口。此前清单从未勾选，但实际
> 完成度已随 PR #1（`de58044`，CI 全绿）达到；本轮补上最后三项实质性缺口：真实 Core
> operation 的可抢占 wall-clock timeout/cancel（`core-preemption.test.ts`）、live smoke
> 实跑记录（§11.3）、PARTIAL_SUCCESS 的 Adapter 层断言（ts-core-e2e）。
>
> 第二轮审计收口（2026-08-16，`fix/m2-audit-fixes`）：正式 composition 默认启用 120 s
> operation timeout；timeout/cancel 后 straggler 有界 grace 等待（build lock 持有至真正
> settle）；publish 各 copy 后 / publication.json 写后 / rename 前 abort 检查；canonicalize /
> integrate 按 processed 行 checkpoint（全 rejected / 全 dedup 极端负载可中断，
> `straggler-safety.test.ts` 三个回归测试均验证过“无修复必失败”）；workspace 测试
> `waitForJson` 消除 pids.json 半写竞态；`delimitedRowsWithLinesAsync` 修复 O(n²) 行扫描
> （200k 行 8.1s → 0.12s）。

## M1 — Phase 5

- [x] Phase 5 baseline/migration matrix 完整。
- [x] Reactome `pipeline_supported` 语义已对齐。
- [x] TS network security foundation 完成。
- [x] TS acquisition service 完成。
- [x] `analyze_papers` 完成。
- [x] research guidance Tool 完成。
- [x] NCBI client 完成。
- [x] PubMed Tool 完成。
- [x] GEO Tool 完成。
- [x] GEO Dataset parser 完成。
- [x] GDC Tool 完成。
- [x] Xena Tool 完成。
- [x] ChEMBL Tool 完成。
- [x] UniProt Tool 完成。
- [x] PDB Tool 完成。
- [x] PubChem Tool 完成。
- [x] Reactome Tool 完成。
- [x] Node Playwright pool 完成。
- [x] browser fallback 完成。
- [x] crawler 完成。
- [x] web visual capture 完成。
- [x] PDF 技术选型记录完成。
- [x] PDF table/meta Tool 完成。
- [x] VLM chart Tool 完成。
- [x] Analysis numeric parity 完成。
- [x] Analysis plot path 完成且不绕过 Publication boundary。
- [x] DB bridge named operations 完成。
- [x] local cache Tool 完成。
- [x] declarative user DB HTTP Tool 完成。
- [x] credential HIL parity 完成。
- [x] formal Pi runtime 注册完整业务 Tool。
- [x] disabled DB/Tool 规则生效。
- [x] `SKILL_TOOL_MAP` 与运行时工具集合一致。
- [x] Pi path 无 Python acquisition/parsing/analysis 调用。
- [x] fixture suite 全绿。
- [x] security suite 全绿。
- [x] live smoke 已记录（§11.3，2026-08-14 实跑 10/11）。
- [x] legacy rollback suite 全绿。
- [x] `docs/TODO.md` Phase 5 可标记完成。

## M2 — Phase 0–6 集成收口

- [x] `ts/pi/ts` 成为合法 opt-in profile。
- [x] DatasetCore interface 完成。
- [x] TS Core service 完成。
- [x] operation async/timeout 完成（Executor + 真实 Core 全链路协作式异步化，
      `core-preemption.test.ts` 验证真实 adapter parse 可被 wall-clock timeout / cancel 中断）。
- [x] cancel terminal ack 完成。
- [x] build lock 完成。
- [x] event sink 完成。
- [x] DatasetBuild Tool 可切 TS/Python Core。
- [x] SUCCESS fixture 通过。
- [x] PARTIAL_SUCCESS fixture 通过（含 Adapter 层 `build_result.status === "partial_success"` 断言）。
- [x] NO_DATA fixture 通过。
- [x] FAILED/SPEC_REJECTED fixture 通过。
- [x] restart/resume 通过（runtime-parity resumeFrom 覆盖）。
- [x] artifact publication 不变量通过。
- [x] `ts/pi/python` 回滚通过。
- [x] `ts/legacy/python` 回滚通过。
- [x] 默认 profile 未提前改变。
- [x] 可以在文档中明确写“Phase 0–6 均完成；Phase 7 下一步”。

---

# 18. 文档同步

M1 后至少同步：

```text
docs/TODO.md
docs/BioMed-QAgent_Pi_Migration_Plan.md
docs/ARCHITECTURE.md
docs/AGENTS.md / AGENTS.md
docs/DEVELOPER_QUICKSTART.md
docs/migration/README.md
README.md
```

M2 后再补：

- `DATASET_CORE=ts` profile；
- TS Core runtime topology；
- rollback matrix；
- `pnpm dev` 当前启动流程；
- Python bridge 边界；
- Phase 7 前置条件。

当前 README/迁移状态容易滞后于 TODO，因此最终状态同步应作为 merge gate，而不是“有空再改”。

---

# 19. 推荐的新 TS 目录形态

以下仅作为实施布局建议，可按现有项目风格调整：

```text
server/src/
├── agent/
│   ├── tools/
│   │   ├── business-tools.ts
│   │   ├── pubmed.ts
│   │   ├── geo.ts
│   │   ├── gdc.ts
│   │   ├── xena.ts
│   │   ├── pdb.ts
│   │   ├── pubchem.ts
│   │   ├── reactome.ts
│   │   ├── chembl.ts
│   │   ├── uniprot.ts
│   │   ├── browser.ts
│   │   ├── web-visual-capture.ts
│   │   ├── local-cache.ts
│   │   ├── pdf.ts
│   │   ├── analysis.ts
│   │   └── dataset-build.ts
│   └── skills/
│       └── skill-tool-map.ts
│
├── external/
│   ├── network/
│   ├── acquisition/
│   ├── ncbi/
│   ├── browser/
│   ├── crawler/
│   ├── gdc/
│   ├── xena/
│   ├── pdb/
│   ├── pubchem/
│   └── reactome/
│
├── processing/
│   ├── pdf/
│   └── vlm/
│
├── analysis/
│
├── databases/
│   ├── manifest.ts
│   ├── declarative-http.ts
│   └── store-adapter.ts
│
├── persistence/
│   └── db-client.ts
│
└── dataset/
    ├── adapters/
    │   └── geo/
    └── runtime/
```

原则比具体目录名重要：

- Agent Tool adapter 薄；
- HTTP/browser client 不藏在 Tool 里；
- Dataset parser 不藏在 Skill 里；
- DB access 不藏在 Agent Tool 里；
- Pi 类型不扩散到业务模块；
- security policy 只有一套底层实现。

---

# 20. 最终迁移路径

按本计划完成后，剩余主线应非常清晰：

```text
当前
0/1/2/3/4/6 done
5 missing
TS Core not wired

        ↓

M1
Phase 5 done
Pi + TS business capabilities complete
Python external/scientific logic leaves Pi path

        ↓

M2
TS Core opt-in fully wired
0–6 integrated closure

        ↓

Phase 7
default frontend/product traffic → ts/pi/ts
FastAPI default off
full E2E release compatibility

        ↓

Phase 8
delete legacy Python runtime
retain only database bridge
remove rollback-only Python dependencies
```

本轮最重要的验收不是“TS 文件数量增加”，而是形成一条可以实际运行、可以通过 fixture 证明、可以回滚的边界：

```text
Pi
→ TS Tool
→ TS External Capability / TS Dataset Core
→ trusted publication

Python
→ only DB bridge in target architecture
```

在这条边界稳定之前，不建议提前进入 Phase 7 默认切换。
