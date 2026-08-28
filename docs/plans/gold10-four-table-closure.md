# Gold10 四表闭包开发指南（肠道微生物组疾病关联数据整合）

> 状态：**已闭包（2026-08-28 深夜，main@d084a7e4）**——fresh run 内 supervisor closure
> `succeeded_publication`（IBD 表型全四表；T2D/CRC 差异源结构化 blocked 并在终答显式标注）。
> 证据 `data/gold-runs/d084a7e4-gold10-r1`（前序 r1-r3 迭代证据同目录前缀），运行史与
> Core 落地片见 `data/gold/gold7_alzheimer_gwas/runs-log.md` 的
> `e2e-gold10-fourtable-20260828` 节。§四的三个缺口处置：§4.2 crosswalk 已落地
> （`gut_microbiome.taxon_name_crosswalk.v1`，替换 taxon_records 语义）；§4.3 已落地
> 双版面（双层 β/p/q 面板 + 单行 LEfSe），但 forslund 面板在 Springer static 主机、
> EPMC provider 不可达（做实 T2D 差异维度需新 provider）；§4.4 已 live 验证。
> 本文其余内容保留为历史交接记录。

## 一、这是什么问题

gold10 要求针对 **T2D / IBD / CRC** 三类肠道微生物组疾病表型，产出**四张正式（formal）数据表**并通过
Dataset Core 发布为 DatasetPublication：

| 表 | 参考行数×列 | 行粒度 | 数据来源 |
| --- | --- | --- | --- |
| `study_records` | 14×16 | 一个研究 | MGnify 研究元数据（含 disease 注记） |
| `taxon_records` | 476×14 | 一次名称解析 | NCBI Taxonomy esearch/efetch（旧名→现行名 crosswalk） |
| `differential_abundance_records` | 1887×24 | 一个研究×分类单元×比较 | 代表性病例对照文献的补充表（XLS/XLSX/DOCX） |
| `reference_prevalence_records` | 1345×12 | 一个表型×分类单元 | GMRepo per-taxon 表型丰度汇总 |

关联键：`phenotype` / `study_id` / `ncbi_taxon_id`。参考产物与完整配方见
`data/gold/gold10_gut_microbiome/output/`（含 `provenance.json`，列明每个上游端点、每篇论文的
`table_ref` 与记录数、全部中间产物 sha256）——**这是验收的黄金对照，不要改它**。

"四表闭包" = 在**单一 fresh run** 内：Agent 只读 `TOPIC.txt` 输入，经正式路由
（`inspect_dataset_execution_routes` → 静态 spec/动态 FamilySpec → validate/execute 或
prepare/submit）产出四表 publication，supervisor 闭包分类 `succeeded_publication`，
全部 artifact 经字节/SHA-256 验证。

## 二、参考配方摘要（来自参考 provenance.json）

- **MGnify**：EBI search REST v1（biome=human gut），8 个研究；每研究另取 per-sample
  representative OTU 分类（name+rank lineage，**源数据无 NCBI id**，必须自己解析）。
- **NCBI Taxonomy**：eutils esearch/efetch；370 个名称查询，309 解析成功 / 61 未解析。
- **GMRepo**：`https://gmrepo.humangut.info/api/` 的
  `getPhenotypesAndAbundanceSummaryOfAAssociatedTaxon/`（POST `{"ncbi_taxon_id": N}`，
  per-taxon 端点；**旧的 per-MeSH 端点已死，勿用**）。MeSH 目标：
  D003123/D003424/D003924/D006262/D015179/D015212，对照 = D006262 (Health)。
