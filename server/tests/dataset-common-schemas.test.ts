import { describe, expect, it } from "vitest";

import {
  COMMON_SCHEMA_KINDS,
  CONFIDENCE_LEVELS,
  ID_NAMESPACES,
  MEASUREMENT_RELATIONS,
  RELATION_CARDINALITIES,
  RELATION_TYPES,
  UNIT_VOCABULARY,
  buildAssayTable,
  buildBiomedicalRelation,
  buildCommonSchema,
  buildCommonTable,
  buildCompoundCrosswalkTable,
  buildCompoundTable,
  buildEntityCrosswalkTable,
  buildEntityTable,
  buildPaperTable,
  buildSourceTable,
  buildStructureDimensionTable,
  buildTrialTable,
  parseBiomedicalUnit,
  parseConfidenceLevel,
  parseCrosswalkConflictStatus,
  parseCrosswalkMatchMethod,
  parseIdNamespace,
  parseMeasurementRelation,
  parseRelationType,
} from "../src/dataset/schema/index.js";
import {
  parseDatasetSchemaV2,
  parseRelationDefinition,
  parseTableDefinition,
} from "../src/dataset/contracts/index.js";
import { createDefaultDatasetFamilyRegistry } from "../src/dataset/families/index.js";

const FAMILY = "bioactivity_measurement";

const builders = [
  ["entity", buildEntityTable],
  ["paper", buildPaperTable],
  ["compound", buildCompoundTable],
  ["assay", buildAssayTable],
  ["structure_dimension", buildStructureDimensionTable],
  ["trial", buildTrialTable],
  ["source", buildSourceTable],
  ["entity_crosswalk", buildEntityCrosswalkTable],
  ["compound_crosswalk", buildCompoundCrosswalkTable],
] as const;

