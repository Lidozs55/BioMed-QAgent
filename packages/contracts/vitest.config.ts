import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 纯 TS 契约测试，轻量且无子进程/文件系统依赖，threads 池足够；
    // 只有 3 个测试文件，worker 压到 2 即可。CI（CI=true）才放开。
    pool: "threads",
    maxWorkers: process.env.CI ? "75%" : 2,
    maxConcurrency: process.env.CI ? 4 : 2,
  },
});
