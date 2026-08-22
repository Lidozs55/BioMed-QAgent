import { describe, expect, it } from "vitest";

import {
  buildFamilySpecDigestCanonical,
  buildImplementationDigestCanonical,
  buildTransformDescriptorDigestCanonical,
  computeFamilySpecDigest,
  computeImplementationDigest,
  parseDatasetBuildProposal2,
  parseDatasetBuildSpec2,
  parseDatasetIdentity,
  parseDatasetTransform,
  parseFamilySpec,
  parseImplementationDigestInput,
  parseResolvedDatasetBuildSpec2,
  parseScopeQualifiedRef,
  parseTransformExecutionReceipt,
  stableStringify,
  verifyFamilySpecDigest,
  type DatasetBuildProposal2,
  type DatasetTransform,
  type FamilySpec,
  type ImplementationDigestInput,
  type ResolvedDatasetBuildSpec2,
  type TransformDescriptorDigestInput,
  type TransformExecutionReceipt,
} from "../src/family-transform";
import { assertArray, assertJsonValue } from "../src/runtime/primitives";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const DS = `ds_${A}`;
const DSREV = `dsrev_${B}`;
const ASSET = `asset_${C}`;

const family: FamilySpec = {
  family_spec_id: "fs_gene_expression",
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
  integration_policy_ref: "pol_int",
  validation_policy_ref: "pol_val",
  assessment_policy_ref: "pol_assess",
  resource_class_request: "standard",
  scope: "curated",
  author: "team",
  evidence_refs: [],
};

const implementationInput: ImplementationDigestInput = {
  normalized_source_sha256: A,
  emitted_bundle_sha256: B,
  compiler_id: "tsc",
  compiler_version: "5.6.3",
  compiler_options_digest: C,
  dependency_closure_digest: D,
  runtime_abi_version: "1.0.0",
  host_policy_version: "1.0.0",
};

const descriptorDigestInput: TransformDescriptorDigestInput = {
  transform_id: "t_geo_series",
  version: "1.0.0",
  entrypoint: "transform.run",
  implementation_digest: A,
  bound_family_spec_digest: B,
  bound_projection_digest: C,
  declared_input_roles: [
    { role: "series_matrix", media_type: "text/tab-separated-values", constraint_ref: "constraint_geo" },
  ],
  declared_output_tables: [{ table_id: "expression", schema_ref: "schema_expression_v2" }],
  runtime_policy_digest: D,
  import_policy_digest: A,
  resource_policy_digest: B,
};

const resolvedBuild: ResolvedDatasetBuildSpec2 = {
  schema_version: "2.0",
  spec_kind: "resolved",
  build_id: "build_1",
  family_spec_ref: { scope: "curated", id: "fs_x", version: "2.0.0", digest: A },
  projection_ref: "proj_gene",
  source_bindings: [
    {
      binding_id: "binding_1",
      source: "geo",
      registered_asset_ref: ASSET,
      registered_result_ref: null,
      parameters: { accession: "GSE1" },
    },
  ],
  transform_refs: [{ scope: "curated", id: "t_x", version: "1.0.0", digest: B }],
  policy_refs: [{ scope: "system", id: "policy_x", version: "1.0.0", digest: C }],
  output_format: "multitable",
  idempotency_identity: "idem_1",
};

const proposalBuild: DatasetBuildProposal2 = {
  schema_version: "2.0",
  spec_kind: "proposal",
  build_id: "build_1",
  family_spec_ref: { scope: "curated", id: "fs_x", version: "2.0.0", digest: A },
  projection_ref: "proj_gene",
  source_bindings: [
    {
      binding_id: "binding_1",
      source: "geo",
      input_requirement_ref: "input_geo_series_matrix",
      parameters: { accession: "GSE1" },
    },
  ],
  transform_refs: [{ scope: "curated", id: "t_x", version: "1.0.0", digest: B }],
  policy_refs: [{ scope: "system", id: "policy_x", version: "1.0.0", digest: C }],
  output_format: "multitable",
  idempotency_identity: "idem_1",
};

