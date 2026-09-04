# BioMed-QAgent 多人 AI 审计与测试执行手册

> 版本：`v1.0`  
> 适用基线：Phase 0–8 完成后的 TS Host + Pi + TS Dataset Core 架构  
> 编写日期：2026-08-15  
> 目标：把一次“项目重构完成后的全面复核”拆成可并行、可复现、可验收的审计任务。

本文件不是产品说明书，也不是单纯的回归测试清单。每个模块都要求审计人同时检查：

1. 代码是否符合当前架构边界；
2. 自动化测试是否真正覆盖关键不变量；
3. 异常、并发、重启、恶意输入下是否安全；
4. 文档、事件、审计产物是否足以证明结果可复现。

如果代码与历史迁移文档冲突，以当前代码、`docs/ARCHITECTURE.md`、`packages/contracts/` 中的契约和本文件列出的“当前边界”为准。迁移文档中的旧路径只能作为历史证据，不能当作当前运行方式。

---

## 1. 当前审计边界

### 1.1 正式运行拓扑

```text
Browser / API Client
        |
        v
TypeScript Application Host
  - Vite middleware / static hosting
  - /api/v1/* HTTP
  - /api/v1/ws durable event stream
  - Task / Run / Event repository
  - Pi adapter
  - TS Dataset Core
  - TS product / settings / cache APIs
        |
        +--> Pi Main Agent (.pi/skills, governed workspace, tool registry)
        +--> TS Dataset Core (deterministic validate/execute/cancel)
        +--> TS DatabaseClient --JSONL named operations--> database/bridge.py
```

### 1.2 明确禁止的回归

下列内容不得重新进入 active runtime：

- `backend/` Python Runtime、FastAPI、Uvicorn、Python Dataset Core；
- `/experimental/pi/*` 正式入口；
- `APP_HOST`、`AGENT_RUNTIME`、`DATASET_CORE`、`PI_EXPERIMENTAL` 等已退役 runtime flags；
- Pi 业务工具直接 spawn Python、直接调用 legacy endpoint 或直接写持久化产物；
- Agent 直接写 `artifacts/`、publication 或绕过 Dataset Core Publisher；
- 任意 raw SQL / 任意 SQL endpoint；
- 把文档中的历史路径误当成可执行依赖。

### 1.3 核心不变量

- 单一浏览器端口由 TS Host 所有；正常启动使用 `pnpm dev`，生产使用 `pnpm start`。
- Task → Run → Event 为 durable event-sourced 状态链；每个 Task 同时最多一个 active Run。
- `events.jsonl` append-only；sequence 单调递增；重放后状态与实时状态一致。
- `/api/v1/ws` 先 replay、后 live；断线可用 `after_sequence` 补齐。
- DatasetBuild 必须经过 schema、兼容性、validation gate 和 Publisher；失败不得留下伪成功 publication。
- 一个 Build 只有一个 primary dataset；其他产物必须有明确 Artifact Role。
- Source provenance、输入 hash、下载尝试、拒绝记录、warning 和 manifest digest 可追溯。
- Python 仅是按需启动的 stdlib DB bridge；协议为 JSONL named-op，EOF 后干净退出。
- API key 等敏感设置只能 masked 返回，不能进入日志、事件、错误或前端状态。

---

## 2. 分工方式与交付规则

### 2.1 推荐分组

每个模块安排 1 名主审计人 + 1 名复核人。高风险模块（运行时、Dataset Core、外部网络、发布与安全）必须双人复核。

| 组别 | 建议模块 | 主要产物 |
| --- | --- | --- |
| A 架构与退役 | M01、M02 | 架构边界扫描、依赖清单 |
| B 合约与数据 | M03、M06、M07 | contract/schema/provenance 报告 |
| C Runtime | M04、M05、M11 | Task/Run/WS/并发/恢复报告 |
| D 外部能力与持久化 | M08、M09、M10 | 网络、DB bridge、模型安全报告 |
| E 前端与发布 | M12、M13 | UI/E2E/包交付报告 |
| F 独立红队 | M14、M15 | 对抗性测试、最终风险汇总 |

