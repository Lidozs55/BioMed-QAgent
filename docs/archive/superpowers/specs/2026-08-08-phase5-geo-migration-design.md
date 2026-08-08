# Phase 5 设计：迁移 GEO（Acquisition Provider + Adapter）

> 日期：2026-08-08
> 状态：**定稿（spec review 修订版 v3）**
> 作者：sol（finalization）→ controller（闭合 round-1 9 项 MUST-FIX，v2）→ controller（闭合 round-2 5 项 MUST-FIX，v3）→ ds（v3 最终验收）
> 分支：`feat/phase5-geo-migration`
> 权威依据：`docs/TODO.md` Phase 5、`docs/BioMed-QAgent_Pipeline_Refactor_Design.md` §16 Phase 5、Phase 4b NO_DATA 契约与 Phase 4 bug sweep 延后项。

## 1. 背景与目标

GEO 当前仍在 V1 deterministic pipeline 内以单 GSE、固定 fallback 链和专用 parser 分支运行。V2 已有 `DatasetBuildSpec -> SourceAdapter -> Canonicalizer -> Compatibility Gate -> Integrator -> Validation Profile -> Publication` 固定执行内核，但 adapter registry 只有 GDC/Xena，canonicalizer 只授权 `ensembl_gene`/`gene_symbol`，platform、probe mapping 和 value scale 也没有字段级契约。

Phase 5 的目标是把 GEO 接入既有 V2 内核，同时保持数据语义诚实：**probe-level 不冒充 gene-level（probe 行只允许在 probe 级契约下发布）**，不能证明兼容的测量值不合并（含 unknown×unknown），无表达或 gene-level 必需但完全无法映射时使用 Phase 4b 的 NO_DATA 语义。多 GSE 是多个独立 build/publication，不做跨 GSE 行级合并。

### 1.1 TODO Phase 5 六项到任务映射

| TODO Phase 5 | 交付任务 |
| --- | --- |
| P0 GEO acquisition/parser 按 Acquisition Provider 与 Adapter 拆分 | T2、T3 |
| P0 正式建模 platform、probe mapping、value scale 与 normalization | T1、T2、T3、T4 |
| P0 多 GSE 各数据集独立发布，`source_relations` 记录双侧关系 | T6 |
| P1 只有通过 Compatibility Gate 的 GEO 才能与其他表达数据整合；映射失败审计或 NO_DATA | T5、T7 |
| P1 消除 `_resolve_gse` 静默截断 | T6 |
| P2 `sample_metadata` 结构化 tumor/normal 分组与配对 ID | T8 |

## 2. 范围与非目标

### 2.1 范围

- 新增 builtin acquisition provider 的最小 GEO 层，复用 NCBI URL、下载尝试、checksum、fixture 资产语义。
- 新增 `geo.expression.v1` Adapter，覆盖 tximport counts、series matrix 和 supplementary expression matrix；Adapter 通过**类型化 `AdapterParams`** 接收格式/语义/尺度/单位/平台声明。
- 正式建模 `PlatformRecord`、`ProbeMappingSummary`、`ValueScale`、`AdapterParams`，注册 **probe 级输出契约 `gene_expression.probe_long.v1`（granularity `probe_sample_measurement`）**，授权 `geo_probe` 并记录 probe mapping 审计。
- 把 value scale 纳入 normalization 与 Compatibility Gate 的 measurement identity；**unknown×unknown 跨源默认不合并**。
- 多 GSE 拆成多个 `DatasetBuildSpec`，由 `MultiBuildOrchestrator` 编排为多个独立 build/publication；关系图使用显式双向行。
- 修复 V1 `_resolve_gse`/accession helper 的“首个匹配即返回”，多 GSE 显式 raise；这是本阶段唯一主动改变 V1 行为的部分。
- 结构化 tumor/normal 分组与 pairing ID。

### 2.2 非目标

- 不做前端或 API 迁移；Manifest-driven ResultsViewer、artifact role 消费、build API 与 operation event UI 属 Phase 7。
- 不迁移 PubMed 或 Reactome；PubMed 仅作为已有 provenance/source relation 的端点。
- 不大改 V1 pipeline；除 T6 的 raise-not-truncate 与共享 provider helper 接线外，V1 topology、工具参数面和 GEO fallback 顺序保持。
- 不做跨数据集行级合并。多 GSE 不拼表；T6 只验证一个显式跨源 build 是否通过 Compatibility Gate 进入既有 integrator。
- 不扩 `SUPPORTED_PIPELINE_SOURCE_COMBINATIONS`；V1 allowlist 维持原状。
- **不引入新的 acquisition provider 插件注册表。** D1 只定义稳定的 builtin `provider_id` 与普通 helper/dispatcher。
- 不迁移 V2 Dataset Cache，不修 Phase 4 bug sweep 的 durable `execution.build_result`、publication transaction 或 artifact ownership 延后项。

## 3. 现状足迹（2026-08-08 已核验）

