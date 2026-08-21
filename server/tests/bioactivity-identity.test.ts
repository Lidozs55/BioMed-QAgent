import type {
  ProductArtifactFact,
  SourceAssetRegistrationReceipt,
} from "@biomed/contracts";
import { describe, expect, it } from "vitest";

import {
  BIOACTIVITY_IDENTITY_TRANSFORM_DIGEST,
  BIOACTIVITY_IDENTITY_TRANSFORM_ID,
  bioactivityCompoundCrosswalkTable,
  bioactivityIdentityRelations,
  bioactivityTableEntries,
  buildBioactivityIdentity,
  parsePubChemIdentityCarrier,
  type BioactivityCompoundInput,
  type BioactivityIdentityInput,
} from "../src/dataset/families/bioactivity-measurement/index.js";

const TASK_ID = "task_identity_fixture";
const CHEMBL_KEY = "BSYNRYMUTXBXSQ-UHFFFAOYSA-N";
const OTHER_KEY = "RZVAJINKPMORJF-UHFFFAOYSA-N";

function receipt(
  digest: string,
  sourceId: string,
  role: "source" | "carrier",
): SourceAssetRegistrationReceipt {
  return {
    schema_version: "1.0",
    receipt_id: `receipt_${digest.slice(0, 16)}_${role}`,
    task_id: TASK_ID,
    asset_ref: {
      schema_version: "1.0",
      asset_id: `asset_${digest}`,
      task_id: TASK_ID,
      role,
    },
    source_id: sourceId,
    relative_path: `source_assets/${sourceId}/identity.json`,
    sha256: digest,
    size_bytes: 512,
    media_type: "application/json",
    registered_at: "2026-08-20T00:00:00Z",
    path_compatibility: {
      schema_version: "1.0",
      mode: "asset_id",
      legacy_path: null,
      telemetry_event: "asset_ref_used",
    },
  };
}

function chemblCompound(inchiKey = CHEMBL_KEY): BioactivityCompoundInput {
  return {
    compound_id: "CHEMBL_FIXTURE_25",
    compound_id_namespace: "chembl_compound",
    preferred_name: "Fixture compound",
    canonical_smiles: "CC(=O)OC1=CC=CC=C1C(=O)O",
    isomeric_smiles: null,
    inchi: null,
    inchi_key: inchiKey,
    molecular_formula: "C9H8O4",
    molecular_weight: 180.16,
    source_id: "source_chembl_fixture",
  };
}

function pubchemDocument(inchiKey = CHEMBL_KEY): unknown {
  return {
    PropertyTable: {
      Properties: [{
        CID: 2244,
        MolecularFormula: "C9H8O4",
        MolecularWeight: 180.16,
        IUPACName: "2-acetyloxybenzoic acid",
        CanonicalSMILES: "CC(=O)OC1=CC=CC=C1C(=O)O",
        IsomericSMILES: "CC(=O)OC1=CC=CC=C1C(=O)O",
        InChIKey: inchiKey,
        InChI: "InChI=1S/C9H8O4",
      }],
    },
  };
}

const HASHED_ARTIFACTS: readonly ProductArtifactFact[] = [
  { artifact_id: "artifact_compound_identity", role: "compound_identity", sha256: "c".repeat(64) },
  { artifact_id: "artifact_compound_crosswalk", role: "compound_crosswalk", sha256: "d".repeat(64) },
];

function input(overrides: Partial<BioactivityIdentityInput> = {}): BioactivityIdentityInput {
  return {
    task_id: TASK_ID,
    chembl_compound: chemblCompound(),
    chembl_source: {
      receipt: receipt("a".repeat(64), "source_chembl_fixture", "source"),
      json_pointer: "/activities/0/molecule",
    },
    pubchem_carrier: {
      receipt: receipt("b".repeat(64), "source_pubchem_fixture", "carrier"),
      json_pointer: "/PropertyTable/Properties/0",
      expected_cid: 2244,
      document: pubchemDocument(),
    },
    ...overrides,
  };
}

