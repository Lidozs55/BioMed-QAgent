# ADR-032: Generic multi-table validation is structural and fail-closed

## Status

Accepted

## Context

Manifest 2.0 can describe several canonical tables and explicit relations, but a
contract-valid manifest does not prove that the table bytes match their schemas,
that keys satisfy the declared relations, or that an Agent workspace file did
not bypass trusted Dataset Core operations. At the same time, a generic gate
must not absorb family measurement vocabularies, unit conversions, confidence
thresholds, or HIL publication policy.

## Decision

1. Add a generic multi-table validation module after assembly and before a
   family release decision. It checks ordered headers and row widths, supported
   primitive data types, nullability, non-null unique primary keys, foreign keys,
   declared cardinality, required/allow-empty table policy, and exact candidate
   table/relation references.
2. A table is readable only through a successful native Core table-operation
   result. The gate reparses the operation result, binds task/build identity,
   requires one relative-path file receipt, resolves the real path below the
   trusted root, rejects Agent workspace/forbidden roots, and verifies file size
   and SHA-256 before scanning. Absolute paths, traversal, legacy read-only
   checkpoints, direct Agent origins, and receipt drift fail closed.
3. Each table declares non-empty provenance and confidence refs. Their disjoint
   union must exactly equal the candidate refs; an unowned or missing evidence
   ref rejects the candidate.
4. Family policy declares source/output pairs for relation and unit tokens. The
   generic gate requires all schema-marked relation/unit token fields to be
   covered and verifies byte-exact token equality, preserving values such as
   `<`, `>`, `=`, and original unit strings. It does not decide whether a token
   or unit is scientifically valid or whether a conversion is equivalent.
5. `profile_defined` relation missing policy fails closed unless the family
   resolves it. Low-confidence thresholds, blocking HIL, measurement semantics,
   vocabulary admission, unit conversion, and normalization remain family
   Validation Profile responsibilities.

## Consequences

- B5 family modules can reuse one deterministic structural/relation gate while
  retaining their own scientific semantics and release policy.
- B2W must supply the build-owned trusted root and Agent workspace/forbidden
  roots when it wires the module; omitting forbidden roots is a validation
  failure rather than a permissive default.
- This module alone does not create a publication capability. Family assembly,
  profile evaluation, provenance/confidence artifacts, and Publisher wiring
  remain required before a family can enter the production registry.
