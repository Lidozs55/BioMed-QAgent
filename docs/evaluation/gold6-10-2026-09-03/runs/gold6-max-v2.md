# Gold6 Max v2 Principal-Run Report

This file is a derived, redacted report. It contains no prompt text, assistant deltas, tool arguments, or tool outputs. All timing and counters are regenerated from the selected authoritative event stream.

## Identity and Scope

| Field | Value |
| --- | --- |
| Campaign | 2026-09-03-main-e5aadfe0-qwen38-six-run-corrected |
| Principal cohort | yes |
| Task | `task_ts_ec2a01da-80be-4486-886f-122b953fd816` |
| Run | `run_ts_383bdbb0-32aa-4134-8794-cb44ced39765` |
| Request | `gold-e5aadfe0-maxv2-f01dfdc657f1` |
| Product commit | `e5aadfe0c46dacddda9464656c551bea0e203ba3` |
| Model | `qwen3.8-max-0902` |
| Model profile | reasoning=xhigh; thinking=true; search=true |
| Prompt SHA-256 | `f30ab31099da23c75a3e0037ee303b8814c7c124bc1e84be149d2c6f4c8fc298` |
| Prompt provenance | same exact Gold6 prompt and frozen execution-context lineage as Gold6 Flash; v2 corrects the model metadata to 1,000,000 context / 32,768 maximum output |
| Execution-context SHA-256 | `ee29d470e3a3789aba152424b1ffe6cf817e60617eda381ff3ba7c9f93430abb` |
| Semantic route | dynamic_family |
| Publication route | dynamic_family |

Context metadata correction before start: 1,000,000 context tokens and 32,768 maximum output tokens.

## Event-Derived Lifecycle

| Milestone | UTC / Value |
| --- | --- |
| Queued | 2026-09-03T18:00:06.013Z |
| Started | 2026-09-03T18:00:06.138Z |
| Finished | 2026-09-03T19:18:06.515Z |
| Terminal classification | `succeeded_publication` |
| Event-derived wall time | 4680.377 s (1 h 18 min 0.377 s) |
| Queue to start | 125 ms |
| Event range | 19,333 events, sequences 1-19333, contiguous=true |

Completed after the context-metadata correction; all sampled contexts use 1,000,000 tokens and no compaction occurred.

## Paper-Use Boundary

- Use v2 as the corrected Max result; v1 had incorrect 100,000-token context metadata and belongs only in the diagnostic appendix.
- The formal product is six CSV tables plus schema, provenance, and ProductAssessment (nine artifacts); B3 checked 94 items with zero failures.
- This is not a pure model-only comparison with Gold6 Flash: v2 used the isolated proxy host as well as corrected context/output metadata.

## Model and Context Usage

| Metric | Value |
| --- | --- |
| Model calls | 29 |
| Context-usage events | 29 |
| Context windows | 1,000,000 |
| Peak context | 387,229 tokens (38.7229%) |
| Compaction events | 0 |
| Input tokens | 413,624 |
| Output tokens | 115,510 |
| Cache-read tokens | 6,981,760 |
| Cache-write tokens | 0 |
| Reasoning tokens | 82,923 |
| Total tokens | 7,510,894 |
| Event sum equals closure | true |

## Tools and Named Operations

Tool events: started=54, called=54, completed=54. Durations are sums of paired spans and can overlap when the runtime ran work concurrently.

| Tool | Calls | Error completions | Span sum | Max span |
| --- | --- | --- | --- | --- |
| `acquire_core_carrier` | 6 | 0 | 19.881 s | 7.686 s |
| `activate_agent_tools` | 1 | 0 | 0.018 s | 0.018 s |
| `extract_registered_paper_chart_evidence` | 5 | 4 | 3726.522 s | 1015.496 s |
| `extract_supplementary_archive` | 3 | 0 | 31.705 s | 23.628 s |
| `inspect_dataset_execution_routes` | 1 | 0 | 0.012 s | 0.012 s |
| `prepare_dynamic_family_publication` | 1 | 0 | 0.288 s | 0.288 s |
| `preview_core_asset` | 20 | 0 | 0.381 s | 0.047 s |
| `read` | 3 | 0 | 0.029 s | 0.012 s |
| `read_dataset_core_source` | 5 | 2 | 0.058 s | 0.017 s |
| `scaffold_dataset_profile` | 3 | 1 | 0.054 s | 0.030 s |
| `submit_dynamic_family_publication` | 1 | 0 | 75.693 s | 75.693 s |
| `workspace_list` | 2 | 0 | 0.019 s | 0.011 s |
| `workspace_read` | 3 | 1 | 0.030 s | 0.014 s |

