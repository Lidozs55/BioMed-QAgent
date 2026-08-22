import { describe, expect, test } from "vitest";

import {
  computeFamilySpecDigest,
  parseDatasetBuildSpec2,
  parseResolvedDatasetBuildSpec2,
  stableStringify,
  type DatasetBuildProposal2,
  type FamilySpec,
} from "@biomed/contracts";
import {
  BuildSpecResolutionError,
  resolveDatasetBuildProposal2,
  type BuildSpecResolutionContext,
} from "../src/dataset/build-spec-readmission/index.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const TASK_ID = "task_buildspec";
const BUILD_ID = "build_buildspec";
const GENERATION = 7;

async function familySpec(overrides: Partial<FamilySpec> = {}): Promise<FamilySpec> {
  const unsigned: FamilySpec = {
    family_spec_id: "family_buildspec",
    semantic_version: "2.0.0",
    canonical_digest: A,
    projections: [],
    table_definitions: [],
    relations: [],
    identity: {
      dataset_id_scheme: "ds_hash",
      dataset_revision_id_scheme: "dsrev_hash",
      asset_id_scheme: "asset_sha256",
      sample_identity_fields: ["dataset_revision_id", "sample_id"],
      probe_mapping_assertion_pk: "mapping_assertion_id",
    },
    transform_capability_refs: [],
    declared_outputs: [],
    integration_policy_ref: "policy.integration",
    validation_policy_ref: "policy.validation",
    assessment_policy_ref: "policy.assessment",
    resource_class_request: "standard",
    scope: "curated",
    author: "test",
    evidence_refs: [],
    ...overrides,
  };
  return { ...unsigned, canonical_digest: await computeFamilySpecDigest(unsigned) };
}

interface Fixture {
  proposal: DatasetBuildProposal2;
  context: BuildSpecResolutionContext;
  family: FamilySpec;
}

async function fixture(overrides: {
  assets?: BuildSpecResolutionContext["assets"];
  results?: BuildSpecResolutionContext["results"];
  transforms?: BuildSpecResolutionContext["transforms"];
  policies?: BuildSpecResolutionContext["policies"];
  family?: Partial<FamilySpec>;
} = {}): Promise<Fixture> {
  const family = await familySpec(overrides.family);
  const assetId = `asset_${A}`;
  const proposal: DatasetBuildProposal2 = {
    schema_version: "2.0",
    spec_kind: "proposal",
    build_id: BUILD_ID,
    family_spec_ref: {
      scope: family.scope,
      id: family.family_spec_id,
      version: family.semantic_version,
      digest: family.canonical_digest,
    },
    projection_ref: "projection_buildspec",
    transform_refs: [{ scope: "curated", id: "transform_buildspec", version: "1.0.0", digest: B }],
    policy_refs: [{ scope: "system", id: "policy_buildspec", version: "1.0.0", digest: C }],
    output_format: "long_table",
    idempotency_identity: "id_buildspec",
    source_bindings: [
      {
        binding_id: "asset_binding",
        source: "geo_gse",
        input_requirement_ref: "input_geo",
        parameters: { accession: "GSE1" },
      },
      {
        binding_id: "result_binding",
        source: "prior_result",
        input_requirement_ref: "input_result",
        parameters: {},
      },
    ],
  };
  const context: BuildSpecResolutionContext = {
    task_id: TASK_ID,
    build_id: BUILD_ID,
    registry_generation: GENERATION,
    registry_snapshot_digest: D,
    family: { family_spec: family, family_status: "activated" },
    transforms: overrides.transforms ?? [{
      kind: "dataset_transform",
      scope: "curated",
      id: "transform_buildspec",
      version: "1.0.0",
      digest: B,
      status: "activated",
    }],
    policies: overrides.policies ?? [{
      kind: "policy",
      scope: "system",
      id: "policy_buildspec",
      version: "1.0.0",
      digest: C,
      status: "activated",
    }],
    assets: overrides.assets ?? [{
      binding_id: "asset_binding",
      source: "geo_gse",
      input_requirement_ref: "input_geo",
      task_id: TASK_ID,
      build_id: BUILD_ID,
      generation: GENERATION,
      registered_ref: assetId,
      receipt_digest: A,
    }],
    results: overrides.results ?? [{
      binding_id: "result_binding",
      source: "prior_result",
      input_requirement_ref: "input_result",
      task_id: TASK_ID,
      build_id: BUILD_ID,
      generation: GENERATION,
      registered_ref: "result_prior",
      receipt_digest: B,
    }],
  };
  return { proposal, context, family };
}

