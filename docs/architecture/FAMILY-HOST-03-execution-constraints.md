# FAMILY-HOST-03：FamilySpec + Transform Host 执行约束

> 状态：目标约束，具体生产接线等待 ADR-039 接受和 Batch 0–2 验收
>
> 本文件取代旧版中以 Runtime Extension 为中心的表述。约束适用于 Dataset Core、Family Host、Transform Host、Agent、examples、Validation 和 Publication。

## 不变边界

1. **Deterministic artifact immutability**：Agent/LLM 不原地修改已提交 artifact；修正产生 derived artifact、parent refs 和 DecisionRecord，并重新进入 Core validation。
2. **Transform Host isolation**：Agent-authored code 不能在 TS Application Host、workspace `process.exec`、`node:vm` 或 `worker_threads` 中作为生产 transform 执行。必须使用独立低权限 process/container、无网络、输入只读、quarantine 输出、OS resource limits 和 hard kill。
3. **Host receipt != Core trust**：Host 只证明隔离执行事实。Core 必须重新 hash、strict parse、检查 output closure，再生成 native OperationResult。
4. **Publication authority**：只有 Core 创建 OperationResult、PublicationCandidate 和 Publication。Transform、FamilySpec、examples、workspace 都不能直接 publish。
5. **Capability honesty**：声明的 input/output/schema/source capability 必须由 Core admission 和实际 output 证明；缺少 parser 或映射时 fail closed，不能静默补默认值。
6. **Same-Schema determinism**：先 compatibility partition，再按 table/projection identity dedup/conflict/provenance merge；Agent 只能提出 typed policy/decision，不能注入 merge function。
7. **Raw evidence preservation**：raw value/unit/token/locator、source asset、transform/runtime/decision digest 均保留，canonical value 不能冒充 raw evidence。
8. **Provenance closure**：正式输出必须闭合到 registered SourceAsset/committed OperationResult/TransformExecutionReceipt；workspace path 不是 provenance。
9. **FamilySpec admission**：FamilySpec 严格版本化、无源码/函数/path/任意 DAG；注册前校验 schema/relation/identity/policy/resource/scope。
10. **DatasetTransform admission**：Transform bundle 必须有 source/bundle/compiler/dependency/runtime/policy digest、固定 ABI、exact input handles、declared outputs 和 deterministic/replay 声明。
11. **Scope/trust/resolution 分离**：scope 不表示 trust 或 lookup priority；生产引用使用 scope-qualified id + exact version + exact digest；歧义 fail closed；名称 shadow 不自动发生。
12. **Examples are not runtime**：`examples/families` 只供检索/fixture/回归，不能被 Core import、扫描或自动注册。
13. **Dataset identity layers**：`dataset_id`、`dataset_revision_id`、`asset_id`、`build_id`、`transform_digest`、`publication_id` 语义不可互换。
14. **Streaming/resource safety**：Transform、integration、B3 不能回退为全量 Buffer/object[]/无界 Map；quota/cancel/timeout/restart/fence 必须在 Publisher 前生效。
15. **Fixed topology**：Transform 只能进入服务端声明的 fixed slot；Agent 不提交 nodes/edges，不把 WorkflowRecipe 扩展成通用 DatasetTransform DAG。
16. **Product success**：Host exit、BuildResult succeeded、文件存在或 B3 passed 都不能代替 ProductAssessment.publishable 和 selected Publication hash closure。

## 允许的统一 Transform 模型

不再维护“Agent transform”和“Trusted Extension”两套 ABI。所有 transform 使用同一 Transform SDK/Host protocol；但 origin、scope、execution status、verification、activation、revocation 和 resource policy 独立记录。统一协议不等于统一信任级别。

## 失败时必须停止动态路线

如果任一平台没有真实 OS isolation、implementation digest 不覆盖 bundle/dependency/runtime、Host 输出能绕过 Core、B3 大表仍无界 Map、只有一个真实消费者，或旧 path 没有 shadow/rollback 证据，则保持现有 static runtime，停止 activation，不以文档或模型判断替代实现证据。
