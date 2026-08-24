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
- Status: completed; commits `b86949e1` and `5ef46fae`.

## 2026-08-24 / D-010

- Decision: Persist browser evidence at `<taskRoot>/state/browser-acquisition-evidence.json`
  using atomic replacement and re-parse/re-digest on read.
- Reason: Browser bytes must survive restart with a verifiable receipt, while an
  identity collision or corrupted state must fail closed.
- Status: completed in `5ef46fae`.

## 2026-08-24 / D-011

- Decision: Add `browser_acquisition_formalization` as a distinct HIL review type
  and expose evidence/source/locator IDs in its subject.
- Reason: Formalization approval is not publication acceptance and needs a
  dedicated closed wire contract.
- Status: completed in the current implementation slice.

## 2026-08-24 / D-012

- Decision: `propose_browser_acquisition_formalization` creates a persisted
  proposal and blocking HIL only; it never parses, registers, or publishes.
- Reason: Core must remain authoritative and the first HIL boundary must not
  accidentally become a publication shortcut.
- Status: completed in the current implementation slice; parser formalization
  and runtime continuation remain later phases.

## 2026-08-24 / D-013

- Decision: Core formalization is implemented as a service adjacent to
  `CoreAcquisitionRuntime`, not inside the browser tool.
- Reason: Only Core may register carrier assets and write acquisition provenance;
  the browser tool remains receipt/proposal/HIL-only.
- Status: focused tests pass; runtime HIL continuation remains pending.

## 2026-08-24 / D-014

- Decision: Carrier registration rechecks the persisted receipt's source ID,
  relative path, exact SHA-256, and byte size before writing provenance.
- Reason: Content-addressed browser evidence alone does not prove the current
  task-owned file has not drifted since retrieval.
- Status: focused formalization tests pass.

## 2026-08-24 / D-015

- Decision: Invoke `BrowserFormalizationService` immediately after the dedicated
  HIL returns `decision.action === "accept"`; reject/other actions return without
  carrier registration.
- Reason: Existing `DurableHILGate.requestHIL` already provides durable request,
  resolution, and restart behavior; a duplicate continuation mechanism would
  create competing state machines.
- Status: implemented and verified with focused tests.

## 2026-08-24 / D-016

- Decision: Reuse `RegisteredTableRegistry` as the parser authority and add a
  generic browser recipe registry that resolves only PROMOTED recipes.
- Reason: Existing production parser registration already forbids dynamic import,
  eval, and Agent-provided parser code. A second parser registry would weaken
  that boundary.
- Status: implemented; 37 focused browser/formalization/store tests pass.

## 2026-08-24 / D-017

- Decision: Do not add a generic parser-to-publication shortcut. A recipe may
  parse a carrier only when an explicit FamilySpec/schema/table binding exists;
  OperationResult, B3, ProductAssessment, and publication remain Core-owned.
- Reason: Media parsing is not dataset semantics. Unknown databases need a
  promoted recipe plus an explicit family contract, not inferred publication.
- Status: enforced by the current proposal/schema checks; execution remains pending.

## 2026-08-24 / D-018

- Decision: Store `schema_ref` on browser recipe registration rather than
  extending the generic `WorkflowRecipeRef` with browser-only fields.
- Reason: Existing workflow recipe contracts are shared by other acquisition
  paths; browser parser schema binding is a registry concern and must not widen
  unrelated wire DTOs.
- Status: implemented and focused-verified.
