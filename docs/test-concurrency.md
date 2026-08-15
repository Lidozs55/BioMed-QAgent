# Test Concurrency Budget

> 2026-08 测试并发调优：本地默认**有界并发**，CI 才允许扩大 worker pool。

## 为什么

Vitest 非 watch 模式默认按 `os.availableParallelism()` 启动 worker。根目录
`pnpm test` 又是 `pnpm -r`（默认 4 个 workspace 并发），叠加后很容易出现：

```text
workspace 并发 × vitest workers ≈ 4 × 16 = 64 个执行线程
```

笔记本上会瞬间吃满 Package Power → 功耗墙 → 全核降频，更热且未必更快。

## 当前预算（本机默认）

| 层 | 控制 | 默认值 | CI（`CI=true`） |
| --- | --- | --- | --- |
| workspace 并发 | 根 `package.json` `test` 脚本 `--workspace-concurrency=2` | 2 | 2 |
| server | `server/vitest.config.ts` `pool: "forks"` | 2 workers / 4 concurrent | 75% / 8 |
| frontend | `frontend/vitest.config.ts` `pool: "threads"` | 4 workers / 4 concurrent | 75% / 8 |
| contracts | `packages/contracts/vitest.config.ts` `pool: "threads"` | 2 workers / 2 concurrent | 75% / 4 |

最大活跃执行单元 ≈ 2 workspace × 2~4 worker ≈ 4~8，远低于 64。

## 选型依据

- **server → forks**：server 测试大量涉及 SQLite / 文件系统 / 子进程
  （Python bridge、pi、playwright、真实 child process），fork 进程池隔离
  更稳，且便于按需降 worker。
- **frontend / contracts → threads**：纯 TS / jsdom 无子进程，threads 更快。
- **`maxConcurrency`**：限制测试文件内部 `test.concurrent` 的并行度。

## 如何覆盖

- 本地全速（不推荐日常用）：`pnpm test:full`（去掉 workspace 并发限制；
  vitest 层仍看 `CI` 环境变量）。
- CI（GitHub Actions 自带 `CI=true`）自动放开 vitest worker 上限。
- 临时降速：`pnpm --filter @biomed/server test -- --maxWorkers=1` 等
  vitest CLI 参数直接透传。

## 原则

> 本地测试默认不允许按照 `os.availableParallelism()` 吃满 CPU；CI 才允许
> 扩大 worker pool。固定值（而非百分比）保证不同开发机行为一致。
