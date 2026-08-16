# BioMed-QAgent 开发 TODO

> 本清单的目标：**全部条目完成后，Pi 迁移完成**——Pi 成为 Main Agent Runtime，
> Deterministic Dataset Core 迁至 TypeScript，Python 仅保留数据库桥接。
>
> 主线：迁移方案 [BioMed-QAgent_Pi_Migration_Plan.md](BioMed-QAgent_Pi_Migration_Plan.md)
> §20 的 Phase 0-8；每个 Phase 的目标与验收标准以该文档为准，此处只列可勾选条目。
> 架构权威见 [ARCHITECTURE.md](ARCHITECTURE.md)；决策依据见
> [adr/README.md](adr/README.md) 与
> [BioMed-QAgent_Architecture_Decisions_and_Lessons.md](BioMed-QAgent_Architecture_Decisions_and_Lessons.md)。
> 已完成项的细节与证据在 `docs/migration/`、`.superpowers/sdd/` 与 git 历史，本文件不重复。
>
> 旧主线「V2 Pipeline Refactor」（Design §16 Phase 1-8）已全部完成，其清单归档于
> [archive/TODO_PIPELINE_REFACTOR_COMPLETED.md](archive/TODO_PIPELINE_REFACTOR_COMPLETED.md)。

---

## 总进度

| Phase | 内容 | 状态 |
| --- | --- | --- |
| 0 | 冻结边界与迁移 ADR | ✅ 完成（2026-08-12） |
| 1 | 引入 Pi Main Agent（不动 Dataset Core） | ✅ 完成（2026-08-12） |
| 2 | 迁移 Skills 与通用 Agent 工具 | ✅ 完成（2026-08-13） |
| 3 | 拆出 TS Application Runtime | ✅ 完成（2026-08-12；Phase 7 已转默认） |
| 4 | 迁移 Dataset Deterministic Core | ✅ 完成（2026-08-13；运行接线 M2 已闭环） |
| 5 | 迁外部能力与 Python 数据处理依赖 | ✅ 完成（2026-08-14；legacy Python 仅作回滚保留，物理删除属 Phase 8） |
| 6 | 迁模型设置与 Settings API | ✅ 完成（2026-08-13） |
| 7 | 正式切换 Frontend → TS Host | ✅ 完成（2026-08-14） |
| 8 | 删除 Python Runtime（仅留 DB bridge） | ✅ 完成（2026-08-14） |
| 9 | Agent Workspace 与权限系统重构 | ✅ 完成（2026-08-16，ADR-026） |

> **当前拓扑（Phase 8 后，2026-08-14）**：唯一正式拓扑是 TypeScript Host
> （`pnpm dev` / `pnpm start`）+ Pi Agent + TS Dataset Core + 按需 `database/bridge.py`
> JSONL persistence。`APP_HOST` / `AGENT_RUNTIME` / `DATASET_CORE` /
> `PI_EXPERIMENTAL` flags 与 FastAPI rollback **已删除**，不再被解析。
> 下文各 Phase 正文是迁移期历史记录（含已不存在的运行方式），不作为当前
> 启动说明；当前启动见 [README.md](README.md)，权威架构见 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## Phase 0：冻结边界与迁移 ADR（✅ 完成）

- [x] 仓库根成为唯一 pnpm Workspace：单一 `pnpm-lock.yaml`、`frontend/`+`server/`+
      `packages/` 同一 Node 环境、共享 `@biomed/contracts` wire DTO（ADR-018/024）。
- [x] 冻结 DatasetBuild JSON contract、Publication/Validation 不变量与前端
      EventEnvelope；四种 E2E 黄金 fixture（SUCCESS / PARTIAL_SUCCESS / NO_DATA /
      FAILED/SPEC_REJECTED）基线（`docs/migration/baseline-2026-08-11.md`）。
- [x] ADR-017 至 ADR-024 落地：Pi 替换 Agent 层 / 单 Host 单端口 / Session≠Task≠Run≠Build /
      Core 保持确定性 / Pi adapter 隔离 / Core bridge 命名操作 / Workspace 策略 /
      contracts 单一来源（`docs/adr/`）。
- [x] Phase 1G root 全门禁与 Windows `pnpm dev` 启动 smoke 在外部 Node/Python
      runtime（node v24.11.1 / pnpm 11.14.0）重跑通过，2026-08-12
      （`docs/migration/PHASE0_1_FINAL_VERIFICATION.md`）。

