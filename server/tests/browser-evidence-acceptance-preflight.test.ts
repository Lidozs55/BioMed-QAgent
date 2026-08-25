import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_ACQUISITION_POLICY_REVISION,
  BROWSER_ACQUISITION_PROVIDER_ID,
  type BrowserAcquisitionEvidence,
} from "@biomed/contracts";
import { createBrowserTools } from "../src/agent/tools/browser.js";
import { BrowserAcquisitionEvidenceStore } from "../src/runtime/browser-acquisition-store.js";
import { BrowserAcquisitionProposalStore } from "../src/runtime/browser-acquisition-proposal-store.js";

function evidence(taskId: string): BrowserAcquisitionEvidence {
  return {
    schema_version: "1.0",
    evidence_id: "browser_evidence_preflight",
    task_id: taskId,
    run_id: "run_preflight",
    requested_url: "https://example.org/source.json",
    final_url: "https://example.org/source.json",
    redirect_chain: [],
    status: 200,
    media_type: "application/json",
    retrieved_at: "2026-08-25T00:00:00.000Z",
    bytes_received: 2,
    sha256: "a".repeat(64),
    browser_policy_revision: BROWSER_ACQUISITION_POLICY_REVISION,
    source_asset_id: `asset_${"a".repeat(64)}`,
    source_id: "browser_source",
    relative_path: "source_assets/source.json",
    download_attempt_id: "download_preflight",
    provider_id: BROWSER_ACQUISITION_PROVIDER_ID,
    provider_implementation_digest: "b".repeat(64),
  };
}

describe("browser evidence acceptance recipe preflight", () => {
  it("rejects an unknown recipe before creating a HIL or proposal", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "browser-hil-preflight-"));
    const evidenceStore = new BrowserAcquisitionEvidenceStore({ taskRoot });
    await evidenceStore.put(evidence("task_preflight"));
    const proposalStore = new BrowserAcquisitionProposalStore(taskRoot);
    const requestHIL = vi.fn();
    const tools = createBrowserTools({
      taskRoot,
      cache: {} as never,
      client: {} as never,
      crawler: {} as never,
      taskId: "task_preflight",
      runId: "run_preflight",
      evidenceStore,
      proposalStore,
      formalizationHIL: { requestHIL } as never,
      formalizationService: {} as never,
      recipeRegistry: {
        resolve: () => { throw new Error("unknown browser parser recipe: browser.json.v1@1"); },
        resolveRegisteredTable: () => { throw new Error("not reached"); },
        list: () => ["browser.registered.fixture_json.1_0_0@1"],
      },
    });

    await expect(tools.proposeFormalization.execute({
      evidence_id: "browser_evidence_preflight",
      recipe_id: "browser.json.v1",
      recipe_version: "1",
      binding_id: "binding",
      family_id: "dynamic_family",
      schema_ref: "dynamic.schema.v1",
      table_id: "records",
      input_role: "records",
      intended_role: "source",
    })).rejects.toThrow("available PROMOTED browser recipes: browser.registered.fixture_json.1_0_0@1");

    expect(requestHIL).not.toHaveBeenCalled();
    await expect(proposalStore.get("missing")).rejects.toThrow("browser proposal not found");
  });
});
