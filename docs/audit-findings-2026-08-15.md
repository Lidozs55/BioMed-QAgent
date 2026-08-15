# 审计发现与风险同步（2026-08-15，Run #2）

> 由 Codex 审计产生；基线 be78a1a。用于把审计发现、未修复风险和本地环境陷阱同步到团队文档。

## 结论

- 代码状态：PASS；全量测试/门禁全绿（server 724 + 11 跳过、frontend 737、contracts 14）。
- P0/P1 = 0；P2 = 0；P3 = 1（M12 长列表性能无显式 UI 测试）。

## 未修复风险 / 测试缺口

- M04-T10：事件写入失败不报虚假成功，无显式故障注入。
- M05-T04/T06/T08：多订阅隔离、慢消费者背压、大量事件背压，未显式测。
- M10-T06：并发 PUT 幂等，未显式测。
- M14：磁盘满/句柄耗尽/时钟跳变/大文件恶意输入，未执行。
- M15 场景 8：恶意输入组合红队，未执行。

## 本地环境陷阱（供复跑参考）

- 沙箱只允许写主仓库工作区；对 `.git`、`node_modules/.pnpm`、uv/pnpm 缓存的读写受限，门禁需沙箱外执行。
- pnpm 需用捆绑 fallback（11.19.0）并前置 PATH，避免 `packageManager` 触发 AppData 自下载。
- Playwright Chromium 需用国内镜像 `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright` 安装。
- 真实外部数据用 `BIOMED_LIVE_SMOKE=1` 显式开启。
- 仓库存在多智能体并发修改，审计须用隔离 worktree。
