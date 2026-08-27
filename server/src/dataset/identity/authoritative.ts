import { types } from "node:util";

import {
  createDatasetId,
  createDatasetRevisionId,
  validateAssetId,
} from "./index.js";

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const INPUT_KEYS = new Set([
  "sourceNamespace",
  "canonicalAccessions",
  "taskId",
  "requirementId",
  "generation",
  "schemaRef",
  "facts",
]);
const FACT_KEYS = new Set([
  "bindingId",
  "source",
  "role",
  "assetId",
  "sha256",
  "sizeBytes",
  "taskId",
  "requirementId",
  "generation",
  "providerSnapshot",
  "revisionToken",
  "accession",
]);

export type ExpressionV2SchemaRef =
  | "gene_expression.long.v2"
  | "gene_expression.probe_long.v2";
export type RegistrationRole = "source" | "mapping" | "metadata" | "carrier";

export interface SourceAssetRegistrationFact {
  readonly bindingId: string;
  readonly source: string;
  readonly role: RegistrationRole;
  readonly assetId: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly taskId: string;
  readonly requirementId: string;
  readonly generation: number;
  readonly providerSnapshot: string;
  readonly revisionToken: string | null;
  readonly accession: string;
}

export interface AuthoritativeDatasetIdentityInput {
  readonly sourceNamespace: string;
  readonly canonicalAccessions: readonly string[];
  readonly taskId: string;
  readonly requirementId: string;
  readonly generation: number;
  readonly schemaRef: ExpressionV2SchemaRef;
  readonly facts: readonly SourceAssetRegistrationFact[];
}

export interface AuthoritativeDatasetIdentityContext {
  readonly contextKind: "authoritative_dataset_identity.v1";
  readonly datasetId: string;
  readonly datasetRevisionId: string;
  /** All exact source/carrier/mapping/metadata receipts in the build closure. */
  readonly closureAssetIds: readonly string[];
  /** Source/carrier subset used by adapter publication identity records. */
  readonly carrierAssetIds: readonly string[];
  readonly providerSnapshot: string;
  readonly revisionToken: string | null;
  readonly schemaRef: ExpressionV2SchemaRef;
  readonly primaryKey: readonly string[];
  readonly sampleIdentityFields: readonly ["dataset_revision_id", "sample_id"];
  readonly probeMappingAssertionPrimaryKey: "mapping_assertion_id";
}

type DataRecord = Record<string, unknown>;

function snapshot(value: unknown, keys: ReadonlySet<string>, label: string): DataRecord {
  if (
    typeof value !== "object" || value === null || Array.isArray(value)
    || types.isProxy(value) || !Object.isFrozen(value)
  ) throw new TypeError(`${label} must be a frozen plain non-Proxy object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must have a plain object prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.size || ownKeys.some((key) => typeof key !== "string" || !keys.has(key))) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
  const result: DataRecord = Object.create(null) as DataRecord;
  for (const key of ownKeys) {
    const descriptor = descriptors[key as string];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label}.${String(key)} must be an enumerable data property`);
    }
    result[key as string] = descriptor.value;
  }
  return result;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.normalize("NFC") !== value) {
    throw new TypeError(`${label} must be a non-empty NFC string`);
  }
  if ([...value].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  })) throw new TypeError(`${label} must not contain control characters`);
  return value;
}

