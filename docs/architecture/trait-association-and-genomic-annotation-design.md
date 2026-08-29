# Trait Association and Genomic Annotation Family Design

> 状态：设计草案，尚未注册 production family。本文由 gold7 暴露的问题触发，
> 但定义的是来源无关、疾病无关的语义能力。它取代此前按数据库/用例命名的
> `gwas_association` 草案；不把 discovery 工具或 workspace 文件提升为正式输入。

## 1. 结论

不能建立 `gwas_association` family。GWAS 是一种研究方法/来源类别，不是稳定的
数据产品语义；同一个 GWAS 来源可以同时提供 variant-trait 统计关联、locus-trait
关联、variant-gene 注释和 study metadata，而这些行不能互相合并。反过来，同一种
variant-trait 关联也可以来自 GWAS Catalog、FinnGen、dbGaP、Open Targets Genetics
或论文补充表。

本设计只新增两个候选语义 family：

1. `trait_association_evidence`：实体与 trait/phenotype 之间的统计关联证据；
2. `genomic_annotation_evidence`：基因组实体的参考定位及实体间注释/映射证据。

每个 family 可声明多个 projection，但一次 DatasetBuild 只选择一个 projection，且
只有一种主行粒度。study、paper、source 和 provenance 是可复用 supporting tables，
不是 family。gold7 因而需要多个独立 Build/Publication，由同一产品需求关联起来，
而不是一个 family 发布三种 primary granularity。

## 2. Family 划分准则

family 的边界由“这行数据声称什么、如何比较、何时可合并”决定，不由数据库、
论文、疾病、文件格式或 benchmark case 决定：

- family 名称在替换或增加数据库后仍应成立；
- 一个数据库可以映射到多个 family，一个 family 可以接收多个数据库；
- projection 固定主实体、行粒度、key semantics 和 measurement semantics；
- 只有选中相同 projection 且兼容性维度一致的记录才可进入同一 merge；
- 来源报告值、确定性派生值和推断值必须保留不同 evidence/method；
- 公共 entity/paper/source/crosswalk schema 可以复用，但不单独构成 production family；
- 无法归入现有语义的产品才新增 family，不能为数据库或输出表名逐个建 family。

这与 ADR-002 的四元组约束一致：

```text
dataset_family + row_granularity + key_semantics + measurement_semantics
```

## 3. 候选 family 与 projection

### 3.1 `trait_association_evidence`

功能语义是“某个分析在明确人群/模型下报告一个实体与 trait 的统计关联”。它不
限定 GWAS，也不限定实体一定是 variant 或 gene。

| projection | 一行代表 | 必须保留的关键语义 | 可复用来源示例 |
| --- | --- | --- | --- |
| `variant_trait_association` | analysis × variant × trait × tested/effect allele | analysis/study identity、trait、variant/reference、allele orientation、P 值 relation、effect type/value/SE/CI、population/model | GWAS Catalog、FinnGen、dbGaP summary statistics、Open Targets Genetics、论文关联表 |
| `genomic_region_trait_association` | analysis × source-defined region/locus × trait | locus definition method、interval/assembly、lead variant、independence/credible-set method、统计量 | GWAS Catalog（有明确 locus 时）、Bellenguez supplementary、fine-mapping/credible-set resources |
| `gene_trait_association` | analysis × gene × trait | gene namespace、gene-level method、P 值/effect/score 的明确类型、population/model | MAGMA/SAIGE-GENE 等 gene-based results、Open Targets Genetics 中有直接 gene-level statistical semantics 的结果 |

三个 projection 必须分别构建。`gene_trait_association` 只接受真正的 gene-based
analysis；GWAS Catalog 的 `MAPPED_GENE`、最近基因或 variant-to-gene score 不是
gene-level association，不能转换成该 projection。

study metadata 可作为每个 projection 的 supporting `studies` 表。它不成为独立
family，除非未来用户产品的主对象就是 study registry，而且有独立的合并和验证语义。

### 3.2 `genomic_annotation_evidence`

功能语义是“一个来源或确定性 resolver 对基因组实体身份、参考位置或实体间关系
作出的注释”。它不限定 dbSNP、Ensembl 或 GWAS。

