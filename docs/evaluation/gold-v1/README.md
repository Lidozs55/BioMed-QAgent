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

The verifier checks UTF-8 prompts, prompt hashes, all referenced files, source-anchor hash/size formats, the frozen default runtime limits, and the full directory checksum inventory. `checksums.sha256` covers every versioned input except itself.

## Source inventory semantics

`historical_content_anchors` establish that a known public response or file was observed with the listed bytes and SHA-256 when this manifest was frozen. They are not pre-approved publication inputs. G1 must acquire or resolve sources through the Core-owned path and record actual receipt hashes. A provider may return newer content when its policy is `refresh_and_register`; the new hash and provider/version metadata then become part of run evidence.

Large inputs are never committed here. For them the source inventory records accession, URL, byte count, and SHA-256 only.
