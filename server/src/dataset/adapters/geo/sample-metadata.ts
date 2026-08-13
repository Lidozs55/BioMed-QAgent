/**
 * Versioned GEO sample metadata extraction for V2 publications (P5-04;
 * Python ``app/datasets/build/geo_sample_metadata.py`` parity).
 *
 * The rules are deterministic and source-format agnostic: GEO SOFT and
 * series-matrix metadata both become ``GeoSampleMetadata`` and use the same
 * closed ``geo.sample-group.v1`` tumor/normal vocabulary. Pairing is never
 * inferred; only explicit subject/patient/donor identifiers are accepted.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";

import { csvLine, parseDelimitedLine } from "../text.js";

export const GROUP_RULE_ID = "geo.sample-group.v1";

export type GroupLabel = "tumor" | "normal" | "unknown";

const HIGH_CONFIDENCE_KEYS = [
  "sample type",
  "tissue type",
  "disease state",
  "condition",
  "tumor normal",
  "tumour normal",
] as const;

const GROUP_PHRASES: ReadonlyArray<readonly [string, GroupLabel]> = [
  ["primary tumor", "tumor"],
  ["adjacent normal", "normal"],
  ["normal adjacent", "normal"],
  ["non tumor", "normal"],
  ["non tumour", "normal"],
  ["control tissue", "normal"],
];

const TUMOR_WORDS: ReadonlySet<string> = new Set([
  "tumor",
  "tumour",
  "cancer",
  "carcinoma",
  "malignant",
  "metastatic",
]);

const NORMAL_WORDS: ReadonlySet<string> = new Set(["normal", "healthy"]);

const PAIRING_KEYS = [
  "pair id",
  "pairing id",
  "patient id",
  "subject id",
  "donor id",
  "individual id",
] as const;

export const SAMPLE_METADATA_COLUMNS = [
  "sample_id",
  "source_sample_alias",
  "title",
  "organism",
  "platform_id",
  "sample_group",
  "sample_group_raw",
  "pairing_id",
  "group_rule_id",
] as const;

export interface GeoSampleMetadata {
  sample_id: string;
  source_sample_alias: string | null;
  title: string;
  organism: string;
  platform_id: string | null;
  sample_group: GroupLabel;
  sample_group_raw: string;
  pairing_id: string | null;
  group_rule_id: string;
}

export interface SampleGroupResult {
  sample_group: GroupLabel;
  sample_group_raw: string;
  warnings: string[];
}

/** Python ``_normalize_token``. */
export function normalizeToken(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .split(/\s+/)
    .filter((part) => part !== "")
    .join(" ");
}

/** Python ``_matched_group_tokens``. */
export function matchedGroupTokens(value: string): Set<GroupLabel> {
  const remaining = normalizeToken(value).match(/[a-z0-9]+/g) ?? [];
  const matched = new Set<GroupLabel>();
  for (const [phrase, group] of GROUP_PHRASES) {
    const phraseWords = phrase.split(" ");
    for (let start = 0; start <= remaining.length - phraseWords.length; start += 1) {
      let equal = true;
      for (let offset = 0; offset < phraseWords.length; offset += 1) {
        if (remaining[start + offset] !== phraseWords[offset]) {
          equal = false;
          break;
        }
      }
      if (equal) {
        remaining.splice(start, phraseWords.length);
        matched.add(group);
        break;
      }
    }
  }
  for (const word of remaining) {
    if (TUMOR_WORDS.has(word)) matched.add("tumor");
    if (NORMAL_WORDS.has(word)) matched.add("normal");
  }
  return matched;
}

/** Python ``_classify_evidence``. */
export function classifyEvidence(
  evidence: ReadonlyArray<readonly [string, string]>,
  ruleId: string,
): SampleGroupResult {
  const classified = evidence
    .map(([key, value]) => [key, value, matchedGroupTokens(value)] as const)
    .filter((entry) => entry[2].size > 0);
  if (classified.length === 0) {
    return { sample_group: "unknown", sample_group_raw: "", warnings: [] };
  }
  const raw = `${classified[0][0].trim()}:${classified[0][1].trim()}`;
  const groups = new Set<GroupLabel>();
  for (const entry of classified) {
    for (const group of entry[2]) groups.add(group);
  }
  if (groups.size === 1 && groups.has("tumor")) {
    return { sample_group: "tumor", sample_group_raw: raw, warnings: [] };
  }
  if (groups.size === 1 && groups.has("normal")) {
    return { sample_group: "normal", sample_group_raw: raw, warnings: [] };
  }
  const details = classified
    .map(([key, value]) => `${key.trim()}:${value.trim()}`)
    .join(" vs ");
  return {
    sample_group: "unknown",
    sample_group_raw: raw,
    warnings: [
      `${ruleId}: conflicting tumor/normal evidence (${details}) -> sample_group=unknown`,
    ],
  };
}

