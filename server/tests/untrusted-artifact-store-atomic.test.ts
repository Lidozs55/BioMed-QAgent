import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

let failReceiptWrite = false;

vi.mock("../src/persistence/atomic-json.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/persistence/atomic-json.js")>();
  return {
    ...actual,
    writeJsonAtomic: async (...args: Parameters<typeof actual.writeJsonAtomic>) => {
      if (failReceiptWrite) throw new Error("simulated receipt write failure");
      return actual.writeJsonAtomic(...args);
    },
  };
});

import {
  listUntrustedArtifacts,
  storeUntrustedArtifact,
} from "../src/runtime/untrusted-artifact-store.js";

const roots: string[] = [];

const METADATA = {
  schema_version: "1.0" as const,
  name: "candidate.csv",
  media_type: "text/csv",
  source_note: "test",
  coverage_status: "partial" as const,
  covered_scope: ["table:records"],
  missing_scope: ["formal_publication"],
};

afterEach(async () => {
  failReceiptWrite = false;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("untrusted artifact store atomic visibility", () => {
  test("receipt write failure leaves neither a visible ua_* nor a partial staging directory", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "untrusted-store-atomic-"));
    roots.push(taskRoot);
    failReceiptWrite = true;

    await expect(storeUntrustedArtifact(
      taskRoot,
      "task_atomic",
      METADATA,
      Buffer.from("record_id,value\nr1,1\n", "utf8"),
    )).rejects.toThrow(/simulated receipt write failure/);

    expect(await listUntrustedArtifacts(taskRoot)).toEqual([]);
    const entries = await readdir(path.join(taskRoot, "quarantine"));
    expect(entries).toEqual([]);
  });
});
