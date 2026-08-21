# Transform Host 威胁模型

> 配套 `docs/plans/family-host/03-transform-host-security.md` 与 ADR-039 §2。
> 本文件枚举 Agent-authored Transform 的攻击面与对应控制，作为 A-T0 交付物之一。

## 1. 信任假设

- Agent-authored TS 默认**不可信**：未经受控编译、未隔离执行的代码视为潜在恶意。
- 托管边界（Host）是唯一的代码执行面；Core 与 Agent 不直接执行 transform 源码。
- 隔离强度由 backend 在运行时强制，不由源码声明（digest 也由 Host 计算）。

## 2. 攻击面与缓解

| # | 威胁 | 缓解（控制层） | 对应验收 |
|---|---|---|---|
| T1 | 读取 repo/settings/.env/其他 task/旧 Publication | 独立空 mount、不挂载敏感目录、凭据不继承 | `03 §3` 隔离 backend 硬门 |
| T2 | 网络外传（数据/心跳/远控） | 无网络/DNS/代理；backend 级网络 deny | `03 §3` |
| T3 | 进程派生 / 提权 | 独立低权限 OS identity；禁止 `child_process`/native addon | `03 §1`,`03 §3` |
| T4 | 无限循环 / 内存耗尽 / 磁盘填满 | wall-clock hard kill；CPU/RSS/PID/open-file/temp/output quota | `03 §3`,`03 §4` |
| T5 | 依赖替换 / source-map 替换 | content-addressed bundle；`implementation_digest` 覆盖 bundle+dependency | `01 §3`,`10 §5#3` |
| T6 | symlink/junction/device escape | quarantine root 独立；禁止 symlink/junction escape | `03 §3`,`03 §7` |
| T7 | 伪造 locator / receipt | Core 重哈希、strict parse、locator 仅引用 invocation inputs | `03 §6`,`05 §1` |
| T8 | 取消后 late commit / stale worker | worker generation/fence；旧 worker 不得写 build/Publication | `03 §3`,`03 §4` |
| T9 | code/input digest 执行前后漂移（TOCTOU） | 执行前后重新核验 code/input digest | `03 §4` |
| T10 | 编译即信任（静态检查冒充隔离） | 静态检查只缩攻击面；真实隔离由 backend 提供 | `03 §2`,`10 §5#2` |

## 3. 红队测试矩阵（必须 fail closed）

`node:fs` / `child_process` / `net:http` / `dynamic import` / `eval` / `Function`；repo/settings 读写；
symlink/junction/device escape；infinite loop、allocation/fork bomb、huge log/output、disk fill；
network/DNS/proxy 外传；dependency/source-map 替换；同 ID/version 不同 bytes；cancel race、stale worker、
restart/orphan cleanup；output locator/receipt 伪造；code/input digest 漂移。（详 `03 §7`）

## 4. 范围边界

- Host 成功只产出 quarantine output + execution receipt；**不代表**结果可信或可发布。
- Transform 不能决定 merge winner / validation threshold / ProductAssessment / PublicationCandidate / Publication。
- 只有 Core 可提交 OperationResult、构造 PublicationCandidate、调用 Publisher。