- **论文差异表**（6 篇，4 成 2 败）：
  - morgan2012_ibd：`gb-2012-13-9-r79-S1.XLS!Sheet1`，296 条（**legacy XLS**）
  - forslund2017_t2d：`MOESM4_ESM.xlsx!Sheet1`，1380 条（**XLSX**，与 gold7 Bellenguez 同一归档模式）
  - zeller2014_crc：`msb0010-0766-sd6.xlsx!Sheet2`，207 条（XLSX）
  - dong2026_t2d：`41387_2026_418_MOESM10_ESM.docx!TableS2`，4 条（**DOCX**）
  - wirbel2019_crc / franzosa2019_ibd：**PDF 补充材料，参考也未提取**（0 条）——不要求闭包，可留 blocker
- **关键链路**：论文里的 `reported_taxon_name`（旧文献名）→ NCBI 解析 → `ncbi_taxon_id` +
  `current_taxon_name` + `name_resolved`，这一步同时喂 `taxon_records` 与差异表的归一列。

## 三、已有资产（不要重做）

代码入口集中在 `server/src/dataset/families/gut-microbiome/`（`schemas.ts` / `provider.ts` /
`assembler.ts`）与 `server/src/dataset/families/provider-transforms.ts`、`registry.ts`。

1. **静态 family `gut_microbiome` 已注册**，四张表的 schema 一应俱全：
   `gut_microbiome.study.v1`、`gut_microbiome.taxon_records.v1`、
   `gut_microbiome.differential_abundance.v1`、`gut_microbiome.reference_prevalence.v1`，
   加上 assembler 与 relations。契约由
   `server/tests/gut-microbiome-association-family.test.ts` 锁定（表集合逐字相等）。
   **注意 schema 字段与参考 CSV 列不是一一对应**（例如差异表 schema 用
   `study_id/taxon_id/comparison_id` 主键与 `source_locator`，参考 CSV 是
   `record_id/source_study_id/reported_taxon_name/...` 24 列）——闭包按 **schema 为准**，
   与参考的列差异在终答里如实说明即可，不要为对齐参考改 schema。
2. **Provider 接线**（`provider.ts`）：`mgnify_study_json`、`mgnify_taxonomy_tsv`、
   `mgnify_taxonomy_json`、`ncbi_taxonomy_esearch_json`、`ncbi_taxonomy_efetch_xml`、
   `gmrepo_taxon_phenotypes_json`（已迁移到存活 per-taxon 端点，accession=数字 NCBI taxon id，
   POST body 由 provider 组装）。固定 provider 规则：**一个 binding 一个 accession，
   上下文进 `spec.entities`，绝不走 `binding.parameters`**（validate 会 422 早拒并给示例）。
3. **差异表 XLSX 载体半通**：`registered_gut_microbiome_differential_abundance_xlsx`
   adapter 只接受 `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`。
   Europe PMC 补充 ZIP 的成员提取已落地（stdlib ZIP reader：`acquisition/zip-members.ts`，
   CRC 校验/zip-slip fail-closed），**xlsx 成员在提取时即确定性转为逐 worksheet 的
   provenance-bound UTF-8 CSV 资产**，Agent 经 `acquire_core_carrier` 拿资产 id 作
   dynamic registered sources。这条路在 gold7 rerun3 已 live 走通（`ac2ffaba` 起）。
4. **fixture E2E**：`server/tests/gut-microbiome-provider-runtime.test.ts`（9 用例）证明
   registered-multitable runtime 能产四表 publication——**fixture ≠ live 源验证**，
   但说明 Core 侧管线本身不缺。
5. **Agent 侧辅助**：`inspect_dataset_execution_routes` 披露每个源的 `required_entities`
   （如 study 需要 `disease_id/disease_name/host_taxon_id`）；
   `scaffold_dataset_execution_spec`（`main@bd4c990d`，红测已清）能为**注册 family 生成
   digest-bound 静态 spec 骨架**——gold10 是注册 family，**优先走静态路线 + scaffold**，
   这正是它比 gold7/9（纯动态）容易的地方。
6. **历史最好成绩**：kimi-k3 的 `e2e-gold10-20260827-08b` 已产出首个动态路线 publication
   （`pub_gutmb_payload_probe_abe3ac60df70ee1a`）——但主表是结构探针，**不是 TOPIC 四表**；
   `-09` 轮在最终提交前被共享 checkout 的 watch 重启打断。deepseek-v4-flash 各轮卡在
   多绑定 spec 授权（详见第六节）。

