import { describe, expect, it } from "vitest";

import type { CoreAcquisitionRequest } from "@biomed/contracts";

import {
  createGeoFilesProvider,
  createGeoSupplementaryListingResolver,
  GEO_FILES_PROVIDER_ID,
  type SupplementaryListingResolver,
} from "../src/dataset/acquisition/expression-providers.js";
import { fixedBiomedicalAcquisitionParameters } from "../src/dataset/acquisition/biomedical-providers.js";
import { parseAdapterParams } from "../src/dataset/contracts/index.js";

function geoRequest(parameters: Record<string, unknown>): CoreAcquisitionRequest {
  return {
    schema_version: "1.0",
    request_id: "acq_test",
    task_id: "task_ts_test",
    requirement_id: "req_test",
    binding_id: "binding_test",
    mode: "builtin",
    provider_id: GEO_FILES_PROVIDER_ID,
    recipe_id: null,
    recipe_version: null,
    parameters: {
      source: "geo",
      accession: "GSE267442",
      entities: {},
      ...parameters,
    },
  };
}

const LISTING: { filename: string; url: string }[] = [
  {
    filename: "GSE267442_all-TPM.txt.gz",
    url: "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE267nnn/GSE267442/suppl/GSE267442_all-TPM.txt.gz",
  },
  {
    filename: "GSE267442_counts.csv.gz",
    url: "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE267nnn/GSE267442/suppl/GSE267442_counts.csv.gz",
  },
];

const resolver: SupplementaryListingResolver = async () => LISTING;

describe("ADR-044 geo.files.v1 supplementary acquisition", () => {
  it("resolves supplement_index=1 (default) from the server-side listing", async () => {
    const plan = await createGeoFilesProvider({ resolveSupplementaryListing: resolver })
      .plan(geoRequest({ file_class: "supplementary" }));
    expect(plan.source.url).toBe(LISTING[0]!.url);
    expect(plan.filename).toBe("GSE267442_all-TPM.txt.gz");
    expect(plan.providerRevisionFacts).toMatchObject({
      provider_snapshot_identity: "geo:supplementary:v1",
      resolved_filename: "GSE267442_all-TPM.txt.gz",
    });
  });

  it("selects the requested supplement_index", async () => {
    const plan = await createGeoFilesProvider({ resolveSupplementaryListing: resolver })
      .plan(geoRequest({ file_class: "supplementary", supplement_index: 2 }));
    expect(plan.source.url).toBe(LISTING[1]!.url);
  });

  it("rejects an out-of-range supplement_index with the listing size", async () => {
    await expect(
      createGeoFilesProvider({ resolveSupplementaryListing: resolver })
        .plan(geoRequest({ file_class: "supplementary", supplement_index: 3 })),
    ).rejects.toThrow(/out of range.*2 entries/);
  });

  it("fails closed when no listing resolver is wired", async () => {
    await expect(
      createGeoFilesProvider().plan(geoRequest({ file_class: "supplementary" })),
    ).rejects.toThrow(/listing resolver/);
  });

  it("rejects a resolver entry that is not host-canonical", async () => {
    const rogue: SupplementaryListingResolver = async () => [
      { filename: "evil.txt", url: "https://example.invalid/suppl/evil.txt" },
    ];
    await expect(
      createGeoFilesProvider({ resolveSupplementaryListing: rogue })
        .plan(geoRequest({ file_class: "supplementary" })),
    ).rejects.toThrow(/non-canonical/);
  });

  it("keeps the series-matrix carrier byte-identical when file_class is absent", async () => {
    const plan = await createGeoFilesProvider().plan(geoRequest({}));
    expect(plan.source.url).toBe("https://ftp.ncbi.nlm.nih.gov/geo/series/GSE267nnn/GSE267442/matrix/GSE267442_series_matrix.txt.gz");
    expect(plan.providerRevisionFacts).toMatchObject({
      provider_snapshot_identity: "geo:series-matrix:v1",
    });
    expect(plan.providerRevisionFacts?.resolved_filename ?? null).toBe(null);
  });

  it("never collides source_id between matrix and supplementary carriers", async () => {
    const matrix = await createGeoFilesProvider().plan(geoRequest({}));
    const supplementary = await createGeoFilesProvider({ resolveSupplementaryListing: resolver })
      .plan(geoRequest({ file_class: "supplementary" }));
    expect(matrix.source.source_id).not.toBe(supplementary.source.source_id);
  });

  it("rejects unknown file_class values and supplement_index without supplementary", async () => {
    const badClass = async () => createGeoFilesProvider().plan(geoRequest({ file_class: "soft" }));
    await expect(badClass()).rejects.toThrow(/file_class/);
    const orphanIndex = async () => createGeoFilesProvider({ resolveSupplementaryListing: resolver })
      .plan(geoRequest({ supplement_index: 1 }));
    await expect(orphanIndex()).rejects.toThrow(/supplement_index/);
  });
});

