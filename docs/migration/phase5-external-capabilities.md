# Phase 5 — External Capabilities: Baseline & Migration Matrix

> 文档状态：Implemented（M1 + M2，2026-08-14；详见实施计划与 CI）
> 实施计划：[phase5-external-capabilities-completion-plan.md](phase5-external-capabilities-completion-plan.md)
> 迁移主线：[../BioMed-QAgent_Pi_Migration_Plan.md](../BioMed-QAgent_Pi_Migration_Plan.md) §20 Phase 5

本文档是 Phase 5 的 baseline 与迁移矩阵：逐 Tool 记录 Python 参考实现、TS 目标、
parity 契约要点与状态。契约稳定字段（参数名、JSON key、error/reason_code、
progress 语义）以 Python 实现为参考；TS 实现必须先通过 fixture parity 才可标记完成。

## 1. 冻结决策

- **P5-D10 Reactome 语义**：权威语义为 **research-only**。`SOURCE_CAPABILITIES` 中
  `Database.REACTOME` 原为 `pipeline_supported`，与 `.pi/skills/reactome/SKILL.md`
  （"never declare reactome as a dataset build source"）及
  `docs/migration/phase2-skills-tools-migration.md`（"否（调研）"）矛盾，且
  Deterministic Core 没有 Reactome adapter。修复：
  `backend/app/domain/contracts/enums.py`（REACTOME → RESEARCH_ONLY）、
  `backend/tests/test_builtin_tools.py`（EXPECTED_PIPELINE_SUPPORTED =
  {pubmed, geo, gdc, xena}）、`skill-tool-map.ts` 描述同步。
- **P5-D5 Analysis 输出路径**：analysis Tool 只写 `staging/analysis/<run_id>/`，
  由 trusted application artifact promotion（非 Dataset Core Publisher，独立命名空间
  `task/analysis/`）提升后对前端暴露；禁止直接写 `artifacts/`。
- **P5-D6 PDF 后端**：spike 结论见 `docs/migration/phase5-pdf-spike.md`。
- **P5-D7 local cache**：TS DB Adapter → Python DB bridge 的 named operations；
  禁止 Tool 直连 Python 业务模块或任意 SQL。
- **P5-D9 HIL**：最小 durable approval primitive（tool approval → run waiting →
  durable event → approve/reject → same run resumes），不移植 SubagentSupervisor。
- **P5-D1 统一网络策略**：所有出网路径复用 `server/src/external/network/`，
  策略分层：PublicHttpPolicy / CredentialedPublicHttpsPolicy /
  CuratedSourcePolicy（HTTPS-only、exact host allowlist、443、禁 IP literal、
  默认禁跨 host redirect）/ BrowserEgressPolicy。
- **P5-D3 SourceAsset 唯一入口**：所有可进入 DatasetBuild 的下载必须经
  `server/src/external/acquisition/` 统一服务（policy、streaming、大小、hash、
  media type、cache、source_assets 发布、DownloadAttempt、progress、cancel、
  provenance）。Tool 不得自行 fetch + writeFile。

## 2. 迁移矩阵

状态图例：✅ 完成（fixture/CI 已验证；live smoke 单独记录）

### 2.1 底座