## Phase 1：引入 Pi Main Agent，不动 Dataset Core（✅ 完成）

- [x] TS Application Host：唯一公开端口、内嵌 Vite middleware、管理 private FastAPI、
      legacy HTTP/WS proxy；root `pnpm dev` 为唯一正常启动入口
      （`server/src/`，ADR-018）。
- [x] Pi adapter（`server/src/agent/pi-adapter.ts`）+ governed task Workspace：
      read / write / edit / 受控 exec（`WORKSPACE_DEV_EXEC` gate）+ audit log
      （ADR-021/023，`docs/migration/workspace-policy-phase1.md`）。
- [x] experimental `/experimental/pi/*` 面：live events 经 Pi event adapter 投影为
      BioMed 事件，显式非 durable；前端 experimental UI 与 legacy store 隔离。
- [x] Legacy Dataset Core bridge：loopback + per-process secret 的命名操作
      （validate/execute/cancel），跨进程绑定 run/session/tool/build 身份
      （ADR-022，`docs/migration/legacy-dataset-core-bridge.md`）。
- [x] 垂直切片：离线 Workspace、DatasetBuild SUCCESS / SPEC_REJECTED / cancel 全链
      验证（`.superpowers/sdd/task-10~12-report.md`）。
- [x] 回滚与诊断脚本保留：standalone frontend/backend、Host proxy-only、full legacy
      rollback 仅作 migration/debug 用
      （`docs/migration/single-host-lifecycle-and-flags.md`）。

## Phase 2：迁移 Skills 与通用 Agent 工具（✅ 完成，2026-08-13）

> 设计决策与验收映射见
> [docs/migration/phase2-skills-tools-migration.md](migration/phase2-skills-tools-migration.md)。

- [x] `backend/app/skills/builtin/*` → `.pi/skills/*` 内容迁移（17 个 curated
      SKILL.md；`migration-smoke` 退役）
- [x] 业务 Tool 建立 Skill ↔ Tool 稳定名称映射（`server/src/agent/skills/
      skill-tool-map.ts`，TS/Python 双侧测试钉住）；legacy Agent 以直接具名工具
      注册；Pi 侧注册遵循 customTools 面（D1，Phase 5 迁 TS 实现时落工具包装）
- [x] 停用并删除 `SkillCatalog` / `SkillGateway` / `SkillRegistry` /
      `LLMRerankingSkillSearchStrategy` / `UserSkillStore`
- [x] learned skill 默认禁用规则：概念明确删除（`.pi/skills` 为 curated 唯一来源）
- [x] 决策：`/api/v1/skills` 与设置页"技能"分区退役；`/api/v1/databases` 保留为
      极薄声明式数据库存储（`app/databases/`，含 enable/disable 与 detail）
- [x] 验收：Main Agent 不再调用 `find_skill`/`invoke_skill` 自制网关；
      Pi 能按任务加载相关 Skill；Skill 缺失不导致 Runtime 崩溃

## Phase 3：拆出 TS Application Runtime（✅ 完成）

- [x] TS Task/Run domain、request-id 幂等、单 Task 单 active Run、重启 interrupted
      恢复（`server/src/runtime/`）。
- [x] append-only durable `events.jsonl` + 纯 reducer + Task 级 sequence +
      `after_sequence → replay → live` WebSocket。
- [x] `AGENT_RUNTIME=pi` 时正式 Task HTTP/WS 由 TS Runtime 接管；legacy Task 与未迁移
      API 回退 private FastAPI，同一 WebSocket 多路复用两类订阅。
- [x] Pi Session 显式映射并持久化于 `state/pi-session/`；Task/Run/Session/Build
      身份分离（ADR-019）。
- [x] Run cancel 等待 terminal durable acknowledgement；Host 关闭等待执行尾部收敛。
- [x] BuildResult 从 Python Core bridge 投影到 Run 终态；artifact API 仅服务通过
      immutable Publication + manifest + size/hash/path 校验的文件。
- [x] 正式默认切换 `AGENT_RUNTIME=pi`（Phase 7，2026-08-14）。

详细边界与回滚见 `docs/migration/phase3-ts-application-runtime.md`。

## Phase 4：迁移 Dataset Deterministic Core（✅ 完成，2026-08-13）

> 逐 Operation 迁至 TypeScript，每步带 Python V2 golden fixture parity。
> 合入 main @ d7dbbb7；证据见 `.superpowers/phase4/T1-T10-report.md`。

