# Gold6-10 Corrected Campaign Session Report

## Scope

This report fixes the primary cohort before comparison: Gold6 Flash, Gold7 Flash, Gold8 Flash, Gold9 Flash, Gold10 Flash, and corrected Gold6 Max v2. All six ran against product commit `e5aadfe0c46dacddda9464656c551bea0e203ba3`. The cohort contains five `succeeded_publication` terminals and one valid `blocked_no_publication` terminal. The invalid-profile batch, Gold6 Max v1, Gold9 proxy, and Gold9 dynamic-first runs are diagnostic appendices only and are excluded from the primary rates and totals.

Campaign ID: `2026-09-03-main-e5aadfe0-qwen38-six-run-corrected`. Model profile: reasoning=xhigh, thinking=true, search=true.

## Main Results

| Run | Prompt provenance | Model | Terminal | Event-derived wall time | Calls | Total tokens | Tools | Business HILs | Formal artifacts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [Gold6 Flash](runs/gold6-flash.md) | exact-data R3/R4/R7c3 lineage; frozen execution context, not the public gold-v1 fixture | `qwen3.8-flash` | `succeeded_publication` | 5935.328 s | 41 | 6,914,535 | 71 | 5 | 9 |
| [Gold7 Flash](runs/gold7-flash.md) | reconstructed historical TOPIC prompt | `qwen3.8-flash` | `succeeded_publication` | 2171.253 s | 40 | 6,349,559 | 75 | 0 | 5 |
| [Gold8 Flash](runs/gold8-flash.md) | reconstructed historical TOPIC prompt | `qwen3.8-flash` | `succeeded_publication` | 2754.172 s | 50 | 10,646,020 | 88 | 0 | 5 |
| [Gold9 Flash](runs/gold9-flash.md) | exact original run_queued.input recovered from historical durable events | `qwen3.8-flash` | `succeeded_publication` | 21072.671 s | 66 | 8,529,008 | 65 | 0 | 5 |
| [Gold10 Flash](runs/gold10-flash.md) | reconstructed historical TOPIC prompt | `qwen3.8-flash` | `blocked_no_publication` | 6509.680 s | 108 | 23,168,188 | 264 | 0 | 0 |
| [Gold6 Max v2](runs/gold6-max-v2.md) | same exact Gold6 prompt and frozen execution-context lineage as Gold6 Flash; v2 corrects the model metadata to 1,000,000 context / 32,768 maximum output | `qwen3.8-max-0902` | `succeeded_publication` | 4680.377 s | 29 | 7,510,894 | 54 | 4 | 9 |

Formal publication success rate: 5/6 (83.3%). This is an outcome rate over heterogeneous Gold requirements, not a controlled benchmark of model quality.

## Measurement Method

Each principal run is rebuilt from the evidence-pack manifest, selected authoritative JSONL stream, closure, run metadata, and formal artifact receipts. The generator validates manifest entries, sequence contiguity, lifecycle timestamps, context-usage sums against closure token totals, tool pairing, and formal artifact receipt hashes. Raw assistant/reasoning deltas, prompt content, tool arguments, tool outputs, permission resources, and raw error text are deliberately excluded from this report and from `processed-log.jsonl`.

Wall time is always the `run_started` to terminal-event interval from the selected authoritative stream. Gold8 is the material reconciliation: monitor metadata states 2174.166 s, while event timestamps yield 2754.172 s. The latter is used throughout.

## Publication and Artifact Evidence

| Run | Current Publication | Manifest SHA-256 | Package digest | Artifacts | Receipt verification |
| --- | --- | --- | --- | --- | --- |
| Gold6 Flash | `pub_egfr_mutant_inhibition_literature_chart_e3bc8e13b05e306c` | `583aac713e037abba22c837a1c5388fc20c2f8d2c5ea0e0b274d2671b58d12b2` | `e3bc8e13b05e306c54bc125443e9550b0fbc701b5fb5567228ca8d200e07b1a1` | 9 | true |
| Gold7 Flash | `pub_ad_gwas_risk_loci_part1_f83586d784807664` | `995d53b993a5dabdfa00b9c12707a0dfde5fad05b139fbec4c9885ba187b39a3` | `f83586d7848076648ad338ee6ad8dca1e6d0df0cc9bf67cf1f5fe44c8bb2275d` | 5 | true |
| Gold8 Flash | `pub_dili_faers_assertions_v4_395cef2afc06884c` | `bf378e3594baab401aad715b3d4f86c2e0fc3ef72f83b2a6926f2a5a6050a992` | `395cef2afc06884cf4e9ef0d46dff83bbc27374f34f90b033ab20ec56d304078` | 5 | true |
| Gold9 Flash | `pub_pid_gene_disease_assertions_v2_347816938b773b67` | `28aec17d3b0ea41431fffe6cd109bedbaa5b1f4e74416c19e511531dfd06ad56` | `347816938b773b67222864d84e1d932117e37ca1caa776d7eb3cdaaaa5a1c428` | 5 | true |
| Gold10 Flash | - | - | - | 0 | not applicable |
| Gold6 Max v2 | `pub_egfr_mutant_inhibition_paper_tables_0de9a13fd6284cac` | `36b2de0c11b0b4bca6a11d2b9dd1af3770e8268fc6aead4e9973d0dacf788f40` | `0de9a13fd6284caca82aa8268314246a3778569fa403469f4de236646be22a45` | 9 | true |