| 文件:行 | 已核验事实 | Phase 5 影响 |
| --- | --- | --- |
| `backend/app/datasets/build/adapters.py:228-286,686-690` | `SourceAdapter.parse()` 校验 checksum、写 source-long/rejected 文件并调用 `_extract()`；registry 仅有 GDC/Xena；**`parse()` 签名无 `parameters`，runner 调用时也未传**（`expression_runner.py:319`） | T2 扩展接口：`parse(..., parameters: AdapterParams)`；T1 定义 AdapterParams |
| `backend/app/datasets/build/compat_gate.py:35-70` | gate 对每源检查 family/granularity/schema/formal mapping；仅 `len(results)>1` 时比较 identity 与 namespace | T5 用现有原因码，补 GEO 矩阵；单源不做跨源 identity 比较 |
| `backend/app/pipeline/processing/geo_tximport.py:23-32` | `GeoSampleMetadata` 无 sample group/pairing 字段 | T8 扩展契约与 artifact 输出 |
| `backend/app/pipeline/processing/geo_tximport.py:183-339,383-522,525-643,679-827` | 存在两条 series-matrix parser 语义、tximport parser 与 supplementary parser；scale 分别出现 `log2`、`unknown`、`linear` 和文件名启发式 | T2 统一为一个 V2 adapter 选择器；T4 禁止靠猜测把未知尺度声明为已知 |
| `backend/app/pipeline/stages/discovery.py:59,79-81,342-354` | spec validator 已拒绝多 GEO dataset/query；accession extraction 和 resolver 仍用首匹配 | T6 对一个字符串内的多个 accession 显式 raise，并保留 V1 单 GEO 限制 |
| `backend/app/pipeline/stages/processing.py:600-606` | V1 multi-dataset 分支遇 GEO `continue`，不把 GEO 加入可合并 parsed list | 不改；跨源判定只在 V2 |
| `backend/app/pipeline/stages/processing.py:653-671` | `_load_geo_gene_map` 只尝试 `platform_ids[0]`，异常降级 `annotation_unavailable` | T3 按证据化的 sample/platform 绑定尝试并形成 `PlatformRecord` |
| `backend/app/domain/contracts/source.py:37-44` | `SourceRelation` 已是有向 `from_source_id -> to_source_id`，无 direction 字段 | D3 选择显式 inverse rows，不改契约 |
| `backend/app/pipeline/stages/artifact_build/relations.py:11-86` | 当前主关系只有 acquired PubMed→GEO；额外 PMID 为 GEO→external PMID，非双向 | T6 对每个有证据的 GSE/PMID pair 输出正反两行 |
| `backend/app/datasets/contracts.py:102-120,141-158` | builtin acquisition 已有必填 `provider_id`；`DatasetBuildSpec.source_bindings` 是非空 list | D1 使用现有字段；多 GSE 是多 spec，由 T6 编排 |
| `backend/app/datasets/contracts.py:366-382` | `NormalizationProfile` 只有 namespace/unit/semantics/conversion/aggregation，无 scale allowlist | T4 增加 `allowed_value_scales` |
| `backend/app/datasets/build/canonicalizer.py:88-96,98-285` | namespace 由 ID pattern 推断（symbol regex 会把部分字母数字 probe 误认成 `gene_symbol`）；identity 已收集 `(value_semantics,value_scale,unit)`，但未验证 scale | T1 source-long `gene_id_namespace_declared` 列；T2 canonicalizer 消费声明；T4 校验 scale |
| `backend/app/domain/contracts/enums.py:66-74` | V1 allowlist 有 GEO、PubMed+GEO、GDC+Xena，无 GEO+GDC/Xena | 保持不动 |

## 4. 设计决策 D1-D7

### D1. 最小 Provider 层 + `geo.expression.v1` Adapter

#### Provider 边界

使用既有 `SourceBindingAcquisition(mode="builtin", provider_id=...)`。Phase 5 定义以下稳定 ID：

- `geo.series.v1`：按固定优先序解析/获取 series 资产：tximport counts + family SOFT、series matrix、supplementary matrix listing/file。
- `geo.platform.v1`：获取 GPL annotation 资产。

provider 层只负责 accession 校验、URL 构造、下载尝试/大小限制/checksum、fixture 资产选择和 `SourceAsset` 形成；不解析表达行、不决定 namespace、不映射 probe、不选择 Profile、不发布。实现可以是普通模块函数和一个显式 `provider_id` dispatcher；不得新增插件 registry。

#### `AdapterParams`（类型化适配器参数，T1 契约）

新契约类型（`app/datasets/contracts.py`，`extra="forbid"`）：

| 字段 | 类型/约束 | 含义 |
| --- | --- | --- |
| `format` | `Literal["tximport_counts","series_matrix","supplementary_matrix"]` | 必填；解析格式 |
| `value_semantics` | 非空 str | 测量语义（如 `expression` / `raw_count` 等） |
| `value_scale` | `ValueScale` 枚举 | 必填；`unknown` 合法且诚实 |
| `expression_unit` | 非空 str | 表达单位 |
| `is_normalized` | `bool = False` | 质量/解释字段，不进入 identity |
| `platform_ids` | `list[str]` | probe 格式可空（空 → not_attempted 审计） |
| `delimiter` | `str | Literal["auto"] = "auto"` | 仅 supplementary 使用；`auto` 只识别 CSV/TSV，**不推断测量语义/尺度** |

**验证与传播**：
- Spec Validator（`dataset_build_tool.py` 入口 + `DatasetBuildSpec` 模型）校验：`format` 必填且合法；`platform_ids` 全部匹配 `^GPL\d+$`；`delimiter="auto"` 之外仅限 supplementary；未知/不适用参数 → `invalid_input`。
- `ExpressionBuildRunner.run_operation` 把 `binding.parameters` 构造为 `AdapterParams` 传给 `adapter.parse(..., parameters=...)`；`chain.py` 同步透传。
- **digest 效果**：`AdapterParams` 的规范化 JSON 进入**按 binding 键控的 parameter digest**——`DatasetBuildExecutor._compute_parameter_digest` 扩展为 per-binding `parameter_scope`（键为 `binding_id`，值为该 binding 的 `AdapterParams` 规范化 JSON），同时将该 digest 纳入 `_compute_input_digest` 的依赖（参数变更 → input digest 变化 → 既有 checkpoint 失效）。T2 必须验证：同一 binding 修改 format/scale/unit/platform_ids 任一参数后重跑，不复用旧 checkpoint。

#### Adapter 接口

`GeoExpressionAdapter(SourceAdapter)`：