- [x] 迁移顺序：contracts → Schema Registry → SourceAsset → adapters →
      canonicalization → compatibility → integration → validation → publication →
      checkpoint/retry/cancel（steps 1-10，`server/src/dataset/`）
- [x] 每 Operation 的 parity：`server/tests/*-parity.ts` 对照 Python V2 序列化与
      Pydantic 不变量（golden fixtures），各步附 Vitest 套件
- [x] 发布不变量镜像：release gate（provenance closure / profile passed / 原子提升）、
      role-based manifest、deterministic package digest（`server/src/dataset/publish/`）
- [x] 验收：4 类主结果与 Python V2 一致；artifact 仅经 Publisher；失败不留伪成功产物；
      旧 publication 不被覆盖；rerun/resume 语义符合原 V2 不变量

**遗留（属 TS Host 集成，非 Phase 4 范围）**：~~TS executor 为同步实现，operation
超时 / build 锁 / 事件投影（event sink）等运行时基础设施尚未接入运行路径；
`DATASET_CORE` 目前只读入配置、未切换行为（默认仍走 Python V2 Core）。这些接线
与 Phase 7 前端切换一并推进。~~

> 更新（M2，2026-08-14）：上段遗留已由 M2 收口，不再成立 —— operation 异步化 +
> wall-clock timeout + cancel 已贯通到真实 TS Dataset Core 全链路（adapter parse /
> canonicalize / integrate / validation / publish 协作式 checkpoint，signal-aware；
> `server/tests/phase5/core-preemption.test.ts` 验证真实 parse 可被 timeout/cancel 中断）；
> build lock、Core event sink、`DATASET_CORE=ts` 合法 opt-in profile 均已落地（见下节
> Phase 5/M2 清单）。仅“默认 profile 切换”仍属 Phase 7。

> 更新（M2 第二轮审计，2026-08-14）：正式 `ts/pi/ts` composition 已默认启用 120 s
> operation timeout（与 Python baseline 一致，`Phase3RuntimeOptions.operationTimeoutMs`）；
> timeout/cancel 后 executor 在持有 build lock 的情况下以有界 grace 等待 straggler 真正
> settle（`server/tests/phase5/straggler-safety.test.ts`）；publish 在每个 copy 后 /
> publication.json 写后 / 最终 rename 前均有 abort 检查；canonicalize / integrate 的
> checkpoint 改为按 processed 行计数（全 rejected / 全 dedup 极端负载也可中断）。

> 更新（M2 第三轮终审修复，2026-08-14）：build lock 按终审结论重做为 fenced lease ——
> owner.json mtime 心跳（活进程不再因 age 被抢占；acquired_at 仅记录）、stale 回收改为
> 原子 rename 接管（多竞争者至多一人获胜）、owner.json 独占创建（wx）封死 mkdir→写记录
> 初始化窗口、release 仅删自己 token 的锁、publish rename 边界前 assertOwned 围栏
> （被接管的构建无法晚到发布；`LockLostError` → `lock_lost`）。回归见
> `server/tests/phase5/build-lock.test.ts`（8 项，含真实子进程跨进程互斥，旧算法下 7/8 失败）；
> Windows CI 新增 `windows-lock` job 验证 I-04 跨平台行为。

**运行接线（M2/Phase 7 已完成）**：TS executor 已异步化并接入 operation timeout、
build 锁、cancel 收敛与 event sink；`DATASET_CORE=ts` 现为默认运行路径，
`DATASET_CORE=python` 保留一轮回滚。

远程分支 `codex/phase4-dataset-core-ts` 已合入 main，无需另行跟踪。

## Phase 5：迁外部能力与 Python 数据处理依赖（✅ 完成，2026-08-14）

> 实施计划与验收清单：
> [docs/migration/phase5-external-capabilities-completion-plan.md](migration/phase5-external-capabilities-completion-plan.md)；
> baseline/迁移矩阵：
> [docs/migration/phase5-external-capabilities.md](migration/phase5-external-capabilities.md)；
> PDF 选型 spike：[docs/migration/phase5-pdf-spike.md](migration/phase5-pdf-spike.md)。
> legacy Python runtime 仍保留作 Phase 7 前回滚；物理删除属 Phase 8。

- [x] 网络策略与 acquisition 底座（`server/src/external/network|acquisition/`）：
      全量 DNS 公网校验 + 地址钉扎、逐跳 redirect 重验证、流式下载大小/hash/media
      校验、content cache、SourceAsset 原子发布、abort（P5-01）
