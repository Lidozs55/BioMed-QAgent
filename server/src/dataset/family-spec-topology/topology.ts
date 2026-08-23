import {
  parseFamilySpec,
  type DeclaredTableRef,
  type Projection,
  type RelationDefinition,
  type TableDefinition,
  type TableRole,
} from "@biomed/contracts";

export type FamilySpecTopologyIssueCode =
  | "ALLOW_EMPTY_OUTSIDE_TOPOLOGY"
  | "DECLARED_OUTPUT_SCHEMA_MISMATCH"
  | "DECLARED_OUTPUT_TABLE_UNDEFINED"
  | "DUPLICATE_DECLARED_OUTPUT_TABLE_ID"
  | "DUPLICATE_PROJECTION_ID"
  | "DUPLICATE_PROJECTION_MEMBER"
  | "DUPLICATE_PROJECTION_RELATION"
  | "DUPLICATE_RELATION_ID"
  | "DUPLICATE_TABLE_ID"
  | "PRIMARY_KEY_EMPTY"
  | "PRIMARY_KEY_FIELD_UNDEFINED"
  | "PROJECTION_RELATION_ENDPOINT_OUTSIDE_TOPOLOGY"
  | "PROJECTION_RELATION_UNDEFINED"
  | "PROJECTION_REQUIREMENT_COVERAGE_MISMATCH"
  | "PROJECTION_REQUIREMENT_OVERLAP"
  | "PROJECTION_ROLE_OVERLAP"
  | "PROJECTION_TABLE_UNDEFINED"
  | "RELATION_ENDPOINT_FIELD_UNDEFINED"
  | "RELATION_ENDPOINT_TABLE_UNDEFINED"
  | "RELATION_FIELD_ARITY_MISMATCH"
  | "RELATION_FIELD_TUPLE_EMPTY"
  | "TABLE_OUTPUT_UNDECLARED"
  | "TABLE_ROLE_MISMATCH"
  | "UNUSED_RELATION"
  | "UNUSED_TABLE";

export interface FamilySpecTopologyIssue {
  code: FamilySpecTopologyIssueCode;
  path: string;
  message: string;
  object_id?: string;
}

export interface NormalizedProjectionTopology {
  projection_id: string;
  schema_version: "2.0";
  primary_tables: string[];
  supporting_tables: string[];
  derived_tables: string[];
  required: string[];
  optional: string[];
  allow_empty: string[];
  relations: string[];
}

export interface NormalizedTableTopology {
  table_id: string;
  schema_ref: string;
  role: TableRole;
  required: boolean;
  allow_empty: boolean;
  primary_key: string[];
  field_names: string[];
}

export interface NormalizedRelationTopology {
  relation_id: string;
  from_table_id: string;
  from_fields: string[];
  to_table_id: string;
  to_fields: string[];
  cardinality: RelationDefinition["cardinality"];
  missing_policy: RelationDefinition["missing_policy"];
}

export interface NormalizedDeclaredOutputTopology {
  table_id: string;
  schema_ref: string;
}

export interface NormalizedFamilySpecTopology {
  projections: NormalizedProjectionTopology[];
  table_definitions: NormalizedTableTopology[];
  relations: NormalizedRelationTopology[];
  declared_outputs: NormalizedDeclaredOutputTopology[];
}

export interface FamilySpecTopologyReport {
  proposal_only: true;
  topology_valid: boolean;
  issues: FamilySpecTopologyIssue[];
  normalized_topology: NormalizedFamilySpecTopology;
}

const PROJECTION_ROLE_MEMBERSHIPS = [
  ["primary_tables", "primary"],
  ["supporting_tables", "supporting"],
  ["derived_tables", "derived"],
] as const satisfies ReadonlyArray<readonly [
  "primary_tables" | "supporting_tables" | "derived_tables",
  TableRole,
]>;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareByIdThenValue<T>(
  left: T,
  right: T,
  idOf: (value: T) => string,
): number {
  const idOrder = compareStrings(idOf(left), idOf(right));
  if (idOrder !== 0) return idOrder;
  return compareStrings(JSON.stringify(left), JSON.stringify(right));
}

function sortedCopies<T>(values: readonly T[], idOf: (value: T) => string): T[] {
  return [...values].sort((left, right) => compareByIdThenValue(left, right, idOf));
}

function projectionPath(projectionId: string): string {
  return `$.projections[${JSON.stringify(projectionId)}]`;
}

function tablePath(tableId: string): string {
  return `$.table_definitions[${JSON.stringify(tableId)}]`;
}

function relationPath(relationId: string): string {
  return `$.relations[${JSON.stringify(relationId)}]`;
}

