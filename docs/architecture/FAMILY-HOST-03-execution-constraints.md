# FAMILY-HOST-03：FamilySpec + Transform Host 执行约束

> 状态：当前生产约束；ADR-039 已接受显式 `in_process_unisolated` 路线。
>
> 当前不开发 sandbox/container/IPC backend。进程内执行不是隔离或安全边界。

## 不变边界

1. **Execution honesty**：backend/receipt 固定声明 `in_process_unisolated`；`node:vm` 只用于同步 timeout，不得称为 sandbox、isolation 或 security boundary。
2. **Explicit opt-in**：只有 `submit_dynamic_family_publication` 的 exact `execution_backend=in_process_unisolated` 可进入动态fixed slot；不能静默fallback或从static build自动切换。
3. **Registered immutable input**：正式来源闭包必须闭合到当前 task 的 registered SourceAsset/committed OperationResult receipt。`transform_input` 按 handle/order/owner/size/SHA-256 重验并且只有它能进入 Transform Host；显式 `provenance_only` binding 同样逐字节和递归来源重验，但只进入 Core provenance/dependency closure，绝不暴露给 transform，也不放宽 UTF-8/gzip-UTF-8 runtime input 约束。workspace path 和 discovery bytes 不是 carrier；binding kind 不得按媒体类型猜测。
4. **Compile/descriptor closure**：normalized source、emitted bundle、compiler/options、dependency/runtime/policy、FamilySpec、Projection和declared output digests必须在执行前精确闭合。
5. **Host receipt != Core trust**：runtime bytes必须进入私有quarantine，Core重hash、closed-world admission并创建native OperationResult；不能直接成为candidate/publication。
6. **Publication authority**：只有 Core 创建 PublicationCandidate、B3 结果、ProductAssessment 和 Publication。Agent/Transform/FamilySpec/workspace 不能直接 publish。只有 committed candidate 命中显式 typed 产品拒绝（literature semantic profile、最终 B3/ProductAssessment 不可发布或 `publication_acceptance` 人工 reject/skip）时，Host 才可将重读、重算 hash 的候选表复制到 task-level untrusted quarantine；该 fallback 必须保持 formal rejection，不能创建正式事件、`current_publication_id` 或 Artifact。
7. **Conservative semantics**：FamilySpec没有科学field type时只生成`dynamic_string_preserving.v1`；不得推断numeric/unit/ontology/domain语义。
8. **Provenance closure**：每个table必须有disjoint data/provenance/confidence refs，并闭合到registered assets和native OperationResults。
9. **HIL fail closed**：含`review_status`/`human_review_status`字段，或含`confidence`/`confidence_level`/`extraction_confidence`抽取置信度字段的动态产品（字段分隔符`_`/`-`等价），必须保持`human_review_pending`，直到Core在B3后创建、候选/assessment/table字节证据绑定的`publication_acceptance` HIL并收到matching `accept`；credential `approve`不能满足此门。accepted review identity/snapshot必须进入immutable assessment/provenance。当前动态publication HIL支持同一live process内suspend/resume；跨Host重启的deterministic dynamic continuation尚未完成，重启场景必须fail closed，不能声称自动恢复。
10. **Scope/trust分离**：scope不表示trust；example scope不可执行；正式引用使用exact scope/id/version/digest。
11. **Identity分层**：dataset/revision/asset/build/transform/publication identity不可互换；不得从buildId、用户参数、注册时间或本地执行事实合成dataset/provider revision identity。
12. **Resource/cancellation fences**：deadline、generation、cancel fence、bounded input/output/log在admission前生效；当前进程内backend不能声称OS级RSS/PID/open-file enforcement。
13. **Fixed topology**：Agent只提交FamilySpec+selected Projection+DatasetTransform，不提交arbitrary DAG、merge function、validator或publication path。
14. **No stale publication reuse**：mutable staging可重建，但immutable`publish/`不得删除、覆盖或静默复用；每次promotion重新验证hash/release invariants。
15. **Single Host during evidence runs**：在event-log multiprocess race修复前，同一data root只能运行一个BioMed-QAgent Host；不得启动多个`tsx watch`实例。
16. **Product success**：Host exit、OperationResult committed、B3 passed或文件存在都不能代替ProductAssessment.publishable + immutable Publication + Artifact API byte-hash verification。
17. **Core-owned product closure**：动态 `assessment_policy_ref` 必须命中 Core 注册的产品拓扑清单；scaffold 由该清单直接生成 FamilySpec、Projection、表定义和关系，Agent 只绑定来源/抽取事实；prepare receipt 绑定清单 digest，submit 时重算。候选在 B3/HIL 前必须精确闭合清单要求的 family、table ID/role/schema、relation ID 与最小行数。Agent 自报清单、未知 policy、手写漂移 topology 或缩减后的单表 projection 均 fail closed，不能进入 `publication_acceptance`。
18. **Formal derived evidence**：VLM manifest 与 archive member/parser output 必须是 task-owned derived SourceAsset，并有持久 OperationResult；动态输入验证递归父资产 closure。按 [ADR-043](../adr/043-exact-only-chart-values.md)，VLM 只提供 figure/series/axis/legend/locator discovery；正式非空 chart points 必须逐行闭合到显式 numeric source-data asset，图像估计即使 HIL accepted/corrected 也不得发布。无精确点时可在留存搜索审计后空表、继续独立精确记录，再进入最终 `publication_acceptance`。
19. **Output locator closure**：Transform output 的 `locator_ref` 必须等于 Core 预期 locator，或精确命中本 invocation 已 admission 的 input asset/result locator；不同表可选择各自真实输入 locator。未知、外部或未登记 locator 仍以 `OUTPUT_CLOSURE_MISMATCH` 拒绝。

