# Transform Host 平台 / 沙箱 Backend 支持矩阵

> 配套 `docs/plans/family-host/03-transform-host-security.md §3` 与 ADR-039 §2。
> 本文件是 A-T0 交付物之一：明确各平台能否提供 ADR-039 要求的真实 OS 隔离。
> 结论变更须在此更新，并经 ADR-039 review 记录。

## 1. 最低隔离要求（来自 ADR-039 §2 / `03 §3`）

生产 Transform Host backend 必须提供：

1. 独立低权限 OS identity；
2. 无网络 / DNS / 代理；
3. 不继承模型 / API / DB / Git / 云凭据；
4. 不挂载 repo / workspace / task output / settings / Publication；
5. input 只读，以 opaque handle / 专用 mount 暴露；
6. 独立空 temp / output quarantine 可写；
7. 禁止 device / symlink / junction escape / native addon / child process；
8. OS 级 CPU / RSS / PID / open-file / temp / output quota；
9. hard wall-clock kill + 整进程树清理；
10. worker generation / fence，旧 worker 不得 late commit。

## 2. 支持矩阵

| 平台 | 候选 backend | 可达标 | 备注 |
|---|---|---|---|
| Linux x64 | systemd-run (`--scope` + `Resource`/`IPAddressDeny`) / OCI 容器（无网络、只读 rootfs、drop caps） | ✅（需运维确认基线） | 首选生产 backend |
| Linux arm64 | 同 Linux x64 backend | ✅（待同基线验证） | 同策略 |
| macOS | `sandbox-exec` + `taskpolicy` / 容器 | ⚠️ 部分 | `sandbox-exec` 非网络 deny 完整；仅作开发/CI，不接生产激活 |
| Windows x64 | 专用 service account + ACL + Job Object + 网络 deny（或受支持容器 backend） | ❌→✅ 条件 | 见 §3；不达标则该平台 Agent-authored transform 保持 **disabled** |

## 3. Windows 决策（依据 `03 §3` 末尾）

- 若 Windows 生产环境**无法**通过「专用低权限 service account + 文件系统 ACL + Job Object 资源限制 + 网络 deny」或等价容器 backend 提供 §1 全部 10 项，则：
  - 该平台 Agent-authored transform **保持 disabled**；
  - 不得降级为 `worker_threads` / `node:vm` / 同账户 `child_process` / workspace `process.exec`；
  - 已激活 capability 在该平台回退为 `revoked`（保留历史 Publication 可读）。
- 判定以 backend proof（隔离集成测试通过）为准，不以文档措辞替代。

## 4. 当前结论（2026-08-21）

- 仓库**尚无**任何生产 Transform Host backend（`main` 现状见 `family-host/README.md`）。
- 目标 backend 待 Batch 1 的 `T6` isolated Host MVP spike 选定并证明；本矩阵为决策基线。
- 在 backend 证明前，任何平台均不得激活 Agent-authored transform（ADR-039 冻结约束）。