### 2.2 每个模块必须提交的证据包

每个模块新建一个结果目录，例如：

```text
audit-results/2026-08-15/M04-runtime/
  README.md                 # 范围、环境、结论
  commands.txt              # 执行过的命令及时间
  test-matrix.md            # TC 编号、结果、失败归因
  logs/                     # 脱敏后的终端/服务日志
  screenshots/              # 仅 UI/浏览器相关模块需要
  traces/                   # events.jsonl、WS 帧、manifest 等
  defects.md                # 缺陷、严重性、复现步骤
```

每条结论必须带：`case_id`、提交 SHA、运行日期、环境（Node/pnpm/Python/OS）、输入 fixture、预期、实际、证据文件。

### 2.3 严重性定义

- **P0 阻断**：数据丢失、错误发布、越权/密钥泄露、任务状态不可恢复、生产无法启动。
- **P1 严重**：核心 API/构建路径错误、并发重复发布、事件丢失、关键校验可绕过。
- **P2 一般**：边界输入错误、降级行为不一致、可观测性不足、文档与代码偏差。
- **P3 改进**：可用性、提示文案、低风险性能或测试缺口。

缺陷报告必须说明：是否可稳定复现、最小输入、影响面、是否跨模块、建议回归用例。

### 2.4 结果状态

每个测试用例只能使用：`PASS`、`FAIL`、`BLOCKED`、`NOT_RUN`。`BLOCKED` 必须写明阻塞条件，不得把未执行伪装成通过。

---

## 3. 所有人先执行的公共预检

### PRE-01 环境与工作区

```powershell
node --version
pnpm --version
git status --short
git rev-parse HEAD
pnpm install --frozen-lockfile
uv sync --frozen
```

通过标准：Node 满足 `>=22.19.0`；pnpm 使用仓库声明版本；lockfile 未被修改；工作区变更已记录。

### PRE-02 全局质量门禁

```powershell
pnpm test
pnpm lint
pnpm typecheck
pnpm build
uv run python database/bridge.py --self-test
uv run pytest database/tests
uv run ruff check database
```

如并行运行导致资源敏感测试超时，按包顺序复跑并记录，不得只报告“全局命令失败”。

### PRE-03 静态退役扫描

```powershell
git ls-files backend
rg -n "AGENT_RUNTIME|DATASET_CORE|APP_HOST|PI_EXPERIMENTAL|LEGACY_BACKEND|PI_DATASET_BRIDGE_SECRET|createLegacyBackend|uvicorn|/experimental/pi" server/src frontend/src packages scripts package.json .env.example .github
```

通过标准：`backend` 无 tracked 文件；active source 不含退役实现或运行时引用。历史文档命中必须逐条标记为“文档历史引用”，不能直接算缺陷。

### PRE-04 启动 smoke

1. 终端 A 执行 `pnpm dev`，记录实际监听地址和进程树。
2. 终端 B 检查：

```powershell
curl.exe -i http://127.0.0.1:5173/api/v1/health
curl.exe -i http://127.0.0.1:5173/
curl.exe -i http://127.0.0.1:5173/api/v1/databases
```

3. 终止 Host，确认 DB bridge 收到 EOF 并退出，无孤儿 Python Web Server。
4. 执行 `pnpm build` 后用 `pnpm start` 重复 health、root、SPA fallback、databases smoke。

---

## 4. 模块任务卡

以下模块可独立分派。每张任务卡包含范围、重点、测试用例和完成标准。审计人可增加用例，但不得删除 P0/P1 用例。

## M01 架构边界与 Python Runtime 退役审计

**目标**：证明 Phase 8 后没有 legacy runtime 偷渡回正式路径。

**重点路径**：`server/src/`、`frontend/src/`、`packages/`、`database/`、`package.json`、`.github/`、`.env.example`。