function addIssue(
  issues: FamilySpecTopologyIssue[],
  code: FamilySpecTopologyIssueCode,
  path: string,
  message: string,
  objectId?: string,
): void {
  issues.push(
    objectId === undefined
      ? { code, path, message }
      : { code, path, message, object_id: objectId },
  );
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort(compareStrings);
}

function checkUniqueObjectIds<T>(
  values: readonly T[],
  idOf: (value: T) => string,
  code: FamilySpecTopologyIssueCode,
  path: string,
  label: string,
  issues: FamilySpecTopologyIssue[],
): void {
  for (const id of duplicateValues(values.map(idOf))) {
    addIssue(issues, code, path, `Duplicate ${label} ${id}`, id);
  }
}

function intersect(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((value) => right.has(value)).sort(compareStrings);
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort(compareStrings);
}

function firstById<T>(values: readonly T[], idOf: (value: T) => string): Map<string, T> {
  const indexed = new Map<string, T>();
  for (const value of sortedCopies(values, idOf)) {
    const id = idOf(value);
    if (!indexed.has(id)) indexed.set(id, value);
  }
  return indexed;
}

function checkTables(
  tables: readonly TableDefinition[],
  outputs: readonly DeclaredTableRef[],
  issues: FamilySpecTopologyIssue[],
): ReadonlyMap<string, TableDefinition> {
  checkUniqueObjectIds(
    tables,
    (table) => table.table_id,
    "DUPLICATE_TABLE_ID",
    "$.table_definitions",
    "table id",
    issues,
  );
  checkUniqueObjectIds(
    outputs,
    (output) => output.table_id,
    "DUPLICATE_DECLARED_OUTPUT_TABLE_ID",
    "$.declared_outputs",
    "declared output table id",
    issues,
  );

  const tableById = firstById(tables, (table) => table.table_id);
  const outputTableIds = new Set(outputs.map((output) => output.table_id));

  for (const table of tables) {
    const path = tablePath(table.table_id);
    if (table.primary_key.length === 0) {
      addIssue(
        issues,
        "PRIMARY_KEY_EMPTY",
        `${path}.primary_key`,
        "Primary key must contain at least one field",
        table.table_id,
      );
    }
    table.primary_key.forEach((field, index) => {
      if (!table.field_names.includes(field)) {
        addIssue(
          issues,
          "PRIMARY_KEY_FIELD_UNDEFINED",
          `${path}.primary_key[${index}]`,
          `Primary key field ${field} is absent from field_names`,
          table.table_id,
        );
      }
    });
    if (!outputTableIds.has(table.table_id)) {
      addIssue(
        issues,
        "TABLE_OUTPUT_UNDECLARED",
        "$.declared_outputs",
        `Table ${table.table_id} has no declared output`,
        table.table_id,
      );
    }
  }

  for (const output of outputs) {
    const table = tableById.get(output.table_id);
    if (table === undefined) {
      addIssue(
        issues,
        "DECLARED_OUTPUT_TABLE_UNDEFINED",
        "$.declared_outputs",
        `Declared output ${output.table_id} has no table definition`,
        output.table_id,
      );
    } else if (table.schema_ref !== output.schema_ref) {
      addIssue(
        issues,
        "DECLARED_OUTPUT_SCHEMA_MISMATCH",
        "$.declared_outputs",
        `Declared output schema ${output.schema_ref} differs from table schema ${table.schema_ref}`,
        output.table_id,
      );
    }
  }

  return tableById;
}

function checkRelations(
  relations: readonly RelationDefinition[],
  tableById: ReadonlyMap<string, TableDefinition>,
  issues: FamilySpecTopologyIssue[],
): ReadonlyMap<string, RelationDefinition> {
  checkUniqueObjectIds(
    relations,
    (relation) => relation.relation_id,
    "DUPLICATE_RELATION_ID",
    "$.relations",
    "relation id",
    issues,
  );

  for (const relation of relations) {
    const path = relationPath(relation.relation_id);
    const fromTable = tableById.get(relation.from_table_id);
    const toTable = tableById.get(relation.to_table_id);

    if (fromTable === undefined) {
      addIssue(
        issues,
        "RELATION_ENDPOINT_TABLE_UNDEFINED",
        `${path}.from_table_id`,
        `Relation source table ${relation.from_table_id} is undefined`,
        relation.relation_id,
      );
    }
    if (toTable === undefined) {
      addIssue(
        issues,
        "RELATION_ENDPOINT_TABLE_UNDEFINED",
        `${path}.to_table_id`,
        `Relation target table ${relation.to_table_id} is undefined`,
        relation.relation_id,
      );
    }
    if (relation.from_fields.length === 0 || relation.to_fields.length === 0) {
      addIssue(
        issues,
        "RELATION_FIELD_TUPLE_EMPTY",
        path,
        "Both relation field tuples must contain at least one field",
        relation.relation_id,
      );
    }
    if (relation.from_fields.length !== relation.to_fields.length) {
      addIssue(
        issues,
        "RELATION_FIELD_ARITY_MISMATCH",
        path,
        `Relation field tuple widths differ (${relation.from_fields.length} and ${relation.to_fields.length})`,
        relation.relation_id,
      );
    }

    relation.from_fields.forEach((field, index) => {
      if (fromTable !== undefined && !fromTable.field_names.includes(field)) {
        addIssue(
          issues,
          "RELATION_ENDPOINT_FIELD_UNDEFINED",
          `${path}.from_fields[${index}]`,
          `Source field ${field} is absent from table ${fromTable.table_id}`,
          relation.relation_id,
        );
      }
    });
    relation.to_fields.forEach((field, index) => {
      if (toTable !== undefined && !toTable.field_names.includes(field)) {
        addIssue(
          issues,
          "RELATION_ENDPOINT_FIELD_UNDEFINED",
          `${path}.to_fields[${index}]`,
          `Target field ${field} is absent from table ${toTable.table_id}`,
          relation.relation_id,
        );
      }
    });
  }

  return firstById(relations, (relation) => relation.relation_id);
}

