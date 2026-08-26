/**
 * GMRepo (Gut Microbiota Data Repository) fixed Core acquisition provider.
 *
 * GMRepo is a curated database of consistently annotated human gut
 * metagenomes (https://gmrepo.humangut.info). Its official REST API is
 * POST-only: every endpoint expects a JSON body (e.g.
 * ``{"mesh_id":"D006262"}``), so a plain GET formalization path can never
 * produce data from it. This provider pins the exact endpoint host and
 * carries the POST body inside the trusted provider plan — request
 * parameters never reach the transport directly.
 *
 * The provider plans one MeSH disease ID per binding and acquires the
 * associated-species payload (the basis of GMRepo species prevalence).
 * Responses enter the trusted Dataset Core acquisition path unchanged:
 * the downloader owns policy (HTTPS, host allowlist, hashing, size limits,
 * media type checks, content cache, immutable source_assets publication)
 * and CoreAcquisitionRuntime registers bytes/hash/provenance.
 */

import { createHash } from "node:crypto";

import type { CoreAcquisitionRequest } from "@biomed/contracts";

import type {
  AcquisitionDownloadPlan,
  AcquisitionProviderHandler,
} from "./runtime.js";

export const GMREPO_FILES_PROVIDER_ID = "gmrepo.files.v1";
/**
 * SHA-256 of this provider's plan implementation with the digest constant
 * line removed, so the value is stable and auditable: recompute with
 * ``sed '/^  "[0-9a-f]\{64\}" *;$/d' gmrepo-provider.ts | sha256sum``.
 */
export const GMREPO_FILES_IMPLEMENTATION_DIGEST =
  "d77e8835ad0bba0474fdec465da9d280d9c0fc45813e017008fcff35135cfecb";

const GMREPO_HOST = "gmrepo.humangut.info";
const GMREPO_ASSOCIATED_SPECIES_ENDPOINT = `https://${GMREPO_HOST}/api/getAssociatedSpeciesByMeshID`;
const MAX_GMREPO_RESPONSE_BYTES = 64 * 1024 * 1024;
const MESH_ID = /^D[0-9]{6}$/;
const PARAMETER_KEYS = new Set(["source", "accession", "entities"]);

type GmrepoParameters = {
  meshId: string;
};

function parameters(request: CoreAcquisitionRequest): GmrepoParameters {
  if (request.mode !== "builtin" || request.provider_id !== GMREPO_FILES_PROVIDER_ID) {
    throw new TypeError("gmrepo.files.v1 only accepts its fixed builtin acquisition contract");
  }
  if (Object.keys(request.parameters).some((key) => !PARAMETER_KEYS.has(key))) {
    throw new TypeError("gmrepo.files.v1 accepts only source, accession, and entities");
  }
  if (request.parameters.source !== "gmrepo") {
    throw new TypeError("gmrepo.files.v1 requires binding source 'gmrepo'");
  }
  if (typeof request.parameters.accession !== "string") {
    throw new TypeError("gmrepo.files.v1 requires a MeSH disease ID");
  }
  const meshId = request.parameters.accession.trim().toUpperCase();
  if (!MESH_ID.test(meshId)) {
    throw new TypeError("gmrepo.files.v1 requires a valid MeSH ID like D006262");
  }
  return { meshId };
}

function sourceId(meshId: string): string {
  const digest = createHash("sha256")
    .update(`${GMREPO_FILES_PROVIDER_ID}\u0000${meshId}`)
    .digest("hex")
    .slice(0, 20);
  return `source_gmrepo_${digest}`;
}

export function createGmrepoFilesProvider(): AcquisitionProviderHandler {
  return Object.freeze({
    providerId: GMREPO_FILES_PROVIDER_ID,
    implementationDigest: GMREPO_FILES_IMPLEMENTATION_DIGEST,
    async plan(request: CoreAcquisitionRequest): Promise<AcquisitionDownloadPlan> {
      const { meshId } = parameters(request);
      const body = JSON.stringify({ mesh_id: meshId });
      return {
        source: {
          schema_version: "1.0",
          source_id: sourceId(meshId),
          database: "gmrepo",
          accession: meshId,
          url: GMREPO_ASSOCIATED_SPECIES_ENDPOINT,
          title: `GMRepo associated species for MeSH ${meshId}`,
          retrieved_at: new Date().toISOString(),
        },
        filename: `gmrepo_species_${meshId}.json`,
        dataLevel: "repository_processed",
        maxBytes: MAX_GMREPO_RESPONSE_BYTES,
        method: "POST",
        body,
        expectedMediaTypes: new Set(["application/json"]),
        accept: "application/json",
        allowedHosts: new Set([GMREPO_HOST]),
        assetRole: "carrier",
        providerRevisionFacts: {
          canonical_accession: meshId,
          provider_snapshot_identity: `${GMREPO_FILES_PROVIDER_ID}:official-api`,
          provider_revision_token: null,
        },
      };
    },
  });
}
