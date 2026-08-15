# C / D / E 独立审计报告

> 依据：`docs/AI_AUDIT_TEST_PLAN.md` v1.0  
> 分组：C Runtime（M04、M05、M11）/ D 外部能力与持久化（M08、M09、M10）/ E 前端与发布（M12、M13）  
> 审计日期：2026-08-15  
> 审计分支：`audit/cde-2026-08-15`  
> 发现基线 Commit：`b9ebfe02eeaf782cfa7d62d0b8c5b34ad5f2188f`  
> 对比主线：`main@be78a1a577a9d20cec4cefb3b604661f0187a59c`  
> 审计方式：GitHub 远端源码、配置、测试与 workflow 独立静态复核；本报告没有把未实际执行的命令、Windows smoke、故障注入或 GitHub Actions 运行伪装成通过。

---

## 1. 结论

- 总体状态：**FAIL**
- C Runtime：**FAIL**
- D 外部能力与持久化：**FAIL**
- E 前端与发布：**FAIL / branch-head dynamic gates NOT_RUN**
- P0：0
- P1：6
- P2：7
- P3：0

本轮共确认 13 条缺陷。其中 C 组存在 durable admission、状态机和 replay 隔离问题；D 组存在 Model Discovery 网络策略绕过与 DB bridge 卡死后不能自愈的问题；E 组前端主体已经落地，但正式 Release workflow 可以绕过完整 CI，而且最终 bundle 缺少 Windows 启动烟测与发布产物追溯信息。

按 `AI_AUDIT_TEST_PLAN.md` 的总体验收门槛，P1 未清零前不得封板。

---

## 2. 公共预检状态

| Case | 结果 | 证据 / 说明 |
| --- | --- | --- |
| PRE-01 环境与工作区 | NOT_RUN | 本轮按要求仅使用 GitHub 远端插件，没有执行本地 `node/pnpm/git/uv` 命令。 |
| PRE-02 全局质量门禁 | NOT_RUN | 当前 `audit/cde-2026-08-15` HEAD 没有 GitHub Actions run；未声称 `pnpm test/lint/typecheck/build`、pytest、ruff 或 bridge self-test 已通过。 |
| PRE-03 静态退役扫描 | NOT_RUN | 本轮只针对 C/D/E 目标路径做源码复核，没有执行手册要求的完整 `rg` / `git ls-files backend` 扫描。 |
| PRE-04 启动 smoke | NOT_RUN | 未启动 `pnpm dev` / `pnpm start`，没有 health/root/databases 动态证据。 |

补充：`.github/workflows/ci.yml` 只在 `main` push、PR 和手工 dispatch 上运行；单独 push `audit/*` 不会自动得到 branch-head CI 证据。当前审计分支也没有 required status checks。

---

## 3. 分组汇总

| ID | 严重性 | 模块 / Case | 问题 | 状态 |
| --- | --- | --- | --- | --- |
| CDE-C-01 | P1 | M04-T03 | `request_id` 幂等检查非原子，并发重复 POST 可创建两个 task/run | FAIL |
| CDE-C-02 | P1 | M04-T02 | single-active-run 检查存在 TOCTOU，可持久化第二个 `run_queued` 并制造 zombie active run | FAIL |
| CDE-C-03 | P1 | M04-T07、M11-T04 | `resumeRun()` 可对 terminal / 非 paused run 写入 `user_input_resumed`，从 durable 投影复活 run | FAIL |
| CDE-C-04 | P2 | M04-T05 | `events.jsonl` 读取只做 JSON parse，没有 sequence/schema/task/run 不变量校验 | FAIL |
| CDE-C-05 | P2 | M05-T04、M05-T06 | unsubscribe / 重复 subscribe 无法终止旧 replay，可能继续推送或重复交错 replay | FAIL |
| CDE-C-06 | P2 | M11-T01 | 前端发送 task history `cursor`，Runtime 却主动拒绝带 cursor 的 `/api/v1/tasks`，加载更多落到 404 | FAIL |
| CDE-D-01 | P1 | M08-T01、M10-T07 | Model Discovery 先校验 DNS，随后普通 `fetch` 再解析，绕开已有 IP pinning，存在 DNS rebinding / SSRF 窗口 | FAIL |
| CDE-D-02 | P1 | M09-T03 | DB bridge request timeout 只 reject 请求，不 recycle 卡死子进程，后续请求持续超时 | FAIL |
| CDE-D-03 | P2 | M08-T02 | `PublicHttpClient.timeoutMs` 文档声明 body-read deadline，但实现完全未使用 | FAIL |
| CDE-D-04 | P2 | M10-T03 | provider/settings CRUD 持久化 `base_url` 时不走统一 URL policy，非法/私网配置可先进入 durable settings | FAIL |
| CDE-E-01 | P1 | M13-T02、M13-T08 | `v*` Release workflow 不依赖完整 CI，可从未验证提交直接打 tag 发布 | FAIL |
| CDE-E-02 | P2 | M13-T03、M13-T05 | 最终 release bundle 只在 Linux 做 unpack/install/start/health，Windows 没有同级 bundle smoke | FAIL |
| CDE-E-03 | P2 | M13-T07 | Release 没有 checksum / build manifest / source SHA / SBOM 或许可证追溯产物 | FAIL |

