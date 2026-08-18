# ADR-034: Fixed Deterministic Derive Slot and Registered Algorithm Provenance

## Status

Accepted

## Context

Some trusted publication families need computed records that are not source records.
Examples include distances between PDB chains/atoms and mappings produced by sequence
alignment. Treating these rows as retrieved source values loses the computation's
inputs, reference version, parameters, and reproducibility boundary. Conversely,
allowing an Agent to submit code or an arbitrary graph of compute nodes would move
scientific computation outside the deterministic Dataset Core and make acceptance and
checkpoint identity unbounded.

The existing operation-result contract already has a `derive` operation kind and a
`derived_evidence` output kind. B6D must define the input and provenance boundary for
that operation without wiring it into the runtime plan.

## Decision

1. The Dataset Core exposes one fixed derive position, the `derive` slot. It is an
   optional operation in the server-owned fixed skeleton; it is not a user-defined
   node, edge, or general-purpose DAG.
2. A `DeterministicDeriveRequest` may reference only a registered, content-addressed
   SourceAsset or a committed Core operation result. It records the algorithm ID and
   version, implementation digest, JSON parameters, reference ID/version/digest,
   input digest(s), and output schema reference. Its identity digest covers all of
   those fields, so changing parameters, reference version, or input content changes
   reuse identity.
3. Algorithms are admitted only through the server-owned deterministic algorithm
   registry. The registry key is `algorithm_id@algorithm_version`, and a request's
   implementation digest must match the registered handler. Unknown algorithms,
   arbitrary code, file paths, dynamic dependencies, and Agent-provided handlers are
   rejected by the contract/registry boundary.
4. A successful result is a `DeterministicDeriveResultReceipt` with a content digest,
   fixed slot, output schema, and complete provenance. Provenance repeats the request
   identity, algorithm implementation, parameters, reference, input references, and
   output digest. Derived rows remain explicitly derived and cannot be represented as
   source records.
5. PDB distance and sequence alignment use this same contract. Their domain-specific
   parameters, reference versions, and output schemas remain algorithm/family-owned;
   no universal derived family or family-specific runtime branch is added here.
6. Runtime plan, cancellation/timeout, checkpoint, and publisher integration remain
   the separate A-owned TASK-048-B6W. This ADR and module do not change those files.

## Consequences

- Derive outputs can be recomputed and independently audited from immutable inputs and
  declared algorithm/reference identities.
- Cache/checkpoint consumers can use the request identity digest as a stable reuse key
  and must invalidate on input, parameter, reference, or implementation changes.
- Family modules may consume derived evidence only after their own schema, relation,
  validation, confidence, provenance, and publication wiring is complete.
- The registry is intentionally narrow: adding an algorithm requires trusted server
  implementation and versioned tests; it is not a plugin loader or workflow engine.
