# WP-G：Agent Capability Interface

## 1. 目的

让 Pi Agent 能先发现和解析可用 Family/Schema/Source capability，再生成 build proposal，同时不把 Agent 的自由度误扩展为 Core 信任权限。

## 2. 分层交付

### G0：当前 DatasetBuildSpec 1.0 的兼容接口

先提供只读/解释性能力：

- family/schema/source capability listing；
- primary projection 查询；
- source parameter schema；
- capability status、version、digest；
- 当前单数 `schema_ref` 到 Core-owned supporting topology 的解释。

不能添加未经版本化的 `schema_refs`，也不能让 tool schema 表面支持 Core 尚未 admission 的字段。

### G1：Capability discovery tools

长期工具：

```text
list_families
search_families
inspect_family
search_schemas
search_capabilities
resolve_capabilities
```

返回必须包含 scope、version、status、source/adapter、schema/projection、requiredness、resource estimate、trust/extension 信息和 evidence refs。查询结果不能直接宣称 publication ready。

### G2：Declarative task Family proposal

Agent 可生成 task-scoped FamilySpec：

- schema/table/relation/capability/integration/validation proposal；
- 纯声明式；
- Core strict parser/semantic validator admission；
- 仅当前 task 生效；
- 不自动 promote；
- 不含任意 executable code。

### G3：Typed semantic decision

对无法由确定性规则裁决的 conflict，Agent 输出 `ResolutionDecision` proposal，包含 conflict refs、candidate evidence、chosen resolution、rationale、model/user、timestamp、proposal digest。Core policy 决定 auto-admit/HIL/reject，并负责 deterministic replay。

## 3. Agent 边界

Agent 可以：

- 发现来源、选择已声明能力、生成 proposal；
- 请求注册 SourceAsset/derived input；
- 提议 mapping、normalization、conflict resolution；
- 读取 validation/assessment blocker 并继续补证或请求 HIL。

Agent 不可以：

- 伪造 capability、receipt、confidence、source value；
- 注入 merge function、validator、provider arbitrary URL/path；
- 修改 committed deterministic artifact；
- 直接创建 Publication 或将 workspace CSV 作为正式 artifact；
- 用模型自述覆盖 Core ProductAssessment。

## 4. 并行与依赖

- G0 可与 A/F 的 contract work 并行，但只读、兼容单 schema。
- G1 依赖 F3/F4 的 versioned resolver。
- G2 依赖 F2 的 strict FamilySpec parser、B/E 的 resource/trust policy。
- G3 依赖 C4 的 typed conflict/replay contract。
- 前端/Agent prompt 适配必须在 server contract 和 API parser 稳定后进行。

## 5. 测试

- tool schema 与 Core parser parity；
- unknown family/schema/source/extension fail closed；
- task Family 不污染 builtin/curated/user Registry；
- scope/version resolution deterministic；
- Agent proposal 不能绕过 SourceAsset receipt、validation、assessment、Publisher；
- blocker 可作为下一步机器可读输入，而非只返回泛化错误。

## 6. 迁移策略

先把 capability discovery 做成解释性接口，再逐步把 build tool 的 enum/schema 生成改为 resolver 输出。任何 wire shape 变化必须进入 `@biomed/contracts` 并做 versioned parser；旧客户端保持单数 `schema_ref` 兼容。