/** Python ``extract_sample_group``. */
export function extractSampleGroup(
  characteristics: Record<string, string> | null | undefined,
  title: string | null | undefined,
  ruleId: string = GROUP_RULE_ID,
): SampleGroupResult {
  const characteristicsMap = characteristics ?? {};
  const evidence: Array<[string, string]> = [];
  for (const expectedKey of HIGH_CONFIDENCE_KEYS) {
    for (const [rawKey, rawValue] of Object.entries(characteristicsMap)) {
      if (normalizeToken(rawKey) === expectedKey) {
        evidence.push([rawKey, rawValue]);
      }
    }
  }
  if (evidence.length === 0) {
    if (
      Object.keys(characteristicsMap).some(
        (key) => normalizeToken(key) === "cell line",
      )
    ) {
      return { sample_group: "unknown", sample_group_raw: "", warnings: [] };
    }
    for (const [rawKey, rawValue] of Object.entries(characteristicsMap)) {
      if (normalizeToken(rawKey) === "source name") {
        evidence.push([rawKey, rawValue]);
      }
    }
    if (title) evidence.push(["title", title]);
  }
  return classifyEvidence(evidence, ruleId);
}

/** Python ``extract_pairing_id``. */
export function extractPairingId(
  characteristics: Record<string, string> | null | undefined,
): string | null {
  if (!characteristics) return null;
  for (const expectedKey of PAIRING_KEYS) {
    for (const [rawKey, rawValue] of Object.entries(characteristics)) {
      if (normalizeToken(rawKey) === expectedKey) {
        const normalized = normalizeToken(rawValue);
        return normalized || null;
      }
    }
  }
  return null;
}

/** Python ``validate_pairings``. */
export function validatePairings(samples: readonly GeoSampleMetadata[]): string[] {
  const groupsByPair = new Map<string, Set<string>>();
  for (const sample of samples) {
    if (sample.pairing_id) {
      const groups = groupsByPair.get(sample.pairing_id) ?? new Set<string>();
      groups.add(sample.sample_group);
      groupsByPair.set(sample.pairing_id, groups);
    }
  }
  const warnings: string[] = [];
  for (const [pairingId, groups] of [...groupsByPair.entries()].sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  )) {
    if (!groups.has("tumor") || !groups.has("normal")) {
      const sorted = [...groups].sort();
      warnings.push(
        `pairing ${pairingId} is one-sided (groups=[${sorted
          .map((group) => `'${group}'`)
          .join(", ")}]) - no valid tumor/normal pair`,
      );
    }
  }
  return warnings;
}

/** Python ``_samples_from_columns``. */
function samplesFromColumns(
  metadata: Record<string, string[]>,
  characteristics: ReadonlyArray<Record<string, string>>,
): { samples: GeoSampleMetadata[]; warnings: string[] } {
  const accessions = metadata.geo_accession ?? [];
  if (accessions.length === 0) return { samples: [], warnings: [] };
  const samples: GeoSampleMetadata[] = [];
  const warnings: string[] = [];
  const titles = metadata.title ?? [];
  const organisms = metadata.organism_ch1 ?? [];
  const platforms = metadata.platform_id ?? [];
  accessions.forEach((accession, index) => {
    const charMap = characteristics[index] ?? {};
    const title = titles[index] ?? "";
    const group = extractSampleGroup(charMap, title);
    warnings.push(...group.warnings.map((warning) => `${accession}: ${warning}`));
    samples.push({
      sample_id: accession,
      source_sample_alias: accession,
      title,
      organism: organisms[index] ?? "",
      platform_id:
        index < platforms.length && platforms[index] ? platforms[index] : null,
      sample_group: group.sample_group,
      sample_group_raw: group.sample_group_raw,
      pairing_id: extractPairingId(charMap),
      group_rule_id: GROUP_RULE_ID,
    });
  });
  warnings.push(...validatePairings(samples));
  return { samples, warnings };
}

