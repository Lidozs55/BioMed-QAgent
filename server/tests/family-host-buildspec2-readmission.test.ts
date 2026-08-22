/**
 * TDD contract for the BuildSpec 2.0 readmission resolver
 * (`server/src/dataset/build-spec-readmission`).
 *
 * The module does not exist yet: this file pins the assumed API surface and
 * behavior before implementation, so it intentionally fails to compile until
 * the module lands. No production source is touched.
 *
 * Assumed API (docs/plans/family-host/01 §5 Build wire versioning +
 * docs/plans/family-host/04 §2.3 Resolution):
 *
 *   resolveDatasetBuildProposal2(
 *     proposal: unknown,
 *     context: ReadmissionContext,
 *   ): ResolvedDatasetBuildSpec2
 *
 * The resolver strictly parses the proposal (proposal shape only, via the
 * @biomed/contracts parser), resolves every family/transform ref exactly
 * against the FamilyCatalog, and binds every source binding to exactly one
 * registered asset or result handle from the current generation. Any failure
 * throws BuildSpecReadmissionError with a family-catalog-compatible code:
 *
 *   invalid_proposal | invalid_reference | not_found | ambiguous_reference
 *   | cross_task_reference | stale_generation | execution_revoked
 *   | example_not_executable
 */

import { describe, expect, test } from "vitest";

import {
  parseDatasetBuildSpec2,
  parseResolvedDatasetBuildSpec2,
  stableStringify,
  type DatasetBuildProposal2,
  type ResolvedDatasetBuildSpec2,
  type ScopeQualifiedRef,
  type TransformScope,
  type TransformTrustStatus,
} from "@biomed/contracts";
import {
  createFamilyCatalog,
  type FamilyCatalog,
  type FamilyCatalogEntry,
} from "../src/dataset/family-catalog/index.js";
import {
  resolveDatasetBuildProposal2,
  BuildSpecReadmissionError,
} from "../src/dataset/build-spec-readmission/index.js";

/* ------------------------------------------------------------------ */
/* Fixtures (minimal)                                                  */
/* ------------------------------------------------------------------ */

const TASK_ID = "task-readmission-e2e";
const OTHER_TASK_ID = "task-readmission-other";
const CURRENT_GENERATION = 3;

const DIGEST = {
  family: "f".repeat(64),
  transform: "t".repeat(64),
  policy: "p".repeat(64),
  asset: "a".repeat(64),
  assetAlt: "b".repeat(64),
  result: "r".repeat(64),
  stale: "s".repeat(64),
};

const FAMILY_REF: ScopeQualifiedRef = {
  scope: "curated",
  id: "readmission-family",
  version: "2.0.0",
  digest: DIGEST.family,
};
const TRANSFORM_REF: ScopeQualifiedRef = {
  scope: "curated",
  id: "readmission-transform",
  version: "1.0.0",
  digest: DIGEST.transform,
};
const POLICY_REFS: ScopeQualifiedRef[] = [{
  scope: "system",
  id: "core-release-policy",
  version: "1.0.0",
  digest: DIGEST.policy,
}];

const ASSET_ID = `asset_${DIGEST.asset}`;
const ALT_ASSET_ID = `asset_${DIGEST.assetAlt}`;
const RESULT_MANIFEST_ID = "result-readmission-gse2";

interface ReadmissionAsset {
  asset_id: string;
  scope: TransformScope;
  task_id: string | null;
  source: string;
  generation: number;
  status: TransformTrustStatus;
  sha256: string;
  size_bytes: number;
}

interface ReadmissionResult {
  result_manifest_id: string;
  scope: TransformScope;
  task_id: string | null;
  source: string;
  generation: number;
  status: TransformTrustStatus;
  sha256: string;
  size_bytes: number;
}

interface ReadmissionContext {
  task_id: string;
  generation: number;
  assets: readonly ReadmissionAsset[];
  results: readonly ReadmissionResult[];
  catalog: FamilyCatalog;
}

