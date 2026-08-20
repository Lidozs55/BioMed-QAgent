const MAX_TEXT_LENGTH = 512;
const MAX_METADATA_DEPTH = 4;
const MAX_METADATA_KEYS = 64;
const MAX_METADATA_ITEMS = 128;

const TABLE_ROLES = ["primary", "supporting", "derived"] as const;
const CARDINALITIES = ["one_to_one", "one_to_many", "many_to_one", "many_to_many"] as const;
const MISSING_POLICIES = ["reject", "profile_defined", "allow_empty"] as const;

type TableRole = (typeof TABLE_ROLES)[number];
type RelationCardinality = (typeof CARDINALITIES)[number];
type MissingPolicy = (typeof MISSING_POLICIES)[number];

type BoundedMetadata =
  | string
  | number
  | boolean
  | null
  | BoundedMetadata[]
  | { [key: string]: BoundedMetadata };

export interface ReferenceTableRequirement {
  table_id: string;
  role: TableRole;
  granularity: string;
  primary_key: readonly string[];
  columns: readonly string[];
  allow_empty: boolean | string;
}

export interface ReferenceRelationRequirement {
  from: string;
  to: string;
  cardinality: RelationCardinality;
  missing: MissingPolicy;
}

export interface ReferenceUncheckableRequirement {
  requirement_id: string;
  reason: string;
  metadata: BoundedMetadata;
}

export interface ReferenceRequirements {
  schema_id: string;
  version: string;
  family: string;
  tables: readonly ReferenceTableRequirement[];
  relations: readonly ReferenceRelationRequirement[];
  required_provenance: readonly string[];
  optional_contracts: Readonly<Record<string, BoundedMetadata>>;
  uncheckable: readonly ReferenceUncheckableRequirement[];
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new TypeError(`${path} has unknown fields: ${extras.join(", ")}`);
}