## 四、缺口清单（按表拆）

### 4.1 `study_records` — 基本闭合，只差 live 验证
MGnify study JSON + `required_entities` 披露 + entities 补救报错都已落地（runs-log
rounds 1–3）。缺：独立 live 复测（`search_mgnify_studies` → study/taxon 双 acquire →
disease 注记按 entities 供给）。注意 MGnify **per-sample abundance TSV 仍在
`mgnify.files.v1` 之外**（08b 轮实测结论），taxon 矩阵要确认走哪个 provider 通道。

### 4.2 `taxon_records` — 缺 crosswalk schema（本表最大缺口）
现状 `gut_microbiome.taxon_records.v1` 的行粒度是"每样本一条丰度记录"，而参考的
`taxon_records` 是**名称解析记录**（`ncbi_taxon_id/current_name/taxon_rank/lineage/
n_synonyms/synonyms/n_equivalent_names/.../name_change_observed/query_names`）。
ISSUES 明确登记：**旧名→现行名 crosswalk schema 未注册**，不能由 Agent 直接拼表。
需要新 schema（如 `gut_microbiome.taxon_name_crosswalk.v1`）+ 基于
`ncbi_taxonomy_esearch_json`/`efetch_xml` 的 provider transform（efetch 的名称记录本就
带 synonym/equivalent/historical 分类与 lineage），并考虑与 `taxon_records.v1` 的
关系（替换或并存由实现者定，动 static registry 记得同步
`gut-microbiome-association-family.test.ts` 的表集合断言与 assembler）。

### 4.3 `differential_abundance_records` — 缺"版面灵活解析"（全案最难缺口）
三条子路径：
- **XLSX（forslund/zeller）**：ZIP→CSV 成员资产已通，缺的是**把任意论文补充表的列版面
  映射到 `gut_microbiome.differential_abundance.v1`**。参考做法是"整表提取+逐列语义映射"
  （24 列里 effect_measure/p/q/方向/丰度统计都来自论文原表头）。可选实现：
  (a) Core-owned layout-flexible transform（确定性表头映射规则，来源无关）；
  (b) 动态 FamilySpec 消费 CSV 成员（Agent 写 transform，Core 只管闭包）。
  gold7 的先例支持 (b) 更快，但注意第六节的回显问题。
- **legacy XLS（morgan2012）**：`application/vnd.ms-excel` **没有任何 Core parser，
  一切 recipe fail-closed**（D-035 决策，勿动摇）。要么新增显式 promoted XLS parser
  （stdlib 无 XLS 支持，需谨慎选型并过 architecture guard），要么该维度结构化 blocked。
- **DOCX（dong2026）**：同样无 parser。参考只取了 4 条，性价比低，建议先 blocked 留档。
- **PDF（wirbel/franzosa）**：参考自己也没提取——**不要求**，终答如实标注即可。

### 4.4 `reference_prevalence_records` — 链路已迁好，等 live
per-taxon 端点迁移（`gut_microbiome.gmrepo_taxon_phenotypes_json.v1`）+ prevalence 计算
（`prevalence = samples/all_samples`，`reference_group = gmrepo:<term> (<MeSH>)`）已实现并
重算 digest。缺：`gmrepo.humangut.info` 当前可达性复测（历史上一度 DNS 失败、后来确认
只有 per-MeSH 端点死了），以及 per-taxon 多 binding（每个 taxon 一个 accession binding，
6 个 MeSH 表型作为 entities/多 binding 组合——**这会放大第六节的多绑定问题**）。

## 五、开发路线（建议顺序）

每步都 TDD、独立分支、过质量门（server 改动跑 `pnpm --filter @biomed/server test`；
契约改动跑全量）。参考 [`docs/DEVELOPER_QUICKSTART.md`](../DEVELOPER_QUICKSTART.md)。