async function capture(
  operation: () => Promise<unknown>,
): Promise<BuildSpecResolutionError> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof BuildSpecResolutionError) return error;
    throw error;
  }
  throw new Error("expected BuildSpecResolutionError");
}

describe("BuildSpec 2.0 Core readmission", () => {
  test("resolves exact registered asset/result bindings and emits wire evidence", async () => {
    const { proposal, context } = await fixture();
    const result = await resolveDatasetBuildProposal2(proposal, context);

    expect(result.resolved.source_bindings).toEqual([
      {
        binding_id: "asset_binding",
        source: "geo_gse",
        registered_asset_ref: `asset_${A}`,
        registered_result_ref: null,
        parameters: { accession: "GSE1" },
      },
      {
        binding_id: "result_binding",
        source: "prior_result",
        registered_asset_ref: null,
        registered_result_ref: "result_prior",
        parameters: {},
      },
    ]);
    expect(result.evidence).toMatchObject({
      task_id: TASK_ID,
      build_id: BUILD_ID,
      registry_generation: GENERATION,
      registry_snapshot_digest: D,
      ordered_receipt_digests: [A, B],
      ordered_capability_refs: [
        `curated:transform_buildspec:1.0.0:${B}`,
        `system:policy_buildspec:1.0.0:${C}`,
      ],
    });
    expect(result.evidence).not.toHaveProperty("operation_result");
    expect(result.evidence).not.toHaveProperty("publication");
  });

  test("preserves declared binding and capability order", async () => {
    const base = await fixture();
    const proposal = {
      ...base.proposal,
      transform_refs: [
        { scope: "curated" as const, id: "transform_two", version: "1.0.0", digest: A },
        ...base.proposal.transform_refs,
      ],
      source_bindings: [
        base.proposal.source_bindings[1]!,
        base.proposal.source_bindings[0]!,
      ],
    };
    const context = {
      ...base.context,
      transforms: [
        ...base.context.transforms,
        { kind: "dataset_transform" as const, scope: "curated" as const, id: "transform_two", version: "1.0.0", digest: A, status: "activated" as const },
      ],
    };
    const result = await resolveDatasetBuildProposal2(proposal, context);
    expect(result.resolved.source_bindings.map((binding) => binding.binding_id))
      .toEqual(["result_binding", "asset_binding"]);
    expect(result.evidence.ordered_capability_refs[0]).toContain("transform_two");
  });

  test.each([
    ["missing binding", { assets: [] }, "unknown_binding"],
    ["stale generation", { assets: [{
      binding_id: "asset_binding", source: "geo_gse", input_requirement_ref: "input_geo",
      task_id: TASK_ID, build_id: BUILD_ID, generation: 1, registered_ref: `asset_${A}`, receipt_digest: A,
    }] }, "stale_generation"],
    ["cross task", { assets: [{
      binding_id: "asset_binding", source: "geo_gse", input_requirement_ref: "input_geo",
      task_id: "other_task", build_id: BUILD_ID, generation: GENERATION, registered_ref: `asset_${A}`, receipt_digest: A,
    }] }, "cross_task_binding"],
    ["build mismatch", { assets: [{
      binding_id: "asset_binding", source: "geo_gse", input_requirement_ref: "input_geo",
      task_id: TASK_ID, build_id: "other_build", generation: GENERATION, registered_ref: `asset_${A}`, receipt_digest: A,
    }] }, "build_mismatch"],
  ] as const)("fails closed on %s", async (_label, overrides, code) => {
    const base = await fixture(overrides);
    const error = await capture(() => resolveDatasetBuildProposal2(base.proposal, base.context));
    expect(error.code).toBe(code);
  });

  test("rejects ambiguous asset/result and duplicate records", async () => {
    const base = await fixture({
      results: [{
        binding_id: "asset_binding", source: "geo_gse", input_requirement_ref: "input_geo",
        task_id: TASK_ID, build_id: BUILD_ID, generation: GENERATION, registered_ref: "result_ambiguous", receipt_digest: B,
      }, baseResult()],
    });
    const ambiguous = await capture(() => resolveDatasetBuildProposal2(base.proposal, base.context));
    expect(ambiguous.code).toBe("ambiguous_binding");

    const duplicate = await fixture({
      assets: [baseAsset(), baseAsset()],
    });
    expect((await capture(() => resolveDatasetBuildProposal2(duplicate.proposal, duplicate.context))).code)
      .toBe("duplicate_binding");
  });

  test("requires activated, non-example exact capabilities and verified family digest", async () => {
    const revoked = await fixture({ transforms: [{ kind: "dataset_transform", scope: "curated", id: "transform_buildspec", version: "1.0.0", digest: B, status: "revoked" }] });
    expect((await capture(() => resolveDatasetBuildProposal2(revoked.proposal, revoked.context))).code)
      .toBe("family_revoked");

    const example = await fixture({ transforms: [{ kind: "dataset_transform", scope: "example", id: "transform_buildspec", version: "1.0.0", digest: B, status: "activated" }] });
    const exampleProposal = {
      ...example.proposal,
      transform_refs: [{ ...example.proposal.transform_refs[0]!, scope: "example" as const }],
    };
    expect((await capture(() => resolveDatasetBuildProposal2(exampleProposal, example.context))).code)
      .toBe("example_execution_forbidden");

    const badFamily = await fixture({ family: { author: "tampered" } });
    const bad = { ...badFamily.context, family: { ...badFamily.context.family, family_spec: { ...badFamily.family, canonical_digest: A } } };
    expect((await capture(() => resolveDatasetBuildProposal2(badFamily.proposal, bad))).code)
      .toBe("family_spec_digest_mismatch");
  });

  test("rejects proposal/resolved hybrids, accessors, and proxies", async () => {
    const base = await fixture();
    const hybrid = { ...base.proposal, spec_kind: "resolved" };
    expect((await capture(() => resolveDatasetBuildProposal2(hybrid, base.context))).code)
      .toBe("invalid_proposal");

    let reads = 0;
    const accessor = { ...base.proposal };
    Object.defineProperty(accessor, "build_id", {
      enumerable: true,
      get() {
        reads += 1;
        return BUILD_ID;
      },
    });
    expect((await capture(() => resolveDatasetBuildProposal2(accessor, base.context))).code)
      .toBe("invalid_proposal");
    expect(reads).toBe(0);

    const proxy = new Proxy(base.proposal, { get() { reads += 1; return undefined; } });
    expect((await capture(() => resolveDatasetBuildProposal2(proxy, base.context))).code)
      .toBe("invalid_proposal");
    expect(reads).toBe(0);
  });

  test("round-trips through the resolved parser and stable canonical bytes", async () => {
    const base = await fixture();
    const result = await resolveDatasetBuildProposal2(base.proposal, base.context);
    const wire = JSON.parse(stableStringify(result.resolved)) as unknown;
    expect(parseResolvedDatasetBuildSpec2(wire, "$resolved")).toEqual(result.resolved);
    expect(parseDatasetBuildSpec2(wire, "$alias")).toEqual(result.resolved);
    expect(stableStringify(wire)).toBe(stableStringify(result.resolved));
  });
});

function baseAsset() {
  return {
    binding_id: "asset_binding",
    source: "geo_gse",
    input_requirement_ref: "input_geo",
    task_id: TASK_ID,
    build_id: BUILD_ID,
    generation: GENERATION,
    registered_ref: `asset_${A}`,
    receipt_digest: A,
  };
}

function baseResult() {
  return {
    binding_id: "result_binding",
    source: "prior_result",
    input_requirement_ref: "input_result",
    task_id: TASK_ID,
    build_id: BUILD_ID,
    generation: GENERATION,
    registered_ref: "result_prior",
    receipt_digest: B,
  };
}