describe("bioactivity identity semantic module", () => {
  it("preserves the legacy ChEMBL-only four-table inventory", () => {
    expect(bioactivityTableEntries().map((entry) => entry.tableId)).toEqual([
      "activities",
      "compounds",
      "assays",
      "targets",
    ]);
    expect(bioactivityTableEntries()).toHaveLength(4);
    expect(bioactivityTableEntries().map((entry) => String(entry.tableId))).not.toContain("compound_crosswalks");
  });

  it("defines an optional non-empty crosswalk table and both compound relations", () => {
    expect(bioactivityCompoundCrosswalkTable).toMatchObject({
      table_id: "compound_crosswalks",
      role: "supporting",
      required: false,
      allow_empty: false,
    });
    expect(bioactivityIdentityRelations.map((relation) => relation.relation_id)).toEqual([
      "crosswalk_left_compound",
      "crosswalk_right_compound",
    ]);
    expect(bioactivityIdentityRelations.every((relation) =>
      relation.to_table_id === "compounds" && relation.missing_policy === "reject"),
    ).toBe(true);
  });

  it("builds separate compound identities and a publishable exact-InChIKey crosswalk", () => {
    const result = buildBioactivityIdentity(input(), HASHED_ARTIFACTS);

    expect(result.compounds).toHaveLength(2);
    expect(result.compounds.map((compound) => [compound.compound_id, compound.compound_id_namespace])).toEqual([
      ["CHEMBL_FIXTURE_25", "chembl_compound"],
      ["2244", "pubchem_cid"],
    ]);
    expect(result.compound_crosswalks[0]).toMatchObject({
      left_id: "CHEMBL_FIXTURE_25",
      left_namespace: "chembl_compound",
      right_id: "2244",
      right_namespace: "pubchem_cid",
      relation_type: "compound_identity_link",
      match_method: "exact_inchi_key",
      conflict_status: "matched",
      conflict_details: null,
      confidence_score: 1,
      confidence_level: "high",
    });
    expect(result.compound_crosswalks[0].match_evidence).toMatchObject({
      transform_id: BIOACTIVITY_IDENTITY_TRANSFORM_ID,
      transform_digest: BIOACTIVITY_IDENTITY_TRANSFORM_DIGEST,
      compared_field: "inchi_key",
      left: expect.objectContaining({ receipt_id: expect.stringMatching(/^receipt_/), json_pointer: "/activities/0/molecule" }),
      right: expect.objectContaining({ receipt_id: expect.stringMatching(/^receipt_/), json_pointer: "/PropertyTable/Properties/0" }),
    });
    expect(result.assessment.product_status).toBe("publishable");
    expect(result.assessment.blockers).toEqual([]);
  });

  it("retains conflicting identities and reports an incomplete assessment", () => {
    const result = buildBioactivityIdentity(input({
      pubchem_carrier: {
        ...input().pubchem_carrier,
        document: pubchemDocument(OTHER_KEY),
      },
    }), HASHED_ARTIFACTS);

    expect(result.compounds).toHaveLength(2);
    expect(result.compound_crosswalks[0]).toMatchObject({
      conflict_status: "conflict",
      confidence_score: 0,
      confidence_level: "low",
      conflict_details: {
        compared_field: "inchi_key",
        left_value: CHEMBL_KEY,
        right_value: OTHER_KEY,
      },
    });
    expect(result.assessment.product_status).toBe("incomplete");
    expect(result.assessment.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      "cross_reference_not_closed",
      "identity_not_closed",
      "human_review_pending",
    ]));
  });

  it("distinguishes semantic closure from missing reproducible artifacts", () => {
    const artifacts = HASHED_ARTIFACTS.map((artifact) => ({ ...artifact, sha256: null }));
    const result = buildBioactivityIdentity(input(), artifacts);

    expect(result.assessment.product_status).toBe("validated");
    expect(result.assessment.blockers).toEqual([
      expect.objectContaining({ code: "artifact_incomplete", dimension: "reproducibility" }),
    ]);
  });

  it("is deterministic for identical receipt-backed inputs", () => {
    const first = buildBioactivityIdentity(input(), HASHED_ARTIFACTS);
    const second = buildBioactivityIdentity(input(), [...HASHED_ARTIFACTS].reverse());

    expect(second).toEqual(first);
    expect(first.compound_crosswalks[0].crosswalk_id).toMatch(/^crosswalk_[0-9a-f]{32}$/);
    expect(BIOACTIVITY_IDENTITY_TRANSFORM_DIGEST).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["HTML/tool fallback", "<html>compound</html>", /must be an object/],
    ["empty properties", { PropertyTable: { Properties: [] } }, /exactly one record/],
    ["multiple properties", { PropertyTable: { Properties: [{ CID: 2244, InChIKey: CHEMBL_KEY }, { CID: 2245, InChIKey: CHEMBL_KEY }] } }, /exactly one record/],
    ["unknown envelope field", { PropertyTable: { Properties: [{ CID: 2244, InChIKey: CHEMBL_KEY }] }, method_used: "api" }, /unknown fields/],
    ["unknown record field", { PropertyTable: { Properties: [{ CID: 2244, InChIKey: CHEMBL_KEY, unexpected: true }] } }, /unknown fields/],
    ["CID mismatch", { PropertyTable: { Properties: [{ CID: 9999, InChIKey: CHEMBL_KEY }] } }, /does not match/],
    ["missing InChIKey", { PropertyTable: { Properties: [{ CID: 2244 }] } }, /InChIKey is required/],
    ["invalid weight", { PropertyTable: { Properties: [{ CID: 2244, InChIKey: CHEMBL_KEY, MolecularWeight: -1 }] } }, /positive finite/],
  ])("rejects strict PubChem carrier case: %s", (_name, document, error) => {
    expect(() => parsePubChemIdentityCarrier(document, 2244)).toThrow(error as RegExp);
  });

  it("rejects receipt identity, task, role, media, and asset closure violations", () => {
    const wrongTask = input();
    wrongTask.pubchem_carrier.receipt = {
      ...wrongTask.pubchem_carrier.receipt,
      task_id: "task_other",
      asset_ref: { ...wrongTask.pubchem_carrier.receipt.asset_ref, task_id: "task_other" },
    };
    expect(() => buildBioactivityIdentity(wrongTask, HASHED_ARTIFACTS)).toThrow(/different task/);

    const sameAsset = input();
    sameAsset.pubchem_carrier.receipt = {
      ...sameAsset.chembl_source.receipt,
      receipt_id: "receipt_duplicate_asset",
      source_id: "source_pubchem_fixture",
      asset_ref: { ...sameAsset.chembl_source.receipt.asset_ref, role: "carrier" },
    };
    expect(() => buildBioactivityIdentity(sameAsset, HASHED_ARTIFACTS)).toThrow(/distinct assets/);

    const wrongMedia = input();
    wrongMedia.pubchem_carrier.receipt = { ...wrongMedia.pubchem_carrier.receipt, media_type: "text/html" };
    expect(() => buildBioactivityIdentity(wrongMedia, HASHED_ARTIFACTS)).toThrow(/application\/json/);

    const wrongRole = input();
    wrongRole.pubchem_carrier.receipt = {
      ...wrongRole.pubchem_carrier.receipt,
      asset_ref: { ...wrongRole.pubchem_carrier.receipt.asset_ref, role: "mapping" },
    };
    expect(() => buildBioactivityIdentity(wrongRole, HASHED_ARTIFACTS)).toThrow(/source or carrier role/);

    const sourceMismatch = input({ chembl_compound: { ...chemblCompound(), source_id: "source_wrong" } });
    expect(() => buildBioactivityIdentity(sourceMismatch, HASHED_ARTIFACTS)).toThrow(/source_id does not match/);
  });
});
