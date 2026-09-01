import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROWSER_ACQUISITION_POLICY_REVISION,
  LEGACY_BROWSER_ACQUISITION_POLICY_REVISION,
  BROWSER_ACQUISITION_PROVIDER_ID,
  type BrowserAcquisitionEvidence,
} from "@biomed/contracts";
import { BrowserAcquisitionEvidenceStore } from "../src/runtime/browser-acquisition-store.js";

function evidence(taskId: string): BrowserAcquisitionEvidence {
  return {
    schema_version: "1.0",
    evidence_id: "browser_evidence_fixture",
    task_id: taskId,
    run_id: "run_fixture",
    requested_url: "https://example.org/source.tsv",
    final_url: "https://example.org/source.tsv",
    redirect_chain: [],
    status: 200,
    media_type: "text/tab-separated-values",
    retrieved_at: "2026-08-24T00:00:00.000Z",
    bytes_received: 4,
    sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    browser_policy_revision: BROWSER_ACQUISITION_POLICY_REVISION,
    source_asset_id: "asset_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source_id: "browser_source",
    relative_path: "source_assets/source.tsv",
    download_attempt_id: "download_attempt_fixture",
    provider_id: BROWSER_ACQUISITION_PROVIDER_ID,
    provider_implementation_digest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  };
}

describe("BrowserAcquisitionEvidenceStore", () => {
  it("persists, reloads, and deterministically digests evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "browser-evidence-"));
    const store = new BrowserAcquisitionEvidenceStore({ taskRoot: root });
    const first = await store.put(evidence("task_fixture"));
    const reloaded = await new BrowserAcquisitionEvidenceStore({ taskRoot: root }).get("browser_evidence_fixture");

    expect(reloaded).toEqual(first);
    expect(JSON.parse(await readFile(path.join(root, "state/browser-acquisition-evidence.json"), "utf8"))).toHaveLength(1);
  });

  it("continues to read evidence written under the legacy TLS policy revision", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "browser-evidence-"));
    const store = new BrowserAcquisitionEvidenceStore({ taskRoot: root });
    const legacy = {
      ...evidence("task_fixture"),
      browser_policy_revision: LEGACY_BROWSER_ACQUISITION_POLICY_REVISION,
    };
    await expect(store.put(legacy)).resolves.toMatchObject({ evidence: legacy });
  });

  it("rejects an evidence identity collision instead of overwriting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "browser-evidence-"));
    const store = new BrowserAcquisitionEvidenceStore({ taskRoot: root });
    await store.put(evidence("task_fixture"));
    await expect(store.put({ ...evidence("task_other") })).rejects.toThrow("identity collision");
  });

  it("rejects corrupted persisted JSON through the contract parser", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "browser-evidence-"));
    await mkdir(path.join(root, "state"), { recursive: true });
    await writeFile(
      path.join(root, "state/browser-acquisition-evidence.json"),
      JSON.stringify([{ ...evidence("task_fixture"), sha256: "not-a-digest" }]),
      "utf8",
    );
    await expect(new BrowserAcquisitionEvidenceStore({ taskRoot: root }).list()).rejects.toThrow();
  });
});