function safeId(value: unknown, label: string): string {
  const parsed = stringValue(value, label);
  if (!SAFE_ID.test(parsed)) throw new TypeError(`${label} must be a safe identifier`);
  return parsed;
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function parseFact(value: unknown, index: number): SourceAssetRegistrationFact {
  const label = `facts[${index}]`;
  const record = snapshot(value, FACT_KEYS, label);
  const role = record.role;
  if (role !== "source" && role !== "mapping" && role !== "metadata" && role !== "carrier") {
    throw new TypeError(`${label}.role is not registered`);
  }
  const assetId = validateAssetId(stringValue(record.assetId, `${label}.assetId`));
  const sha256 = stringValue(record.sha256, `${label}.sha256`);
  if (!SHA256.test(sha256) || assetId !== `asset_${sha256}`) {
    throw new TypeError(`${label} asset identity does not match its byte digest`);
  }
  return Object.freeze({
    bindingId: safeId(record.bindingId, `${label}.bindingId`),
    source: safeId(record.source, `${label}.source`),
    role,
    assetId,
    sha256,
    sizeBytes: safeInteger(record.sizeBytes, `${label}.sizeBytes`),
    taskId: safeId(record.taskId, `${label}.taskId`),
    requirementId: safeId(record.requirementId, `${label}.requirementId`),
    generation: safeInteger(record.generation, `${label}.generation`),
    providerSnapshot: stringValue(record.providerSnapshot, `${label}.providerSnapshot`),
    revisionToken: record.revisionToken === null
      ? null
      : stringValue(record.revisionToken, `${label}.revisionToken`),
    accession: stringValue(record.accession, `${label}.accession`),
  });
}

export function createAuthoritativeDatasetIdentityContext(
  input: AuthoritativeDatasetIdentityInput,
): AuthoritativeDatasetIdentityContext {
  const record = snapshot(input, INPUT_KEYS, "identity context input");
  const taskId = safeId(record.taskId, "taskId");
  const requirementId = safeId(record.requirementId, "requirementId");
  const generation = safeInteger(record.generation, "generation");
  const schemaRef = record.schemaRef;
  if (schemaRef !== "gene_expression.long.v2" && schemaRef !== "gene_expression.probe_long.v2") {
    throw new TypeError("schemaRef must be a registered expression V2 schema");
  }
  if (!Array.isArray(record.canonicalAccessions) || !Object.isFrozen(record.canonicalAccessions)) {
    throw new TypeError("canonicalAccessions must be a frozen array");
  }
  if (!Array.isArray(record.facts) || !Object.isFrozen(record.facts) || record.facts.length === 0) {
    throw new TypeError("facts must be a non-empty frozen array");
  }
  const accessions = record.canonicalAccessions.map((value, index) =>
    stringValue(value, `canonicalAccessions[${index}]`));
  const facts = record.facts.map(parseFact);
  const providerSnapshots = new Set(facts.map((fact) => fact.providerSnapshot));
  const revisionTokens = new Set(facts.map((fact) => fact.revisionToken));
  const factAccessions = new Set(facts.map((fact) => fact.accession));
  if (providerSnapshots.size !== 1 || revisionTokens.size !== 1) {
    throw new TypeError("carrier receipts do not share one provider revision snapshot");
  }
  if (facts.some((fact) =>
    fact.taskId !== taskId || fact.requirementId !== requirementId || fact.generation !== generation)) {
    throw new TypeError("carrier receipt ownership does not match task/build/generation");
  }
  if (accessions.some((accession) => !factAccessions.has(accession))) {
    throw new TypeError("canonical accession closure is not supported by carrier receipts");
  }
  const closureAssetIds = [...new Set(facts.map((fact) => fact.assetId))].sort();
  if (closureAssetIds.length !== facts.length) {
    throw new TypeError("identity closure asset IDs must be unique");
  }
  const carrierAssetIds = facts
    .filter((fact) => fact.role === "source" || fact.role === "carrier")
    .map((fact) => fact.assetId)
    .sort();
  if (carrierAssetIds.length === 0) {
    throw new TypeError("identity closure must contain a source or carrier receipt");
  }
  const datasetId = createDatasetId({
    sourceNamespace: stringValue(record.sourceNamespace, "sourceNamespace"),
    canonicalAccessions: accessions,
  });
  const providerSnapshot = [...providerSnapshots][0]!;
  const revisionToken = [...revisionTokens][0]!;
  const datasetRevisionId = createDatasetRevisionId({
    datasetId,
    revisionToken,
    providerSnapshot,
    // The revision hash covers the complete exact receipt closure. The
    // historical field name is retained for the stable identity primitive.
    carrierAssetIds: closureAssetIds,
  });
  const primaryKey = schemaRef === "gene_expression.long.v2"
    ? ["dataset_revision_id", "sample_id", "gene_id", "measurement_type"]
    : ["dataset_revision_id", "probe_id", "platform_id", "sample_id"];
  return Object.freeze({
    contextKind: "authoritative_dataset_identity.v1",
    datasetId,
    datasetRevisionId,
    closureAssetIds: Object.freeze(closureAssetIds),
    carrierAssetIds: Object.freeze(carrierAssetIds),
    providerSnapshot,
    revisionToken,
    schemaRef,
    primaryKey: Object.freeze(primaryKey),
    sampleIdentityFields: Object.freeze(["dataset_revision_id", "sample_id"] as const),
    probeMappingAssertionPrimaryKey: "mapping_assertion_id",
  });
}