---

# 4. C Runtime — M04 / M05 / M11

## 4.1 模块结果

- 状态：**FAIL**
- P0：0
- P1：3
- P2：3
- P3：0

### M04 测试矩阵

| Case | 结果 | 证据类型 | 缺陷 / 备注 |
| --- | --- | --- | --- |
| M04-T01 | NOT_RUN | 静态观察 | 正常事件链已有 reducer/runtime 实现，但未做动态完整链路验证。 |
| M04-T02 | FAIL | 静态可证明 | `CDE-C-02` |
| M04-T03 | FAIL | 静态可证明 | `CDE-C-01` |
| M04-T04 | NOT_RUN | - | 未做进程崩溃故障注入。 |
| M04-T05 | FAIL | 静态可证明 | `CDE-C-04` |
| M04-T06 | NOT_RUN | 静态观察 | cancellation 路径有 terminal acknowledgement 逻辑，但没有 queued/running/finalizing 全状态动态验证。 |
| M04-T07 | FAIL | 静态可证明 | `CDE-C-03` |
| M04-T08 | NOT_RUN | - | 未执行 compact + pagination + replay 组合测试。 |
| M04-T09 | NOT_RUN | 静态观察 | delete 代码会拒绝 active task；未执行删除后 events/artifacts 动态验证。 |
| M04-T10 | NOT_RUN | - | 未做事件写入故障注入。 |

### M05 测试矩阵

| Case | 结果 | 证据类型 | 缺陷 / 备注 |
| --- | --- | --- | --- |
| M05-T01 | NOT_RUN | 静态观察 | 服务端有 replay loop，但未抓取实际 WS trace。 |
| M05-T02 | NOT_RUN | - | 未执行 replay → live 去重验证。 |
| M05-T03 | NOT_RUN | - | 未执行断线、HTTP events 补齐、重连组合测试。 |
| M05-T04 | FAIL | 静态可证明 | `CDE-C-05`：unsubscribe 不能取消已启动 replay。 |
| M05-T05 | NOT_RUN | 静态观察 | ping/pong 与基础错误控制帧已实现，未动态测试所有非法命令。 |
| M05-T06 | FAIL | 静态可证明 | `CDE-C-05`：重复 subscribe 旧 replay 不失效。 |
| M05-T07 | NOT_RUN | - | 未验证 WS 与 HTTP 截断 parity。 |
| M05-T08 | NOT_RUN | - | 未做慢消费者 / 大事件背压压测。 |

### M11 测试矩阵

| Case | 结果 | 证据类型 | 缺陷 / 备注 |
| --- | --- | --- | --- |
| M11-T01 | FAIL | 静态可证明 | `CDE-C-06`：task history cursor 契约断裂。 |
| M11-T02 | NOT_RUN | 静态正向证据 | `artifact-store.ts` 有 relative path、realpath、symlink escape、size/hash 校验；未动态攻击验证。 |
| M11-T03 | NOT_RUN | 静态观察 | active task delete 拒绝已存在；未做 HTTP 全链路。 |
| M11-T04 | FAIL | 静态可证明 | `CDE-C-03`：非法/重复/terminal resume 缺状态门禁。 |
| M11-T05 | NOT_RUN | - | 未做 cache export zip 路径/压缩攻击测试。 |
| M11-T06 | NOT_RUN | 静态观察 | WS same-origin 有检查；未做 CORS/Host/proxy/header 动态矩阵。 |

---

## 4.2 [P1] CDE-C-01 — `request_id` 幂等检查不是原子 admission

- 模块：M04
- Case ID：M04-T03
- 发现提交：`b9ebfe02eeaf782cfa7d62d0b8c5b34ad5f2188f`
- 环境：GitHub 静态源码复核；动态 OS/Node/pnpm 不适用
- 可复现性：并发调度相关；竞态窗口静态确定存在
- 影响：任务、幂等、事件链、重复执行

### 前置条件

两个请求使用完全相同 `request_id` 和相同请求内容，同时进入 `DurableTaskRepository.createTask()`。

### 最小复现步骤

1. 对 `POST /api/v1/tasks` 并发发送两次同一个 `request_id`。
2. 让两个调用都在任一方 append `run_queued` 前完成 `findRequest()`。
3. 检查 `data/output/tasks`（或当前 tasks root）和两个 HTTP 返回。

### 预期