```text
adapter_id = "geo.expression.v1"
version = "1.0.0"
source_database = "geo"

parse(source_asset, source_path, *, build_id, binding_id,
      schema_ref, output_dir, parameters: AdapterParams) -> DataBatch
```

Adapter 输出既有 source-long 列和 `DataBatch`：结构错误、checksum mismatch、截断 gzip、列宽/样本头冲突 fail closed；非有限单元格写 rejected audit；无有效表达行抛 typed `EmptySourceError`。Adapter 不执行 probe→gene 映射。

namespace 不能继续只靠 symbol regex 猜测：Adapter 在 batch statistics 写 `source_gene_id_namespace`，每一 source-long 行增加内部 `gene_id_namespace_declared`（canonical schema 输出仍以 `gene_id_namespace` 为权威）。tximport ENSG 为 `ensembl_gene`；series/supplementary 的 ID_REF 只有符合 ENSG 才为 `ensembl_gene`，其余默认 `geo_probe`。Canonicalizer 必须消费声明而非把任意字母数字 probe 当 `gene_symbol`（**修复 canonicalizer.py:88-96 的外形猜测**）。

V1 parser 可被小步重构为共享纯解析 helper，但 Phase 5 不要求删除 V1 parser 或改变其输出。fixture 缺口使用 copy-directory + added/corrupted asset 模式，不修改共享 GSE178352 fixture。

### D2. 实体级输出契约（gene vs probe，P0 MUST-FIX 1）

**核心规则：`geo_probe` 行只允许在 probe 级契约下发布；gene 级 schema 下任何残留 probe/ambiguous 行使 Profile FAILED。**

1. **Schema Registry 注册两个实体级 schema**：
   - `gene_expression.long.v1`（现有；granularity `gene_sample_measurement`；`gene_id_namespace ∈ {ensembl_gene, gene_symbol}`，不含 `geo_probe`）。
   - **新增 `gene_expression.probe_long.v1`**（granularity `probe_sample_measurement`）。**完整字段清单（基于 22 列 gene schema 的实体级镜像）**：`probe_id`（probe 标识，如 ID_REF）、`platform_id`（`^GPL\d+$`）、`sample_id`、`value`（表达值）、`gene_id_namespace`（允许 `geo_probe`；映射成功行可为目标 namespace）、`value_semantics`、`value_scale`、`expression_unit`、`is_normalized`、`source_id`/`binding_id`/`provenance` 等 source-long 列。**主键 `(probe_id, platform_id, sample_id)`**；无 `gene_symbol`/`ensembl_gene` 主列（那是 gene 级概念）。Schema Registry 注册该 schema 时声明其 granularity 与主键；适配器/规范化器/积分器/验证 Profile 按 schema 元数据驱动列处理，不在代码中硬编码列名。
2. **声明**：`DatasetBuildSpec` 新增可选 `target_entity_level: Literal["gene","probe"] | None = None`（None → 由所选 validation profile 的 `required_entity_level` 决定）。Spec Validator 校验其与 profile 兼容（见 D4）。
3. **Schema 选择**：`gene_expression.long.v1` 配 `gene_sample_measurement`；`gene_expression.probe_long.v1` 配 `probe_sample_measurement`。manifest `dataset_manifest.json` 记录 `entity_level`（发布行的实际实体级：全部 gene → `gene`；存在 `geo_probe` → `probe`）；**manifest 必须列出全部实际 namespace**，不得汇总成 "gene-level"。
4. **Gate/Profile 选择**：Compatibility Gate 的 schema/granularity 检查天然区分两契约；跨实体级 build（probe primary + gene primary）→ `namespace_mismatch`/granularity 不符 reason（见 D5 矩阵）。Validation Profile 按实体级选择（`gene_expression.release.v1` 要求 gene；新增 `gene_expression.probe_release.v1` 要求 probe）。
5. **映射审计**：probe→gene canonicalization 输出独立于主表：命中行（有可信映射）在主表中改为目标 namespace（但整表仍是 probe 级契约下）；未命中与 ambiguous 行保持 `geo_probe`；映射明细作为 audit CSV 发布。

### D3. platform、probe mapping、value scale 字段级契约

契约放在 `app/datasets/contracts.py`；均 `extra="forbid"`，由现有 `ContractModel` 保证。

#### `PlatformRecord`（独立模型）

一个 platform 可被多个矩阵/映射尝试复用；organism/asset provenance 不属于统计摘要。

| 字段 | 类型/约束 | 含义 |
| --- | --- | --- |
| `platform_id` | `str`, `^GPL\d+$` | GEO platform accession |
| `source_id` | 非空 `str` | platform SourceRecord/逻辑来源 |
| `annotation_asset_id` | `str | None` | 成功获取的 GPL `SourceAsset.asset_id` |
| `organism` | `str | None` | platform organism；未知为 None，不猜测 |
| `annotation_status` | enum | `mapped | unmapped | no_gene_annotation | annotation_unavailable | not_attempted` |
| `probe_id_field` | `str | None` | 实际 probe 列名 |
| `gene_id_field` | `str | None` | 实际 gene 列名 |
| `target_namespace` | `gene_symbol | ensembl_gene | None` | 映射目标 |
| `mapping_source_url` | `str | None` | annotation 来源 URL |
| `annotation_sha256` | 64 hex `str | None` | 映射所用资产摘要 |

**跨字段校验（pydantic validators，P1 MUST-FIX 8）**：
- `annotation_status == "not_attempted"` ⇒ `annotation_asset_id`/`mapping_source_url`/`annotation_sha256` 全 None；
- `annotation_asset_id` 存在 ⇒ `annotation_sha256` 必须存在且为 64 hex，`annotation_status ∈ {mapped, unmapped, no_gene_annotation}`（有资产才可判定映射状态）；
- `annotation_status == "mapped"` ⇒ `target_namespace` 非 None 且 `gene_id_field` 非 None；
- `platform_id` 必须 `^GPL\d+$`。