function checkProjectionPartition(
  projection: Projection,
  tableById: ReadonlyMap<string, TableDefinition>,
  relationById: ReadonlyMap<string, RelationDefinition>,
  tableUsage: Set<string>,
  relationUsage: Set<string>,
  issues: FamilySpecTopologyIssue[],
): void {
  const path = projectionPath(projection.projection_id);
  const roleSets = PROJECTION_ROLE_MEMBERSHIPS.map(([field, role]) => {
    const values = projection[field];
    for (const duplicate of duplicateValues(values)) {
      addIssue(
        issues,
        "DUPLICATE_PROJECTION_MEMBER",
        `${path}.${field}`,
        `Table ${duplicate} occurs more than once in ${field}`,
        duplicate,
      );
    }
    for (const tableId of values) {
      tableUsage.add(tableId);
      const table = tableById.get(tableId);
      if (table === undefined) {
        addIssue(
          issues,
          "PROJECTION_TABLE_UNDEFINED",
          `${path}.${field}`,
          `Projection table ${tableId} is undefined`,
          tableId,
        );
      } else if (table.role !== role) {
        addIssue(
          issues,
          "TABLE_ROLE_MISMATCH",
          `${path}.${field}`,
          `Projection membership ${field} requires role ${role}, but table role is ${table.role}`,
          tableId,
        );
      }
    }
    return { field, values: new Set(values) };
  });

  for (let leftIndex = 0; leftIndex < roleSets.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < roleSets.length; rightIndex += 1) {
      const left = roleSets[leftIndex];
      const right = roleSets[rightIndex];
      if (left === undefined || right === undefined) continue;
      for (const tableId of intersect(left.values, right.values)) {
        addIssue(
          issues,
          "PROJECTION_ROLE_OVERLAP",
          path,
          `Table ${tableId} occurs in both ${left.field} and ${right.field}`,
          tableId,
        );
      }
    }
  }

  const topology = new Set(roleSets.flatMap(({ values }) => [...values]));
  for (const field of ["required", "optional"] as const) {
    for (const duplicate of duplicateValues(projection[field])) {
      addIssue(
        issues,
        "DUPLICATE_PROJECTION_MEMBER",
        `${path}.${field}`,
        `Table ${duplicate} occurs more than once in ${field}`,
        duplicate,
      );
    }
  }
  const required = new Set(projection.required);
  const optional = new Set(projection.optional);
  for (const tableId of intersect(required, optional)) {
    addIssue(
      issues,
      "PROJECTION_REQUIREMENT_OVERLAP",
      path,
      `Table ${tableId} occurs in both required and optional`,
      tableId,
    );
  }

  const requirementTopology = new Set([...required, ...optional]);
  const missingRequirements = difference(topology, requirementTopology);
  const outsideRequirements = difference(requirementTopology, topology);
  if (missingRequirements.length > 0 || outsideRequirements.length > 0) {
    addIssue(
      issues,
      "PROJECTION_REQUIREMENT_COVERAGE_MISMATCH",
      path,
      `required/optional coverage differs from role topology; missing=[${missingRequirements.join(",")}], outside=[${outsideRequirements.join(",")}]`,
      projection.projection_id,
    );
  }

  for (const tableId of projection.allow_empty) {
    if (!topology.has(tableId)) {
      addIssue(
        issues,
        "ALLOW_EMPTY_OUTSIDE_TOPOLOGY",
        `${path}.allow_empty`,
        `allow_empty table ${tableId} is outside the projection topology`,
        tableId,
      );
    }
  }

  for (const duplicate of duplicateValues(projection.relations)) {
    addIssue(
      issues,
      "DUPLICATE_PROJECTION_RELATION",
      `${path}.relations`,
      `Relation ${duplicate} occurs more than once in the projection`,
      duplicate,
    );
  }
  for (const relationId of projection.relations) {
    relationUsage.add(relationId);
    const relation = relationById.get(relationId);
    if (relation === undefined) {
      addIssue(
        issues,
        "PROJECTION_RELATION_UNDEFINED",
        `${path}.relations`,
        `Projection relation ${relationId} is undefined`,
        relationId,
      );
      continue;
    }
    if (!topology.has(relation.from_table_id) || !topology.has(relation.to_table_id)) {
      addIssue(
        issues,
        "PROJECTION_RELATION_ENDPOINT_OUTSIDE_TOPOLOGY",
        `${path}.relations`,
        `Relation ${relationId} has an endpoint outside the projection topology`,
        relationId,
      );
    }
  }
}

