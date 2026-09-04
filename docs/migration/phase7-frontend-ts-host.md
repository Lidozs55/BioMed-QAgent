# Phase 7：Frontend → TypeScript Host 正式切换

日期：2026-08-14
状态：完成

## 1. 结论

正式默认 profile 已从 `ts/legacy/python/1` 切换为：

```text
APP_HOST=ts
AGENT_RUNTIME=pi
DATASET_CORE=ts
PI_EXPERIMENTAL=0
```

浏览器仍只访问 TS Host 的单一公开端口。默认启动不创建 Uvicorn/FastAPI 子进程；
Python 只保留由 TS `DatabaseClient` 按需管理的 `database/bridge.py` 命名操作进程。
legacy Agent、Python Dataset Core 与 experimental Pi 仍保留一个发布周期的显式回滚。

## 2. 默认所有权

| 能力 | 默认权威实现 |
| --- | --- |
| Vite/HMR 与静态前端 | TS Application Host |
| Task/Run admission、event log、reducer、HTTP/WS replay | `server/src/runtime/` |
| Pi Session、steer、compact、cancel、HIL resume | `server/src/agent/` + TS durable runtime |
| Dataset validation/execution/publication | `server/src/dataset/` |
| 模型设置、provider/model registry | `server/src/settings/model-settings.ts` |
| health、databases、personalization、builds、artifacts、cache | `server/src/product/` |
| 本地 cache/声明式数据库持久化 | TS DB client → `database/bridge.py` |
| 浏览器采集 | 共享 `NodeBrowserPool` |

`createBootstrapOptions` 是默认组合根：同一个 `DatabaseClient` 与
`NodeBrowserPool` 被 product API、Pi tools 和 runtime 共享，并由 Host lifecycle
统一关闭。没有 rollback proxy 时，未匹配的 `/api/v1/*` 明确返回 404。

## 3. FastAPI 回滚边界

以下任一条件成立时才创建 private FastAPI：

- `AGENT_RUNTIME=legacy`
- `DATASET_CORE=python`
- `PI_EXPERIMENTAL=1`

`DATASET_CORE=python` 继续经受保护的 loopback named-operation bridge 执行；
`AGENT_RUNTIME=legacy` 将 formal API/WS 回退给 FastAPI。回滚不会删除或改写
`task_ts_*` 的 events、Pi session、Build 或 publication。

## 4. API 兼容

TS Host 原生覆盖前端使用的 formal surface：

- durable tasks、imports、runs、cancel、resume、steer、compact、messages、events；
- task/build artifact 列表与下载，含路径、realpath、size 与 SHA-256 校验；
- settings、vendors、models、model registry；
- databases CRUD 与 enable/disable；
- builds、cache dataset detail/artifacts/export、personalization、health。

不支持的 subagent identity 返回 404；已知资源上的不支持方法返回 405。上传在启动
Pi session 前完成大小、文件名与 hash 校验，并先落入 Task `source_assets/`。

## 5. 验收证据

| 验收项 | 自动化证据 |
| --- | --- |
| 默认切换、无 FastAPI bootstrap | `server/tests/config.test.ts`、`bootstrap.test.ts`、`host.test.ts` |
| 多轮对话、steer、compact、删除、import | `server/tests/durable-agent-runtime.test.ts` |
| 取消与 terminal acknowledgement | `server/tests/durable-agent-runtime.test.ts`、`phase5/ts-core-e2e.test.ts` |
| HIL 恢复 | `server/tests/phase5/approval-gate.test.ts` |
| 断线重连与 replay watermark | `server/tests/durable-agent-runtime.test.ts`、`frontend/src/test/agent-stream.test.ts` |
| DatasetBuild 与四类结果 | `server/tests/phase5/ts-core-e2e.test.ts` |
| artifact / build / cache / databases / health | `server/tests/product-api.test.ts` |
| settings 与 credential masking | `server/tests/model-settings.test.ts` |
| 浏览器与视觉采集 | `server/tests/phase5/browser.test.ts`、`web-visual-capture.test.ts` |
| 重启异常恢复 | `server/tests/durable-runtime.test.ts`、`phase5/db-bridge.test.ts` |
| Python Core 回滚纵切 | `server/tests/phase1f-e2e.test.ts` |

生产 ESM 启动还要求 adapter registry 不形成 top-level-await 循环：共享
`SourceAdapter` 边界位于 `server/src/dataset/adapters/base.ts`，GEO adapter 与
registry 只通过该无环基座组合；`server/tests/dataset-adapter-module-graph.test.ts`
锁定这一约束，真实 `node server/dist/index.js` smoke 验证默认与 rollback 拓扑。

仓库最终门禁为根 `pnpm test / lint / typecheck / build`、backend `uv run pytest`
与 Ruff，以及默认 Host、private FastAPI 和显式 rollback 启动 smoke。

## 6. Phase 8 前保留项

Phase 7 只改变默认所有权，不物理删除 legacy Python runtime。FastAPI、OpenAI Agents
SDK runtime、Python Dataset Core 与对应 tests 在 Phase 8 完成前继续作为回滚资产；
默认路径不得新增对这些模块的依赖。
