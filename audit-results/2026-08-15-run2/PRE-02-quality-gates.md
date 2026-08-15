# 公共预检 PRE-02 全局质量门禁记录（Run #2）

- 基线 commit: be78a1a577a9d20cec4cefb3b604661f0187a59c
- 日期: 2026-08-15
- 运行方式: 隔离 worktree `BioMed-QAgent-audit-run2` 内、沙箱外执行
- pnpm: 捆绑 fallback 11.19.0

## Node 工作区

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | PASS：contracts 14/14；server 68 文件 722 通过、11 跳过；frontend 55 文件 736/736 |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS（前端为 `tsc -b` 真实门禁） |
| `pnpm build` | PASS |

## Python DB bridge

| 命令 | 结果 |
| --- | --- |
| `uv run python database/bridge.py --self-test` | OK |
| `uv run pytest database/tests` | 79 passed |
| `uv run ruff check database` | All checks passed |

## 说明

- 已迁移 Run #1 的项目加固（事件日志损坏 fail-closed + 4 条回归测试）并在本基线验证通过，故 server/frontend 计数高于纯新基线（714/735 -> 722/736）。
