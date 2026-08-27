import { describe, expect, it } from "vitest";

import {
  buildImplementationDigestCanonical,
  computeImplementationDigest,
  parseAuditArtifactDefinition,
  parseResolvedDatasetExecutionSpec2,
  parseDatasetIdentity,
  parseDatasetTransform,
  parseFamilySpec,
  parseProbeMappingAssertion,
  parseProjection,
  parseSampleIdentity,
  parseScopeQualifiedRef,
  parseTransformExecutionReceipt,
  stableStringify,
  type ResolvedDatasetExecutionSpec2,
  type DatasetTransform,
  type FamilySpec,
  type ScopeQualifiedRef,
  type TransformExecutionReceipt,
} from "../src/family-transform";

const HEX = "a".repeat(64);
const HEX_B = "b".repeat(64);
const DATASET_ID = `ds_${HEX}`;
const DATASET_REVISION_ID = `dsrev_${HEX_B}`;
const ASSET_ID = `asset_${HEX}`;

describe("A-T1 FamilySpec contract (strict, code-free)", () => {
  const baseFamily: FamilySpec = {
    family_spec_id: "fs_gene_expression",
    semantic_version: "2.0.0",
    canonical_digest: HEX,
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

  it("parses a valid FamilySpec", () => {
    const parsed = parseFamilySpec(baseFamily, "$");
    expect(parsed.family_spec_id).toBe("fs_gene_expression");
    expect(parsed.scope).toBe("curated");
  });

  it("REJECTS unknown fields (fail closed)", () => {
    const bad = { ...baseFamily, source_code: "console.log('x')" } as unknown as FamilySpec;
    expect(() => parseFamilySpec(bad, "$")).toThrow(/Unknown field|source_code/);
  });

  it("REJECTS attempt to smuggle a validator/merge function", () => {
    const bad = { ...baseFamily, merge_function: "()=>{}" } as unknown as FamilySpec;
    expect(() => parseFamilySpec(bad, "$")).toThrow(/Unknown field|merge_function/);
  });

  it("REJECTS invalid scope enum", () => {
    const bad = { ...baseFamily, scope: "builtin" } as unknown as FamilySpec;
    expect(() => parseFamilySpec(bad, "$")).toThrow();
  });

  it("REJECTS unknown fields nested in table_definitions (fail closed)", () => {
    const bad = {
      ...baseFamily,
      table_definitions: [
        {
          table_id: "t",
          schema_ref: "schema",
          role: "primary",
          required: true,
          allow_empty: false,
          primary_key: ["id"],
          field_names: ["id"],
          smuggled_path: "/etc/passwd",
        },
      ],
    } as unknown as FamilySpec;
    expect(() => parseFamilySpec(bad, "$")).toThrow(/Unknown field|smuggled_path/);
  });

  it("REJECTS invalid relation cardinality / missing_policy", () => {
    const bad = {
      ...baseFamily,
      relations: [
        {
          relation_id: "r",
          from_table_id: "a",
          from_fields: ["x"],
          to_table_id: "b",
          to_fields: ["y"],
          cardinality: "many_to_many",
          missing_policy: "explodes",
        },
      ],
    } as unknown as FamilySpec;
    expect(() => parseFamilySpec(bad, "$")).toThrow();
  });
});

describe("A-T1 DatasetExecutionSpec 1.0 snapshot untouched + 2.0 separated", () => {
  it("parses a resolved execution spec with refs only", () => {
    const ref: ScopeQualifiedRef = { scope: "curated", id: "fs_x", version: "2.0.0", digest: HEX };
    const spec2: ResolvedDatasetExecutionSpec2 = {
      schema_version: "2.0",
      spec_kind: "resolved",
      requirement_id: "build_1",
      family_spec_ref: ref,
      projection_ref: "proj_gene",
      source_bindings: [],
      transform_refs: [ref],
      policy_refs: [],
      output_format: "multitable",
      idempotency_identity: "idem_1",
    };
    const parsed = parseResolvedDatasetExecutionSpec2(spec2, "$");
    expect(parsed.schema_version).toBe("2.0");
    expect(parsed.family_spec_ref.digest).toBe(HEX);
  });

  it("rejects schema_refs injected into an execution spec", () => {
    const ref: ScopeQualifiedRef = { scope: "curated", id: "fs_x", version: "2.0.0", digest: HEX };
    const bad = {
      schema_version: "2.0",
      spec_kind: "resolved",
      requirement_id: "build_1",
      family_spec_ref: ref,
      projection_ref: "proj_gene",
      source_bindings: [],
      transform_refs: [ref],
      policy_refs: [],
      output_format: "multitable",
      idempotency_identity: "idem_1",
      schema_refs: ["x"],
    } as unknown as ResolvedDatasetExecutionSpec2;
    expect(() => parseResolvedDatasetExecutionSpec2(bad, "$")).toThrow(/Unknown field|schema_refs/);
  });
});

describe("A-T1 DatasetTransform descriptor + TransformExecutionReceipt", () => {
  const transform: DatasetTransform = {
    transform_id: "t_geo_series",
    version: "1.0.0",
    source_digest: HEX,
    bundle_digest: HEX,
    compiler_id: "tsc",
    compiler_version: "5.6.3",
    compiler_options_digest: HEX,
    runtime_abi_version: "1.0.0",
    runtime_policy_version: "1.0.0",
    dependency_closure_digest: HEX,
    code_bundle_ref: "bundle_" + HEX,
    entrypoint: "transform.run",
    declared_input_roles: [],
    declared_output_tables: [],
    bound_family_spec_digest: HEX,
    bound_projection_digest: HEX,
    determinism_profile: "deterministic",
    resource_class: "standard",
    origin: "agent",
    scope: "task",
    review_refs: [],
  };

  it("parses a valid DatasetTransform", () => {
    expect(parseDatasetTransform(transform, "$").transform_id).toBe("t_geo_series");
  });

  it("REJECTS unknown field in DatasetTransform", () => {
    const bad = { ...transform, network_permission: true } as unknown as DatasetTransform;
    expect(() => parseDatasetTransform(bad, "$")).toThrow(/Unknown field|network_permission/);
  });

  const receipt: TransformExecutionReceipt = {
    schema_version: "1.0",
    task_id: "task_1",
    run_id: "run_1",
    requirement_id: "build_1",
    invocation_id: "inv_1",
    attempt: 1,
    generation: 1,
    request_digest: HEX,
    parameters_digest: HEX,
    family_spec_digest: HEX,
    projection_digest: HEX,
    transform_digest: HEX,
    bundle_digest: HEX,
    compiler_digest: HEX,
    runtime_digest: HEX,
    policy_digest: HEX,
    input_asset_receipts: [],
    input_result_receipts: [],
    granted_capabilities: ["bounded_reader"],
    resource_limits: {
      wall_ms: 2000,
      cpu_ms: 1000,
      rss_bytes: 1,
      temp_bytes: 1,
      output_bytes: 1,
      log_bytes: 1,
      open_files: 64,
      pids: 1,
    },
    sandbox_backend: "container",
    sandbox_config_digest: HEX,
    exit_state: "succeeded",
    exit_code: 0,
    exit_signal: null,
    wall_ms: 10,
    cpu_ms: 10,
    rss_bytes: 1,
    temp_bytes: 1,
    output_bytes: 1,
    log_bytes: 1,
    quarantined_output_receipts: [],
    stdout_ref: "stdout_1",
    stderr_ref: "stderr_1",
    audit_refs: [],
    cancellation_state: "none",
    cancel_requested_at: null,
    deadline_at: "2026-08-21T00:01:00Z",
    started_at: "2026-08-21T00:00:00Z",
    finished_at: "2026-08-21T00:00:01Z",
    host_implementation_digest: HEX,
    host_issued_at: "2026-08-21T00:00:02Z",
  };

  it("parses valid isolated and honestly named unisolated receipts", () => {
    expect(parseTransformExecutionReceipt(receipt, "$").exit_state).toBe("succeeded");
    expect(parseTransformExecutionReceipt({
      ...receipt,
      sandbox_backend: "in_process_unisolated",
    }, "$").sandbox_backend).toBe("in_process_unisolated");
  });

  it("REJECTS a receipt missing any required digest", () => {
    const bad = { ...receipt, policy_digest: undefined } as unknown as TransformExecutionReceipt;
    expect(() => parseTransformExecutionReceipt(bad, "$")).toThrow();
  });

  it("REJECTS unknown terminal reason", () => {
    const bad = { ...receipt, exit_state: "exploited" } as unknown as TransformExecutionReceipt;
    expect(() => parseTransformExecutionReceipt(bad, "$")).toThrow();
  });
});

describe("A-T2 identity / projection / relation / audit", () => {
  it("parses dataset/sample/probe identity (no requirement_id leakage)", () => {
    const id = parseDatasetIdentity(
      { dataset_id: DATASET_ID, dataset_revision_id: DATASET_REVISION_ID, asset_id: ASSET_ID },
      "$",
    );
    expect(id.dataset_id).toBe(DATASET_ID);
    expect(id.dataset_id).not.toMatch(/^build_/);
  });

  it("REJECTS dataset_id that equals a requirement_id shape", () => {
    expect(() =>
      parseDatasetIdentity(
        { dataset_id: "build_123", dataset_revision_id: DATASET_REVISION_ID, asset_id: ASSET_ID },
        "$",
      ),
    ).toThrow(/dataset_id|build/);
  });

  it("parses sample composite key (dataset_revision_id, sample_id)", () => {
    const s = parseSampleIdentity({ dataset_revision_id: DATASET_REVISION_ID, sample_id: "S1" }, "$");
    expect(s.sample_id).toBe("S1");
  });

  it("parses probe mapping assertion with mapping_assertion_id PK", () => {
    const p = parseProbeMappingAssertion(
      {
        mapping_assertion_id: "ma_1",
        dataset_revision_id: DATASET_REVISION_ID,
        mapping_scope_id: "scope_1",
        platform_id: "plat_1",
        probe_id: "pb_1",
        target_gene_id: null,
        target_namespace: null,
        annotation_asset_id: ASSET_ID,
        mapping_rule_id: "rule_1",
        mapping_status: "unmapped",
      },
      "$",
    );
    expect(p.mapping_assertion_id).toBe("ma_1");
  });

  it("REJECTS audit as a TableRole (audit is a separate artifact)", () => {
    const proj = parseProjection(
      {
        projection_id: "proj_gene",
        schema_version: "2.0",
        primary_tables: ["expression"],
        supporting_tables: [],
        derived_tables: [],
        required: ["expression"],
        optional: [],
        allow_empty: [],
        relations: [],
        row_granularity: "gene_sample",
        compatibility_dimensions: ["taxon", "unit"],
        merge_identity_fields: ["dataset_revision_id", "sample_id"],
        validation_policy_ref: "pol_val",
        assessment_policy_ref: "pol_assess",
      },
      "$",
    );
    expect(proj.primary_tables).toEqual(["expression"]);
  });

  it("parses AuditArtifactDefinition (distinct from TableRole)", () => {
    const a = parseAuditArtifactDefinition(
      {
        artifact_id: "audit_1",
        schema_ref: "audit.reject.v1",
        fields: ["row", "reason"],
        locator_ref: "loc_1",
        receipt_ref: "rcpt_1",
        append_only: true,
      },
      "$",
    );
    expect(a.append_only).toBe(true);
  });
});

describe("A-T3 implementation identity digest (frozen algorithm)", () => {
  const input = {
    normalized_source_sha256: HEX,
    emitted_bundle_sha256: HEX,
    compiler_id: "tsc",
    compiler_version: "5.6.3",
    compiler_options_digest: HEX,
    dependency_closure_digest: HEX,
    runtime_abi_version: "1.0.0",
    host_policy_version: "1.0.0",
  };

  it("stableStringify is order- and unicode-stable", () => {
    const a = stableStringify({ b: 1, a: "é" });
    const b = stableStringify({ a: "é", b: 1 });
    expect(a).toBe(b);
  });

  it("same inputs -> identical canonical + digest", async () => {
    const c1 = buildImplementationDigestCanonical(input);
    const c2 = buildImplementationDigestCanonical({ ...input });
    expect(c1).toBe(c2);
    const d1 = await computeImplementationDigest(input);
    const d2 = await computeImplementationDigest(input);
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different source bytes -> different digest", async () => {
    const d1 = await computeImplementationDigest(input);
    const d2 = await computeImplementationDigest({ ...input, normalized_source_sha256: "b".repeat(64) });
    expect(d1).not.toBe(d2);
  });

  it("different compiler/dependency/policy -> different digest", async () => {
    const d1 = await computeImplementationDigest(input);
    const d2 = await computeImplementationDigest({ ...input, compiler_version: "5.7.0" });
    const d3 = await computeImplementationDigest({ ...input, dependency_closure_digest: "c".repeat(64) });
    expect(d1).not.toBe(d2);
    expect(d1).not.toBe(d3);
  });
});

describe("A-T1 scope-qualified ref resolution contract", () => {
  it("requires exact scope+id+version+digest", () => {
    const ref = parseScopeQualifiedRef({ scope: "curated", id: "fs_x", version: "2.0.0", digest: HEX }, "$");
    expect(ref.id).toBe("fs_x");
  });

  it("REJECTS missing digest", () => {
    expect(() =>
      parseScopeQualifiedRef({ scope: "curated", id: "fs_x", version: "2.0.0" } as never, "$"),
    ).toThrow();
  });
});
