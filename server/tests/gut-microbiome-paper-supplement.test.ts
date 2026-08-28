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
const MORGAN_S9_XLSX = "data/gold/gold10_gut_microbiome/raw/papers/morgan2012_ibd/gb-2012-13-9-r79-S9.XLSX";
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

/** Same layout class as the Morgan 2012 S9 LEfSe panel (single header row, lineage entities). */
const SINGLE_ROW_PANEL = Buffer.from(
  "Clade,Max. value,Effect size,P\n" +
    "Bacteria.Firmicutes.Clostridia.Clostridiales.Ruminococcaceae,RectumSigmoidRectosigmoid,4.81055595378,5.28296506597e-08\n" +
    "Bacteria.Bacteroidetes.Bacteroidia.Bacteroidales.Prevotellaceae,Cecum,4.72531006384,2.56557737657e-07\n" +
    "Bacteria.Firmicutes.Clostridia.Clostridiales.Lachnospiraceae,RectumSigmoidRectosigmoid,4.15620610914,4.78364532053e-06\n" +
    "Bacteria.Firmicutes.Clostridia.Clostridiales.Ruminococcaceae,Cecum,4.16710937072,0.000182884055615",
  "utf8",
);

describe("Gold10 paper supplement differential CSV", () => {
  it("extracts single-header LEfSe panels with terminal taxon names and side-label comparisons", () => {
    const rows = parseGutMicrobiomeCarrier(paperRequest(SINGLE_ROW_PANEL, { logicalFile: "PMC3506950_supplementary/gb-2012-13-9-r79-S9.XLSX__Sheet1.csv" }));
    expect(rows.paperDifferentials).toHaveLength(4);
    const first = rows.paperDifferentials[0]!;
    expect(first).toMatchObject({
      reported_taxon_name: "Ruminococcaceae",
      comparison_label: "RectumSigmoidRectosigmoid",
      effect_size: 4.81055595378,
      p_value: 5.28296506597e-08,
      adjusted_p_value: null,
      effect_direction: "increase",
    });
    expect(first.comparison_id).toBe("gb_2012_13_9_r79_s9__ruminococcaceae__rectumsigmoidrectosigmoid");
    // Same clade with a different side label keeps a distinct comparison id;
    // exact duplicates fall back to a row-ordinal suffix.
    const ids = rows.paperDifferentials.map((record) => record.comparison_id);
    expect(new Set(ids).size).toBe(ids.length);
    const cecum = rows.paperDifferentials.find((record) => record.comparison_label === "Cecum" && record.reported_taxon_name === "Ruminococcaceae")!;
    expect(cecum.comparison_id).toBe("gb_2012_13_9_r79_s9__ruminococcaceae__cecum");
  });

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

  it("parses the real Morgan S9 LEfSe worksheet CSV into terminal-taxon records", () => {
    if (!existsSync(MORGAN_S9_XLSX)) return; // frozen gold fixture; skip when absent
    const worksheets = xlsxWorksheetsToCsv(readFileSync(MORGAN_S9_XLSX), {
      maxWorksheets: 12,
      maxCsvBytes: 32 * 1024 * 1024,
    });
    expect(worksheets).toHaveLength(1);
    const rows = parseGutMicrobiomeCarrier(paperRequest(Buffer.from(worksheets[0]!.csv), {
      logicalFile: "PMC3506950_supplementary/gb-2012-13-9-r79-S9.XLSX__Sheet1.csv",
    }));
    expect(rows.paperDifferentials.length).toBeGreaterThanOrEqual(20);
    const first = rows.paperDifferentials[0]!;
    expect(first.reported_taxon_name).not.toContain(".");
    expect(first).toMatchObject({ effect_size: 4.81055595378, p_value: 5.28296506597e-08, effect_direction: "increase" });
    expect(first.comparison_label).toBe("RectumSigmoidRectosigmoid");
  });
});
