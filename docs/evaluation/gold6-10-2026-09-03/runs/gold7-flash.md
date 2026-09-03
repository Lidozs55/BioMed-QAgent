# Gold7 Flash Principal-Run Report

This file is a derived, redacted report. It contains no prompt text, assistant deltas, tool arguments, or tool outputs. All timing and counters are regenerated from the selected authoritative event stream.

## Identity and Scope

| Field | Value |
| --- | --- |
| Campaign | 2026-09-03-main-e5aadfe0-qwen38-six-run-corrected |
| Principal cohort | yes |
| Task | `task_ts_d35ff3ab-bc9c-4324-a180-e12e134df974` |
| Run | `run_ts_367d3372-f246-4738-8d46-5e53a1f36221` |
| Request | `gold-e5aadfe0-corrected-gold7-flash-4306e64df11e` |
| Product commit | `e5aadfe0c46dacddda9464656c551bea0e203ba3` |
| Model | `qwen3.8-flash` |
| Model profile | reasoning=xhigh; thinking=true; search=true |
| Prompt SHA-256 | `a2c6dd2ea41d844c8ee4757a5756a3d55162de16221c59e575f0afd760496bf8` |
| Prompt provenance | reconstructed historical TOPIC prompt |
| Execution-context SHA-256 | - |
| Semantic route | dynamic_family |
| Publication route | dynamic_family |

## Event-Derived Lifecycle

| Milestone | UTC / Value |
| --- | --- |
| Queued | 2026-09-03T11:57:55.491Z |
| Started | 2026-09-03T11:57:55.581Z |
| Finished | 2026-09-03T12:34:06.834Z |
| Terminal classification | `succeeded_publication` |
| Event-derived wall time | 2171.253 s (36 min 11.253 s) |
| Queue to start | 90 ms |
| Event range | 17,550 events, sequences 1-17550, contiguous=true |

Completed with two independent run-bound publications; the risk-loci publication is current.

## Model and Context Usage

| Metric | Value |
| --- | --- |
| Model calls | 40 |
| Context-usage events | 40 |
| Context windows | 1,000,000 |
| Peak context | 337,147 tokens (33.7147%) |
| Compaction events | 0 |
| Input tokens | 847,180 |
| Output tokens | 133,291 |
| Cache-read tokens | 5,369,088 |
| Cache-write tokens | 0 |
| Reasoning tokens | 91,644 |
| Total tokens | 6,349,559 |
| Event sum equals closure | true |

## Tools and Named Operations

Tool events: started=75, called=75, completed=75. Durations are sums of paired spans and can overlap when the runtime ran work concurrently.

| Tool | Calls | Error completions | Span sum | Max span |
| --- | --- | --- | --- | --- |
| `acquire_core_carrier` | 2 | 1 | 389.082 s | 198.283 s |
| `activate_agent_tools` | 3 | 0 | 0.039 s | 0.014 s |
| `inspect_dataset_execution_routes` | 1 | 0 | 0.012 s | 0.012 s |
| `inspect_source_coverage` | 1 | 1 | 0.006 s | 0.006 s |
| `lookup_dbsnp` | 1 | 0 | 1.971 s | 1.971 s |
| `lookup_gwas_catalog` | 2 | 0 | 7.193 s | 6.384 s |
| `prepare_dynamic_family_publication` | 2 | 0 | 0.357 s | 0.184 s |
| `preview_core_asset` | 24 | 0 | 0.531 s | 0.037 s |
| `read` | 5 | 2 | 0.058 s | 0.016 s |
| `read_dataset_core_source` | 19 | 10 | 0.310 s | 0.035 s |
| `scaffold_dataset_profile` | 2 | 1 | 0.017 s | 0.010 s |
| `search_pubmed` | 1 | 0 | 4.314 s | 4.314 s |
| `submit_dynamic_family_publication` | 2 | 0 | 72.003 s | 58.053 s |
| `workspace_list` | 5 | 1 | 43.203 s | 33.676 s |
| `workspace_read` | 3 | 1 | 0.076 s | 0.047 s |
| `workspace_search` | 2 | 0 | 0.075 s | 0.048 s |

