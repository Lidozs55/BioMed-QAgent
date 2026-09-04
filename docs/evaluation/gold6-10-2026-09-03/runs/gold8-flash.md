# Gold8 Flash Principal-Run Report

This file is a derived, redacted report. It contains no prompt text, assistant deltas, tool arguments, or tool outputs. All timing and counters are regenerated from the selected authoritative event stream.

## Identity and Scope

| Field | Value |
| --- | --- |
| Campaign | 2026-09-03-main-e5aadfe0-qwen38-six-run-corrected |
| Principal cohort | yes |
| Task | `task_ts_1133afea-eb44-4a84-9634-b2fdcf568ed9` |
| Run | `run_ts_5f8fad28-55e9-4a5e-975e-8e447061f9f8` |
| Request | `gold-e5aadfe0-corrected-gold8-flash-5291bf57d86b` |
| Product commit | `e5aadfe0c46dacddda9464656c551bea0e203ba3` |
| Model | `qwen3.8-flash` |
| Model profile | reasoning=xhigh; thinking=true; search=true |
| Prompt SHA-256 | `2ec9f28fc844804d39c9cce4f32f2be632625f1b2e37e69a0778c07df997fa10` |
| Prompt provenance | reconstructed historical TOPIC prompt |
| Execution-context SHA-256 | - |
| Semantic route | dynamic_family |
| Publication route | dynamic_family |

## Event-Derived Lifecycle

| Milestone | UTC / Value |
| --- | --- |
| Queued | 2026-09-03T11:57:55.631Z |
| Started | 2026-09-03T11:57:55.725Z |
| Finished | 2026-09-03T12:43:49.897Z |
| Terminal classification | `succeeded_publication` |
| Event-derived wall time | 2754.172 s (45 min 54.172 s) |
| Queue to start | 94 ms |
| Event range | 9,165 events, sequences 1-9165, contiguous=true |

Duration reconciliation: the recorder field `wall_times.run_wall_duration_s` reports 2174.166 s, but the authoritative event interval is 2754.172 s (delta 580.006 s). The event interval is used here and in the main report.

Completed with one byte-verified publication. Event-derived duration is authoritative because a monitor arithmetic field is inconsistent.

## Paper-Use Boundary

- The formal Publication covers the openFDA FAERS assertion and study tables (five artifacts including schema/provenance/assessment). Other requested integration dimensions remained workspace staging; the run report records this as one of three evidence dimensions formally published.
- Use 2754.172 seconds from run_started to run_completed. The 2174.166-second monitor arithmetic value is inconsistent and must not appear in primary tables.
- The prompt is reconstructed historical TOPIC text; do not describe this as an exact original-prompt replay or as complete DILI multi-source coverage.

## Model and Context Usage

| Metric | Value |
| --- | --- |
| Model calls | 50 |
| Context-usage events | 50 |
| Context windows | 1,000,000 |
| Peak context | 396,236 tokens (39.6236%) |
| Compaction events | 0 |
| Input tokens | 1,035,622 |
| Output tokens | 156,190 |
| Cache-read tokens | 9,454,208 |
| Cache-write tokens | 0 |
| Reasoning tokens | 50,045 |
| Total tokens | 10,646,020 |
| Event sum equals closure | true |

## Tools and Named Operations

Tool events: started=88, called=88, completed=88. Durations are sums of paired spans and can overlap when the runtime ran work concurrently.

| Tool | Calls | Error completions | Span sum | Max span |
| --- | --- | --- | --- | --- |
| `acquire_core_carrier` | 1 | 1 | 0.022 s | 0.022 s |
| `activate_agent_tools` | 5 | 1 | 0.166 s | 0.071 s |
| `get_research_data_guidance` | 1 | 0 | 0.044 s | 0.044 s |
| `inspect_dataset_execution_routes` | 1 | 0 | 0.017 s | 0.017 s |
| `inspect_source_coverage` | 1 | 1 | 0.036 s | 0.036 s |
| `lookup_openfda_dili_counts` | 4 | 0 | 135.520 s | 58.981 s |
| `navigate_page` | 23 | 10 | 628.130 s | 134.309 s |
| `prepare_dynamic_family_publication` | 5 | 1 | 0.611 s | 0.245 s |
| `preview_core_asset` | 1 | 0 | 0.011 s | 0.011 s |
| `read` | 3 | 0 | 0.114 s | 0.051 s |
| `read_dataset_core_source` | 17 | 12 | 0.435 s | 0.125 s |
| `scaffold_dataset_profile` | 4 | 2 | 0.033 s | 0.012 s |
| `search_local_cache` | 1 | 0 | 0.074 s | 0.074 s |
| `search_pubmed` | 1 | 0 | 1.161 s | 1.161 s |
| `submit_dynamic_family_publication` | 4 | 3 | 134.095 s | 67.424 s |
| `workspace_list` | 5 | 1 | 536.100 s | 423.325 s |
| `workspace_read` | 4 | 1 | 0.110 s | 0.064 s |
| `workspace_search` | 3 | 0 | 0.100 s | 0.058 s |
| `workspace_write` | 4 | 0 | 0.066 s | 0.023 s |