同一 request id 只归属一个 durable request；第二个调用返回同一 task/run，或在冲突条件下明确拒绝，不得创建第二条 durable 身份链。

### 实际

`createTask()` 先执行全局 `findRequest()`，确认不存在后才生成 taskId/runId 并 append。request-id lookup 不在全局 reservation / transaction / critical section 内，两个并发调用可以同时看到“未存在”，随后各自创建不同 task/run。

### 证据

- `server/src/runtime/task-repository.ts`
  - `DurableTaskRepository.createTask()`
  - `DurableTaskRepository.findRequest()`
  - `pending` 只按 `taskId` 串行 append，不能保护全局 `request_id` admission。

### 初步归因

幂等约束实现成“写之前查询”，缺少 request-id 级原子保留或单 repository admission 锁。

### 建议修复与回归用例

将 request-id lookup + ownership/content comparison + task/run 创建放进同一原子 admission 区域。新增并发回归：`Promise.all()` 同时提交 20 个同 request-id 请求，最终只能存在 1 个 task、1 个初始 run、1 条 `run_queued`。

---

## 4.3 [P1] CDE-C-02 — single-active-run TOCTOU 会持久化 zombie run

- 模块：M04
- Case ID：M04-T02
- 发现提交：`b9ebfe02eeaf782cfa7d62d0b8c5b34ad5f2188f`
- 环境：GitHub 静态源码复核
- 可复现性：并发调度相关；静态存在确定竞态窗口
- 影响：任务状态、并发、恢复、后续 continuation

### 前置条件

一个 terminal Agent task，同时收到两条 continuation。

### 最小复现步骤

1. 并发调用两次 `POST /api/v1/tasks/{task}/runs`。
2. 两个请求都在第一条 `run_queued` append 前读取 snapshot。
3. 观察 `events.jsonl`、Pi 实际 active run 与 reducer snapshot。

### 预期

第二个 continuation 必须排队、409 或得到明确冲突，任何时刻 durable log 不能出现两个 active candidate。

### 实际

`createRun()` 在 task append 队列之外执行 `getSnapshot()` 和 `active_run_id === null` 检查；两个并发调用可同时通过，然后依次 append 两个 `run_queued`。上层 `startRun()` 才通过内存 `activeRunId` 拒绝第二个 run，但拒绝发生在第二条 `run_queued` 已持久化之后。

`task-reducer.ts` 又以 `runs.at(-1)` 推导 task status / active_run_id，因此第二个从未真正启动的 queued run 可以成为 durable `active_run_id`，而真实执行的是第一个 run。

### 证据

- `server/src/runtime/task-repository.ts::createRun()`
- `server/src/runtime/durable-agent-runtime.ts::createRun()` / `startRun()`
- `server/src/runtime/task-reducer.ts::reduceTaskEvents()`

### 初步归因

single-active invariant 分裂在 durable repository 和 Runtime 内存状态两个层次，检查与 append 不在同一临界区。

### 建议修复与回归用例

repository 必须原子完成 `active_run_id` 检查与 `run_queued` append。新增 50 路并发 continuation 回归：只允许一个请求写入 `run_queued`，其余得到一致冲突；snapshot active_run_id 必须等于实际 Pi active run。

---

## 4.4 [P1] CDE-C-03 — terminal / 非 paused run 可被 `resume` 重新投影成 running

- 模块：M04、M11
- Case ID：M04-T07、M11-T04
- 发现提交：`b9ebfe02eeaf782cfa7d62d0b8c5b34ad5f2188f`
- 环境：GitHub 静态源码复核
- 可复现性：100%（接口状态门禁缺失）
- 影响：任务状态、HIL、用户决策、恢复

### 最小复现步骤

1. 取得一个 `completed` / `failed` / `cancelled` run id。
2. 对 `/api/v1/tasks/{task}/runs/{run}/resume` 提交合法 `request_id` 与 `approve/reject`。
3. 读取 snapshot。

### 预期

只有当前 `awaiting_user_input` run 且 pending approval request 匹配时才能 resume。terminal、错误 run、重复 resume、过期 request 必须明确拒绝。

### 实际

`resumeRun()` 只确认 run id 曾存在，随后无条件 append `user_input_resumed`。`task-reducer.ts::statusFor()` 将该事件映射为 `running`。因此已 terminal 的历史 run 可以重新出现在 durable 投影中，且此时没有对应 Pi execution。

### 证据

- `server/src/runtime/durable-agent-runtime.ts::resumeRun()`
- `server/src/runtime/task-reducer.ts::statusFor()`

### 建议修复与回归用例

resume 前同时验证：

- `task.active_run_id === run_id`
- `run.status === awaiting_user_input`
- approval gate 中存在同 run、同 request id 的 pending decision
- decision 一次性消费

