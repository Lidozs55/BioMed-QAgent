import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,

    // 有界并发：本机默认只占少量 worker，避免测试 worker 抢满 CPU 撞功耗墙
    // （16 逻辑线程的笔记本上，Vitest 默认会按全部可用并行度启动 worker）。
    // 本地与 CI 都固定为 2，避免共享 runner 或开发机触发 CPU/功耗限制。
    //
    // server 测试大量涉及 SQLite / 文件系统 / 子进程（Python bridge、pi、
    // playwright），统一用 forks 进程池隔离，避免 worker_threads 共享进程状态
    // 互相干扰，也方便按需调低 worker 数。
    pool: "forks",
    poolOptions: {
      forks: {
        execArgv: ["--expose-gc"],
      },
    },
    maxWorkers: 2,
    maxConcurrency: 2,
  },
});