- [x] 业务 Tool 全量 TS 化：analyze_papers、guidance、PubMed/NCBI、GEO（含 Dataset
      parser：series matrix/SOFT/sample metadata/probe mapping）、GDC、Xena、
      ChEMBL/UniProt/PDB/PubChem/Reactome、Node Playwright browser pool +
      crawler + web visual capture、PDF tables/meta、Qwen-VL chart extraction
      （P5-02…P5-08，fixture golden parity + SKILL_TOOL_MAP 名称钉住）
- [x] 统计/绘图 TS 化：Welch t-test（scipy 数值 parity）、BH FDR（全量 p-value 后截断）、
      Pearson/Spearman/Kendall、heatmap 聚类、PNG 绘图；输出走
      `staging/analysis/<run_id>/`，不绕 Publication 边界（P5-09，P5-D5）
- [x] local cache → TS DB Adapter → Python DB bridge 命名操作（`database/bridge.py`，
      禁任意 SQL）；声明式用户数据库 HTTP 执行 TS 化 + 最小 durable HIL approval
      primitive（api_key_or_credential，P5-10/P5-11）
- [x] 正式 Pi Runtime 全量业务 Tool 接线：Workspace + curated business + 动态声明式
      DB + DatasetBuild，重名 fail closed（P5-12）
- [x] Pi 路径 Python 依赖隔离双门禁：静态（business tool 禁 spawn Python/legacy
      调用）+ 运行时（legacy 不可达时 `ts/pi/ts` 完整运行，P5-13）
- [x] 验收：backend Python 不再承担 Pi 路径 acquisition / parsing / analysis，
      仅 DB bridge；Reactome 语义修正为 research-only（P5-D10）

### M2：Phase 0–6 集成收口（✅ 完成，2026-08-14）

- [x] `DATASET_CORE=ts` 合法 opt-in profile（M2）；Phase 7 已将 `ts/pi/ts/0` 转为默认
- [x] DatasetCore 服务接口 + Python 回滚 adapter + TS adapter（bridge 外形不漂移）
- [x] operation 异步化 + wall-clock timeout（typed timeout failure）+ cancel 收敛 +
      straggler 清理；build lock（task+build 单发布者，Windows 安全，stale 回收）。
      真实 Core 可抢占性由 `server/tests/phase5/core-preemption.test.ts` 验证
      （真实 adapter parse 可被 timeout / AbortSignal / cancelDatasetBuild 中断）
- [x] 正式 runtime 默认启用 operation timeout（120 s，对齐 Python baseline）；
      straggler 有界 grace 等待 + publish rename 边界 abort 检查
      （`server/tests/phase5/straggler-safety.test.ts`）
- [x] Core event sink → 稳定 operation_* EventEnvelope（经 recordRunEvent）
- [x] 四类 golden fixture（SUCCESS / PARTIAL_SUCCESS / NO_DATA / SPEC_REJECTED）
      在 TS Core 路径通过（`server/tests/phase5/ts-core-e2e.test.ts`）
- [x] `DATASET_CORE=python` 回滚路径保留（DatasetCoreClient → private FastAPI）

## Phase 6：迁模型设置与 Settings API（✅ 完成）

- [x] TS model settings + Pi ModelRegistry/AuthStorage adapter：provider credentials、
      custom OpenAI-compatible provider、参数 profile 转 Pi 可消费结构
- [x] 旧 `model_registry.db` 一次性迁移；API Key 不以明文返回前端
- [x] 验收：设置页可创建 provider / 导入模型 / 设 active model；不同模型参数正确
      传给 Pi/provider

## Phase 7：正式切换 Frontend → TS Host（✅ 完成，2026-08-14）

- [x] frontend 全量流量切 TS Host，保持 API 兼容一轮发布；FastAPI 保留为 feature-flag
      回滚路径，默认关闭
- [x] 验收：完整 E2E——多轮对话 / 取消 / 恢复 / 断线重连 / 构建 / artifact 下载 /
      cache / settings / 浏览器能力 / 异常恢复

验收证据与默认/回滚拓扑见
[phase7-frontend-ts-host.md](migration/phase7-frontend-ts-host.md)。

## Phase 8：删除 Python Runtime（✅ 完成，2026-08-14）

- [x] 删除 `backend/`（`app/{agent_loop,runtime,subagents,skills,pipeline,datasets,tools,api,main.py}`、
      `compat/`、`launcher.py`、旧 tests 全部物理退役；`git ls-files backend` = 0）
