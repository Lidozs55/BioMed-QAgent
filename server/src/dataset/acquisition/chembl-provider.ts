import type { CoreAcquisitionRequest } from "@biomed/contracts";

import type {
  AcquisitionDownloadPlan,
  AcquisitionProviderHandler,
} from "./runtime.js";

export const CHEMBL_FILES_PROVIDER_ID = "chembl.files.v1";
export const CHEMBL_FILES_IMPLEMENTATION_DIGEST =
  "5f9c3c968f2ed498aa597039e30d092c6194e60161f186f39e92163221e2fca2";
export const CHEMBL_FILES_URL =
  "https://www.ebi.ac.uk/chembl/api/data/activity.json?target_chembl_id=CHEMBL203&molecule_chembl_id__in=CHEMBL939,CHEMBL553,CHEMBL3353410,CHEMBL1173655,CHEMBL2110732&standard_type=IC50&standard_units=nM&limit=100&offset=0";

const CHEMBL_HOST = "www.ebi.ac.uk";
const MAX_CHEMBL_RESPONSE_BYTES = 16 * 1024 * 1024;

export function createChemblFilesProvider(): AcquisitionProviderHandler {
  return Object.freeze({
    providerId: CHEMBL_FILES_PROVIDER_ID,
    implementationDigest: CHEMBL_FILES_IMPLEMENTATION_DIGEST,
    plan(request: CoreAcquisitionRequest): AcquisitionDownloadPlan {
      if (request.mode !== "builtin" || request.provider_id !== CHEMBL_FILES_PROVIDER_ID) {
        throw new TypeError("chembl.files.v1 only accepts its fixed builtin acquisition contract");
      }
      if (Object.keys(request.parameters).length !== 0) {
        throw new TypeError("chembl.files.v1 parameters must be empty");
      }
      return {
        source: {
          schema_version: "1.0",
          source_id: "chembl_gold5_bioactivity",
          database: "chembl",
          accession: "CHEMBL203",
          url: CHEMBL_FILES_URL,
          title: "ChEMBL bioactivity API response",
          retrieved_at: new Date().toISOString(),
        },
        filename: "chembl-bioactivity.json",
        dataLevel: "repository_processed",
        maxBytes: MAX_CHEMBL_RESPONSE_BYTES,
        expectedMediaTypes: new Set(["application/json"]),
        accept: "application/json",
        allowedHosts: new Set([CHEMBL_HOST]),
        assetRole: "carrier",
      };
    },
  });
}
