import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { xlsxWorksheetsToCsv } from "../src/dataset/acquisition/xlsx-to-csv.js";
import {
  GUT_MICROBIOME_PAPER_SUPPLEMENT_CSV_ADAPTER_ID,
  joinPaperDifferentials,
  parseGutMicrobiomeCarrier,
} from "../src/dataset/families/gut-microbiome/index.js";

const FORSLUND_XLSX = "data/gold/gold10_gut_microbiome/raw/papers/forslund2017/MOESM4_ESM.xlsx";
const RETRIEVED_AT = "2026-08-28T00:00:00Z";

function paperRequest(bytes: Buffer, options: { logicalFile?: string; mediaType?: string } = {}) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    assetId: `asset_${sha256}`,
    logicalFile: options.logicalFile ?? "PMC5090114_supplementary/MOESM4_ESM.xlsx__Supplementary_Data_1.csv",
    retrievedAt: RETRIEVED_AT,
    mediaType: options.mediaType ?? "text/csv",
    bytes,
    studyId: "MGYS00000001",
    adapterId: GUT_MICROBIOME_PAPER_SUPPLEMENT_CSV_ADAPTER_ID,
    accession: "PMC5090114",
    sourceId: "source_europepmc_supplement_fixture",
  };
}

/** Same layout class as the forslund stat panel, including the irregular sub-header hole. */
const SYNTHETIC_PANEL = Buffer.from(
  '"Long title with an embedded\nnewline and, commas",,,,,,,,\n' +
    "mOTU ,UDCA,,,GCDCA,,,,TLCA,,\n" +
    ",β,pvalue,q value,β,,q value,,β,pvalue\n" +
    "Alistipes putredinis,0.5,0.01,0.05,-0.25,0.5,0.6,,0.9,0.95\n" +
    '"[Ruminococcus] torques",-0.1,0.2,0.3,,,,,,,',
  "utf8",
);

describe("Gold10 paper supplement differential CSV", () => {
  it("extracts effect/p/adjusted-p records from a merged two-row-header statistics panel", () => {
    const rows = parseGutMicrobiomeCarrier(paperRequest(SYNTHETIC_PANEL));
    // 3 complete groups resolve for Alistipes (UDCA, GCDCA via pattern fill, TLCA)
    // and 1 for R. torques; GCDCA's merged `pvalue` hole must inherit p from the
    // recurring block pattern rather than being dropped.
    expect(rows.paperDifferentials).toHaveLength(4);
    const first = rows.paperDifferentials.find(
      (record) => record.reported_taxon_name === "Alistipes putredinis" && record.comparison_label === "UDCA")!;
    expect(first).toMatchObject({
      study_id: "MGYS00000001",
      effect_size: 0.5,
      p_value: 0.01,
      adjusted_p_value: 0.05,
      effect_direction: "increase",
    });
    expect(first.comparison_id).toBe("moesm4_esm__alistipes_putredinis__udca");
    const gcdca = rows.paperDifferentials.find(
      (record) => record.reported_taxon_name === "Alistipes putredinis" && record.comparison_label === "GCDCA")!;
    expect(gcdca).toMatchObject({ effect_size: -0.25, p_value: 0.5, adjusted_p_value: 0.6, effect_direction: "decrease" });
    const negative = rows.paperDifferentials.find(
      (record) => record.reported_taxon_name === "[Ruminococcus] torques" && record.comparison_label === "UDCA")!;
    expect(negative).toMatchObject({ effect_size: -0.1, effect_direction: "decrease", adjusted_p_value: 0.3 });
  });

  it("joins reported names to ESearch taxids and skips unresolved names deterministically", () => {
    const rows = parseGutMicrobiomeCarrier(paperRequest(SYNTHETIC_PANEL));
    const joined = joinPaperDifferentials(rows.paperDifferentials, [
      {
        query_name: "Alistipes putredinis",
        taxon_id: "239759",
        source_id: "source_ncbi_esearch_fixture",
        source_asset_id: rows.paperDifferentials[0]!.source_asset_id,
        source_locator: rows.paperDifferentials[0]!.source_locator,
      },
    ]);
    expect(joined).toHaveLength(3);
    expect(joined.every((row) => row.taxon_id === "239759")).toBe(true);
  });

  it("fails closed with the verbatim-name remedy when no paper name joins a resolution", () => {
    const rows = parseGutMicrobiomeCarrier(paperRequest(SYNTHETIC_PANEL));
    expect(() => joinPaperDifferentials(rows.paperDifferentials, [])).toThrow(
      /could not join any NCBI taxon.*verbatim reported taxon names/,
    );
  });

  it("rejects non-extraction assets so the zip archive cannot be bound directly", () => {
    expect(() => parseGutMicrobiomeCarrier(paperRequest(SYNTHETIC_PANEL, { mediaType: "application/zip" }))).toThrow(
      /text\/csv extraction member asset/,
    );
  });

  it("parses the real forslund MOESM4 worksheet CSV into the full 1380-record panel", () => {
    if (!existsSync(FORSLUND_XLSX)) return; // frozen gold fixture; skip when the gold data dir is absent
    const worksheets = xlsxWorksheetsToCsv(readFileSync(FORSLUND_XLSX), {
      maxWorksheets: 12,
      maxCsvBytes: 32 * 1024 * 1024,
    });
    expect(worksheets).toHaveLength(1);
    const rows = parseGutMicrobiomeCarrier(paperRequest(Buffer.from(worksheets[0]!.csv)));
    expect(rows.paperDifferentials).toHaveLength(1380);
    const torquesUdca = rows.paperDifferentials.find(
      (record) => record.reported_taxon_name === "[Ruminococcus] torques" && record.comparison_label === "UDCA")!;
    expect(torquesUdca).toMatchObject({
      effect_size: 0.00820817,
      p_value: 0.890917492,
      adjusted_p_value: 0.931413741636364,
      effect_direction: "increase",
    });
    const gcdca = rows.paperDifferentials.find(
      (record) => record.reported_taxon_name === "[Ruminococcus] torques" && record.comparison_label === "GCDCA")!;
    // GCDCA's sub-header has a merged hole; the recurring β/p/q pattern must fill p from data columns 4/5.
    expect(gcdca).toMatchObject({ effect_size: 0.122225047, p_value: 0.235496392, adjusted_p_value: 0.714853005 });
  });
});
