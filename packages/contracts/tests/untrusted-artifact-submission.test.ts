import { describe, expect, it } from "vitest";

import {
  parseUntrustedArtifactMetadata,
  parseUntrustedArtifactReceipt,
  UNTRUSTED_SUBMISSION_ID_PATTERN,
  type UntrustedArtifactMetadata,
  type UntrustedArtifactReceipt,
} from "../src/index.js";

const VALID_METADATA: UntrustedArtifactMetadata = {
  schema_version: "1.0",
  name: "paper-supplement.csv",
  media_type: "text/csv",
  source_note: null,
  coverage_status: "partial",
  covered_scope: ["gene_expression"],
  missing_scope: ["variant_level"],
};

function validReceipt(): UntrustedArtifactReceipt {
  return {
    ...VALID_METADATA,
    submission_id: "ua_0123456789abcdef01234567",
    task_id: "task_ts_fixture",
    authoritative: false,
    trust: "untrusted",
    size_bytes: 5,
    sha256: "a".repeat(64),
    submitted_at: "2026-08-30T00:00:00.000Z",
  };
}

describe("untrusted artifact submission contracts", () => {
  it("parses metadata with explicit coverage information", () => {
    expect(parseUntrustedArtifactMetadata(VALID_METADATA)).toEqual(VALID_METADATA);
  });

  it("rejects unknown and missing metadata fields", () => {
    expect(() => parseUntrustedArtifactMetadata({ ...VALID_METADATA, trust: "untrusted" }))
      .toThrow(/Unknown or missing fields/u);
    const { source_note: _omitted, ...withoutNote } = VALID_METADATA;
    expect(() => parseUntrustedArtifactMetadata(withoutNote)).toThrow(/Unknown or missing fields/u);
  });

  it("rejects invalid coverage status and empty text", () => {
    expect(() => parseUntrustedArtifactMetadata({ ...VALID_METADATA, coverage_status: "verified" }))
      .toThrow(/coverage_status/u);
    expect(() => parseUntrustedArtifactMetadata({ ...VALID_METADATA, name: "  " }))
      .toThrow(/non-empty/u);
  });

  it("parses a receipt only when it stays non-authoritative and untrusted", () => {
    expect(parseUntrustedArtifactReceipt(validReceipt())).toMatchObject({
      authoritative: false,
      trust: "untrusted",
    });
    expect(() => parseUntrustedArtifactReceipt({ ...validReceipt(), authoritative: true }))
      .toThrow(/authoritative/u);
    expect(() => parseUntrustedArtifactReceipt({ ...validReceipt(), trust: "authoritative" }))
      .toThrow(/trust/u);
    expect(() => parseUntrustedArtifactReceipt({ ...validReceipt(), extra_field: 1 }))
      .toThrow(/Unknown or missing fields/u);
  });

  it("matches and accepts only server-generated submission ids", () => {
    expect(UNTRUSTED_SUBMISSION_ID_PATTERN.test("ua_0123456789abcdef01234567")).toBe(true);
    expect(UNTRUSTED_SUBMISSION_ID_PATTERN.test("../../etc/passwd")).toBe(false);
    expect(() => parseUntrustedArtifactReceipt({
      ...validReceipt(),
      submission_id: "../../etc/passwd",
    })).toThrow(/Invalid submission id/u);
  });
});
