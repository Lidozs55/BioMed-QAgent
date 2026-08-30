import { describe, expect, it } from "vitest";

import { transformBioCLiteratureEvidence } from "../src/dataset/families/literature-evidence/provider.js";

const ASSET_ID = `asset_${"a".repeat(64)}`;

function input(xml: string) {
  return {
    bytes: Buffer.from(xml),
    assetId: ASSET_ID,
    logicalFile: "source_assets/PMC123.xml",
    retrievedAt: "2026-08-28T00:00:00.000Z",
    sourceDatabase: "europe_pmc",
  };
}

describe("Europe PMC fullTextXML literature provider", () => {
  it("parses a JATS article with a canonical quantitative evidence table", () => {
    const result = transformBioCLiteratureEvidence(input(`
      <article>
        <front><journal-meta><journal-title>Journal</journal-title></journal-meta>
          <article-meta>
            <article-id pub-id-type="pmcid">123</article-id>
            <title-group><article-title>Formal evidence article</article-title></title-group>
          </article-meta>
        </front>
        <body><table-wrap id="T1"><table>
          <tr><th>experiment_id</th><th>evidence_type</th><th>claim_text</th><th>result_summary</th><th>value_precision</th><th>confidence</th><th>review_status</th><th>activity_value</th><th>activity_unit</th></tr>
          <tr><td>EXP1</td><td>intervention_result</td><td>Measured response</td><td>IC50 was 12 nM</td><td>exact</td><td>high</td><td>not_required</td><td>12</td><td>nM</td></tr>
          <tr><td>EXP2</td><td>intervention_result</td><td>Measured second response</td><td>IC50 was 24 nM</td><td>exact</td><td>high</td><td>not_required</td><td>24</td><td>nM</td></tr>
        </table></table-wrap></body>
      </article>
    `));

    expect(result.papers[0]).toMatchObject({
      paper_id: "PMC123",
      paper_id_namespace: "pmc",
      title: "Formal evidence article",
    });
    expect(result.literature_evidence[0]).toMatchObject({
      experiment_id: "EXP1",
      evidence_type: "intervention_result",
      study_context: { activity_value: "12", activity_unit: "nM" },
    });
    expect(result.sources).toHaveLength(2);
    expect(result.sources.map((source) => source.source_locator)).toEqual([
      expect.objectContaining({ row_index: 1, raw_value: expect.stringContaining("EXP1") }),
      expect.objectContaining({ row_index: 2, raw_value: expect.stringContaining("EXP2") }),
    ]);
    expect(result.literature_evidence.map((row) => row.source_id)).toEqual(
      result.sources.map((source) => source.source_id),
    );
    expect(result.sources[0]?.source_locator).toMatchObject({
      locator_type: "xml_cell",
      asset_id: ASSET_ID,
      table_id: "T1",
    });
  });

  it("preserves a distinct locator for every BioC evidence row", () => {
    const result = transformBioCLiteratureEvidence(input(`
      <collection><source>bioc</source><document>
        <id>doc-1</id><infon key="pmid">12345</infon><infon key="title">BioC evidence</infon>
        <passage><infon key="table_id">T1</infon><table id="T1">
          <row><cell>experiment_id</cell><cell>evidence_type</cell><cell>claim_text</cell><cell>result_summary</cell><cell>value_precision</cell><cell>confidence</cell><cell>review_status</cell></row>
          <row><cell>E1</cell><cell>result</cell><cell>first</cell><cell>one</cell><cell>exact</cell><cell>high</cell><cell>not_required</cell></row>
          <row><cell>E2</cell><cell>result</cell><cell>second</cell><cell>two</cell><cell>exact</cell><cell>high</cell><cell>not_required</cell></row>
        </table></passage>
      </document></collection>
    `));

    expect(result.sources).toHaveLength(2);
    expect(result.sources.map((source) => source.source_locator)).toEqual([
      expect.objectContaining({ row_index: 1, raw_value: expect.stringContaining("E1") }),
      expect.objectContaining({ row_index: 2, raw_value: expect.stringContaining("E2") }),
    ]);
    expect(result.literature_evidence.map((row) => row.source_id)).toEqual(
      result.sources.map((source) => source.source_id),
    );
  });

  it("reports JATS semantic emptiness instead of a false BioC document error", () => {
    expect(() => transformBioCLiteratureEvidence(input(`
      <article><front><article-meta>
        <article-id pub-id-type="pmcid">123</article-id>
        <title-group><article-title>No matching table</article-title></title-group>
      </article-meta></front><body><p>Text only.</p></body></article>
    `))).toThrow(/fullTextXML article contains no canonical evidence table rows/);
  });
});