## 当前受支持流程

```text
registered immutable source receipts
  -> Core-owned profile scaffold (FamilySpec/Projection/tables/relations)
  -> Core-owned archive member/parser or VLM evidence OperationResults when needed
  -> Core-owned product topology profile resolution + digest binding
  -> strict FamilySpec/Projection/transform submission
  -> Host compile + content-addressed bundle verification
  -> explicit in_process_unisolated execution
  -> private quarantine + Core re-hash/closed-world admission
  -> native multi-table OperationResultManifest
  -> dynamic_string_preserving.v1 materialization
  -> generic multi-table B3
  -> Core provenance/confidence evidence + provisional ProductAssessment
  -> evidence-bound publication_acceptance HIL（review-status或抽取置信度产品）
  -> accepted review re-hash + final ProductAssessment/provenance
  -> atomic immutable Publication
  -> Artifact API download + SHA-256 verification
```

若 committed candidate 命中显式 typed 产品拒绝（literature semantic profile、最终
B3/ProductAssessment 不可发布，或 `publication_acceptance` 人工 reject/skip），可走单向旁路：

```text
committed candidate bytes
  -> canonical path + size/SHA-256 re-verification
  -> task quarantine ua_* receipts (authoritative=false, trust=untrusted)
  -> Assets UI 的“未准入”分组
```

该旁路不是第二套 Publisher；未知异常以及控制、资源、I/O 或完整性失败（cancel、timeout、
stale generation、fence loss、身份错配、路径越界、摘要漂移）不得降级归档。跨 Host
restart 的 publication continuation 未持久化完整 committed OperationResult/trusted root，
所以 restart 后的 reject/skip 只能保持 typed 正式拒绝并以 `run_failed` 收束，不能生成
`ua_*`。

receipt-only submit（`submit_dynamic_family_publication` 只回传 `preflight_receipt`）
依赖 task-owned preflight coordinator 保存的 prepared submission
（`server/src/runtime/dynamic-family-preflight-coordinator.ts`）。未消费 receipt 与精确
submission 以原子 JSON 状态持久化在 `<task>/state/dynamic-family-preflight.json`，Host
重启后可继续 receipt-only submit；reserve 在任何 acquisition 副作用前持久化 consumed，
重启后的 in-flight receipt 因无 reservation token 而 fail closed。新 prepare 仍同步提升
generation 并使旧 receipt 失效，成功或失败完成后清除 active entry。

## 未来isolated backend

若未来增加isolated backend，必须使用独立ADR，证明低权限OS identity、network deny、credential stripping、read-only inputs、hard quota/kill/process-tree cleanup、restart/cancel/replay和same-commit release evidence。当前backend不能通过改名、`node:vm`、worker thread或普通child process升级为“sandbox”。