function text(value: unknown, path: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${path} must be a non-empty bounded string`);
  }
  return value;
}

function stringList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_METADATA_ITEMS) {
    throw new TypeError(`${path} must be a bounded string array`);
  }
  const result = value.map((entry, index) => text(entry, `${path}[${index}]`));
  if (new Set(result).size !== result.length) throw new TypeError(`${path} must not contain duplicates`);
  return result;
}

function literal<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  const candidate = text(value, path);
  if (!allowed.includes(candidate as T)) {
    throw new TypeError(`${path} must be one of ${allowed.join(", ")}`);
  }
  return candidate as T;
}

function boundedMetadata(value: unknown, path: string, depth = 0): BoundedMetadata {
  if (depth > MAX_METADATA_DEPTH) throw new TypeError(`${path} exceeds metadata depth limit`);
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && value.length > MAX_TEXT_LENGTH) throw new TypeError(`${path} contains oversized text`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain finite numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_METADATA_ITEMS) throw new TypeError(`${path} exceeds metadata item limit`);
    return value.map((entry, index) => boundedMetadata(entry, `${path}[${index}]`, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > MAX_METADATA_KEYS) throw new TypeError(`${path} exceeds metadata key limit`);
    const result: Record<string, BoundedMetadata> = {};
    for (const [key, entry] of entries) {
      text(key, `${path}.${key}`, 128);
      result[key] = boundedMetadata(entry, `${path}.${key}`, depth + 1);
    }
    return result;
  }
  throw new TypeError(`${path} contains an unsupported value`);
}

function parseTable(value: unknown, path: string): ReferenceTableRequirement {
  const table = object(value, path);
  exactKeys(table, ["table_id", "role", "granularity", "primary_key", "columns", "allow_empty"], path);
  const primaryKey = stringList(table.primary_key, `${path}.primary_key`);
  if (primaryKey.length === 0) throw new TypeError(`${path}.primary_key must not be empty`);
  const columns = stringList(table.columns, `${path}.columns`);
  if (columns.length === 0) throw new TypeError(`${path}.columns must not be empty`);
  if (primaryKey.some((key) => !columns.includes(key))) {
    throw new TypeError(`${path}.primary_key must reference declared columns`);
  }
  return {
    table_id: text(table.table_id, `${path}.table_id`),
    role: literal(table.role, `${path}.role`, TABLE_ROLES),
    granularity: text(table.granularity, `${path}.granularity`),
    primary_key: primaryKey.sort(),
    columns: columns.sort(),
    allow_empty: table.allow_empty === undefined
      ? false
      : typeof table.allow_empty === "boolean" || typeof table.allow_empty === "string"
        ? typeof table.allow_empty === "string"
          ? text(table.allow_empty, `${path}.allow_empty`, 2_048)
          : table.allow_empty
        : (() => { throw new TypeError(`${path}.allow_empty must be a boolean or bounded condition`); })(),
  };
}

function parseRelation(value: unknown, path: string): ReferenceRelationRequirement {
  const relation = object(value, path);
  exactKeys(relation, ["from", "to", "cardinality", "missing"], path);
  return {
    from: text(relation.from, `${path}.from`),
    to: text(relation.to, `${path}.to`),
    cardinality: literal(relation.cardinality, `${path}.cardinality`, CARDINALITIES),
    missing: relation.missing === undefined ? "profile_defined" : literal(relation.missing, `${path}.missing`, MISSING_POLICIES),
  };
}

export function parseReferenceRequirements(value: unknown): ReferenceRequirements {
  const reference = object(value, "reference requirements");
  exactKeys(reference, [
    "schema_id",
    "version",
    "family",
    "tables",
    "relations",
    "required_provenance",
    "confidence_policy",
    "derived_contract",
    "measurement_contract",
    "chart_contract",
  ], "reference requirements");
  if (!Array.isArray(reference.tables) || reference.tables.length === 0 || reference.tables.length > MAX_METADATA_ITEMS) {
    throw new TypeError("reference requirements.tables must be a bounded non-empty array");
  }
  if (!Array.isArray(reference.relations) || reference.relations.length > MAX_METADATA_ITEMS) {
    throw new TypeError("reference requirements.relations must be a bounded array");
  }
  const tables = reference.tables.map((entry, index) => parseTable(entry, `reference requirements.tables[${index}]`)).sort((a, b) => a.table_id.localeCompare(b.table_id));
  if (new Set(tables.map((table) => table.table_id)).size !== tables.length) throw new TypeError("reference requirements.tables must not contain duplicate table_id");
  const relations = reference.relations.map((entry, index) => parseRelation(entry, `reference requirements.relations[${index}]`)).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.cardinality.localeCompare(b.cardinality));
  const relationKeys = relations.map((relation) => `${relation.from}\u0000${relation.to}\u0000${relation.cardinality}`);
  if (new Set(relationKeys).size !== relationKeys.length) throw new TypeError("reference requirements.relations must not contain duplicates");
  const optionalContracts: Record<string, BoundedMetadata> = {};
  const uncheckable: ReferenceUncheckableRequirement[] = [];
  for (const table of tables) {
    if (typeof table.allow_empty === "string") {
      uncheckable.push({
        requirement_id: `${table.table_id}.allow_empty`,
        reason: "Conditional empty-table policy requires a concrete product assessment",
        metadata: table.allow_empty,
      });
    }
  }
  for (const key of ["derived_contract", "measurement_contract", "chart_contract"] as const) {
    if (reference[key] !== undefined) {
      optionalContracts[key] = boundedMetadata(reference[key], `reference requirements.${key}`);
      uncheckable.push({
        requirement_id: key,
        reason: "Reference metadata requires a concrete artifact or operation result to evaluate",
        metadata: optionalContracts[key],
      });
    }
  }
  if (reference.confidence_policy !== undefined) {
    const policy = text(reference.confidence_policy, "reference requirements.confidence_policy", 2_048);
    uncheckable.push({
      requirement_id: "confidence_policy",
      reason: "Natural-language confidence policy is not machine-checkable without a concrete product assessment",
      metadata: policy,
    });
  }
  const sortedOptionalContracts = Object.fromEntries(
    Object.entries(optionalContracts).sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    schema_id: text(reference.schema_id, "reference requirements.schema_id"),
    version: text(reference.version, "reference requirements.version", 32),
    family: text(reference.family, "reference requirements.family"),
    tables,
    relations,
    required_provenance: stringList(reference.required_provenance, "reference requirements.required_provenance").sort(),
    optional_contracts: sortedOptionalContracts,
    uncheckable: uncheckable.sort((left, right) => left.requirement_id.localeCompare(right.requirement_id)),
  };
}
