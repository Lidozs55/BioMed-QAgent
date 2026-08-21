# Transform Host：编译、隔离、资源与安全门

## 1. 威胁模型

Agent-authored TS 按默认不可信代码处理。攻击/故障包括：读取 repo/settings/其他 task/Publication、网络外传、进程派生、无限循环、内存/磁盘耗尽、依赖替换、symlink escape、伪造 locator/receipt、取消后 late commit。

当前 workspace `process.exec` 只有授权、timeout、output cap、process-tree cleanup；源码明确说明 cwd 不是 sandbox。它不能执行 production DatasetTransform。

以下也不能单独构成安全边界：

- `node:vm`（不安全的 untrusted-code sandbox）；
- `worker_threads`（同进程/同 OS 权限）；
- 普通 `child_process`（同账户文件与网络权限）；
- `tsx`/TypeScript AST check（编译器不是 runtime isolation）。

## 2. Admission pipeline

1. 从 Agent workspace 接收 transform submission；
2. 复制到 Host-owned code quarantine，规范化 source；
3. strict parse descriptor与FamilySpec digest binding；
4. TypeScript typecheck + AST/import policy；
5. v1 只允许 Transform SDK/Host allowlist，无任意 npm/native addon；
6. emit 单一 bundle；
7. 计算 source/bundle/compiler/options/dependency/runtime/policy digests；
8. 注册 immutable code bundle receipt；
9. 验证 input handles、task ownership、roles、hash/size；
10. resource request 不得超过 server policy。

静态检查只缩小攻击面，不能替代隔离。

## 3. Isolation backend 硬门

production Transform Host 必须使用独立进程/容器并满足：

- 独立低权限 OS identity；
- 无网络/DNS/代理；
- 不继承模型、API、DB、Git、云凭据；
- 不挂载 repo、workspace、task output、settings、Publication；
- input 只读且以 opaque handle/专用 mount 暴露；
- 独立空 temp/output quarantine 可写；
- 禁止 device、symlink/junction escape、native addon、child process；
- OS-level CPU/RSS/PID/open-file/temp/output quota；
- hard wall-clock kill 和 whole process-tree cleanup；
- worker generation/fence，旧 worker 不得 late commit。

Windows production 若无法通过 service account/ACL + Job Object + network deny，或受支持 container backend 提供等价隔离，则该平台的 Agent-authored transform 保持 disabled；不得降级为 worker thread 或同账户 spawn。

## 4. Runtime protocol

父 Host 与 worker 使用 framed、versioned、named-operation IPC，控制协议与 stdout/stderr 分离。Invocation 固定：

- task/build/operation/attempt/generation；
- transform bundle + runtime/policy digest；
- ordered input handles和receipts；
- output declarations；
- deterministic environment；
- quota、deadline、heartbeat、cancel token。

worker只能调用SDK reader/writer；输出只能写 invocation quarantine。执行前后重新核验 code/input digest，关闭 TOCTOU。

稳定 terminal reason：`succeeded | compile_rejected | admission_rejected | failed | cancelled | timeout | oom | quota_exceeded | policy_violation | sandbox_unavailable`。

## 5. Determinism 与 replay

v1 固定 timezone/locale、禁网络、禁未种子随机、规范化目录/row serialization。对于宣称 deterministic 的 transform：

- same input/params/runtime 双跑 digest一致；
- 不一致则降级为 non-deterministic candidate并阻止 activation；
- checkpoint identity包含完整 implementation/runtime/policy closure；
- restart只重放 persisted invocation，不让模型重新解释 spec。

semantic decision transform可以消费 immutable DecisionRecord，但最终数据改写由同一 Host ABI重放，且 parent refs、decision/evidence digest进入result。

## 6. Quarantine 到 Core handoff

Host成功后只提交 TransformExecutionReceipt + output receipts。Core必须：

1. 从 Host quarantine重新读取和hash；
2. 拒绝未声明文件/table/schema；
3. strict parse row/header/type/locator；
4. 验证locator只引用 invocation inputs；
5. 检查 resource/log/audit receipt；
6. 将合格输出复制/提交为 Core-owned operation output；
7. 创建 native OperationResultManifest；
8. 再进入compatibility/integration/validation/assessment。

Host无权写 OperationResult commit、build artifact或Publication directory。

## 7. 安全红队测试

必须覆盖：

- `node:fs`、`child_process`、`net/http`、dynamic import、eval、Function；
- repo/settings/.env/其他task/publication读取与写入；
- symlink/junction/device escape；
- infinite loop、allocation/fork bomb、huge log/output、disk fill；
- network/DNS/proxy外传；
- dependency/source-map替换；
- transform ID/version相同但bytes不同；
- cancel race、stale worker late commit、restart/orphan cleanup；
- output locator/receipt伪造；
- code/input digest execution前后漂移。

## 8. Batch 门

- Batch 0：threat model、backend spike、contracts；不执行production code。
- Batch 1：非生产 isolated Host MVP；所有红队基础项fail closed；不接默认build、不激活。
- Batch 2：shadow E2E；只有隔离、replay、Core handoff、product gate全通过才能讨论单 capability activation。
