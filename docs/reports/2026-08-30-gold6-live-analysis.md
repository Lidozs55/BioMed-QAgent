# Gold6 live 修复与未闭环问题分析（2026-08-30）

## 结论

本轮按用户指令终止。**Gold6 未完成，不能声明通过。** 截止终止时，没有任何 live run
产生不可变 `DatasetPublication`，因此也没有可提交的 ProductAssessment、B3 最终报告、
Manifest 下载闭包或 Artifact API SHA-256 复算证据。

本轮完成并验证了多项生产路径修复；非 Gold fixture 的六表 E2E 可以发布并复算 artifact
hash，但这只能证明实现能力，不能替代 live Gold6 证据。

## 运行边界

- 模型：`gpt-5.6-terra`，`reasoning_effort=high`。
- Provider：用户指定的 OpenAI-compatible endpoint；密钥只保存在本地设置，未写入报告、
  Git diff 或日志摘要。
- 最终实现提交（写报告前）：`b52dcebd`。
- 分支：`fix/gold6-checksum-eol`。
- 运行约束：每次 live 证据期仅启动一个 Host；data root 为仓库 `data/`。
- 监督：`scripts/gold-formal-supervisor.mjs`；证据目录为
  `data/gold/evidence/gold6-20260830-terra-high-*`（Git ignored）。

## 已完成的实现与验证

1. 冻结 Gold fixture checksum，修复 CRLF/LF 导致的字节校验漂移。
2. 建立 `literature_experiment_chart.release.v1` 六表 profile：
   `paper_records`、`experiment_records`、`activity_value_records`、`chart_series`、
   `chart_points`、`supplementary_asset_records`。
3. 接通 supplementary archive member、registered parser、JATS/XML 与正式 VLM evidence asset
   的 provenance 闭包；禁止 browser/workspace staging 冒充 Core carrier。
4. 动态 prepare/submit 改为 receipt-first、receipt-only 提交；修复 prepare envelope 往返。
5. 串行执行 VLM 工具，避免并发 blocking HIL 相互覆盖。
6. 修复 PubMed scaffold entities、dynamic route 选择与错误 static fallback。
7. 修复 transform output locator admission，并让 OperationResult 声明实际运行时 locator。
8. Agent-facing 动态 source binding 改为 strict-tool-safe entries 数组，并在进入 Core 前归一化
   为 map，避免 strict function schema 把动态键封死。
9. 明确 CSV 全字段双引号、SourceLocator 2.0 `image_bbox` / `json_pointer` 精确 wire，禁止
   `locator`、`source_logical_file`、`source_raw_value` 等伪字段。
10. 增加 429/503 正常重试耗尽后的同-run 隐藏 continuation；补充
    `stream_read_error` 与 `response.completed` 前精确流断开恢复。
11. 非 Gold `literature-experiment-chart-e2e.test.ts` 已通过六表 Publication 与 Artifact
    SHA-256 校验。

最终代码内容通过：

- workspace lint、typecheck、build；
- workspace foundation 与 docs link check；
- server 全量：199 个文件中 197 passed、2 个 live smoke skipped；1814 个用例中
  1797 passed、17 skipped、0 failed；
- 相关 targeted / E2E 回归均通过。

## Live run 结果

以下是本轮后段最有诊断价值的监督结果；所有 `publication` 均为空：

| 证据目录 | 终态 | 关键结果 |
| --- | --- | --- |
| `...-21` | `failed_or_cancelled` | 首轮连续 429/503，正常重试耗尽 |
| `...-23` | `failed_or_cancelled` | route 成功后再次被 429/503 终止 |
| `...-24` | `failed_or_cancelled`（人工取消） | live 验证隐藏 provider recovery 有效；随后暴露 dynamic source map strict-schema 问题 |
| `...-25` | `failed_or_cancelled` | source entries 已穿过 Pi；prepare 成功；多次 VLM carrier 不可读；恢复预算后终止 |
| `...-26` | `blocked_no_publication` | 27 个轴估算点被拒；六表 prepare/submit 到达语义校验；SourceLocator 反复修正后超出 turn 预算 |
| `...-27` | `blocked_no_publication` | 长会话压缩后重复来源探索，未回到 publication |
| `...-28` | `failed_or_cancelled` | 新 task 获取多个 archive/CSV；105 个轴估算点被拒；在批量 VLM 后遇到未分类流断开 |
| `...-29` | `failed_or_cancelled`（用户终止） | 用户要求终止目标时仍在运行，已主动取消 |

