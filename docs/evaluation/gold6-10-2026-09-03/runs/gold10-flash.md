# Gold10 Flash Principal-Run Report

This file is a derived, redacted report. It contains no prompt text, assistant deltas, tool arguments, or tool outputs. All timing and counters are regenerated from the selected authoritative event stream.

## Identity and Scope

| Field | Value |
| --- | --- |
| Campaign | 2026-09-03-main-e5aadfe0-qwen38-six-run-corrected |
| Principal cohort | yes |
| Task | `task_ts_383afd85-ebc9-46f4-a2c7-7597de1bb103` |
| Run | `run_ts_c9807ed7-7369-4d5e-992e-b4c28676a484` |
| Request | `gold-e5aadfe0-corrected-gold10-flash-4929a684dcc8` |
| Product commit | `e5aadfe0c46dacddda9464656c551bea0e203ba3` |
| Model | `qwen3.8-flash` |
| Model profile | reasoning=xhigh; thinking=true; search=true |
| Prompt SHA-256 | `f2ca2ecc4571bd734c1989e96883d28b94e09ded553620ec523827c5d189c199` |
| Prompt provenance | reconstructed historical TOPIC prompt |
| Execution-context SHA-256 | - |
| Semantic route | static |
| Publication route | not_reached |

## Event-Derived Lifecycle

| Milestone | UTC / Value |
| --- | --- |
| Queued | 2026-09-03T12:38:59.141Z |
| Started | 2026-09-03T12:38:59.256Z |
| Finished | 2026-09-03T14:27:28.936Z |
| Terminal classification | `blocked_no_publication` |
| Event-derived wall time | 6509.68 s (1 h 48 min 29.680 s) |
| Queue to start | 115 ms |
| Event range | 30,496 events, sequences 1-30496, contiguous=true |

Valid blocked_no_publication terminal: the static four-table all-or-nothing path did not admit a non-empty differential-abundance table. Staging files are not formal artifacts.

## Model and Context Usage

| Metric | Value |
| --- | --- |
| Model calls | 108 |
| Context-usage events | 108 |
| Context windows | 1,000,000 |
| Peak context | 399,623 tokens (39.9623%) |
| Compaction events | 0 |
| Input tokens | 978,248 |
| Output tokens | 189,428 |
| Cache-read tokens | 22,000,512 |
| Cache-write tokens | 0 |
| Reasoning tokens | 153,125 |
| Total tokens | 23,168,188 |
| Event sum equals closure | true |

## Tools and Named Operations

Tool events: started=264, called=264, completed=264. Durations are sums of paired spans and can overlap when the runtime ran work concurrently.

| Tool | Calls | Error completions | Span sum | Max span |
| --- | --- | --- | --- | --- |
| `acquire_core_carrier` | 29 | 16 | 2805.329 s | 204.256 s |
| `activate_agent_tools` | 4 | 0 | 0.063 s | 0.028 s |
| `download_from_page` | 1 | 0 | 2.554 s | 2.554 s |
| `download_supplementary` | 1 | 0 | 28.509 s | 28.509 s |
| `execute_dataset_execution` | 2 | 2 | 10.541 s | 8.907 s |
| `extract_core_archive` | 2 | 1 | 0.094 s | 0.082 s |
| `extract_supplementary_archive` | 6 | 6 | 471.418 s | 203.413 s |
| `inspect_dataset_execution_routes` | 1 | 0 | 0.018 s | 0.018 s |
| `inspect_source_coverage` | 1 | 1 | 0.006 s | 0.006 s |
| `navigate_page` | 47 | 1 | 112.210 s | 6.615 s |
| `preview_core_asset` | 116 | 33 | 4.318 s | 0.100 s |
| `read` | 6 | 1 | 0.064 s | 0.017 s |
| `read_dataset_core_source` | 11 | 4 | 0.158 s | 0.020 s |
| `scaffold_dataset_execution_spec` | 2 | 0 | 0.024 s | 0.012 s |
| `search_local_cache` | 2 | 0 | 0.036 s | 0.028 s |
| `search_mgnify_studies` | 8 | 0 | 15.302 s | 3.522 s |
| `search_pubmed` | 12 | 0 | 25.210 s | 5.745 s |
| `validate_dataset_execution` | 6 | 4 | 0.062 s | 0.013 s |
| `workspace_list` | 3 | 2 | 1246.677 s | 1246.654 s |
| `workspace_write` | 4 | 0 | 0.106 s | 0.041 s |

| Operation family | Category | Started | Completed | Failed | Open | Observed span sum |
| --- | --- | --- | --- | --- | --- | --- |
| `tool:acquisition:downloaded_bytes` | acquisition | 1 | 0 | 0 | 1 | 0.000 s |
| `tool:browser:query` | discovery | 48 | 47 | 1 | 0 | 115.940 s |
| `tool:discovery:discovered_records` | discovery | 1 | 0 | 0 | 1 | 0.000 s |
| `tool:local_cache:query` | discovery | 2 | 2 | 0 | 0 | 0.143 s |
| `tool:pubmed:query` | discovery | 12 | 12 | 0 | 0 | 25.445 s |

## HIL and Permission Summary

| HIL category | Requested | Resolved | Wait |
| --- | --- | --- | --- |
| none | 0 | 0 | 0 s |

| Capability | Scope | Decision | Count | Observed wait |
| --- | --- | --- | --- | --- |
| fs.read | project | deny | 1 | 1246.651 s |

Permission resources and request text are intentionally omitted from this derived report.

## Publication and Formal Artifacts

No Publication was produced. There are no formal artifacts or formal artifact hashes for this terminal outcome.

## Evidence Integrity and Redaction Boundary

| Check | Value |
| --- | --- |
| Authoritative event source | `runs/gold10-flash/evidence/events.jsonl` |
| Authoritative event SHA-256 | `f34ba21d1806f2373dac26f8c6356bfc7d858a9c91f454fc00894f0b937e709f` |
| Evidence manifest | 16/16 verified, base=manifest_directory |
| Evidence manifest SHA-256 | `81d377bee0789c73768c7d1a839b29c7d4e20070d35b3a6734ee3a6f793f9167` |
| Runtime comparison | byte-identical=true |

The corresponding processed JSONL contains only lifecycle timestamps, counts, normalized tool/operation families, status codes, formal artifact hashes, and integrity checks. It excludes prompt bodies, assistant/reasoning deltas, tool arguments, tool outputs, HIL summaries, permission resources, and raw terminal/error messages.

Back to the [campaign report](../report.md).
