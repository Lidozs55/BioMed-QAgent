# ADR-044: Verified canonical acquisition — server-enumerated supplementary carriers

## Status

Accepted — 2026-10-13.

## Context

GEO RNA-seq 系列（GSE267442/GSE292487/GSE318780 等）的 series matrix 是元数据壳，
真实表达数据在 `suppl/` 目录的补充文件（TPM/count 矩阵）里。gold1 r5（2026-10-12，
dev@f495aba9）实测该类数据在正式链路上三道门全灭：

1. **获取层**：`geo.files.v1` 的 plan 把 URL 硬编码为 series matrix
   （`expression-providers.ts` `geoPlan`），参数白名单只有
   `source/accession/entities`，无法表达"取 suppl 目录下的某个文件"。
2. **绑定层**：carrier 必须由 `PROVIDER_CARRIER_BINDINGS` 表内 provider 生产，
   "Agent input cannot extend this set"。
3. **溯源层**：agent 注册资产的 carrier 角色要求精确匹配的 Core acquisition
   receipt（`source-assets/registry.ts`）；`extract_core_archive` 同样拒收。
   `source_files` 绑定与解包两条绕路均被实证拒绝。

同时格式层已泛化（ADR-039 编译 transform + AdapterParams.delimiter 已覆盖新格式
解析），缺口集中在"哪个文件的字节能被 Core 正式获取"。且
`FORBIDDEN_PARAMETER_KEY`（`acquisition/runtime.ts`）**显式禁止 `filename` 作为
acquisition 参数键**——agent 以自由文件名控制获取是被架构明令封死的。

## Decision

### 1. Server-enumerated file selection（服务端枚举选文件）

`geo.files.v1` 的 builtin 参数集扩展两个**服务端词汇表**内的键：

- `file_class: "series_matrix" | "supplementary"`（缺省 `series_matrix`，现有
  调用方行为不变）；
- `supplement_index: number`（正整数，缺省 1；仅在 `file_class=supplementary`
  时允许）。

语义：`supplement_index` 只对**服务端实时获取的 NCBI `suppl/` 目录列表**编址
（复用 `resolveGeoSupplementaryAssets` 的固定解析顺序），最终 URL 由服务端从
被选中条目自己的文件名构造。任何自由文件名/路径字符串都不穿越 agent→Core
边界——黑名单保留且其立法意图（agent 只能表达"要什么"，服务端决定"取哪个字节"）
被完整遵守。整数序号注入面为零。

### 2. 身份与缓存

- `source_id` 的 digest 输入从 `provider∅accession` 扩为
  `provider∅accession∅file_class∅resolved_filename`（同 GSE 多文件不撞身份）；
- `provider_snapshot_identity` 参数化：`geo:series-matrix:v1` /
  `geo:supplementary:v1`，`provider_revision_facts` 增加 `resolved_filename`；
- `requestIdentityDigest` 因参数集扩展自然覆盖新键。

### 3. 推导链（单点）

`fixedBiomedicalAcquisitionParameters`（biomedical-providers.ts）是 spec binding
→获取请求的唯一翻译点：由 `AdapterParams.format` 推导 `file_class`
（`supplementary_matrix`/`tximport_counts` → `supplementary`，其余 →
`series_matrix`），并透传新的可选 `AdapterParams.supplement_index`。适配器、
canonicalizer、validation profile 零改动。

### 4. 不变量重申（拒绝的备选）

- **agent 字节作 carrier / receipt adoption**：拒绝。carrier 字节只能来自 Core
  acquisition（`forbidden_shortcuts` 的 "workspace CSV as publication" 防线）。
- **缓存种子装载转换字节**：拒绝且永不接受——同 URL 异字节 = 溯源伪造。
- **quarantine 旁路**：保留为非正式交付通道（`trust: "untrusted"`），不满足正式
  成功语义；本 ADR 不改变其定位。

### 5. 泛化缝（本 ADR 是实例而非框架）

本决策是 "verified canonical acquisition" 机制的首个实例：host 白名单（已有
`allowedHosts`）+ 按 repository layout 的 URL 模板 + 服务端列表枚举。后续新仓库
接入按同一模式注册（枚举谓词 + URL 模板），不再需要新 ADR；**不为假想的来源
无限性提前抽象**——等第二个实例出现再把模板抽成配置。

## Consequences

- `GEO_IMPLEMENTATION_DIGEST` 更新（实现身份随代码变更）。
- `file_class=supplementary` 且未注入列表解析器时 fail-closed（测试环境与
  生产装配都必须显式提供）。
- NCBI 后续在同目录新增文件可能使 index 漂移；获取时实时重新解析列表，
  `resolved_filename` 进入身份 digest，漂移在 provenance 中可见。
- gold1 类 RNA-seq 系列由此获得正式 carrier 路径（format=
  `supplementary_matrix`/`tximport_counts` + `supplement_index`）。
