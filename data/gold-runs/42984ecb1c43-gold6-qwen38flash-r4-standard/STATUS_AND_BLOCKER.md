# Gold6 R4 formal result

## Terminal classification

- Product commit: `42984ecb1c430e5128cce93257c2286ab6bf1107`
- Prompt SHA-256: `f30ab31099da23c75a3e0037ee303b8814c7c124bc1e84be149d2c6f4c8fc298`
- Task: `task_ts_b41c545e-2375-4244-9305-103dc06f991a`
- Run: `run_ts_7d68668d-13b0-4d20-a988-eed58f27484f`
- Terminal event: `run_completed` at sequence 10,478
- Classification: **`blocked_no_publication`**
- `current_publication_id`: `null`
- Formal Publications / Artifacts / publication-acceptance reviews: **0 / 0 / 0**

`completed` is not a Gold success. `assert-current-run.mjs` rejected the run on the five expected missing publication-closure facts; see `assert-current-run.log`.

The user explicitly directed this rerun to proceed without the full workspace gates. The frozen product commit had focused evidence only: five directly affected server files / 48 tests passed, test TypeScript passed, and changed-file ESLint passed.

## What R4 proved

R3's supplementary-member deadlock is closed in live production behavior:

- A successful Dynamic Family preflight admitted three registered JSON evidence carriers as `transform_input`.
- Ten provenance assets (later thirteen) were admitted as `provenance_only`; `required_input_roles` remained exactly the three JSON carrier roles.
- PMC5355725 ZIP `asset_63d8e…ea48` produced real JPEG member `asset_38428f…e9c4` through committed `archive_member_extraction` OperationResult `result_archive_eef24411…`.
- That binary member was not exposed to the UTF-8 Transform Host. It entered the formal dependency closure and became a parent of successful VLM carrier `asset_4de014…90d4`.

See `binding-closure-summary.json`, `formal-state/core-derived-asset-provenance.json`, and `formal-state/derived-operation-results/`.

## Current formal blocker

The production VLM producer and literature semantic validator disagree on the manifest contract:

- `registered-paper-chart-extraction` v1.2.0 produced three content-addressed carrier JSON files with paper/experiment/activity/supplement/series/point arrays, but no top-level `evidence_manifest`.
- Their `CoreDerivedAssetProvenance.evidence` records contain carrier identity, paper identity, source assets, prompt/model identity, and output digest, but no `manifest` object.
- `validateLiteratureExperimentChartProfile()` requires `evidence.manifest` and reads `manifest.charts` / `manifest.points`.

Five committed six-table candidates were therefore rejected with `Core VLM provenance requires an embedded evidence manifest`. Three attempts that tried to substitute a Core extraction receipt as a locator were correctly rejected with `OUTPUT_CLOSURE_MISMATCH`; no fallback ran for those control failures.

This should be fixed at the producer/consumer contract, with production-output regression coverage. A model-authored manifest or rewritten Core descriptor is not acceptable.

## Untrusted fallback outcome

The five typed semantic rejections each archived six table files into task quarantine:

- 30 `ua_*` submissions total, five copies for each six-table name.
- Every `artifact.bin` was re-read and matched its receipt size and SHA-256.
- Every receipt is `authoritative: false` and `trust: "untrusted"`.
- Tool results remained errors with `formal_status: "rejected"`.
- The fallback emitted no formal OperationResult, ValidationResult, ProductAssessment, DatasetPublication, Artifact, or current-publication pointer update.

See `dynamic-submit-summary.json`, `quarantine-summary.json`, and `quarantine/`. These bytes are evidence of recoverability after rejection, not Gold output.

## Remaining data-quality closure

The final three VLM carriers contain:

- 3 paper records
- 107 experiment records
- 185 activity-value records
- 4 supplementary records
- 86 chart-series records
- **0 chart-point records**

There are no point review IDs and no `vlm_extraction` data-review HIL. No estimated coordinates were promoted as exact values.

## Route-discipline exception

After selecting the Dynamic Family semantic route, the Agent also attempted static validation twice and static execution six times under changed requirement IDs. Every static execution failed and produced no formal Publication or Artifact. These attempts are explicitly excluded from Gold closure. Prompt-only route locking failed in both R3 and R4; a durable Host-side semantic-route fence remains required.

See `route-audit.json`.

## Evidence boundaries

- `events.jsonl` is byte-identical to the authoritative task log: SHA-256 `97073dddfd684c96668dc3b38ef9d92cb3131e06c73780e6e78a7d415a3cb0ef`, 10,478 lines.
- `source-asset-summary.json` records a successful size/SHA-256 re-read of all 14 task registrations before Host shutdown.
- The five rejected integrated OperationResult manifest IDs are preserved in quarantine source notes and `operation-result-summary.json`. The runtime did not expose standalone durable manifest files or formal `operation_completed` events for those formally rejected results; this visibility limitation is recorded rather than reconstructed.
- Original XML/PDF/ZIP carrier bytes are not duplicated in this repository evidence pack; their task-owned receipts, Core acquisition provenance, and pre-shutdown byte-reverification results are included. Derived carrier/member bytes required to prove the R4 fix are included.
- Runtime settings, API credentials, PIDs, rendered pages, and Host logs are excluded.