**测试用例**：

- `M01-T01`：`git ls-files backend` 为空。
- `M01-T02`：扫描 active source，不得出现 FastAPI/Uvicorn/Python Runtime spawn、legacy proxy、退役 flags。
- `M01-T03`：扫描 package scripts，不得有 `dev:legacy-*`、rollback-only 启动入口。
- `M01-T04`：确认 Python import 仅位于 `database/`；数据库 forbidden-import 测试通过。
- `M01-T05`：Pi 业务工具静态检查，不得 import legacy client 或调用 Python subprocess。
- `M01-T06`：启动 `pnpm dev`，观察进程树；必须只有 TS Host/Pi 相关进程和按需 DB bridge，不得启动 Python HTTP server。
- `M01-T07`：启动 `pnpm start`，确认生产包不依赖源码目录、Vite dev server 或 backend 目录。
- `M01-T08`：对历史文档命中逐条归类，确认不会被构建/运行时读取。

**通过标准**：所有退役边界为零误报、零 active 引用；启动与构建均不依赖 legacy 目录。

## M02 Workspace、Pi Adapter 与工具权限审计

**目标**：验证 Agent 能力受 workspace、工具注册和执行门禁约束。

**重点路径**：`server/src/agent/pi-adapter.ts`、`server/src/agent/skills/`、`.pi/skills/`、workspace policy、tool registry。

**测试用例**：

- `M02-T01`：Pi 只能通过 adapter 使用模型、workspace、工具；业务代码不得依赖 Pi 内部类型。
- `M02-T02`：读取文件、写文件、edit、exec 的允许路径边界测试；尝试 `..`、绝对路径、符号链接逃逸、workspace 外路径。
- `M02-T03`：`WORKSPACE_DEV_EXEC` 未开启时执行命令必须 fail closed；开启时仍需审计记录。
- `M02-T04`：工具参数深度、字符串长度、列表长度截断符合事件协议；不得因恶意大参数撑爆日志。
- `M02-T05`：Skill 缺失、SKILL.md 格式错误、工具映射缺失时，Agent 失败可解释且 Runtime 不崩溃。
- `M02-T06`：Agent 不能直接创建 publication、写 artifacts 或绕过 Dataset Core。
- `M02-T07`：多轮 task 中 session、task、run、build 身份不串线。
- `M02-T08`：max turns、取消、异常工具返回后，最终 run 状态和审计事件完整。

**红队输入**：路径穿越、超长 UTF-8、控制字符、伪造工具名、重复 tool call、工具返回恶意 JSON。

## M03 Contracts、Schema Registry 与 wire DTO 审计

**目标**：验证跨包契约是唯一、稳定、可演进的边界。

**重点路径**：`packages/contracts/`、`server/src/contracts/`、DatasetBuildSpec、EventEnvelope、Manifest、ValidationResult。

**测试用例**：

- `M03-T01`：contracts build 与 tests 通过；server/frontend 使用同一 wire DTO。
- `M03-T02`：必填字段缺失、未知字段、错误枚举、错误类型、空字符串、超长字段均得到明确拒绝。
- `M03-T03`：事件 envelope 的 `sequence`、`task_id`、`run_id`、时间戳、payload 类型校验。
- `M03-T04`：`tool_started.arguments` 可选且向后兼容；旧 events.jsonl 无 arguments 仍可 replay。
- `M03-T05`：operation_* 事件字段完整；旧 stage_* 历史事件只用于 replay，不被新 emitter 产生。
- `M03-T06`：DatasetBuildSpec 中 family、row_granularity、key、measurement、schema、source binding 组合校验。
- `M03-T07`：Manifest digest 改变任一关键字段时必须变化；字段顺序或稳定序列化不得造成非确定性。
- `M03-T08`：契约版本新增可选字段时旧客户端可读；删除/重命名字段必须有失败行为和迁移说明。

