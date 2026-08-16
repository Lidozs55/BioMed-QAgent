import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseBatchConfidence,
  parseConfidenceRecord,
  type BatchConfidence,
  type ConfidenceRecord,
} from "../contracts/data.js";

export const CONFIDENCE_ARTIFACT_FILE = "confidence_records.json";

export interface ConfidenceArtifact {
  schema_version: "1.0";
  batch_defaults: BatchConfidence[];
  record_overrides: ConfidenceRecord[];
}

export function parseConfidenceArtifact(value: unknown): ConfidenceArtifact {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("ConfidenceArtifact must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "batch_defaults,record_overrides,schema_version") {
    throw new TypeError("ConfidenceArtifact has unexpected keys");
  }
  if (record.schema_version !== "1.0") {
    throw new TypeError("ConfidenceArtifact.schema_version must be 1.0");
  }
  if (!Array.isArray(record.batch_defaults) || !Array.isArray(record.record_overrides)) {
    throw new TypeError("ConfidenceArtifact confidence collections must be arrays");
  }
  return {
    schema_version: "1.0",
    batch_defaults: record.batch_defaults.map(parseBatchConfidence),
    record_overrides: record.record_overrides.map(parseConfidenceRecord),
  };
}

export async function writeConfidenceArtifact(
  outputDir: string,
  artifact: ConfidenceArtifact,
): Promise<string> {
  const normalized = parseConfidenceArtifact(artifact);
  normalized.batch_defaults.sort((left, right) => left.batch_id.localeCompare(right.batch_id));
  normalized.record_overrides.sort((left, right) => left.record_id.localeCompare(right.record_id));
  const target = path.join(outputDir, CONFIDENCE_ARTIFACT_FILE);
  await writeFile(target, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return target;
}

export async function readConfidenceArtifact(
  outputDir: string,
): Promise<ConfidenceArtifact | null> {
  try {
    return parseConfidenceArtifact(
      JSON.parse(await readFile(path.join(outputDir, CONFIDENCE_ARTIFACT_FILE), "utf8")) as unknown,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