describe("ADR-044 binding parameter derivation", () => {
  const base = {
    providerId: GEO_FILES_PROVIDER_ID,
    source: "geo",
    accession: "GSE267442",
    entities: {} as Record<string, string[]>,
  };

  it("derives file_class=supplementary from the adapter format", () => {
    expect(fixedBiomedicalAcquisitionParameters({
      ...base,
      bindingParameters: { format: "supplementary_matrix" },
    })).toMatchObject({ file_class: "supplementary" });
    expect(fixedBiomedicalAcquisitionParameters({
      ...base,
      bindingParameters: { format: "tximport_counts", supplement_index: 2 },
    })).toMatchObject({ file_class: "supplementary", supplement_index: 2 });
  });

  it("keeps series_matrix derivation backward compatible", () => {
    expect(fixedBiomedicalAcquisitionParameters({
      ...base,
      bindingParameters: { format: "series_matrix" },
    })).toMatchObject({ file_class: "series_matrix" });
    expect("supplement_index" in (fixedBiomedicalAcquisitionParameters({
      ...base,
      bindingParameters: { format: "series_matrix" },
    }) ?? {})).toBe(false);
  });

  it("rejects supplement_index on a series-matrix carrier", () => {
    expect(() => fixedBiomedicalAcquisitionParameters({
      ...base,
      bindingParameters: { format: "series_matrix", supplement_index: 1 },
    })).toThrow(/supplementary carrier/);
    expect(() => fixedBiomedicalAcquisitionParameters({
      ...base,
      bindingParameters: { format: "supplementary_matrix", supplement_index: 0 },
    })).toThrow(/positive integer/);
  });
});

describe("ADR-044 AdapterParams.supplement_index", () => {
  const params = {
    schema_version: "1.0",
    value_semantics: "expression_value",
    value_scale: "linear" as const,
    expression_unit: "expression_value",
    platform_ids: ["GPL570"],
  };

  it("accepts a positive index on supplementary formats", () => {
    expect(parseAdapterParams({ ...params, format: "supplementary_matrix", supplement_index: 3 }).supplement_index).toBe(3);
    expect(parseAdapterParams({ ...params, format: "tximport_counts", supplement_index: 1 }).supplement_index).toBe(1);
    expect(parseAdapterParams({ ...params, format: "supplementary_matrix" }).supplement_index).toBeUndefined();
  });

  it("rejects malformed indexes and non-supplementary use", () => {
    expect(() => parseAdapterParams({ ...params, format: "supplementary_matrix", supplement_index: 1.5 })).toThrow(/supplement_index/);
    expect(() => parseAdapterParams({ ...params, format: "supplementary_matrix", supplement_index: 0 })).toThrow(/supplement_index/);
    expect(() => parseAdapterParams({ ...params, format: "series_matrix", supplement_index: 1 })).toThrow(/supplement_index/);
  });
});

describe("ADR-044 production listing resolver", () => {
  it("enumerates the NCBI suppl directory in fixed parse order", async () => {
    const html = Buffer.from(
      "<html><body>" +
      `<a href="GSE267442_all-TPM.txt.gz">GSE267442_all-TPM.txt.gz</a>` +
      `<a href="GSE267442_counts.csv.gz">GSE267442_counts.csv.gz</a>` +
      `<a href="../">parent</a>` +
      `</body></html>`,
    );
    const client = {
      request: async () => ({
        status: 200,
        headers: {},
        url: "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE267nnn/GSE267442/suppl/",
        body: (async function* () { yield html; })(),
        discard: async () => undefined,
      }),
    };
    const listing = await createGeoSupplementaryListingResolver(client as never)("GSE267442");
    expect(listing.map((entry) => entry.filename)).toEqual([
      "GSE267442_all-TPM.txt.gz",
      "GSE267442_counts.csv.gz",
    ]);
  });
});