/** Python ``parse_geo_series_matrix_samples`` (tab-delimited text input). */
export function parseGeoSeriesMatrixSamples(text: string): {
  samples: GeoSampleMetadata[];
  warnings: string[];
} {
  const metadata: Record<string, string[]> = {};
  const characteristics: Array<Record<string, string>> = [];
  const lines = text.split(/\r\n|\n|\r/);
  for (const lineText of lines) {
    const values = parseDelimitedLine(lineText, "\t");
    if (values.length === 0) continue;
    if (values[0].startsWith("!series_matrix_table_begin")) break;
    if (values[0].startsWith("!Sample_")) {
      const key = values[0].slice("!Sample_".length).trim();
      const rowValues = values.slice(1).map((value) => value.trim());
      if (key === "characteristics_ch1") {
        while (characteristics.length < rowValues.length) {
          characteristics.push({});
        }
        rowValues.forEach((value, index) => {
          if (value.includes(":")) {
            const [rawKey, rawValue] = value.split(":", 2);
            characteristics[index][rawKey.trim()] = rawValue.trim();
          }
        });
      } else {
        metadata[key] = rowValues;
      }
    }
  }
  return samplesFromColumns(metadata, characteristics);
}

interface SoftSampleState {
  sample_id: string;
  characteristics: Record<string, string>;
  source_sample_alias?: string;
  title?: string;
  organism?: string;
  platform_id?: string;
}

/** Python ``parse_geo_soft_samples`` (SOFT family text input). */
export function parseGeoSoftSamples(text: string): {
  samples: GeoSampleMetadata[];
  warnings: string[];
} {
  const samples: GeoSampleMetadata[] = [];
  const warnings: string[] = [];
  let current: SoftSampleState | null = null;

  const finish = (): void => {
    if (current === null) return;
    const title = current.title ?? "";
    const group = extractSampleGroup(current.characteristics, title);
    const sampleId = current.sample_id;
    warnings.push(...group.warnings.map((warning) => `${sampleId}: ${warning}`));
    samples.push({
      sample_id: sampleId,
      source_sample_alias: current.source_sample_alias ?? null,
      title,
      organism: current.organism ?? "",
      platform_id: current.platform_id ?? null,
      sample_group: group.sample_group,
      sample_group_raw: group.sample_group_raw,
      pairing_id: extractPairingId(current.characteristics),
      group_rule_id: GROUP_RULE_ID,
    });
  };

  for (const rawLine of text.split(/\r\n|\n|\r/)) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("^SAMPLE = ")) {
      finish();
      current = {
        sample_id: line.split("=", 2)[1].trim(),
        characteristics: {},
      };
    } else if (current === null) {
      continue;
    } else if (line.startsWith("!Sample_description = Sample ")) {
      current.source_sample_alias = line.split(" ").pop()?.trim() ?? "";
    } else if (line.startsWith("!Sample_title = ")) {
      current.title = line.split("=", 2)[1].trim();
    } else if (line.startsWith("!Sample_organism_ch1 = ")) {
      current.organism = line.split("=", 2)[1].trim();
    } else if (line.startsWith("!Sample_platform_id = ")) {
      current.platform_id = line.split("=", 2)[1].trim();
    } else if (line.startsWith("!Sample_characteristics_ch1 = ")) {
      const value = line.split("=", 2)[1].trim();
      if (value.includes(":")) {
        const [key, item] = value.split(":", 2);
        current.characteristics[key.trim()] = item.trim();
      }
    }
  }
  finish();
  warnings.push(...validatePairings(samples));
  return { samples, warnings };
}

/** Python ``write_sample_metadata``. */
export function writeSampleMetadata(
  filePath: string,
  samples: readonly GeoSampleMetadata[],
): string {
  writeFileSync(filePath, sampleMetadataCsv(samples), "utf8");
  return path.dirname(filePath);
}

/** Serialized CSV content (Python csv.DictWriter over SAMPLE_METADATA_COLUMNS). */
export function sampleMetadataCsv(
  samples: readonly GeoSampleMetadata[],
): string {
  const lines = [csvLine([...SAMPLE_METADATA_COLUMNS])];
  for (const sample of samples) {
    lines.push(
      csvLine([
        sample.sample_id,
        sample.source_sample_alias ?? "",
        sample.title,
        sample.organism,
        sample.platform_id ?? "",
        sample.sample_group,
        sample.sample_group_raw,
        sample.pairing_id ?? "",
        sample.group_rule_id,
      ]),
    );
  }
  return lines.join("");
}
