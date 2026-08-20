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

## Evidence Gaps

The current evidence bundles do not yet provide a machine-checkable projection
for all of these stages:

- admitted SourceAsset and role-aware input receipts;
- family/schema admission and assembled table/relation inventory;
- ProductAssessment or equivalent semantic validation result;
- authoritative publication receipt;
- Artifact API download and SHA-256 re-verification;
- final-answer publication reference.

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
