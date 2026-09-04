# Gold6 Flash Principal-Run Report

This file is a derived, redacted report. It contains no prompt text, assistant deltas, tool arguments, or tool outputs. All timing and counters are regenerated from the selected authoritative event stream.

## Identity and Scope

| Field | Value |
| --- | --- |
| Campaign | 2026-09-03-main-e5aadfe0-qwen38-six-run-corrected |
| Principal cohort | yes |
| Task | `task_ts_3fc56c5d-7d7a-45a9-9b8e-914951514082` |
| Run | `run_ts_2606770d-9a14-41b8-b1f3-eb7bfc268b4f` |
| Request | `gold-e5aadfe0-corrected-gold6-flash-46cd194330a3` |
| Product commit | `e5aadfe0c46dacddda9464656c551bea0e203ba3` |
| Model | `qwen3.8-flash` |
| Model profile | reasoning=xhigh; thinking=true; search=true |
| Prompt SHA-256 | `f30ab31099da23c75a3e0037ee303b8814c7c124bc1e84be149d2c6f4c8fc298` |
| Prompt provenance | exact-data R3/R4/R7c3 lineage; frozen execution context, not the public gold-v1 fixture |
| Execution-context SHA-256 | `ee29d470e3a3789aba152424b1ffe6cf817e60617eda381ff3ba7c9f93430abb` |
| Semantic route | dynamic_family |
| Publication route | dynamic_family |

## Event-Derived Lifecycle

| Milestone | UTC / Value |
| --- | --- |
| Queued | 2026-09-03T11:57:55.288Z |
| Started | 2026-09-03T11:57:55.432Z |
| Finished | 2026-09-03T13:36:50.760Z |
| Terminal classification | `succeeded_publication` |
| Event-derived wall time | 5935.328 s (1 h 38 min 55.328 s) |
| Queue to start | 144 ms |
| Event range | 9,749 events, sequences 1-9749, contiguous=true |

Completed with a current publication after a superseded earlier publication.

## Paper-Use Boundary

- Describe the current formal product as six CSV tables plus schema, provenance, and ProductAssessment (nine artifacts total); the phrase 'four-table chart product' is not supported by the manifest.
- The five HIL requests were three exact-only credential grants and two publication-acceptance decisions. No low-confidence point-correction or generic data-review HIL occurred in this run.
- Artifact SHA-256 verification proves byte integrity and receipt binding, not scientific correctness or complete coverage of all potentially relevant EGFR literature.

## Model and Context Usage

| Metric | Value |
| --- | --- |
| Model calls | 41 |
| Context-usage events | 41 |
| Context windows | 1,000,000 |
| Peak context | 394,536 tokens (39.4536%) |
| Compaction events | 0 |
| Input tokens | 529,191 |
| Output tokens | 122,816 |
| Cache-read tokens | 6,262,528 |
| Cache-write tokens | 0 |
| Reasoning tokens | 52,425 |
| Total tokens | 6,914,535 |
| Event sum equals closure | true |

## Tools and Named Operations

Tool events: started=71, called=71, completed=71. Durations are sums of paired spans and can overlap when the runtime ran work concurrently.

| Tool | Calls | Error completions | Span sum | Max span |
| --- | --- | --- | --- | --- |
| `acquire_core_carrier` | 10 | 3 | 495.376 s | 201.094 s |
| `activate_agent_tools` | 1 | 0 | 0.011 s | 0.011 s |
| `download_supplementary` | 1 | 0 | 67.117 s | 67.117 s |
| `extract_core_archive` | 1 | 0 | 0.058 s | 0.058 s |
| `extract_registered_paper_chart_evidence` | 4 | 1 | 4091.493 s | 1739.309 s |
| `extract_supplementary_archive` | 3 | 3 | 601.289 s | 203.405 s |
| `inspect_dataset_execution_routes` | 1 | 0 | 0.020 s | 0.020 s |
| `prepare_dynamic_family_publication` | 6 | 4 | 0.408 s | 0.196 s |
| `preview_core_asset` | 12 | 0 | 0.144 s | 0.023 s |
| `read` | 4 | 1 | 0.051 s | 0.015 s |
| `read_dataset_core_source` | 6 | 2 | 0.064 s | 0.018 s |
| `scaffold_dataset_profile` | 3 | 1 | 0.028 s | 0.014 s |
| `search_pubmed` | 3 | 0 | 12.667 s | 5.092 s |
| `submit_dynamic_family_publication` | 2 | 0 | 337.326 s | 228.521 s |
| `workspace_list` | 2 | 0 | 0.057 s | 0.034 s |
| `workspace_read` | 12 | 1 | 0.187 s | 0.034 s |