const receipt: TransformExecutionReceipt = {
  schema_version: "1.0",
  task_id: "task_1",
  run_id: "run_1",
  build_id: "build_1",
  invocation_id: "inv_1",
  attempt: 1,
  generation: 1,
  request_digest: A,
  parameters_digest: B,
  family_spec_digest: A,
  projection_digest: B,
  transform_digest: C,
  bundle_digest: D,
  compiler_digest: A,
  runtime_digest: B,
  policy_digest: C,
  input_asset_receipts: [
    { asset_id: ASSET, role: "series_matrix", sha256: C, size_bytes: 10, locator_ref: "locator_asset_1" },
  ],
  input_result_receipts: [
    {
      result_manifest_id: "result_1",
      role: "prior_result",
      sha256: D,
      size_bytes: 20,
      locator_ref: "locator_result_1",
    },
  ],
  granted_capabilities: ["bounded_reader"],
  resource_limits: {
    wall_ms: 2_000,
    cpu_ms: 1_000,
    rss_bytes: 1_000_000,
    temp_bytes: 1_000_000,
    output_bytes: 1_000_000,
    log_bytes: 10_000,
    open_files: 64,
    pids: 1,
  },
  sandbox_backend: "container",
  sandbox_config_digest: D,
  exit_state: "succeeded",
  exit_code: 0,
  exit_signal: null,
  wall_ms: 10,
  cpu_ms: 9,
  rss_bytes: 100,
  temp_bytes: 20,
  output_bytes: 30,
  log_bytes: 4,
  quarantined_output_receipts: [
    {
      table_id: "expression",
      schema_ref: "schema_expression_v2",
      artifact_ref: "artifact_expression_1",
      locator_ref: "locator_output_1",
      sha256: A,
      size_bytes: 30,
      row_count: 1,
    },
  ],
  stdout_ref: "stdout_1",
  stderr_ref: "stderr_1",
  audit_refs: [],
  cancellation_state: "none",
  cancel_requested_at: null,
  deadline_at: "2026-08-21T00:01:00Z",
  started_at: "2026-08-21T00:00:00Z",
  finished_at: "2026-08-21T00:00:01Z",
  host_implementation_digest: D,
  host_issued_at: "2026-08-21T00:00:02Z",
};

describe("family-transform object parser red-team boundary", () => {
  it("rejects Proxies without invoking any trap", () => {
    let reads = 0;
    const proxy = new Proxy(
      {},
      {
        get() {
          reads += 1;
          return undefined;
        },
        getPrototypeOf() {
          reads += 1;
          return Object.prototype;
        },
        ownKeys() {
          reads += 1;
          return [];
        },
        getOwnPropertyDescriptor() {
          reads += 1;
          return undefined;
        },
      },
    );

    expect(() => parseFamilySpec(proxy, "$")) .toThrow(/Proxy/);
    expect(reads).toBe(0);
  });

  it("rejects accessors without invoking getters", () => {
    let reads = 0;
    const accessor = { ...family };
    Object.defineProperty(accessor, "family_spec_id", {
      enumerable: true,
      get() {
        reads += 1;
        return "fs_evil";
      },
    });

    expect(() => parseFamilySpec(accessor, "$")) .toThrow(/accessor|data property/i);
    expect(reads).toBe(0);
  });

  it("rejects own __proto__, symbols, non-enumerable fields, and exotic prototypes", () => {
    const ownProto = Object.assign(Object.create(null) as Record<string, unknown>, family);
    Object.defineProperty(ownProto, "__proto__", { value: {}, enumerable: true });
    expect(() => parseFamilySpec(ownProto, "$")) .toThrow(/__proto__/);

    const symbolField = { ...family };
    Object.defineProperty(symbolField, Symbol("smuggled"), { value: true, enumerable: true });
    expect(() => parseFamilySpec(symbolField, "$")) .toThrow(/symbol/i);

    const hidden = { ...family };
    Object.defineProperty(hidden, "smuggled_path", { value: "/etc/passwd", enumerable: false });
    expect(() => parseFamilySpec(hidden, "$")) .toThrow(/non-enumerable/i);

    const exotic = Object.assign(Object.create({ polluted: true }) as Record<string, unknown>, family);
    expect(() => parseFamilySpec(exotic, "$")) .toThrow(/prototype/i);
  });

  it("requires every declared field to be an own data property", () => {
    const inherited = Object.create({ family_spec_id: family.family_spec_id }) as Record<string, unknown>;
    for (const [key, value] of Object.entries(family)) {
      if (key !== "family_spec_id") inherited[key] = value;
    }
    expect(() => parseFamilySpec(inherited, "$")) .toThrow(/prototype|required|family_spec_id/i);

    expect(() => parseFamilySpec({ ...family, family_spec_id: undefined }, "$")) .toThrow();
  });
});

