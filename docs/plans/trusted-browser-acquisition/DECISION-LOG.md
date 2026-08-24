# Decision Log: Trusted Browser Acquisition

All entries are append-only. This log records autonomous decisions, approvals,
risks, and verification results for later audit.

## 2026-08-24 / D-001

- Decision: Work on dedicated branch `feat/trusted-browser-acquisition`.
- Reason: Browser trust formalization crosses contracts, Host runtime, acquisition,
  HIL, recovery, and publication boundaries; it must not mix with identity,
  preflight, or source-specific branches.
- Approval: User delegated autonomous decisions while unavailable.
- Status: accepted.

## 2026-08-24 / D-002

- Decision: Preserve the existing rule that browser/workspace bytes are not
  formal carriers by themselves.
- Reason: Core must remain authoritative for provider identity, parser identity,
  OperationResult, ProductAssessment, and Publication.
- Risk: Unknown databases remain blocked until a Core-promoted recipe/provider
  exists; this is accepted as fail-closed behavior.
- Status: accepted.

## 2026-08-24 / D-003

- Decision: Add a generic browser formalization route before Gold9/Gold10 adapters.
- Reason: Avoid sample-specific production code and make the route reusable for
  any unfamiliar public source.
- Status: accepted.

## 2026-08-24 / D-004

- Decision: Require a distinct browser-acquisition formalization HIL before any
  fixed parser runs; it cannot satisfy publication acceptance.
- Reason: Browser evidence establishes retrieval facts, not scientific validity
  or publication trust. Existing one-blocking-HIL and evidence-bound semantics
  require explicit sequencing.
- Status: accepted.

## 2026-08-24 / D-005

- Decision: Bind browser evidence digest, final URL/redirect chain, fixed browser
  carrier identity, recipe digest, task/run/build/generation, and source bytes
  into the formal request and preflight/submission identity.
- Reason: Prevent TOCTOU, equal-bytes/different-provenance substitution, stale
  replay, and HIL approval being detached from the bytes later parsed.
- Status: accepted.

## 2026-08-24 / D-006

- Decision: Host persists final URL and redirect chain at browser download time;
  an Agent-proposed receipt is never sufficient.
- Reason: Existing browser tool stages content-addressed bytes but loses redirect
  metadata and does not create a Core registration/provenance record.
- Status: accepted.

## 2026-08-24 / D-007

- Decision: Promoted parser recipes are the only parser authority; Agent cannot
  submit parser source, arbitrary paths, or provider/implementation digests.
- Reason: Generic browser support must not become arbitrary code execution or an
  implicit trust bypass. Binary office formats need explicit promoted parsers.
- Status: accepted.

## 2026-08-24 / D-008

- Decision: If browser prerequisites/authentication/network cannot run, use a
  separate fixed-provider/API adapter branch rather than mixing environment
  workarounds into this trust boundary.
- Reason: Keeps browser capability failures diagnosable and preserves branch
  ownership. Fixed providers can be validated without Playwright.
- Status: accepted.

## 2026-08-24 / D-009

- Decision: First implementation slice is contracts, receipt persistence, and
  negative tests; no Gold-specific adapter is allowed in this branch yet.
- Reason: Establish the trust boundary and test fail-closed behavior before
  adding real-source coverage.
- Status: in progress.