新增 terminal resume、错误 request-id、double resume、cancel-vs-resume race 回归，全部应 fail closed。

---

## 4.5 [P2] CDE-C-04 — durable event log 缺少不变量校验

- 模块：M04
- Case ID：M04-T05
- 可复现性：100%（对任意语义损坏但 JSON 合法的日志）
- 影响：恢复、状态投影、审计可信度

### 最小复现步骤

手工构造合法 JSONL，但包含 sequence 缺口、重复 sequence、错误 task_id、未知 schema/type 或 run 事件先于 `run_queued`，随后调用 snapshot / append。

### 预期

服务 fail closed，给出可操作 corruption 错误；不得静默继续 reducer 或基于错误尾 sequence 继续 append。

### 实际

`parseEvents()` 逐行 `JSON.parse()` 后直接 cast `EventEnvelope[]`。`readAllEvents()` 没有验证 sequence 连续性、schema、task/run linkage、event type 或状态顺序。

### 证据

- `server/src/runtime/task-repository.ts::parseEvents()` / `readAllEvents()`

### 建议修复与回归用例

增加 durable log validator，并为尾部半行、合法 JSON 断序、重复 sequence、错误 task_id、unknown event、非法 run transition 建独立 fixture。

---

## 4.6 [P2] CDE-C-05 — WS 旧 replay 在 unsubscribe / 重复 subscribe 后仍可继续发送

- 模块：M05
- Case ID：M05-T04、M05-T06
- 可复现性：高；取决于 replay 长度与时序
- 影响：事件重复、task 串线感知、资源回收、前端 gap/replay 稳定性

### 最小复现步骤

1. 给一个拥有大量历史事件的 task 发 subscribe。
2. replay 未结束时发 unsubscribe，或再次 subscribe 同一 task。
3. 抓取后续 WS frame。

### 预期

unsubscribe 后旧 replay 立即失效；重复 subscribe 应原子替换上一代 subscription，不允许两个 replay 协程同时向同 socket 发送。

### 实际

服务端 `subscriptions.delete(taskId)` 或覆盖 Map 项目后，已经启动的异步 replay loop 没有 generation/token 检查，仍直接调用 `send(event)`。旧 replay 与新 replay 可交错或重复发送。

### 证据

- `server/src/runtime/durable-agent-runtime.ts` WebSocket `subscribe` / replay loop / `unsubscribe`

### 建议修复与回归用例

为每个 subscription 分配 generation/token；每次 replay page、每个 event 发送前确认 `subscriptions.get(taskId) === subscription`。新增 unsubscribe-during-replay、duplicate-subscribe-during-replay、socket-close-during-replay 测试。

---

## 4.7 [P2] CDE-C-06 — task history `cursor` 前后端契约断裂

- 模块：M11（用户可见影响跨到 M12）
- Case ID：M11-T01
- 可复现性：100%（历史数量超过首屏）
- 影响：任务历史分页、前端交互

### 最小复现步骤

1. 生成超过 10 个 terminal tasks。
2. 前端加载首屏并点击“加载更多”。
3. 观察 `GET /api/v1/tasks?limit=10&cursor=...`。

### 预期

Runtime 接收 cursor 并返回下一页；`next_cursor` 单调推进直到 null。

### 实际

`frontend/src/runtime/controller.ts::loadMoreTasks()` 明确发送 cursor；`server/src/runtime/durable-agent-runtime.ts::handle()` 却在 `/api/v1/tasks` 带 cursor 时主动 `return false`。Host API 只组合 product/settings，因此请求最终进入 formal API 404。

### 证据

- `frontend/src/runtime/controller.ts::loadMoreTasks()`
- `server/src/runtime/durable-agent-runtime.ts::handle()`
- `server/src/bootstrap.ts::combineApis()`
- `server/src/app/create-app.ts::routeRequest()`

### 建议修复与回归用例

在正式 Runtime 实现一致 cursor 语义，并为 0/1/10/11/25 个历史 task 建分页 E2E；确保无重复、无遗漏、cursor 稳定推进。

---

# 5. D 外部能力与持久化 — M08 / M09 / M10

## 5.1 模块结果

- 状态：**FAIL**
- P0：0
- P1：2
- P2：2
- P3：0

### M08 测试矩阵

| Case | 结果 | 证据类型 | 缺陷 / 备注 |
| --- | --- | --- | --- |
| M08-T01 | FAIL | 静态可证明 | `CDE-D-01`：Model Discovery 绕开 pinned transport。 |
| M08-T02 | FAIL | 静态可证明 | `CDE-D-03`：声明的 body-read timeout 未实现。 |
| M08-T03 | NOT_RUN | - | 未做恶意 content-type/magic/compression fixture。 |
| M08-T04 | NOT_RUN | - | 未做中断/hash/cache 动态测试。 |
| M08-T05 | NOT_RUN | - | 未执行 browser hostile-page 资源回收测试。 |
| M08-T06 | NOT_RUN | - | 未执行 PDF golden / corrupt PDF。 |
| M08-T07 | NOT_RUN | - | 未执行恶意 HTML/长文本输出链路。 |
| M08-T08 | NOT_RUN | - | 未验证 fixture mode 网络隔离。 |