describe("JSON and canonicalization red-team boundary", () => {
  it("rejects aggregate payloads that exceed the whole-object character budget", () => {
    expect(() => parseFamilySpec({
      ...family,
      evidence_refs: Array.from(
        { length: 9_000 },
        (_value, index) => `evidence_${index}_${"x".repeat(480)}`,
      ),
    }, "$")) .toThrow(/aggregate characters/);
  });

  it("rejects sparse arrays and unsafe JSON numbers", () => {
    const sparse = new Array<unknown>(1);
    expect(() => assertArray(sparse, "$", (value) => value)).toThrow(/sparse|index/i);
    expect(() => assertJsonValue(Number.NaN, "$")) .toThrow(/finite/i);
    expect(() => assertJsonValue(Number.POSITIVE_INFINITY, "$")) .toThrow(/finite/i);
    expect(() => stableStringify(sparse)).toThrow(/sparse|index/i);
    expect(() => stableStringify(Number.NaN)).toThrow(/finite/i);
    expect(() => stableStringify(Number.NEGATIVE_INFINITY)).toThrow(/finite/i);
  });

  it("rejects accessors and unsupported canonical values without reading getters", () => {
    let reads = 0;
    const accessor = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get() {
        reads += 1;
        return 1;
      },
    });
    expect(() => stableStringify(accessor)).toThrow(/accessor|data property/i);
    expect(reads).toBe(0);
    expect(() => stableStringify(undefined)).toThrow(/undefined/);
    expect(() => stableStringify(1n)).toThrow(/bigint/);
    expect(() => stableStringify(new Date(0))).toThrow(/prototype/i);
  });

  it("preserves general JSON wire values while canonical digests normalize Unicode", () => {
    expect(assertJsonValue({ "e\u0301": "e\u0301" }, "$"))
      .toEqual({ "e\u0301": "e\u0301" });
    expect(stableStringify({ "e\u0301": "e\u0301" })).toBe('{"é":"é"}');

    const duplicate = Object.create(null) as Record<string, unknown>;
    duplicate["é"] = 1;
    duplicate["e\u0301"] = 2;
    expect(() => stableStringify(duplicate)).toThrow(/duplicate|NFC/i);
  });
});

