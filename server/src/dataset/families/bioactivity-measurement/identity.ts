import type {
  ProductArtifactFact,
  ProductAssessment,
  ProductEvidenceSnapshot,
  ProductRequirementManifest,
  SourceAssetRegistrationReceipt,
} from "@biomed/contracts";

import { canonicalDigest } from "../../adapters/identity.js";
import { assessProduct } from "../../assessment/index.js";
import { parseSourceAssetRegistrationReceipt } from "../../contracts/index.js";
import type { BioactivityCompoundInput } from "./types.js";

export const BIOACTIVITY_IDENTITY_PACKAGE_ID = "bioactivity_identity";
export const BIOACTIVITY_IDENTITY_TRANSFORM_ID = "bioactivity_identity.exact_inchi_key.v1";
export const BIOACTIVITY_IDENTITY_TRANSFORM_DIGEST = canonicalDigest({
  transform_id: BIOACTIVITY_IDENTITY_TRANSFORM_ID,
  algorithm: "normalize uppercase InChIKey and compare for exact equality",
  input_contract: "registered ChEMBL compound plus PubChem PUG-REST property carrier",
  output_contract: "separate compound identities plus conflict-preserving crosswalk",
});

const INCHI_KEY = /^[A-Z]{14}-[A-Z]{10}-[A-Z]$/;
const JSON_POINTER = /^(?:\/(?:[^~/]|~0|~1)*)*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

export interface BioactivityIdentitySourceInput {
  receipt: SourceAssetRegistrationReceipt;
  json_pointer: string;
}

export interface PubChemIdentityCarrierInput extends BioactivityIdentitySourceInput {
  expected_cid: number;
  document: unknown;
}

export interface BioactivityIdentityInput {
  task_id: string;
  chembl_compound: BioactivityCompoundInput;
  chembl_source: BioactivityIdentitySourceInput;
  pubchem_carrier: PubChemIdentityCarrierInput;
}

export interface BioactivityCompoundCrosswalkInput {
  crosswalk_id: string;
  left_id: string;
  left_namespace: "chembl_compound";
  right_id: string;
  right_namespace: "pubchem_cid";
  relation_type: "compound_identity_link";
  match_method: "exact_inchi_key";
  match_evidence: Readonly<Record<string, unknown>>;
  conflict_status: "matched" | "conflict";
  conflict_details: Readonly<Record<string, unknown>> | null;
  confidence_score: number;
  confidence_level: "high" | "low";
  source_id: string;
}

export interface BioactivityIdentityResult {
  compounds: readonly [BioactivityCompoundInput, BioactivityCompoundInput];
  compound_crosswalks: readonly [BioactivityCompoundCrosswalkInput];
  assessment: ProductAssessment;
}

interface PubChemProperty {
  cid: number;
  preferredName: string;
  canonicalSmiles: string | null;
  isomericSmiles: string | null;
  inchi: string | null;
  inchiKey: string;
  molecularFormula: string | null;
  molecularWeight: number | null;
}

const PUBCHEM_FIELDS = new Set([
  "CID",
  "MolecularFormula",
  "MolecularWeight",
  "IUPACName",
  "CanonicalSMILES",
  "IsomericSMILES",
  "InChIKey",
  "InChI",
]);

