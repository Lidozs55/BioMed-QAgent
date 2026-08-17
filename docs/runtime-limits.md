# 运行限制配置

运行限制通过 `GET/PUT /api/v1/settings` 的 `runtime_limits` 字段管理，设置页入口为
**Agent -> 运行限制**。共享类型、默认值和合法范围定义在
`packages/contracts/src/settings.ts`，服务端不得复制另一套默认表。

## 设计边界

- 限制是运行预算，不是安全策略。路径权限、敏感文件保护、SSRF、来源校验、内容
  hash、Publication 完整性和 Validation Gate 不可通过该设置关闭。
- 设置保存后由新 Task Workspace / Run 创建时读取快照；不改变正在执行的 deadline。
- API 使用秒、KiB、MiB等面向用户的单位；执行器仅在边界换算为毫秒或字节。
- `runtime_limits: null` 恢复服务端推荐默认值。部分更新只修改显式字段；未知字段、
  非整数和越界值返回 422，且不会产生部分写入。
- 配置带内部版本号。旧 `model-registry.json` 尚无版本号时整体迁移到当前推荐默认值，
  避免历史 30 秒 HTTP / 120 秒浏览器值继续覆盖放宽后的默认；新版本缺失或非法字段
  则按当前默认逐项补齐。

## 当前字段

| 字段 | 默认 | 范围 | 主要消费者 |
| --- | ---: | ---: | --- |
| `command_timeout_seconds` | 600 s | 1-86,400 | `workspace_exec` 默认 deadline |
| `command_output_kib` | 256 KiB | 64-16,384 | stdout/stderr返回预算 |
| `workspace_read_kib` | 256 KiB | 64-16,384 | Workspace读取 |
| `workspace_write_kib` | 1,024 KiB | 256-65,536 | Workspace写入/编辑 |
| `workspace_search_file_mib` | 16 MiB | 1-1,024 | 单文件搜索扫描 |
| `workspace_search_max_files` | 2,000 | 100-100,000 | 单次搜索文件数 |
| `http_timeout_seconds` | 300 s | 5-3,600 | 普通外部API请求 |
| `download_timeout_seconds` | 3,600 s | 60-86,400 | acquisition与网页文件下载 |
| `browser_timeout_seconds` | 300 s | 10-3,600 | Playwright导航/截图/回退 |
| `dataset_operation_timeout_seconds` | 3,600 s | 60-86,400 | TS Dataset Core operation |
| `database_timeout_seconds` | 600 s | 10-3,600 | DB bridge与声明式数据库 |
| `max_download_mib` | 8,192 MiB | 64-65,536 | GEO/GDC/Xena/PubMed及来源下载 |
| `gdc_max_files` | 50 | 1-1,000 | 单次GDC文件预算 |
| `request_interval_ms` | 500 ms | 0-10,000 | 通用来源同host pacing |

NCBI 等来源的官方配额仍可采用更严格的专用 pacing。通用限流统一复用
`AsyncHostRateLimiter`；不得再新增模块级时间戳或无串行 lane 的自制限流器。

## 命令执行

模型可见参数为 `timeout_seconds`，默认采用设置值，最大24小时。内部
`WorkspaceExecResult.durationMs` 和 Node timer 仍使用毫秒。参数数组最多1,000项，
单参数最多65,536字符；NUL、shell元字符、权限检查、进程树清理和环境变量白名单
仍属于安全边界。