describe("family-transform strict lexical policies", () => {
  it("binds the content-addressed bundle reference to bundle_digest", () => {
    const transform: DatasetTransform = {
      transform_id: "transform_1",
      version: "1.0.0",
      source_digest: A,
      bundle_digest: B,
      compiler_id: "tsc",
      compiler_version: "5.6.3",
      compiler_options_digest: C,
      runtime_abi_version: "1.0.0",
      runtime_policy_version: "1.0.0",
      dependency_closure_digest: D,
      code_bundle_ref: `bundle_${B}`,
      entrypoint: "transform.run",
      declared_input_roles: [],
      declared_output_tables: [],
      bound_family_spec_digest: A,
      bound_projection_digest: B,
      determinism_profile: "deterministic",
      resource_class: "standard",
      origin: "agent",
      scope: "task",
      review_refs: [],
    };
    expect(parseDatasetTransform(transform, "$")) .toEqual(transform);
    expect(() => parseDatasetTransform({
      ...transform,
      code_bundle_ref: `bundle_${C}`,
    }, "$")) .toThrow(/bundle_digest|code_bundle_ref/);
    const withoutProjection: Partial<DatasetTransform> = { ...transform };
    delete withoutProjection.bound_projection_digest;
    expect(() => parseDatasetTransform(withoutProjection, "$"))
      .toThrow(/bound_projection_digest/);
  });

  it("requires exact identity schemes instead of silently correcting them", () => {
    expect(() =>
      parseFamilySpec(
        { ...family, identity: { ...family.identity, dataset_id_scheme: "build_hash" } },
        "$",
      ),
    ).toThrow(/dataset_id_scheme|ds_hash/);
  });

  it("requires exact lowercase SHA-256 dataset identities", () => {
    expect(parseDatasetIdentity({ dataset_id: DS, dataset_revision_id: DSREV, asset_id: ASSET }, "$"))
      .toEqual({ dataset_id: DS, dataset_revision_id: DSREV, asset_id: ASSET });
    expect(() => parseDatasetIdentity({ dataset_id: `ds_${A.toUpperCase()}`, dataset_revision_id: DSREV, asset_id: ASSET }, "$"))
      .toThrow(/dataset_id/);
    expect(() => parseDatasetIdentity({ dataset_id: DS, dataset_revision_id: "dsrev_short", asset_id: ASSET }, "$"))
      .toThrow(/dataset_revision_id/);
  });

  it("rejects control, bidi, traversal, non-NFC refs, and uppercase hashes", () => {
    const good = { scope: "curated", id: "fs_x", version: "2.0.0", digest: A };
    for (const id of ["fs\u0000x", "fs\u202Ex", "../fs_x", "e\u0301"]) {
      expect(() => parseScopeQualifiedRef({ ...good, id }, "$")) .toThrow();
    }
    expect(() => parseScopeQualifiedRef({ ...good, digest: A.toUpperCase() }, "$")) .toThrow(/hex|SHA/i);
  });

  it("represents an unavailable backend honestly and binds backend to terminal state", () => {
    const unavailable: TransformExecutionReceipt = {
      ...receipt,
      sandbox_backend: "unavailable",
      exit_state: "sandbox_unavailable",
      exit_code: null,
      exit_signal: null,
      wall_ms: 0,
      cpu_ms: 0,
      rss_bytes: 0,
      temp_bytes: 0,
      output_bytes: 0,
      log_bytes: 0,
      quarantined_output_receipts: [],
    };
    expect(parseTransformExecutionReceipt(unavailable, "$")).toEqual(unavailable);
    expect(() => parseTransformExecutionReceipt({
      ...receipt,
      sandbox_backend: "unavailable",
    }, "$")) .toThrow(/unavailable|sandbox_backend|exit_state/);
    expect(() => parseTransformExecutionReceipt({
      ...unavailable,
      sandbox_backend: "container",
    }, "$")) .toThrow(/unavailable|sandbox_backend|exit_state/);
  });

  it("binds terminal, cancellation, deadline, and resource usage facts", () => {
    expect(() => parseTransformExecutionReceipt({
      ...receipt,
      exit_code: 1,
    }, "$")) .toThrow(/succeeded|exit_code/);
    expect(() => parseTransformExecutionReceipt({
      ...receipt,
      exit_state: "cancelled",
      exit_code: null,
    }, "$")) .toThrow(/cancelled|cancellation/);
    expect(() => parseTransformExecutionReceipt({
      ...receipt,
      deadline_at: "2026-08-20T23:59:59Z",
    }, "$")) .toThrow(/deadline|timestamp/);
    expect(() => parseTransformExecutionReceipt({
      ...receipt,
      output_bytes: receipt.resource_limits.output_bytes + 1,
    }, "$")) .toThrow(/output_bytes|limit/);
    expect(() => parseTransformExecutionReceipt({
      ...receipt,
      finished_at: "2026-08-21T00:02:00Z",
      host_issued_at: "2026-08-21T00:02:01Z",
    }, "$")) .toThrow(/deadline/);
    expect(() => parseTransformExecutionReceipt({
      ...receipt,
      cancellation_state: "requested",
      cancel_requested_at: "2026-08-20T23:59:59Z",
    }, "$")) .toThrow(/cancel_requested_at/);
    expect(() => parseTransformExecutionReceipt({
      ...receipt,
      output_bytes: 29,
    }, "$")) .toThrow(/receipt sizes|output_bytes/);
  });

  it("rejects unsafe integers, invalid cancellation state, and non-canonical timestamps", () => {
    expect(() => parseTransformExecutionReceipt({ ...receipt, attempt: Number.MAX_SAFE_INTEGER + 1 }, "$"))
      .toThrow(/safe|integer/i);
    expect(() => parseTransformExecutionReceipt({ ...receipt, resource_limits: { ...receipt.resource_limits, rss_bytes: Number.MAX_SAFE_INTEGER + 1 } }, "$"))
      .toThrow(/safe|integer/i);
    expect(() => parseTransformExecutionReceipt({ ...receipt, cancellation_state: "cancelled" }, "$"))
      .toThrow(/cancellation_state/);
    expect(() => parseTransformExecutionReceipt({ ...receipt, host_issued_at: "2026-08-21T01:00:02+01:00" }, "$"))
      .toThrow(/ISO|host_issued_at/);
    expect(() => parseTransformExecutionReceipt({ ...receipt, host_issued_at: "2026-02-30T00:00:00Z" }, "$"))
      .toThrow(/ISO|host_issued_at/);
  });
});