export const BIOACTIVITY_IDENTITY_REQUIREMENTS: ProductRequirementManifest = Object.freeze({
  schema_version: "1.0",
  requirement_id: "bioactivity_identity.release.v1",
  package_id: BIOACTIVITY_IDENTITY_PACKAGE_ID,
  package_version: "1.0",
  entities: [
    {
      requirement_id: "compound_identity",
      entity_type: "Compound",
      min_count: 1,
      require_identity_closure: true,
    },
  ],
  relations: [
    {
      requirement_id: "compound_identity_link",
      predicate: "compound_identity_link",
      subject_type: "Compound",
      object_type: "Compound",
      min_count: 1,
      require_evidence: true,
    },
  ],
  evidence: [
    {
      requirement_id: "compound_identity_evidence",
      evidence_type: "CompoundIdentityEvidence",
      min_count: 1,
    },
  ],
  identifiers: [
    {
      requirement_id: "pubchem_identity",
      entity_type: "Compound",
      required_namespaces: ["pubchem_cid"],
      min_cross_references: 1,
    },
  ],
  provenance: [
    {
      requirement_id: "identity_source_closure",
      min_complete_records: 2,
      require_locator: true,
      require_retrieved_at: true,
      require_source_receipt: true,
      require_transform_digest: true,
    },
  ],
  confidence: [
    {
      requirement_id: "identity_confidence",
      min_high_confidence_ratio: 1,
      max_pending_reviews: 0,
      reject_unreviewed_low_confidence: true,
    },
  ],
  artifacts: [
    {
      requirement_id: "identity_artifacts",
      min_count: 2,
      required_roles: ["compound_identity", "compound_crosswalk"],
      require_hashes: true,
    },
  ],
});

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`bioactivity identity rejected: ${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, name: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length > 0) {
    throw new TypeError(`bioactivity identity rejected: ${name} has unknown fields: ${extras.join(", ")}`);
  }
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`bioactivity identity rejected: ${name} is required`);
  }
  return value.trim();
}

function optionalText(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, name);
}

function positiveNumber(value: unknown, name: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new TypeError(`bioactivity identity rejected: ${name} must be a positive finite number`);
  }
  return parsed;
}

function positiveCid(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`bioactivity identity rejected: ${name} must be a positive safe integer`);
  }
  return value;
}

function normalizedInchiKey(value: unknown, name: string): string {
  const parsed = requiredText(value, name).toUpperCase();
  if (!INCHI_KEY.test(parsed)) {
    throw new TypeError(`bioactivity identity rejected: ${name} must be a valid InChIKey`);
  }
  return parsed;
}

function jsonPointer(value: string, name: string): string {
  if (!JSON_POINTER.test(value)) {
    throw new TypeError(`bioactivity identity rejected: ${name} must be an RFC 6901 JSON pointer`);
  }
  return value;
}

function safeSourceId(value: string, name: string): string {
  if (!SAFE_ID.test(value) || value.includes("..")) {
    throw new TypeError(`bioactivity identity rejected: ${name} must be a safe identifier`);
  }
  return value;
}

function receipt(
  value: SourceAssetRegistrationReceipt,
  taskId: string,
  name: string,
): SourceAssetRegistrationReceipt {
  const parsed = parseSourceAssetRegistrationReceipt(value, taskId);
  if (parsed.asset_ref.role !== "carrier" && parsed.asset_ref.role !== "source") {
    throw new TypeError(`bioactivity identity rejected: ${name} receipt must have source or carrier role`);
  }
  if (parsed.media_type !== "application/json") {
    throw new TypeError(`bioactivity identity rejected: ${name} receipt must be application/json`);
  }
  return parsed;
}

export function parsePubChemIdentityCarrier(
  document: unknown,
  expectedCid: number,
): PubChemProperty {
  const requestedCid = positiveCid(expectedCid, "expected_cid");
  const root = object(document, "PubChem document");
  exactKeys(root, new Set(["PropertyTable"]), "PubChem document");
  const table = object(root.PropertyTable, "PubChem PropertyTable");
  exactKeys(table, new Set(["Properties"]), "PubChem PropertyTable");
  if (!Array.isArray(table.Properties) || table.Properties.length !== 1) {
    throw new TypeError("bioactivity identity rejected: PubChem Properties must contain exactly one record");
  }
  const property = object(table.Properties[0], "PubChem property record");
  exactKeys(property, PUBCHEM_FIELDS, "PubChem property record");
  const cid = positiveCid(property.CID, "PubChem CID");
  if (cid !== requestedCid) {
    throw new TypeError("bioactivity identity rejected: PubChem CID does not match the requested CID");
  }
  const inchiKey = normalizedInchiKey(property.InChIKey, "PubChem InChIKey");
  return {
    cid,
    preferredName: optionalText(property.IUPACName, "PubChem IUPACName") ?? `PubChem CID ${cid}`,
    canonicalSmiles: optionalText(property.CanonicalSMILES, "PubChem CanonicalSMILES"),
    isomericSmiles: optionalText(property.IsomericSMILES, "PubChem IsomericSMILES"),
    inchi: optionalText(property.InChI, "PubChem InChI"),
    inchiKey,
    molecularFormula: optionalText(property.MolecularFormula, "PubChem MolecularFormula"),
    molecularWeight: positiveNumber(property.MolecularWeight, "PubChem MolecularWeight"),
  };
}

function checkedArtifacts(artifacts: readonly ProductArtifactFact[]): ProductArtifactFact[] {
  const seen = new Set<string>();
  return artifacts.map((artifact) => {
    if (!SAFE_ID.test(artifact.artifact_id) || seen.has(artifact.artifact_id)) {
      throw new TypeError("bioactivity identity rejected: artifact IDs must be unique safe identifiers");
    }
    seen.add(artifact.artifact_id);
    if (!SAFE_ID.test(artifact.role)) {
      throw new TypeError("bioactivity identity rejected: artifact role must be a safe identifier");
    }
    if (artifact.sha256 !== null && !SHA256.test(artifact.sha256)) {
      throw new TypeError("bioactivity identity rejected: artifact sha256 must be a lowercase digest or null");
    }
    return { ...artifact };
  }).sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
}

function assessmentSnapshot(
  crosswalk: BioactivityCompoundCrosswalkInput,
  chemblReceipt: SourceAssetRegistrationReceipt,
  pubchemReceipt: SourceAssetRegistrationReceipt,
  chemblPointer: string,
  pubchemPointer: string,
  artifacts: readonly ProductArtifactFact[],
): ProductEvidenceSnapshot {
  const matched = crosswalk.conflict_status === "matched";
  const canonicalEntityId = crosswalk.crosswalk_id;
  return {
    entities: [{
      entity_id: canonicalEntityId,
      entity_type: "Compound",
      identity_closed: matched,
    }],
    relations: [{
      subject_id: `${crosswalk.left_namespace}:${crosswalk.left_id}`,
      subject_type: "Compound",
      predicate: "compound_identity_link",
      object_id: `${crosswalk.right_namespace}:${crosswalk.right_id}`,
      object_type: "Compound",
      evidence_refs: [crosswalk.crosswalk_id],
    }],
    evidence: [{
      evidence_id: crosswalk.crosswalk_id,
      evidence_type: "CompoundIdentityEvidence",
    }],
    cross_references: [{
      entity_id: canonicalEntityId,
      entity_type: "Compound",
      namespace: "pubchem_cid",
      match_confidence: matched ? "high" : "low",
      conflict: !matched,
    }],
    provenance: [
      {
        source_receipt_id: chemblReceipt.receipt_id,
        locator: `${chemblReceipt.relative_path}#${chemblPointer}`,
        retrieved_at: chemblReceipt.registered_at,
        transform_digest: BIOACTIVITY_IDENTITY_TRANSFORM_DIGEST,
      },
      {
        source_receipt_id: pubchemReceipt.receipt_id,
        locator: `${pubchemReceipt.relative_path}#${pubchemPointer}`,
        retrieved_at: pubchemReceipt.registered_at,
        transform_digest: BIOACTIVITY_IDENTITY_TRANSFORM_DIGEST,
      },
    ],
    confidence: [{
      level: matched ? "high" : "low",
      review_status: matched ? "not_required" : "pending",
    }],
    artifacts: checkedArtifacts(artifacts),
  };
}