| Operation family | Category | Started | Completed | Failed | Open | Observed span sum |
| --- | --- | --- | --- | --- | --- | --- |
| `tool:discovery:discovered_records` | discovery | 1 | 0 | 0 | 1 | 0.000 s |
| `tool:pubmed:query` | discovery | 3 | 3 | 0 | 0 | 12.734 s |

## HIL and Permission Summary

| HIL category | Requested | Resolved | Wait |
| --- | --- | --- | --- |
| credential | 3 | 3 | 451.420 s |
| publication_acceptance | 2 | 2 | 325.538 s |

| Capability | Scope | Decision | Count | Observed wait |
| --- | --- | --- | --- | --- |
| none | - | - | 0 | 0 s |

Permission resources and request text are intentionally omitted from this derived report.

## Publication and Formal Artifacts

| Field | Value |
| --- | --- |
| Current publication | `pub_egfr_mutant_inhibition_literature_chart_e3bc8e13b05e306c` |
| Requirement | `egfr_mutant_inhibition_literature_chart` |
| Published at | 2026-09-03T13:35:39.567000Z |
| Manifest SHA-256 | `583aac713e037abba22c837a1c5388fc20c2f8d2c5ea0e0b274d2671b58d12b2` |
| Package digest | `e3bc8e13b05e306c54bc125443e9550b0fbc701b5fb5567228ca8d200e07b1a1` |
| Artifact receipts verified | true |
| Product status | publishable |

| Role | Relative path | Bytes | SHA-256 | Receipt match |
| --- | --- | --- | --- | --- |
| primary_dataset | `tables/activity_value_records.csv` | 106,169 | `35221fe47761351b630137af5c7317dc690a87ed93231acfcb0ab90a3b339545` | true |
| supporting_dataset | `tables/paper_records.csv` | 1,038 | `44ef3bd1154d248e82c7db869441d08e27ff513f7a0138685854be426c1eca80` | true |
| supporting_dataset | `tables/experiment_records.csv` | 34,114 | `1c50f32a93a69aa3aa7526897d04dd73e098aae16fc80fe0d8fd9cd79b6d42da` | true |
| supporting_dataset | `tables/chart_series.csv` | 351 | `71b4fdb28c073ecff668323b70d86f9691850846da96bcc8be9c0cb44d9c01ed` | true |
| supporting_dataset | `tables/supplementary_asset_records.csv` | 231 | `76bf42632a75989ee78214649799778c57a6f18404c0b07d9a93efb5193da095` | true |
| supporting_dataset | `tables/chart_points.csv` | 265 | `1f24e78130f4deb8af1aeadf408628aacc9703711179af624acd68fd7511fb49` | true |
| schema | `schema.json` | 33,904 | `94e89dcd57bb0a365845a7675cb6c028e2fae11aa60b11f133ce7a1247cbcf9f` | true |
| provenance | `provenance.json` | 143,069 | `15adcffbf5e5d25702ecb473cd2949676dd2a0b7b625860f71511acbffeb627a` | true |
| audit_report | `product_assessment.json` | 1,741 | `6a7017b8b3199845c77a1cbbc82ee2c2459187b3b75521b7e9a59753be294915` | true |

| Publication event | Published at | Manifest SHA-256 | Supersedes |
| --- | --- | --- | --- |
| `pub_egfr_mutant_inhibition_literature_chart_608bbcd1f04fef01` | 2026-09-03T13:31:12.189000Z | `a5b5f3e88942219d8897816dfffbc60471baa6714dbf7335d33b0890d14b17aa` | - |
| `pub_egfr_mutant_inhibition_literature_chart_e3bc8e13b05e306c` | 2026-09-03T13:35:39.567000Z | `583aac713e037abba22c837a1c5388fc20c2f8d2c5ea0e0b274d2671b58d12b2` | `pub_egfr_mutant_inhibition_literature_chart_608bbcd1f04fef01` |

## Evidence Integrity and Redaction Boundary

| Check | Value |
| --- | --- |
| Authoritative event source | `runs/gold6-flash/evidence/archive/task-events.authoritative.jsonl` |
| Authoritative event SHA-256 | `b4280f02d92c83737dedad17eb418dc0f12d7940bd3bbe5325a8475896081a2a` |
| Evidence manifest | 31/31 verified, base=manifest_directory |
| Evidence manifest SHA-256 | `fb634c7f51de8d56a0d056ed6fcbbdad8344ceea555849b3aeee7ef90eca6108` |
| Runtime comparison | byte-identical=true |

Evidence mirror: `runs/gold6-flash/evidence/events.jsonl`, 9,749 events, byte-identical=true, missing authoritative sequences=none.

The corresponding processed JSONL contains only lifecycle timestamps, counts, normalized tool/operation families, status codes, formal artifact hashes, and integrity checks. It excludes prompt bodies, assistant/reasoning deltas, tool arguments, tool outputs, HIL summaries, permission resources, and raw terminal/error messages.

Back to the [campaign report](../report.md).