**通过标准**：契约测试、序列化 round-trip、错误输入测试全部通过；无重复 DTO 定义。

## M04 Durable Task/Run/Event Runtime 审计

**目标**：验证任务状态机、事件持久化、reducer、重启恢复和终止语义。

**重点路径**：`server/src/runtime/`、TaskRepository、reducer、event store、run manager。

**测试用例**：

- `M04-T01`：创建 task 后按 `run_queued → run_started → ... → run_completed/failed/cancelled` 产生合法事件。
- `M04-T02`：同一 Task 并发提交两个 run；第二个必须排队、拒绝或得到明确冲突，不得双 active。
- `M04-T03`：`request-id` 幂等：重复 POST 不产生重复 run 或重复 publication。
- `M04-T04`：进程在 run_started、tool_started、operation_progress、publish 前后分别崩溃，重启后状态可重建。
- `M04-T05`：events.jsonl 损坏、尾部半行、未知事件、sequence 缺口时，服务 fail closed 或给出可操作错误，不静默篡改。
- `M04-T06`：取消 queued、running、finalizing、terminal run；取消请求和 terminal acknowledgement 顺序正确。
- `M04-T07`：resume 仅对合法 HIL paused run 生效；错误 run、重复 resume、过期决策必须拒绝。
- `M04-T08`：compact 后 conversation_compacted 事件、消息分页和 reducer 状态一致。
- `M04-T09`：删除 task 只允许 terminal task；删除后 artifacts/events 访问行为符合 API 约定。
- `M04-T10`：事件写入失败时不得向客户端报告虚假的成功。

**必须保存**：完整事件序列、重启前后 snapshot、请求 ID、最终 HTTP 响应。

## M05 WebSocket Replay/Live 与断线恢复审计

**目标**：验证 `/api/v1/ws` 协议在实时、重连、多个订阅和异常帧下正确。

**测试用例**：

- `M05-T01`：subscribe `after_sequence=0`，收到严格递增 replay。
- `M05-T02`：订阅到最新 sequence 后产生新事件，确认只收到 live 增量且不重复。
- `M05-T03`：客户端断线；先调用 events API 补齐，再重连订阅，最终 sequence 连续。
- `M05-T04`：同时订阅两个 task，事件不得串 task；unsubscribe 后不得继续推送。
- `M05-T05`：ping/pong、未知 command、缺失 task_id、非法 after_sequence 返回明确控制帧。
- `M05-T06`：服务端事件流慢消费者、连接突然关闭、重复 subscribe 的资源回收。
- `M05-T07`：tool output 4KB 截断、arguments 深度截断在 WS 与 HTTP replay 中一致。
- `M05-T08`：大量事件下 sequence、排序、背压和内存使用可接受。

## M06 TS Dataset Core 确定性构建审计

**目标**：证明 validate/execute/cancel 的业务结果、失败语义和 golden parity 稳定。

**重点路径**：`server/src/dataset/`、`server/tests/*parity*`、`server/tests/phase5/`、golden fixtures。

**四类基线**：`SUCCESS`、`PARTIAL_SUCCESS`、`NO_DATA`、`SPEC_REJECTED/FAILED`。

**测试用例**：

- `M06-T01`：同一输入、同一 schema/profile 重复构建，manifest、artifact hash、validation 摘要完全一致。
- `M06-T02`：缺 schema、缺 required field、family/granularity 不兼容、非法 merge strategy 应在执行前拒绝。
- `M06-T03`：单源成功、多源部分失败、全部无数据、解析器异常分别映射正确 BuildResult。
- `M06-T04`：重复记录、冲突主键、单位不一致、count/TPM 语义混用、空值、非法数值。
- `M06-T05`：canonicalize/integrate 大输入分批处理；中断后 checkpoint 不重复或丢失记录。
- `M06-T06`：timeout、AbortSignal、cancelDatasetBuild 的 preemption；straggler 不得在取消后继续 publish。
- `M06-T07`：build lock 并发竞争；fenced lease、owner token、失锁后 publish 必须失败。
- `M06-T08`：Publisher 只接受通过 gate 的结果；失败构建不产生 publication 或伪造 current_publication_id。
- `M06-T09`：artifact 只由 Publisher 生成，文件 hash/size/path 校验防止越界读取。
- `M06-T10`：TS 与 golden baseline parity；差异必须逐字段解释，不能只比“成功/失败”。