describe("FamilySpec canonical digest closure", () => {
  it("excludes only canonical_digest and preserves every declared array order", async () => {
    const canonical = buildFamilySpecDigestCanonical(family);
    expect(canonical).not.toContain("canonical_digest");
    const digest = await computeFamilySpecDigest(family);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyFamilySpecDigest({ ...family, canonical_digest: digest })).toBe(true);
    expect(await verifyFamilySpecDigest({ ...family, canonical_digest: B })).toBe(false);

    const reordered: FamilySpec = {
      ...family,
      evidence_refs: ["evidence_b", "evidence_a"],
    };
    const reversed: FamilySpec = {
      ...reordered,
      evidence_refs: [...reordered.evidence_refs].reverse(),
    };
    await expect(computeFamilySpecDigest(reordered)).resolves.not.toBe(
      await computeFamilySpecDigest(reversed),
    );
  });

  it("has a stable known vector and ignores the embedded digest value", async () => {
    const first = await computeFamilySpecDigest(family);
    const second = await computeFamilySpecDigest({ ...family, canonical_digest: D });
    expect(second).toBe(first);
    expect(first).toBe("8fe7a1d6f07000ca22e9257e76bda5bf716b28099fd90b8bb03fb2c1873d9290");
  });
});

describe("implementation and descriptor canonical digest closure", () => {
  it("strictly parses ImplementationDigestInput and rejects unknown/invalid fields", () => {
    expect(parseImplementationDigestInput(implementationInput, "$")) .toEqual(implementationInput);
    expect(() => parseImplementationDigestInput({ ...implementationInput, source_path: "src/index.ts" }, "$"))
      .toThrow(/Unknown field|source_path/);
    expect(() => parseImplementationDigestInput({ ...implementationInput, normalized_source_sha256: "short" }, "$"))
      .toThrow(/SHA|hex/i);
    expect(() => parseImplementationDigestInput({ ...implementationInput, compiler_id: "x".repeat(300) }, "$"))
      .toThrow(/length|long|characters/i);
  });

  it("matches the frozen implementation canonical string and digest vector", async () => {
    expect(buildImplementationDigestCanonical(implementationInput)).toBe(
      `{"compiler_id":"tsc","compiler_options_digest":"${C}","compiler_version":"5.6.3",` +
        `"dependency_closure_digest":"${D}","emitted_bundle_sha256":"${B}",` +
        `"host_policy_version":"1.0.0","normalized_source_sha256":"${A}",` +
        '"runtime_abi_version":"1.0.0"}',
    );
    await expect(computeImplementationDigest(implementationInput))
      .resolves.toBe("ae04c2edfbbe54c67d33944eeee500a0ea314eaa6088b4ac594529cee26f9b43");
  });

  it("changes digest when any of the eight implementation components changes", async () => {
    const baseline = await computeImplementationDigest(implementationInput);
    const variants: ImplementationDigestInput[] = [
      { ...implementationInput, normalized_source_sha256: B },
      { ...implementationInput, emitted_bundle_sha256: C },
      { ...implementationInput, compiler_id: "swc" },
      { ...implementationInput, compiler_version: "5.7.0" },
      { ...implementationInput, compiler_options_digest: D },
      { ...implementationInput, dependency_closure_digest: A },
      { ...implementationInput, runtime_abi_version: "1.1.0" },
      { ...implementationInput, host_policy_version: "1.1.0" },
    ];
    for (const variant of variants) {
      await expect(computeImplementationDigest(variant)).resolves.not.toBe(baseline);
    }
  });

  it("builds an independent descriptor digest closure over code, family/projection, IO, and policies", () => {
    const baseline = buildTransformDescriptorDigestCanonical(descriptorDigestInput);
    const changes: TransformDescriptorDigestInput[] = [
      { ...descriptorDigestInput, entrypoint: "transform.other" },
      { ...descriptorDigestInput, implementation_digest: C },
      { ...descriptorDigestInput, bound_family_spec_digest: C },
      { ...descriptorDigestInput, bound_projection_digest: D },
      { ...descriptorDigestInput, declared_input_roles: [] },
      { ...descriptorDigestInput, declared_output_tables: [] },
      { ...descriptorDigestInput, runtime_policy_digest: A },
      { ...descriptorDigestInput, import_policy_digest: B },
      { ...descriptorDigestInput, resource_policy_digest: C },
    ];
    for (const changed of changes) {
      expect(buildTransformDescriptorDigestCanonical(changed)).not.toBe(baseline);
    }
  });
});