function asset(overrides: Partial<ReadmissionAsset> = {}): ReadmissionAsset {
  return {
    asset_id: ASSET_ID,
    scope: "task",
    task_id: TASK_ID,
    source: "geo-gse1",
    generation: CURRENT_GENERATION,
    status: "activated",
    sha256: DIGEST.asset,
    size_bytes: 1_024,
    ...overrides,
  };
}

function result(overrides: Partial<ReadmissionResult> = {}): ReadmissionResult {
  return {
    result_manifest_id: RESULT_MANIFEST_ID,
    scope: "task",
    task_id: TASK_ID,
    source: "geo-gse2",
    generation: CURRENT_GENERATION,
    status: "activated",
    sha256: DIGEST.result,
    size_bytes: 512,
    ...overrides,
  };
}

function catalog(overrides: {
  family?: Partial<FamilyCatalogEntry>;
  transform?: Partial<FamilyCatalogEntry>;
} = {}): FamilyCatalog {
  const created = createFamilyCatalog([
    {
      kind: "family_spec",
      scope: "curated",
      id: FAMILY_REF.id,
      version: FAMILY_REF.version,
      digest: FAMILY_REF.digest,
      status: "activated",
      ...overrides.family,
    },
    {
      kind: "dataset_transform",
      scope: "curated",
      id: TRANSFORM_REF.id,
      version: TRANSFORM_REF.version,
      digest: TRANSFORM_REF.digest,
      status: "activated",
      ...overrides.transform,
    },
  ]);
  if (!created.ok) {
    throw new Error(`fixture catalog rejected: ${JSON.stringify(created.error)}`);
  }
  return created.catalog;
}

function proposal(overrides: Partial<DatasetBuildProposal2> = {}): DatasetBuildProposal2 {
  return {
    schema_version: "2.0",
    spec_kind: "proposal",
    build_id: "build-readmission-e2e",
    family_spec_ref: FAMILY_REF,
    projection_ref: "readmission.projection.v1",
    transform_refs: [TRANSFORM_REF],
    policy_refs: POLICY_REFS,
    output_format: "long_table",
    idempotency_identity: "readmission-e2e-v1",
    source_bindings: [
      {
        binding_id: "binding-asset",
        source: "geo-gse1",
        input_requirement_ref: "readmission.input.gse.v1",
        parameters: {},
      },
      {
        binding_id: "binding-result",
        source: "geo-gse2",
        input_requirement_ref: "readmission.input.gse.v1",
        parameters: {},
      },
    ],
    ...overrides,
  };
}

function context(overrides: Partial<ReadmissionContext> = {}): ReadmissionContext {
  return {
    task_id: TASK_ID,
    generation: CURRENT_GENERATION,
    assets: [asset()],
    results: [result()],
    catalog: catalog(),
    ...overrides,
  };
}