### M09 测试矩阵

| Case | 结果 | 证据类型 | 缺陷 / 备注 |
| --- | --- | --- | --- |
| M09-T01 | NOT_RUN | 静态正向证据 | bridge 是 JSONL named-op；未执行真实 request/response matrix。 |
| M09-T02 | NOT_RUN | 静态观察 | protocol version/unknown op 路径存在；未跑 malformed/duplicate/oversize 全矩阵。 |
| M09-T03 | FAIL | 静态可证明 | `CDE-D-02` |
| M09-T04 | NOT_RUN | 静态正向证据 | `sql.exec` 不在 dispatch allowlist；注入类动态用例未执行。 |
| M09-T05 | NOT_RUN | - | 未执行 cache schema compatibility。 |
| M09-T06 | NOT_RUN | - | 未做磁盘/rename/crash 故障注入。 |
| M09-T07 | NOT_RUN | 静态观察 | CRUD handlers 已存在；未执行全组合。 |
| M09-T08 | NOT_RUN | - | 未做并发 cache 压测。 |
| M09-T09 | NOT_RUN | - | 当前 branch-head 没有 pytest/ruff/self-test 动态证据。 |

### M10 测试矩阵

| Case | 结果 | 证据类型 | 缺陷 / 备注 |
| --- | --- | --- | --- |
| M10-T01 | NOT_RUN | 静态正向证据 | masked key、独立 auth 文件与 private mode 已实现；未执行重启恢复。 |
| M10-T02 | NOT_RUN | 静态观察 | active model 参数映射存在；未做 provider 动态透传。 |
| M10-T03 | FAIL | 静态可证明 | `CDE-D-04` |
| M10-T04 | NOT_RUN | 静态正向证据 | HTTP 返回 masked key；未审完整日志/截图/localStorage。 |
| M10-T05 | NOT_RUN | 静态观察 | legacy registry migration 已有测试；本轮未执行。 |
| M10-T06 | NOT_RUN | 静态观察 | service 有 serialized `mutate()`；未做多进程/磁盘失败。 |
| M10-T07 | FAIL | 静态可证明 | `CDE-D-01`：discovery transport 未地址钉扎。 |

---

## 5.2 [P1] CDE-D-01 — Model Discovery 绕过地址钉扎，存在 DNS rebinding / SSRF 窗口

- 模块：M08、M10
- Case ID：M08-T01、M10-T07
- 可复现性：依赖可控 DNS；代码路径静态确定
- 影响：网络安全、SSRF、凭据边界、模型配置

### 前置条件

攻击者控制 provider hostname DNS，或存在 DNS answer 在验证与实际 connect 之间变化的环境。

### 最小复现步骤

1. 第一次 resolver 返回公网 IP，使 `validateCredentialedPublicUrl` / `validatePublicHttpUrl` 通过。
2. `discover()` 随后调用普通 `fetch(target)`。
3. 第二次 DNS resolve 改为 loopback/私网地址。

### 预期

验证得到的公网地址必须与实际 socket connect 地址绑定；每次 redirect 都重新校验并重新 pin。

### 实际

`ModelSettingsService.publicProviderUrl()` 只做 URL/DNS validation；`discover()` 随后使用普通 `fetcher(target)`，实际连接会再次 DNS resolve。仓库已有 `PublicHttpClient` 能把 socket 绑定到校验过的 IP，但 discovery 没复用。

### 证据

- `server/src/settings/model-registry/service.ts::publicProviderUrl()` / `discover()`
- `server/src/external/network/http-client.ts::PublicHttpClient`
- `server/src/external/network/url-policy.ts::resolvePublicHttpTarget()`

### 建议修复与回归用例

所有 provider discovery 必须走 `PublicHttpClient` 或同等 pinned transport。测试注入 resolver：验证阶段 public、后续 DNS private；真实 executor 仍只能连接第一次验证过的 public address，或 fail closed。

---

## 5.3 [P1] CDE-D-02 — DB bridge timeout 后不 recycle 子进程

- 模块：M09
- Case ID：M09-T03
- 可复现性：100%（当 bridge handler 永不返回时）
- 影响：数据库、缓存、Host 长期可用性、子进程恢复

### 最小复现步骤

1. 使用测试 bridge / 故障注入让一个 named-op 永久阻塞。
2. 等 `DatabaseClient.call()` timeout。
3. 再发 `ping` 或任意 database/cache request。

### 预期