describe("BuildSpec 2.0 proposal/resolved split", () => {
  it("parses proposal and resolved contracts through distinct parsers", () => {
    expect(parseDatasetBuildProposal2(proposalBuild, "$").spec_kind).toBe("proposal");
    expect(parseResolvedDatasetBuildSpec2(resolvedBuild, "$").spec_kind).toBe("resolved");
  });

  it("requires exactly one registered handle for each resolved binding", () => {
    const binding = resolvedBuild.source_bindings[0];
    if (!binding) throw new Error("test fixture binding missing");
    expect(() => parseResolvedDatasetBuildSpec2({
      ...resolvedBuild,
      source_bindings: [{ ...binding, registered_asset_ref: null, registered_result_ref: null }],
    }, "$")) .toThrow(/exactly one|registered/i);
    expect(() => parseResolvedDatasetBuildSpec2({
      ...resolvedBuild,
      source_bindings: [{ ...binding, registered_result_ref: "result_1" }],
    }, "$")) .toThrow(/exactly one|registered/i);
  });

  it("never accepts a proposal through the resolved or compatibility parser", () => {
    expect(() => parseResolvedDatasetBuildSpec2(proposalBuild, "$")) .toThrow(/proposal|resolved|spec_kind/);
    expect(() => parseDatasetBuildSpec2(proposalBuild, "$")) .toThrow(/proposal|resolved|spec_kind/);
    expect(parseDatasetBuildSpec2(resolvedBuild, "$")) .toEqual(parseResolvedDatasetBuildSpec2(resolvedBuild, "$"));
  });

  it("rejects 1.0/2.0 hybrid objects without fallback sniffing", () => {
    expect(() => parseResolvedDatasetBuildSpec2({ ...resolvedBuild, schema_version: "1.0" }, "$")) .toThrow(/2.0/);
    expect(() => parseResolvedDatasetBuildSpec2({ ...resolvedBuild, objective: "hybrid" }, "$"))
      .toThrow(/Unknown field|objective/);
    const withoutKind = { ...resolvedBuild } as Record<string, unknown>;
    delete withoutKind.spec_kind;
    expect(() => parseDatasetBuildSpec2(withoutKind, "$")) .toThrow(/spec_kind|required/);
  });
});
