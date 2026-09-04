# 运行限制配置

运行限制通过 `GET/PUT /api/v1/settings` 的 `runtime_limits` 字段管理，设置页入口为
**Agent -> 运行限制**。共享类型、默认值和合法范围定义在
`packages/contracts/src/settings.ts`，服务端不得复制另一套默认表。

## 设计边界

- 限制是运行预算，不是安全策略。路径权限、敏感文件保护、SSRF、来源校验、内容
  hash、Publication 完整性和 Validation Gate 不可通过该设置关闭。
- 设置保存后由每个新 Run 创建时读取一次快照；不改变正在执行的 deadline。同一 Task
  的后续 Run 会重建 run-scoped workspace/tools/HIL 与 Agent runtime 配置，并通过同一
  `sessionDir` 继续最近的持久 Pi 对话；task-scope 临时授权保留，已结束 Run 的授权清除。
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
| `request_interval_ms` | 500 ms | 0-10,000 | 通用来源同 host pacing；Core acquisition 重试基础退避 |
| `model_request_timeout_seconds` | 120 s | 10-3,600 | VLM、HIL LLM 预审、模型发现、技能迭代单次模型请求 |
| `acquisition_max_attempts` | 3 | 1-10 | Core acquisition 总尝试次数 |
| `model_provider_max_retries` | 6 | 0-20 | Pi SDK 单次供应商请求重试 |
| `model_recovery_max_attempts` | 3 | 0-10 | durable stream / provider 耗尽后的恢复轮次 |
| `model_retry_base_delay_ms` | 3,000 ms | 0-60,000 | Pi 请求重试与 durable 恢复指数退避基数 |
| `model_retry_max_delay_ms` | 60,000 ms | 1,000-600,000 | Pi 最大重试延迟与耗尽后恢复延迟 |
| `vlm_max_attempts` | 3 | 1-10 | 单个视觉页面请求总尝试次数 |
| `vlm_retry_base_delay_ms` | 1,000 ms | 0-60,000 | 视觉请求指数退避基数 |
| `vlm_pdf_max_pages` | 12 | 1-100 | 每份 PDF 最多渲染的候选/回退页 |
| `vlm_pdf_max_images` | 10 | 1-100 | 探索路线每份 PDF 最多抽取的内嵌图片 |
| `vlm_render_dpi` | 216 DPI | 72-300 | 普通与 registered-paper PDF 页面渲染 |
| `api_response_max_mib` | 16 MiB | 1-256 | 六类 JSON 工具响应的 Host 收紧上限 |

NCBI 等来源的官方配额仍可采用更严格的专用 pacing。通用限流统一复用
`AsyncHostRateLimiter`；不得再新增模块级时间戳或无串行 lane 的自制限流器。
Core acquisition 以 `request_interval_ms` 为基础做可取消指数退避，并在 30 秒封顶。
`api_response_max_mib` 只能收紧，实际上限始终为
`min(工具固有安全上限, api_response_max_mib)`，不能借设置放宽工具自己的边界。

## 模型与视觉参数语义

- `model_provider_*`、`model_recovery_*` 与 `vlm_*retry*` 由
  `modelRetryPolicyFromRuntimeLimits()` 派生为同一策略对象，分别供 Pi SDK、durable
  recovery 和 VLM 客户端消费；不得在调用层复制另一套默认次数或退避值。
- 视觉 Temperature 不新增重复的全局运行限制。每次提取使用所选 managed vision
  model 的 `params.temperature`；未设置时兼容默认 `0.1`。模型角色变更在下一次提取时
  生效，正在运行的请求不被改写。
- Run 创建时快照模型请求 deadline、重试策略和 PDF 页/图/DPI 预算。模型列表发现是
  设置页即时操作，按调用时的当前 `model_request_timeout_seconds` 执行。
