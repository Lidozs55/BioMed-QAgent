# Test Concurrency Budget

> 2026-08 测试并发调优：本地与 CI 的全量测试在任一时刻统一限制为最多 **2** 个测试 worker，避免开发机和共享 runner 触发 CPU/功耗限制。

## 为什么

Vitest 非 watch 模式默认按 `os.availableParallelism()` 启动 worker。根目录递归执行多个 workspace 时，如果每层独立扩池，会形成：

```text
workspace 并发 × vitest workers × test.concurrent
```

这会瞬间吃满 CPU、触发功耗墙或共享 runner 限流，并放大 timing-sensitive 测试抖动。仓库默认因此采用固定值 2，而不是按机器核数或百分比自动扩大。

## 当前预算

| 层 | 控制 | 本地与 CI 默认值 |
| --- | --- | --- |
| workspace 并发 | 根 `package.json` 的 `test` / `test:full` | 1（workspace 顺序执行） |
| server | `server/vitest.config.ts`，forks pool | 2 workers / 2 concurrent |
| frontend | `frontend/vitest.config.ts`，threads pool | 2 workers / 2 concurrent |
| contracts | `packages/contracts/vitest.config.ts`，threads pool | 2 workers / 2 concurrent |

`pnpm test` 与 `pnpm test:full` 都遵守同一上限；`test:full` 表示运行完整测试集合，不再表示解除并发限制。workspace 必须顺序执行，否则两个 workspace 各自启动 2 个 worker 时，全机实际会同时运行 4 个 worker，违反总预算。

## 选型依据

- **server → forks**：server 测试涉及 SQLite、文件系统和子进程，fork 隔离更稳。
- **frontend / contracts → threads**：纯 TS/jsdom 使用 threads，但 worker 数仍固定为 2。
- **`maxConcurrency=2`**：同时限制测试文件内部的 `test.concurrent`。

## 临时覆盖

排查单个 timing-sensitive 测试时可以进一步降低，例如：

```bash
pnpm --filter @biomed/server test -- --maxWorkers=1 --maxConcurrency=1
```

不得在日常 full gate 或 CI 中把并发提高到 2 以上；如果未来需要提高，必须先提交代表性耗时、CPU 和 flaky-rate 证据，并同步本文及三个 Vitest 配置。

## 原则

> 全量测试默认在全机范围最多并行 2 个测试 worker；focused 单文件测试可正常运行，但仍不得通过额外参数把 worker/concurrency 提高到 2 以上。
