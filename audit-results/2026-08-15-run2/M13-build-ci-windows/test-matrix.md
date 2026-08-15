# M13 测试矩阵

- Commit: be78a1a577a9d20cec4cefb3b604661f0187a59c
- 环境: Windows / Node 24.19

| Case | 结果 | 证据 |
| --- | --- | --- |
| M13-T01 | PASS | 隔离 worktree `pnpm install --frozen-lockfile` + build |
| M13-T02 | PASS | PRE-02 全绿 |
| M13-T03 | PASS | Windows 本机跑全部 server/database 测试通过 |
| M13-T04 | PASS | package/tsconfig 结构（静态） |
| M13-T05 | PASS | PRE-04 生产 `pnpm start` health/root/databases 200 |
| M13-T06 | PASS | `host.test.ts`、`vite-middleware.test.ts`、静态中间件 |
| M13-T07 | PASS | package version、构建产物 hash（静态） |
| M13-T08 | PASS | `.github/workflows/ci.yml`：workspace/database/windows 三 job，无 backend job |
