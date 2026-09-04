# Gold v1 Diagnostic Baseline

## Scope

This audit is an offline evaluation of the existing evidence directory. It did
not rerun external acquisition, modify frozen Gold inputs, or treat workspace
files as trusted artifacts.

- evaluator target commit: `54cf7ec2829612e13da652b9fdb4ecc80b2bab69`
- evidence root: local ignored `data/gold-runs/dd498ec8-rerun/`
- evidence product commit: `dd498ec862d5c0e827241509ea4171df018788cb`
- frozen reference: `docs/evaluation/gold-v1/`
- strict result: **0/6**

The matrix was generated with explicit roots:

```bash
server/node_modules/.bin/tsx \
  server/src/evaluation/gold-diagnostic-matrix-cli.ts \
  --evidence-root ../BioMed-QAgent/data/gold-runs/dd498ec8-rerun \
  --gold-root docs/evaluation/gold-v1 \
  --target-commit 54cf7ec2829612e13da652b9fdb4ecc80b2bab69
```

The CLI returned exit code `2`, meaning at least one strict failure. Its stdout
was one deterministic JSON document and stderr was empty.

## Matrix Summary

| Case | Strict status | Execution | Trusted inputs | Semantic product | Publication | Reproducibility | Primary blocker |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gold1 | fail | unknown | unknown | unknown | unknown | fail | `identity.product_commit_mismatch` |
| gold2 | fail | unknown | unknown | unknown | unknown | fail | `identity.product_commit_mismatch` |
| gold3 | fail | pass | unknown | unknown | unknown | fail | `identity.product_commit_mismatch` |
| gold4 | fail | pass | unknown | unknown | unknown | fail | `identity.product_commit_mismatch` |
| gold5 | fail | pass | unknown | unknown | unknown | fail | `identity.product_commit_mismatch` |
| gold6 | blocked | unknown | blocked | unknown | unknown | fail | `trusted_input.hil_pending` |

Aggregate strict statuses:

```json
{ "pass": 0, "fail": 5, "blocked": 1 }
```

All six frozen-input checks passed. None of the old evidence can satisfy a
same-commit result for the target commit. Gold6 has an explicit generic HIL
sidecar with `hil_request.status=pending` and `blocking=true`; the evaluator
therefore reports blocked rather than failed or passed.

## E6 Trusted Evidence Projection

The evaluator now projects existing event/snapshot/artifact evidence without
changing the runtime. On the same old evidence root and target commit, the
matrix remains:

```text
pass: 0
fail: 5
blocked: 1
```

The projection recovered the following facts where the old collector had left
`unknown`:

- task/run completion from matching snapshot and terminal events;
- authoritative publication receipts from `publication_created` and matching
  snapshot publication records;
- artifact receipt-only versus downloaded hash/size verified states;
- final assistant text and exact publication-ID reference;
- pending blocking HIL from event or sidecar evidence.

For the old bundles, Gold1, Gold3, and Gold5 now have a machine-checkable
publication check of `pass`; this is not a strict Gold pass because the target
product commit differs, semantic product remains unknown, and trusted SourceAsset
receipts are absent from the bundle. Gold6 remains `blocked` because its pending
blocking HIL is explicit. No workspace file or publication count is promoted to
semantic product success.

## TASK-057 ProductAssessment Evidence Projection

The evaluator can now project `semantic_product` from a Core-owned
`product_assessment.json`, but only when one evidence bundle closes all of these
identities:

```text
selected run
-> strict BuildResult.publication_id
-> authoritative publication receipt with the same publication ID
-> publication_artifacts.publication_id with the same publication ID
-> product_assessment.json production receipt
-> Artifact API list receipt
-> Artifact API download hash/size receipt
-> downloaded raw UTF-8 bytes rehashed inside the projector
-> strict ProductAssessment parser
```

The evaluator-owned downloaded-content envelope is intentionally bounded and
path-free:

```json
{
  "publication_artifacts": {
    "schema_version": "1.0",
    "publication_id": "pub_...",
    "artifact_list": ["...Artifact API list receipts..."],
    "artifact_hashes": ["...download receipts rehashed by the collector..."],
    "artifact_contents": {
      "artifact_...": {
        "artifact_id": "artifact_...",
        "utf8": "{...downloaded JSON bytes...}\n"
      }
    }
  }
}
```

The projector computes the UTF-8 byte length and SHA-256 itself. Flat legacy
`artifact_list`/`artifact_hashes`, claimed hashes, workspace paths, top-level
`product_assessment` sidecars, receipt-only artifacts, wrong run/publication
identities, duplicate/conflicting artifact identities, unknown envelope fields,
and malformed assessment fields cannot upgrade semantic status. The evaluator
must also supply the expected requirement/package/version identity; an otherwise
valid assessment for another package cannot represent the evaluated product. An
identity-matched verified `publishable` assessment maps to `pass`, `incomplete`
maps to `fail`, and `validated` remains `unknown` because it is not yet a
reproducibly publishable product.

A read-only smoke against `data/gold-runs/dd498ec8-rerun/` at the TASK-057 base
commit retained `0 pass / 5 fail / 1 blocked`; all six semantic-product checks
remain `unknown` because the old bundles contain no publication-bound downloaded
assessment bytes. Gold6 remains blocked by its real pending HIL. No frozen Gold
input or legacy evidence file was changed.

## Evidence Gaps

The current evidence bundles do not yet provide a machine-checkable projection
for all of these stages:

- admitted SourceAsset and role-aware input receipts;
- family/schema admission and assembled table/relation inventory;
- ProductAssessment or equivalent semantic validation result;
- authoritative publication receipt;
- Artifact API download and SHA-256 re-verification;
- final-answer publication reference.

The evaluator-owned projection labels each fact as `present`, `missing`,
`conflicting`, or `receipt_only`, with source refs. This makes old collector
omissions distinguishable from evidence genuinely absent from the bundle.

Gold3-Gold5 prove completed task/run execution in the selected evidence files,
but that is not product or publication success. Gold1, Gold2, and Gold6 do not
provide completed task/run evidence in their canonical unsuffixed bundles.
Rerun-suffixed sidecars are not automatically substituted because the evaluator
requires explicit evidence selection and identity closure.

## Next Repair Slice

The next P0 slice is **trusted evidence-chain projection**, not Canonical IR or a
new family abstraction.

First inspect existing durable events, Core receipts, BuildResult, publication
events, Artifact API hash sidecars, and final messages. Project those existing
facts into one evaluator-owned chain:

```text
accepted request
-> terminal task/run
-> admitted SourceAsset receipts
-> build and validation result
-> publication receipt
-> artifact download/hash verification
-> final-answer publication reference
```

Missing stages must remain `unknown` or become a typed blocker. Runtime changes
are justified only when a required stage is absent from the authoritative event
or receipt model, not merely absent from the old ad hoc evidence bundle.

After this projection, rerun the offline matrix against the same evidence root.
Use the resulting earliest supported boundaries to select the smallest production
repair shared by multiple cases. Do not begin full Canonical Evidence IR,
RegisteredTransform, dynamic Skill work, or repository cleanup before that
boundary distribution is available.