| projection | 一行代表 | 必须保留的关键语义 | 可复用来源示例 |
| --- | --- | --- | --- |
| `variant_reference_placement` | variant identity × reference assembly/sequence × placement | variant namespace、assembly/sequence version、position、alleles、placement status、resolver version | dbSNP/RefSNP、Ensembl Variation、gnomAD、Allele Registry |
| `variant_gene_annotation` | variant × gene × annotation assertion | mapping method、direction、distance/score（若有）、reported/derived status、source locator | GWAS Catalog mapped genes、Ensembl VEP、Open Targets Genetics V2G、eQTL/fine-mapping resources |
| `region_gene_annotation` | source-defined genomic region × gene × annotation assertion | region identity/assembly、membership or mapping method、reported/derived status | Bellenguez reported loci/genes、credible-set resources、functional mapping pipelines |

`reported_gene`、`nearest_gene`、`coding_consequence`、`eQTL`、`chromatin_contact` 和
`fine_mapping` 是不同 mapping methods。它们可以保存在同一 projection 中作为不同
evidence assertions，但默认不能静默折叠成一个“最终基因”。冲突应保留，选择优先级
属于显式 product policy，而不是 adapter 隐含行为。

### 3.3 现有 family 的复用边界

| 现有 family | GWAS 相关数据何时可以使用 | 不能承载什么 |
| --- | --- | --- |
| `target_evidence` | 来源直接给出 gene/protein target assertion，或上层产品在保留推导链后发布候选 target | 不能把 mapped gene 当 gene-level association；不能用通用 JSON 吞掉 P 值、效应、allele/model 语义 |
| `variant_evidence` | ClinVar 类“一个 condition 下的 variant assertion”，并保留 assertion/conflict 状态 | 不是统计 association；不能承载 GWAS study、effect、locus 或 gene mapping |
| `literature_evidence` | 论文中一个可定位的 experiment-level evidence assertion 是用户所需主产品时 | 论文附件作为 carrier 不会自动把关联矩阵变成 literature evidence |
| `gene_expression` | 请求本身包含可比较的 gene × sample expression measurements 时 | 不能承载 gene-trait association 或 variant-gene annotation |

因此，“挂到朴素的单基因 family”只在主语义确实是 target assertion 时成立。gold7
中的 gene 信息主要是 variant/region-to-gene annotation；它应进入
`genomic_annotation_evidence`，而不是因为行里出现 gene 就进入 `target_evidence`。

## 4. 数据库与 family 的多对多审查

下表描述来源能够直接提供的语义，而不是仅凭数据库名称推断。`conditional` 表示
必须检查具体记录/endpoint 的统计或 assertion 语义。

| 来源 | Trait association | Genomic annotation | Variant assertion | Target evidence | 说明 |
| --- | --- | --- | --- | --- | --- |
| GWAS Catalog | yes：variant；有定义时 region | yes：reported mapped genes | no | conditional/downstream | mapped gene 不是 gene-level association |
| Bellenguez supplementary | yes：variant/region | yes：reported region-gene/variant-gene | no | no | 表格/工作表与行定位必须保留 |
| dbSNP/RefSNP | no | yes：variant placement/identity | no | no | 不提供 trait effect |
| Ensembl VEP/Variation | no | yes | no | no | consequence/nearest-gene method 必须标记 |
| Open Targets Genetics | yes | yes：V2G | no | yes/conditional | 同一数据库可供多个独立 Build 使用 |
| FinnGen / dbGaP summary | yes | conditional | no | no | effect scale、allele 和 population 决定兼容性 |
| ClinVar | no statistical association | yes：placement support | yes | conditional | 临床 assertion 不等于关联统计 |
| DisGeNET | conditional：仅在 projection/profile 接受其 evidence model 时 | no | no | yes | 通常更适合 target evidence，不冒充 GWAS statistics |
| gnomAD | no trait association | yes | no | no | population frequency 需要其它 measurement family 时另行设计 |
| PGS Catalog | no（默认） | conditional | no | no | 模型权重/性能属于 predictive-model family，不应塞入 association |

