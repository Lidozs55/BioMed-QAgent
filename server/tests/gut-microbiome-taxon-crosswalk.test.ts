import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  composeGutMicrobiomeCrosswalk,
  parseGutMicrobiomeCarrier,
} from "../src/dataset/families/gut-microbiome/index.js";

const ASSET_SEED = "gut_microbiome_taxon_crosswalk_fixture";
const RETRIEVED_AT = "2026-08-28T00:00:00Z";

function assetId(seed: string): string {
  return `asset_${createHash("sha256").update(seed).digest("hex")}`;
}

function request(bytes: Buffer, options: {
  adapterId: string;
  accession: string;
  mediaType: string;
  logicalFile: string;
  assetSeed?: string;
}) {
  return {
    assetId: assetId(options.assetSeed ?? ASSET_SEED),
    logicalFile: options.logicalFile,
    retrievedAt: RETRIEVED_AT,
    mediaType: options.mediaType,
    bytes,
    studyId: "MGYS00000001",
    adapterId: options.adapterId,
    accession: options.accession,
    sourceId: `source_ncbi_${options.logicalFile}`,
  };
}

function esearchCarrier(idlist: string[]): Buffer {
  return Buffer.from(JSON.stringify({
    esearchresult: { idlist, querytranslation: "term[SCIN]" },
  }));
}

function efetchCarrier(options: {
  taxId: string;
  scientificName: string;
  otherNames?: string;
  rank?: string;
  lineage?: string;
  parentTaxId?: string;
}): Buffer {
  return Buffer.from(
    "<TaxaSet><Taxon>" +
    `<TaxId>${options.taxId}</TaxId>` +
    `<ScientificName>${options.scientificName}</ScientificName>` +
    (options.otherNames === undefined ? "" : `<OtherNames>${options.otherNames}</OtherNames>`) +
    (options.parentTaxId === undefined ? "" : `<ParentTaxId>${options.parentTaxId}</ParentTaxId>`) +
    `<Rank>${options.rank ?? "species"}</Rank>` +
    (options.lineage === undefined ? "" : `<Lineage>${options.lineage}</Lineage>`) +
    "</Taxon></TaxaSet>",
  );
}

describe("Gold10 taxon name crosswalk", () => {
  it("keeps an empty ESearch idlist as an unresolved resolution instead of failing", () => {
    const rows = parseGutMicrobiomeCarrier(request(esearchCarrier([]), {
      adapterId: "gut_microbiome.ncbi_taxonomy_esearch_json.v1",
      accession: "motu linkage group 349",
      mediaType: "application/json",
      logicalFile: "esearch.json",
    }));
    expect(rows.taxonResolutions).toHaveLength(1);
    expect(rows.taxonResolutions[0]).toMatchObject({
      query_name: "motu linkage group 349",
      taxon_id: null,
    });
  });

  it("fails closed when a resolved taxid has no EFetch detail binding", () => {
    const resolution = parseGutMicrobiomeCarrier(request(esearchCarrier(["851"]), {
      adapterId: "gut_microbiome.ncbi_taxonomy_esearch_json.v1",
      accession: "Bacteroides vulgatus",
      mediaType: "application/json",
      logicalFile: "esearch.json",
    }));
    expect(() => composeGutMicrobiomeCrosswalk(resolution.taxonResolutions, [])).toThrow(
      /taxid 851 has no NCBI EFetch detail binding.*gut_microbiome\.ncbi_taxonomy_efetch_xml\.v1/,
    );
  });

  it("composes a detail-only crosswalk row with null query names", () => {
    const detail = parseGutMicrobiomeCarrier(request(efetchCarrier({ taxId: "2", scientificName: "Bacteria", rank: "domain" }), {
      adapterId: "gut_microbiome.ncbi_taxonomy_efetch_xml.v1",
      accession: "2",
      mediaType: "application/xml",
      logicalFile: "efetch.xml",
    }));
    const rows = composeGutMicrobiomeCrosswalk([], detail.taxonDetails);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ncbi_taxon_id: "2",
      current_name: "Bacteria",
      taxon_rank: "domain",
      parent_taxon_id: null,
      lineage: null,
      synonyms: "",
      equivalent_names: "",
      historical_names: "",
      name_change_observed: false,
      query_names: null,
    });
  });

  it("flags a name change from historical-name membership even when the query matches the current name casing", () => {
    const resolution = parseGutMicrobiomeCarrier(request(esearchCarrier(["216571"]), {
      adapterId: "gut_microbiome.ncbi_taxonomy_esearch_json.v1",
      accession: "Salmonella choleraesuis",
      mediaType: "application/json",
      logicalFile: "esearch.json",
    }));
    const detail = parseGutMicrobiomeCarrier(request(efetchCarrier({
      taxId: "216571",
      scientificName: "Salmonella enterica",
      otherNames:
        '<Name><ClassCDE>historical</ClassCDE><DispName>Salmonella choleraesuis</DispName></Name>' +
        '<Name><ClassCDE>authority</ClassCDE><DispName>Salmonella enterica (ex Kauffmann &amp; Edwards) Le Minor &amp; Popoff 1987</DispName></Name>',
    }), {
      adapterId: "gut_microbiome.ncbi_taxonomy_efetch_xml.v1",
      accession: "216571",
      mediaType: "application/xml",
      logicalFile: "efetch.xml",
    }));
    const rows = composeGutMicrobiomeCrosswalk(resolution.taxonResolutions, detail.taxonDetails);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      current_name: "Salmonella enterica",
      historical_names: "Salmonella choleraesuis",
      name_change_observed: true,
      query_names: "Salmonella choleraesuis",
    });
  });

  it("decodes XML entities and keeps only the three crosswalk name classes", () => {
    const detail = parseGutMicrobiomeCarrier(request(efetchCarrier({
      taxId: "571",
      scientificName: "Klebsiella &amp; friends",
      otherNames:
        "<EquivalentName>Acetobacter liquefaciens &amp; co</EquivalentName>" +
        "<GenbankSynonym>ML-001</GenbankSynonym>" +
        '<Name><ClassCDE>genbank common name</ClassCDE><DispName>Dropped Name</DispName></Name>',
      lineage: "Bacteria; Gammaproteobacteria",
    }), {
      adapterId: "gut_microbiome.ncbi_taxonomy_efetch_xml.v1",
      accession: "571",
      mediaType: "application/xml",
      logicalFile: "efetch.xml",
    }));
    expect(detail.taxonDetails).toHaveLength(1);
    expect(detail.taxonDetails[0]).toMatchObject({
      current_name: "Klebsiella & friends",
      synonyms: ["ML-001"],
      equivalent_names: ["Acetobacter liquefaciens & co"],
      historical_names: [],
      lineage: "Bacteria; Gammaproteobacteria",
    });
  });
});
