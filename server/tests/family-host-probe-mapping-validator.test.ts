import type { ProbeMappingAssertion } from "@biomed/contracts";
import { describe, expect, it } from "vitest";

import {
  TrustedProbeMappingCorePolicyRegistry,
  validateProbeMappingAssertions,
  validateProbeMappingAssertionsWithTrustedCorePolicy,
  type CoreOwnedProbeMappingPolicy,
  type ProbeMappingValidationInput,
  type ProbeMappingValidationReport,
} from "../src/dataset/relations/index.js";

const REVISION = `dsrev_${"a".repeat(64)}`;
const OTHER_REVISION = `dsrev_${"b".repeat(64)}`;
const ASSET_A = `asset_${"c".repeat(64)}`;
const ASSET_B = `asset_${"d".repeat(64)}`;
const ASSET_OUTSIDE_CLOSURE = `asset_${"e".repeat(64)}`;
const RECEIPT_A = "receipt:annotation:asset-a";
const RECEIPT_B = "receipt:annotation:asset-b";
const SCOPE = "geo.gpl570.annotation-v7";
const PLATFORM = "GPL570";
const SOURCE_PROBES = Array.from(
  { length: 8 },
  (_value, index) => `probe_${String(index + 1).padStart(2, "0")}`,
);

const CORE_POLICY = {
  policy_id: "core.probe-mapping.release.v7",
  max_unmapped_ratio: 0.15,
  max_ambiguous_ratio: 0.15,
  max_invalid_ratio: 0,
  max_unresolved_ratio: 0.3,
  distinct_mapped_target_policy: "require_ambiguous",
} satisfies CoreOwnedProbeMappingPolicy;

const WIDE_FIXTURE_POLICY = {
  policy_id: "core.probe-mapping.fixture-wide.v1",
  max_unmapped_ratio: 1,
  max_ambiguous_ratio: 1,
  max_invalid_ratio: 1,
  max_unresolved_ratio: 1,
  distinct_mapped_target_policy: "require_ambiguous",
} satisfies CoreOwnedProbeMappingPolicy;

const REJECT_MULTI_TARGET_POLICY = {
  ...WIDE_FIXTURE_POLICY,
  policy_id: "core.probe-mapping.fixture-reject-multi-target.v1",
  distinct_mapped_target_policy: "reject",
} satisfies CoreOwnedProbeMappingPolicy;

const POLICY_REGISTRY = new TrustedProbeMappingCorePolicyRegistry([
  CORE_POLICY,
  WIDE_FIXTURE_POLICY,
  REJECT_MULTI_TARGET_POLICY,
]);

function assertion(
  overrides: Partial<ProbeMappingAssertion> = {},
): ProbeMappingAssertion {
  return {
    mapping_assertion_id: "declared_assertion_01",
    dataset_revision_id: REVISION,
    mapping_scope_id: SCOPE,
    platform_id: PLATFORM,
    probe_id: SOURCE_PROBES[0]!,
    target_gene_id: "ENSG00000000001",
    target_namespace: "ensembl_gene",
    annotation_asset_id: ASSET_A,
    mapping_rule_id: "geo.probe-map.ensembl.v3",
    mapping_status: "mapped",
    ...overrides,
  };
}

function validAssertions(): ProbeMappingAssertion[] {
  return SOURCE_PROBES.map((probeId, index) => {
    if (index === 6) {
      return assertion({
        mapping_assertion_id: "declared_assertion_07",
        probe_id: probeId,
        target_gene_id: null,
        target_namespace: null,
        annotation_asset_id: ASSET_B,
        mapping_rule_id: "geo.probe-map.unmapped.v1",
        mapping_status: "unmapped",
      });
    }
    if (index === 7) {
      return assertion({
        mapping_assertion_id: "declared_assertion_08",
        probe_id: probeId,
        target_gene_id: null,
        target_namespace: null,
        mapping_status: "ambiguous",
      });
    }
    if (index === 5) {
      return assertion({
        mapping_assertion_id: "declared_assertion_06",
        probe_id: probeId,
        target_gene_id: "7157",
        target_namespace: "ncbi_gene",
        annotation_asset_id: ASSET_B,
        mapping_rule_id: "geo.probe-map.entrez.v2",
      });
    }
    return assertion({
      mapping_assertion_id: `declared_assertion_${String(index + 1).padStart(2, "0")}`,
      probe_id: probeId,
      target_gene_id: `ENSG${String(index + 1).padStart(11, "0")}`,
    });
  });
}