timeout 后当前 bridge generation 应标记失效并终止；下一次请求创建新 bridge，或自动重试到新 generation。

### 实际

timeout handler 只从 `pending` 删除 request 并 reject。child process 保持 `running`；后续 `start()` 因 `running === true` 不会 spawn 新进程。Python `_serve()` 又是同步处理循环，一个 handler 卡死时无法处理后续 JSONL，因此客户端会持续 timeout，直到 Host/bridge 外部重启。

### 证据

- `server/src/persistence/db-client.ts::DatabaseClient.call()` / `start()`
- `database/bridge.py::_serve()`

### 建议修复与回归用例

引入 bridge generation。任意 request timeout 应 detach + kill 当前 generation、reject 其余 pending；下一次 call lazy-spawn 新 child。旧 child 的 exit/error listener 不能清理新 child 引用。新增 hang → timeout → child pid 变化 → ping success 回归。

---

## 5.4 [P2] CDE-D-03 — `PublicHttpClient.timeoutMs` 是未实现的安全配置

- 模块：M08
- Case ID：M08-T02
- 可复现性：100%
- 影响：网络资源、慢响应 DoS、配置可信度

### 最小复现步骤

构造 executor：立即返回 headers，但 body async iterable 永不结束；调用 `request(url, { timeoutMs: 100 })`。

### 预期

约 100 ms 后 body read / request fail closed。

### 实际

`HttpRequestOptions.timeoutMs` 注释声明“Total per-hop body-read deadline”，但 `PublicHttpClient.request()` 和 `defaultExecutor` 未使用该字段。只有 `connectTimeoutMs` 与外部 AbortSignal 生效。

### 证据

- `server/src/external/network/http-client.ts`

### 建议修复与回归用例

明确区分 connect / headers / body / overall deadline，并在 body async iterator 上施加 deadline。增加 slow-body、never-ending-body、redirect-per-hop timeout 测试。

---

## 5.5 [P2] CDE-D-04 — Provider / settings 持久化前不验证 URL policy

- 模块：M10
- Case ID：M10-T03
- 可复现性：100%
- 影响：配置、错误延迟暴露、网络边界一致性

### 最小复现步骤

创建或更新 provider/settings，传入 malformed scheme、URL credentials、localhost、私网 URL 等 `base_url`。

### 预期

写入 durable settings 前立即 422 / validation error；带 credential 的 provider 强制 HTTPS policy。

### 实际

`createProvider()` / `updateProvider()` / `updateSettings()` 对 `base_url` 主要只做非空字符串验证；统一 URL policy 直到 discovery 才调用，active model resolution 又会直接把持久化 URL 交给 Pi runtime。

### 证据

- `server/src/settings/model-registry/service.ts`
- `server/src/settings/model-registry/model-resolution.ts`

### 建议修复与回归用例

将 URL validation 放入所有 settings/provider mutation 路径。credential 已配置时使用 credentialed HTTPS policy；无 credential 也至少应用 public HTTP policy。增加 malformed/private/credential-in-URL/custom-port 回归。

---

# 6. E 前端与发布 — M12 / M13

## 6.1 模块结果

- 状态：**FAIL / dynamic gates NOT_RUN**
- P0：0
- P1：1
- P2：2
- P3：0

### M12 测试矩阵

| Case | 结果 | 证据类型 | 缺陷 / 备注 |
| --- | --- | --- | --- |
| M12-T01 | NOT_RUN | 静态观察 | task/run/tool/operation UI 状态实现较完整，未做浏览器 E2E。 |
| M12-T02 | NOT_RUN | 静态正向证据 | transport 有 reconnect、sequence gap recovery、REST fallback；未实际断网验证。 |
| M12-T03 | NOT_RUN | 静态正向证据 | UI 显式区分 `succeeded/partial_success/no_data/spec_rejected`；未跑业务 fixture。 |
| M12-T04 | NOT_RUN | - | 未执行 artifact/provenance/audit report 浏览器链路。 |
| M12-T05 | NOT_RUN | 静态观察 | settings/model UI 存在；未做保存失败/恢复 E2E。 |
| M12-T06 | NOT_RUN | - | 未做 database/HIL 浏览器全链路。 |
| M12-T07 | NOT_RUN | 静态关联风险 | task history “加载更多”会命中 `CDE-C-06`，但本轮没有浏览器交互 trace。 |
| M12-T08 | NOT_RUN | - | 未做可访问性扫描。 |
| M12-T09 | NOT_RUN | - | 未抓浏览器 console/network/localStorage。 |

### M13 测试矩阵

