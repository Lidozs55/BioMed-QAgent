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
import { createDefaultBrowserParserRecipeRegistry } from "../src/dataset/acquisition/browser-recipe-registry.js";
import type { BoundHILRequestInput } from "../src/runtime/hil-gate.js";

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

  it("rejects browser.json.v1@1 before HIL with the real default recipe catalog", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "browser-hil-preflight-"));
    const evidenceStore = new BrowserAcquisitionEvidenceStore({ taskRoot });
    await evidenceStore.put(evidence("task_preflight_real"));
    const proposalStore = new BrowserAcquisitionProposalStore(taskRoot);
    const requestHIL = vi.fn();
    const tools = createBrowserTools({
      taskRoot,
      cache: {} as never,
      client: {} as never,
      crawler: {} as never,
      taskId: "task_preflight_real",
      runId: "run_preflight_real",
      evidenceStore,
      proposalStore,
      formalizationHIL: { requestHIL } as never,
      formalizationService: {} as never,
      recipeRegistry: createDefaultBrowserParserRecipeRegistry(),
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
    })).rejects.toThrow(/unknown browser parser recipe: browser\.json\.v1@1/);

    expect(requestHIL).not.toHaveBeenCalled();
    await expect(proposalStore.get("missing")).rejects.toThrow("browser proposal not found");
  });

  it("lets a promoted XLSX recipe reach the browser evidence acceptance HIL with bound evidence", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "browser-hil-preflight-"));
    const evidenceStore = new BrowserAcquisitionEvidenceStore({ taskRoot });
    const stored = await evidenceStore.put({
      ...evidence("task_preflight_xlsx"),
      evidence_id: "browser_evidence_xlsx",
      media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      requested_url: "https://example.org/proteins.xlsx",
      final_url: "https://example.org/proteins.xlsx",
    });
    const proposalStore = new BrowserAcquisitionProposalStore(taskRoot);
    const requestHIL = vi.fn(async () => ({
      schema_version: "1.0",
      review_id: "review_xlsx",
      request_id: "hil_xlsx",
      decision: { action: "reject" },
      reviewer: "user",
      reviewed_at: "2026-08-25T00:00:00.000Z",
      evidence_digest: stored.evidenceDigest,
      reason: "not ready",
    }));
    const recipes = createDefaultBrowserParserRecipeRegistry();
    const tools = createBrowserTools({
      taskRoot,
      cache: {} as never,
      client: {} as never,
      crawler: {} as never,
      taskId: "task_preflight_xlsx",
      runId: "run_preflight_xlsx",
      evidenceStore,
      proposalStore,
      formalizationHIL: { requestHIL } as never,
      formalizationService: {} as never,
      recipeRegistry: recipes,
    });

    const output = await tools.proposeFormalization.execute({
      evidence_id: "browser_evidence_xlsx",
      recipe_id: "browser.registered.registered_protein_structure_xlsx.1_0_0",
      recipe_version: "1",
      binding_id: "structure_binding",
      family_id: "protein_structure",
      schema_ref: "protein_structure.structure.v1",
      table_id: "structures",
      input_role: "structures",
      intended_role: "carrier",
    });

    expect(requestHIL).toHaveBeenCalledTimes(1);
    const request = (requestHIL.mock.calls[0] as unknown[])[0] as BoundHILRequestInput;
    expect(request.review_type).toBe("browser_evidence_acceptance");
    expect(request.evidence).toMatchObject({
      evidence_id: "browser_evidence_xlsx",
      evidence_digest: stored.evidenceDigest,
      media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      recipe_id: "browser.registered.registered_protein_structure_xlsx.1_0_0",
      schema_ref: "protein_structure.structure.v1",
      binding_id: "structure_binding",
    });
    const payload = JSON.parse(output.content) as { proposal: { proposal_id: string; status: string } };
    expect(payload.proposal.status).toBe("hil_pending");
    const persisted = await proposalStore.get(payload.proposal.proposal_id);
    expect(persisted.status).toBe("rejected");
    expect(persisted.recipe_id).toBe("browser.registered.registered_protein_structure_xlsx.1_0_0");
    expect(persisted.evidence_digest).toBe(stored.evidenceDigest);
  });
});