function request(
  overrides: Partial<ProbeMappingValidationInput> = {},
): ProbeMappingValidationInput {
  return {
    dataset_revision_id: REVISION,
    mapping_scope_id: SCOPE,
    platform_id: PLATFORM,
    source_probe_ids: [...SOURCE_PROBES],
    assertions: validAssertions(),
    policy_id: CORE_POLICY.policy_id,
    expected_annotation_asset_receipt_refs: [
      { annotation_asset_id: ASSET_A, receipt_ref: RECEIPT_A },
      { annotation_asset_id: ASSET_B, receipt_ref: RECEIPT_B },
    ],
    ...overrides,
  };
}

function validate(
  input: unknown,
  registry = POLICY_REGISTRY,
): ProbeMappingValidationReport {
  return validateProbeMappingAssertions(input, registry);
}

function issueCodes(result: ProbeMappingValidationReport): string[] {
  return result.issues.map((item) => item.code);
}

function oneProbeRequest(
  rows: readonly unknown[],
  policyId = WIDE_FIXTURE_POLICY.policy_id,
): ProbeMappingValidationInput {
  return request({
    source_probe_ids: [SOURCE_PROBES[0]!],
    assertions: rows,
    policy_id: policyId,
  });
}

describe("Family Host probe-mapping pure validator", () => {
  it("accepts unfrozen plain rows through the contracts parser and derives coverage from rows", () => {
    const input = request();
    const result = validate(input);

    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.assertions[0])).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.report_kind).toBe("probe_mapping_validation_report");
    expect(result.summary).toEqual({
      source_probe_count: 8,
      assertion_row_count: 8,
      unique_assertion_id_count: 8,
      valid_assertion_count: 8,
      evidenced_probe_count: 8,
      missing_evidence_probe_count: 0,
      unknown_source_assertion_count: 0,
      mapped_probe_count: 6,
      unmapped_probe_count: 1,
      ambiguous_probe_count: 1,
      invalid_probe_count: 0,
      mapped_ratio: 0.75,
      unmapped_ratio: 0.125,
      ambiguous_ratio: 0.125,
      invalid_ratio: 0,
      unresolved_ratio: 0.25,
    });
    expect(result.assertion_identity).toEqual({
      primary_key: "mapping_assertion_id",
      identity_basis: "declared",
      formula_verified: false,
    });
    expect(result.declared_closure).toEqual({
      dataset_revision_id: REVISION,
      mapping_scope_id: SCOPE,
      platform_id: PLATFORM,
      annotation_asset_receipt_refs: [
        { annotation_asset_id: ASSET_A, receipt_ref: RECEIPT_A },
        { annotation_asset_id: ASSET_B, receipt_ref: RECEIPT_B },
      ],
    });
    expect(result.annotation_asset_ids).toEqual([ASSET_A, ASSET_B]);
    expect(result.mapping_rule_ids).toEqual([
      "geo.probe-map.ensembl.v3",
      "geo.probe-map.entrez.v2",
      "geo.probe-map.unmapped.v1",
    ]);
    expect(result.target_namespaces).toEqual(["ensembl_gene", "ncbi_gene"]);
  });

  it("allows multiple annotation assets, rules, and target namespaces in one mapping scope", () => {
    const result = validate(request());

    expect(issueCodes(result)).not.toContain("mapping_scope_fact_conflict");
    expect(result.annotation_asset_ids).toHaveLength(2);
    expect(result.mapping_rule_ids.length).toBeGreaterThan(1);
    expect(result.target_namespaces).toEqual(["ensembl_gene", "ncbi_gene"]);
  });

  it("rejects assertion accessors and proxies without reading them", () => {
    let accessorReads = 0;
    const accessorRow = assertion();
    Object.defineProperty(accessorRow, "probe_id", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return SOURCE_PROBES[0];
      },
    });
    const accessorResult = validate(oneProbeRequest([accessorRow]));

    expect(issueCodes(accessorResult)).toContain("assertion_contract_invalid");
    expect(accessorReads).toBe(0);

    let proxyReads = 0;
    const proxyRow = new Proxy(assertion(), {
      get(target, key, receiver) {
        proxyReads += 1;
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        proxyReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf(target) {
        proxyReads += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        proxyReads += 1;
        return Reflect.ownKeys(target);
      },
    });
    const proxyResult = validate(oneProbeRequest([proxyRow]));

    expect(issueCodes(proxyResult)).toContain("assertion_contract_invalid");
    expect(proxyReads).toBe(0);
  });

  it("rejects top-level input accessors and proxies without reading them", () => {
    let accessorReads = 0;
    const accessorInput = request();
    Object.defineProperty(accessorInput, "dataset_revision_id", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return REVISION;
      },
    });
    expect(issueCodes(validate(accessorInput))).toEqual(["input_contract_invalid"]);
    expect(accessorReads).toBe(0);

    let proxyReads = 0;
    const proxyInput = new Proxy(request(), {
      get(target, key, receiver) {
        proxyReads += 1;
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        proxyReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf(target) {
        proxyReads += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        proxyReads += 1;
        return Reflect.ownKeys(target);
      },
    });
    expect(issueCodes(validate(proxyInput))).toEqual(["input_contract_invalid"]);
    expect(proxyReads).toBe(0);
  });

  it("strictly parses Core-owned policies and never treats freeze as trust", () => {
    const mutablePolicy = { ...CORE_POLICY };
    expect(Object.isFrozen(mutablePolicy)).toBe(false);
    const registry = new TrustedProbeMappingCorePolicyRegistry([mutablePolicy]);
    expect(registry.policyIds()).toEqual([CORE_POLICY.policy_id]);

    expect(() => new TrustedProbeMappingCorePolicyRegistry([{
      ...CORE_POLICY,
      caller_override: true,
    }])).toThrow(/unknown fields/i);

    expect(() => new TrustedProbeMappingCorePolicyRegistry([
      Object.assign(Object.create({ inherited: true }), CORE_POLICY),
    ])).toThrow(/prototype/i);

    for (const ratio of [Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01]) {
      expect(() => new TrustedProbeMappingCorePolicyRegistry([{
        ...CORE_POLICY,
        max_unmapped_ratio: ratio,
      }])).toThrow(/finite|ratio|number/i);
    }

    let getterReads = 0;
    const getterPolicy = { ...CORE_POLICY };
    Object.defineProperty(getterPolicy, "max_unmapped_ratio", {
      enumerable: true,
      get() {
        getterReads += 1;
        return 1;
      },
    });
    expect(() => new TrustedProbeMappingCorePolicyRegistry([getterPolicy])).toThrow(/accessor/i);
    expect(getterReads).toBe(0);

    let proxyReads = 0;
    const proxyPolicy = new Proxy({ ...CORE_POLICY }, {
      get(target, key, receiver) {
        proxyReads += 1;
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        proxyReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf(target) {
        proxyReads += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        proxyReads += 1;
        return Reflect.ownKeys(target);
      },
    });
    expect(() => new TrustedProbeMappingCorePolicyRegistry([proxyPolicy])).toThrow(/proxy/i);
    expect(proxyReads).toBe(0);
  });

  it("lets callers select only registered policy IDs, not submit arbitrary wider values", () => {
    const unknown = validate(request({ policy_id: "caller.arbitrary-wide.v1" }));
    expect(issueCodes(unknown)).toContain("unknown_policy_id");
    expect(unknown.policy).toBeNull();

    const smuggled = validate({
      ...request(),
      profile_policy: {
        ...WIDE_FIXTURE_POLICY,
        policy_id: CORE_POLICY.policy_id,
      },
    });
    expect(issueCodes(smuggled)).toEqual(["input_contract_invalid"]);

    const mismatch = validateProbeMappingAssertionsWithTrustedCorePolicy(
      request(),
      WIDE_FIXTURE_POLICY,
    );
    expect(issueCodes(mismatch)).toContain("policy_id_mismatch");
  });

  it("uses injected policy ratios instead of a validator-owned threshold", () => {
    const strictPolicy = {
      ...WIDE_FIXTURE_POLICY,
      policy_id: "core.probe-mapping.fixture-strict-unmapped.v1",
      max_unmapped_ratio: 0.1,
    } satisfies CoreOwnedProbeMappingPolicy;
    const registry = new TrustedProbeMappingCorePolicyRegistry([strictPolicy]);
    const result = validate(request({ policy_id: strictPolicy.policy_id }), registry);

    expect(issueCodes(result)).toContain("unmapped_ratio_exceeded");
    expect(result.policy).toEqual(strictPolicy);
    expect(result.summary.unmapped_ratio).toBe(0.125);
  });

  it("requires mapped and unmapped target fields to match their status", () => {
    const mappedWithoutTarget = validate(oneProbeRequest([assertion({
      target_gene_id: null,
      target_namespace: null,
    })]));
    expect(issueCodes(mappedWithoutTarget)).toContain("mapping_target_invalid");

    const unmappedWithTarget = validate(oneProbeRequest([assertion({
      mapping_status: "unmapped",
    })]));
    expect(issueCodes(unmappedWithTarget)).toContain("mapping_target_invalid");

    const ambiguousHalfTarget = validate(oneProbeRequest([assertion({
      mapping_status: "ambiguous",
      target_namespace: null,
    })]));
    expect(issueCodes(ambiguousHalfTarget)).toContain("mapping_target_invalid");
  });

  it("preserves complete ambiguous candidate evidence", () => {
    const rows = [
      assertion({
        mapping_assertion_id: "declared_candidate_a",
        mapping_status: "ambiguous",
      }),
      assertion({
        mapping_assertion_id: "declared_candidate_b",
        target_gene_id: "7157",
        target_namespace: "ncbi_gene",
        annotation_asset_id: ASSET_B,
        mapping_rule_id: "geo.probe-map.entrez.v2",
        mapping_status: "ambiguous",
      }),
    ];
    const result = validate(oneProbeRequest(rows));

    expect(result.passed).toBe(true);
    expect(result.probes[0]).toMatchObject({
      coverage_status: "ambiguous",
      mapping_assertion_ids: ["declared_candidate_a", "declared_candidate_b"],
    });
    expect(result.annotation_asset_ids).toEqual([ASSET_A, ASSET_B]);
    expect(result.target_namespaces).toEqual(["ensembl_gene", "ncbi_gene"]);
  });

  it("does not count multiple distinct mapped targets as mapped", () => {
    const rows = [
      assertion({ mapping_assertion_id: "declared_target_a" }),
      assertion({
        mapping_assertion_id: "declared_target_b",
        target_gene_id: "ENSG00000000002",
      }),
    ];
    const requireAmbiguous = validate(oneProbeRequest(rows));

    expect(issueCodes(requireAmbiguous)).toContain("distinct_mapped_targets_require_ambiguous");
    expect(requireAmbiguous.summary).toMatchObject({
      mapped_probe_count: 0,
      invalid_probe_count: 1,
    });

    const reject = validate(oneProbeRequest(
      rows,
      REJECT_MULTI_TARGET_POLICY.policy_id,
    ));
    expect(issueCodes(reject)).toContain("distinct_mapped_targets_rejected");
    expect(reject.summary.mapped_probe_count).toBe(0);
  });

  it("counts absent assertions as missing invalid evidence, never as unmapped", () => {
    const result = validate(request({
      source_probe_ids: [SOURCE_PROBES[0]!, SOURCE_PROBES[1]!],
      assertions: [assertion()],
      policy_id: WIDE_FIXTURE_POLICY.policy_id,
    }));

    expect(issueCodes(result)).toContain("missing_probe_evidence");
    expect(result.summary).toMatchObject({
      source_probe_count: 2,
      evidenced_probe_count: 1,
      missing_evidence_probe_count: 1,
      mapped_probe_count: 1,
      unmapped_probe_count: 0,
      invalid_probe_count: 1,
    });
    expect(result.probes[1]).toMatchObject({
      composite_key: [REVISION, SCOPE, PLATFORM, SOURCE_PROBES[1]],
      coverage_status: "invalid",
      mapping_assertion_ids: [],
    });
  });

  it("rejects duplicate declared assertion IDs, especially for different facts", () => {
    const first = assertion();
    const conflict = validate(oneProbeRequest([
      first,
      assertion({ target_gene_id: "ENSG00000000002" }),
    ]));
    expect(issueCodes(conflict)).toContain("assertion_id_conflict");
    expect(conflict.summary.invalid_probe_count).toBe(1);

    const duplicate = validate(oneProbeRequest([first, { ...first }]));
    expect(issueCodes(duplicate)).toContain("duplicate_assertion_id");
  });

  it.each([
    ["dataset revision", { dataset_revision_id: OTHER_REVISION }, "dataset_revision_mismatch"],
    ["mapping scope", { mapping_scope_id: "geo.other-scope" }, "mapping_scope_mismatch"],
    ["platform", { platform_id: "GPL96" }, "platform_mismatch"],
    ["source probe", { probe_id: "probe_outside_source" }, "unknown_source_probe"],
    [
      "annotation asset",
      { annotation_asset_id: ASSET_OUTSIDE_CLOSURE },
      "annotation_asset_mismatch",
    ],
  ] as const)("rejects assertions outside the declared %s closure", (_name, rowOverride, code) => {
    const result = validate(oneProbeRequest([assertion(rowOverride)]));

    expect(issueCodes(result)).toContain(code);
    expect(result.passed).toBe(false);
  });

  it("requires opaque registry receipt refs instead of paths or URIs", () => {
    for (const receiptRef of [
      "../receipts/annotation.json",
      "C:/receipts/annotation.json",
      "file:/receipts/annotation.json",
      "https://example.test/receipt",
    ]) {
      const result = validate(request({
        expected_annotation_asset_receipt_refs: [
          { annotation_asset_id: ASSET_A, receipt_ref: receiptRef },
        ],
      }));
      expect(issueCodes(result)).toEqual(["input_contract_invalid"]);
    }
  });

  it("fails closed on missing or duplicate annotation receipt closure", () => {
    const empty = validate(request({
      expected_annotation_asset_receipt_refs: [],
      policy_id: WIDE_FIXTURE_POLICY.policy_id,
    }));
    expect(issueCodes(empty)).toContain("empty_annotation_asset_receipt_closure");
    expect(issueCodes(empty)).toContain("annotation_asset_mismatch");

    const duplicate = validate(request({
      expected_annotation_asset_receipt_refs: [
        { annotation_asset_id: ASSET_A, receipt_ref: RECEIPT_A },
        { annotation_asset_id: ASSET_A, receipt_ref: "receipt:annotation:duplicate" },
        { annotation_asset_id: ASSET_B, receipt_ref: RECEIPT_B },
      ],
    }));
    expect(issueCodes(duplicate)).toContain("duplicate_annotation_asset_receipt_ref");
  });

  it("produces order-independent deterministic reports and issues", () => {
    const rows = [
      ...validAssertions(),
      assertion({
        mapping_assertion_id: "declared_outside_probe",
        probe_id: "probe_outside_source",
      }),
    ];
    const forward = validate(request({ assertions: rows }));
    const reversed = validate(request({
      source_probe_ids: [...SOURCE_PROBES].reverse(),
      assertions: [...rows].reverse(),
      expected_annotation_asset_receipt_refs: [
        { annotation_asset_id: ASSET_B, receipt_ref: RECEIPT_B },
        { annotation_asset_id: ASSET_A, receipt_ref: RECEIPT_A },
      ],
    }));

    expect(reversed).toEqual(forward);
    expect(forward.probes.map((item) => item.composite_key[3])).toEqual(SOURCE_PROBES);
  });

  it("returns only ProbeMappingValidationReport semantics, never admission or publication output", () => {
    const result: ProbeMappingValidationReport = validate(request());
    const output = result as unknown as Record<string, unknown>;

    expect(result.report_kind).toBe("probe_mapping_validation_report");
    expect(output.core_admission).toBeUndefined();
    expect(output.operation_result).toBeUndefined();
    expect(output.product_assessment).toBeUndefined();
    expect(output.publication_candidate).toBeUndefined();
    expect(output.publication).toBeUndefined();
  });
});