| Case | 结果 | 证据类型 | 缺陷 / 备注 |
| --- | --- | --- | --- |
| M13-T01 | NOT_RUN | - | 未 fresh checkout。 |
| M13-T02 | FAIL | workflow 静态可证明 | `CDE-E-01`：tag release 不要求完整 CI。 |
| M13-T03 | NOT_RUN | workflow 静态观察 | Windows job 存在 dataset/bridge 定向 gates，但当前 HEAD 无 run；最终 bundle Windows smoke 仍缺失。 |
| M13-T04 | PASS | workflow 静态检查 | staging 显式复制 `packages/`、tsconfig、frontend/server，移除 node_modules，没有复制 `backend/`。动态 bundle 内容仍应抽检。 |
| M13-T05 | FAIL | workflow 静态可证明 | `CDE-E-02`：真正 unpack/install/start/health 只在 Ubuntu。 |
| M13-T06 | NOT_RUN | - | 未执行 SPA/MIME/cache/port/Ctrl+C smoke。 |
| M13-T07 | FAIL | workflow 静态可证明 | `CDE-E-03` |
| M13-T08 | PASS | workflow 静态检查 | CI 没有同步整个 Python backend，database job 仍执行 uv sync/self-test/pytest/ruff。 |

---

## 6.2 [P1] CDE-E-01 — `v*` Release 可以绕过完整 CI

- 模块：M13
- Case ID：M13-T02、M13-T08
- 可复现性：100%（workflow 触发/依赖图决定）
- 影响：发布、生产质量、可追溯验收

### 最小复现步骤

1. 在一个没有完整 CI 成功记录的 commit 上创建 `v*` tag。
2. 触发 `.github/workflows/package.yml`。
3. 检查 release dependency graph。

### 预期

任何正式 Release 都必须依赖与 `ci.yml` 同等级的 test/lint/typecheck/build + database gates，不能只依赖 package 内较弱 smoke。

### 实际

`ci.yml` 的 workspace job 会执行 `pnpm test/lint/typecheck/build`，database job 会执行 bridge self-test/pytest/ruff，另有 Windows gates；但 `package.yml` 的 `release` 只依赖 `package` + `release-smoke`。tag 可以直接触发 package workflow，workflow 没有证明同 SHA 的完整 CI 已通过。

当前 `audit/cde-2026-08-15` 也没有 Actions run，进一步说明 branch-head 没有动态绿灯证据。

### 证据

- `.github/workflows/ci.yml`
- `.github/workflows/package.yml`

### 建议修复与回归用例

将完整质量门禁抽为 reusable workflow，PR/main CI 与 release workflow 同时调用；`release` 必须 `needs` 该门禁。增加一个测试/演练：故意让 unit test 失败后打 tag，release 必须无法创建。

---

## 6.3 [P2] CDE-E-02 — Cross-platform bundle 缺 Windows 最终启动 smoke

- 模块：M13
- Case ID：M13-T03、M13-T05
- 可复现性：100%（workflow 配置缺 job）
- 影响：Windows 发布可用性、路径、进程、Python bridge

### 预期

最终 ZIP 至少在 Ubuntu 和 Windows 各执行一次：unpack → frozen install → uv sync → bridge self-test → `pnpm start` → health/root/databases → shutdown。

### 实际

`package.yml` 的 release-smoke 仅 `runs-on: ubuntu-latest`。`ci.yml` 虽有 Windows job，但它针对 checkout 工作区运行 build-lock/dataset core/bridge 定向测试，不是对最终 release bundle 的真实启动 smoke。

### 建议修复与回归用例

release-smoke 使用 OS matrix（至少 `ubuntu-latest`, `windows-latest`），Windows 侧额外验证路径带空格、Ctrl+C/child cleanup、bridge Python 选择与静态资源访问。

---

## 6.4 [P2] CDE-E-03 — Release 产物缺少 checksum 与构建身份追溯

- 模块：M13
- Case ID：M13-T07
- 可复现性：100%
- 影响：发布追溯、下载完整性、审计复现

### 预期

正式 Release 至少附带：

- `SHA256SUMS`；
- build/release manifest（source commit SHA、tag、Node/pnpm/Python/uv 版本）；
- 可核对的 bundle hash；
- 许可证清单或 SBOM（至少一项标准化 dependency inventory）。

### 实际

`package.yml` 最终只上传 `BioMed-QAgent-bundle.zip` 并创建 GitHub Release；没有 checksum、source/build manifest、SBOM/license inventory 等追溯产物。

### 建议修复与回归用例

在 package job 生成 `SHA256SUMS` 与 `release-manifest.json`，记录 `${GITHUB_SHA}`、tag、toolchain 版本和 bundle SHA256，一并附到 Release；建议再生成 CycloneDX/SPDX SBOM。

---

# 7. 已确认的正向边界（不等于动态 PASS）

以下内容在静态审计中表现正确，保留为后续回归基线；除 M13-T04/T08 这类纯 workflow 静态项外，不把它们替代动态测试：