- [x] 清理 FastAPI / uvicorn / openai-agents / httpx / Playwright Python / pdfplumber /
      matplotlib / scipy / seaborn 依赖；根 `pyproject.toml` 只服务 `database/`（stdlib-only）
- [x] `database/` 自包含：`bridge.py` + `cache_store.py` + `database_store.py` +
      `declarative.py`（stdlib 重写，无 backend/app 依赖）；builtin database catalogue
      移入 TS（`server/src/product/builtin-databases.ts`）；cache 改为 schema-neutral
      （记录自述 columns，删除 22 列全局常量）
- [x] 删除 TS rollback topology：feature flags（APP_HOST/AGENT_RUNTIME/DATASET_CORE/
      PI_EXPERIMENTAL）、`server/src/legacy/`、experimental Phase 1 Pi runtime、
      legacy proxy、Python Dataset Core client、`/experimental/pi` 前端入口
- [x] 验收：`pnpm test / lint / typecheck / build` 全通过 +
      `uv run python database/bridge.py --self-test` + `uv run pytest database/tests` +
      `uv run ruff check database`；`pnpm dev` 与 `pnpm start` 冒烟通过，产品启动不再
      需要 Python Web Server

执行计划与最终验证见
[migration/phase8-python-runtime-retirement.md](migration/phase8-python-runtime-retirement.md)、
[migration/PHASE8_FINAL_VERIFICATION.md](migration/PHASE8_FINAL_VERIFICATION.md)、
[migration/phase8-retirement-inventory.md](migration/phase8-retirement-inventory.md)。

---

## Phase 9：Agent Workspace 与权限系统重构（✅ 完成，2026-08-16）

> 执行计划：`BioMed-QAgent Agent Workspace 与权限系统重构执行计划.md`（W1/W2/P1–P7）；
> 决策记录：ADR-026（取代 ADR-023 的 staging-only 写入模型，保留不可变发布保证）。

### W1  Workspace Root 解耦

- [x] Agent cwd 迁移至 `data/workspaces/<taskId>/`；`data/output/tasks/<taskId>/` 不再作为 cwd
- [x] `WorkspaceManager` + `workspace-paths.ts` 集中路径推导（`getPath/ensure/exists/remove`）
- [x] Workspace 不保存框架 runtime metadata；`state/workspace.json` 记录 version/path/migration
- [x] Task 多 Run 共享同一 Workspace；Task 删除同时清理 Workspace（先 cancel/dispose）
- [x] 重启恢复：`ensure(taskId)` 幂等复用 durable workspace
- [x] Pi session 目录移至 `<taskOutput>/state/pi-session`；audit/cache 保持在框架 output

### W2  Legacy Workspace Migration

- [x] `staging/agent/**` → `data/workspaces/<taskId>/**`（copy → verify → mark，保留旧目录）

### P1  Permission Core

- [x] `server/src/agent/permissions/`：types / path-normalizer / classifier / evaluator /
      grants / policy-store / broker / protected-paths / audit + 单元测试
- [x] allow/ask/deny；once/run/task/persistent grant；most-specific path rule；scope 分类

### P2  read/write/edit 接入 PermissionBroker

- [x] 移除 absolute-path hard deny 与 `staging/agent` write-only；normalize → classify → evaluate
- [x] workspace 自由；task output 只读；project/external 默认 ask；state/logs/artifacts 硬保护

### P3  Permission Event + API

- [x] `permission_requested` / `permission_resolved` durable events
- [x] `POST /api/v1/tasks/{taskId}/runs/{runId}/permissions/{requestId}`（once/run/task/persistent），
      resolve 绑定 URL runId（pending 按 runId 索引再核验 requestId，旧 runId 不能批准新请求）
- [x] pending 请求生命周期：cancel/重启失效，不静默重放

### P4  Frontend Permission UI

- [x] Run 时间线权限卡片（拒绝 / 允许一次 / 本 Run / 本 Task / 始终允许目录·命令）；
      Run/Task 授权为 capability×scope 粒度，卡片明示“覆盖该范围内其他路径”
- [x] 设置 → Agent → 权限：preset（受限/按需询问/完全访问）+ 已授权目录管理 + 命令执行开关

### P5  Exec Permission

- [x] `process.exec` 独立 capability，默认 ask；删除 snapshot/restore 伪沙箱
- [x] 保留 timeout / output limit / cancel / process-tree cleanup / audit；UI 显示 OS 权限警告
- [x] 迁移 flag `AGENT_EXEC_POLICY=deny|ask|allow` 替换 `WORKSPACE_DEV_EXEC`
- [x] **撤权闭环**：`PUT .../persistent-exec {enabled:false}` + 设置开关；Restricted 在 evaluator 硬拒绝
      exec 并在切 preset 时清除 `persistent_exec_allow`

