/**
 * Evidence-backed, bidirectional GEO source relation generation (P5-04;
 * Python ``app/datasets/build/geo_relations.py`` parity).
 */

import { writeFileSync } from "node:fs";

import { csvLine } from "../text.js";
import type { SourceRecord, SourceRelation } from "../../contracts/source.js";
import type { GeoSeriesRecord } from "../../../external/geo/parsers.js";

export const SOURCE_RELATION_COLUMNS = [
  "relation_id",
  "from_source_id",
  "to_source_id",
  "relation_type",
  "evidence_type",
  "evidence_value",
  "evidence_url",
] as const;

export interface BuildGeoSourceRelationsOptions {
  geoSourceId: string;
  geo: GeoSeriesRecord;
  sources: readonly SourceRecord[];
}

/** Python ``build_geo_source_relations``. */
export function buildGeoSourceRelations(
  options: BuildGeoSourceRelationsOptions,
): SourceRelation[] {
  const { geoSourceId, geo, sources } = options;
  const acquiredPubmed = new Map<string, string>();
  for (const source of sources) {
    if (source.database === "pubmed") {
      acquiredPubmed.set(source.accession, source.source_id);
    }
  }
  const evidenceUrl =
    "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=" + geo.accession;
  const rows: SourceRelation[] = [];
  for (const pmid of [...new Set(geo.pubmed_ids)]) {
    const pubmedSourceId = acquiredPubmed.get(pmid);
    let forwardType: string;
    let inverseType: string;
    if (pubmedSourceId === undefined) {
      const externalId = `ext:pubmed:${pmid}`;
      forwardType = "geo_references_pubmed";
      inverseType = "pubmed_referenced_by_geo";
      rows.push(
        relationRow({
          relationId: `rel_${geo.accession.toLowerCase()}_pmid${pmid}`,
          fromSourceId: geoSourceId,
          toSourceId: externalId,
          relationType: forwardType,
          evidenceValue: pmid,
          evidenceUrl,
        }),
        relationRow({
          relationId: `rel_pmid${pmid}_${geo.accession.toLowerCase()}`,
          fromSourceId: externalId,
          toSourceId: geoSourceId,
          relationType: inverseType,
          evidenceValue: pmid,
          evidenceUrl,
        }),
      );
      continue;
    }
    forwardType = "dataset_described_by_article";
    inverseType = "article_describes_dataset";
    rows.push(
      relationRow({
        relationId: `rel_${geo.accession.toLowerCase()}_pmid${pmid}`,
        fromSourceId: geoSourceId,
        toSourceId: pubmedSourceId,
        relationType: forwardType,
        evidenceValue: pmid,
        evidenceUrl,
      }),
      relationRow({
        relationId: `rel_pmid${pmid}_${geo.accession.toLowerCase()}`,
        fromSourceId: pubmedSourceId,
        toSourceId: geoSourceId,
        relationType: inverseType,
        evidenceValue: pmid,
        evidenceUrl,
      }),
    );
  }
  return rows.sort(compareRelations);
}

function relationRow(options: {
  relationId: string;
  fromSourceId: string;
  toSourceId: string;
  relationType: string;
  evidenceValue: string;
  evidenceUrl: string;
}): SourceRelation {
  return {
    schema_version: "1.0",
    relation_id: options.relationId,
    from_source_id: options.fromSourceId,
    to_source_id: options.toSourceId,
    relation_type: options.relationType,
    evidence_type: "geo_pubmed_id",
    evidence_value: options.evidenceValue,
    evidence_url: options.evidenceUrl,
  };
}

/** Python sort key over the relation rows. */
function compareRelations(left: SourceRelation, right: SourceRelation): number {
  for (const key of [
    "from_source_id",
    "to_source_id",
    "relation_type",
    "evidence_type",
    "evidence_value",
  ] as const) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
}

/** Python ``write_source_relations``. */
export function writeSourceRelations(
  filePath: string,
  relations: readonly SourceRelation[],
): string {
  const lines = [csvLine([...SOURCE_RELATION_COLUMNS])];
  for (const relation of relations) {
    lines.push(
      csvLine([
        relation.relation_id,
        relation.from_source_id,
        relation.to_source_id,
        relation.relation_type,
        relation.evidence_type,
        relation.evidence_value,
        relation.evidence_url,
      ]),
    );
  }
  writeFileSync(filePath, lines.join(""), "utf8");
  return filePath;
}