## M07 数据质量、兼容性、Provenance 与 Publication 审计

**目标**：验证数据语义不被“看似能合并”的输入污染。

**测试用例**：

- `M07-T01`：表达数据、突变事件、临床样本、文献元数据、通路成员等不同 family 不得直接合并。
- `M07-T02`：row granularity 结构化比较：实体、measurement、时间/条件维度全部显式。
- `M07-T03`：主键、外键、ontology、单位和词表一致性；自动映射不确定时只能进入 proposed/warning。
- `M07-T04`：拒绝记录包含来源、行号/键、原因、可操作修复建议；warning 不得静默丢弃。
- `M07-T05`：SourceAsset、DownloadAttempt、adapter/parser/profile、字段映射、转换链进入 provenance。
- `M07-T06`：primary/supporting/schema/provenance/audit_report 五类 Artifact Role 正确且不互相冒充。
- `M07-T07`：manifest 通过唯一主数据入口识别，不依赖 `main_data.csv`、`dataset.csv` 等硬编码文件名。
- `M07-T08`：发布 supersedes 关系、publication digest、published_at、validation ref 可追溯。
- `M07-T09`：任一源文件内容变化、schema 版本变化、profile 变化都能触发正确 digest/重建。

## M08 外部获取、网络安全与 Browser/PDF 审计

**目标**：验证外部数据获取既可复现又不成为 SSRF、资源耗尽或脏数据入口。

**重点路径**：`server/src/external/network/`、`acquisition/`、browser pool、crawler、PDF/table handlers。

**测试用例**：

- `M08-T01`：DNS 解析、地址钉扎、每次 redirect 重新校验；阻止 loopback、内网、metadata service 和私有网段。
- `M08-T02`：HTTPS/证书/不支持协议、超时、重试、最大响应体、最大重定向次数。
- `M08-T03`：Content-Type、magic bytes、压缩炸弹、畸形 XML/JSON/CSV、超长 header。
- `M08-T04`：下载中断、hash 不匹配、部分文件、重复下载、cache 命中/失效和清理。
- `M08-T05`：Browser 页面导航、弹窗、跨域 iframe、无限滚动、下载文件、页面截图资源回收。
- `M08-T06`：PDF 文本/表格/图片提取的 fixture golden parity；损坏 PDF 不得使 Host 崩溃。
- `M08-T07`：外部服务返回恶意 HTML/脚本/超长文本，不能直接注入前端或日志。
- `M08-T08`：fixture 模式不得偷偷访问 live 网络；live 模式必须显式标记并保留来源 URL、时间和 hash。

## M09 Python DB Bridge、Cache 与 Declarative Database 审计

**目标**：证明 Python 边界小而稳定、协议可恢复、缓存不会产生半发布状态。

**重点路径**：`database/bridge.py`、`database/cache_store.py`、`database/database_store.py`、`database/declarative.py`、`server/src/persistence/db-client.ts`。

**测试用例**：

- `M09-T01`：`ping`、`cache.*`、`database.*` named-op 请求/响应、错误码和 request id。
- `M09-T02`：非法 JSON、未知 op、版本不匹配、缺 args、超大请求、重复 id、bridge EOF。
- `M09-T03`：bridge 异常退出/被杀后，TS client 超时、重试、错误映射和重启行为。
- `M09-T04`：禁止 raw SQL；参数注入、路径注入、manifest 注入全部被拒绝。
- `M09-T05`：schema-neutral cache 新记录、旧无 columns 记录、CSV header 兼容读取。
- `M09-T06`：cache commit 原子性故障注入：manifest 替换失败、数据替换失败、磁盘满、进程崩溃；`.tmp/.bak` 恢复策略正确。
- `M09-T07`：数据库 manifest CRUD、enable/disable、delete、重复名称、保留内置数据库事实。
- `M09-T08`：并发 commit/search/list；无半记录、无越权读取、排序稳定。
- `M09-T09`：运行 `uv run pytest database/tests`、ruff、self-test，并核对测试数量与实际输出。

