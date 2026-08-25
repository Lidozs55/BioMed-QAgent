# Trusted Browser Acquisition

Status: Proposed, review-revised
Branch: `feat/trusted-browser-acquisition`

## Goal

Provide a general route for an unfamiliar public biomedical database or web-hosted
source to become a trusted formal carrier without treating browser/workspace
bytes as publication artifacts by default.

```text
Agent discovery
  -> guarded browser navigation/download
  -> Host-persisted evidence + byte/hash receipt
  -> Core-owned browser evidence acceptance proposal
  -> one browser evidence acceptance HIL
  -> fixed recipe/provider formalization
  -> preflight-bound registered carrier
  -> Dataset Core validation/OperationResult
  -> ProductAssessment and deterministic publication checks
  -> immutable Publication/Artifact API
```

Browser access remains a guarded acquisition mechanism. It is not a sandbox,
scientific validator, publication authority, or a way to bypass Core provider
identity.

## Non-goals

- No sample-specific Gold9/Gold10 production branch.
- No Agent-controlled arbitrary parser, DAG, validator, publication, or provider
  identity.
- No direct promotion of browser responses, workspace paths, or downloaded files
  into Artifact API publications.
- No weakening of fixed-provider acquisition or registered-asset hash checks.
- No authentication bypass, credential scraping, or persistent browser sessions.
- No isolated execution backend or ADR-039 change.

## Phase 0: Contracts and Threat Model

1. Define versioned `BrowserAcquisitionEvidence` with requested URL, every
   redirect hop, final URL, status/media type, retrieval time, byte size,
   SHA-256, browser/client policy revision, task/run ownership, and Host-persisted
   `SourceAsset` and `DownloadAttempt` IDs. Update the browser tool to persist
   final URL and redirect chain; Agent-proposed text is never an evidence receipt.
2. Register a fixed Core carrier identity such as `browser.snapshot.v1` with a
   stable implementation digest and explicit revision/provenance rules. The
   formal request identity must include evidence digest, fixed carrier identity,
   source locator, and browser policy revision.
3. Define Core-owned `BrowserAcquisitionProposal`. The Agent may propose source
   metadata, locator, intended role, registered recipe reference, media type, and
   FamilySpec binding. It cannot choose provider implementation, parser code,
   trust status, or publication policy.
4. Persist proposal state in the task event stream and a rebuildable reducer:
   `draft`, `hil_pending`, `accepted`, `rejected`, `formalizing`, `formalized`,
   `failed`. Every transition binds proposal/evidence/recipe/provider digests,
   task/run/build/generation, and source byte hash. Missing state or cross-Host
   continuation fails closed.
5. Add a closed-contract HIL type named `browser_evidence_acceptance`, with
   explicit accept/reject actions and a snapshot covering the exact evidence
   digest(s), source/provenance, bindings, promoted recipe, and intended
   publication scope. Acceptance authorizes only the deterministic Core pipeline
   for that exact closure; it does not authorize changed inputs or arbitrary
   code. Keep `browser_acquisition_formalization` readable for recovery of old
   requests, but do not create it for new browser proposals.
6. Fail closed on redirect-host changes, non-public/authenticated pages, URL
   credentials, mutable URLs without Host snapshots, unsupported media, duplicate
   or ambiguous evidence, digest drift, stale generation, missing/unpromoted
   recipes, and equal bytes substituted under another provenance identity.

## Phase 1: Core Formalization Boundary

1. Add a Host-persisted browser evidence store/receipt writer behind
   `download_from_page`. It records final URL, redirect chain, response metadata,
   exact bytes, SourceAsset, DownloadAttempt, and evidence digest before proposal.
2. Add a Core service that re-hashes the stored bytes, validates the receipt,
   resolves the fixed `browser.snapshot.v1` carrier, checks exact request
   identity, and rejects Agent-supplied provider or implementation digests.
3. Define recipe registration/promotion authority, storage, exact-key lookup,
   parser implementation digest, supported media types, and revision identity.
   Agent requests a recipe by ID/version but cannot submit parser source, paths,
   or office-document parsing code.
4. Enforce ordering:

   ```text
   evidence receipt -> browser evidence acceptance HIL -> preflight/descriptor -> fixed parser
   ```

   Parser execution is forbidden while browser evidence acceptance is
   pending/rejected. Preflight must include the accepted evidence digest, fixed
   carrier identity, recipe digest, source binding, and the tuple must be in the
   final submission digest.