1. **P0 环境复测（半天）**：写一个只读探针脚本或直接 live smoke
   （`BIOMED_LIVE_SMOKE=1 npx vitest run tests/phase5/provider-live-smoke.test.ts`，
   server/ 下）确认 GMRepo per-taxon / MGnify / NCBI / Europe PMC 四上游当前可达性，
   结论写回本文第七节。**上游死了就先结构化 blocked，不要造数据**。
2. **P0 taxon crosswalk schema + transform（1–2 天）**：§4.2。验收：efetch fixture 的
   synonym/equivalent/historical 名称能确定性展开进 crosswalk 行；
   `name_change_observed` 由 historical 名称存在性推导；`query_names` 保留原名。
3. **P1 XLSX 差异表版面解析（2–3 天）**：§4.3 XLSX 子路径。先拿 forslund MOESM4 的
   CSV 成员资产做 fixture（gold7 任务缓存里就有 Bellenguez 的同名归档模式可对照）。
   验收：单篇论文 → 差异表行数与参考同数量级（forslund 1380 / zeller 207），
   effect/p/方向/丰度列各就各位，`source_locator` 指到 worksheet 行。
4. **P1 静态 spec 全链 live（1 天）**：`scaffold_dataset_execution_spec` 生成
   gut_microbiome 静态骨架 → Agent 补 accession/entities → validate/execute →
   四表（XLS 与 DOCX 维度允许 blocked）→ publication。**这是主验收 run**。
5. **P2 legacy XLS / DOCX parser（可选，按时间盒）**：仅当第 4 步证明其余三表稳了再投入。
6. **收尾**：fresh run 证据 + runs-log 条目 + TODO/ISSUES 勾销 + 本文状态更新。

## 六、模型侧已知坑（2026-08-27/28 实测，接手前必读）

1. **多绑定 spec 授权成功率低（deepseek-v4-flash）**：gold10 各轮需要多次纠正迭代。
   缓解优先级：静态路线 + scaffold（gold10 是注册 family，可全程静态）＞ prompt 定向
   （"一个 binding 一个 accession；entities 不走 binding.parameters；角色按源声明勿按记录"）
   ＞ 临时换强模型（kimi-k3 有 08b 全链先例；注意 kimi 需 strip temperature/top_p，
   adapter 已处理）。
2. **巨型回显丢字段**（ISSUES §代码质量 2026-08-28 条）：动态路线 submit 要求逐字回显
   ~97KB prepared_submission，flash 在 32,768 输出预算边缘丢 `registered_sources`。
   gold10 若走动态路线必踩；**receipt-referenced submit 已立项 TODO**，落地前动态路线
   只能用"压缩 spec + 逐字拷贝"的 prompt 纪律硬扛（gold9 r5 先例）。
3. **浏览器渲染大文件会挂死整个 run**：navigate_page 渲染 54MB XML 曾令渲染器爆到
   ~10.6GB（渲染闸门修复已并 `main@688409b1`，**Host 须重启才生效**）。
   prompt 里显式禁止浏览大文件，一律走 governed provider/acquire_core_carrier。
4. **会话挂起时 cancel 可能无响应**：强制取消修复已并 `main@05f43592`（RED→GREEN），
   但旧 dist 的 Host 没有——开跑前确认 Host 是新 dist。
5. **Host lease**：同一 data 目录同时只允许一个 Host；起 Host 前查 8000/5187 端口与
   `data/output/tasks/.host-lease.json`（死 pid 可接管）。**评测 run 期间任何人重启
   Host 都会 `run_interrupted`**（2026-08-27 两案被杀的教训）。

## 七、运行与验收流程

1. **独立 worktree + 安静窗口**（TODO 验收原文要求）：`git worktree add ../BioMed-QAgent-gold10 <branch>`，
   装依赖、build、以该 worktree 的 data root 起 Host（避免共享 data 目录互杀）。
   若需复用主 checkout 的缓存种子，见第八节手法。