| Operation family | Category | Started | Completed | Failed | Open | Observed span sum |
| --- | --- | --- | --- | --- | --- | --- |
| `tool:discovery:discovered_records` | discovery | 1 | 0 | 0 | 1 | 0.000 s |
| `tool:pubmed:query` | discovery | 1 | 1 | 0 | 0 | 4.364 s |

## HIL and Permission Summary

| HIL category | Requested | Resolved | Wait |
| --- | --- | --- | --- |
| none | 0 | 0 | 0 s |

| Capability | Scope | Decision | Count | Observed wait |
| --- | --- | --- | --- | --- |
| fs.read | project | allow | 2 | 42.981 s |

Permission resources and request text are intentionally omitted from this derived report.

## Publication and Formal Artifacts

| Field | Value |
| --- | --- |
| Current publication | `pub_ad_gwas_risk_loci_part1_f83586d784807664` |
| Requirement | `ad_gwas_risk_loci_part1` |
| Published at | 2026-09-03T12:31:44.098000Z |
| Manifest SHA-256 | `995d53b993a5dabdfa00b9c12707a0dfde5fad05b139fbec4c9885ba187b39a3` |
| Package digest | `f83586d7848076648ad338ee6ad8dca1e6d0df0cc9bf67cf1f5fe44c8bb2275d` |
| Artifact receipts verified | true |
| Product status | publishable |

| Role | Relative path | Bytes | SHA-256 | Receipt match |
| --- | --- | --- | --- | --- |
| primary_dataset | `tables/assertion_records.csv` | 193,931 | `881221b02aa860d196dec6c80066a952d9d5ffc4456e0d3eec09e91e9da28945` | true |
| supporting_dataset | `tables/study_records.csv` | 352 | `5d1c56595ee107d5c6e5ff141c5019a53e093923972b1b3296c86fda9e13b8a5` | true |
| schema | `schema.json` | 6,049 | `a33c1bf702cd5e848c63fdb2b7d20fee6763181aaa308ff907d8535766d5bdc2` | true |
| provenance | `provenance.json` | 96,553 | `5f8472bd4fd1ec931555e57622812637e61a37815876ed8ffb45ac33e9c8d522` | true |
| audit_report | `product_assessment.json` | 899 | `27e8db63c26439c4182c367130335fdab2b1732d3415ccb6a13f1792432815e7` | true |

| Publication event | Published at | Manifest SHA-256 | Supersedes |
| --- | --- | --- | --- |
| `pub_ad_gwas_variant_gene_map_ecec00532f86fc21` | 2026-09-03T12:22:17.151000Z | `9a86e982289d239f43eedc586ad6dc9e7833dfbbc95c629104094edc848ea8a0` | - |
| `pub_ad_gwas_risk_loci_part1_f83586d784807664` | 2026-09-03T12:31:44.098000Z | `995d53b993a5dabdfa00b9c12707a0dfde5fad05b139fbec4c9885ba187b39a3` | - |

## Evidence Integrity and Redaction Boundary

| Check | Value |
| --- | --- |
| Authoritative event source | `runs/gold7-flash/evidence/events.jsonl` |
| Authoritative event SHA-256 | `f550e9ab9c620446cae6641005e43f91d1d1746403bafb9b6495864b580b34f4` |
| Evidence manifest | 32/32 verified, base=manifest_directory |
| Evidence manifest SHA-256 | `3c56aa023a3e9f7f23215731d1674650b4f974cc207d95317d09f2edc6299fdb` |
| Runtime comparison | byte-identical=true |

The corresponding processed JSONL contains only lifecycle timestamps, counts, normalized tool/operation families, status codes, formal artifact hashes, and integrity checks. It excludes prompt bodies, assistant/reasoning deltas, tool arguments, tool outputs, HIL summaries, permission resources, and raw terminal/error messages.

Back to the [campaign report](../report.md).