### P6  Permission Presets + Persistent Rules

- [x] `data/settings/agent-permissions.json`；Restricted / Ask when needed / Full access
- [x] 持久规则入库前 canonicalize 并校验绝对路径（不依赖 evaluator 的 `path.resolve`）

### P7  Publication Integrity Hardening

- [x] 验证：外部改动 artifact → hash 不匹配 → 409 ArtifactIntegrityError；
      workspace 任意文件不会自动成为 Publication（仅 Core 发布路径）
- [x] 审计修正：reader 重算 package digest 并与 `manifest.sha256`/`manifest_id`（绑定 publication.json
      manifest_ref）交叉验证——改 artifact 并同步改 manifest 条目但不重算 digest 也会被拒
- [x] 二轮审计修正：`packageDigest` 只覆盖 artifact 条目，manifest 顶层元数据（row_count/
      validation_summary 等）改不改 digest——Publisher 新增必需字段 `publication.json.manifest_sha256`
      （manifest 文件字节哈希），reader 先校验文件字节再解析；golden fixtures 同步携带该字段
- [x] 信任边界明确（ADR-026 §3）：同账户 exec 能一致性重写整包时无法防伪，仅防意外/部分篡改
- [x] `../` 越界改为 resolve→classify→broker（不再是 INVALID 输入错）；不存在路径 canonicalization
      重新拼回缺失后缀，避免授权范围意外扩大；write 在创建父目录后复核目标与授权 canonical 一致
- [x] legacy migration marker 的 POSIX 比较修正（比较 `marker.workspace` 而非 `workspaceRoot`）

二轮审计修复（2026-08-17）：

- [x] **P0 framework control-plane 隔离**：新增 `framework_internal` scope——`data/settings/**`
      （持久权限规则 + 模型凭据）、其他 Task 的 workspace/output 全部硬拒绝（含 read），
      任何 project 级授权或持久规则都无法覆盖；当前 Task 的 state/logs/artifacts 仍由
      ProtectedPaths 保护
- [x] **P1 Restricted 硬收权**：评估顺序改为 invariant → Restricted → grants → rules → preset；
      受限模式下临时授权与持久 allow rule 一律失效（file + exec 均覆盖，exec 也压过迁移 flag）
- [x] **P1 Broker 失败状态机**：suspend/resolve 任一步磁盘/audit/event 写失败都会 settle 原
      工具调用（reject）且不留孤儿 pending；fault-injection 测试覆盖
- [x] **P1 policy-store 串行化**：mutation queue + 磁盘写成功后才替换缓存；并发授权不丢规则，
      失败写不产生“内存已改/重启回退”的分裂
- [x] 顺手项：system prompt 与真实策略对齐（exec 默认 ask、task output 只读、框架路径恒拒）；
      持久按钮改为“始终允许此路径”（单文件持久化的是文件路径）；workspace/taskOutput/data/
      repository 四个根在 `createWorkspaceContext` 统一 canonicalize

三轮审计修复（2026-08-17，第三轮审查）:

- [x] **P0 stale pending 重验证**：`broker.resolve(allow)` 先按当前策略重评估原请求，verdict 已变
      deny（如切到 Restricted / 新增 deny rule）→ 不记 grant、工具调用以结构化拒绝 settle、
      事件流写入 resolved-deny；切 Restricted 时经 broker registry 全 host invalidate 所有
      pending（卡片立即消失，不能再被点击生效）
- [x] **P1 pending path TOCTOU**：read/list/search/edit 在 IO 前重新 canonicalize，要求 canonical
      路径与 scope 与原批准一致，不一致 → PATH_ESCAPE（写路径原有复核保留）；批准卡与 audit
      在请求路径 ≠ canonical 时同时展示“请求路径 / 实际路径”
- [x] **P1 sensitive scope**：`.env*`（`.env.example` 除外）、`*.key/pem/p12/pfx`、
      `credentials.json`/`secrets.json` 独立 scope；默认 read=ask、write/edit=deny；
      project/external 的 Run/Task grant 与持久规则都不能自动覆盖；当前 Task 的
      workspace/output 内豁免
