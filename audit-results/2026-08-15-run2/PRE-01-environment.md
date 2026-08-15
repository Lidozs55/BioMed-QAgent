# PRE-01 环境与工作区（Run #2）

- **case_id**：PRE-01
- **Commit**：`be78a1a577a9d20cec4cefb3b604661f0187a59c`
- **日期**：2026-08-15
- **结果**：PASS（附 1 处沙箱说明，非项目缺陷）

| 检查项 | 实际 | 判定 |
| --- | --- | --- |
| Node | v22.21.0（>=22.19.0） | PASS |
| pnpm 版本 | 沙箱 EPERM（自管理全局 tools 目录被拒），pnpm 本身可用 | 说明 |
| Python | 3.14.0（>=3.12） | PASS |
| uv | 0.9.16 | PASS |
| git HEAD | be78a1a577a9d20cec4cefb3b604661f0187a59c | PASS |
| git status | 仅 `?? audit-results/`（未跟踪），无源码改动 | PASS |
| lockfile | `pnpm install --frozen-lockfile` 需沙箱外执行，见 PRE-02 | 待 PRE-02 |

## 备注

- `pnpm --version` 失败为沙箱限制（`C:\Users\lenovo\AppData\Local\pnpm\.tools`
  写入被拒），与项目无关。审计命令实际通过仓库内 `node_modules/.bin` 与
  已安装依赖运行，功能正常。
