# WP-D：GEO、GDC、Xena Provider Projection

## 1. 目的

把来源能力落实为可验证的 `source -> projection/schema` 输出，并区分声明能力、fixture 通过、trusted E2E 和 production activation 四种状态。

## 2. 共同原则

- Provider 只读取 Core 已登记且 receipt/hash/size 可信的 SourceAsset；
- Provider 输出 typed/file-backed rows，不以任意 URL/path 或 workspace 文件作为输入；
- source adapter 只声明真实可产出的 schema；
- source-specific transform 放在 provider adapter 边界，不散落到 generic runtime；
- 输出每张表都必须绑定 schema、operation result、source locator、asset receipt；
- 不能把 provider 成功或下载成功报告为 product 成功。

## 3. GEO 子轨道

复用现有：

- `server/src/dataset/adapters/geo/series-matrix.ts`
- `probe-mapping.ts`
- `sample-metadata.ts`
- `relations.ts`

交付：

1. 从 GEO input 派生稳定 `dataset_id` 和 source-scoped sample identity；
2. gene/probe primary projection；
3. `datasets`、`samples`、`probe_gene_mapping`、rejected/conflicts supporting/audit outputs；
4. metadata、platform annotation、mapping asset receipt closure；
5. expression semantic validation 和 ProductAssessment；
6. 单 GEO trusted E2E，包含 publication artifact hash parity。

GEO 完成不等于 gene_expression family production activation。

## 4. GDC 子轨道

交付：

- expression gene projection；
- samples 和 datasets；
- GDC source locator/accession/version receipt；
- scale/unit/normalization compatibility metadata；
- 与 GEO 共用 Schema、identity、integration、validation primitive；
- 无 probe mapping 时明确 allow-empty/unsupported 语义，而非伪造 mapping。

验收重点：GDC 数据能在同一 integration path 中与 GEO 合并，且样本 identity 不因裸 `sample_id` 发生跨 dataset 碰撞。

## 5. Xena 子轨道

交付：

- expression gene projection；
- samples、datasets 和 source metadata；
- Xena hub/cohort/asset locator receipt；
- 与 GEO/GDC 相同的 measurement compatibility policy；
- 大矩阵 streaming、checkpoint、cancel 和 artifact parity。

## 6. 状态模型

每个 capability 单独记录：

```text
declared
  -> parser_fixture_verified
  -> trusted_e2e_verified
  -> production_activated
  -> deprecated / blocked
```

Registry 中存在 `schema_refs` 只证明声明，不证明已完成上述后续状态。当前 family-level activation 模型未重构前，gene/probe + GEO/GDC/Xena 的相关 production checks 必须一起通过，不能只激活 GEO 后把整族标记为 ready。

## 7. 并行顺序

- GEO 可作为第一 vertical slice，在 A/B/C/E 的最小契约完成后启动。
- GDC、Xena 可在 Schema/identity contract 冻结后独立开发，分别拥有自己的 fixture、source receipt 和压力测试。
- 三者共享 integration/validation primitive；任何 provider 不得提交私有 table topology 或 merge identity。
- C/H 负责跨 source E2E 和 publication，不由单一 provider 分支自行宣布完成。

## 8. 测试

- 现有 GEO/GDC/Xena adapter parity 测试继续保留；
- 新增每个 source 的 table/schema/row granularity/identity tests；
- missing probe mapping、malformed metadata、multi mapping、unit mismatch、asset receipt mismatch；
- source binding reorder determinism；
- GEO+GDC、GEO+Xena cross-source integration；
- large input RSS/heap/temp/quota/cancel/restart；
- trusted E2E：task -> run -> build -> operation results -> validation -> publication -> download/hash。