- [x] **P1 Run/Task grant 粒度**：fs 临时授权改为 `capability × canonical root`（批准路径+
      子树），批准单个 external 文件不再授权整个 external；卡片提供“高级：整个范围”勾选
      （`scope_wide`）显式扩大；新增 `GET/DELETE .../temp-grants` 查看/撤销运行中授权 + 设置页 UI
- [x] **P1 Broker 事务 rollback**：grant 记录可撤销——audit/event 写失败时回滚临时 grant
      （revoke）或恢复持久设置（exec flag 还原旧值 / 删除刚写入的 rule）；run/task/持久文件/
      持久 exec 四种失败注入测试验证无残留授权
- [x] **P1 Restricted exec 不变量下沉**：store 层拒绝 restricted 下 `setPersistentExecAllow(true)`
      （API 409），不再只靠前端禁用开关
- [x] **P1 P7 损坏 receipt → 409**：`latestPublication` 区分“publish/ 不存在 → null”与
      “publication 存在但损坏 → ArtifactIntegrityError”；坏 JSON/缺 receipt/版本非法不再被
      静默当成“没有发布”
- [x] **P1/P2 publication schema 1.1**：新发布写 `schema_version: "1.1"` + 必填
      `manifest_sha256`；旧 1.0 记录保留其 pre-P7 信任级别（package digest 校验）可继续服务；
      1.0 带 receipt 或 1.1 缺 receipt 均拒绝；golden fixtures 恢复为 1.0 无 receipt（真实
      V2 迁移期形态）
- [x] **P2 exec 完整路径展示**：`sanitizedCommand` 不再 basename executable——批准卡/audit
      显示 canonical 化后的完整可执行文件路径；参数仍脱敏
- [x] 顺手项：`JsonPermissionPolicyStore.load()` 首读 memoize（与并发 mutation 无竞态）；
      设置页可主动创建 allow/ask/deny 持久规则（表单）

验收（2026-08-17 三轮审计后）：`pnpm test`（contracts 14 + server 811 + frontend 765）/ `pnpm lint` /
`pnpm typecheck` / `pnpm build` 全通过；`uv run pytest database/tests` + ruff 通过。

---

## 跨阶段约束（所有 Phase 都必须保持）

- Pi Session ≠ BioMed Task ≠ Run ≠ DatasetBuild（ADR-019）。
- Pipeline/Core 保持受信任 Tool，不降级为纯 Skill；Validation Gate 是程序约束
  而非提示词约束（ADR-020）。
- Agent 不得直写 `artifacts/` / publications；只有 Core Publisher 可以发布。
- Pi 依赖只经 `server/agent/pi-adapter.ts`；业务代码不直接依赖 Pi 内部类型。
- 每阶段可独立回滚（Plan §24）；不同时重写前端 + Pipeline + DB + Agent Runtime。

## 独立维护项（与迁移主线并行）

- [ ] **P1** model-registry 响应未做 wire-boundary 校验：`frontend/src/api/modelRegistry.ts`
      仍用窄化 cast（`b as ProviderInfo[]` 等）。下一步为 `packages/contracts`
      runtime 增加 `parseProvidersEnvelope` / `parseManagedModelsEnvelope` 等解析器，
      与其余 endpoint 组一致（ADR-025 后续项，2026-08-14 层抽取时发现）
- [ ] **P2** Agent INSTRUCTIONS 增加"达到 max_turns 后输出 `[MAX_TURNS_REACHED]`"
      指导（原 Pipeline Design §4.5）
- [ ] **P2** 设置页供应商/模型列表分页与搜索后端支持（当前全量返回）
- [ ] **P2** `createPhase3ToolHooks()` 的 operation 并发 identity：同一来源所有
      查询共用 `operation_id: tool:<source>:query`，并发同源查询的
      started/progress/completed 会互相覆盖（UI 表现为同源多查询只有一个
      operation 总卡片）。应改为 call-scoped ID（2026-08-15 对话流时序
      修复时发现，`fix/runtime-timeline-sequence` 未包含此改动）

## 前端 UI 合规修复（shadcn 规则审查，2026-08-15）（✅ 完成，2026-08-15）

> 依据：shadcn skill 规则（styling / composition / icons / chat）与
> `frontend/DESIGN.md`。审查报告与逐条证据见 2026-08-15 会话；本清单只列
> 可勾选条目。原则：**每项改动走专用分支，一次 merge 一个完整功能单元**
> （AGENTS.md §7.2）；类名断言类测试随改动同步更新。