- governed registered-paper 路线把实际 Temperature、DPI、页数写入 extraction carrier、
  transform step 和参数摘要；普通视觉路线也把 Temperature、页/图/DPI 写入
  `extraction_parameters`，因此调整这些参数会改变正式候选身份，不会静默复用旧证据。

## Host 级部署预算（不走 Web settings）

以下值描述一个 Application Host 进程的机器资源，启动时由 `parseHostConfig()` 严格
解析；它们不是多用户/任务级设置：

| 环境变量 | 默认 | 约束 | 消费者 |
| --- | ---: | ---: | --- |
| `BROWSER_MAX_CONTEXTS` | 4 | 正安全整数 | Host 共享 Playwright BrowserContext 并发 |
| `EVENT_CACHE_MAX_BYTES` | 268,435,456 (256 MiB) | 正安全整数 | `DurableTaskRepository` 解析事件缓存预算 |

默认值集中在 `server/src/host-resource-limits.ts`，Host parser、浏览器池和任务仓库均
复用该单源。bootstrap 为正式 runtime 与技能迭代注入同一个
`DurableTaskRepository`，因此一个 Host 只有一份解析事件缓存和一份总预算，而不是每个
API surface 各自获得完整额度。

任务导入上限（10 个文件、单文件 500 MiB、合计 2 GiB）不是 Host env：它们是固定的
协议/安全闸，集中定义在 `packages/contracts/src/upload-limits.ts`，前端只做同值的提前
UX 拒绝，Application Host 始终作权威校验。这样既消除前后端复制，也不允许部署变量
在客户端未知的情况下放宽服务端上传边界。

## 命令执行

模型可见参数为 `timeout_seconds`，默认采用设置值，最大24小时。内部
`WorkspaceExecResult.durationMs` 和 Node timer 仍使用毫秒。参数数组最多1,000项，
单参数最多65,536字符；NUL、shell元字符、权限检查、进程树清理和环境变量白名单
仍属于安全边界。

## 浏览器渲染资源闸（代码级，不走 settings）

渲染器工作集没有内建上限：数百 MB 的数据文件被当作页面导航（2026-08-28
gold9 事故：agent 对 Orphadata `en_product1.xml` 整库 XML 调
`navigate_page`）会在单个渲染进程内膨胀成约 10 倍体积的 DOM 树、占满单核，
并把渲染进程卡死到 close 都无法应答——单 renderer 常驻 ~10.6 GB，run 挂死、
cancel 无法确认、并发槽位泄漏。因此在 `server/src/external/browser/pool.ts`
加入以下代码级闸门（与 `runtime_limits` 设置无关）：

- 主帧导航在传输前按 URL 路径后缀拒绝数据文件（`.xml/.pdf/.zip/.gz/.tgz/
  .tar/.7z/.rar/.bz2/.xz`，后缀匹配覆盖 `.vcf.gz` 等）；按响应
  `content-type` 拒绝 XML/PDF/压缩包/`application/octet-stream` 与 `*+xml`；
  声明 `content-length` 超过 `MAX_BROWSER_MAINFRAME_BYTES`（50 MiB）同样拒
  绝。错误信息引导改走 `download_from_page`。
- `route.fetch` 每跳受导航超时约束，停滞的主帧传输不会超出操作生命周期。
- `page/context.close` 由 `settleWithin` 限时（`SESSION_CLOSE_TIMEOUT_MS`
  = 5 s）兜底：卡死的渲染进程不再挂起工具调用或泄漏槽位。
- 启动参数 `DEFAULT_BROWSER_LAUNCH_ARGS` 以
  `--js-flags=--max-old-space-size=2048` 封顶渲染器 V8 堆，JS 堆炸弹以
  "Page crashed" 干净失败而非吃满系统。

已知残余边界：主帧 body 在 MIME/size 闸门前仍会完整缓冲一次（Node 侧瞬时
峰值约等于响应体大小）；iframe 子帧导航不经过该闸门。