export function buildBioactivityIdentity(
  input: BioactivityIdentityInput,
  artifacts: readonly ProductArtifactFact[],
): BioactivityIdentityResult {
  const taskId = safeSourceId(input.task_id, "task_id");
  const chemblReceipt = receipt(input.chembl_source.receipt, taskId, "ChEMBL");
  const pubchemReceipt = receipt(input.pubchem_carrier.receipt, taskId, "PubChem");
  if (chemblReceipt.asset_ref.asset_id === pubchemReceipt.asset_ref.asset_id) {
    throw new TypeError("bioactivity identity rejected: ChEMBL and PubChem carriers must be distinct assets");
  }
  if (input.chembl_compound.source_id !== chemblReceipt.source_id) {
    throw new TypeError("bioactivity identity rejected: ChEMBL compound source_id does not match its receipt");
  }
  if (pubchemReceipt.source_id === chemblReceipt.source_id) {
    throw new TypeError("bioactivity identity rejected: ChEMBL and PubChem source IDs must be distinct");
  }
  const chemblPointer = jsonPointer(input.chembl_source.json_pointer, "ChEMBL json_pointer");
  const pubchemPointer = jsonPointer(input.pubchem_carrier.json_pointer, "PubChem json_pointer");
  const leftKey = normalizedInchiKey(input.chembl_compound.inchi_key, "ChEMBL InChIKey");
  if (input.chembl_compound.compound_id_namespace !== "chembl_compound") {
    throw new TypeError("bioactivity identity rejected: left compound must use chembl_compound namespace");
  }
  safeSourceId(input.chembl_compound.compound_id, "ChEMBL compound_id");
  const pubchem = parsePubChemIdentityCarrier(
    input.pubchem_carrier.document,
    input.pubchem_carrier.expected_cid,
  );
  const rightId = String(pubchem.cid);
  const matched = leftKey === pubchem.inchiKey;
  const identityEvidence = {
    transform_id: BIOACTIVITY_IDENTITY_TRANSFORM_ID,
    transform_digest: BIOACTIVITY_IDENTITY_TRANSFORM_DIGEST,
    compared_field: "inchi_key",
    left: {
      value: leftKey,
      receipt_id: chemblReceipt.receipt_id,
      asset_id: chemblReceipt.asset_ref.asset_id,
      source_id: chemblReceipt.source_id,
      relative_path: chemblReceipt.relative_path,
      json_pointer: chemblPointer,
    },
    right: {
      value: pubchem.inchiKey,
      receipt_id: pubchemReceipt.receipt_id,
      asset_id: pubchemReceipt.asset_ref.asset_id,
      source_id: pubchemReceipt.source_id,
      relative_path: pubchemReceipt.relative_path,
      json_pointer: pubchemPointer,
    },
  };
  const crosswalkBody = {
    left_id: input.chembl_compound.compound_id,
    left_namespace: "chembl_compound" as const,
    right_id: rightId,
    right_namespace: "pubchem_cid" as const,
    relation_type: "compound_identity_link" as const,
    match_method: "exact_inchi_key" as const,
    match_evidence: identityEvidence,
    conflict_status: matched ? "matched" as const : "conflict" as const,
    conflict_details: matched ? null : {
      compared_field: "inchi_key",
      left_value: leftKey,
      right_value: pubchem.inchiKey,
    },
    confidence_score: matched ? 1 : 0,
    confidence_level: matched ? "high" as const : "low" as const,
    source_id: `source_identity_${canonicalDigest(identityEvidence).slice(0, 20)}`,
  };
  const crosswalk: BioactivityCompoundCrosswalkInput = {
    crosswalk_id: `crosswalk_${canonicalDigest(crosswalkBody).slice(0, 32)}`,
    ...crosswalkBody,
  };
  const pubchemCompound: BioactivityCompoundInput = {
    compound_id: rightId,
    compound_id_namespace: "pubchem_cid",
    preferred_name: pubchem.preferredName,
    canonical_smiles: pubchem.canonicalSmiles,
    isomeric_smiles: pubchem.isomericSmiles,
    inchi: pubchem.inchi,
    inchi_key: pubchem.inchiKey,
    molecular_formula: pubchem.molecularFormula,
    molecular_weight: pubchem.molecularWeight,
    source_id: pubchemReceipt.source_id,
  };
  const snapshot = assessmentSnapshot(
    crosswalk,
    chemblReceipt,
    pubchemReceipt,
    chemblPointer,
    pubchemPointer,
    artifacts,
  );
  return {
    compounds: [{ ...input.chembl_compound, inchi_key: leftKey }, pubchemCompound],
    compound_crosswalks: [crosswalk],
    assessment: assessProduct(BIOACTIVITY_IDENTITY_REQUIREMENTS, snapshot),
  };
}
