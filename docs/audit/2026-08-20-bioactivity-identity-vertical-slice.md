# Bioactivity Identity Vertical Slice

## Selection

The first canonical evidence vertical slice is `bioactivity_identity`, informed by
one of the frozen non-expression cases but implemented as a reusable package
capability. It was selected after comparing the available Gold3-Gold6 shapes:

- the existing ChEMBL bioactivity path already has a trusted four-table Core
  projection and publication path;
- the missing identity closure is narrow and reusable: a receipt-backed PubChem
  compound identity and an explicit conflict-preserving crosswalk;
- exact identifier matching does not require automatic HIL;
- the same cross-reference semantics can be reused by target/structure products;
- Gold3 requires a much broader six-entity graph, Gold4 also requires structure
  derivation and more carrier closure, and Gold6 is currently blocked on real
  credential HIL.

## Implemented Capability

The slice preserves the legacy `activities`, `compounds`, `assays`, and `targets`
projection. When the fixed Core receives exactly one ChEMBL and one PubChem
carrier, it additionally produces:

- a separate `pubchem_cid` compound identity;
- an optional `compound_crosswalks` table;
- two strict crosswalk-to-compound relations;
- receipt/asset/locator/transform evidence in `match_evidence`;
- a `product_assessment.json` audit artifact;
- publishability gating requiring exact InChIKey identity, complete receipts,
  deterministic transform evidence, and hashed identity artifacts.

Conflicting InChIKeys preserve both identities but fail closed before Publisher.
Malformed PUG-REST envelopes, CID mismatch, missing receipt, duplicate identity,
workspace-origin inputs, and unsafe provider controls fail closed.

The fixed PubChem provider only constructs the official bounded PUG-REST property
endpoint. The fixed ChEMBL provider now builds a server-owned query from admitted
ChEMBL target/compound/activity-type identifiers instead of embedding a benchmark
source ID in production. Arbitrary URLs, paths, scripts, and query controls are
not accepted.

## Non-goals

- No Gold-specific production profile or identifier.
- No dynamic topology or general Canonical IR registry.
- No Agent or workspace CSV trust promotion.
- No fuzzy chemical matching, synonym resolution, or automatic HIL approval.
- No removal of the existing four-table ChEMBL compatibility output.
- No claim of strict Gold5 success. Frozen Gold inputs and same-commit evaluation
  remain unchanged; the strict aggregate remains 0/6 until a complete rerun
  proves task/run/build/publication/download/final-answer closure.

## Acceptance

Non-Gold fixtures verify ChEMBL-only four-table parity, exact identity publication
with five tables and artifact hash parity, conflict/malformed/CID/missing-receipt
fail-closed behavior, relation/FK validation, deterministic output, and semantic
assessment states (`publishable`, `validated`, `incomplete`).