## M10 Settings、Model Registry 与敏感信息审计

**目标**：验证模型设置可用、可迁移且不会泄露凭据。

**测试用例**：

- `M10-T01`：GET settings 只返回 masked credentials；PUT 后重启仍能恢复非敏感配置。
- `M10-T02`：provider、custom OpenAI-compatible endpoint、model id、temperature/max tokens 等参数透传正确。
- `M10-T03`：非法 URL、空 key、超长 key、错误 provider、重复模型、未知字段。
- `M10-T04`：API key 不进入 HTTP access log、Pi 事件、tool arguments、错误堆栈、前端 localStorage 或截图。
- `M10-T05`：旧 `model.json` 一次性只读迁移不 spawn Python；迁移失败可解释且不破坏新设置。
- `M10-T06`：并发 PUT、请求幂等、部分失败、进程重启和文件权限。
- `M10-T07`：model discovery 成功、provider 不可达、限流、超时、返回恶意模型列表。

## M11 HTTP Product API 与授权/输入验证审计

**目标**：逐路由验证状态码、DTO、边界、错误格式、文件访问与任务权限。

**覆盖路由**：health、databases CRUD/enable/disable、settings、vendors、models、model-info、tasks/runs/cancel/resume/subagents、messages/events/artifacts、builds、cache。

**通用测试矩阵**：

- 正常请求、缺字段、错误类型、空 body、未知字段、重复请求、超长 query/path/header；
- 未知 task/run/build/artifact/database；
- 错误方法、错误 Content-Type、JSON 污染、Unicode 和路径穿越；
- terminal/active/paused 状态下的允许与拒绝操作；
- 统一错误 shape、不会返回内部堆栈、不会泄露本地路径和凭据。

**重点用例**：

- `M11-T01`：列表分页、limit 上限、after cursor/sequence 边界。
- `M11-T02`：artifact/build download 只允许 manifest 已声明且路径校验通过的文件。
- `M11-T03`：DELETE task 对 active/nonterminal task 拒绝；terminal 删除后历史一致消失。
- `M11-T04`：resume/cancel/subagent cancel 的重复与竞态。
- `M11-T05`：cache export zip 防止路径穿越、符号链接逃逸和超大压缩包。
- `M11-T06`：CORS、Host header、反向代理/静态托管模式下的安全 header 与 SPA fallback。

## M12 Frontend 状态机、页面交互与可访问性审计

**目标**：验证前端只消费正式 TS Host API/WS，并能解释所有 durable 状态。

**重点路径**：`frontend/src/`、runtime transport/controller/reducer、任务页、设置页、数据库页、构建/缓存页。

**测试用例**：

- `M12-T01`：创建 task、多轮对话、工具调用、operation progress、完成/失败/取消的 UI 状态。
- `M12-T02`：WS 断线、自动重连、events replay、重复事件去重、页面刷新后的状态恢复。
- `M12-T03`：PARTIAL_SUCCESS、NO_DATA、SPEC_REJECTED、FAILED 的差异化展示和下一步提示。
- `M12-T04`：artifact 列表、下载、manifest/provenance/audit report 查看。
- `M12-T05`：settings masked key、provider/model discovery、保存失败/恢复。
- `M12-T06`：database builtin 与 user declarative CRUD、enable/disable、HIL approval。
- `M12-T07`：空状态、长文本、超长表格、错误 toast、加载 skeleton、重复点击和键盘操作。
- `M12-T08`：基础可访问性：键盘导航、focus、label、role、对比度、屏幕阅读器可读错误。
- `M12-T09`：浏览器控制台无未处理异常、无退役 `/experimental/pi` 请求、无凭据泄露。

