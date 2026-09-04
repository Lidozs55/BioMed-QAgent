# ADR-040: Personalized skill iteration produces evidence-bound review candidates

## Status

Accepted.

## Context

The existing self-iteration script reconstructs one Run's tool flow and writes
replay and SKILL.md candidates into that Task's solidification directory. It
does not learn stable user preferences across Tasks, record preferred
data-processing methods, or expose an interactive settings workflow.

There is no single main SKILL.md. The main Agent has a fixed system prompt plus
the curated skill set under .pi/skills, and dataset-construction is the default
task-core skill. Automatically replacing curated skills from model output would
reintroduce an unreviewed learned-skill runtime and would make provenance,
rollback, and trust boundaries ambiguous.

Historical conversations can also contain secrets, private data, one-off
requests, assistant mistakes, and mutually conflicting instructions. Sending
unbounded history to a model or treating every past pattern as permanent would
be unsafe and low quality.

## Decision

Add a settings entry named Skill 迭代 with a candidate-only workflow:

1. The user selects one curated target Skill and an explicit recent-history
   range, optionally adding a current focus.
2. The server reads only terminal Task snapshots. It selects user and assistant
   messages, excludes system/tool/reasoning content, redacts common credential
   patterns, and enforces per-message, per-task, task-count, and aggregate
   character limits.
3. A dedicated internal instruction skill at
   server/src/agent/skill-iteration/personalized-skill-evolver/SKILL.md guides a
   tool-free one-shot call through the configured Pi model adapter.
4. The model returns strict JSON with preference signals, evidence references,
   data-processing preferences, a full target SKILL.md candidate, and warnings.
5. The server validates evidence references against the supplied transcript,
   preserves the target name and mapped tools, rejects forbidden legacy
   surfaces, binds the candidate to the source SHA-256 and model identity, and
   atomically stores it under data/settings/skill-iterations.
6. The UI displays and allows copying the candidate. It never auto-writes
   .pi/skills, changes the fixed main prompt, or affects an active Run.

The source .pi/skills tree remains the curated runtime truth. Promotion still
requires a separate human review, validation, commit, and rollback point.

## Consequences

- Users can iteratively personalize task SOPs from evidence in prior work
  without silently activating model-authored instructions.
- Personalization needs and data-processing choices become structured,
  evidence-referenced, version-bound records.
- The configured model provider receives a bounded subset of selected history
  only after an explicit user action; the UI must disclose that fact.
- Candidate generation can fail closed on malformed JSON, invalid evidence,
  source drift, missing mapped tools, timeout, or upstream model failure.
- Applying, diffing, reverting, or promoting a candidate is intentionally
  outside this decision and requires a future explicit HIL design.
