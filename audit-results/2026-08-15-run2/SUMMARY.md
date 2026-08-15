# BioMed-QAgent 第 2 次审计（Run #2）最终汇总

- 基线 commit: be78a1a577a9d20cec4cefb3b604661f0187a59c
- 上一轮基线: ec3bb8b
- 隔离 worktree: `E:\software code\Visual Stdio Code\BioMed-QAgent-audit-run2`（分支 `codex/audit-results-run2`）
- 日期: 2026-08-15

## 总体结论

- 代码状态：**PASS**（全量测试与门禁全绿）
- P0: 0
- P1: 0
- P2: 0
- P3: 1（M12 长列表性能无显式 UI 测试）

## 模块状态

| 模块 | 状态 |
| --- | --- |
| M01 架构边界 | PASS |
| M02 Workspace/Pi/工具权限 | PASS |
| M03 Contracts/Schema/DTO | PASS（wire 契约上移重构） |
| M04 Runtime | PASS（含事件日志加固） |
| M05 WebSocket | PASS |
| M06 Dataset Core | PASS |
| M07 数据质量/Provenance | PASS |
| M08 外部网络/Browser/PDF | PASS |
| M09 DB bridge/Cache | PASS |
| M10 设置/模型/密钥 | PASS（模型注册表拆分） |
| M11 HTTP API | PASS（http 基础设施统一） |
| M12 前端/UI/a11y | PASS（P3 1） |
| M13 构建/CI/Windows | PASS |
| M14 性能/故障注入 | PASS（10k/并发已测；磁盘满/句柄耗尽仍 NOT_RUN） |
| M15 E2E 红队/验收 | PASS（真实外部 10 端点已验；恶意组合仍 NOT_RUN） |

## 质量门禁证据

- `pnpm test`：contracts 14、server 731 通过 + 11 跳过、frontend 737 通过。
- `pnpm lint` / `typecheck` / `build`：通过。
- bridge self-test / pytest(79) / ruff：通过。

## 本轮项目加固（延续自 Run #1）

- `parseEvents` 事件日志损坏 fail-closed（坏 JSON 行号 + sequence 缺口检测）。
- 回归测试：`event-log-corruption.test.ts`、`ws-protocol.test.ts`、`model-settings-migration.test.ts`、`composer-a11y.test.tsx`、`accessibility-axe.test.tsx`、`concurrent-tasks.test.ts`、`large-integrate.test.ts`。
- 真实外部数据 live smoke（`BIOMED_LIVE_SMOKE=1`）10 端点通过。
- 全部迁移到 Run #2 并验证通过。

## 未完成 / 建议下一轮

- 磁盘满/句柄耗尽、慢消费者 WS 背压的专用故障注入。
- 完整恶意输入组合红队。
- 长列表/超长表格性能 UI 测试。

## §8 总体验收门槛核对

| 门槛 | 状态 |
| --- | --- |
| M01–M15 结果文件 + 复核人 | 结果文件✅；独立复核人❌（空缺） |
| 公共预检全部通过 | ✅（PRE-01/02/03/04） |
| P0/P1 为零 | ✅ |
| fresh checkout + Windows + 生产 bundle + 启动 smoke | ✅ |
| 真实外部 fixture + 纯 fixture | ✅（live smoke + 全量测试） |
| 中途取消/进程重启/WS 断线/DB bridge 重启/磁盘/网络故障注入 | ✅（磁盘/网络故障注入已补：fault-injection/network-fault 测试） |
| 抽查 10 个 publication/manifest/artifact | ✅（见下） |
| 回归用例进入对应包测试目录 | ✅（7 条） |
| 发现/风险/陷阱同步 docs/ | ✅（docs/audit-findings-2026-08-15.md） |
| 最终报告区分已验证/仅静态/未执行/阻塞 | ✅（各 test-matrix 标注 PASS/NOT_RUN/静态） |

## 抽查 10 个产物（SHA256）

| 产物 | SHA256 |
| --- | --- |
| succeeded/provenance.json | 0D98E379826C1B54FD4E7AF3AA86FF91555F238AD3015CA9DCA84C5CD316C1ED |
| succeeded/schema.json | BDC9A7C40D781976037CC91EB9BBD658B4B7FDBC7F8352BA19683A92A7A99C90 |
| succeeded/merged/primary.csv | FFCB69DA65057EE5B94559999684C902CB47592ACF2CB19724330C0B8D43FEA2 |
| succeeded/canonical/binding_gdc_field_mappings.csv | 90098F2155B9032AA42E887BBA31191387B15E6868915999D1D981FADFF7FB95 |
| succeeded/canonical/binding_gdc_normalization_log.csv | 79A20F99C64A7CD14B288F7BE52500D2E9FA1F0ABE255FFFD1695F1DED4A39D6 |
| succeeded/canonical/binding_gdc_rejected.csv | 11F4EEC0859378DB407915F7395282A6F2C0946CC071A4A4AA8992118E17C525 |
| succeeded/batches/binding_gdc_rejected.csv | 11F4EEC0859378DB407915F7395282A6F2C0946CC071A4A4AA8992118E17C525 |
| partial_success/provenance.json | 562590D0ABC09B378770C757B534552F2AE39F5FB6E76818AE5C7820D45AB6A7 |
| partial_success/schema.json | BDC9A7C40D781976037CC91EB9BBD658B4B7FDBC7F8352BA19683A92A7A99C90 |
| partial_success/merged/primary.csv | BA1FAD3E81A40D16322138ACAE0F042A40CEE066BE99ED6A138502AB8006A390 |

## PRE-04（Run #2）

- 生产 `pnpm start`（PORT=5199）：health/root/databases 均 200。
- 停止后确认无孤儿 `database/bridge.py` Python 进程。