The individual run reports list the final formal artifact paths, bytes, SHA-256 values, and receipt checks. Gold7 has two independent run-bound publications (ten artifacts across history); its current risk-loci publication is the primary formal projection. Gold6 Flash and Gold9 each emitted an earlier publication that was superseded by the listed current publication.

## Prompt Provenance and Comparability

Gold6 Flash and Gold6 Max v2 share the exact-data Gold6 prompt and frozen execution-context lineage. Gold6 Max v2 is nevertheless not a pure model-only comparison: it ran through the isolated proxy host and corrects the Max registry metadata to a 1,000,000-token context and 32,768-token maximum output. Gold7, Gold8, and Gold10 use reconstructed historical TOPIC prompts. Gold9 uses an exact original `run_queued.input` recovered from the durable event stream. Therefore, aggregate campaign results establish observed terminal behavior and evidence integrity, not interchangeable task difficulty or causal model ranking.

## Gold9 Three-Route Analysis

| Route | Prompt | Final semantic route | Acquisition | Deterministic terminal barrier | Outcome |
| --- | --- | --- | --- | --- | --- |
| Original frozen/direct | exact frozen | static -> dynamic_family | initial direct download failures; later carriers acquired | static rejection observed before dynamic pivot | published v2 |
| Frozen/proxy | same frozen SHA | static | all 24 attempts succeeded | INVALID_INPUT / conflicting ClinGen classifications | blocked_no_publication |
| Dynamic-first variant | variant, not frozen | static | 12 Core attempts succeeded | INVALID_INPUT / conflicting OMIM identifiers; requested profile rejected | blocked_no_publication |

Proven facts: the direct run changed its durable route immediately after successful dynamic-family preparation and then emitted publication events; the frozen proxy run never selected that route and failed 15 static execution attempts; the dynamic-first directive did not create an unavailable four-table profile and the run remained static. Strongly supported inference: successful network acquisition alone was insufficient, because both proxy diagnostics acquired inputs and still failed deterministic static validation. Unproven: a model-level causal explanation for the direct agent's route choice. The successful direct dynamic publication uses a different scientific-assertion publication profile from the requested static four-table product, so it is not a controlled like-for-like quality comparison.

Structured route evidence is recorded in `results.json`, field `gold9_cross_route`.

## Gold6 Qoder Offline 2x2 Analysis

The Qoder Flash/Max zip comparison is an offline, read-only artifact analysis. It is not part of the principal run cohort and neither zip is a formal BioMed-QAgent Publication. Source zips: Flash SHA-256 `74317e075e2f702a9a5d24cb85d59e881356fedfe9d721af26f33d07e12c3990`; Max SHA-256 `10faf91f8994b473f1b47eee91981886a616076ff694b301d3ede007941073bb`.

| Side | Structural coverage/reuse (X) | Evidence auditability (Y) | Placement |
| --- | --- | --- | --- |
| Flash | 0.95 | 0.808 | Q1_high_coverage_high_auditability |
| Max | 0.5 | 0.758 | borderline |

Key measured differences: Flash has finer provenance granularity (10,215 distinct locations across 10,682 facts versus 11 across 6,439); Flash's manifest has a self-referential SHA-1 mismatch and truncated SHA-1 prefixes while Max validates 5/5 full MD5 entries; and neither offline export contains the raw payloads or scripts referenced by its methods log. The offline analysis verification has `6` checked hashes and pass=`true`. Its source root is `qoder-gold6-2x2-analysis`.

## Diagnostic Appendices Excluded from Main Statistics

| Diagnostic | Observed condition | Why excluded |
| --- | --- | --- |
| Initial Flash batch | 3 failed runs; 21 rejected provider calls; 0 tokens/tools/HIL/artifacts | The provider rejected the configuration before generation; it is infrastructure diagnosis, not a formal result. |
| Gold6 Max v1 | 100000-token metadata; 6 compactions; terminal CONTEXT_COMPACTION_INEFFECTIVE | The registry metadata recorded a 100,000-token context window; v2 is the corrected 1,000,000-token main run. |
| Gold9 frozen/proxy | 15 static execute attempts; no publication | A frozen-prompt proxy rerun used for route diagnosis, not included in the six-run primary cohort. |
| Gold9 dynamic-first | profile scaffold rejected; 16 INVALID_INPUT failures; no publication | This is an explicit prompt variant, not a frozen Gold9 rerun; it is route diagnosis only. |

## Reproduction and Derived Files

Run the generator from a checkout containing this script:

```bash
node scripts/generate-gold6-10-session-report.mjs \
  --campaign-root /home/modenicheng/coding/BioMed-QAgent/data/gold-campaigns/2026-09-03-main-e5aadfe0-qwen38-six-run-corrected \
  --output-dir docs/evaluation/gold6-10-2026-09-03
```

Derived files: `results.json` (structured facts), `processed-log.jsonl` (redacted normalized event summaries), six reports under `runs/`, and `evidence-manifest.sha256` (SHA-256 of every derived artifact except itself). The generator verifies its own JSON output, every generated manifest entry, and credential-like patterns without printing any match content.
