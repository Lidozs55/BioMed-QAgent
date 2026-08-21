# Family Host 改造总计划

## 1. 目标与边界

本计划将 `docs/architecture/FAMILY-HOST-*` 的长期方向整理为可并行执行的工程路线：

```text
Pi Agent
  -> Family discovery / proposal
  -> Core admission
  -> fixed or resolved execution
  -> deterministic validation
  -> ProductAssessment
  -> Core Publisher
```

改造目标不是取消 Dataset Core，也不是让 Agent 自由编排任意 DAG，而是把当前分散在 `DatasetFamilyRegistry`、Schema、assembler、provider dispatch、validation 和 runtime 中的 Family 语义，逐步收敛为可验证的 Family package/capability 边界。

## 2. 当前仓库基线

已存在并可复用：

- `DatasetFamilyRegistry`、Schema Registry、Normalization/Validation Profile 绑定；
- `DatasetSchemaV2`、`TableDefinition`、`RelationDefinition`、`DatasetManifestV2`；
- B3 multi-table structural/relation/provenance gate；
- FamilyAssemblerRegistry 及多个 family-specific assembler；
- expression 专用 streaming canonicalizer、SQLite disk-backed integrator、quota/cancel 测试；
- Core-owned SourceAsset、OperationResultManifest、Publisher、Artifact API；
- `ProductRequirementManifest` / `ProductAssessment` 及 Gold evaluator trusted evidence projection；
- Agent -> `DatasetBuildSpec` -> Core -> Publication 的正式链路。

已确认的缺口：

- 默认 Family 与 `PRODUCTION_RUNTIME_BY_FAMILY` 仍是源码静态绑定；
- Schema、table topology、provider dispatch、assembler 仍有多处 family/source 特判；
- `registered_multitable.runtime.v1` 仍以完整 carrier bytes 和内存 row arrays 为主；
- 通用 Same-Schema Integration 尚未抽出；
- expression supporting tables、稳定 dataset/sample/mapping identity、实际 provenance coverage、expression ProductAssessment 尚未形成完整可信闭环；
- Family Host、动态 package load、capability resolver、task-scoped declarative Family、Agent family tools 尚未实现；
- `DatasetBuildSpec 1.0` 仍只支持单 `schema_ref`。

## 3. 优先级原则

### P0：先完成现有产品的可信闭环

首先按现有 Gold evaluator 诊断结果修复 task/run/build/trusted input/validation/publication/final-answer 证据链。除非诊断证明缺少可复用 contract，否则不启动完整 Canonical IR、RegisteredTransform 或动态 Family Host。

### P1：先形成可信 expression 多表 projection

用 gene/probe 两个明确 primary projection、正式 supporting tables、稳定身份、流式执行、关系验证和 ProductAssessment 完成一个可验证 vertical slice。它是 Family Host 的前置去风险工作，不是完整 Family Host。

### P2：抽出通用执行原语

将 file-backed writer、disk-backed merge、table-level operation result、receipt closure、relation index、typed conflict decision 等能力抽出为 family-agnostic primitive。

### P3：再做声明式 Family Host

只有当至少两个真实 Family 消费同一抽象，且已有版本化 contract、资源边界和回滚方案时，才将静态定义迁移为 JSON/YAML package loader 和 capability resolver。

## 4. 并行轨道

```text
A Contract / Projection / Identity
        |\
        | +--> C Same-Schema Integration
        |       |
        +--> B Streaming Primitives ----+--> D Provider Projections
                                        |
                                        +--> E Validation / Provenance / Assessment
                                                          |
                                                          +--> H Publication / Evaluator / Release

F Registry / Family Host <---- A + B + E 的稳定契约
G Agent Capability Interface <---- F + versioned wire contract
```

允许并行：A 与 B 可同时开展；C 在 A 的 identity 草案可用后启动；G 的只读 discovery contract 可提前做，但不得提前开放动态执行字段；D 的 GEO 可先于 GDC/Xena 做内部 vertical slice；F/L2 之前必须完成至少一个通用 runtime primitive 和两个消费者验证。

禁止并行造成的竞态：Provider 不得各自定义 table identity；Validation 不得在未冻结 schema/relation contract 时写 production profile；Agent 不得在 Core admission 尚未支持时暴露 `schema_refs` 或 `create_family`。

## 5. 全局不变量

所有工作包必须遵守 `FAMILY-HOST-03`：

- deterministic artifact 只读；LLM 只能产生 typed proposal/decision，Core 负责 replay；
- workspace 不是可信输入，必须先注册 SourceAsset/derived input 并产生 receipt；
- 只有 Core Publisher 创建正式 Publication；
- capability 必须诚实，不能静默补字段或冒充 derived/source value；
- 同 Schema 多源必须确定性 dedup/conflict/provenance merge；
- schema、family、extension、transform 语义必须版本化并保留 digest；
- 大数据路径保持 streaming、bounded buffer、disk-backed index、cancel/timeout；
- `BuildResult.succeeded`、文件存在、tool call 成功都不能代替产品级 `publishable`。

## 6. 全局完成标准

本路线达到“可进入 Family Host rollout”前，必须同时满足：

1. 当前 Gold 失败边界有机器可读诊断，且同 commit trusted evidence closure 可复现。
2. expression vertical slice 不损失现有 streaming、checkpoint、cancel、lock/fence 和发布安全性。
3. 至少两种 Family 使用相同的通用 integration/validation/assembly primitive。
4. 新增声明式 FamilySpec 能在不修改 Dataset Core 业务源码的情况下通过 parser/validator admission；这一条在动态加载阶段才验收，不提前承诺。
5. 任何 dynamic/task Family 都不能获得未审核 executable extension 或绕过 Publisher 的权限。
6. 旧 Family/Schema/Publication 的解析和 artifact 下载保持兼容，迁移失败可回滚到旧路径。

## 7. 不属于本计划的工作

- 修改 Gold prompt、source inventory、acceptance threshold；
- 为单个 Gold case 建立生产专用 family/profile/runtime；
- 重新迁移 TS Host、Pi、权限系统或 Python persistence bridge；
- 引入 Agent-controlled general DAG；
- 让 Agent 生成 TS/JS/Shell 并自动进入 trusted runtime；
- 在没有第二个真实消费者时泛化一个仅服务单 case 的抽象。
