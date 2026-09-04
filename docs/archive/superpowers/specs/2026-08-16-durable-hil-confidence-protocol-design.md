# Durable HIL and Confidence Protocol Design

**Date:** 2026-08-16
**Status:** Approved for implementation
**Scope:** Runtime HIL, Dataset Core confidence, validation/profile policy, and review UI

## Goal

Close the formal protocol gap between durable human-in-the-loop (HIL) requests,
evidence confidence, and release validation without replacing the current TS Host,
Pi Agent, or TS Dataset Core architecture.

The three concepts remain deliberately separate:

- **Confidence** describes the strength and limitations of the evidence for a
  record or batch.
- **HIL** resolves a concrete permission, semantic, data, or conflict question
  that cannot be decided safely by deterministic rules.
- **Validation** applies a profile-owned release policy to the completed build.

Low confidence does not itself mean validation failure, and human approval does
not itself raise confidence to high.

## Durable HIL domain model

`HILRequest` is the durable mutable lifecycle object. It identifies the task,
run, optional build, category, review type, blocking policy, reviewed subjects,
review items, policy reference, and an `evidence_digest` bound to the exact
evidence snapshot shown to the reviewer.

`HumanReviewRecord` is immutable. It records one structured decision:

- permission: `approve` or `reject`;
- data/semantic/conflict review: `accept`, `correct`, `reject`, or `skip`.

Corrections are JSON values and are interpreted only by the policy that created
the request. Runtime never executes arbitrary correction expressions.

One run may have at most one unresolved blocking HIL request in V1. A request may
contain multiple `review_items`, enabling batch review instead of repeated
dialogs.

## Persistence and recovery

The task event log remains the authoritative runtime timeline. HIL domain
objects are persisted under the task state directory because event payloads are
not a suitable mutable query model.

The protocol is:

1. Persist `HILRequest`.
2. Append `user_input_required` with a request snapshot.
3. Reduce the run to `awaiting_user_input`.
4. On resume, validate task/run/request/evidence digest and decision shape.
5. Persist immutable `HumanReviewRecord` and resolve the request.
6. Append `user_input_resumed`.
7. Wake a live waiter or reconstruct the continuation from the durable request
   and runtime checkpoint after restart.

The in-memory waiter map is only an optimization. It is never the source of
truth. Startup recovery preserves `awaiting_user_input` runs rather than
interrupting them. Repeated identical resume requests are idempotent; stale or
conflicting decisions are rejected.

## HIL categories and policy

The stable categories are `permission`, `semantic_review`, `data_review`, and
`conflict_resolution`. Review scenarios are expressed through structured
`review_type`, not by continually expanding event `prompt_kind`.

Initial Dataset Core policy covers:

- proposed/string-similarity field mappings;
- unregistered unit conversions;
- low-confidence VLM extraction affecting primary data.

Deterministic registered rules execute automatically. An ambiguous case with no
deterministic rule produces HIL rather than another model guess. Advisory review
may be recorded without pausing; blocking review pauses the run.

## Confidence model

Confidence remains categorical: `high`, `medium`, or `low`. It is not a
probability.

The evidence components are:

- source reliability;
- extraction reliability;
- mapping reliability;
- cross-source consistency;
- human review state.

Validation status is not a confidence component. `requires_human_review` is a
derived result and is not supplied independently by adapters.

The evaluator uses an explainable conservative policy: a critical low component
produces low, otherwise any medium produces medium, otherwise all applicable
high components produce high. Explicit caps apply to nondeterministic extraction
and unresolved proposed mappings. Accepting a low-confidence value records
`human_review_state=accepted` but does not manufacture stronger evidence.

Deterministic structured channels may store batch defaults with sparse record
overrides. VLM, LLM, OCR, and semi-structured web extraction require per-record
confidence reasons.

Complex source-lineage independence scoring is intentionally outside V1.
Cross-source consistency defaults to `not_checked`; mirror agreement never adds
independent evidence votes.

## Validation and publication

`ValidationProfile` owns a `ConfidenceGatePolicy`. It can require zero pending
blocking reviews, set minimum primary-field confidence, restrict low-confidence
primary records, cap their fraction, and require review for nondeterministic
channels.

Confidence evaluation occurs before validation. HIL corrections are recorded in
provenance and confidence is recomputed. Validation then decides whether the
build meets its profile. Publisher behavior remains gated by validation success.

Statistical anomaly analysis remains separate from evidence confidence and is
reported independently.

## Frontend

The existing user-input dialog becomes a structured batch review surface using
the repository's shadcn components and semantic tokens. Permission requests keep
approve/reject controls. Data review supports item selection plus accept,
correct, reject, and skip actions, always submitting the evidence digest.

Build results expose confidence distribution, reason summaries, review state,
and links into confidence/provenance audit artifacts. The UI visualizes protocol
state; it does not decide confidence or release thresholds.

## Non-goals

- Numeric probability scores or weighted averages.
- Cell-level confidence duplication.
- Arbitrary model-generated unit conversion expressions.
- Complex cross-source independence inference in V1.
- Treating human acceptance as evidence upgrade.
- A general-purpose conversational pause mechanism outside formal Runtime HIL.