| 能力 | Python 参考 | TS 目标 | 状态 |
| --- | --- | --- | --- |
| Public URL / SSRF 防护 | `app/tools/network_safety.py` | `server/src/external/network/` | ✅ |
| HTTP acquisition 服务 | `app/integrations/acquisition.py` | `server/src/external/acquisition/` | ✅ |
| Content cache | `app/tools/content_cache.py` | `server/src/external/acquisition/content-cache.ts` | ✅ |
| Task workdir | `app/tools/workdir.py` | `server/src/external/acquisition/workdir.ts` | ✅ |
| Browser egress | `app/tools/egress_proxy.py` | `server/src/external/browser/egress-*` | ✅ |
| Browser pool (Node Playwright) | `app/tools/browser_pool.py` | `server/src/external/browser/pool.ts` | ✅ |
| Crawler | `app/tools/crawler.py` | `server/src/external/crawler/` | ✅ |
| NCBI E-utilities | `app/integrations/ncbi/*` | `server/src/external/ncbi/` | ✅ |
| Unpaywall / Europe PMC | `app/integrations/{unpaywall,europepmc}.py` | `server/src/external/publication/` | ✅ |
| PDF tables/meta | `app/processing/extract_tables.py` | `server/src/processing/pdf/` | ✅ |
| VLM chart | `app/processing/extract_chart_data_vlm.py` | `server/src/processing/vlm/` | ✅ |
| Analysis | `app/analysis/stats.py` | `server/src/analysis/` | ✅ |
| Local cache bridge | `app/tools/cache_store.py` | `server/src/persistence/db-client.ts` + `database/bridge.py` named ops | ✅ |
| 用户声明式数据库 HTTP | `app/databases/declarative.py` | `server/src/databases/` | ✅ |
| Dataset Core bridge | `app/pipeline/dataset_build_tool.py` | `server/src/dataset/`（Phase 4 已移植；M2 运行接线） | Phase 4 ✅ / M2 ✅ |

### 2.2 Agent Tools（SKILL_TOOL_MAP 全量）

