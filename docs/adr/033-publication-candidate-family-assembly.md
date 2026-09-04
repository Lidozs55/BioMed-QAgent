# ADR-033: Core-only Publication Candidates and Family Assembly

## Status

Accepted

## Context

Manifest 2.0 can describe several related tables, and operation result manifests
can bind committed Core outputs to dependency closures. The runtime still needs a
family-owned step between integration and validation that selects those outputs
without allowing an Agent path, workspace file, or publisher family branch to
become a trusted publication input.

Expression integration already produces one primary table. Renaming that
operation to assemble would erase its merge semantics and would not provide a
handler boundary for future multi-table families.

## Decision

1. `PublicationCandidate` is a Core-only contract. Table and evidence payloads
   reference a committed `OperationResultManifest` by result ID, typed output
   kind, file receipt index, and file hash. External source inputs are referenced
   only by registered, content-addressed asset IDs. The candidate contains no
   file path field and is not an Agent input DTO.
2. A family assembler receives task/build identity, family/schema semantics,
   committed Core result manifests, and registered asset IDs. It deterministically
   emits the candidate; its ID is a canonical digest of the complete candidate
   body.
3. The expression assembler preserves the existing `integrate` operation and
   wraps its `integrated_table` result as one required primary table. It requires
   the registered asset set to equal the integration result dependency closure.
4. Family assembly is exposed through a handler registry. A family without a
   registered assembler handler cannot construct an assembly capability. Family
   admission into the production runtime remains blocked until the rest of its
   canonicalization, validation, provenance, confidence, publisher wiring, and
   tests are complete.
5. Runtime topology, checkpoint versioning, validation, and publisher wiring are
   a separate task (`TASK-048-B2W`). This decision adds no Agent-defined node,
   generic DAG, or dynamic workflow.

## Consequences

- Future multi-table families can own table/relation selection without adding
  family conditionals to the publisher.
- Candidate consumers must resolve every result/file receipt inside the Dataset
  Core and verify its hash before use; a workspace path cannot be adapted into a
  candidate reference.
- Existing expression publication layout remains unchanged until B2W connects
  the fixed `integrate -> assemble -> validate -> publish` skeleton.
- Handler presence is necessary but not sufficient for production family
  admission, preventing registry-only declarations from advertising false
  capabilities.
