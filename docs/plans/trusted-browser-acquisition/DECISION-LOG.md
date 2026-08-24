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

## 2026-08-24 / D-019

- Decision: Add an explicit `parseCarrier` adapter entry point; preserve
  source-only behavior of the existing `parse` method.
- Reason: Browser formalization produces a carrier-role receipt. Re-labeling it
  as source would weaken role semantics and make provenance ambiguous.
- Status: implemented; existing registered-table and browser focused tests pass.

## 2026-08-24 / D-020

- Decision: Browser carrier parsing requires exact `resolveCoreAcquired` provenance
  and writes only task build staging output until OperationResult admission.
- Reason: A registered carrier without Core acquisition provenance must not be
  parsed into a formal result; parser success is not publication authority.
- Status: implemented and focused-verified.

## 2026-08-24 / D-021

- Decision: Browser carrier parser output is represented as a native
  `OperationResultManifest` with `operation_kind=parse` and
  `output_kind=parsed_table`; it is not a publication candidate.
- Reason: Existing OperationResult contracts provide the correct immutable hash,
  dependency, schema, and task/build closure before family validation.
- Status: implemented and focused-verified.

## 2026-08-24 / D-022

- Decision: Add an explicit deterministic `parsed_table` to `integrated_table`
  operation before dynamic-family materialization; never relabel parser output.
- Reason: Dataset family assembly requires integrated-table semantics, while media
  parsing alone does not establish those semantics. The integration copy is
  rehashed and references the parsed manifest in dependency closure.
- Status: implemented and focused-verified; family publication integration pending.

## 2026-08-24 / D-023

- Decision: Require every projection-selected table in the browser family bridge
  to have an integrated OperationResult; no missing-table or empty-table inference.
- Reason: Generic browser acquisition must not turn one successfully parsed
  source into an incomplete or fabricated family publication.
- Status: implemented; server/contracts typecheck and lint pass.

## 2026-08-24 / D-024

- Decision: Add opt-in live browser smoke tests for NCBI E-utilities and MGnify;
  default CI remains network-free and skipped live tests never count as pass.
- Reason: Validate real public database download behavior without coupling normal
  tests to external availability or creating a publication in the smoke path.
- Status: both live downloads passed with HTTP 200 and verified SHA-256 receipts.

## 2026-08-24 / D-032

- Decision: browser parser/integration results use an explicit `BrowserPublicationHandoff`; they are not cast to `SubmitDynamicFamilyBuildResult` or treated as transform receipts.
- The handoff binds task/run/build/generation, preflight, selected projection tables, integrated result manifests, source acquisition provenance, browser evidence digests, and a Core-only trusted root.
- Every selected table must carry integrated data plus provenance and confidence evidence; missing closure fails closed.
- Publication adapter work remains separate from this handoff contract.

## 2026-08-24 / D-025

- Decision: Browser family materialization requires non-empty provenance and
  confidence result refs for every projection-selected table.
- Reason: The previous empty arrays could never satisfy ProductAssessment and
  would hide a trust gap between browser evidence and a publishable candidate.
- Status: implemented and focused-verified.

## 2026-08-24 / D-026

- Decision: Generate browser table provenance/confidence manifests only from
  explicit source evidence manifests, with upstream IDs and asset closure.
- Reason: ProductAssessment must be able to trace an integrated table back to
  browser evidence; empty or inferred evidence is not acceptable.
- Status: implemented and focused-verified.

## 2026-08-24 / D-027

- Decision: Carrier parser execution accepts only recipe ID/version and a
  Core-owned resolver; adapter ID and parser version are never caller-selected.
- Reason: Passing parser identity from Agent input would bypass PROMOTED recipe
  authority and undermine the trusted browser boundary.
- Status: implemented and typecheck/lint verified.

## 2026-08-24 / D-028

- Decision: A formalization HIL accept followed by Core verification failure
  transitions the persisted proposal to `failed`, preserving the exact error.
- Reason: HIL approval of retrieval evidence is not proof that carrier
  registration, recipe resolution, or hash closure succeeded.
- Status: implemented; 37 focused browser/formalization/store tests and lint pass.

## 2026-08-24 / D-029

- Decision: Browser publication handoff is a distinct execution variant rather
  than a cast to `SubmitDynamicFamilyBuildResult`.
- Reason: The existing publication path reads transform receipt fields that do
  not exist for browser parser execution. A cast would fabricate transform
  provenance and weaken auditability.
- Status: handoff validator implemented and focused-verified; publisher variant
  integration remains pending.