#### `ProbeMappingSummary`

每个 canonicalized binding/platform 组合一条；统计 probe entity，不按展开后的 gene×sample 行重复计数。

| 字段 | 类型/约束 | 含义 |
| --- | --- | --- |
| `binding_id` | 非空 `str` | 对应 SourceBinding |
| `platform_id` | `str | None` | 使用的平台；未尝试可 None |
| `source_namespace` | 固定 `geo_probe` | 映射源 namespace |
| `target_namespace` | `gene_symbol | ensembl_gene | None` | 映射目标 |
| `mapping_status` | enum | `mapped | partial | unmapped | no_gene_annotation | annotation_unavailable | not_attempted`；**语义**：`mapped` = coverage==1.0 完全映射；`partial` = 0 < coverage < 1；`unmapped` = coverage==0 |
| `total_probe_count` | `int >= 0` | 去重 probe 数 |
| `mapped_probe_count` | `0 <= int <= total` | 至少一个可信映射的 probe 数 |
| `unmapped_probe_count` | `int >= 0` | 未命中 probe 数 |
| `ambiguous_probe_count` | `int >= 0` | 多目标且未按明确规则消解的 probe 数 |
| `coverage_ratio` | `float` | `mapped / total`；`total=0` 时为 `0.0` |
| `mapping_asset_id` | `str | None` | annotation SourceAsset |
| `mapping_rule_id` | `str | None` | 映射/多对一处理规则版本 |

**跨字段校验（P1 MUST-FIX 8，全集）**：
- `mapped_probe_count + unmapped_probe_count == total_probe_count`；
- `ambiguous_probe_count <= unmapped_probe_count`（ambiguous ⊆ unmapped）；
- `0 <= mapped_probe_count <= total_probe_count`；
- `coverage_ratio` 与 `mapped/total` 一致（`total=0 → 0.0`），容差 1e-9；
- **status ↔ 计数一致性**：`mapped` ⇒ `coverage_ratio == 1.0`；`partial` ⇒ `0 < coverage_ratio < 1`；`unmapped` ⇒ `coverage_ratio == 0.0`；`not_attempted` ⇒ 计数全 0、`mapping_asset_id`/`mapping_rule_id` None；
- `mapping_status ∈ {mapped, partial}` ⇒ `mapping_asset_id` 非 None；
- `mapping_asset_id` 存在 ⇒ 对应 `SourceAsset.sha256` 必须与 mapping audit 记录的资产摘要一致（**双向一致性**：asset 缺 sha 或 sha 不匹配均拒绝）。

**序列化/往返不变量（T1 测试必含）**：`model_dump → model_validate` 往返保真（extra=forbid 下无字段丢失/新增）；`coverage_ratio` 序列化保留精度（容差 1e-9）；空计数/全零对象合法序列化。

映射明细 audit CSV 至少包含 `binding_id, platform_id, probe_id, target_gene_id, target_namespace, status, evidence_asset_id, rule_id`。

#### `ValueScale`

`StrEnum` 字段值：`linear | log2 | log10 | unknown`。`raw_count` 不是 scale，而是 `value_semantics`/unit。`unknown` 是诚实值，不可与已知 scale 自动兼容；supplementary 文件名只能帮助选择候选资产，不能证明 scale；不能由 metadata/参数证明时必须声明 `unknown`。

`NormalizationProfile` 增加 `allowed_value_scales: list[ValueScale]`。Canonicalizer 在接纳行前同时验证 namespace、semantics、scale、unit。

#### Measurement identity

Compatibility Gate 的 identity 固定为有序三元组 `(value_semantics, value_scale, expression_unit)`。`is_normalized` 和 `is_integer_expected` 是质量/解释字段，不加入 identity；与三元组矛盾时由 Profile check 拒绝。

### D4. Compatibility Gate 与 coverage 策略（含 unknown 与 entity-level 门）

Gate 继续复用 `check_expression_compatibility`，不引入 GEO 特例绕过。测试矩阵固定如下：

| 场景 | 预期 |
| --- | --- |
| 单 GEO，family/granularity/schema/formal mapping 合法 | compatible |
| 任一来源 family/granularity/schema 不符 | 对应既有 reason code |
| 缺 formal mapping 或 string-similarity proposal | `missing_mapping_evidence` |
| 跨源且 identity 完全一致、namespace 单一 | compatible |
| `log2` vs `linear`，或 semantics/unit 任一不同 | `measurement_identity_mismatch` |
| **任一来源 scale 为 `unknown` 的跨源合并** | **`measurement_identity_mismatch`（unknown×unknown 也必须 FAIL，除非服务端持有 evidence-backed normalization/conversion 规则建立等价；Phase 5 不实现该规则）** |
| 单一来源 scale 为 `unknown` | 可发布（诚实 scale=unknown）；Profile 校验 identity 内一致性 |
| gene-level 与残留 `geo_probe` 并存 | `namespace_mismatch` |
| probe-level build（`probe_long.v1`）与 probe-level build，identity 相同 | gate 可 compatible；只能按 probe 级契约发布 |
| 一个来源 NO_DATA、另一个非空 | 空源不伪造 identity；结果由 Profile/BuildResult partial/no-data policy 决定 |
| 所有来源空 | `no_sources`/typed NO_DATA，不进入 integrator publication |

**`probe_mapping_coverage` 校准前策略（P1 MUST-FIX 6）**：