- [x] **P1** 修复 `shimmer` 死类：`components/ChatPanel.tsx:845`（"正在思考…"
      Marker）与 `components/ui/attachment.tsx:104`（uploading/processing 态）
      引用的 `shimmer` 类未定义（Tailwind 4.3.2 无此工具类，`global.css` 无
      定义，已核实）→ 在 `global.css` 定义 shimmer 动画并接入
      prefers-reduced-motion，或改用 Skeleton/现有动画；验收：附件上传态与
      思考态可见动画效果
- [x] **P2** 清除产品代码全部 `space-y-*/space-x-*`（35 处 / 14 文件，
      `components/ui/` 除外）→ `flex flex-col gap-*`；含
      `ModelImportSheet.tsx:821` 对 `FieldGroup`（自带 gap-5）的 `space-y-3`
      覆盖删除。文件清单：SettingsPage、settings/primitives、各 settings
      sections、UserInputDialog、ModelImportSheet/ModelListManager/
      ParameterEditor/ProviderManager、QueuedMessages、OperationStep/
      ToolCallStep、BuildResultsViewer
- [x] **P2** 移除产品代码原始颜色与 `dark:` 手动覆盖（9 文件 ~17 处）：
      emerald（AgentComposer/model-info-card/SessionSidebar）、amber
      （ModelImportSheet/ModelListManager/BuildResultsViewer/
      BuildReportCard）、sky（BuildResultsViewer/ResultsViewer）、yellow
      （WarningStep）、`dark:bg-transparent`（AgentComposer）→ 语义 token
      或 Badge 语义 variant；**同步更新 `test/session-sidebar.test.tsx` 的
      `dark:text-sky-400` / `dark:text-emerald-400` 断言**；验收：
      `grep -rn "dark:" src/components --include="*.tsx" | grep -v
      components/ui` 为空
- [x] **P2** 手写 chip 改为 `Badge`：AgentComposer（"推荐"/"图"）、
      model-info-card（"推荐"/"可用"/"接口验证"）、ContextWindowSelect
      （"推断"）、AppearanceSettingsSection（已导入字体 chip）等 5+ 处
      手写 `rounded-full bg-*/px-* text-[10-11px]` 结构
- [x] **P3** AgentComposer 模型选择器改用手写搜索列表 → 已安装的
      `Combobox` 组件（`components/ui/combobox.tsx` 已存在但未使用）；
      保留"推荐"标记与"前往设置"入口
- [x] **P3** `SettingsSearch` 手写下拉（绝对定位 `z-50`、focus/blur 定时器、
      role=listbox）→ `Popover` + `Command` 组合，消除手动 `z-50` 与
      setTimeout 管理
- [x] **P3** `settings/primitives.tsx` 手写 `SegmentedControl`（role=group +
      aria-pressed 循环按钮）→ `ToggleGroup`（先 `shadcn add toggle-group`，
      base 原语库）；替换使用处（AppearanceSettingsSection 主题模式/
      reduced-motion、EditorSettingsSection 发送模式）
- [x] **P3** 小型组件合规修补：ReasoningBlock `SpinnerGapIcon animate-spin`
      → `Spinner`；SettingsPage header 分隔 `span` → `Separator
      orientation="vertical"`；BuildResultsViewer 模板字符串 className →
      `cn()`；AgentComposer 模型搜索框绝对定位图标 → `InputGroup` +
      `InputGroupAddon`
- [x] **P4** `text-[10px]/[11px]`（17+ 处）收敛到 DESIGN.md 元数据下限
      （12px）：AgentComposer、ContextWindowSelect、model-info-card、
      SessionSidebar kbd、ModelImportSheet、primitives 滑块刻度等
- [x] **P4** 去除双流式光标：AssistantSegment/ReasoningBlock 手写
      `▋ animate-pulse` span 与 `global.css` 的
      `.markdown-content[data-streaming]::after` 光标重复 → 保留 CSS
      内置光标，删除手写 span
- [x] **P4** 主题预览卡（AppearanceSettingsSection `slate-*` 硬编码）加注释
      说明"预览需渲染真实色板"；LoadingScreen logo `animate-pulse` 决策
      （保留品牌呼吸 / 换 Skeleton，二选一并注释）

> 全量验收（每项改动合并前）：`pnpm test / lint / typecheck / build` 全通过
> （AGENTS.md §7.3）+ `pnpm dev` 冒烟无视觉回归；新行为补测试、改类名同步
> 更新既有测试；`docs/TODO.md` 勾选与 git 提交一一对应。
