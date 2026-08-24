import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HumanReviewRecord, BrowserAcquisitionEvidence, BrowserAcquisitionProposal } from "@biomed/contracts";
import { BROWSER_ACQUISITION_POLICY_REVISION, BROWSER_ACQUISITION_PROVIDER_ID, BROWSER_ACQUISITION_PROVIDER_IMPLEMENTATION_DIGEST } from "@biomed/contracts";
import { BrowserAcquisitionEvidenceStore } from "../src/runtime/browser-acquisition-store.js";
import { BrowserAcquisitionProposalStore } from "../src/runtime/browser-acquisition-proposal-store.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";
import { BrowserFormalizationService } from "../src/dataset/acquisition/browser-formalization.js";

function fixture(): { evidence: BrowserAcquisitionEvidence; proposal: BrowserAcquisitionProposal; review: HumanReviewRecord } {
  const evidence: BrowserAcquisitionEvidence = {
    schema_version: "1.0", evidence_id: "browser_evidence_formal", task_id: "task_formal", run_id: "run_formal",
    requested_url: "https://example.org/source.tsv", final_url: "https://example.org/source.tsv", redirect_chain: [],
    status: 200, media_type: "text/tab-separated-values", retrieved_at: "2026-08-24T00:00:00.000Z", bytes_received: 4,
    sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", browser_policy_revision: BROWSER_ACQUISITION_POLICY_REVISION,
    source_asset_id: "asset_9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", source_id: "browser_source", relative_path: "source_assets/source.tsv",
    download_attempt_id: "download_attempt_formal", provider_id: BROWSER_ACQUISITION_PROVIDER_ID, provider_implementation_digest: BROWSER_ACQUISITION_PROVIDER_IMPLEMENTATION_DIGEST,
  };
  const proposal: BrowserAcquisitionProposal = {
    schema_version: "1.0", proposal_id: "browser_proposal_formal", evidence_digest: "", task_id: "task_formal", run_id: "run_formal", build_id: null, generation: 1,
    recipe_id: "fixture.tsv", recipe_version: "1", binding_id: "source", family_id: "fixture_family", schema_ref: "fixture_schema", table_id: "fixture_table", input_role: "source", intended_role: "carrier", status: "accepted", created_at: evidence.retrieved_at, updated_at: evidence.retrieved_at, failure_reason: null,
  };
  const review: HumanReviewRecord = { schema_version: "1.0", review_id: "review_formal", request_id: "hil_formal", decision: { action: "accept" }, reviewer: "user", reviewed_at: evidence.retrieved_at, evidence_digest: "", reason: null };
  return { evidence, proposal, review };
}

describe("BrowserFormalizationService", () => {
  it("rechecks receipt, registers a carrier, and writes Core provenance only after accept", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "browser-formal-"));
    const taskRoot = path.join(root, "task"); await mkdir(path.join(taskRoot, "source_assets"), { recursive: true });
    await writeFile(path.join(taskRoot, "source_assets/source.tsv"), "test", "utf8");
    const parts = fixture();
    const evidenceStore = new BrowserAcquisitionEvidenceStore({ taskRoot });
    const stored = await evidenceStore.put(parts.evidence);
    const proposalStore = new BrowserAcquisitionProposalStore(taskRoot);
    const proposal = await proposalStore.put({ ...parts.proposal, evidence_digest: stored.evidenceDigest });
    const review = { ...parts.review, evidence_digest: stored.evidenceDigest };
    const result = await new BrowserFormalizationService({
      evidenceStore, proposalStore, sourceAssetRegistry: new SourceAssetRegistry("task_formal", taskRoot),
      recipeRegistry: { resolve: () => ({ ref: { schema_version: "1.0", recipe_id: "fixture.tsv", recipe_version: 1, status: "PROMOTED", implementation_digest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, schema_ref: "fixture_schema", adapter_id: "fixture", parser_version: "1", media_types: ["text/tab-separated-values"] }) },
    }).formalize({ proposal, evidence: parts.evidence, review });
    expect(result.registration.asset_ref.role).toBe("carrier");
    expect(result.provenance.provider_id).toBe(BROWSER_ACQUISITION_PROVIDER_ID);
    expect(result.proposal.status).toBe("formalized");
  });

  it("rejects approve and does not register a carrier", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "browser-formal-"));
    const taskRoot = path.join(root, "task"); await mkdir(path.join(taskRoot, "source_assets"), { recursive: true });
    await writeFile(path.join(taskRoot, "source_assets/source.tsv"), "test", "utf8");
    const parts = fixture(); const evidenceStore = new BrowserAcquisitionEvidenceStore({ taskRoot });
    const stored = await evidenceStore.put(parts.evidence); const proposalStore = new BrowserAcquisitionProposalStore(taskRoot);
    const proposal = await proposalStore.put({ ...parts.proposal, evidence_digest: stored.evidenceDigest });
    await expect(new BrowserFormalizationService({ evidenceStore, proposalStore, sourceAssetRegistry: new SourceAssetRegistry("task_formal", taskRoot), recipeRegistry: { resolve: () => ({ ref: { schema_version: "1.0", recipe_id: "fixture.tsv", recipe_version: 1, status: "PROMOTED", implementation_digest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, schema_ref: "fixture_schema", adapter_id: "fixture", parser_version: "1", media_types: ["text/tab-separated-values"] }) } }).formalize({ proposal, evidence: parts.evidence, review: { ...parts.review, evidence_digest: stored.evidenceDigest, decision: { action: "approve" } } })).rejects.toThrow("was approve");
  });
});