- **新 Profile 字段**：`required_entity_level: Literal["gene","probe","any"]`（服务端版本化 ValidationProfile 字段；**Agent 不得经 binding parameters 设置**）。现有 `gene_expression.release.v1` 声明 `"gene"`（默认 gene 构建）；新增 `gene_expression.probe_release.v1` 声明 `"probe"`。
- **Spec Validator 兼容检查**：build 的 `target_entity_level`（若设置）与 profile 的 `required_entity_level` 必须兼容：`gene` build + `probe` profile → `invalid_input`；`probe` build + `gene` profile → `invalid_input`；未设置时由 profile 决定。
- build 未显式要求 gene-level（probe build）：**warning-only**；任何 coverage（含 0）都可发布诚实的 `geo_probe` 数据与 audit。
- build 显式要求 gene-level（profile `required_entity_level="gene"`）：coverage 必须为 **1.0**，任何残留 probe/ambiguous 行均 FAILED。这是输出语义完整性，不是统计阈值校准。
- Phase 6 后续可在版本化 Profile 中引入经校准的中间覆盖率门槛。

### D5. 映射失败与 NO_DATA（P0 MUST-FIX 2：操作级语义）

行为按两个正交维度决定：是否存在真实表达行、build 是否要求 gene-level。**执行器/工具层映射固定如下**：

| # | 表达行 | 实体要求 | 结果 | 执行器/工具行为 |
| --- | --- | --- | --- | --- |
| 1 | 无（typed `EmptySourceError`） | 任意 | **NO_DATA** | `BuildResult.status=no_data`、`valid_row_count=0`、无 primary publication、`publication_id=None`；supporting/audit 保留；不得生成 schema-only/sample-metadata 假主表（4b 授权绑定仍适用） |
| 2 | 有 | probe 级 | **发布 probe primary** | 所有行保持 `geo_probe`（或映射后目标 namespace，整表 entity_level=probe）；发布 PlatformRecord/ProbeMappingSummary/audits + warning；gate 阻止与 gene 来源合并 |
| 3 | 有 | gene 级 | **Validation FAILED** | coverage<1.0 → Profile FAILED，不发布 primary；工具分类器（`_classify_failed_outcome`，`dataset_build_tool.py`）将"无任何满足 gene 级的有效行"归类为 **NO_DATA**，稳定 reason code `probe_mapping_unavailable_required_gene_level`；多 binding 中仍有满足要求的来源 → 按既有 partial policy（**wave-7 定稿：中止的混合源 build 永不判 PARTIAL_SUCCESS；有可发布满足来源时才 partial**），失败 GEO binding 的 audit 必须保留 |
| 4 | 有 | probe 级、部分映射 | **发布混合 namespace** | mapped 行可为目标 namespace，未映射保持 `geo_probe`；混合 namespace 单源可发布，但 manifest 必须列出两个 namespace；不能通过跨源 merge gate |

**操作级细节（T7 必须实现并可测）**：
- **per-binding fan-out plan**：`DatasetBuildExecutor` 的 plan 结构改为**按 binding 扇出的二段拓扑**——段 A（per-binding：acquire/parse/canonicalize 对每个 binding 独立执行，一个 binding 的 `EmptySourceError`/parse 失败被**捕获为 per-binding rejection**（`per_binding_outcomes: dict[binding_id, BindingRejection]`），不中止其他 binding 的段 A）；段 B（integrate/validate/publish 只接收段 A 成功的 binding；全部 binding 失败时段 B 跳过）。该拓扑变更在 T7 内实现并测试（保留既有 GDC/Xena 单 binding 路径行为不变）。
- **audit 存活**：段 A 的 mapping report/probe audit/platform provenance/rejected 在段 B 前已写入 staging supporting/audit 资产；Profile FAILED 时不发布 primary，但这些 supporting/audit 资产随 **4b 的 NO_DATA-with-audit 包路径** 发布（沿用 4b `validate_package` 的 NO_DATA 授权分支；**不新建 audit-only publication 路径**）。
- **pipeline 层与 tool 层分工**：pipeline 层在"build 要求 gene 且无任何可发布 gene 行"时进入 4b NO_DATA 授权路径（等价无表达）；"要求 gene 且存在可发布行但 coverage<1.0"时 Profile FAILED（不发布 primary，supporting/audit 已发布）。**tool 层**（`dataset_build_tool.py` 的 `_classify_failed_outcome`）把上述两种情况统一归类为 **NO_DATA**，稳定 reason code `probe_mapping_unavailable_required_gene_level`——classifier 输入扩展为 `(outcome_error, per_binding_outcomes, profile_required_entity_level)`，不再仅靠 `no_primary_data` 子串/枚举。
- **分类器**：`probe_mapping_unavailable_required_gene_level` 仅在"gene 要求 + 零可发布 gene 行"时产出；probe-level coverage 0 走 #2 不产该码。

### D6. 多 GSE 独立发布与双向关系（P0 MUST-FIX 9：编排 owner）

**每个 GSE 生成一个 `DatasetBuildSpec`**，具有独立 `build_id`、binding、checkpoint、manifest、validation result 和 immutable publication。**不得**把多个 GSE bindings 放入一个 append/dedup build 来实现"多 GSE"。

**编排 owner**：新增 `backend/app/datasets/build/multi_build.py` —— `MultiBuildOrchestrator`：