describe("parameterized biomedical common schemas", () => {
  it("builds every reusable schema under the requesting family without registering it", () => {
    expect(COMMON_SCHEMA_KINDS).toHaveLength(9);
    for (const kind of COMMON_SCHEMA_KINDS) {
      const schema = buildCommonSchema(kind, { datasetFamily: FAMILY });
      expect(parseDatasetSchemaV2(schema)).toEqual(schema);
      expect(schema.dataset_family).toBe(FAMILY);
      expect(schema.schema_id).toBe(`${FAMILY}.common.${kind}.v1`);
      expect(schema.fields.every((field) => field.schema_version === "2.0")).toBe(true);
      expect(schema.primary_key.every((key) => schema.fields.some((field) => field.name === key))).toBe(true);
    }

    expect(createDefaultDatasetFamilyRegistry().list()).toEqual([
      "bioactivity_measurement",
      "gene_expression",
      "gut_microbiome",
      "inherited_disease_gene_evidence",
      "literature_evidence",
      "protein_structure",
      "target_evidence",
      "variant_evidence",
    ]);
  });

  it.each(builders)("builds a validated %s table definition", (_kind, builder) => {
    const result = builder({
      datasetFamily: FAMILY,
      tableId: `${_kind}_records`,
      role: _kind === "compound" ? "primary" : "supporting",
    });
    expect(parseDatasetSchemaV2(result.schema)).toEqual(result.schema);
    expect(parseTableDefinition(result.definition)).toEqual(result.definition);
    expect(result.definition.schema_ref).toBe(result.schema.schema_id);
    expect(result.definition.field_names).toEqual(result.schema.fields.map((field) => field.name));
    expect(result.definition.primary_key).toEqual(result.schema.primary_key);
  });

  it("supports family-specific table projections only when required fields remain present", () => {
    const projected = buildCommonTable("paper", {
      datasetFamily: FAMILY,
      tableId: "paper_records",
      role: "supporting",
      fieldNames: [
        "paper_id",
        "paper_id_namespace",
        "title",
        "source_id",
      ],
    });
    expect(projected.definition.field_names).toEqual([
      "paper_id",
      "paper_id_namespace",
      "title",
      "source_id",
    ]);
    expect(() => buildCommonTable("paper", {
      datasetFamily: FAMILY,
      tableId: "invalid_paper_records",
      role: "supporting",
      fieldNames: ["title", "source_id"],
    })).toThrow(/required field/);
    expect(() => buildCommonTable("paper", {
      datasetFamily: FAMILY,
      tableId: "invalid_paper_records",
      role: "primary",
      allowEmpty: true,
    })).toThrow(/primary common tables/);
  });

  it("keeps source carriers distinct from dataset families", () => {
    const source = buildSourceTable({
      datasetFamily: "target_evidence",
      tableId: "sources",
      role: "supporting",
    });
    expect(source.schema.dataset_family).toBe("target_evidence");
    expect(source.schema.row_granularity).toContain("source carrier");
    expect(source.schema.schema_id).toContain("common.source");
    expect(source.schema.dataset_family).not.toBe("source");
  });

  it("retains crosswalk evidence, conflict, and confidence columns", () => {
    for (const build of [buildEntityCrosswalkTable, buildCompoundCrosswalkTable]) {
      const { schema } = build({
        datasetFamily: FAMILY,
        tableId: "crosswalk",
        role: "supporting",
      });
      const fields = new Map(schema.fields.map((field) => [field.name, field]));
      expect(fields.get("match_evidence")?.data_type).toBe("json");
      expect(fields.get("match_evidence")?.required).toBe(true);
      expect(fields.get("conflict_status")?.ontology).toBe("biomed:crosswalk_conflict_status.v1");
      expect(fields.get("conflict_details")?.data_type).toBe("json");
      expect(fields.get("confidence_score")?.data_type).toBe("float");
      expect(fields.get("confidence_level")?.ontology).toBe("biomed:confidence_level.v1");
      expect(schema.primary_key).toEqual(["crosswalk_id"]);
    }
  });

  it("builds typed relations through the shared B1 relation contract", () => {
    const relation = buildBiomedicalRelation({
      relationType: "compound_has_activity",
      fromTableId: "activities",
      fromFields: ["compound_id"],
      toTableId: "compounds",
      toFields: ["compound_id"],
      cardinality: "many_to_one",
      missingPolicy: "reject",
    });
    expect(parseRelationDefinition(relation)).toEqual(relation);
    expect(relation.relation_id).toBe("compound_has_activity");
    expect(() => buildBiomedicalRelation({
      relationType: "compound_has_activity",
      fromTableId: "activities",
      fromFields: ["compound_id"],
      toTableId: "compounds",
      toFields: ["compound_id"],
      cardinality: "many_to_one",
      relationId: "bad relation id",
    })).toThrow(/safe path identifier/);
  });
});

describe("biomedical controlled vocabularies", () => {
  it("exposes finite ID, relation, cardinality, unit, and confidence vocabularies", () => {
    expect(ID_NAMESPACES).toContain("pubmed");
    expect(ID_NAMESPACES).toContain("inchi_key");
    expect(RELATION_TYPES).toContain("compound_identity_link");
    expect(RELATION_CARDINALITIES).toEqual([
      "one_to_one",
      "one_to_many",
      "many_to_one",
      "many_to_many",
    ]);
    expect(MEASUREMENT_RELATIONS).toEqual(["=", "<", ">", "<=", ">=", "~"]);
    expect(UNIT_VOCABULARY).toContain("nM");
    expect(CONFIDENCE_LEVELS).toEqual(["high", "medium", "low"]);
  });

  it("accepts controlled tokens and rejects silent vocabulary drift", () => {
    expect(parseIdNamespace("pubmed")).toBe("pubmed");
    expect(parseRelationType("compound_identity_link")).toBe("compound_identity_link");
    expect(parseMeasurementRelation("<=")).toBe("<=");
    expect(parseBiomedicalUnit("nM")).toBe("nM");
    expect(parseCrosswalkMatchMethod("exact_inchi_key")).toBe("exact_inchi_key");
    expect(parseCrosswalkConflictStatus("conflict")).toBe("conflict");
    expect(parseConfidenceLevel("high")).toBe("high");
    expect(() => parseIdNamespace("guessed_database")).toThrow(/controlled vocabulary/);
    expect(() => parseRelationType("links_somehow")).toThrow(/controlled vocabulary/);
    expect(() => parseBiomedicalUnit("unknown_unit")).toThrow(/controlled vocabulary/);
  });
});