| Tool | Python 实现 | 参数（required / default） | 稳定输出 key | TS 目标 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `analyze_papers` | `skills/builtin/discovery/understanding.py` | `titles: list[str]` (required) | `papers_analyzed, findings[], errors[], summary` | `server/src/agent/tools/literature-understanding.ts` | ✅ |
| `get_research_data_guidance` | `skills/builtin/analysis/research_data_guidance.py` | `topic: str` (required) | markdown text | `server/src/agent/tools/guidance.ts` | ✅ |
| `search_pubmed` | `skills/builtin/discovery/pubmed.py` | `query` (required), `max_results=20` | `summary, source, query, query_translation, total_count, records_count, records[], usage_hint` | `server/src/agent/tools/pubmed.ts` | ✅ |
| `download_supplementary` | 同上 | `pmid` (required), `max_size_mb=4096` | `source, accession, source_url, local_files[], source_assets[], download_attempts[], format_hint, warnings[]` / `error` | `server/src/agent/tools/pubmed.ts` | ✅ |
| `search_geo` | `skills/builtin/acquisition/geo.py` | `query=""`, `max_results=20`, `term=""` | `source, term, query_translation, total_count, accessions[], records[]` | `server/src/agent/tools/geo.ts` | ✅ |
| `describe_geo` | 同上 | `accession` (required) | `source` + GeoSeriesRecord 字段 + `supplementary_file_listing_url, note` | `server/src/agent/tools/geo.ts` | ✅ |
| `list_geo_supplementary_files` | 同上 | `accession` (required) | `source, accession, supplementary_file_count, supplementary_files[], listing_url` | `server/src/agent/tools/geo.ts` | ✅ |
| `download_geo` | 同上 | `accession` (required), `file_type="matrix"`, `filename=None`, `max_size_mb=4096` | `source, accession, source_url, attempt, asset, local_files[], format_hint` / `error`（`empty_series_matrix`） | `server/src/agent/tools/geo.ts` | ✅ |
| `download_geo_platform_annotation` | 同上 | `gpl` (`^GPL\d+$`), `max_size_mb=4096` | `source, platform, source_url, attempt, asset, local_files[], format_hint:"platform_annotation"` | `server/src/agent/tools/geo.ts` | ✅ |
| `search_gdc` | `skills/builtin/acquisition/gdc.py` | `query=""`, `max_results=20`, `term=""` | `source:"gdc", term, project_ids[], records[]` | `server/src/agent/tools/gdc.ts` | ✅ |
| `describe_gdc` | 同上 | `project_id` (required), `data_category=None` | `source, project_id, name, disease_type, primary_site, program, case_count, file_count, data_categories[], experimental_strategies, dbgap_accession, state` | `server/src/agent/tools/gdc.ts` | ✅ |
| `download_gdc` | 同上 | `project_id`, `data_type="RNA-Seq"`, `data_category=None`, `workflow_type=None` | `source, accession, data_type, source_url, local_files[], format_hint, file_count, downloaded, retrieved_at` / `error` | `server/src/agent/tools/gdc.ts` | ✅ |
| `search_xena` | `skills/builtin/acquisition/xena.py` | `query=""`, `max_results=20`, `term=""` | `source, term, count, records[]` | `server/src/agent/tools/xena.ts` | ✅ |
| `download_xena` | 同上 | `dataset_id`, `file_type="tsv"`, `cohort=None` | `source, dataset_id, cohort, source_url, local_files[], format_hint, retrieved_at` | `server/src/agent/tools/xena.ts` | ✅ |
| `search_chembl` | `skills/builtin/discovery/chembl.py` | `query`, `max_results=20` | `source, query, count, total_count, records[], method_used, attempts[]`（降级 `status:"page_fallback"`） | `server/src/agent/tools/chembl.ts` | ✅ |
| `search_uniprot` | `skills/builtin/discovery/uniprot.py` | `query`, `max_results=20` | 同上形状（source `"uniprot"`） | `server/src/agent/tools/uniprot.ts` | ✅ |
| `search_pdb` | `skills/builtin/acquisition/pdb.py` | `term`, `max_results=20` | `source, term, pdb_ids[], records[], enriched_count` | `server/src/agent/tools/pdb.ts` | ✅ |
| `describe_pdb` | 同上 | `pdb_id` | `source, pdb_id, title, deposit_date, resolution, method, molecular_weight, polymer_count, authors[], citation, polymer_entities, nonpolymer_entities, url` | `server/src/agent/tools/pdb.ts` | ✅ |
| `download_pdb` | 同上 | `pdb_id`, `file_type="pdb"` | `source, pdb_id, source_url, attempt, asset, local_files[], format_hint, retrieved_at` / `error` | `server/src/agent/tools/pdb.ts` | ✅ |
| `search_pubchem` | `skills/builtin/acquisition/pubchem.py` | `term`, `max_results=None`, `strict_mode=False` | `source, term, count, records[], method_used, attempts[]`（降级 `status:"page_fallback"` / `"error"`） | `server/src/agent/tools/pubchem.ts` | ✅ |
| `get_compound` | 同上 | `cid: int` | `source, cid, record, method_used, attempts` | `server/src/agent/tools/pubchem.ts` | ✅ |
| `download_pubchem` | 同上 | `cid: int`, `file_type="sdf"` | `source, cid, source_url, local_files[], format_hint, retrieved_at` | `server/src/agent/tools/pubchem.ts` | ✅ |
| `search_reactome` | `skills/builtin/acquisition/reactome.py` | `term`, `max_results=20` | `source, term, count, total_matches, records[], enriched_count, method_used, attempts[]` | `server/src/agent/tools/reactome.ts` | ✅ |
| `get_pathway` | 同上 | `pathway_id` | `source, pathway_id, record, method_used, attempts` | `server/src/agent/tools/reactome.ts` | ✅ |
| `download_reactome` | 同上 | `pathway_id`, `file_type="tsv"` | `source, pathway_id, source_url, local_files[], format_hint, retrieved_at` | `server/src/agent/tools/reactome.ts` | ✅ |
| `navigate_page` | `skills/builtin/acquisition/browser.py` | `url` | `url, status_code, method_used, title, body_text_preview(≤5000), content_type` / `{url, error}` | `server/src/agent/tools/browser.ts` | ✅ |
| `download_from_page` | 同上 | `url`, `filename` | `source:"browser_fallback", source_url, local_files[], mime_type, bytes_received, retrieved_at, source_asset, download_attempt` / error | `server/src/agent/tools/browser.ts` | ✅ |
| `capture_web_page` | `skills/builtin/acquisition/web_visual_capture.py` | `url`, kw-only `full_page=True, viewport_width=1920, viewport_height=1080, wait_until="networkidle", label=None` | `source, url, status_code, local_files[], meta_file, sha256, size_bytes, viewport, full_page, selector, label, captured_at, source_id` | `server/src/agent/tools/web-visual-capture.ts` | ✅ |
| `capture_page_section` | 同上 | `url, selector` + 同 kw-only | 同上 | `server/src/agent/tools/web-visual-capture.ts` | ✅ |
| `search_local_cache` | `skills/builtin/acquisition/local_cache.py` | `query`, `max_results=10` | `source:"local_cache", query, results[]` | `server/src/agent/tools/local-cache.ts` | ✅ |
| `describe_local_cache` | 同上 | `source_namespace, dataset_id` | manifest + `column_count, extra` / `{error:"dataset not found"}` | `server/src/agent/tools/local-cache.ts` | ✅ |
| `get_cache_dataset` | 同上 | `source_namespace, dataset_id, max_rows=1000` | `source, dataset_id, source_namespace, topic, row_count, returned_rows, truncated, columns[22], rows[]` | `server/src/agent/tools/local-cache.ts` | ✅ |
| `extract_pdf_tables` | `app/processing/extract_tables.py` | `file_path` | `status, source_file, outputs[], summary, warning?` / `{status:"error", error, source_file}` | `server/src/processing/pdf/tables.ts` + tool | ✅ |
| `extract_pdf_metadata` | 同上 | `file_path` | `status, source_file, outputs[], summary{...,num_pages}, warning?` | `server/src/processing/pdf/metadata.ts` + tool | ✅ |
| `extract_chart_data_vlm` | `app/processing/extract_chart_data_vlm.py` | `source_path`, `hint=""` | `status:"ok", source_file, source_path, outputs[], charts[], total_charts, total_data_points, metas[], degradation?` / error | `server/src/processing/vlm/` + tool | ✅ |
| `run_differential_expression` | `app/analysis/stats.py` | `csv_path, group_a_cols, group_b_cols`, `gene_col="", pval_threshold=0.05, log2fc_threshold=1.0, top_n=100` | `status, source_file, gene_column, row_count, group_a_count, group_b_count, significant_up, significant_down, pval_threshold, log2fc_threshold, degs[], volcano_plot, outputs` | `server/src/analysis/` + tool | ✅ |
| `generate_heatmap` | 同上 | `csv_path`, `columns=None, gene_col="", max_genes=50, zscore=True, cluster_rows=True, cluster_cols=True, cmap="RdBu_r"` | `status, source_file, gene_column, rows_displayed, total_rows_in_csv, columns_used, zscore, heatmap_png, outputs` | `server/src/analysis/` + tool | ✅ |
| `basic_statistics` | 同上 | `csv_path`, `columns=None` | `status, source_file, total_rows, columns_analyzed, stats_report, summary, outputs` | `server/src/analysis/` + tool | ✅ |
| `generate_correlation_matrix` | 同上 | `csv_path`, `columns=None, method="pearson", cmap="coolwarm"` | `status, source_file, method, columns_used, correlation_png, outputs` | `server/src/analysis/` + tool | ✅ |