- 输入：`list[DatasetBuildSpec]`（调用方/Agent 为每个 GSE 生成一个）；输出 `MultiBuildResult`（`list[BuildExecutionSummary]`，每项含 build_id/status/`BuildResult`/publication_id/audit 摘要——**不使用已删除的 `BuildOutcome` 概念**；`BuildResult` 是权威业务结果，`BuildExecutionSummary` 仅聚合 build_id→BuildResult 的映射与失败详情）。
- **失败隔离**：逐 build 执行（顺序或受限并发），一个 GSE 失败/NO_DATA **不回滚、不污染**其他 GSE publication。
- **no-supersede 断言**：不同 GSE 的 publication 互不 supersede。**实现边界**：supersede 查找必须按 build_id 作用域——`ExpressionBuildRunner._publish` 的 `find_latest_publication(publish_dir)` 改为限定同一 build_id 的版本目录（或每 build 使用隔离的 publish 子目录 `publish/<build_id>/`）；orchestrator 汇总时断言无跨 build supersede。T6 必须实现该作用域，不能仅事后断言。
- `execute_dataset_build` Agent 工具保持单 build 语义（Agent 可多次调用）；orchestrator 是服务端编排入口（V1 多 GSE 显式 raise 后的建议路径与 Phase 7 build API 的接缝）。

`SourceRelation` 已是有向边，最终选择**每个方向一条显式 row**，不新增 direction 字段：

- 正反各唯一 `relation_id`；`relation_type` 用互为 inverse 的稳定值：GSE/PMID 用 `article_describes_dataset` 与 `dataset_described_by_article`。
- GSE/GSE 仅在明确证据时建边（`related_series` 双向两行）；同一请求不构成证据。
- 共享 PubMed：**每个有 GEO metadata 证据的 GSE×PMID pair 输出两行**。已获取 PMID 用本地 source_id；未获取用稳定 `ext:pubmed:<pmid>`。去重键 `(from_source_id,to_source_id,relation_type,evidence_type,evidence_value)`，输出按该键排序。
- V2 relation audit 与 V1 `source_relations.csv` 共用生成 helper，避免语义漂移。

### D7. 消除 `_resolve_gse` 静默截断

统一 discovery/acquisition accession helper：对输入用 `finditer/findall`，uppercase 后按首次出现顺序去重。

- 0 个：保留当前 None/调用方错误行为。
- 1 个：返回该 accession。
- 多于 1 个：V1 在 discovery 前显式 `ValueError`，列出全部 accession，提示拆成多个 V2 build。

同时检查 query 与 dataset selections 的**全部候选集合**（query 中 GSE1、dataset 中 GSE2 也必须 raise）。`_validate_pipeline_source_specification` 的"最多一个 GEO query/dataset"继续存在，但不替代字符串内多 accession 检测。V2 Agent/调用者负责形成多 spec。

### D8. platform→sample 关联（P1 MUST-FIX 7）

**样本→平台证据**：平台归属证据来自 series matrix 的 GSM 行或 SOFT sample 元数据中的 `platform_id`（每 GSM 声明的 GPL）。

- **关联算法**：为每个 sample 收集其声明的 GPL；一个 GPL 的 annotation **只映射到声明该 GPL 的样本**（`sample_platform_evidence` 进入 audit）。
- **单平台矩阵**：全部样本声明同一 GPL → 直接使用该 GPL mapping。
- **多平台矩阵**：样本按 GPL 分组——per-platform binding 拆分（每个 platform 一个 mapping/audit），或在无法安全归属时 fail-closed → NO_DATA。
- **series-level fallback（窄）**：仅当证据表明**单个 GPL 覆盖整个 series**（全部样本声明同一 GPL）时才允许把该 GPL 的 annotation 用于全部样本；**禁止无条件"取第一个可用 GPL"**（修正草案 T3）。
- **测试**：GPL A 的 mapping 绝不被应用到 GPL B 样本；无证据的多 GPL → fail-closed/NO_DATA。

## 5. 任务分解（T1-T9，red-first，DAG）

### T1. GEO 契约层 + 实体级列（P0 MUST-FIX 4：契约先行）

- **交付物**：`PlatformRecord`、`ProbeMappingSummary`、`ValueScale`、`AdapterParams`（含字段校验/跨字段 validator）；`gene_expression.probe_long.v1` schema + `probe_sample_measurement` granularity 注册进 Schema Registry；`DatasetBuildSpec.target_entity_level` 字段 + Spec Validator 检查；source-long 增加 `gene_id_namespace_declared` 内部列（canonical schema 输出仍以 `gene_id_namespace` 为权威）。
- **关键文件**：`backend/app/datasets/contracts.py`、schema registry 相关、`backend/app/datasets/build/canonicalizer.py`（仅列定义）、tests。
- **red-first 测试**：先证明当前 probe 被 symbol regex 误分类（canonicalizer.py:88-96 的外形猜测）；覆盖 declared namespace 列、非法 AdapterParams 拒绝、跨字段 validator 违约拒绝（asset 无 sha、mapped 无 target、mapped+unmapped≠total、ambiguous>unmapped）、probe schema 注册后可被 Spec Validator 选择。
- **依赖**：无（全 DAG 的根）。

### T2. `geo.expression.v1` Adapter

- **交付物**：GEO adapter 与 registry 注册；三种显式 format；`parse(..., parameters: AdapterParams)` 接口；source-long、rejected audit、typed empty/error；**AdapterParams 进入 operation digest**；`chain.py` + `ExpressionBuildRunner` 参数透传；共享纯 parser helper（仅必要时）。
- **关键文件**：`backend/app/datasets/build/adapters.py`（可拆 `geo_adapter.py`）、`backend/app/datasets/build/expression_runner.py`、`chain.py`、tests/fixtures。
- **red-first 测试**：registry 未识别、三格式最小输入、checksum mismatch、截断 gzip、坏表头/列宽、非有限值 rejected、零有效行 `EmptySourceError`、**缺/未知/格式不适用参数拒绝**、参数变更使 checkpoint 失效（digest）。
- **依赖**：T1。

### T3. 最小 GEO acquisition/platform provider（含 platform→sample 关联）