1. `server/src/runtime/artifact-store.ts` 对 artifact relative path、`..`、反斜杠、realpath/symlink escape 做限制，并在读取时验证 size + SHA256。
2. 当前分支对 `server/src/dataset/runtime/executor.ts` 的修改已将外部 `AbortSignal` 接入 operation-local controller；cancel 后 late output 有 discard 语义。仍需 M06 动态故障注入复核。
3. `database/bridge.py` 使用 named-op allowlist，`sql.exec` 不在 dispatch 表内；Python 边界已明显收缩。
4. Model registry 将 API key 放到独立 `model-auth.json`；公开返回 masked value；`writeJsonAtomic(..., { private: true })` 使用 private file mode。
5. Frontend transport 已实现 reconnect、sequence-gap recovery、REST snapshot fallback、terminal unsubscribe 和 assistant-stream buffer 上限。
6. `ChatPanel` 已对 `succeeded / partial_success / no_data / spec_rejected` build result 做差异化标签与 summary 渲染。
7. `.github/workflows/ci.yml` 已把 Python 范围收缩到 database bridge，并保留 Windows 定向 gates。

---

# 8. 必须新增的长期回归用例

按风险与复现价值排序，优先加入：

1. **Atomic admission suite**：20~50 路相同 request-id create + 同 task continuation 并发，断言一个 durable owner、一个 active run、无 zombie queued run。
2. **HIL state-machine suite**：paused 正常 resume、错误 run、terminal run、错误 request-id、double resume、cancel-vs-resume race。
3. **Durable log corruption suite**：尾半行、sequence gap/duplicate、wrong task_id、unknown schema/type、非法 transition；全部 fail closed。
4. **WS subscription generation suite**：unsubscribe-during-replay、duplicate-subscribe、socket-close-during-replay、慢消费者。
5. **Task pagination E2E**：超过 10/20 条历史 task，cursor 多页无重复无遗漏，前端 load-more 正常。
6. **DNS rebinding suite**：validation resolver 返回 public，连接时 DNS 变 private；discovery 必须 pin 或拒绝。
7. **HTTP slow-body suite**：connect success + body 永不结束；body/overall timeout 必须生效并释放 socket。
8. **DB bridge recovery suite**：handler hang → timeout → kill old generation → new pid → ping / database op 恢复。
9. **Settings URL policy suite**：localhost/private/credentials/malformed/custom-port 在 mutation 阶段直接拒绝。
10. **Release gate test**：完整 CI 失败时 tag release 不得创建。
11. **Windows final-bundle smoke**：真实 ZIP 解包后 `pnpm start` + health/root/databases + shutdown。
12. **Release provenance test**：下载 Release 后核对 `SHA256SUMS`、source SHA、release manifest 与实际 bundle。

---

# 9. 建议修复顺序

1. 原子化 M04 admission：同时解决 `request_id` 与 single-active-run。
2. 封死 M04/M11 非法 resume；pending approval 必须一次性、严格绑定 run/request。
3. 给 durable event log 增加 schema/sequence/linkage/transition 校验。
4. 给 WS subscription 增加 generation/token；修复 task history cursor。
5. Model Discovery 全部切到 pinned `PublicHttpClient`；补齐 body/overall timeout。
6. DB bridge timeout 后 recycle generation；补 hang/restart 测试。
7. provider/settings mutation 阶段统一 URL policy。
8. Release 改为依赖 reusable full CI，补 Windows bundle smoke、checksum 与 release manifest。

---

# 10. 封板条件

本 C/D/E 报告只有在以下条件全部满足后才能从 FAIL 改为 PASS：

- 本报告 6 个 P1 全部关闭，并有对应自动化回归；
- 7 个 P2 均修复或有项目负责人书面接受风险；
- PRE-01 ~ PRE-04 有真实执行证据；
- `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build` 全绿；
- `uv run python database/bridge.py --self-test`, `uv run pytest database/tests`, `uv run ruff check database` 全绿；
- Windows 和 Linux 对最终 bundle 都完成 unpack/install/start/health smoke；
- 至少执行一次并发 admission、非法 resume、WS replay、DNS rebinding、DB bridge hang/restart 故障注入；
- 修复后的 branch HEAD 有可追溯 CI run；
- 复核人随机抽取至少 10 条结论重跑。

---

## 11. 签字 / 复核

| 角色 | 姓名 | 负责范围 | 结论 | 日期 |
| --- | --- | --- | --- | --- |
| Runtime 负责人 |  | M04、M05、M11 | FAIL | 2026-08-15 |
| 外部能力/数据负责人 |  | M08、M09 | FAIL | 2026-08-15 |
| 安全负责人 |  | M10 | FAIL | 2026-08-15 |
| 前端/发布负责人 |  | M12、M13 | FAIL / NOT_RUN | 2026-08-15 |
| 独立总复核 |  | C / D / E | FAIL | 2026-08-15 |
