# Gold v1 frozen evaluation manifest

This directory is the versioned input contract for the six trusted-publication Gold evaluations. It contains only small evaluation metadata. Raw downloads, reference CSVs, task workspaces, publications, and run evidence stay outside this directory.

## Rules

- `prompts/gold*.txt` are byte-for-byte copies of the original evaluation prompts. Do not edit them to fit an implementation.
- `manifest.json` is the only case index consumed by the final G1 evaluator.
- `schemas/*.json` describe required publication shape, not production capabilities. A reference schema does not admit a family to the production `FamilyRegistry`.
- `sources/*.json` freeze allowed providers, stable identifiers, and historical content anchors. Dynamic APIs must still produce newly registered immutable `SourceAsset` receipts during a run.
- Workspace files and historical reference outputs are never passing artifacts.
- A case passes only when its frozen prompt produces a successful task, run, build, immutable publication, verified artifact download, and final answer on one product commit under `runtime-defaults.json`.
- The strict result remains 0/6 until G1 reruns all six cases on the same commit.

## Verification

From the repository root:

```bash
node docs/evaluation/gold-v1/verify.mjs
```

The verifier checks UTF-8 prompts, prompt hashes, all referenced files, source-anchor hash/size formats, the frozen default runtime limits, and the full directory checksum inventory. `checksums.sha256` covers every versioned input except itself. After adding or changing a versioned input, refresh the inventory with `node docs/evaluation/gold-v1/verify.mjs --write-checksums`.

## Current-commit assertion (Gold6)

A saved Gold6 run — the JSON written by `run-case.mjs gold6 --output <file>` — is asserted against the current commit and live Host with:

```bash
node docs/evaluation/gold-v1/assert-current-run.mjs data/gold/gold6-current-run.json [--base-url URL]
```

`assert-current-run.mjs` REJECTS the run (exit 1, one `REJECT:` line per problem) when any of the following holds:

- **Commit mismatch** — the run's `product_commit` differs from the current `git rev-parse HEAD`.
- **Context-hash mismatch** — the run's `execution_context` hashes (manifest, case, prompt, runtime profile) do not match the frozen files on disk, or the persisted run `execution_context` drifted from them.
- **Missing PMCID coverage** — any frozen PMCID (`sources/gold6.sources.json` selection) appears nowhere in the run evidence or is missing from the published `paper_records`.
- **Missing required tables** — the published manifest does not contain every `required_tables` entry of the frozen case.
- **Pending/rejected estimates** — a published `chart_points` row is not `accepted`/`corrected`, or a corrected row does not preserve its original values.
- **Absent review IDs** — a published estimate carries no durable review id, or the single `publication_acceptance` review was never resolved.
- **Stale source receipts** — a published source asset id is not evidenced by this run's own event stream (i.e. it was copied from an earlier run).
- **Artifact API hash mismatch** — a declared artifact fails to download, or its bytes re-hash to something other than the manifest receipt (the published manifest itself is re-verified the same way, plus exactly one `publication_created` event).

Historical Gold6 runs cannot pass this script: they were produced by different commits, without the frozen execution context, and without the governed extraction route.

## Source inventory semantics

`historical_content_anchors` establish that a known public response or file was observed with the listed bytes and SHA-256 when this manifest was frozen. They are not pre-approved publication inputs. G1 must acquire or resolve sources through the Core-owned path and record actual receipt hashes. A provider may return newer content when its policy is `refresh_and_register`; the new hash and provider/version metadata then become part of run evidence.

Large inputs are never committed here. For them the source inventory records accession, URL, byte count, and SHA-256 only.
