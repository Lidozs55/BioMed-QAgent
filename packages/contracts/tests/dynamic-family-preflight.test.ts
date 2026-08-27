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
});
