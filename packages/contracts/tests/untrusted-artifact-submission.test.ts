import { describe, expect, it } from "vitest";

import {
  parseUntrustedArtifactReceipt,
  parseUntrustedArtifactSubmissionInput,
  UNTRUSTED_SUBMISSION_ID_PATTERN,
  UNTRUSTED_SUBMISSION_MAX_BASE64_LENGTH,
  type UntrustedArtifactReceipt,
} from "../src/index.js";

const VALID_SUBMISSION = {
  name: "paper-supplement.csv",
  media_type: "text/csv",
  source_note: null,
  coverage_status: "partial",
  covered_scope: ["gene_expression"],
  missing_scope: ["variant_level"],
  bytes_base64: "aGVsbG8=",
  idempotency_key: null,
};

function validReceipt(): UntrustedArtifactReceipt {
  return {
    schema_version: "1.0",
    submission_id: "ua_0123456789abcdef01234567",
    task_id: "task_ts_fixture",
    name: "paper-supplement.csv",
    media_type: "text/csv",
    source_note: null,
    coverage_status: "partial",
    covered_scope: ["gene_expression"],
    missing_scope: [],
    authoritative: false,
    trust: "untrusted",
    size_bytes: 5,
    sha256: "a".repeat(64),
    submitted_at: "2026-08-30T00:00:00.000Z",
  };
}

describe("untrusted artifact submission contracts", () => {
  it("parses a valid submission body", () => {
    expect(parseUntrustedArtifactSubmissionInput(VALID_SUBMISSION)).toEqual(VALID_SUBMISSION);
  });

  it("accepts an optional idempotency key and source note", () => {
    const parsed = parseUntrustedArtifactSubmissionInput({
      ...VALID_SUBMISSION,
      source_note: "supplementary table 3 from the paper",
      idempotency_key: "review-round-1",
    });
    expect(parsed.source_note).toBe("supplementary table 3 from the paper");
    expect(parsed.idempotency_key).toBe("review-round-1");
  });

  it("rejects unknown and missing fields", () => {
    expect(() =>
      parseUntrustedArtifactSubmissionInput({ ...VALID_SUBMISSION, authoritative: true }),
    ).toThrow(/Unknown or missing fields/u);
    const { source_note: _omitted, ...withoutNote } = VALID_SUBMISSION;
    expect(() => parseUntrustedArtifactSubmissionInput(withoutNote)).toThrow(
      /Unknown or missing fields/u,
    );
  });

  it("rejects invalid coverage status, empty name, and bad base64", () => {
    expect(() =>
      parseUntrustedArtifactSubmissionInput({ ...VALID_SUBMISSION, coverage_status: "verified" }),
    ).toThrow(/coverage_status/u);
    expect(() => parseUntrustedArtifactSubmissionInput({ ...VALID_SUBMISSION, name: "  " })).toThrow(
      /non-empty/u,
    );
    expect(() => parseUntrustedArtifactSubmissionInput({ ...VALID_SUBMISSION, bytes_base64: "" }))
      .toThrow(/non-empty base64/u);
    expect(() =>
      parseUntrustedArtifactSubmissionInput({ ...VALID_SUBMISSION, bytes_base64: "not/base64!!!" }),
    ).toThrow(/base64/u);
  });

  it("rejects base64 payloads beyond the submission size limit", () => {
    const oversized = "A".repeat(UNTRUSTED_SUBMISSION_MAX_BASE64_LENGTH + 1);
    expect(() =>
      parseUntrustedArtifactSubmissionInput({ ...VALID_SUBMISSION, bytes_base64: oversized }),
    ).toThrow(/size limit/u);
  });

  it("parses a receipt only when it stays non-authoritative and untrusted", () => {
    expect(parseUntrustedArtifactReceipt(validReceipt())).toMatchObject({
      authoritative: false,
      trust: "untrusted",
    });
    expect(() =>
      parseUntrustedArtifactReceipt({ ...validReceipt(), authoritative: true }),
    ).toThrow(/authoritative/u);
    expect(() =>
      parseUntrustedArtifactReceipt({ ...validReceipt(), trust: "authoritative" }),
    ).toThrow(/trust/u);
    expect(() =>
      parseUntrustedArtifactReceipt({ ...validReceipt(), extra_field: 1 }),
    ).toThrow(/Unknown or missing fields/u);
    expect(() =>
      parseUntrustedArtifactReceipt({ ...validReceipt(), schema_version: "2.0" }),
    ).toThrow(/schema_version/u);
  });

  it("matches only server-generated submission ids", () => {
    expect(UNTRUSTED_SUBMISSION_ID_PATTERN.test("ua_0123456789abcdef01234567")).toBe(true);
    expect(UNTRUSTED_SUBMISSION_ID_PATTERN.test("../../etc/passwd")).toBe(false);
    expect(UNTRUSTED_SUBMISSION_ID_PATTERN.test("ua_short")).toBe(false);
  });
});