### 2.3 GEO Dataset Core parser（Phase 4 遗留）

| 能力 | Python | TS 目标 | 状态 |
| --- | --- | --- | --- |
| Series matrix / SOFT / supplementary parse | `datasets/build/geo_adapter.py` | `server/src/dataset/adapters/geo/series-matrix.ts` | ✅ |
| GEO source relations | `datasets/build/geo_relations.py` | 同上 `relations.ts` | ✅ |
| Sample metadata | `datasets/build/geo_sample_metadata.py` | 同上 `sample-metadata.ts` | ✅ |
| Probe mapping | `datasets/build/probe_mapping.py` + `pipeline/processing/geo_annotation.py` | 同上 `probe-mapping.ts` | ✅ |

## 3. 网络策略基线

- 正式 acquisition 允许 host（Python `_ALLOWED_HOSTS`）：`ftp.ncbi.nlm.nih.gov`,
  `eutils.ncbi.nlm.nih.gov`, `www.ncbi.nlm.nih.gov`, `api.gdc.cancer.gov`,
  `files.rcsb.org`, `search.rcsb.org`, `data.rcsb.org`,
  `pubchem.ncbi.nlm.nih.gov`, `reactome.org`,
  `toil-xena-hub.s3.us-east-1.amazonaws.com`, `api.unpaywall.org`,
  `www.ebi.ac.uk`。TS 侧命名为 `CURATED_SOURCE_HOSTS`。
