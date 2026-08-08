# Task for reviewer

Read-only scoped final re-review in /mnt/d/code-linux/BioMed-QAgent branch fix/phase4-review-bugs. Inspect full diff .superpowers/review-phase4/final-fix-review.diff, original review-{A,B,C,D}.md, wave reports, docs/REVIEW_2026-08-08-phase4-bug-sweep.md, and actual branch files. Focus backend fixes B1 B2 B7 B8 B9 D2 D3 A8 A1 A5 B3+B4 B5 B6 D1. For each return ADDRESSED/NOT ADDRESSED/REGRESSION with exact current file:line evidence. Deeply assess B5 dual NO_DATA signals, G3 validation_result_ref residual scope/inventory impact, and backend cross-wave interactions. Do not modify or run controller-verified gates. Report only concrete issues.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```