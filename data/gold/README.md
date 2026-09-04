# `data/gold` 评测与正式重跑指南

本目录存放参考输入/输出案例（`gold1`～`gold10`），用于端到端评测与论文实验。

- 参考输出不是唯一正确答案：其数据源与清洗方法仅作事后对照参考。
- 评测中发现的问题**只记录、不修复**：现象与分析写入 `runs-log.md`（或 `docs/evaluation/`）；仅当问题非常明显且修改方法确定时才落地修改代码。

## 案例结构

每个 `gold<N>_*` 目录：

- `TOPIC.txt` — 用户需求原文，**唯一合法的任务输入**。
- 参考 CSV / JSON 与 `provenance.json` — 仅用于事后对照。
- `raw/` — 原始 API 响应存档，仅用于核对，**严禁**喂给 Agent。

## 运行约束

- 模型统一为 qwen3.8 系列（当前 qwen3.8-flash + 思考模式），上下文窗口 1M。
- 输入只允许 `TOPIC.txt` 原文；严禁混入参考 CSV、`provenance.json`、`raw/` 内容，绝对禁止以参考数据冒充 Run 产物。
- 多个 gold 可并发评测；每次 Run 的记录追加到 `data/gold/<case>/runs-log.md`。

## 运行方式

任务通过 `POST /api/v1/tasks` 创建，输入直接使用真实研究问题——该自动启动的 Run **就是**被评测的 Run。不要创建额外的 Bootstrap 任务（哨兵文本会残留在会话历史中影响评测）。

Supervisor（`scripts/gold-formal-supervisor.mjs`，经 `pnpm gold:supervise` 调用）负责驱动 Run 并采集证据；Agent 会话由 Host 掌控，Supervisor 只等待终止状态：

```bash
pnpm gold:supervise -- \
  --base-url http://127.0.0.1:5173 \
  --task-id task_ts_... \
  --request-id gold-rerun-gold1-... \
  --prompt-file path/to/prompt.txt \
  --evidence-dir data/gold/evidence/gold1 \
  --case-label gold1 \
  --expected-commit <host-commit-sha>
```

- `--adopt`：挂载到任务当前（或最新）Run 记录事件，而不是自己 POST 新 Run；此时不需要 `--prompt-file`。
- `--resume`：仅在人工介入处理后，复用原 Run 与游标续跑，绝不发起第二次 POST。
- `--timeout`（毫秒）为全局墙钟超时；`--page-size` 控制事件分页。
- `--expected-commit`：冻结的产品 Commit，与 Host 一致才允许运行。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功闭合（产物经 SHA-256 校验） |
| 2 | 参数错误 |
| 10 / 11 / 12 | Health / 任务 / 活跃 Run 检查失败 |
| 20 | 权限策略外请求，fail-closed 阻断 |
| 21 | `data_review` 请求，等待人工处理 |
| 30 / 31 / 32 / 33 | Run 终止失败 / 产物校验失败 / 超时 / 协议错误 |

**人工介入（退出码 21）**：`kind=data_review` 及 `browser_evidence_acceptance`、`publication_acceptance` 请求不会被自动处理，Supervisor 写入 `HIL-STOP.json` 后以 21 退出。人工在 Host 解决请求后，将决策（`request_id`、Host 提供的 `evidence_digest`、`decision`、可选 `reason`）记录到证据目录的 `human-review.jsonl`，再用 `--resume` 重跑同一命令。

## 单实例要求

任务根目录（`data/output/tasks/`）同一时间只允许**一个**活跃 Host 进程：多个活跃实例会互相把对方不知情的 Run 标记为 `run_interrupted`，并损坏 `events.jsonl`。启动 Host 或挂载 Supervisor 前，确认没有其他实例（dev 或 `--static`）正在服务同一数据目录；永远不要"为了安全起见"多开一个实例。
