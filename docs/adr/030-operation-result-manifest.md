# ADR-030: Versioned Operation Result Manifests

## Status

Accepted

## Context

The fixed Dataset Core skeleton already writes operation attempts and output
checkpoints, but their files are runtime-internal and do not provide a stable
handoff for long-running acquisition, assemble, derive, validation, or publish
work. Reusing a checkpoint must be invalidated when input assets, parameters, or
implementation code change, and an incomplete write must never be treated as a
successful result.

## Decision

1. Each completed operation may emit an `OperationResultManifest` containing the
   operation kind, attempt identity, input/parameter/implementation/output
   digests, typed output kind, output file receipts, dependency closure, and an
   atomic `committed` receipt.
2. Result manifests accept only Core-owned relative file receipts. Workspace
   absolute paths, traversal, missing receipts, and output kind mismatches are
   rejected. `integrate` remains a fixed operation; `assemble` and `derive` are
   explicit fixed slots, not Agent-defined DAG nodes.
3. A result is reusable only when its complete dependency closure matches: input
   asset IDs/digests, upstream result manifests, parameter digest, and
   implementation digest. A changed member invalidates downstream reuse.
4. Legacy checkpoints may be read in `legacy_read_only` migration mode with an
   explicit path and migration timestamp. They cannot be presented as a native
   committed result or used as a publication receipt.
5. Publication operations must produce `publication_manifest`; publish replay
   is not a valid operation-result shortcut.

## Consequences

- A5I can persist operation results atomically and bind checkpoint reuse to a
  versioned result contract without introducing a generic DAG.
- B2W/B6W can consume stable candidate/derive result references after runtime
  wiring is merged.
- Existing checkpoint tests remain valid; old files are compatibility inputs,
  not new trusted evidence.