- redirect ≤ 5 跳、逐跳重新校验；正式 acquisition 禁跨 host。
- 大小限制：download ≤ 4096 MiB（Python `MAX_CRAWLER_DOWNLOAD_BYTES`）、
  crawler response ≤ 10 MiB、browser page/extract 10 MiB、screenshot 25 MiB /
  25,000,000 px、declarative DB response ≤ 10 MiB。
- QueryStatus: `success | not_found | failed | skipped | page_fallback`。

## 4. Test 布局

```text
server/tests/phase5/
├── network/        # SSRF、redirect、policy（P5-01）
├── acquisition/    # 下载服务、cache、hash、原子发布（P5-01）
├── fixtures/       # 各数据源 response fixtures（P5-03..P5-06）
├── tools/          # 各 Tool parity（P5-02..P5-09）
├── security/       # 跨能力安全回归（P5-13）
└── live/           # live smoke（live:* marker 风格，独立于 CI）
```

fixture parity 规则：同一输入 → Python reference（`backend/tests/fixtures/` +
golden JSON）与 TS 实现归一化后比较稳定字段；时间/UUID/临时路径归一化。

## 5. P5-04 GEO 实现笔记

P5-04 落地后（TS 实现 + fixture parity 通过，live 待验证）的非明显决策：

- **ADAPTER_REGISTRY 循环导入**：`geo/series-matrix.ts` 的 adapter 类必须
  `extends SourceAdapter`（`adapters.ts`），而 `adapters.ts` 又要静态注册
  geo adapter —— 直接静态互相 import 会在 ESM 模块求值期触发
  `SourceAdapter` TDZ。仿 Python `adapters.py` 文件尾 E402 延迟导入的做法，
  `adapters.ts` 在 `ADAPTER_REGISTRY` 定义前用
  `const { geoExpressionAdapter } = await import("./geo/index.js")`
  （top-level await）延迟求值；geo 模块反向 import `adapters.ts` 时
  `SourceAdapter` 等绑定已初始化。后续 adapter 若再遇到同样结构，沿用此
  模式。
- **supporting_assets 偏差**：TS `DataBatch` 契约无 `supporting_assets`
  字段（契约归他处所有），GEO sample-metadata 侧表路径记录在
  `statistics.supporting_assets`（字符串数组）；CSV 内容与 Python
  逐字节一致。
- **probe mapping 接线已完成**：`createTsCoreOperationRunner` 在 canonicalize
  阶段读取 GEO `mappingAssets`，调用 `buildProbeMapping()`，并把
  `probeMap`/`probeTargetNamespace` 与 probe mapping audit CSV 接入
  canonicalizer / manifest。
- **golden 生成**：`server/tests/phase5/fixtures/geo/generate_goldens.py`
  （从 `backend/` 用 `.venv` 运行）产出全部 golden JSON；Python csv 写盘
  是 `\r\n`，但 golden 字符串经 `read_text()` 通用换行归一化为 `\n`，
  TS 测试对比前需同样归一化。
- **eutils 限速**：`GeoEutilsClient` 复刻 Python 3/s（无 key）/10/s 限速与
  429/5xx + Retry-After 有界重试；`getGeoListing` 复刻 `_get_geo_listing`
  的 3 次有界重试（429/5xx/传输错误）。
- 测试：`server/tests/phase5/geo-{parsers,client,tools,adapter,sample-metadata,relations,probe-mapping}.test.ts`
  （99 用例，golden 覆盖 esearch/esummary/suppl listing/SOFT samples/三类
  matrix/probe mapping summary）。
