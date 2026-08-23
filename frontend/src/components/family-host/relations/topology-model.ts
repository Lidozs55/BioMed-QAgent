import type {
  DatasetManifestV2,
  PublicationCandidateRef,
  RelationDefinition,
  TableDefinition,
  TableRole,
} from "@biomed/contracts";

export type TopologySelection =
  | { kind: "table"; id: string }
  | { kind: "relation"; id: string }
  | null;

export interface TopologyLane {
  readonly role: TableRole;
  readonly tables: readonly TableDefinition[];
}

export interface TopologyModel {
  readonly lanes: readonly TopologyLane[];
  readonly relations: readonly RelationDefinition[];
  readonly tablesById: ReadonlyMap<string, TableDefinition>;
  readonly relationsById: ReadonlyMap<string, RelationDefinition>;
  readonly summary: {
    readonly tables: number;
    readonly relations: number;
    readonly primary: number;
    readonly supporting: number;
    readonly derived: number;
  };
  readonly evidence: {
    readonly candidates: readonly PublicationCandidateRef[];
    readonly artifacts: DatasetManifestV2["artifacts"];
  };
}

const TABLE_ROLES: readonly TableRole[] = ["primary", "supporting", "derived"];

export function buildTopologyModel(manifest: DatasetManifestV2): TopologyModel {
  const tables = [...manifest.tables].sort((left, right) => left.table_id.localeCompare(right.table_id));
  const relations = [...manifest.relations].sort((left, right) => left.relation_id.localeCompare(right.relation_id));
  const candidates = [...manifest.candidate_refs].sort((left, right) => left.candidate_id.localeCompare(right.candidate_id));
  const artifacts = [...manifest.artifacts].sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));

  return {
    lanes: TABLE_ROLES.map((role) => ({
      role,
      tables: tables.filter((table) => table.role === role),
    })),
    relations,
    tablesById: new Map(tables.map((table) => [table.table_id, table])),
    relationsById: new Map(relations.map((relation) => [relation.relation_id, relation])),
    summary: {
      tables: tables.length,
      relations: relations.length,
      primary: tables.filter((table) => table.role === "primary").length,
      supporting: tables.filter((table) => table.role === "supporting").length,
      derived: tables.filter((table) => table.role === "derived").length,
    },
    evidence: { candidates, artifacts },
  };
}

function endpointRole(
  model: TopologyModel,
  tableId: string,
  relation: RelationDefinition,
): TableRole | undefined {
  const endpointId = relation.from_table_id === tableId ? relation.to_table_id : relation.from_table_id;
  return model.tablesById.get(endpointId)?.role;
}

function roleIndex(role: TableRole | undefined): number {
  return role === undefined ? TABLE_ROLES.length : TABLE_ROLES.indexOf(role);
}

export function relationsForTable(model: TopologyModel, tableId: string): readonly RelationDefinition[] {
  return model.relations
    .filter((relation) => relation.from_table_id === tableId || relation.to_table_id === tableId)
    .sort((left, right) => {
      const leftRole = endpointRole(model, tableId, left);
      const rightRole = endpointRole(model, tableId, right);
      const roleDifference = roleIndex(leftRole) - roleIndex(rightRole);
      return roleDifference || left.relation_id.localeCompare(right.relation_id);
    });
}

export function isRelationConnected(selection: TopologySelection, relation: RelationDefinition): boolean {
  if (selection === null) return false;
  if (selection.kind === "relation") return selection.id === relation.relation_id;
  return relation.from_table_id === selection.id || relation.to_table_id === selection.id;
}
