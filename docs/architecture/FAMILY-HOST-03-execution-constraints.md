# FAMILY-HOST-03：FamilySpec + Transform Host 执行约束

> 状态：当前生产约束；ADR-039 已接受显式 `in_process_unisolated` 路线。
>
> 当前不开发 sandbox/container/IPC backend。进程内执行不是隔离或安全边界。

## 不变边界

1. **Execution honesty**：backend/receipt 固定声明 `in_process_unisolated`；`node:vm` 只用于同步 timeout，不得称为 sandbox、isolation 或 security boundary。
2. **Explicit opt-in**：只有 `submit_dynamic_family_build` 的 exact `execution_backend=in_process_unisolated` 可进入动态fixed slot；不能静默fallback或从static build自动切换。
3. **Registered immutable input**：正式输入必须闭合到当前task的registered SourceAsset/committed OperationResult receipt；按handle/order/owner/size/SHA-256重验。workspace path和discovery bytes不是carrier。
4. **Compile/descriptor closure**：normalized source、emitted bundle、compiler/options、dependency/runtime/policy、FamilySpec、Projection和declared output digests必须在执行前精确闭合。
5. **Host receipt != Core trust**：runtime bytes必须进入私有quarantine，Core重hash、closed-world admission并创建native OperationResult；不能直接成为candidate/publication。
6. **Publication authority**：只有Core创建PublicationCandidate、B3结果、ProductAssessment和Publication。Agent/Transform/FamilySpec/workspace不能直接publish。
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

## 当前受支持流程

```text
registered immutable source receipts
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

## 未来isolated backend

若未来增加isolated backend，必须使用独立ADR，证明低权限OS identity、network deny、credential stripping、read-only inputs、hard quota/kill/process-tree cleanup、restart/cancel/replay和same-commit release evidence。当前backend不能通过改名、`node:vm`、worker thread或普通child process升级为“sandbox”。
