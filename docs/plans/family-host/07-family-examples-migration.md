# 六个 Family 迁移为 Retrieval Examples

## 1. 终态定位

现有六个 Family 不再是最终架构中的六套 Core 领域框架，而是高质量 reference corpus：

1. Agent few-shot / retrieval；
2. Transform SDK example；
3. fixture/regression；
4. legacy-vs-Host shadow parity；
5. Gold capability evidence；
6. 迁移和回滚样例。

迁移的目标不是把六个目录简单从 `server/src` 移到 `examples/`，而是先拆出 versioned declarative contract、exact Transform bundle、fixtures、expected assessment/publication，再逐 capability 消除 Core hardcode。

## 2. Example 形态

```text
examples/families/<family-id>/
  README.md
  family-spec.example.json
  transforms/<transform-id>/
    transform.ts
    manifest.example.json
  fixtures/input/
  fixtures/expected/
  retrieval-metadata.json
```

Example 不得：

- 被 `server/src` import；
- 通过目录扫描自动注册；
- 自带生产 credentials、network URL 或任意 package install；
- 以目录名/文件名代替 exact digest；
- 直接构造 OperationResult、PublicationCandidate 或 Publication。

## 3. 每个 Family 的迁移状态

```text
example_only
  -> host_fixture_verified
  -> core_shadow_verified
  -> trusted_e2e_verified
  -> activated
  -> legacy_retired
```

状态必须按 projection/source/transform capability 记录，而不是一个 family-level green flag。`activated` 可撤销；撤销不修改历史 Publication。

## 4. 推荐顺序

### 4.1 bioactivity_measurement

已有 ChEMBL/PubChem identity、crosswalk、ProductAssessment，适合第一例证明：多表、relation、crosswalk、deterministic identity 和 transform provenance。

### 4.2 gene_expression

作为大数据 donor 和第二个真实消费者：GEO/GDC partition、samples/datasets、probe mapping、disk-backed validation、streaming/recovery。

### 4.3 literature_evidence

验证 XML/BioC parser、论文/source locator、evidence confidence 和 audit closure。

### 4.4 target_evidence

验证多 provider JSON、crosswalk、entity/relation projection。

### 4.5 protein_structure

验证 PDB/mmCIF、reference version、derived evidence 和结构关系。

### 4.6 variant_evidence

验证 reference mapping、crosswalk 和 fixed derive/transform interaction。

Chart evidence 先作为 bioactivity/figure example 子例，不单独形成第七个 production family。

## 5. 单 Family 迁移步骤

1. inventory 静态 schema/adapter/assembler/validation/provider 特判；
2. 冻结旧 projection/manifest/publication compatibility fixture；
3. 生成 example FamilySpec 与 Transform descriptor；
4. 用 Host fixture 执行 Transform，输出 quarantine receipt；
5. Core shadow admission、integration、validation、assessment；
6. trusted E2E：acquisition -> transform -> Core result -> publication/artifact hash；
7. capability-level activation 与回滚演练；
8. 删除该 capability 的静态分支；
9. architecture guard 防止旧分支重新出现；
10. 只有所有调用者、历史 reader 和 rollback 条件满足后，才 retired legacy。

## 6. 不能一次性迁移的内容

- 不能因为一个 GEO fixture 通过就删除整个 expression runtime；
- 不能同时重写 acquisition、durable runtime、Publisher、前端；
- 不能以“six examples 已存在”宣称六个 Family 已被替代；
- 不能删除旧代码而没有 shadow evidence、历史 publication reader 和回滚点。

## 7. 验收

每个迁移 capability 必须提交：

- exact FamilySpec/Transform/compiled bundle digests；
- source/input/output receipt closure；
- fixture 与 expected assessment；
- legacy shadow diff；
- resource/cancel/restart evidence；
- Publication/Artifact API hash parity；
- activation/revoke/rollback 记录；
- Core 不 import example 的 architecture guard。
