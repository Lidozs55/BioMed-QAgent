# Gold Evaluator Near-term Plan

## Status

Active near-term plan for Phase 4A. This plan covers the next three to five
complete work packages. It does not modify the frozen Gold inputs or the
production Dataset Core topology.

Parent roadmap:
[`2026-08-20-phase4-to-phase5-hardening-roadmap.md`](2026-08-20-phase4-to-phase5-hardening-roadmap.md).

## Goal

Turn the frozen Gold v1 corpus from a checksum inventory into a deterministic
diagnostic system that answers:

```text
what failed -> where it failed -> evidence for the finding -> owning boundary
```

The evaluator is an offline release/audit tool. Production contracts may be
reused where useful, but production code must not contain Gold case identifiers
or benchmark-only family behavior.

## Failure Taxonomy

Every finding must use one primary boundary:

| Boundary | Meaning |
| --- | --- |
| `discovery` | Required source/evidence was not found or reported by the run. |
| `trusted_input` | Evidence existed but lacked an admitted SourceAsset/binding/receipt. |
| `contract` | The selected family/schema/package could not express a required product element. |
| `assembly` | Trusted inputs existed but required tables/relations were absent after assembly. |
| `validation` | Schema, relation, identifier, provenance, confidence, or HIL checks failed. |
| `publication` | A validated candidate was not promoted or publication artifacts were incomplete. |
| `reproducibility` | Artifact download/hash/manifest or same-commit evidence was incomplete. |
| `evaluator` | The reference requirement or evaluator assumption was invalid or uncheckable. |

Finding severity is `info | warning | blocker`. A strict case passes only when it
has no blocker and its same-commit evidence chain is complete.

## Stable Report Shape

The evaluator report must be versioned and deterministic:

```json
{
  "schema_version": "1.0",
  "case_id": "goldN",
  "product_commit": "...",
  "strict_status": "pass | fail | blocked",
  "findings": [
    {
      "code": "publication.required_table_missing",
      "severity": "blocker",
      "boundary": "publication",
      "requirement_ref": "...",
      "evidence_refs": ["..."],
      "message": "..."
    }
  ],
  "checks": {
    "frozen_inputs": "pass | fail | unknown",
    "execution": "pass | fail | unknown",
    "trusted_inputs": "pass | fail | unknown",
    "semantic_product": "pass | fail | unknown",
    "publication": "pass | fail | unknown",
    "reproducibility": "pass | fail | unknown"
  }
}
```

Unknown is not pass. Missing evidence must produce an explicit finding rather
than being silently ignored.

## Work Packages

### E1: Freeze evaluator contracts and fixtures

Deliver:

- versioned diagnostic report types and strict parser;
- stable finding codes, boundary enum, severity, check status;
- generic fixture tests for pass, fail, blocked, unknown evidence, malformed
  report, and deterministic ordering;
- no production runtime wiring.

Acceptance:

- contracts reject unknown fields and invalid status combinations;
- findings sort deterministically by boundary/code/requirement/evidence;
- no contract field references a Gold-specific table or case;
- existing `ProductAssessment` remains a generic semantic input, not the entire
  Gold report.

### E2: Evidence inventory loader

Deliver an offline loader for a run evidence directory. It must inventory, but
not infer success from:

- frozen manifest/case/source/reference files and checksums;
- product commit and runtime-default evidence;
- task/run/build terminal state;
- admitted SourceAsset and role-aware receipts;
- ProductAssessment or legacy validation summaries;
- publication and artifact receipts;
- downloaded artifact hash verification;
- HIL requests/decisions.

Acceptance:

- missing or malformed evidence produces typed `unknown`/blocker findings;
- paths are confined under the provided evidence root;
- historical evidence is labelled and cannot satisfy same-commit checks;
- loader does not call external services or mutate evidence.

### E3: Semantic reference checks

Translate each frozen reference schema into evaluator-only requirements:

- expected tables and required columns;
- identifier namespaces and closure rules;
- relation topology and foreign-key requirements;
- source/provenance/locator requirements;
- confidence/HIL requirements;
- artifact roles and hash requirements.

Acceptance:

- requirements live under `docs/evaluation/gold-v1/` or an evaluator fixture
  module, never in production family registries;
- the evaluator reports unsupported/uncheckable requirements explicitly;
- table/schema checks stream or inspect bounded metadata where possible;
- the existing frozen checksums remain valid unless a separately approved
  manifest version is created.

### E4: Boundary diagnosis engine

Combine E2 evidence with E3 requirements and emit the stable report. When a
required product element is missing, classify the earliest evidenced boundary:

```text
discovery -> trusted_input -> contract -> assembly -> validation
-> publication -> reproducibility
```

Do not guess an earlier failure without evidence. If the evidence cannot locate
the boundary, emit `evaluator.insufficient_evidence`.

Acceptance:

- fixtures cover all eight boundaries;
- one failure may have supporting secondary findings, but exactly one primary
  owning boundary;
- report ordering and JSON serialization are deterministic;
- evaluator exit code distinguishes pass, fail, blocked, and evaluator error.

### E5: Baseline Gold diagnostic run

Run E1-E4 against the existing same-commit evidence inventory without rerunning
all external data acquisition. Record:

- per-case report;
- aggregate counts by boundary and finding code;
- evidence gaps that require a future rerun;
- the smallest repair candidates ordered by Gold impact and implementation risk.

Acceptance:

- strict status remains unchanged unless complete evidence proves otherwise;
- no historical publication or workspace CSV is counted as a trusted artifact;
- Gold6 pending real HIL remains `blocked`, not automatically failed or passed;
- the report identifies the next repair slice rather than prescribing a broad
  architecture rewrite.

## Immediate Sequence

```text
E1 contracts/fixtures
  -> E2 evidence loader
  -> E3 evaluator-only requirements
  -> E4 diagnosis engine
  -> E5 baseline report
  -> select one evidence-chain repair
```

After E5, stop and review the dominant boundary distribution. Do not start repo
cleanup, full Canonical IR, RegisteredTransform, or dynamic Skill work until the
next repair is selected from evaluator evidence.

## Verification

For every work package:

- affected package typecheck/lint/tests;
- strict parser and malformed-input tests;
- deterministic fixture snapshots;
- `node docs/evaluation/gold-v1/verify.mjs` remains green;
- no production Gold identifiers outside evaluator-owned code/data;
- no changes to prompts, source inventory, runtime defaults, or acceptance
  thresholds.
