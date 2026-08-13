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
| 2 | 迁移 Skills 与通用 Agent 工具 | ⬜ **下一阶段** |
| 3 | 拆出 TS Application Runtime | ✅ 完成（opt-in，2026-08-12） |
| 4 | 迁移 Dataset Deterministic Core | ✅ 完成（2026-08-13；运行接线待后续阶段） |
| 5 | 迁外部能力与 Python 数据处理依赖 | ⬜ 待开始 |
| 6 | 迁模型设置与 Settings API | ⬜ 待开始 |
| 7 | 正式切换 Frontend → TS Host | ⬜ 待开始 |
| 8 | 删除 Python Runtime（仅留 DB bridge） | ⬜ 待开始 |

默认 profile 仍是 `APP_HOST=ts / AGENT_RUNTIME=legacy / DATASET_CORE=python`；
Phase 3 需显式 `AGENT_RUNTIME=pi` 才接管正式 Task 流量。实际执行顺序为 0 → 1 → 3 →
4（TS Core 已移植、尚未接入运行路径）→ Phase 2。feature-flag 回滚顺序与迁移期约束
见 Plan §24；Phase 8 后删除 flag 与 legacy 代码。

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

## Phase 2：迁移 Skills 与通用 Agent 工具（⬜ 下一阶段）

> 目标：`backend/app/skills/builtin/*` 内容迁至 `.pi/skills/*`；停用自制 Skill
> Catalog/Gateway/Registry；业务 Tool 注册为 Pi Extensions。验收见 Plan §20 Phase 2。

- [ ] `backend/app/skills/builtin/*` → `.pi/skills/*` 内容迁移（当前 `.pi/skills/`
      仅 `dataset-construction` 与 `migration-smoke`）
- [ ] 业务 Tool（PubMed / GEO / GDC / Xena / PDB / cache / …）改注册为 Pi Extensions，
      建立 Skill ↔ Tool 稳定名称映射
- [ ] 停用并删除 `SkillCatalog` / `SkillGateway` / `SkillRegistry` /
      `LLMRerankingSkillSearchStrategy` / `UserSkillStore`
- [ ] learned skill 默认禁用规则：确定 Pi 侧替代方案或明确删除
- [ ] 决策：Skill 管理 UI / `/api/v1/skills` 的去向（store.py → 极薄 UI adapter 或退役）
- [ ] 验收：Main Agent 不再调用 `find_skill`/`invoke_skill` 自制网关；
      Pi 能按任务加载相关 Skill；Skill 缺失不导致 Runtime 崩溃

## Phase 3：拆出 TS Application Runtime（✅ opt-in 完成）

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
- [ ] 正式默认切换 `AGENT_RUNTIME=pi`——待 Phase 2 Skills 与跨阶段集成门禁完成后执行。

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

**遗留（属 TS Host 集成，非 Phase 4 范围）**：TS executor 为同步实现，operation
超时 / build 锁 / 事件投影（event sink）等运行时基础设施尚未接入运行路径；
`DATASET_CORE` 目前只读入配置、未切换行为（默认仍走 Python V2 Core）。这些接线
与 Phase 7 前端切换一并推进。

远程分支 `codex/phase4-dataset-core-ts` 已合入 main，无需另行跟踪。

## Phase 5：迁外部能力与 Python 数据处理依赖（⬜ 待开始）

> 注意区分：**旧设计主线**的 Phase 5 GEO（Python 侧 Provider/Adapter 拆分、多 GSE
> 独立发布、sample metadata）已合入 main（dfa668a，清单见归档文件）；本节是
> **迁移方案** Phase 5——把 GEO 等外部能力迁到 TypeScript，尚未开始。

> 每项必须有 live + fixture 双测试；不允许一次删掉全部 Python 科学依赖后再调试。

- [ ] Playwright → Node Playwright；crawler → TS HTTP/browser acquisition
- [ ] GEO / GDC / Xena / PubMed acquisition 迁 TS（保留 URL allow/deny、redirect 检查、
      下载大小、超时、rate limit、来源日志策略）
- [ ] PDF（pdfplumber）、表格解析、统计/绘图（SciPy/matplotlib/seaborn）：先选型
      验证 TS/CLI 方案，逐项 fixture parity 后退役
- [ ] 验收：backend Python 不再承担 acquisition / parsing / analysis，仅 DB bridge

## Phase 6：迁模型设置与 Settings API（⬜ 待开始）

- [ ] TS model settings + Pi ModelRegistry/AuthStorage adapter：provider credentials、
      custom OpenAI-compatible provider、参数 profile 转 Pi 可消费结构
- [ ] 旧 `model_registry.db` 一次性迁移；API Key 不以明文返回前端
- [ ] 验收：设置页可创建 provider / 导入模型 / 设 active model；不同模型参数正确
      传给 Pi/provider

## Phase 7：正式切换 Frontend → TS Host（⬜ 待开始）

- [ ] frontend 全量流量切 TS Host，保持 API 兼容一轮发布；FastAPI 保留为 feature-flag
      回滚路径，默认关闭
- [ ] 验收：完整 E2E——多轮对话 / 取消 / 恢复 / 断线重连 / 构建 / artifact 下载 /
      cache / settings / 浏览器能力 / 异常恢复

## Phase 8：删除 Python Runtime（⬜ 待开始）

> 前提：对应职责已迁移（Phase 2-7 完成）。删除清单见 Plan §20 Phase 8。

- [ ] 删除 `backend/app/{agent_loop,runtime,subagents,skills,pipeline,datasets,tools,api,main.py}`
- [ ] 清理 FastAPI / uvicorn / openai-agents / httpx / Playwright Python / pdfplumber /
      matplotlib / scipy / seaborn 与旧 Python tests
- [ ] 最终 Python 仅留 `database/` bridge（JSONL stdin/stdout 命名操作，由 TS Host
      管理生命周期，Plan §15）
- [ ] 验收：`pnpm test / lint / typecheck / build` 全通过 +
      `uv run python database/bridge.py --self-test`；产品启动不再需要 Python Web Server

---

## 跨阶段约束（所有 Phase 都必须保持）

- Pi Session ≠ BioMed Task ≠ Run ≠ DatasetBuild（ADR-019）。
- Pipeline/Core 保持受信任 Tool，不降级为纯 Skill；Validation Gate 是程序约束
  而非提示词约束（ADR-020）。
- Agent 不得直写 `artifacts/` / publications；只有 Core Publisher 可以发布。
- Pi 依赖只经 `server/agent/pi-adapter.ts`；业务代码不直接依赖 Pi 内部类型。
- 每阶段可独立回滚（Plan §24）；不同时重写前端 + Pipeline + DB + Agent Runtime。

## 独立维护项（与迁移主线并行）

- [ ] **P2** Agent INSTRUCTIONS 增加"达到 max_turns 后输出 `[MAX_TURNS_REACHED]`"
      指导（原 Pipeline Design §4.5）
- [ ] **P2** 设置页供应商/模型列表分页与搜索后端支持（当前全量返回）