较早的 `...-13` 至 `...-20` 也全部为 `failed_or_cancelled` 或
`blocked_no_publication`。完整事件、HIL 和 closure 以对应 ignored 证据目录为准；报告不把
历史/临时产物拼接成同一 run 的成功证据。

## 人工审查决策

- 先前已接受 3 个直接标注 IC50：A549 `0.11 µM`、H1299 `0.09 µM`、H1975
  `0.02 µM`。它们有直接数值标签，但没有形成最终 Publication。
- 用户明确拒绝 32 个估算点。
- 后续依同一规则拒绝多批 `~`、轴插值、坐标读取或仅上限可见的数据；本报告对应的关键
  批次包括 27 点和 105 点。
- `>1000` 若只是触及坐标上限且精确值不可读，也按不可发布数值拒绝。
- credential HIL 的批准只允许调用 VLM，不代表接受抽取值。

## 尚未解决的问题

### P0：Gold6 live publication 证据缺失

- **现状：** 没有 `publication_acceptance` HIL、不可变 Publication、最终 B3、Manifest 或
  Artifact API hash 闭环。
- **影响：** Gold6 必须保持未完成；临时 CSV、prepare receipt、fixture E2E 都不能替代。
- **完成条件：** 单一 commit / Host / data root 的 run 产生正确六表候选，经真实 publication
  HIL 接受，并由监督器下载全部 artifacts 复算文件 hash 与 package digest。

### P0：Provider 持续 429/503 与流中断

- **现象：** 多个 run 在不同阶段连续出现 `429 rate_limit_error`、
  `503 service temporarily unavailable`；还出现
  `stream disconnected before completion: stream closed before response.completed`。
- **局部修复：** 正常重试、固定冷却隐藏 continuation 与两类精确流恢复已落地。
- **遗留：** 上游长时间不可用仍会耗尽有界恢复预算；不能靠无限重试保证完成。
- **下一步：** 在 provider 稳定窗口重跑，或由 provider 方确认限流/并发/配额 SLA；不得擅自
  更换用户指定模型或 endpoint。

### P0：SourceLocator live 闭包尚未在修复后成功发布

- **现象：** live submit 依次暴露 `must be JSON`、unknown fields、VLM byte/provenance exact-match
  等拒绝；最终已把精确 locator wire 写进工具契约，但终止前没有再次得到成功 Publication。
- **下一步：** 用 fresh task 验证 `chart_series` 的 `image_bbox`、空 `chart_points`、
  `supplementary_asset_records` 的 `json_pointer` 与对应 VLM/archive bytes 完全一致。

### P1：prepare receipt 不是 Host-restart durable

- **现象：** receipt-only submit 依赖 Host 内存中的 prepared submission；Host 重启后旧 receipt
  不能直接复用，只能重新 scaffold/prepare。
- **影响：** durable task 能恢复事件，但不能恢复已准备的提交，增加 live run 重复工作和
  turn 消耗。
- **下一步：** 将 digest-bound prepared submission 持久化到 task-owned state，并补 restart、
  stale generation、篡改与 replay 测试。

### P1：Agent turn 消耗与重复探索

- **现象：** 在确定性拒绝后，多次重新 scaffold、检索和 archive 获取；长 task 最终出现
  `MAX_TURNS_REACHED`，新 run 又可能重复 route/source discovery。
- **下一步：** 把最近成功 scaffold/prepare receipt、精确恢复动作和不可重试来源写入更强的
  deterministic progress state；对同 digest 的成功/失败工具调用提供显式 reuse/禁止重复提示。

### P1：VLM 易产生“看图估数”的假精度

