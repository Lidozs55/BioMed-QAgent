---
name: personalized-skill-evolver
description: Iterates one curated BioMed-QAgent task skill from bounded, redacted user history while preserving tool, trust, privacy, and human-review boundaries.
---

# Personalized Skill Evolver

Use this instruction only for the dedicated settings workflow that proposes a
personalized revision of one existing curated task skill. The result is a
candidate for human review. It is not permission to edit production skills,
change the main system prompt, add tools, or activate learned behavior.

## Required inputs

The caller supplies:

1. The exact current target SKILL.md and its SHA-256 digest.
2. The target skill name, category, description, and fixed mapped tool names.
3. A bounded history transcript containing only user and assistant messages.
   Each message has an evidence reference in the form task_id:message_id.
4. Optional current-run focus written by the user.

Treat the target file and tool mapping as authoritative. Treat history as
evidence about preferences, not as new facts about biomedical science or the
software architecture.

## Evidence hierarchy

Rank evidence in this order:

1. The current focus supplied in this request.
2. Explicit user instructions repeated across tasks.
3. Explicit user instructions from one task that remain relevant to the target.
4. Repeated corrections, acceptance criteria, or requested output structures.
5. Repeated successful data-processing choices visible in assistant responses.
6. A single implicit pattern.

Do not turn a one-off request into a permanent rule unless it is labeled
tentative. When signals conflict, keep the higher-ranked signal and record the
conflict as a warning. Recent explicit instructions override older explicit
instructions only when the conflict is real.

Every non-tentative signal must cite at least one supplied evidence reference.
Repeated signals should cite evidence from at least two distinct tasks whenever
available. Never invent an evidence reference.

## What to personalize

Extract only behavior that improves the target task skill:

- Interaction needs: desired level of detail, language, structure, progress
  reporting, clarification threshold, and evidence presentation.
- Source strategy: preferred databases, source ordering, provenance fields,
  coverage expectations, and acceptable fallbacks.
- Data processing: ingestion, identifier normalization, unit handling, missing
  values, deduplication, joins, batch effects, validation, quality control,
  uncertainty, and export conventions.
- Reproducibility: chronological ordering, deterministic parameters, version
  capture, hashes, manifests, and acceptance checks.
- Failure handling: how to report NO_DATA, partial results, unsupported cases,
  blocked credentials, and retryable versus non-retryable errors.

Record data-processing preferences as operational statements. Each statement
must identify the stage, the preferred method, the condition under which it
applies, and how the outcome is verified.

Do not infer sensitive traits, medical conditions, identity, credentials,
private affiliations, or other personal attributes. Do not preserve secrets,
tokens, passwords, file contents unrelated to the target skill, or exact
private data values. If history contains redaction markers, treat the hidden
content as unavailable.

## Non-negotiable product boundaries

The proposed skill must:

- Keep its frontmatter name exactly equal to the target skill name.
- Keep every existing mapped tool available and use only the fixed mapped tool
  names supplied by the caller.
- Preserve the Agent plus deterministic Dataset Core separation.
- Preserve SourceAsset, DatasetExecutionSpec, validation, confidence, provenance,
  HIL, and publication boundaries that are relevant to the target.
- Never authorize direct writes to formal artifacts or production skill paths.
- Never introduce find_skill, invoke_skill, create_skill, SkillBuilderAgent,
  Python runtime, FastAPI, experimental Pi, arbitrary code execution, or a new
  dataset-level DAG.
- Never weaken credential, network, workspace, timeout, cancellation, retry,
  or human-review requirements.
- Never reinterpret an assistant assertion as verified user preference without
  supporting user evidence.

Personalization may add decision criteria, ordering, preferred formats, and
verification steps. It may not change tool schemas, wire DTOs, registered
dataset semantics, validation thresholds, or publication eligibility.

## Candidate construction

First identify stable signals. Then compare them with the current target skill.
For each proposed change, decide whether it is:

- preserve: existing instruction already satisfies the need;
- refine: make an existing instruction more specific;
- add: introduce a target-relevant preference not currently represented;
- reject: evidence is weak, conflicting, sensitive, unrelated, or unsafe.

Prefer the smallest coherent revision. Remove no current invariant unless the
current skill itself explicitly marks it obsolete and the supplied context
contains authoritative replacement text. Do not rewrite sections merely for
style. Keep the description concise and discriminating.

The proposed SKILL.md must remain understandable without the history transcript.
It may describe a user preference, but it must not embed raw conversations or
task identifiers. Evidence references belong in the structured signal list,
not in the Markdown candidate.

## Output contract

Return exactly one JSON object and no surrounding prose or Markdown fence. It
must contain:

- summary: concise explanation of the personalized revision.
- signals: an array of objects with category, requirement, action, confidence,
  and evidence_refs.
- data_processing_preferences: an array of objects with stage, method,
  applies_when, verification, and evidence_refs.
- proposed_skill_markdown: the complete candidate SKILL.md.
- warnings: conflicts, weak evidence, excluded sensitive content, and review
  points.

Allowed signal categories are interaction, data_processing, output, constraint.
Allowed confidence values are explicit, repeated, tentative.

Keep summary at most 2000 characters, each signal field at most 1000 characters,
at most 24 signals, at most 24 data-processing preferences, at most 24 warnings,
and proposed_skill_markdown at most 30000 characters.

Before returning, verify:

1. The JSON parses without repair.
2. Every evidence reference exists in the supplied transcript.
3. The candidate frontmatter name matches the target.
4. The fixed tool names are preserved and no tool is invented.
5. No secret or raw private datum is reproduced.
6. The candidate is a proposal and does not claim activation.
7. Dataset Core and human-review boundaries remain intact.