| Operation family | Category | Started | Completed | Failed | Open | Observed span sum |
| --- | --- | --- | --- | --- | --- | --- |
| `tool:browser:query` | discovery | 23 | 13 | 10 | 0 | 628.994 s |
| `tool:discovery:discovered_records` | discovery | 1 | 0 | 0 | 1 | 0.000 s |
| `tool:local_cache:query` | discovery | 1 | 1 | 0 | 0 | 0.050 s |
| `tool:pubmed:query` | discovery | 1 | 1 | 0 | 0 | 1.173 s |

## HIL and Permission Summary

| HIL category | Requested | Resolved | Wait |
| --- | --- | --- | --- |
| none | 0 | 0 | 0 s |

| Capability | Scope | Decision | Count | Observed wait |
| --- | --- | --- | --- | --- |
| fs.read | project | allow | 2 | 536.039 s |

Permission resources and request text are intentionally omitted from this derived report.

## Publication and Formal Artifacts

| Field | Value |
| --- | --- |
| Current publication | `pub_dili_faers_assertions_v4_395cef2afc06884c` |
| Requirement | `dili_faers_assertions_v4` |
| Published at | 2026-09-03T12:29:40.154000Z |
| Manifest SHA-256 | `bf378e3594baab401aad715b3d4f86c2e0fc3ef72f83b2a6926f2a5a6050a992` |
| Package digest | `395cef2afc06884cf4e9ef0d46dff83bbc27374f34f90b033ab20ec56d304078` |
| Artifact receipts verified | true |
| Product status | publishable |

| Role | Relative path | Bytes | SHA-256 | Receipt match |
| --- | --- | --- | --- | --- |
| primary_dataset | `tables/assertion_records.csv` | 110,068 | `c99ace7f482d364012f9a8711edb49116d6e897c48389aa8b7c8c891fe3f7de6` | true |
| supporting_dataset | `tables/study_records.csv` | 28,771 | `179a48dcb7f4dc3aa9fe1d10ce2b3ec1e676203acf00efebf2fce66f05b0d135` | true |
| schema | `schema.json` | 6,049 | `a33c1bf702cd5e848c63fdb2b7d20fee6763181aaa308ff907d8535766d5bdc2` | true |
| provenance | `provenance.json` | 97,537 | `7c6dbd97b5a6bf0909b6723f129b81697331edd2344f5553e2a9500df53c3543` | true |
| audit_report | `product_assessment.json` | 899 | `27e8db63c26439c4182c367130335fdab2b1732d3415ccb6a13f1792432815e7` | true |

| Publication event | Published at | Manifest SHA-256 | Supersedes |
| --- | --- | --- | --- |
| `pub_dili_faers_assertions_v4_395cef2afc06884c` | 2026-09-03T12:29:40.154000Z | `bf378e3594baab401aad715b3d4f86c2e0fc3ef72f83b2a6926f2a5a6050a992` | - |

## Evidence Integrity and Redaction Boundary

| Check | Value |
| --- | --- |
| Authoritative event source | `runs/gold8-flash/evidence/events.jsonl` |
| Authoritative event SHA-256 | `760d5bf436b83aaed0b05fb8ff48811f5e0396acf9c0bcc20dd4d0e23ef0dbe1` |
| Evidence manifest | 23/23 verified, base=run_directory |
| Evidence manifest SHA-256 | `c5ef531a2fe78a812ffc422012d27d5d86a1875997d4f66c75f88a73fc708db7` |
| Runtime comparison | byte-identical=true |

The corresponding processed JSONL contains only lifecycle timestamps, counts, normalized tool/operation families, status codes, formal artifact hashes, and integrity checks. It excludes prompt bodies, assistant/reasoning deltas, tool arguments, tool outputs, HIL summaries, permission resources, and raw terminal/error messages.

Back to the [campaign report](../report.md).