2. fresh task：`POST /api/v1/tasks`（request_id + 一句 dummy 输入如 "Bootstrap task.
   Reply with READY and stop. Do not use any tools." + `mode: agent`），等 dummy run 完成
   （`active_run_id: null`）。
3. supervisor（在仓库根、**去掉全部代理变量**启动）：
   ```bash
   env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
     node scripts/gold-formal-supervisor.mjs \
     --base-url http://127.0.0.1:8000 --task-id <tid> \
     --request-id gold10-<commit>-r1 \
     --prompt-file data/gold/gold10_gut_microbiome/TOPIC.txt \
     --evidence-dir data/gold-runs/<commit>-gold10-r1 \
     --case-label gold10 --expected-commit <full-commit> --timeout 14400000
   ```
   协议细节（HIL 停审、`--resume`、closure 分类）见 [`docs/gold-formal-rerun.md`](../gold-formal-rerun.md)。
4. **验收（TODO 原文）**：单一 fresh run 内 `completed` 且 `artifact_count>0`、
   `current_publication_id` 非空、产物经 Artifact API 字节/SHA-256 校验、
   supervisor closure `succeeded_publication`。允许 XLS/DOCX/PDF 维度结构化 blocked
   （blocked 维度必须在终答与 provenance 里显式标注，不得零值/模拟行）。
5. 证据落 `data/gold-runs/<commit>-gold10-*`，条目写进
   `data/gold/gold7_alzheimer_gwas/runs-log.md`（gold8–10 共用该 log）。

## 八、环境备忘（2026-08-28 实测）

- **上游可达性**（当日晚间实测，接手时复测）：`www.ebi.ac.uk` ✓、`eutils.ncbi.nlm.nih.gov` ✓、
  `api.orphadata.com` ✓、`www.orphadata.com` ✗（直连死；代理 7897 可达——但 Host 的 Node
  fetch 不吃代理 env，需缓存种子）、`www.europepmc.org` 曾全局 530（直连+代理皆死）。
- **ContentCache 种子手法**（gold9 r5 验证有效）：新任务目录 `cache/` 尚未创建时，
  `cp -r <旧任务>/cache/blobs <新任务>/cache/` 会把 blobs 内容直接摊进 `cache/sha256/…`
  （少一层）；正确布局是 `cache/blobs/sha256/<aa>/<bb>/<sha>` + `cache/metadata/*.json`，
  拷错后用 `mkdir cache/blobs && mv cache/sha256 cache/blobs/sha256` 修正。
  种子命中后 acquisition 零网络，provenance 保留原 URL/digest。
- **supervisor 的 fetch 会被系统代理抖动杀死**：务必 `env -u` 全部代理变量（第八节命令已含）。
- settings 改动后**重启 Host** 才进 adapter；评估模型建议 deepseek-v4-flash +
  context_window 1000000 + max_tokens 32768 + temperature 0.2（789 复跑验证过的组合）。

## 九、关联文档

- 设计：[`docs/architecture/trait-association-and-genomic-annotation-design.md`](../architecture/trait-association-and-genomic-annotation-design.md)（gold7/10 共用的来源无关 family 设计）
- XLSX 载体决策：[`docs/architecture/FAMILY-HOST-06-xlsx-carrier-parser.md`](../architecture/FAMILY-HOST-06-xlsx-carrier-parser.md)、
  [`docs/plans/trusted-browser-acquisition/DECISION-LOG.md`](trusted-browser-acquisition/DECISION-LOG.md) D-035
- 执行约束：[`docs/architecture/FAMILY-HOST-03-execution-constraints.md`](../architecture/FAMILY-HOST-03-execution-constraints.md)
- 历史证据：`data/gold-runs/313c6239-gold10`、`…-08b/-09`（kimi 轮）、
  `5f2dc1eef4af334d0c1a5e34c94781638913ccb7-gold10`、`c442710f-gold10-*`