- **交付物**：`geo.series.v1`/`geo.platform.v1` helper/dispatcher；V1 调用共享 URL/获取逻辑；**D8 的样本→GPL 证据关联**（per-sample GPL、单平台 fallback 窄规则、多平台拆分或 fail-closed）；每 GPL 记录 `PlatformRecord`；不建 provider registry。
- **关键文件**：`backend/app/pipeline/stages/acquisition.py`、`backend/app/pipeline/stages/processing.py`、`backend/app/pipeline/processing/geo_annotation.py`、新 provider module。
- **red-first 测试**：builtin provider ID、URL 前缀、checksum/size fail closed、GPL A 映射绝不用于 GPL B 样本、多 GPL 无证据 fail-closed/NO_DATA、单平台全系列 fallback、全部不可用、无 GPL not_attempted、V1 fallback 顺序不回归。
- **依赖**：T1。

### T4. ValueScale 与 normalization identity

- **交付物**：`ValueScale`；`NormalizationProfile.allowed_value_scales`；canonicalizer scale validation；identity 固定 `(semantics,scale,unit)`；现有 profiles 显式补齐允许值；`required_entity_level` Profile 字段 + `gene_expression.probe_release.v1` 注册。
- **关键文件**：`backend/app/datasets/contracts.py`、`backend/app/datasets/build/profiles.py`、`backend/app/datasets/build/canonicalizer.py`、tests。
- **red-first 测试**：非法 scale 契约拒绝、profile 外 scale rejected、`raw_count` 不能作为 scale、`unknown` 不被推成 log2、identity 三元组稳定排序、`unknown`×`unknown` 跨源 gate FAIL（与 T5 交界处先建 gate 测试）、既有 GDC/Xena 测试不回归。
- **依赖**：T1。

### T5. GEO Compatibility Gate 与 coverage Profile policy

- **交付物**：D4 完整 gate 矩阵（含 unknown×unknown 与 entity-level 矩阵）；`required_entity_level` 校验（gene/probe profile 互斥选择）；稳定 reason/check ids；V1 allowlist 不变测试。
- **关键文件**：`backend/app/datasets/build/compat_gate.py`、`backend/app/datasets/build/profiles.py`、gate/profile tests。
- **red-first 测试**：逐项覆盖 D4 表；尤其 unknown×unknown FAIL、log2/linear、geo_probe/gene、probe-only、empty source、非 gene-level coverage 0 warning、gene-level coverage<1 FAILED、Agent 经 binding 参数切换 entity policy 被拒。
- **依赖**：T1、T4（§8 的 `T2+T4 → T5` 经 T2→T1 传递闭合，等价）。

### T6. 多 GSE 编排、双向 relations 与 raise-not-truncate

- **交付物**：`MultiBuildOrchestrator`（`multi_build.py`：逐 build 执行、失败隔离、no-supersede 断言、`MultiBuildResult`）；共享 relation generator 输出 inverse rows；V1 resolver/acquisition helper 全候选检测并 raise。
- **关键文件**：`backend/app/datasets/build/multi_build.py`、`backend/app/pipeline/stages/discovery.py`、`backend/app/pipeline/stages/acquisition.py`、`backend/app/pipeline/stages/artifact_build/relations.py`、tests。
- **red-first 测试**：同一字符串两个 GSE、query/dataset 各一不同 GSE、重复同一 GSE 去重；两个 copy-dir fixture build 得到不同 build/publication、一方失败不影响另一方、**两 publication 互不 supersede**；每个 evidenced GSE×PMID 恰两行、external PMID 双向、无证据不造边、稳定排序/去重。
- **依赖**：T1、T5。

### T7. GEO mapping failure / empty expression E2E

- **交付物**：D5 表 4 行结果端到端；per-binding fan-in 继续执行；typed reason；audit 随 NO_DATA-with-audit 信封保留；与 Phase 4b NO_DATA 契约一致。
- **关键文件**：`backend/app/datasets/build/expression_runner.py`、`backend/app/datasets/runtime/executor.py`（per-binding outcomes）、`backend/app/pipeline/dataset_build_tool.py`（`_classify_failed_outcome` 扩展）、GEO E2E tests。
- **red-first 测试**：copy-dir + 损坏/空资产 → NO_DATA、无 primary、`publication_id=None`；coverage 0 probe-level 可发布且有 warning/audit；coverage 0 gene-level → NO_DATA + `probe_mapping_unavailable_required_gene_level`；多源尚有有效 gene 源 → partial policy 且保留失败 GEO audit；**一个 binding 失败不中止另一 binding**（per-binding outcomes）。
- **依赖**：T2、T3、T5；依赖 Phase 4b typed/no-primary 语义和 V2 内核。

### T8. tumor/normal sample metadata 与 pairing

- **交付物**：`GeoSampleMetadata` 增加 `sample_group`, `sample_group_raw`, `pairing_id`, `group_rule_id`；SOFT/series-matrix 共用版本化提取器；sample_metadata artifact 增列。
- **关键文件**：`backend/app/pipeline/processing/geo_tximport.py`、`backend/app/pipeline/stages/artifact_build/samples.py`、fixtures/tests。
- **red-first 测试**：规范键/别名、大小写/分隔符、冲突、未知值、不存在 pairing、显式 patient/subject 配对、同一 pairing 下 tumor+normal 一致性；既有 cell-line fixture 不回归。
- **依赖**：可与 T4/T5 并行；最终 E2E 依赖 T2。

#### T8 词汇表定稿

服务端版本化、封闭规则 + 原值保留；`group_rule_id="geo.sample-group.v1"`：