## M13 构建、CI、发布包与 Windows 审计

**目标**：证明 fresh checkout、Windows 和发布 bundle 与开发机行为一致。

**测试用例**：

- `M13-T01`：fresh checkout 执行 `pnpm install --frozen-lockfile`、contracts build、server/frontend build。
- `M13-T02`：`pnpm -r test/lint/typecheck/build` 全绿；记录并行与串行差异。
- `M13-T03`：Windows build-lock、Dataset Core、DB bridge 测试，确认路径、锁、进程终止行为。
- `M13-T04`：release staging 含 `packages/`、tsconfig、frontend/dist、server/dist 和必要静态资产，不含 node_modules、backend、secret。
- `M13-T05`：解压 bundle 到全新目录，安装冻结依赖，`pnpm start` 后 health/root/databases/cache smoke。
- `M13-T06`：SPA fallback、静态资源 MIME、压缩/缓存 header、端口参数和 Ctrl+C 清理。
- `M13-T07`：发布包版本、manifest、source map、许可证和构建产物 hash 可追溯。
- `M13-T08`：CI workflow 不再同步/测试整个 Python backend；database job 仍完整执行。

## M14 性能、并发、资源与故障注入红队

**目标**：主动寻找“功能测试通过但生产会失效”的问题。

**测试维度**：

- 100/1,000/10,000 条记录的 parse、canonicalize、integrate、publish；
- 10/50/100 个并发 task、WS 连接、cache 查询；
- 慢网络、慢 parser、慢 consumer、DB bridge 延迟、磁盘满、句柄耗尽；
- build lock 竞争、崩溃恢复、straggler、重复请求、时钟跳变；
- 大文件、超长单行、深层 JSON、恶意压缩、异常 Unicode。

**必须观察**：CPU、RSS、事件文件大小、临时文件、子进程、打开句柄、响应 p50/p95/p99、任务最终状态。

**通过标准**：无无界内存增长、无永久锁、无孤儿进程、取消后无后台写入、资源最终回收。

## M15 独立端到端业务红队与最终验收

**目标**：不依赖模块作者的测试，模拟真实用户从自然语言到可下载发布物的完整路径。

**场景**：

1. “从多个来源构建 gene-expression dataset”——源发现、获取、解析、规范化、合并、校验、发布、下载。
2. 一个来源超时、一个来源字段不兼容——产生 PARTIAL_SUCCESS，保留 warning/rejected/provenance。
3. 所有来源无数据——NO_DATA，不生成伪 publication。
4. spec 不完整或 family/granularity 不兼容——SPEC_REJECTED，执行前拒绝。
5. 构建中途断网/取消/重启——恢复或终止语义可解释，不能半发布。
6. WS 断线后刷新页面——消息、progress、最终结果和 artifact 列表一致。
7. 用户添加 declarative database，执行需要 credential 的工具，触发 HIL，批准/拒绝/重复 resume。
8. 恶意输入组合：路径穿越 + 超长数据 + 重定向到内网 + 伪造 manifest + 并发提交。

**最终验收**：由不参与实现的审计人复核所有证据，确认 P0/P1 为零，P2 有明确处置；随机抽取至少 10 条结论重跑。

---

## 5. API 与状态覆盖矩阵