这个矩阵同时证明两个方向：新增 family 可被非 GWAS 数据库复用；GWAS 数据源也
可以复用多个 family。provider registration 仍按数据库/API 实现，但 provider ID
不得泄漏为 family identity。

## 5. 合并资格

共享 family 名称不等于可以合并。进入同一 Build 前至少要匹配：

1. 相同 projection 和主行粒度；
2. 相同或可审计 crosswalk 后的 entity/trait namespace；
3. 对 genomic entity，相同 reference assembly/sequence 与 allele orientation；
4. 相容的 analysis unit、population/cohort、model 和 ancestry 语义；
5. 相容的 measurement type/scale，例如 beta、odds ratio、hazard ratio、P 值及其
   relation token（`<`、`>`、`=`、`±`）不能互换；
6. 相同 dedup identity。不同 study/analysis 的同一 rsID 是不同 association，默认
   union 并保留来源，不能按 rsID 静默去重；
7. 每行绑定 immutable SourceAsset、provider revision、source locator 和转换证据。

只有显式、版本化的转换（例如 log(OR) 与 beta 的科学上合法转换）才能改变 measurement
scale；无法证明兼容时分开发布，而不是填空或择一覆盖。

## 6. Gold7 的正确 Build 分解

gold7 至少拆为以下正式产品；具体输出列由 TOPIC 的需求 manifest 决定：

1. `trait_association_evidence/variant_trait_association`：GWAS Catalog 与 Bellenguez
   中逐 variant 的统计关联；
2. `trait_association_evidence/genomic_region_trait_association`：Bellenguez 报告的
   independent loci，及其它来源中确有同等 locus definition 的记录；
3. `genomic_annotation_evidence/variant_reference_placement`：dbSNP/其它 resolver 的
   GRCh38 identity/placement evidence；
4. `genomic_annotation_evidence/variant_gene_annotation` 或
   `region_gene_annotation`：按来源实际报告粒度发布 mapping assertions。

`studies`、`papers`、`sources`、`evidence` 和 crosswalk 是各 Build 的 supporting
tables。若用户还要候选靶点，应在上述 Publications 之后生成单独且可追溯的
`target_evidence` product；不能把候选 target 反写成源数据库报告的 gene association。

产品层需要记录这几份 Publication 共同满足一个 ProductRequirementManifest。任何
一个来源不可达时，应返回该 projection 的结构化 blocker/`no_data`，不能用另一
projection 的行补齐，也不能把 workspace CSV 计为交付。

## 7. 为什么 gold7 没有正式产物

真实 rerun：

```text
task_ts_ae9b71f9-02af-44ae-a3b4-f75ba8a98d02
run_ts_2b037d08-a5c2-45b9-a84a-a45066541064
```

事件流有 1,238 个事件、34 次工具调用，其中 `workspace_exec` 17 次、浏览/下载
10 次、`lookup_dbsnp` 4 次；以下正式工具调用均为 0：

```text
validate_dataset_build
execute_dataset_build
submit_dynamic_family_build
```

Agent 的首段计划直接是“获取数据后生成 three linked tables”，随后写入并运行 Python
workspace integration script。终态是：

```json
{"type":"run_completed","build_result":null}
```

本次事件中没有 `conversation_compacted`，所以不能把未发布归因于上下文耗尽。问题
分为四个独立层次：

### 7.1 路径选择失败

`submit_dynamic_family_build`（现名 `submit_dynamic_family_publication`）当时已由 runtime 注入；system prompt 也规定正式 artifact
只能经 Core，但只把“CSV 不使 Publication 可选”写成并列规则，没有定义不可绕过的
dataset completion contract。Agent 因而仍选择更熟悉、更短的 workspace/Python 流程，
并主动推断“用户只要 CSV，所以 formal Publication 可能没有必要”。Prompt 现已改为按
任务语义识别 dataset-producing request，并要求每个请求的语义产品都有当前 Run 的
BuildResult + immutable Publication 才能声明正式完成。缺 provider/carrier 时不得在首次
受阻后立即降级；应先尝试可用 static/dynamic 路径并寻找独立真实来源。合理路径耗尽后可
交付明确标注为 provisional 的 workspace CSV，但必须同步报告 blocked/NO_DATA、覆盖缺口并
请求具体帮助，且不得称其为 Dataset Core Publication 或正式成功。该改动只是路径选择的局部缓解：当前仍没有
capability preflight 强制调研前选择 formal projection，也没有终态门阻止从未提交 Build
的 dataset-producing request 报告 completed。

