# E2E run log

- Case: gold7 (Alzheimer GWAS)
- Request: `e2e-gold7-009`
- Task: `task_ts_c93256a6-f374-4bc8-9795-d0a5ff3bc109`
- Run: `run_ts_bbe31d50-2ff9-48e9-a3ca-b6fc4acb3c18`
- Model settings: `qwen3.7-plus`, context window `262144`, max tokens `8192`, thinking disabled.
- Result: Agent run completed. The agent produced workspace CSVs (`locus_records.csv`, `study_records.csv`, `variant_gene_mapping.csv`) and source/raw notes.
- Artifact check: no formal Dataset Core publication (`artifact_count=0`, `current_publication_id=null`). Therefore this is not a formal artifact/data-quality pass; workspace-only output was not promoted or copied into gold.
- Event check: one browser query operation failed (HTTP endpoint/source issue); no permission deadlock or runtime code failure in the successful run. Sources cited in the run included GWAS Catalog, PubMed/Bellenguez PMID 35379992, Springer supplementary data, and Ensembl/dbSNP lookups.
- Repair: fixed Pi adapter handling for DashScope `thinking_mode=false` and bounded length continuations before this run. No gold reference files were modified.
- Post-run remediation: strengthened the shared Agent prompt to require a formal Core build/publication for dataset requests and to forbid simulated fallback records. This run was not retroactively promoted.

## 2026-08-24 source-blocker remediation

- Added an explicit shared Prompt invariant: dataset rows must never be fabricated, simulated, approximated, inferred, or filled from model memory. When required data is unavailable, the Agent must stop and report NO_DATA/blocked, request concrete user help, or continue researching an independent real source.
- Bellenguez supplementary root cause: `download_supplementary` promised article attachments but only executed the publication PDF/Unpaywall/fullTextXML fallback. The run then guessed `MOESM1`; the article XML identifies the table archive under `MOESM4`.
- Bellenguez repair: the tool now attempts Europe PMC's official `PMC9005347/supplementaryFiles` archive before publication fallback. Live smoke downloaded a 27,656,649-byte `application/zip` asset with SHA-256 `a2902ab425cfb4609a2398c60d905d9e157830ae246241e451cfedcbc8e6ed26`.
- dbSNP root cause: the run used nonexistent `/variation/v0/rsids/...` and then `/variation/v0/refsnp/rs429358`; RefSNP requires a numeric suffix.
- dbSNP repair: added `lookup_dbsnp`, which validates rs-prefixed input and calls `/variation/v0/refsnp/429358`. Live smoke returned the official rs429358 SNV record and GRCh38 placement data.
- Remaining blocker: these are discovery/acquisition repairs only. No Alzheimer GWAS family or Core provider exists, so this does not change the original run's `artifact_count=0` result and does not make gold7 a formal publication pass.

## e2e-gold7-010 post-fix rerun

- Task: `task_ts_ae9b71f9-02af-44ae-a3b4-f75ba8a98d02`; run: `run_ts_2b037d08-a5c2-45b9-a84a-a45066541064`.
- Model settings remained `qwen3.7-plus` with context window `262144`; the task input was only the original `TOPIC.txt` content.
- Bellenguez blocker passed: `download_supplementary(35379992)` returned the official PMC9005347 supplementary ZIP, and the Agent extracted `41588_2022_1024_MOESM4_ESM.xlsx` instead of guessing MOESM1.
- dbSNP path blocker passed: the Agent called `lookup_dbsnp`; its first 20-record batch returned 20 successes. Three concurrent later batches returned only 12/20, 11/20, and 7/20 because tool calls did not share NCBI pacing. Serial replay of the same failed batch returned 20/20, confirming concurrency throttling; the tool now has process-shared 3 req/s pacing and bounded 429/5xx retries.
- Post-fix live load replay: the same three 20-record batches were invoked concurrently and all returned 20/20 successes with zero failures.
- Truthfulness finding: despite partial dbSNP failures, the Agent stated that coordinates were fully verified and built workspace tables from Bellenguez/GWAS Catalog coordinates without durable per-record dbSNP provenance. The Prompt now explicitly forbids expanding partial success into full-source verification.
- Result: run completed with workspace staging tables only (`studies.csv` 95 rows, `loci.csv` 891 rows, `variant_gene_map.csv` 702 rows). `build_result=null`, `artifact_count=0`; gold7 still fails formal publication because the GWAS family/Core provider is absent.