| 区域 | 必测成功态 | 必测失败/竞态态 |
| --- | --- | --- |
| health/root | 200、正确 app/runtime 标识、SPA fallback | 未构建静态包、端口占用、错误 Host |
| databases | list/detail/register/update/enable/disable/delete | 重名、非法 manifest、内置项删除、并发更新 |
| settings/models | masked GET、PUT、vendors/models discovery | 错 key、provider 超时、并发覆盖、日志泄密 |
| tasks/runs | create、追加 turn、messages、compact | active run 冲突、幂等重试、非法状态 |
| cancel/resume | queued/running/paused 正常处理 | terminal、重复、失效 decision、重启竞态 |
| events/ws | replay、live、断线补齐、ping/pong | sequence 错误、未知命令、慢连接 |
| builds/artifacts | detail、manifest、download | 未发布、路径逃逸、hash/size 不符 |
| cache | list/detail/artifact/export | 半提交、磁盘满、旧 schema、恶意 zip |

---

## 6. 缺陷报告模板

```markdown
# [P0/P1/P2/P3] <一句话标题>

- 模块：M__
- Case ID：M__-T__
- 发现提交：<git SHA>
- 环境：Windows/Linux, Node, pnpm, Python/uv
- 可复现性：100% / 间歇 / 一次性
- 影响：数据、任务、用户、发布、性能、安全

## 前置条件

## 最小复现步骤

1.
2.
3.

## 预期

## 实际

## 证据

- 日志：
- events.jsonl / WS trace：
- manifest / hash：
- 截图：

## 初步归因

## 建议修复与回归用例
```

---

## 7. 模块结果模板

```markdown
# M__ <模块名> 审计结果

- 审计人：
- 复核人：
- 日期：
- Commit：
- 环境：
- 范围：

## 结论

- 状态：PASS / FAIL / BLOCKED
- P0：0
- P1：0
- P2：0
- P3：0

## 测试矩阵

| Case | 结果 | 证据 | 缺陷 |
| --- | --- | --- | --- |
| M__-T__ | PASS | `traces/...` | - |

## 未覆盖与风险

## 建议进入回归套件的用例
```

---

## 8. 总体验收门槛

项目只有在以下条件同时满足时，才能标记“审计完成”：

- M01–M15 均有结果文件和复核人；
- 公共预检全部通过；
- P0、P1 缺陷为零，或由项目负责人书面接受并标明风险；
- 至少一轮 fresh checkout、Windows、生产 bundle、启动 smoke 完成；
- 至少一轮真实外部 fixture 和一轮纯 fixture 模式完成；
- 至少一次中途取消、进程重启、WS 断线、DB bridge 重启、磁盘/网络故障注入；
- 至少抽查 10 个 publication/manifest/artifact，确认 hash、provenance、validation、下载内容一致；
- 自动化测试新增的回归用例已进入对应包测试目录；
- 文档中的发现、未修复风险、环境陷阱已同步到 `docs/` 或关联任务；
- 最终报告明确区分“代码已验证”“仅静态检查”“未执行/被阻塞”。

最终签字表：

| 角色 | 姓名 | 负责范围 | 结论 | 日期 |
| --- | --- | --- | --- | --- |
| 架构负责人 |  | M01–M03 |  |  |
| Runtime 负责人 |  | M04–M05、M11 |  |  |
| Dataset 负责人 |  | M06–M07 |  |  |
| 外部能力/数据负责人 |  | M08–M09 |  |  |
| 安全负责人 |  | M02、M10、M14–M15 |  |  |
| 前端/发布负责人 |  | M12–M13 |  |  |
| 独立总复核 |  | 全部 |  |  |

---

## 9. 分派时的最小消息格式

将模块交给其他 AI 或工程师时，使用下面格式，避免只说“帮忙测一下”：

```text
[AUDIT ASSIGNMENT]
模块：M__ <名称>
目标：<要证明的不变量>
范围：<目录/接口>
必须执行：<公共预检 + 指定 TC>
允许增加：<探索性测试方向>
禁止假设：<例如不能把历史 backend 文档当作当前依赖>
交付：audit-results/<日期>/M__/README.md、test-matrix.md、证据与 defects.md
完成标准：<PASS 条件>
截止：<时间>
```

每位审计人完成后必须回复：通过用例数、失败用例数、阻塞项、最高严重性、最值得进入长期回归套件的 3 条用例。

