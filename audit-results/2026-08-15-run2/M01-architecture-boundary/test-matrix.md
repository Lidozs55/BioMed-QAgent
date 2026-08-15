# M01 测试矩阵

- Commit: be78a1a577a9d20cec4cefb3b604661f0187a59c
- 环境: Windows / Node 24.19 / pnpm 11.19 / Python 3.13

| Case | 结果 | 证据 |
| --- | --- | --- |
| M01-T01 | PASS | `git ls-files backend` 为空 |
| M01-T02 | PASS | PRE-03 扫描：active source 无 FastAPI/Uvicorn/legacy flag |
| M01-T03 | PASS | package.json scripts 无 dev:legacy-* |
| M01-T04 | PASS | database/*.py 仅 stdlib；`uv run pytest database/tests` 79 通过（含 forbidden-import） |
| M01-T05 | PASS | rg 无 Pi 业务工具 spawn Python；db-client.ts 为唯一合法 bridge |
| M01-T06 | PASS | PRE-04 生产启动仅 TS Host（无 Python HTTP server） |
| M01-T07 | PASS | PRE-04 生产 root 为静态 HTML（无 Vite HMR） |
| M01-T08 | PASS | 唯一命中 .env.example:22 为说明性注释（文档历史引用） |
