# ADR-026: Durable HIL and confidence protocol

## Status

Accepted (2026-08-16).

## Context

Runtime already emitted durable `user_input_required` and `user_input_resumed`
events, but credential approval kept its unresolved waiter in a process-local
`Map`. Dataset Core separately carried confidence and mapping review fields.
Events therefore described a pause without durably owning the pending decision,
and confidence, human review, and validation could be mistaken for substitutes.

Data review also needs more than permission's `approve` / `reject`: accepting a
machine candidate, correcting it, rejecting it, and skipping it have different
provenance consequences. A reviewer must decide against the exact evidence they
saw, not whatever evidence happens to exist when the response is applied.

## Decision

HIL is a Runtime primitive. `HILRequest` is the durable mutable projection of a
pending request; resolution creates one immutable `HumanReviewRecord`. The
review is the commit point. Both objects are persisted independently of the
event timeline, and every decision binds `request_id` plus `evidence_digest`.
Restart recovery leaves the Run in `awaiting_user_input`, reconstructs the
pending request from storage, and continues the same Run after resolution.
Recovery repairs either half of the request→required-event and
review→resumed-event commit windows. Resume admission is serialized per Run,
so concurrent identical retries append one resumed event and start one
continuation; a retry after an event-append failure completes the same review.

The four HIL kinds are `permission`, `semantic_review`, `data_review`, and
`conflict_resolution`. Stable `review_type` values refine data scenarios without
growing `prompt_kind`. Permission decisions remain `approve` / `reject`; review
decisions are `accept` / `correct` / `reject` / `skip`. One Run has at most one
blocking request, while one request may batch many review items.
V1 resolves one immutable decision for the whole batch; `correct` carries a
mapping/point keyed structure for item-specific corrected values. Mixed
accept/reject/skip decisions are deferred until the domain contract can
represent more than one immutable action without UI-only state.

Confidence remains an explainable `high` / `medium` / `low` classification, not
an uncalibrated probability. Its components are source, extraction, mapping,
cross-source consistency, and human-review state. A conservative weakest-link
evaluator derives the level and `requires_human_review`; adapters cannot set the
latter directly. Official deterministic channels may use batch defaults with
sparse record overrides. VLM, LLM, OCR, and semi-structured extraction require
record-level reasons.
Dataset release counts batch defaults only over final integrated
source-of-record rows, after deduplication/conflict selection, and asserts that
the effective confidence count equals the primary row count.

Human acceptance resolves a policy gate but does not by itself increase
evidence reliability. Corrections retain original values and add review and
transform provenance. Validation stays orthogonal and uses a versioned
`ConfidenceGatePolicy` to decide whether unresolved review or low-confidence
primary data blocks publication.

The first implemented review policies cover proposed field mappings, unknown
unit conversions, and low-confidence VLM chart points. The frontend uses a
single shadcn batch-review surface and shows confidence distributions, reasons,
review states, evidence records, and provenance drill-down.
Registered safe linear `UnitConversionRule` formulas execute automatically;
unregistered units require structured human correction. DashScope VLM calls
always pass per-invocation credential permission HIL before network access.
Strict release Profiles fail closed when the confidence artifact is absent.

## Consequences

- A host restart cannot lose a pending blocking review or apply a decision to a
  changed evidence snapshot.
- Event replay remains the task timeline, while HIL domain storage owns pending
  and resolved review state.
- Review completion and confidence level can move independently; validation is
  the only publication decision.
- Existing non-domain prompts such as plan confirmation remain a compatibility
  path with exact unresolved request matching, but cannot masquerade as formal
  data review.
- Cross-source consistency does not gain evidence weight until source lineage
  can establish independence; mirror agreement is not counted as another vote.
