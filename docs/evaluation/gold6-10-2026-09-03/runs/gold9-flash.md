# Gold9 Flash Principal-Run Report

This file is a derived, redacted report. It contains no prompt text, assistant deltas, tool arguments, or tool outputs. All timing and counters are regenerated from the selected authoritative event stream.

## Identity and Scope

| Field | Value |
| --- | --- |
| Campaign | 2026-09-03-main-e5aadfe0-qwen38-six-run-corrected |
| Principal cohort | yes |
| Task | `task_ts_9b89b400-5493-4f1f-83d6-0f55d7d88ef9` |
| Run | `run_ts_711cbdd0-0a9a-4aa0-8649-4cca963ce196` |
| Request | `gold-e5aadfe0-corrected-gold9-flash-550cd4f47824` |
| Product commit | `e5aadfe0c46dacddda9464656c551bea0e203ba3` |
| Model | `qwen3.8-flash` |
| Model profile | reasoning=xhigh; thinking=true; search=true |
| Prompt SHA-256 | `26be317daadbf91b5d2d7bf464c0cb21beb2e13f2f14b69252c0db08571143ef` |
| Prompt provenance | exact original run_queued.input recovered from historical durable events |
| Execution-context SHA-256 | - |
| Semantic route | static -> dynamic_family |
| Publication route | dynamic_family |

## Event-Derived Lifecycle

| Milestone | UTC / Value |
| --- | --- |
| Queued | 2026-09-03T12:12:48.020Z |
| Started | 2026-09-03T12:12:48.145Z |
| Finished | 2026-09-03T18:04:00.816Z |
| Terminal classification | `succeeded_publication` |
| Event-derived wall time | 21072.671 s (5 h 51 min 12.671 s) |
| Queue to start | 125 ms |
| Event range | 17,037 events, sequences 1-17037, contiguous=true |

Completed after a static-route attempt was reclassified to a dynamic-family publication path; publication v2 is current.

## Model and Context Usage

| Metric | Value |
| --- | --- |
| Model calls | 66 |
| Context-usage events | 66 |
| Context windows | 1,000,000 |
| Peak context | 333,139 tokens (33.3139%) |
| Compaction events | 0 |
| Input tokens | 704,163 |
| Output tokens | 153,805 |
| Cache-read tokens | 7,671,040 |
| Cache-write tokens | 0 |
| Reasoning tokens | 95,985 |
| Total tokens | 8,529,008 |
| Event sum equals closure | true |

## Tools and Named Operations

Tool events: started=65, called=65, completed=65. Durations are sums of paired spans and can overlap when the runtime ran work concurrently.

| Tool | Calls | Error completions | Span sum | Max span |
| --- | --- | --- | --- | --- |
| `activate_agent_tools` | 3 | 0 | 0.019 s | 0.007 s |
| `execute_dataset_execution` | 2 | 2 | 10751.619 s | 8136.996 s |
| `inspect_dataset_execution_routes` | 1 | 0 | 0.006 s | 0.006 s |
| `inspect_source_coverage` | 2 | 2 | 0.014 s | 0.008 s |
| `navigate_page` | 5 | 1 | 51.191 s | 14.510 s |
| `prepare_dynamic_family_publication` | 4 | 2 | 0.336 s | 0.186 s |
| `preview_core_asset` | 4 | 1 | 0.047 s | 0.018 s |
| `read` | 1 | 0 | 0.005 s | 0.005 s |
| `read_dataset_core_source` | 22 | 8 | 0.202 s | 0.028 s |
| `scaffold_dataset_execution_spec` | 1 | 0 | 0.012 s | 0.012 s |
| `scaffold_dataset_profile` | 2 | 1 | 0.013 s | 0.007 s |
| `submit_dynamic_family_publication` | 2 | 0 | 24.888 s | 21.679 s |
| `validate_dataset_execution` | 2 | 1 | 0.025 s | 0.013 s |
| `workspace_list` | 6 | 3 | 8342.504 s | 8342.129 s |
| `workspace_search` | 8 | 0 | 146.669 s | 73.172 s |

