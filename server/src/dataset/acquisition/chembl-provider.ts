import { createHash } from "node:crypto";

import type { CoreAcquisitionRequest } from "@biomed/contracts";

import type {
  AcquisitionDownloadPlan,
  AcquisitionProviderHandler,
} from "./runtime.js";

export const CHEMBL_FILES_PROVIDER_ID = "chembl.files.v1";
export const CHEMBL_FILES_IMPLEMENTATION_DIGEST =
  "f6347cf2389f5ff4c83c01cd1fe84a9729c9f04b1f13f9045d242981b5d730b7";
export const CHEMBL_FILES_SOURCE_ID_PREFIX = "source_chembl_bioactivity";

const CHEMBL_HOST = "www.ebi.ac.uk";
const CHEMBL_ID = /^CHEMBL[1-9][0-9]*$/;
const MAX_CHEMBL_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_COMPOUNDS = 32;
const ACTIVITY_TYPES = new Set(["IC50", "EC50", "Ki", "Kd"]);
const PARAMETER_KEYS = new Set(["source", "accession", "entities"]);
const TARGET_KEYS = ["chembl_target", "chembl_targets", "target_chembl_id", "target_chembl_ids"];
const COMPOUND_KEYS = [
  "chembl_compound",
  "chembl_compounds",
  "molecule_chembl_id",
  "molecule_chembl_ids",
];
const ACTIVITY_TYPE_KEYS = ["activity_type", "activity_types", "standard_type", "standard_types"];

type ChemblParameters = {
  source: string;
  accession: string | null;
  entities: Record<string, string[]>;
};

function parameters(request: CoreAcquisitionRequest): ChemblParameters {
  if (request.mode !== "builtin" || request.provider_id !== CHEMBL_FILES_PROVIDER_ID) {
    throw new TypeError("chembl.files.v1 only accepts its fixed builtin acquisition contract");
  }
  if (Object.keys(request.parameters).some((key) => !PARAMETER_KEYS.has(key))) {
    throw new TypeError("chembl.files.v1 accepts only server-owned source, accession, and entities");
  }
  if (request.parameters.source !== "chembl") {
    throw new TypeError("chembl.files.v1 requires binding source 'chembl'");
  }
  const accession = request.parameters.accession;
  if (accession !== null && typeof accession !== "string") {
    throw new TypeError("chembl.files.v1 accession must be a string or null");
  }
  const rawEntities = request.parameters.entities;
  if (rawEntities === null || typeof rawEntities !== "object" || Array.isArray(rawEntities)) {
    throw new TypeError("chembl.files.v1 entities must be a string-array record");
  }
  const entities: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(rawEntities)) {
    if (/(?:url|path|code|command|script)/i.test(key)) {
      throw new TypeError("chembl.files.v1 entities must not contain URL, path, or code controls");
    }
    if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string")) {
      throw new TypeError("chembl.files.v1 entities must be a string-array record");
    }
    entities[key] = value;
  }
  return { source: "chembl", accession, entities };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value !== ""))];
}

function valuesFor(entities: Record<string, string[]>, keys: readonly string[]): string[] {
  return unique(keys.flatMap((key) => entities[key] ?? []));
}

function parseTarget(input: ChemblParameters): string {
  const candidates = unique([
    ...(input.accession === null ? [] : [input.accession]),
    ...valuesFor(input.entities, TARGET_KEYS),
  ]).filter((value) => CHEMBL_ID.test(value));
  if (candidates.length !== 1) {
    throw new TypeError(
      "chembl.files.v1 requires exactly one valid ChEMBL target ID in the " +
        `binding accession or entities under keys: ${TARGET_KEYS.join(", ")}`,
    );
  }
  return candidates[0]!;
}

function parseCompounds(input: ChemblParameters): string[] {
  const candidates = valuesFor(input.entities, COMPOUND_KEYS);
  if (candidates.length === 0 || candidates.length > MAX_COMPOUNDS ||
      candidates.some((value) => !CHEMBL_ID.test(value))) {
    throw new TypeError(
      `chembl.files.v1 requires 1-${MAX_COMPOUNDS} valid ChEMBL compound IDs ` +
        `in entities under keys: ${COMPOUND_KEYS.join(", ")}`,
    );
  }
  return candidates.sort();
}

function parseActivityTypes(input: ChemblParameters): string[] {
  const values = valuesFor(input.entities, ACTIVITY_TYPE_KEYS);
  const selected = values.length === 0 ? ["IC50"] : values;
  if (selected.some((value) => !ACTIVITY_TYPES.has(value))) {
    throw new TypeError("chembl.files.v1 activity types must be controlled IC50, EC50, Ki, or Kd values");
  }
  return selected.sort();
}

export function chemblFilesUrl(options: {
  targetId: string;
  compoundIds: readonly string[];
  activityTypes: readonly string[];
}): string {
  const query = new URLSearchParams();
  query.set("target_chembl_id", options.targetId);
  query.set("molecule_chembl_id__in", options.compoundIds.join(","));
  query.set("standard_type__in", options.activityTypes.join(","));
  query.set("limit", "100");
  query.set("offset", "0");
  return `https://${CHEMBL_HOST}/chembl/api/data/activity.json?${query.toString()}`;
}

function sourceId(targetId: string, compoundIds: readonly string[]): string {
  const digest = createHash("sha256")
    .update(`${targetId}\u0000${compoundIds.join("\u0000")}`)
    .digest("hex")
    .slice(0, 20);
  return `${CHEMBL_FILES_SOURCE_ID_PREFIX}_${digest}`;
}

export function createChemblFilesProvider(): AcquisitionProviderHandler {
  return Object.freeze({
    providerId: CHEMBL_FILES_PROVIDER_ID,
    implementationDigest: CHEMBL_FILES_IMPLEMENTATION_DIGEST,
    plan(request: CoreAcquisitionRequest): AcquisitionDownloadPlan {
      const parsed = parameters(request);
      const targetId = parseTarget(parsed);
      const compoundIds = parseCompounds(parsed);
      const activityTypes = parseActivityTypes(parsed);
      return {
        source: {
          schema_version: "1.0",
          source_id: sourceId(targetId, compoundIds),
          database: "chembl",
          accession: targetId,
          url: chemblFilesUrl({ targetId, compoundIds, activityTypes }),
          title: `ChEMBL bioactivity records for ${targetId}`,
          retrieved_at: new Date().toISOString(),
        },
        filename: `chembl-${targetId.toLowerCase()}-bioactivity.json`,
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