1. key 规范化：trim、lower、`_`/`-` 转空格、折叠空白。
2. 高置信 key 优先级：`sample type`, `tissue type`, `disease state`, `condition`, `tumor normal`, `tumour normal`；`source name`/title 仅在无高置信字段时作为低优先 evidence。
3. canonical group 仅 `tumor | normal | unknown`。tumor token：`tumor,tumour,cancer,carcinoma,malignant,primary tumor,metastatic`；normal token：`normal,adjacent normal,normal adjacent,non-tumor,non tumour,healthy,control tissue`。cell-line 的 `control` 不自动等于 normal。
4. 同优先级证据冲突 → `unknown` + warning，不按关键词次数投票。
5. `sample_group_raw` 保存命中的 `key:value`；未命中为空。
6. pairing 只接受显式键 `pair id, pairing id, patient id, subject id, donor id, individual id`；规范化值后生成稳定 `pairing_id`。不得从 GSM 顺序、sample title 相似度或同一 GSE 猜 pairing。一个 pairing 可缺一侧并 warning；同一 pairing 有 tumor+normal 才形成有效 pair。

## 6. 验收标准

### 6.1 Design §16 Phase 5

| 验收原文 | 达成证据 |
| --- | --- |
| gene-level 与 probe-level 清楚区分 | T1 probe schema/entity_level + declared namespace；T2 `geo_probe`/mapped namespace 与 audit；T5 namespace/granularity gate；T7 manifest/E2E |
| 无映射时发布策略明确 | D5；T5 warning/FAILED policy；T7 probe-level audit publication 与 gene-level NO_DATA/partial E2E |
| 测量尺度不兼容时不合并 | D4 identity；T4 scale validation；T5 `measurement_identity_mismatch` 矩阵（含 unknown×unknown） |

### 6.2 TODO Phase 5 六项验收映射

| TODO | 必须通过的验证 |
| --- | --- |
| Provider + Adapter 拆分 | T2 registry/三 parser + T3 provider boundary；无 provider plugin registry |
| platform/probe/value scale/normalization | T1 字段契约与 mapping audit + T3 GPL provenance + T4 scale/profile |
| 多 GSE 独立发布/双侧 relation | T6 两 publication 隔离 + 互不 supersede + 每 pair inverse rows |
| Gate 后才整合，mapping failure audit/NO_DATA | T5 全矩阵 + T7 四行结果 E2E |
| `_resolve_gse` 不截断 | T6 字符串内/跨字段 multi-GSE red tests |
| tumor/normal 与 pairing | T8 vocabulary、conflict、explicit pairing tests |

### 6.3 终态系统断言

- `geo.expression.v1` 通过 V2 固定 Operation plan；成功 operation 可 checkpoint 复用（AdapterParams 入 digest），发布遵守 provenance closure、Profile passed、atomic promotion。
- 多 GSE publication 互不覆盖、互不 supersede。
- 任一 primary row 的 `gene_id_namespace` 与实际实体级一致；`geo_probe` 行只出现在 `probe_long.v1` 契约下；manifest 列出全部 namespaces 与 `entity_level`。
- 没有任何通过文件名、样本标题或 probe 外形把未知 scale/entity/pairing 提升为已知的路径。
- unknown×unknown 跨源不合并（除非服务端 evidence-backed 规则）。

## 7. 风险与依赖

- **Phase 4b NO_DATA 契约**：T7 必须复用可信 no-primary 授权，保持 supporting/audit、无假主表、`valid_row_count=0`、NO_DATA BuildResult 无 `publication_id`。
- **V2 执行内核**：T2-T7 依赖 `DatasetBuildExecutor` operation/checkpoint/atomic publish；不得为 GEO 建旁路。Phase 4 bug sweep 的 `V2-dup` durable result 接线仍是开放风险，本阶段只在 build/tool 边界验收并在文档中保持可见。
- **fixture 缺口**：共享 fixture 没有完整 series matrix、GPL annotation、tumor/normal/pairing 样例，fixture acquisition pin GSE178352。使用临时 copy-directory + added/corrupted asset；不得修改共享 fixture 或靠 live network。
- **scale 元数据质量**：GEO metadata 常不能证明 scale；`unknown` 减少跨源可合并率是 fail-closed 的预期代价。
- **platform 多样性**：样本↔GPL 归属信息可能不完整；T3 按 D8 证据关联，不能安全归属时 fail-closed/NO_DATA，不把单 GPL map 套到全部样本。
- **多对多 probe mapping**：ambiguous probe 保持 probe-level，除非存在版本化显式消解规则；可能使 gene-level requirement 失败。
- **relation evidence**：共享 PMID 不自动证明 GSE 彼此 related；只生成各自 GSE↔PMID。GSE↔GSE 需独立证据。
- **Phase 7 边界**：本阶段只产正确 manifest/audit/BuildResult，不做新前端/API；NO_DATA 与 mixed namespace 的完整 UI 留 Phase 7。
- **V1 双轨**：共享 parser/provider helper 可能引入回归；必须跑 discovery/acquisition/processing/artifact/NO_DATA fixture 回归；T6 之外 V1 用户可见行为保持。
- **Profile 版本化**：新增 scale/entity-level policy 改变 profile 契约；升级 profile/adapter version 或确保 digest 纳入版本，避免 checkpoint/cache 复用旧语义。

## 8. 实施顺序与完成定义

依赖 DAG：`T1 → T2`；`T1 → T3`；`T1 → T4`；`T2+T4 → T5`（T5 依赖行同：T1、T4；T2 经 T1 传递）；`T1+T5 → T6`；`T2+T3+T5 → T7`；T8 无依赖、可并行（最终与 T2 做 E2E）。**T1 是主实现链的唯一根任务，先于主链一切实现提交**；T8 为独立并行支线（自身根），不与主链共享前置。

每个任务先提交失败测试，再做最小实现，再跑目标测试。Phase 5 完成前必须通过全部新增测试、GEO V1/V2 相关回归、后端全量 pytest 与 ruff，并验证应用导入/启动；TODO 六项和 §16 三项只能在对应证据全部成立后勾选。