### 7.2 动态工具可用性不足

动态工具支持 task-scope FamilySpec，所以“不注册新的 production family”本身不是
拓扑阻塞；但 Agent 仍需准备完整 FamilySpec、Projection、TypeScript transform、
proposal 和 registered source/acquisition bindings，并严格执行 prepare/submit 两阶段协议。
2026-08-27 已完成 scaffold 的第一个小步：prepare schema 不再要求 Agent 手写 Family、
Projection、transform binding 和 Host descriptor digest；服务端派生这些值并返回可原样交给
submit 的 `prepared_submission`，同时兼容旧的严格 prepare 请求。它仍缺少 planning/scaffold
接口来返回：匹配的
semantic family/projection、行粒度、可用 providers、缺失 blockers 和服务端生成的
合法 skeleton。这增加了模型跳过正式路径的概率，但本次日志只能证明“未选择”，
不能把动机单因果归结为 schema 大小。

### 7.3 Core acquisition closure 缺失

这里的 **Core provider** 是注册在 Dataset Core acquisition runtime 中的确定性获取处理器；
它约束可访问的来源、请求参数、实现 revision、资源限制和 provenance，并把响应登记成
当前 task 拥有的 content-addressed SourceAsset。**Formal carrier** 是随后被 Dataset Core
接受为 build 输入的那组不可变字节及其闭包，至少绑定 asset ID/SHA-256、大小、角色、
registration receipt 和精确 acquisition provenance。浏览器响应或 workspace 文件是证据，
但在经过上述可信获取与登记前不是 formal carrier。

2026-08-25 的基础接线已消除 runtime 与 Dynamic schema 的双份 provider 清单：两者统一
派生自 `provider-catalog.ts`。除原有 GEO/GDC/ChEMBL/PDB/PubMed/UniProt/ClinVar/
ClinicalTrials/PubChem 外，现已补入 Xena、Reactome、RefSNP、MGnify、openFDA 和
GWAS Catalog association provider。所有 user-selectable builtin database 都有 formal Core
provider；Dynamic transform 还支持受 `temp_bytes` 限制的 gzip UTF-8 解码，因此 GEO/Xena
压缩文本不再因 raw fatal UTF-8 解码而失败。`registered_sources` 仍必须闭合到同一 task 中
带 exact Core acquisition provenance 的 asset，浏览器下载、discovery response 和 workspace
bytes 仍不能成为正式 carrier。

因此，“没接线的数据源也能通过 Dynamic Family publication”需要区分两种接线。若仅指
没有注册 production static family，结论成立：task-scope `FamilySpec` 可以补足语义拓扑。
若指数据源没有任何 Core acquisition/formal carrier 接线，结论不成立：当前 submission
对每个 binding 调用 `SourceAssetRegistry.resolveCoreAcquired`，只接受带 exact Core
acquisition provenance 的 task-owned asset。Dynamic Family 解决 family/topology 注册缺口，
不负责把任意 discovery、浏览器或 workspace bytes 提升为可信输入；后者仍需通用 Core
provider，或未来由 Core 提交并可验证 provenance 的 parser/extraction result。

Bellenguez supplementary 仍有第二层阻塞：dynamic transform host 不能直接消费 ZIP/XLSX。
Core acquisition 已能通过 `europepmc.supplementary.v1` 登记官方 archive carrier，也能登记
provider-declared `extractionAssets`，但
phase3 dynamic binding 当前固定选择 `acquired.sourceAsset`，没有选择可信解析后 extraction
asset 的协议。因此，仅新增一个下载 supplementary ZIP 的 provider 仍然不能接通 gold7；
必须让 Core 确定性提取/解析并把 provenance-bound UTF-8 CSV/JSON 选为 formal binding，
或扩展 dynamic input 以接受 Core committed parser OperationResult。后者范围更大。