function captureError(fn: () => unknown): BuildSpecReadmissionError {
  try {
    fn();
  } catch (error) {
    if (error instanceof BuildSpecReadmissionError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected resolveDatasetBuildProposal2 to throw BuildSpecReadmissionError");
}

function hasOnlyPlainDataPrototypes(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (Array.isArray(value)) return value.every(hasOnlyPlainDataPrototypes);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every(hasOnlyPlainDataPrototypes);
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe("BuildSpec 2.0 readmission", () => {
  test("resolves every source binding to exactly one registered asset or result handle", () => {
    const resolved = resolveDatasetBuildProposal2(proposal(), context());

    expect(resolved).toEqual({
      schema_version: "2.0",
      spec_kind: "resolved",
      build_id: "build-readmission-e2e",
      family_spec_ref: FAMILY_REF,
      projection_ref: "readmission.projection.v1",
      transform_refs: [TRANSFORM_REF],
      policy_refs: POLICY_REFS,
      output_format: "long_table",
      idempotency_identity: "readmission-e2e-v1",
      source_bindings: [
        {
          binding_id: "binding-asset",
          source: "geo-gse1",
          registered_asset_ref: ASSET_ID,
          registered_result_ref: null,
          parameters: {},
        },
        {
          binding_id: "binding-result",
          source: "geo-gse2",
          registered_asset_ref: null,
          registered_result_ref: RESULT_MANIFEST_ID,
          parameters: {},
        },
      ],
    });

    for (const binding of resolved.source_bindings) {
      expect((binding.registered_asset_ref === null) !== (binding.registered_result_ref === null))
        .toBe(true);
    }
  });

  test("preserves source binding declaration order and per-binding association", () => {
    const resolved = resolveDatasetBuildProposal2(proposal({
      source_bindings: [
        { binding_id: "o1", source: "geo-o1", input_requirement_ref: "readmission.input.v1", parameters: {} },
        { binding_id: "o2", source: "geo-o2", input_requirement_ref: "readmission.input.v1", parameters: {} },
        { binding_id: "o3", source: "geo-o3", input_requirement_ref: "readmission.input.v1", parameters: {} },
      ],
    }), context({
      assets: [
        asset({ source: "geo-o3", asset_id: ALT_ASSET_ID, sha256: DIGEST.assetAlt }),
        asset({ source: "geo-o1" }),
      ],
      results: [result({ source: "geo-o2" })],
    }));

    expect(resolved.source_bindings.map((binding) => binding.binding_id)).toEqual([
      "o1",
      "o2",
      "o3",
    ]);
    expect(resolved.source_bindings).toEqual([
      {
        binding_id: "o1",
        source: "geo-o1",
        registered_asset_ref: ASSET_ID,
        registered_result_ref: null,
        parameters: {},
      },
      {
        binding_id: "o2",
        source: "geo-o2",
        registered_asset_ref: null,
        registered_result_ref: RESULT_MANIFEST_ID,
        parameters: {},
      },
      {
        binding_id: "o3",
        source: "geo-o3",
        registered_asset_ref: ALT_ASSET_ID,
        registered_result_ref: null,
        parameters: {},
      },
    ]);
  });

  test("rejects a binding whose source has no registered candidate", () => {
    const error = captureError(() => resolveDatasetBuildProposal2(proposal({
      source_bindings: [
        { binding_id: "ghost", source: "geo-ghost", input_requirement_ref: "readmission.input.v1", parameters: {} },
      ],
    }), context()));

    expect(error.code).toBe("not_found");
  });

  test("returns explicit ambiguity when a source matches multiple visible candidates", () => {
    const error = captureError(() => resolveDatasetBuildProposal2(proposal({
      source_bindings: [
        { binding_id: "amb", source: "geo-amb", input_requirement_ref: "readmission.input.v1", parameters: {} },
      ],
    }), context({
      assets: [asset({ source: "geo-amb" })],
      results: [result({ source: "geo-amb", scope: "curated", task_id: null })],
    })));

    expect(error.code).toBe("ambiguous_reference");
  });

  test("fails closed when a task-scoped candidate belongs to another task", () => {
    const error = captureError(() => resolveDatasetBuildProposal2(proposal({
      source_bindings: [
        { binding_id: "x", source: "geo-x", input_requirement_ref: "readmission.input.v1", parameters: {} },
      ],
    }), context({
      assets: [asset({ source: "geo-x", task_id: OTHER_TASK_ID })],
    })));

    expect(error.code).toBe("cross_task_reference");
  });

  test("binds non-task-scoped candidates without cross-task restrictions", () => {
    const curated = asset({ source: "geo-curated", scope: "curated", task_id: null });
    const resolved = resolveDatasetBuildProposal2(proposal({
      source_bindings: [
        { binding_id: "c", source: "geo-curated", input_requirement_ref: "readmission.input.v1", parameters: {} },
      ],
    }), context({ assets: [curated] }));

    expect(resolved.source_bindings).toEqual([{
      binding_id: "c",
      source: "geo-curated",
      registered_asset_ref: curated.asset_id,
      registered_result_ref: null,
      parameters: {},
    }]);
  });

  test("rejects candidates from a stale registry generation", () => {
    const error = captureError(() => resolveDatasetBuildProposal2(proposal({
      source_bindings: [
        { binding_id: "old", source: "geo-old", input_requirement_ref: "readmission.input.v1", parameters: {} },
      ],
    }), context({
      assets: [asset({ source: "geo-old", generation: 1, sha256: DIGEST.stale })],
    })));

    expect(error.code).toBe("stale_generation");
  });

  test("prefers the current-generation candidate over a shadowed older copy", () => {
    const resolved = resolveDatasetBuildProposal2(proposal({
      source_bindings: [
        { binding_id: "mix", source: "geo-mix", input_requirement_ref: "readmission.input.v1", parameters: {} },
      ],
    }), context({
      assets: [
        asset({ source: "geo-mix", generation: 1, asset_id: ALT_ASSET_ID, sha256: DIGEST.assetAlt }),
        asset({ source: "geo-mix" }),
      ],
    }));

    expect(resolved.source_bindings[0]).toMatchObject({
      binding_id: "mix",
      registered_asset_ref: ASSET_ID,
      registered_result_ref: null,
    });
  });

  test("fails closed on revoked and example-scoped candidates", () => {
    const revoked = captureError(() => resolveDatasetBuildProposal2(proposal({
      source_bindings: [
        { binding_id: "rev", source: "geo-rev", input_requirement_ref: "readmission.input.v1", parameters: {} },
      ],
    }), context({
      assets: [asset({ source: "geo-rev", status: "revoked" })],
    })));
    expect(revoked.code).toBe("execution_revoked");

    const example = captureError(() => resolveDatasetBuildProposal2(proposal({
      source_bindings: [
        { binding_id: "ex", source: "geo-ex", input_requirement_ref: "readmission.input.v1", parameters: {} },
      ],
    }), context({
      assets: [asset({ source: "geo-ex", scope: "example", task_id: null })],
    })));
    expect(example.code).toBe("example_not_executable");

    const revokedTransform = captureError(() => resolveDatasetBuildProposal2(
      proposal(),
      context({ catalog: catalog({ transform: { status: "revoked" } }) }),
    ));
    expect(revokedTransform.code).toBe("execution_revoked");
  });

  test("rejects family and transform refs whose digest no longer matches the catalog", () => {
    const familyDigest = captureError(() => resolveDatasetBuildProposal2(proposal({
      family_spec_ref: { ...FAMILY_REF, digest: "0".repeat(64) },
    }), context()));
    expect(familyDigest.code).toBe("not_found");

    const familyVersion = captureError(() => resolveDatasetBuildProposal2(proposal({
      family_spec_ref: { ...FAMILY_REF, version: "9.9.9" },
    }), context()));
    expect(familyVersion.code).toBe("not_found");

    const transformDigest = captureError(() => resolveDatasetBuildProposal2(proposal({
      transform_refs: [{ ...TRANSFORM_REF, digest: "0".repeat(64) }],
    }), context()));
    expect(transformDigest.code).toBe("not_found");
  });

  test("is invariant to registry insertion order", () => {
    const bindings: DatasetBuildProposal2["source_bindings"] = [
      { binding_id: "i1", source: "geo-i1", input_requirement_ref: "readmission.input.v1", parameters: {} },
      { binding_id: "i2", source: "geo-i2", input_requirement_ref: "readmission.input.v1", parameters: {} },
    ];
    const leftAssets = [
      asset({ source: "geo-i1" }),
      asset({ source: "geo-i2", asset_id: ALT_ASSET_ID, sha256: DIGEST.assetAlt }),
    ];
    const rightAssets = [...leftAssets].reverse();

    const left: ResolvedDatasetBuildSpec2 = resolveDatasetBuildProposal2(proposal({
      source_bindings: bindings,
    }), context({ assets: leftAssets }));
    const right = resolveDatasetBuildProposal2(proposal({
      source_bindings: bindings,
    }), context({ assets: rightAssets }));

    expect(left).toEqual(right);

    const ambiguityAssets = [asset({ source: "geo-amb2" }), result({ source: "geo-amb2", scope: "curated", task_id: null })];
    for (const assets of [ambiguityAssets, [...ambiguityAssets].reverse()]) {
      const error = captureError(() => resolveDatasetBuildProposal2(proposal({
        source_bindings: [
          { binding_id: "amb2", source: "geo-amb2", input_requirement_ref: "readmission.input.v1", parameters: {} },
        ],
      }), context({ assets })));
      expect(error.code).toBe("ambiguous_reference");
    }
  });

  test("fails closed on accessors and proxies without reading them", () => {
    let reads = 0;
    const accessorProposal = proposal();
    Object.defineProperty(accessorProposal.source_bindings[0], "source", {
      enumerable: true,
      get() {
        reads += 1;
        return "geo-gse1";
      },
    });
    expect(captureError(() => resolveDatasetBuildProposal2(accessorProposal, context())).code)
      .toBe("invalid_proposal");
    expect(reads).toBe(0);

    const accessorAsset = asset();
    Object.defineProperty(accessorAsset, "source", {
      enumerable: true,
      get() {
        reads += 1;
        return "geo-gse1";
      },
    });
    expect(captureError(() => resolveDatasetBuildProposal2(proposal(), context({
      assets: [accessorAsset],
    }))).code).toBe("invalid_reference");
    expect(reads).toBe(0);

    let gets = 0;
    const { proxy, revoke } = Proxy.revocable(proposal(), {
      get() {
        gets += 1;
        return undefined;
      },
      ownKeys() {
        gets += 1;
        return [];
      },
    });
    revoke();
    expect(captureError(() => resolveDatasetBuildProposal2(proxy, context())).code)
      .toBe("invalid_proposal");
    expect(gets).toBe(0);
  });

  test("rejects non-proposal input and resolved handles inside a proposal", () => {
    const resolvedKind = captureError(() => resolveDatasetBuildProposal2(
      { ...proposal(), spec_kind: "resolved" },
      context(),
    ));
    expect(resolvedKind.code).toBe("invalid_proposal");

    const unknownField = captureError(() => resolveDatasetBuildProposal2(proposal({
      source_bindings: [
        { binding_id: "leak", source: "geo-gse1", input_requirement_ref: "readmission.input.v1", registered_asset_ref: ASSET_ID, parameters: {} },
      ],
    }), context()));
    expect(unknownField.code).toBe("invalid_proposal");
  });

  test("round-trips through the resolved parser and stable stringify", () => {
    const resolved = resolveDatasetBuildProposal2(proposal(), context());
    const wire = JSON.parse(stableStringify(resolved)) as unknown;

    expect(parseResolvedDatasetBuildSpec2(wire, "$resolved_roundtrip")).toEqual(resolved);
    expect(parseDatasetBuildSpec2(wire, "$resolved_alias")).toEqual(resolved);
    expect(stableStringify(parseResolvedDatasetBuildSpec2(wire, "$resolved_roundtrip")))
      .toBe(stableStringify(resolved));
  });

  test("emits only wire evidence, never OperationResult or Publication objects", () => {
    const resolved = resolveDatasetBuildProposal2(proposal(), context());
    expect(hasOnlyPlainDataPrototypes(resolved)).toBe(true);
    expect(JSON.parse(stableStringify(resolved))).toEqual(resolved);
    expect(resolved).not.toHaveProperty("operation_result");
    expect(resolved).not.toHaveProperty("publication");

    const error = captureError(() => resolveDatasetBuildProposal2(proposal(), context({ assets: [] })));
    expect(Object.keys(error).sort()).toEqual(["code", "message"]);
    expect(typeof error.code).toBe("string");
    expect(typeof error.message).toBe("string");
    expect(JSON.parse(JSON.stringify(error))).toEqual(error);
  });
});
