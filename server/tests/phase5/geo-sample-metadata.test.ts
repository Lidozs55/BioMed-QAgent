/**
 * P5-04 GEO sample metadata (mirror
 * ``backend/tests/test_geo_sample_metadata.py``) plus golden parity against
 * the Python parse of the real GSE178352 family SOFT fixture.
 */

import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  GROUP_RULE_ID,
  extractPairingId,
  extractSampleGroup,
  parseGeoSeriesMatrixSamples,
  parseGeoSoftSamples,
  sampleMetadataCsv,
  validatePairings,
  type GeoSampleMetadata,
} from "../../src/dataset/adapters/geo/sample-metadata.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/geo", import.meta.url));

function sample(
  sampleId: string,
  group: "tumor" | "normal" | "unknown",
  pairingId: string | null,
): GeoSampleMetadata {
  return {
    sample_id: sampleId,
    source_sample_alias: null,
    title: "",
    organism: "",
    platform_id: null,
    sample_group: group,
    sample_group_raw: "",
    pairing_id: pairingId,
    group_rule_id: GROUP_RULE_ID,
  };
}

describe("extract_sample_group", () => {
  test("normalizes keys and preserves raw evidence", () => {
    const result = extractSampleGroup({ TISSUE_TYPE: "Primary Tumor" }, null);
    expect(result.sample_group).toBe("tumor");
    expect(result.sample_group_raw).toBe("TISSUE_TYPE:Primary Tumor");
    expect(result.warnings).toEqual([]);
  });

  test("conflict is unknown; cell-line control is not normal", () => {
    const conflict = extractSampleGroup(
      { "sample type": "tumor", condition: "normal" },
      null,
    );
    expect(conflict.sample_group).toBe("unknown");
    expect(conflict.warnings[0]).toContain("conflicting");
    const control = extractSampleGroup(
      { "cell line": "MCF7", condition: "control" },
      "Cancer control",
    );
    expect(control.sample_group).toBe("unknown");
  });

  test("fallback evidence uses source name and title", () => {
    const byTitle = extractSampleGroup({}, "Adjacent normal tissue");
    expect(byTitle.sample_group).toBe("normal");
    const bySource = extractSampleGroup(
      { "source name": "non-tumor lung" },
      null,
    );
    expect(bySource.sample_group).toBe("normal");
  });
});

describe("extract_pairing_id", () => {
  test("accepts only explicit normalized keys", () => {
    expect(extractPairingId({ PATIENT_ID: "Patient-01" })).toBe("patient 01");
    expect(extractPairingId({ "sample name": "Patient-01" })).toBeNull();
    expect(extractPairingId(null)).toBeNull();
  });
});

describe("validate_pairings", () => {
  test("requires both tumor and normal sides", () => {
    const warnings = validatePairings([
      sample("GSM1", "tumor", "p1"),
      sample("GSM2", "normal", "p1"),
      sample("GSM3", "tumor", "p2"),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("p2");
    expect(warnings[0]).not.toContain("p1");
    expect(warnings[0]).toContain("one-sided");
  });
});

describe("series matrix and SOFT share the versioned extractor", () => {
  const MATRIX =
    '!Sample_geo_accession\t"GSM10"\t"GSM11"\n' +
    '!Sample_title\t"Tumor P1"\t"Normal P1"\n' +
    '!Sample_organism_ch1\t"Homo sapiens"\t"Homo sapiens"\n' +
    '!Sample_platform_id\t"GPL570"\t"GPL570"\n' +
    '!Sample_characteristics_ch1\t"tissue type: tumor"\t"tissue type: normal"\n' +
    '!Sample_characteristics_ch1\t"subject id: P1"\t"subject id: P1"\n' +
    "!series_matrix_table_begin\n";

  const SOFT =
    "^SAMPLE = GSM10\n" +
    "!Sample_description = Sample A1\n" +
    "!Sample_title = Tumor P1\n" +
    "!Sample_platform_id = GPL570\n" +
    "!Sample_characteristics_ch1 = tissue type: tumor\n" +
    "!Sample_characteristics_ch1 = subject id: P1\n";

  test("matrix extractor: groups, pairing, platform", () => {
    const { samples, warnings } = parseGeoSeriesMatrixSamples(MATRIX);
    expect(warnings).toEqual([]);
    expect(samples.map((item) => item.sample_group)).toEqual(["tumor", "normal"]);
    expect(samples.map((item) => item.pairing_id)).toEqual(["p1", "p1"]);
    expect(samples[0].platform_id).toBe("GPL570");
    expect(samples[0].organism).toBe("Homo sapiens");
  });

  test("soft extractor: alias, group and one-sided pairing warning", () => {
    const { samples, warnings } = parseGeoSoftSamples(SOFT);
    expect(warnings).toEqual([
      "pairing p1 is one-sided (groups=['tumor']) - no valid tumor/normal pair",
    ]);
    expect(samples[0].sample_group).toBe("tumor");
    expect(samples[0].source_sample_alias).toBe("A1");
    expect(samples[0].group_rule_id).toBe(GROUP_RULE_ID);
    expect(samples[0].sample_group_raw).toBe("tissue type:tumor");
  });
});

describe("real GSE178352 family SOFT golden parity", () => {
  test("matches the Python parse_geo_soft_samples golden", () => {
    const text = gunzipSync(
      readFileSync(path.join(FIXTURES, "gse178352_family.soft.gz")),
    ).toString("utf8");
    const { samples, warnings } = parseGeoSoftSamples(text);
    const golden = JSON.parse(
      readFileSync(path.join(FIXTURES, "geo_soft_samples.golden.json"), "utf8"),
    ) as {
      samples: Array<Record<string, unknown>>;
      warnings: string[];
    };
    expect(warnings).toEqual(golden.warnings);
    const normalized = samples.map(({ ...rest }) => rest);
    const expected = golden.samples.map((record) => {
      const copy = { ...record };
      delete copy.schema_version;
      return copy;
    });
    expect(normalized).toEqual(expected);
    expect(samples).toHaveLength(12);
    expect(samples[0].sample_id).toBe("GSM5388270");
    expect(samples[0].source_sample_alias).toBe("A1");
    expect(samples[0].platform_id).toBe("GPL24676");
    expect(samples[0].organism).toBe("Homo sapiens");
  });
});

describe("write_sample_metadata serialization", () => {
  test("CSV rows carry the versioned group rule", () => {
    const csv = sampleMetadataCsv([
      {
        sample_id: "GSM1",
        source_sample_alias: "S1",
        title: "T",
        organism: "Homo sapiens",
        platform_id: "GPL570",
        sample_group: "tumor",
        sample_group_raw: "tissue type:tumor",
        pairing_id: "p1",
        group_rule_id: GROUP_RULE_ID,
      },
    ]);
    const lines = csv.split(/\r\n|\n|\r/).filter((line) => line !== "");
    expect(lines[0]).toBe(
      "sample_id,source_sample_alias,title,organism,platform_id,sample_group,sample_group_raw,pairing_id,group_rule_id",
    );
    expect(lines[1]).toBe(
      "GSM1,S1,T,Homo sapiens,GPL570,tumor,tissue type:tumor,p1,geo.sample-group.v1",
    );
  });
});