| Operation family | Category | Started | Completed | Failed | Open | Observed span sum |
| --- | --- | --- | --- | --- | --- | --- |
| `tool:browser:query` | discovery | 5 | 4 | 1 | 0 | 51.273 s |

## HIL and Permission Summary

| HIL category | Requested | Resolved | Wait |
| --- | --- | --- | --- |
| none | 0 | 0 | 0 s |

| Capability | Scope | Decision | Count | Observed wait |
| --- | --- | --- | --- | --- |
| fs.read | project | allow | 9 | 142.389 s |
| fs.read | project | pending | 1 | 0.000 s |

Permission resources and request text are intentionally omitted from this derived report.

## Publication and Formal Artifacts

| Field | Value |
| --- | --- |
| Current publication | `pub_pid_gene_disease_assertions_v2_347816938b773b67` |
| Requirement | `pid_gene_disease_assertions_v2` |
| Published at | 2026-09-03T18:02:41.456000Z |
| Manifest SHA-256 | `28aec17d3b0ea41431fffe6cd109bedbaa5b1f4e74416c19e511531dfd06ad56` |
| Package digest | `347816938b773b67222864d84e1d932117e37ca1caa776d7eb3cdaaaa5a1c428` |
| Artifact receipts verified | true |
| Product status | publishable |

| Role | Relative path | Bytes | SHA-256 | Receipt match |
| --- | --- | --- | --- | --- |
| primary_dataset | `tables/assertion_records.csv` | 44,689 | `fb67b2693452c0a1a205b8a894e3329accc580f8e5f80708022471d6411018d7` | true |
| supporting_dataset | `tables/study_records.csv` | 7,992 | `8994f7ce7be26cb2363a0b930edfcecc103b04158e95d1dab1b1e835563c6f8e` | true |
| schema | `schema.json` | 6,049 | `a33c1bf702cd5e848c63fdb2b7d20fee6763181aaa308ff907d8535766d5bdc2` | true |
| provenance | `provenance.json` | 56,479 | `6b341e2458a77a3e2061869b9ead0d9e14e93e0a368f567abec77f1582075d8b` | true |
| audit_report | `product_assessment.json` | 899 | `ca51efd14660fbb7c67ef44b9b26caabafd969c919a42e50a70e17ee686d33be` | true |

| Publication event | Published at | Manifest SHA-256 | Supersedes |
| --- | --- | --- | --- |
| `pub_pid_gene_disease_assertions_v1_fa45a56e7394cdde` | 2026-09-03T17:57:00.463000Z | `689cc445a1c72475607a1a05678db9d42cbdef1a785cb7ea1d06a791d34c13a5` | - |
| `pub_pid_gene_disease_assertions_v2_347816938b773b67` | 2026-09-03T18:02:41.456000Z | `28aec17d3b0ea41431fffe6cd109bedbaa5b1f4e74416c19e511531dfd06ad56` | - |

## Evidence Integrity and Redaction Boundary

| Check | Value |
| --- | --- |
| Authoritative event source | `runs/gold9-flash/evidence/archive/authoritative/task-events.jsonl` |
| Authoritative event SHA-256 | `c50f739bdd0b9a1977d5205171f80119306cf2a558dd8e3c6a80c7d977afbdcb` |
| Evidence manifest | 36/36 verified, base=manifest_directory |
| Evidence manifest SHA-256 | `0b40a3991b3e9c68f6b2e1e5d84832b0d59e62d61f082b405030d169b9d06a7c` |
| Runtime comparison | object-identical=false |

Evidence mirror: `runs/gold9-flash/evidence/events.jsonl`, 17,037 events, byte-identical=true, missing authoritative sequences=none.

The corresponding processed JSONL contains only lifecycle timestamps, counts, normalized tool/operation families, status codes, formal artifact hashes, and integrity checks. It excludes prompt bodies, assistant/reasoning deltas, tool arguments, tool outputs, HIL summaries, permission resources, and raw terminal/error messages.

Back to the [campaign report](../report.md).
