import {
  BROWSER_ACQUISITION_PROVIDER_ID,
  BROWSER_ACQUISITION_PROVIDER_IMPLEMENTATION_DIGEST,
  parseBrowserAcquisitionEvidence,
  parseBrowserAcquisitionProposal,
  type BrowserAcquisitionEvidence,
  type BrowserAcquisitionProposal,
  type HumanReviewRecord,
  type SourceAssetRegistrationReceipt,
} from "@biomed/contracts";
import { canonicalDigest } from "../adapters/identity.js";
import type { BrowserAcquisitionEvidenceStore } from "../../runtime/browser-acquisition-store.js";
import type { BrowserAcquisitionProposalStore } from "../../runtime/browser-acquisition-proposal-store.js";
import type { SourceAssetRegistry, CoreAcquisitionProvenance } from "../../runtime/source-assets/registry.js";

export interface BrowserFormalizationInput {
  proposal: BrowserAcquisitionProposal;
  evidence: BrowserAcquisitionEvidence;
  review: HumanReviewRecord;
}

export interface BrowserFormalizationResult {
  proposal: BrowserAcquisitionProposal;
  evidence: BrowserAcquisitionEvidence;
  evidenceDigest: string;
  requestIdentityDigest: string;
  registration: SourceAssetRegistrationReceipt;
  provenance: CoreAcquisitionProvenance;
}

export interface BrowserFormalizationServiceOptions {
  evidenceStore: BrowserAcquisitionEvidenceStore;
  proposalStore: BrowserAcquisitionProposalStore;
  sourceAssetRegistry: SourceAssetRegistry;
}

/**
 * Core-owned trust boundary for a browser receipt. This service only
 * formalizes a verified carrier; parser execution and publication remain
 * separate Core operations.
 */
export class BrowserFormalizationService {
  readonly #evidenceStore: BrowserAcquisitionEvidenceStore;
  readonly #proposalStore: BrowserAcquisitionProposalStore;
  readonly #assets: SourceAssetRegistry;

  constructor(options: BrowserFormalizationServiceOptions) {
    this.#evidenceStore = options.evidenceStore;
    this.#proposalStore = options.proposalStore;
    this.#assets = options.sourceAssetRegistry;
  }

  async formalize(input: BrowserFormalizationInput): Promise<BrowserFormalizationResult> {
    const proposal = parseBrowserAcquisitionProposal(input.proposal);
    const review = input.review;
    if (review.request_id === "" || review.evidence_digest !== proposal.evidence_digest) {
      throw new Error("browser formalization review is not bound to the proposal evidence digest");
    }
    if (review.decision.action !== "accept") {
      throw new Error(`browser formalization review was ${review.decision.action}`);
    }
    if (review.request_id === "") throw new Error("browser formalization review request is invalid");

    const stored = await this.#evidenceStore.get(input.evidence.evidence_id);
    const evidence = parseBrowserAcquisitionEvidence(stored.evidence);
    if (stored.evidenceDigest !== proposal.evidence_digest) {
      throw new Error("browser evidence digest does not match the proposal");
    }
    if (evidence.evidence_id !== input.evidence.evidence_id || evidence.task_id !== proposal.task_id || evidence.run_id !== proposal.run_id) {
      throw new Error("browser evidence identity does not match the proposal");
    }
    if (evidence.provider_id !== BROWSER_ACQUISITION_PROVIDER_ID || evidence.provider_implementation_digest !== BROWSER_ACQUISITION_PROVIDER_IMPLEMENTATION_DIGEST) {
      throw new Error("browser evidence provider identity is not Core-approved");
    }

    const registration = await this.#assets.register({
      sourceId: evidence.source_id,
      relativePath: evidence.relative_path,
      role: "carrier",
      mediaType: evidence.media_type,
    });
    if (registration.asset_ref.asset_id !== evidence.source_asset_id || registration.sha256 !== evidence.sha256 || registration.size_bytes !== evidence.bytes_received) {
      throw new Error("browser evidence does not match its registered carrier receipt");
    }
    const requestIdentityDigest = canonicalDigest({
      task_id: proposal.task_id,
      run_id: proposal.run_id,
      binding_id: proposal.binding_id,
      evidence_digest: proposal.evidence_digest,
      carrier_provider_id: BROWSER_ACQUISITION_PROVIDER_ID,
      provider_implementation_digest: BROWSER_ACQUISITION_PROVIDER_IMPLEMENTATION_DIGEST,
      recipe_id: proposal.recipe_id,
      recipe_version: proposal.recipe_version,
      generation: proposal.generation,
    });
    const provenance = await this.#assets.registerCoreAcquisitionProvenance(registration, {
      provider_id: BROWSER_ACQUISITION_PROVIDER_ID,
      implementation_digest: BROWSER_ACQUISITION_PROVIDER_IMPLEMENTATION_DIGEST,
      request_identity_digest: requestIdentityDigest,
      canonical_accession: evidence.final_url,
      provider_snapshot_identity: proposal.evidence_digest,
      provider_revision_token: evidence.retrieved_at,
    });
    const formalized = await this.#proposalStore.update(proposal.proposal_id, { status: "formalized" });
    return {
      proposal: formalized,
      evidence,
      evidenceDigest: proposal.evidence_digest,
      requestIdentityDigest,
      registration,
      provenance,
    };
  }
}