5. Run the fixed parser bounded and cancellably. Its output enters private
   quarantine, then existing closed-world OperationResult admission and output
   hash checks.
6. Immediately before parser use, reload proposal state, re-verify evidence
   digest, and re-hash bytes. Any TOCTOU drift fails closed. Register resulting
   carriers/extraction assets with source receipt, evidence digest, parser digest,
   request identity, and provider revision evidence.
7. Make formalization retry-safe: reuse binds evidence, recipe, provider, task,
   build, generation, and source hash; mismatches re-execute or fail closed.

## Phase 2: Agent and HIL Integration

1. Add a generic proposal tool after browser navigation/download. It cannot
   publish, register provider records, mark evidence trusted, or choose parser
   implementation.
2. Core creates one browser evidence acceptance HIL containing
   URL/redirects/final URL, byte/hash, media type, source identity, promoted
   recipe, intended bindings, risks, and intended publication scope. Resolve
   only the valid decision object for this review type. Rejection/expiry remains
   fail-closed.
3. Permit one blocking HIL at a time. Browser evidence acceptance resolves before
   parser execution; no redundant publication HIL is created for the same
   accepted closure. Same-Host restart may resume exact persisted state;
   cross-Host unresolved HIL fails closed.
4. Return bounded diagnostics distinguishing fetch failure, formalization
   rejection, recipe/parser failure, schema/topology failure,
   identity/provenance mismatch, and publication assessment failure.

## Phase 3: Tests

1. Add deterministic HTTP fixtures for redirects, final URL capture, content
   type, hash drift, mutable URL, unsupported media, duplicate evidence, and
   cross-host redirect policy.
2. Add live guarded smoke tests for at least two real public sources (including
   Gold9/Gold10 gaps) using the same browser path. Record bytes/hash and skip with
   a precise environment reason when prerequisites are unavailable; skipped is
   never publication success.
3. Add a generic Core-registered fixture recipe end-to-end through browser
   evidence, formalization HIL, quarantine, OperationResult, B3, ProductAssessment,
   publication, and Artifact API hash verification.
4. Add negative tests proving browser/workspace bytes alone cannot publish,
   formalization HIL cannot authorize publication, Agent cannot choose provider
   or parser identity, and equal bytes with different provenance do not reuse.
5. Add restart, TOCTOU, cancellation, stale-generation, duplicate-evidence,
   retry, unresolved-HIL, and cross-Host fail-closed tests.

## Phase 4: Source Enablement

Only after the generic route is stable, add registered recipe/provider adapters
for actual source formats. These are small adapters to the generic route, not
Gold-specific production branches. Gold9/Gold10 are acceptance fixtures, not
hardcoded routing logic. Binary office media types require explicitly promoted
parsers; CSV/JSON assumptions are insufficient.

If browser execution cannot run because Playwright, network, authentication, or
OS prerequisites are unavailable, stop browser work at generic contracts/tests
and use a separate branch for fixed API/provider adapters. Do not mix an
environment workaround into the formalization boundary.

## Review Record

Independent `deepseek-v4-flash` review identified and this plan resolves:

- fixed browser provider identity and evidence digest in acquisition/preflight;
- Host persistence of final URL/redirect chain and re-hash after HIL;
- closed HIL enum/prompt kind and one-blocking-HIL sequencing;
- proposal state/restart persistence and cross-Host fail-closed behavior;
- recipe promotion authority and binary-media parser requirements;
- separation of generic browser route from Gold-specific adapters;
- one-time browser evidence acceptance instead of redundant stage approvals.

Main-thread self-review: this plan preserves Core authority, does not let browser
bytes become formal by themselves, uses one evidence-bound acceptance closure,
rejects Agent-supplied trust/provider/parser identity, and keeps preflight,
identity, quarantine, B3, ProductAssessment, recovery, and Artifact API gates. The first
implementation slice must be contracts/evidence persistence and negative tests;
no source-specific adapter may land before that slice passes.

## Gates

- Plan review and self-review complete before production implementation.
- Focused contract/runtime/browser tests after each phase.
- No full suite unless final cross-layer integration or release freeze requires it.
