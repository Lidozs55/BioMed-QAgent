# 已知问题

> 这里只保留尚未解决、可复现或明确待验证的问题。计划性工作放在 [`TODO.md`](TODO.md)；2026-08-24 前的关闭记录见 [`archive/ISSUES-2026-08-24-before-governance.md`](archive/ISSUES-2026-08-24-before-governance.md)。

## 前端交互

### 快速点击可能重复或丢失

- **状态：** 待复现。
- **现象：** 快速点击主题切换或其他按钮时，可能出现一次点击触发两次或未触发。
- **下一步：** 用 pointer/click 事件测试确定是否为重复 handler、事件穿透或状态节流问题；确认后先提交失败测试。

## 测试稳定性

### `build-lock.test.ts` 全量运行偶发失败

- **状态：** 2026-08-14 在并行负载下复现，单文件连续 8 次通过。
- **影响：** `pnpm test` 可能因真实子进程文件锁时序与 CPU 争抢偶发失败。
- **下一步：** 增加进程间同步闩，或基于测量调整重试/时窗；不得仅隐藏失败。
- **历史上下文：** [`archive/LEFTOVERS-2026-08-09.md`](archive/LEFTOVERS-2026-08-09.md) §K1。

### `main@a884b159` 全仓测试存在两个确定性失败

- **状态：** 2026-08-24 在干净的 `origin/main` 基线复现；与本轮文档内容无关。
- **B3 parity proof：** `server/tests/b3-memory-disk-parity.test.ts` 计算证据文件 SHA-256 为 `a5534621…1609`，但 `PRODUCTION_B3_PARITY_PROOF.digest` 仍为 `324b8cf1…b610`。
- **solidify-run：** `server/tests/solidify-run.test.ts` 在 Vitest collect 阶段对合法的 vitest import 报 `SyntaxError: Invalid or unexpected token`；文件与 HEAD blob 一致且 `tsc` 通过，需继续定位 Vite/Vitest transform 输入。
- **下一步：** 分别核对 B3 证据生成/提交闭包；用最小 transform reproduction 定位 solidify-run collect failure。不得在不重生证据的情况下只改 digest，也不得跳过测试。

## 可选测试缺口

这些是非阻塞的覆盖增强，不代表已观察到生产故障：

- `GET /builds/{id}` 损坏 manifest 返回 409，以及中间页损坏分页。
- operation 事件顺序无关性与部分镜像 run 语义。
- 双读 API 对真实 `execute_dataset_build` 产物的 E2E，以及 `build_result` 全量重启回放。
- NO_DATA `data-variant` 与 `runId === null` reducer。
- `/cache/datasets?limit=` 页帽与 hook 负向用例。

## 维护规则

新增条目必须写出状态、影响、最小复现和下一步。修复从失败测试开始；合并后从本文件删除，由测试和提交历史承担关闭证据。架构 hardening 或产品里程碑不得重复登记在这里和 `TODO.md`。
