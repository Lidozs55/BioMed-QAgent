# Agent API Quickstart

> 面向需要从脚本或其他 Agent 调用 BioMed-QAgent 的最小闭环。正式 DTO 以
> `@biomed/contracts` 和 `docs/architecture/runtime-events.md` 为准；本文不复制完整 API。

## 1. 启动与就绪

唯一正常入口位于仓库根目录：

```bash
pnpm dev
```

Host 会先绑定端口再初始化，因此 `/api/v1/health` 可能暂时返回 `503 starting`。
调用方必须有界重试，不能把端口已监听等同于 runtime ready：

```bash
node scripts/run-driver.mjs health
# 可选：--base-url http://127.0.0.1:5173 --retries 30 --delay-ms 500
```

生产构建使用 `pnpm build && pnpm start`；不要启动 Python Web Server或独立Vite作为正式入口。

## 2. 创建任务与续跑

把用户输入保存为UTF-8文件。driver会拒绝非法UTF-8、replacement character和lone surrogate：

```bash
node scripts/run-driver.mjs create --input request.txt --request-id request-demo-1
# 返回 HTTP 202及 {"task_id":"...","run_id":"..."}

node scripts/run-driver.mjs submit <task-id> --input follow-up.txt
node scripts/run-driver.mjs snapshot <task-id>
```

对应 REST：

```http
POST /api/v1/tasks
Content-Type: application/json

{"request_id":"request-demo-1","input":"...","mode":"agent"}
```

```http
POST /api/v1/tasks/{task_id}/runs
Content-Type: application/json

{"request_id":"request-demo-2","input":"..."}
```

`request_id` 是调用方提供的幂等身份。不要在已有active run时盲目重试不同request ID；先读取task snapshot。

## 3. Durable事件重放

HTTP分页读取是恢复事实的最简单方式：

```bash
node scripts/run-driver.mjs events <task-id> --after 0 --limit 100
```

每次保存最后处理的`sequence`，下一页使用`--after <sequence>`。不要用数组位置、时间戳或前端状态作为resume cursor。

实时客户端连接：

```text
ws://127.0.0.1:5173/api/v1/ws
```

发送：

```json
{"type":"subscribe","task_id":"<task-id>","after_sequence":0}
```

服务端先补发`sequence > after_sequence`的durable事件，再发送实时事件。断线重连时带最后确认的sequence；WebSocket不创建Run，也不提供SSE。

## 4. 终态、HIL与失败

- 只把`run_completed`视为成功终态；`run_failed`、`run_cancelled`、`run_interrupted`不能包装成成功。
- `user_input_required`或permission request表示受信操作已暂停。使用对应run的resume/permission REST endpoint提交决定，不要绕过它启动未审查的替代命令。
- `NO_DATA`、validation rejection和publication failure是可审计结果，不是空成功。
- Artifact只能从`GET /api/v1/tasks/{task_id}/artifacts`列出的manifest注册项下载；不要直接读取task目录猜产物。

## 5. 常用命令

```bash
node scripts/run-driver.mjs --help
node scripts/run-driver.mjs health --base-url http://127.0.0.1:5173
node scripts/run-driver.mjs create --input request.txt
node scripts/run-driver.mjs submit <task-id> --input follow-up.txt
node scripts/run-driver.mjs snapshot <task-id>
node scripts/run-driver.mjs events <task-id> --after <last-sequence> --limit 100
```

完整Task/Run/Event、HIL、permission及Artifact协议见
[`docs/architecture/runtime-events.md`](architecture/runtime-events.md)。
