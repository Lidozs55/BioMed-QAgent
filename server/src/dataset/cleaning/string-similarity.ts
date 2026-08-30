import { createHash } from "node:crypto";

export const STRING_SIMILARITY_COMPARATOR_VERSION = "string_similarity.v1" as const;
export const STRING_SIMILARITY_THRESHOLD = 0.7;
export const STRING_SIMILARITY_TIE_EPSILON = 0.05;

export type MappingCandidateState = "accepted_candidate" | "ambiguous" | "no_match";

export interface MappingCandidate {
  source_field: string;
  target_field: string;
  score: number;
  rank: number;
}

export interface MappingCandidateSet {
  comparator_version: typeof STRING_SIMILARITY_COMPARATOR_VERSION;
  threshold: number;
  tie_epsilon: number;
  source_fields: string[];
  target_fields: string[];
  candidates: MappingCandidate[];
  states: Record<string, MappingCandidateState>;
  digest: string;
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[._:/\\-]+/gu, " ")
    .replace(/\s+/gu, " ");
}

function score(source: string, target: string): number {
  const left = normalize(source);
  const right = normalize(target);
  if (left === "" || right === "") return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }
  const leftTokens = new Set(left.split(" "));
  const rightTokens = new Set(right.split(" "));
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const prefix = commonPrefix(left, right) / Math.max(left.length, right.length);
  return Math.max(union === 0 ? 0 : overlap / union, prefix);
}

function commonPrefix(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}

function digest(value: Omit<MappingCandidateSet, "digest">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function rankMappingCandidates(
  sourceFields: readonly string[],
  targetFields: readonly string[],
): MappingCandidateSet {
  const sources = [...new Set(sourceFields)].sort((left, right) => left.localeCompare(right));
  const targets = [...new Set(targetFields)].sort((left, right) => left.localeCompare(right));
  const candidates: MappingCandidate[] = [];
  const states: Record<string, MappingCandidateState> = {};
  for (const sourceField of sources) {
    const ranked = targets
      .map((targetField) => ({ source_field: sourceField, target_field: targetField, score: score(sourceField, targetField) }))
      .filter((candidate) => candidate.score >= STRING_SIMILARITY_THRESHOLD)
      .sort((left, right) => right.score - left.score || left.target_field.localeCompare(right.target_field));
    ranked.forEach((candidate, index) => candidates.push({ ...candidate, rank: index + 1 }));
    if (ranked.length === 0) {
      states[sourceField] = "no_match";
      continue;
    }
    states[sourceField] = ranked.length > 1 && ranked[0].score - ranked[1].score <= STRING_SIMILARITY_TIE_EPSILON
      ? "ambiguous"
      : "accepted_candidate";
  }
  const unsigned = {
    comparator_version: STRING_SIMILARITY_COMPARATOR_VERSION,
    threshold: STRING_SIMILARITY_THRESHOLD,
    tie_epsilon: STRING_SIMILARITY_TIE_EPSILON,
    source_fields: sources,
    target_fields: targets,
    candidates,
    states,
  };
  return { ...unsigned, digest: digest(unsigned) };
}
