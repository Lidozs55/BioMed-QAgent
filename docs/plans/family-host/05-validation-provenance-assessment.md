# WP-E：Validation、Provenance 与 ProductAssessment

## 1. 目的

将“结构正确”与“科学产品可用”明确分层，并让每张正式表、每个 measurement/assertion、每个 supporting artifact 都能闭合到可信输入和执行证据。

## 2. 验证层次

### E1：Contract admission

检查 Family/Projection/Schema/SourceBinding/Policy 的版本、所属关系、capability 支持、runtime requirement、extension trust level 和资源上限。

### E2：Table structural validation

复用 B3，检查 header、row width、type/nullability、primary key、required/allow-empty、relation field/cardinality、candidate closure、Core operation result、source receipt 和 path containment。

### E3：Expression semantic validation

补齐：

- gene/probe namespace；
- row granularity；
- value semantics、scale、unit、normalization compatibility；
- dataset/sample identity closure；
- probe mapping coverage/status；
- partial/empty publication policy；
- rejected/conflict policy；
- confidence/review/HIL policy。

B3 通过不能替代 E3。

### E4：Provenance closure

coverage 必须从实际数据计算，至少输出：

- traced/untraced row 或 assertion 数；
- source asset receipt；
- locator coverage；
- mapping/annotation receipt；
- parser/adapter version；
- integration decision/conflict refs；
- derived/review/correction refs。

禁止写死 `coverage_ratio = 1`。

### E5：ProductAssessment

为 expression 注册通用 package requirement，例如 `expression_evidence`，至少覆盖 Study/Dataset、Sample、ExpressionMeasurement、Probe/Mapping（按 projection）、relation closure、source locator/receipt、required artifact hash 和 review status。`publishable` 只能在 artifact hashes 已实际回填并复核后成立。

## 3. ProductAssessment 接入顺序

1. 先用纯 fixture 扩展 `ProductRequirementManifest` / evaluator，覆盖 incomplete、validated、publishable、missing relation、missing provenance、missing artifact。
2. 生成 Core-owned product evidence snapshot，不读取 workspace sidecar 作为权威事实。
3. 在 validation report、manifest、durable build result 和 Artifact API 中暴露 assessment identity/status。
4. Publisher 在新 expression flow 中只接受 assessment `publishable`；保留旧 compatibility path，直到迁移验收完成。
5. Gold evaluator 只读取 selected publication scoped artifact bytes/receipts，不能用历史 workspace 文件补证。

## 4. 并行关系

- E1 可与 A1/B1 并行，但必须消费 versioned contract。
- E2 可复用现有 B3，先补大表 index 设计。
- E3 依赖 A 的 projection identity 和 D 的 provider metadata。
- E4 依赖 B4/C3 的 committed operation result。
- E5 evaluator fixture 可独立；production 接线依赖 E2/E3/E4。
- H 依赖 E5 的 publishability semantics。

## 5. 验收

- 对 malformed table、dangling relation、untraced row、missing mapping receipt、unit mismatch、wrong projection、missing artifact 分别给出稳定 blocker；
- 同输入重跑 assessment digest 和 blocker ordering 稳定；
- publication 只引用 Core result receipts；
- `Publication exists` 和 `ProductAssessment.publishable` 在测试中明确区分；
- Gold6 的 HIL/pending 状态不会被 evaluator 默认为通过；
- 历史 publication、legacy flat hash、workspace sidecar 不能满足 selected current publication requirement。

## 6. 风险

- 不要把 Gold case 的表名/阈值硬编码进 production package；
- 不要为了提高覆盖率静默填充默认 namespace、unit 或 confidence；
- 不要要求所有语义冲突都人工批准，采用 typed proposal + policy（auto-admit/HIL/reject），但最终 replay 必须由 Core 完成。