- **现象：** 27 点和 105 点批次均把 marker/柱高按坐标轴读成数值；部分值未带 `~`，但
  confidence reason 明确写着 estimated/interpolated。
- **影响：** 仅看数值字符串会误接收；必须审查 provenance reason。
- **下一步：** 提示和预审应默认拒绝无直接数值标签的 curve/bar 数值；若产品允许数字化，
  必须作为独立 estimated 数据类型与误差模型，不能冒充论文直接报告值。

### P1：credential HIL 未合并同策略授权

- **现象：** 同一 run 中每个串行 VLM 调用都产生新的 credential HIL，即使 policy/evidence
  digest 相同；本轮单批出现十余次人工 resume。
- **影响：** 监督器频繁停止，增加操作成本和超时风险。
- **下一步：** 评审 task/run 范围、可撤销的 credential grant；不得把一次数据接受授权扩展为
  credential 或后续数据接受授权。

### P1：公开来源与媒体类型不稳定

- **现象：** Europe PMC full-text/supplementary 出现 `http_client_error`、`media_mismatch`；
  多个 `.pdf` 下载实际是 HTML；部分 PDF 图对象没有可提取 raster。
- **下一步：** 为 provider 响应做 media sniffing 与来源候选排序；HTML/PDF staging 仍不得
  越权成为 Core carrier。

### P1：监督证据未记录 observed commit

- **现象：** closure 中 `expected_commit` 有值，但 `observed_commit` 为 `null`。
- **影响：** 即使未来发布成功，也缺少“同一 commit”机器证据的一部分。
- **下一步：** health endpoint 暴露构建 commit，监督器要求 expected/observed 精确相等后才
  允许 release classification。

### P2：测试随机命中 Fetch 禁用端口

- **现象：** 完整 server 测试曾在 `durable-agent-runtime`、`model-settings`、`ws-edge`
  随机出现 `fetch failed: bad port`；单文件重跑均通过。
- **下一步：** 测试端口分配应避开 Fetch forbidden-port 列表，并增加统一 helper。

### P2：exFAT 上 pnpm workspace 安装不可复现

- **现象：** 默认 pnpm symlink 布局在 E: exFAT 失败；hoisted 模式仍不能链接
  `workspace:*`；低堆测试又硬编码查找 `node_modules/.pnpm/vite-node@*`。
- **本轮临时处理：** 本地复制 workspace contracts，并补生成的 vite-node virtual-store
  compatibility path；未改 lockfile。
- **下一步：** 在仓库层选择跨文件系统可复现的 pnpm 配置，或把 workspace 部署到支持链接的
  NTFS；测试不应硬编码某一种 node-linker 目录布局。

### P2：Commonly check-in 未完成

- **现象：** `commonly whoami` 返回 `Not logged in`，因此本轮无法真实发送 `[TASK]` /
  `[DONE]` / `[BLOCKED]`。
- **下一步：** 维护者登录 Commonly 后补充真实状态；本报告不声称已 check-in。

## 建议的下一轮顺序

1. 先解决 provider 稳定窗口与 observed commit 证据。
2. 持久化 prepared submission，验证 Host restart 后 receipt-only submit。
3. 用 fresh Gold6 task 只选一篇已有直接 IC50 表、有效 image asset 和完整 archive/parser
   provenance 的论文；`chart_points` 可按 profile 合法为空。
4. 对 VLM 点继续执行“直接标签可收、轴估算全拒”的冻结规则。
5. 只有六表语义校验、B3、ProductAssessment、publication HIL、Manifest 与 Artifact hash
   全部通过后，才勾选 Gold6 TODO。

## 安全与可恢复性说明

- 没有真实 API key 进入 Git；报告仅记录 provider 行为。
- 本轮依赖恢复产生的临时 `data/.tmp-*` 目录已删除；内容为可重建依赖缓存，不可恢复但无需
  恢复。
- live evidence 仍在 Git-ignored `data/gold/evidence/`，未随代码推送；报告只引用目录名和
  结论，不复制敏感路径或原始凭据。
