# Phase 4 to Phase 5 Hardening Roadmap

## Status

Active long-term roadmap. Updated 2026-08-20 after the migration-complete status
review.

The project is no longer in a migration phase. Phase 0-9 migration work is
complete; the current product phase is **Phase 4 Gold audit transitioning to
Phase 5 hardening and release**.

This roadmap is intentionally narrower than a platform expansion plan. The
primary objective is to prove and stabilize the existing system before adding
new general-purpose capability.

## Current Product Position

The formal topology is stable:

```text
TS Host + Pi Agent + TS Dataset Core + Python database bridge
```

The existing workspace isolation, durable runtime, fixed Dataset Core pipeline,
family contracts, source receipts, validation gates, Publisher, and immutable
artifact APIs remain the product foundation. They are not migration leftovers
that need to be replaced.

The central release risk is the gap between partial Agent work and a complete,
trusted product:

```text
Agent discovery / tool output
  -> workspace or intermediate result
  -> family contract admission
  -> assembly and validation
  -> publication and artifact evidence
```

A successful execution of one family operation does not by itself prove that the
requested product is complete. The release process therefore needs stronger
observability and product-level evaluation before more capability is added.

## Priority Order

### P0: Machine-readable Gold evaluation

Make every frozen Gold run explain its failure in terms that map to an actionable
system boundary:

- discovery did not find the required evidence;
- evidence was found but was not bound into a trusted input;
- the family or schema could not express it;
- assembly or validation rejected or dropped it;
- publication did not contain the required product;
- identifier, relation, provenance, confidence, HIL, or artifact evidence was
  incomplete;
- the evaluator itself had an invalid assumption.

The evaluator must preserve the frozen prompt, source inventory, input hashes,
and acceptance standard. It diagnoses the result; it does not weaken the Gold
standard or create a benchmark-specific production path.

### P1: Contract and product-chain review

After P0 diagnostics identify the dominant failure boundaries, review the
existing family and contract design:

```text
family capability -> candidate evidence -> trusted binding
-> validation/assembly -> publication
```

The review must decide, using observed failures, whether a small generic contract
extension is sufficient or whether a carefully bounded canonical evidence
projection is necessary. Existing family outputs remain compatible during this
review. Do not implement a general IR, dynamic DAG, or Agent-authored publication
schema as a precaution.

The review must also make the Agent boundary explicit:

- Agent: discover sources, propose mappings, report candidate evidence, request
  registered capabilities;
- Core: admit inputs, execute fixed transforms, validate relations/provenance,
  assemble products, and publish immutable artifacts.

### P2: Repository hygiene and architecture slimming

Only after Gold diagnosis and the highest-value product-chain repairs are stable:

- archive or consolidate stale planning documents;
- identify files with multiple responsibilities or excessive size;
- clarify Tool, Skill, and Pipeline ownership;
- remove dead compatibility paths only when their callers and rollback impact
  are known;
- freeze architecture and documentation for release.

Cleanup must not change semantics merely to make the repository look smaller.

## Phased Execution

### Phase 4A: Evaluation baseline

Deliver a deterministic evaluator report for the current frozen Gold evidence.
The first implementation should be offline and pure where possible. It should
consume the existing manifest plus task/run/build/publication/artifact evidence,
and report per-case findings without modifying Dataset Core execution.

Required dimensions:

- execution lifecycle and terminal state;
- required trusted inputs and source/carrier receipts;
- expected family/schema/table presence;
- row shape and relation checks;
- identifier and cross-reference closure;
- provenance and locator coverage;
- confidence and HIL state;
- publication/artifact/hash reproducibility.

Each finding needs a stable code, severity, evidence pointer, and owning boundary.

### Phase 4B: Evidence-chain repair

Use evaluator output to select the smallest complete repair slice. A repair is
complete only when the same frozen case can demonstrate:

```text
task -> run -> build -> trusted inputs -> validation -> publication
-> artifact download -> hash parity -> final answer evidence
```

Every repair includes a reproducing test, a regression test, and updated evidence
for the affected Gold case. Workspace files remain diagnostic inputs or
candidate outputs; they are never treated as trusted publication artifacts.

### Phase 4C: Gold closure

Run the frozen Gold suite on one product commit only after the relevant repair
slices have passed their local gates. Keep strict case accounting: historical
publication, a standalone module test, or a workspace CSV is not a substitute
for same-commit end-to-end evidence. Gold6 remains blocked on real HIL when its
confidence/credential policy requires it.

### Phase 5A: Release hardening

After Gold results are understood and the required closure work is complete:

- run root quality gates and bounded-memory checks;
- verify restart, cancellation, permission recovery, publication durability,
  artifact download, and hash parity;
- audit secrets, stale files, generated output, and documentation links;
- freeze the supported topology and release checklist.

### Phase 5B: Controlled generalization

Only after release gates pass, consider the smallest reusable semantic extensions
needed by more than one real product family. A Canonical Evidence Product Layer
may continue as an additive design direction, but each new primitive must have:

- at least two concrete product consumers;
- a stable contract and validation semantics;
- deterministic provenance and reproducibility evidence;
- compatibility fixtures for existing family projections;
- a rollback path.

The existing design reference is
[`2026-08-20-canonical-evidence-product-layer.md`](2026-08-20-canonical-evidence-product-layer.md).
It is subordinate to this release roadmap with respect to sequencing.

## Stop Conditions

Pause capability expansion when any of these is true:

- the Gold evaluator cannot identify which boundary failed;
- a proposed fix changes the frozen Gold prompt, input, schema standard, or
  acceptance criterion;
- a workspace artifact is being used as a trust shortcut;
- execution success is being presented as product success without assessment;
- a new abstraction has only one benchmark consumer;
- the change requires re-migrating runtime, replacing workspace isolation, or
  adding dynamic Agent-controlled orchestration.

## Definition of Done

The Phase 4 to Phase 5 transition is complete when:

1. Every frozen Gold case produces a machine-readable diagnosis.
2. The dominant Agent-to-Publication breaks are either repaired or explicitly
   recorded as unsupported capabilities.
3. Strict Gold status is reported from same-commit end-to-end evidence.
4. Core quality, security, cancellation/recovery, bounded-memory, publication,
   and artifact integrity gates pass.
5. The supported topology and extension boundaries are documented and frozen.
6. Remaining feature ideas are ordered after release hardening rather than mixed
   into the closure work.
