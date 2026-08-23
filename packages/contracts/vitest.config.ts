import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 纯 TS 契约测试，轻量且无子进程/文件系统依赖，threads 池足够；
    // worker 与文件内并发均固定为 2，CI 也不放宽共享 CPU 预算。
    pool: "threads",
    maxWorkers: 2,
    maxConcurrency: 2,
  },
});