| Operation family | Category | Started | Completed | Failed | Open | Observed span sum |
| --- | --- | --- | --- | --- | --- | --- |

## HIL and Permission Summary

| HIL category | Requested | Resolved | Wait |
| --- | --- | --- | --- |
| credential | 3 | 3 | 139.398 s |
| publication_acceptance | 1 | 1 | 70.834 s |

| Capability | Scope | Decision | Count | Observed wait |
| --- | --- | --- | --- | --- |
| none | - | - | 0 | 0 s |

Permission resources and request text are intentionally omitted from this derived report.

## Publication and Formal Artifacts

| Field | Value |
| --- | --- |
| Current publication | `pub_egfr_mutant_inhibition_paper_tables_0de9a13fd6284cac` |
| Requirement | `egfr_mutant_inhibition_paper_tables` |
| Published at | 2026-09-03T19:15:52.169000Z |
| Manifest SHA-256 | `36b2de0c11b0b4bca6a11d2b9dd1af3770e8268fc6aead4e9973d0dacf788f40` |
| Package digest | `0de9a13fd6284caca82aa8268314246a3778569fa403469f4de236646be22a45` |
| Artifact receipts verified | true |
| Product status | publishable |

| Role | Relative path | Bytes | SHA-256 | Receipt match |
| --- | --- | --- | --- | --- |
| primary_dataset | `tables/activity_value_records.csv` | 95,413 | `101322d3fca080427513656e12cee32b48ce83341dc400947061d7cfdb7dca0f` | true |
| supporting_dataset | `tables/paper_records.csv` | 1,226 | `7b9a22b0d3af5850ffda16cb5ce36b8c40825d76e5f82bae227e2116c58d64f5` | true |
| supporting_dataset | `tables/experiment_records.csv` | 4,007 | `13ef2fe01a32d337210e9bf279a6ed390a0883028a8261a42f870c0d3dc8708f` | true |
| supporting_dataset | `tables/chart_series.csv` | 351 | `71b4fdb28c073ecff668323b70d86f9691850846da96bcc8be9c0cb44d9c01ed` | true |
| supporting_dataset | `tables/supplementary_asset_records.csv` | 1,148 | `dfb72724af422574a835cc5d225c6a79ffe382f03957bdf79bc493bc613ab71e` | true |
| supporting_dataset | `tables/chart_points.csv` | 265 | `1f24e78130f4deb8af1aeadf408628aacc9703711179af624acd68fd7511fb49` | true |
| schema | `schema.json` | 33,904 | `94e89dcd57bb0a365845a7675cb6c028e2fae11aa60b11f133ce7a1247cbcf9f` | true |
| provenance | `provenance.json` | 19,195 | `07a000d4161f785663c1c27260c8d28c86de3c9bd1213d1332f748a8cd5a5c41` | true |
| audit_report | `product_assessment.json` | 1,907 | `32becd5ef6af7fe0bfc959ba5fbd6867b47b940d4ba578d3546c50fa049f707d` | true |

| Publication event | Published at | Manifest SHA-256 | Supersedes |
| --- | --- | --- | --- |
| `pub_egfr_mutant_inhibition_paper_tables_0de9a13fd6284cac` | 2026-09-03T19:15:52.169000Z | `36b2de0c11b0b4bca6a11d2b9dd1af3770e8268fc6aead4e9973d0dacf788f40` | - |

B3 evidence: 94 checks, 0 failed, profile `literature_experiment_chart.validation.v1`.

## Evidence Integrity and Redaction Boundary

| Check | Value |
| --- | --- |
| Authoritative event source | `proxy-rerun/runs/gold6-max-v2/evidence/events-api-refetch.jsonl` |
| Authoritative event SHA-256 | `0cfa2c7632541857d8059548a6abdbff889f0c9d4c20a59a7a75412d01c84912` |
| Evidence manifest | 43/43 verified, base=manifest_directory |
| Evidence manifest SHA-256 | `56213a921c9ee8d6bdd32192f211253c22831afd09ca8d876744b717e4c3632d` |
| Runtime comparison | object-identical=true |

Evidence mirror: `proxy-rerun/runs/gold6-max-v2/evidence/events.jsonl`, 19,331 events, byte-identical=false, missing authoritative sequences=19332, 19333.

The corresponding processed JSONL contains only lifecycle timestamps, counts, normalized tool/operation families, status codes, formal artifact hashes, and integrity checks. It excludes prompt bodies, assistant/reasoning deltas, tool arguments, tool outputs, HIL summaries, permission resources, and raw terminal/error messages.

Back to the [campaign report](../report.md).