### 7.4 错误成功终态

`turn_completed` 当前无条件映射为 `run_completed`，runtime 只是把
`workspace.consumeBuildResult()` 的空值写为 `build_result:null`；reducer 又把它显示为
completed。对于明确要求数据集产物的 agent-mode request，这不是可接受的成功结果。
它应在已选择的 projections 均有 BuildResult/结构化 blocker 后才能完成。

### 7.5 不注册 production family 的最小接线

若“不新增 family”指不把新定义注册进 production static Registry，gold7 可以先用
task-scope Dynamic FamilySpec 验证：分别为 variant-trait、region-trait、variant placement
和 variant/region-gene annotation 提交独立 projection/build。若它指连 task-scope
FamilySpec 都不允许，则不可行，因为每个 DatasetBuild 都必须声明 family + projection +
row granularity；`variant_evidence` 又不能承载统计关联语义。

最小接线不新增 static family，但仍需新增通用 Core 能力：

1. **已完成：** GWAS Catalog provider 返回官方 association/study HAL JSON，并冻结请求与
   provider revision；它可供多个 task-scope/未来 static family 使用。live smoke 以非 gold
   study `GCST90012877` 返回 HTTP 200。
2. **已完成：** RefSNP provider 按受控 rsID 请求返回官方 UTF-8 JSON，保留原始 placement
   和 allele provenance；live smoke 以非 gold `rs7412` 返回 HTTP 200。
3. **待完成：** Europe PMC supplementary provider 已下载并登记官方 archive；Core 仍需
   确定性选择附件、解析 XLSX
   sheet 为 UTF-8 CSV，并把 raw archive -> attachment -> parsed table 的 hash/locator 链
   绑定到所选 formal input。优先扩展 acquisition result 以显式选择 provider-owned
   extraction asset；不要让 Agent 指定路径，也不要把 workspace 解析结果提升为 carrier。
4. 用上述 Core-acquired 文本输入走现有 prepare/submit、generic multi-table B3、
   ProductAssessment 和 immutable Publication。先用非 Alzheimer trait 与至少两个来源
   证明 provider/family 多对多，再决定是否把已验证 FamilySpec 提升到 production Registry。

## 8. 修复顺序与验收

1. **Capability preflight**：研究前解析候选 semantic family/projection，返回可用 Core
   providers 与缺失 provider blockers；不按数据库创建 family。
2. **Server scaffold**：digest binding 子步骤已完成；继续由服务端根据选中 projection 生成
   FamilySpec/build skeleton，使 Agent 只补来源参数和 transform，避免手写整个协议。
3. **Provider/carrier closure**：实现通用的 GWAS Catalog association、Europe PMC
   supplementary table 和 RefSNP providers；为 binary supplementary 增加 Core-owned
   extraction asset 选择或 committed parser-result 输入。一个 provider 可绑定多个 family
   adapters；provider 失败产生明确 acquisition outcome。
4. **Dynamic bridge without static registration**：用 task-scope FamilySpec 和非 gold fixture
   分别证明 variant-trait、region-trait、variant placement 和 variant/region-gene annotation
   可走完整 Publication；不得把 task-scope success 写成 production family 已注册。
5. **Family/projection implementation**：在 dynamic bridge 证据后决定是否提升为 production
   family，并做跨数据库 merge compatibility/拒绝测试。
6. **Terminal enforcement**：dataset-producing request 未调用 formal build，或仍有未决
   projection 时，不得成功为 `run_completed(build_result=null)`；返回结构化
   `no_data`、`spec_rejected` 或 blocked outcome。
7. **Gold7 E2E**：只把 TOPIC.txt 交给 qwen3.7-plus；正式成功标准是每个所需
   projection 都有 Core-owned BuildResult、Publication、provenance closure 和 Artifact
   API hash。workspace 产物不计入通过。

在实现前必须用至少一个非 Alzheimer、至少两个不同来源的 fixture 审查 family 复用，
并用反例证明不相容的 projection/measurement 会 fail closed。
