import { describe, expect, it } from "vitest";

import {
  buildDynamicFamilyPreflightReceiptDigestCanonical,
  computeDynamicFamilyPreflightReceiptDigest,
  parseDynamicFamilyPreflightReceipt,
  type DynamicFamilyPreflightReceipt,
} from "../src/index.js";

const DIGEST = "a".repeat(64);

function receipt(): DynamicFamilyPreflightReceipt {
  return {
    schema_version: "1.0",
    task_id: "task_1",
    requirement_id: "build_1",
    generation: 0,
    family_spec_digest: DIGEST,
    projection_digest: DIGEST,
    product_requirement_digest: DIGEST,
    host_descriptor_digest: DIGEST,
    submission_digest: DIGEST,
    required_input_roles: ["source"],
    output_closure: ["records"],
    topology_diagnostics: [],
    acquisition_plan: [{
      binding_id: "binding_1",
      input_requirement_ref: "source",
      source: "registered_asset",
      mode: "registered",
      binding_kind: "transform_input",
      asset_id: `asset_${DIGEST}`,
      provider_id: null,
      request_digest: DIGEST,
    }],
    receipt_digest: DIGEST,
  };
}

describe("dynamic family preflight receipt contract", () => {
  it("parses the exact hostile-wire receipt and canonicalizes without its digest", async () => {
    const parsed = parseDynamicFamilyPreflightReceipt(receipt(), "$");
    expect(parsed.task_id).toBe("task_1");
    expect(buildDynamicFamilyPreflightReceiptDigestCanonical(parsed)).toContain("host_descriptor_digest");
    expect(buildDynamicFamilyPreflightReceiptDigestCanonical(parsed)).not.toContain("receipt_digest");
    const digest = await computeDynamicFamilyPreflightReceiptDigest(parsed);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("parses the legacy all-transform wire shape with the subset role fields present", () => {
    const parsed = parseDynamicFamilyPreflightReceipt(receipt(), "$");
    expect(parsed.required_input_roles).toEqual(["source"]);
    expect(parsed.acquisition_plan[0]?.binding_kind).toBe("transform_input");
  });

  it("binds provenance-only plan entries through binding_kind", () => {
    const provenanceOnly = receipt();
    provenanceOnly.required_input_roles = [];
    provenanceOnly.acquisition_plan = [{
      ...receipt().acquisition_plan[0]!,
      input_requirement_ref: "supplementary",
      binding_kind: "provenance_only",
    }];
    const parsed = parseDynamicFamilyPreflightReceipt(provenanceOnly, "$");
    expect(parsed.acquisition_plan[0]?.binding_kind).toBe("provenance_only");
  });

  it("rejects unknown fields, duplicate bindings, and tampered modes", () => {
    expect(() => parseDynamicFamilyPreflightReceipt({ ...receipt(), extra: true }, "$")).toThrow();
    expect(() => parseDynamicFamilyPreflightReceipt({
      ...receipt(),
      acquisition_plan: [
        receipt().acquisition_plan[0],
        receipt().acquisition_plan[0],
      ],
    }, "$")).toThrow(/Duplicate acquisition plan/);
    expect(() => parseDynamicFamilyPreflightReceipt({
      ...receipt(),
      acquisition_plan: [{ ...receipt().acquisition_plan[0], mode: "builtin", provider_id: null }],
    }, "$")).toThrow();
  });

  it("rejects a hostile binding_kind value on plan entries", () => {
    const hostile = receipt();
    hostile.acquisition_plan = [{
      ...hostile.acquisition_plan[0]!,
      binding_kind: "media_type_inference" as unknown as "transform_input",
    }];
    expect(() => parseDynamicFamilyPreflightReceipt(hostile, "$")).toThrow(/binding_kind/);
  });
});