function normalizeProjection(projection: Projection): NormalizedProjectionTopology {
  return {
    projection_id: projection.projection_id,
    schema_version: projection.schema_version,
    primary_tables: [...projection.primary_tables],
    supporting_tables: [...projection.supporting_tables],
    derived_tables: [...projection.derived_tables],
    required: [...projection.required],
    optional: [...projection.optional],
    allow_empty: [...projection.allow_empty],
    relations: [...projection.relations],
  };
}

function normalizeTable(table: TableDefinition): NormalizedTableTopology {
  return {
    table_id: table.table_id,
    schema_ref: table.schema_ref,
    role: table.role,
    required: table.required,
    allow_empty: table.allow_empty,
    primary_key: [...table.primary_key],
    field_names: [...table.field_names],
  };
}

function normalizeRelation(relation: RelationDefinition): NormalizedRelationTopology {
  return {
    relation_id: relation.relation_id,
    from_table_id: relation.from_table_id,
    from_fields: [...relation.from_fields],
    to_table_id: relation.to_table_id,
    to_fields: [...relation.to_fields],
    cardinality: relation.cardinality,
    missing_policy: relation.missing_policy,
  };
}

function normalizeOutput(output: DeclaredTableRef): NormalizedDeclaredOutputTopology {
  return { table_id: output.table_id, schema_ref: output.schema_ref };
}

function sortIssues(issues: FamilySpecTopologyIssue[]): FamilySpecTopologyIssue[] {
  return issues.sort((left, right) => compareStrings(
    `${left.path}\u0000${left.code}\u0000${left.object_id ?? ""}\u0000${left.message}`,
    `${right.path}\u0000${right.code}\u0000${right.object_id ?? ""}\u0000${right.message}`,
  ));
}

export function checkFamilySpecTopology(value: unknown): FamilySpecTopologyReport {
  const spec = parseFamilySpec(value, "$");
  const issues: FamilySpecTopologyIssue[] = [];

  checkUniqueObjectIds(
    spec.projections,
    (projection) => projection.projection_id,
    "DUPLICATE_PROJECTION_ID",
    "$.projections",
    "projection id",
    issues,
  );
  const tableById = checkTables(spec.table_definitions, spec.declared_outputs, issues);
  const relationById = checkRelations(spec.relations, tableById, issues);

  const tableUsage = new Set<string>();
  const relationUsage = new Set<string>();
  for (const projection of spec.projections) {
    checkProjectionPartition(
      projection,
      tableById,
      relationById,
      tableUsage,
      relationUsage,
      issues,
    );
  }

  for (const table of spec.table_definitions) {
    if (!tableUsage.has(table.table_id)) {
      addIssue(
        issues,
        "UNUSED_TABLE",
        "$.projections",
        `Table ${table.table_id} is unused by every projection`,
        table.table_id,
      );
    }
  }
  for (const relation of spec.relations) {
    if (!relationUsage.has(relation.relation_id)) {
      addIssue(
        issues,
        "UNUSED_RELATION",
        "$.projections",
        `Relation ${relation.relation_id} is unused by every projection`,
        relation.relation_id,
      );
    }
  }

  const normalizedTopology: NormalizedFamilySpecTopology = {
    projections: sortedCopies(spec.projections, (projection) => projection.projection_id)
      .map(normalizeProjection),
    table_definitions: sortedCopies(spec.table_definitions, (table) => table.table_id)
      .map(normalizeTable),
    relations: sortedCopies(spec.relations, (relation) => relation.relation_id)
      .map(normalizeRelation),
    declared_outputs: sortedCopies(spec.declared_outputs, (output) => output.table_id)
      .map(normalizeOutput),
  };
  const sortedIssues = sortIssues(issues);

  return {
    proposal_only: true,
    topology_valid: sortedIssues.length === 0,
    issues: sortedIssues,
    normalized_topology: normalizedTopology,
  };
}
