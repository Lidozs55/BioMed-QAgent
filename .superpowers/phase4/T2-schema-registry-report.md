# Pi Migration Phase 4 — T2 Report: Schema Registry (TS)

Plan: `docs/BioMed-QAgent_Pi_Migration_Plan.md` §20 Phase 4, step 2 (Schema Registry).
Branch: none yet — uncommitted on shared `main` (see Constraints).

## Summary

Ported the versioned Schema Registry and its two built-in expression schemas to TypeScript,
mirroring `backend/app/datasets/schema_registry.py` and the field data in
`backend/app/pipeline/stages/artifact_build/columns.py` (`_FIELD_DESCRIPTIONS`).

## What was built

| Area | Files |
| --- | --- |
| Field tables + inference helpers | `server/src/dataset/schema/fields.ts` — `EXPRESSION_FAMILY_FIELDS` (22), `PROBE_EXPRESSION_FIELDS` (21), primary keys, `PROBE_FIELD_META` (4 overrides), `FIELD_DESCRIPTIONS` (22 entries, transcribed verbatim from Python), `inferSemanticRole` / `inferOntology` |
| Registry + builders | `server/src/dataset/schema/registry.ts` — `SchemaRegistry` (register/contains/get/list, Python semantics), `buildGeneExpressionSchema`, `buildProbeExpressionSchema`, `createDefaultSchemaRegistry` (mirrors `_build_schema_registry`), `schemasDeepEqual` |
| Module surface | `server/src/dataset/schema/index.ts` |
| Parity checks (vitest-free) | `server/tests/schema-registry-parity.ts` |
| Vitest suite | `server/tests/dataset-schema-registry.test.ts` (6 tests) |

## Verification evidence

- Strict typecheck (harness, incl. schema module + new tests): exit 0.
- `tsc` compile: exit 0.
- Vitest-free parity (`runner-schema.mjs`): gene parity / probe parity / registry semantics — all pass.
- Step-1 contract parity + invariants still pass (no regression).
- Real vitest 3.2.7: 32/32 (26 contracts + 6 schema registry).
- ESLint (server config, type-aware) on all `src/dataset/**` + test files: 0 warnings.

Parity details:

- **Gene schema**: `buildGeneExpressionSchema()` deep-equals the authoritative
  Python-generated golden `tests/migration/golden/succeeded/artifacts/schema.json`
  (22 fields, exact descriptions / semantic roles / required flags / unit policies).
  This proves the ported `FIELD_DESCRIPTIONS`, role inference and field ordering are
  byte-for-byte faithful to Python.
- **Probe schema**: `buildProbeExpressionSchema()` asserted against every invariant in
  `backend/tests/test_schema_registry.py` (21 unique fields, correct order, PK
  `(probe_id, platform_id, sample_id)` required, `value.unit_policy =
  "declared_per_record"`, meta roles/types, no gene primary columns, optional fields
  exactly `[source_sample_alias]`, parses through the contracts parser).
- **Registry semantics**: register/get/contains/list, conflicting duplicate rejected,
  identical duplicate idempotent, unknown `get` raises, initial load, default registry
  contains both builtins.

## Known gap (environment-blocked)

A Python-side probe-schema fixture could not be generated this round: running the backend
interpreter is blocked by the sandbox and the approval reviewer is returning 503. The gene
golden covers the shared field-data transcription; the probe-specific data (field list, PK,
meta, granularity) is verified by the Python-test invariants above. To close the gap once
Python execution is possible:

```bash
cd backend
python -c "import json; from app.datasets.schema_registry import build_probe_expression_schema as b; print(json.dumps(json.loads(b().model_dump_json()), indent=2))" \
  > ../tests/migration/golden/schema_registry/gene_expression.probe_long.v1.json
```

Then add a fixture comparison in `checkProbeSchemaParity`.

## Constraints (unchanged from T1)

- `pnpm install` still blocked (network + approval 503); real workspace gates pending.
- Worktree/branch + commit still pending (approval outage); diff uncommitted on shared `main`.
- Stray untracked `packages/contracts/src/*.js` build artifacts still to be deleted before commit.
- Commonly `[TASK]`/`[DONE]` still not posted (Commonly MCP 503).

## Next steps (Phase 4 step 3)

SourceAsset (TS): the `FileAsset` / `SourceLocator` base already lives in the contracts
module; step 3 adds the `SourceAsset` subclass (source_assets path prefix, exactly-one
download/derivation lineage, self-reference and `generated_by_step_id` rules).