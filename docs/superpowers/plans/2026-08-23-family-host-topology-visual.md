# Family Host Topology Visual Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a V2-only Family Host structure explorer that renders authoritative table roles, PK/FK-style relation mappings, cardinality, missing policy, and candidate/artifact provenance in the existing build-result UI.

**Architecture:** Preserve the existing V1 build flow while making `BuildDetail.manifest` version-aware. Convert a validated `DatasetManifestV2` into a deterministic role-lane view model, render a custom presentational SVG edge layer with accessible HTML table nodes, and keep a complete shadcn relation table and Sheet inspector as the semantic interaction surface.

**Tech Stack:** TypeScript 5.6, React 19, Vitest, Testing Library, Vite, Tailwind CSS v4, shadcn/ui base-nova, Phosphor icons.

## Global Constraints

- Work only in `D:/coding/BioMed-QAgent-family-host-topology-visual` on `feat/family-host-topology-visual`.
- Do not modify `main`, another worktree, `App.tsx`, conversation reducers/renderers, lifecycle, HIL, ProductAssessment components, shared README/AGENTS/TODO/ISSUES/ADR files, or archived migration documents.
- Do not add dependencies, sandbox/container/IPC behavior, generic DAG behavior, or Gold-specific branches.
- V1 manifests retain the existing four build-result tabs and behavior.
- V2 topology must fail closed at the frontend API boundary; never infer relations or table roles from filenames, CSV columns, artifact order, or aggregate coverage.
- `TableDefinition.role` is authoritative for `primary | supporting | derived`.
- Lineage is limited to manifest-backed candidate/artifact provenance; do not claim record-level lineage.
- Use existing shadcn components, semantic tokens, Phosphor icons, `gap-*`, keyboard focus, and reduced-motion-safe behavior.
- Every behavior change starts with a failing test. Do not use `as any`, `@ts-ignore`, or `@ts-expect-error`.

---

## File Structure

- Modify `packages/contracts/src/dataset-build.ts` — make `BuildDetail.manifest` a versioned manifest union.
- Modify `frontend/src/lib/apiResponseParsers.ts` — parse and cross-validate V2 topology without changing V1 output.
- Create `frontend/src/components/family-host/relations/topology-model.ts` — deterministic role-lane projection and selection helpers.
- Create `frontend/src/components/family-host/relations/TopologyMap.tsx` — scroll-contained HTML table nodes plus presentational SVG edges.
- Create `frontend/src/components/family-host/relations/TopologyInspector.tsx` — selected table/relation and candidate/artifact detail Sheet.
- Create `frontend/src/components/family-host/relations/FamilyTopologyExplorer.tsx` — summary, shared selection state, map, accessible relation table, and inspector composition.
- Create `frontend/src/components/family-host/relations/index.ts` — public feature export.
- Modify `frontend/src/components/BuildResultsViewer.tsx` — add the V2-only `结构` tab.
- Create `frontend/src/test/family-host-topology-parser.test.ts` — focused V1/V2 wire-boundary tests.
- Create `frontend/src/test/family-host-topology-model.test.ts` — deterministic projection tests.
- Create `frontend/src/test/family-host-topology-explorer.test.tsx` — interaction and accessibility tests.
- Modify `frontend/src/test/build-results-viewer.test.tsx` — integration coverage for conditional tab behavior.

---

### Task 1: Preserve and validate V2 topology at the frontend boundary

**Files:**
- Modify: `packages/contracts/src/dataset-build.ts`
- Modify: `frontend/src/lib/apiResponseParsers.ts`
- Create: `frontend/src/test/family-host-topology-parser.test.ts`

**Interfaces:**
- Consumes: `DatasetManifestV1`, `DatasetManifestV2`, `VersionedDatasetManifest`, `TableDefinition`, `RelationDefinition`, and `PublicationCandidateRef` from `@biomed/contracts`.
- Produces: `parseBuildDetail(json): BuildDetail` whose `manifest` is a validated `VersionedDatasetManifest` and retains V2 topology arrays.

- [ ] **Step 1: Write failing V1/V2 parser tests**

Create a fixture helper that builds a complete V2 manifest and assert both preservation and rejection:

```ts
import { describe, expect, it } from "vitest";

import { parseBuildDetail } from "@/lib/apiResponseParsers";

const artifact = {
  artifact_id: "artifact_expression",
  role: "primary_dataset",
  relative_path: "tables/expression.csv",
  media_type: "text/csv",
  size_bytes: 42,
  sha256: "a".repeat(64),
} as const;

function v2Manifest() {
  return {
    schema_version: "2.0",
    manifest_id: "manifest_topology",
    task_id: "task_topology",
    build_id: "build_topology",
    dataset_family: "gene_expression",
    row_granularity: "measurement_by_sample",
    schema_ref: "schema.expression.v2",
    primary_key: ["dataset_revision_id", "sample_id", "feature_id"],
    row_count: 42,
    sha256: "b".repeat(64),
    artifacts: [artifact],
    source_summary: { asset_source: { asset_id: "asset_source" } },
    validation_summary: { status: "passed" },
    confidence_summary: {},
    provenance_summary: { coverage: { coverage_ratio: 1 } },
    tables: [
      {
        table_id: "expression",
        schema_ref: "schema.expression.v2",
        role: "primary",
        required: true,
        allow_empty: false,
        primary_key: ["dataset_revision_id", "sample_id", "feature_id"],
        field_names: ["dataset_revision_id", "sample_id", "feature_id", "value"],
      },
      {
        table_id: "samples",
        schema_ref: "schema.samples.v2",
        role: "supporting",
        required: true,
        allow_empty: false,
        primary_key: ["dataset_revision_id", "sample_id"],
        field_names: ["dataset_revision_id", "sample_id", "condition"],
      },
    ],
    relations: [
      {
        relation_id: "expression_samples",
        from_table_id: "expression",
        from_fields: ["dataset_revision_id", "sample_id"],
        to_table_id: "samples",
        to_fields: ["dataset_revision_id", "sample_id"],
        cardinality: "many_to_one",
        missing_policy: "reject",
      },
    ],
    candidate_refs: [
      {
        candidate_id: "candidate_topology",
        table_ids: ["expression", "samples"],
        relation_ids: ["expression_samples"],
        provenance_refs: ["result_provenance"],
        confidence_refs: ["result_confidence"],
        audit_refs: [],
      },
    ],
  };
}

function detail(manifest = v2Manifest()) {
  return {
    build_id: "build_topology",
    task_id: "task_topology",
    manifest_ref: "datasets_build/build_topology/dataset_manifest.json",
    build_result: null,
    manifest,
    publication: null,
    artifacts: manifest.artifacts,
  };
}

describe("V2 build manifest parsing", () => {
  it("preserves tables, relations, and candidate refs", () => {
    const parsed = parseBuildDetail(detail());
    expect(parsed.manifest.schema_version).toBe("2.0");
    if (parsed.manifest.schema_version !== "2.0") throw new Error("expected V2");
    expect(parsed.manifest.tables.map((table) => table.table_id)).toEqual(["expression", "samples"]);
    expect(parsed.manifest.relations[0]?.cardinality).toBe("many_to_one");
    expect(parsed.manifest.candidate_refs[0]?.candidate_id).toBe("candidate_topology");
  });

  it.each([
    { relations: [{ ...v2Manifest().relations[0], to_table_id: "missing" }] },
    { relations: [{ ...v2Manifest().relations[0], from_fields: ["missing_field"] }] },
    { relations: [{ ...v2Manifest().relations[0], to_fields: ["dataset_revision_id"] }] },
    { candidate_refs: [{ ...v2Manifest().candidate_refs[0], relation_ids: ["missing_relation"] }] },
  ])("rejects malformed topology references", (override) => {
    expect(() => parseBuildDetail(detail({ ...v2Manifest(), ...override }))).toThrow();
  });
});
```

- [ ] **Step 2: Run the parser test and verify it fails**

Run:

```powershell
pnpm --filter @biomed/frontend test -- family-host-topology-parser.test.ts
```

Expected: failure because the current parser returns the V1 manifest shape and `BuildDetail.manifest` is not version-aware.

- [ ] **Step 3: Make the shared BuildDetail type version-aware**

In `packages/contracts/src/dataset-build.ts`, keep the existing local
`VersionedDatasetManifest` union and change only the detail field:

```ts
export interface BuildDetail {
  build_id: string;
  task_id: string;
  manifest_ref: string;
  build_result: BuildResult | null;
  manifest: VersionedDatasetManifest;
  publication: DatasetPublication | null;
  artifacts: ManifestArtifactEntry[];
}
```

Keep the existing `DatasetManifest` V1 alias unchanged for legacy consumers.

- [ ] **Step 4: Implement strict version-aware manifest parsing**

In `frontend/src/lib/apiResponseParsers.ts`, keep the existing common manifest fields, add typed parsers for `TableDefinition`, `RelationDefinition`, and `PublicationCandidateRef`, and cross-validate after parsing:

```ts
function parseVersionedDatasetManifest(json: unknown, path: string): VersionedDatasetManifest {
  const object = assertObject(json, path);
  const common = parseDatasetManifestV1Fields(object, path);
  if (Reflect.get(object, "schema_version") !== "2.0") return common;

  const tables = assertArray(Reflect.get(object, "tables"), `${path}.tables`, parseTableDefinition);
  const relations = assertArray(Reflect.get(object, "relations"), `${path}.relations`, parseRelationDefinition);
  const candidateRefs = assertArray(
    Reflect.get(object, "candidate_refs"),
    `${path}.candidate_refs`,
    parsePublicationCandidateRef,
  );
  validateTopologyReferences(tables, relations, candidateRefs, path);
  return { ...common, schema_version: "2.0", tables, relations, candidate_refs: candidateRefs };
}
```

`validateTopologyReferences` must reject duplicate table/relation/candidate IDs, orphan relation endpoints, missing endpoint fields, unequal field-pair lengths, and candidate refs to unknown tables or relations. Use `APIError(502, message)` consistently with the surrounding parser.

- [ ] **Step 5: Run focused parser and existing API tests**

Run:

```powershell
pnpm --filter @biomed/frontend test -- family-host-topology-parser.test.ts api.test.ts api-malformed-rejection.test.ts
pnpm --filter @biomed/contracts test
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit the wire-boundary slice**

```powershell
git add packages/contracts/src/dataset-build.ts frontend/src/lib/apiResponseParsers.ts frontend/src/test/family-host-topology-parser.test.ts
git commit -m "feat(frontend): preserve V2 build topology"
```

---

### Task 2: Build the deterministic topology view model

**Files:**
- Create: `frontend/src/components/family-host/relations/topology-model.ts`
- Create: `frontend/src/test/family-host-topology-model.test.ts`

**Interfaces:**
- Consumes: `DatasetManifestV2`, `TableDefinition`, `RelationDefinition`, and `PublicationCandidateRef`.
- Produces:
  - `buildTopologyModel(manifest: DatasetManifestV2): TopologyModel`
  - `relationsForTable(model: TopologyModel, tableId: string): readonly RelationDefinition[]`
  - `isRelationConnected(selection: TopologySelection, relation: RelationDefinition): boolean`

- [ ] **Step 1: Write failing deterministic projection tests**

Cover role ordering, counts, derived-role preservation, connected relations, and candidate-level evidence:

```ts
expect(model.lanes.map((lane) => lane.role)).toEqual(["primary", "supporting", "derived"]);
expect(model.lanes[1]?.tables.map((table) => table.table_id)).toEqual(["samples", "sources"]);
expect(model.summary).toEqual({ tables: 4, relations: 3, primary: 1, supporting: 2, derived: 1 });
expect(relationsForTable(model, "expression").map((relation) => relation.relation_id)).toEqual([
  "expression_samples",
  "expression_quality",
]);
expect(model.evidence.candidates[0]?.provenance_refs).toEqual(["result_provenance"]);
```

- [ ] **Step 2: Run the model test and verify it fails**

Run:

```powershell
pnpm --filter @biomed/frontend test -- family-host-topology-model.test.ts
```

Expected: module-not-found failure for `topology-model`.

- [ ] **Step 3: Implement the pure model**

Define stable types and sort every ID with `localeCompare`:

```ts
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

export function buildTopologyModel(manifest: DatasetManifestV2): TopologyModel {
  const roles: readonly TableRole[] = ["primary", "supporting", "derived"];
  const tables = [...manifest.tables].sort((left, right) => left.table_id.localeCompare(right.table_id));
  const relations = [...manifest.relations].sort((left, right) => left.relation_id.localeCompare(right.relation_id));
  return {
    lanes: roles.map((role) => ({ role, tables: tables.filter((table) => table.role === role) })),
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
    evidence: { candidates: manifest.candidate_refs, artifacts: manifest.artifacts },
  };
}
```

- [ ] **Step 4: Run the model tests**

Run:

```powershell
pnpm --filter @biomed/frontend test -- family-host-topology-model.test.ts
```

Expected: all model tests pass.

- [ ] **Step 5: Commit the pure model slice**

```powershell
git add frontend/src/components/family-host/relations/topology-model.ts frontend/src/test/family-host-topology-model.test.ts
git commit -m "feat(frontend): model family table topology"
```

---

### Task 3: Render the topology map, relation table, and inspector

**Files:**
- Create: `frontend/src/components/family-host/relations/TopologyMap.tsx`
- Create: `frontend/src/components/family-host/relations/TopologyInspector.tsx`
- Create: `frontend/src/components/family-host/relations/FamilyTopologyExplorer.tsx`
- Create: `frontend/src/components/family-host/relations/index.ts`
- Create: `frontend/src/test/family-host-topology-explorer.test.tsx`

**Interfaces:**
- Consumes: `DatasetManifestV2`, `DatasetPublication | null`, and `TopologyModel` from Task 2.
- Produces: `FamilyTopologyExplorer({ manifest, publication }: FamilyTopologyExplorerProps)`.

- [ ] **Step 1: Write failing explorer interaction tests**

Render a four-table fixture and assert:

```ts
expect(screen.getByText("4 张表")).toBeInTheDocument();
expect(screen.getByRole("button", { name: /expression.*主表/ })).toBeVisible();
expect(screen.getByRole("button", { name: /quality.*派生表/ })).toBeVisible();
expect(screen.getByRole("table", { name: "表关系" })).toBeVisible();

fireEvent.click(screen.getByRole("button", { name: /expression_samples/ }));
expect(screen.getByRole("dialog", { name: "关系详情" })).toBeVisible();
expect(screen.getByText("dataset_revision_id + sample_id")).toBeVisible();
expect(screen.getByText("多对一")).toBeVisible();

fireEvent.click(screen.getByRole("button", { name: /expression.*主表/ }));
expect(screen.getByRole("dialog", { name: "表详情" })).toBeVisible();
expect(screen.getByText("schema.expression.v2")).toBeVisible();
expect(screen.getByText("候选级证据")).toBeVisible();
```

Add a no-relation fixture and assert the informational empty state while table nodes remain visible.

- [ ] **Step 2: Run the explorer test and verify it fails**

Run:

```powershell
pnpm --filter @biomed/frontend test -- family-host-topology-explorer.test.tsx
```

Expected: module-not-found failure for `FamilyTopologyExplorer`.

- [ ] **Step 3: Implement `TopologyMap` with deterministic geometry**

Use a scroll-contained 888-unit canvas, lane x positions `24 / 324 / 624`, node width `240`, row height `144`, and a computed height of `max(420, maxLaneSize * 144 + 72)`. Render SVG paths behind absolutely positioned HTML node buttons. Mark the SVG `aria-hidden="true"`; make every node button labelled with table ID and Chinese role label.

The geometry helper must be pure:

```ts
const LANE_X = { primary: 24, supporting: 324, derived: 624 } as const;
const NODE_WIDTH = 240;
const NODE_HEIGHT = 112;
const ROW_HEIGHT = 144;

function nodePoint(model: TopologyModel, tableId: string) {
  const lane = model.lanes.find((entry) => entry.tables.some((table) => table.table_id === tableId));
  if (lane === undefined) throw new Error(`Unknown topology table '${tableId}'`);
  const index = lane.tables.findIndex((table) => table.table_id === tableId);
  return { x: LANE_X[lane.role], y: 48 + index * ROW_HEIGHT };
}
```

Draw cubic paths between endpoint centers. Use semantic CSS tokens for strokes and opacity, `vectorEffect="non-scaling-stroke"`, and no animation. Selected/connected state changes stroke emphasis but never hides the relation.

- [ ] **Step 4: Implement `TopologyInspector`**

Compose `Sheet`, `SheetHeader`, `SheetTitle`, `SheetDescription`, `Badge`, `Card`, `Separator`, and `Table`. Provide two explicit titles: `表详情` and `关系详情`. Table selection lists every field, PK fields, and connected relations. Relation selection lists paired endpoint fields, cardinality, and missing policy. A candidate evidence card labels refs as `候选级证据`; artifacts remain a separate manifest artifact list.

- [ ] **Step 5: Implement `FamilyTopologyExplorer` composition**

The orchestrator owns one `TopologySelection` state and passes it to both views:

```ts
export interface FamilyTopologyExplorerProps {
  readonly manifest: DatasetManifestV2;
  readonly publication: DatasetPublication | null;
}

export function FamilyTopologyExplorer({ manifest, publication }: FamilyTopologyExplorerProps) {
  const model = useMemo(() => buildTopologyModel(manifest), [manifest]);
  const [selection, setSelection] = useState<TopologySelection>(null);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <TopologySummary model={model} publication={publication} />
      <TopologyMap model={model} selection={selection} onSelect={setSelection} />
      <RelationTable model={model} selection={selection} onSelect={setSelection} />
      <TopologyInspector
        model={model}
        selection={selection}
        onOpenChange={(open) => { if (!open) setSelection(null); }}
      />
    </div>
  );
}
```

Use full Card composition, Badge variants, existing Table primitives, and an `Empty` state labelled `此构建没有声明表关系` when `model.relations.length === 0`.

- [ ] **Step 6: Run explorer and focused accessibility tests**

Run:

```powershell
pnpm --filter @biomed/frontend test -- family-host-topology-explorer.test.tsx
pnpm --filter @biomed/frontend lint
pnpm --filter @biomed/frontend tsc
```

Expected: component tests, lint, and typecheck pass with zero warnings.

- [ ] **Step 7: Commit the explorer slice**

```powershell
git add frontend/src/components/family-host/relations frontend/src/test/family-host-topology-explorer.test.tsx
git commit -m "feat(frontend): add family topology explorer"
```

---

### Task 4: Integrate the V2-only structure tab

**Files:**
- Modify: `frontend/src/components/BuildResultsViewer.tsx`
- Modify: `frontend/src/test/build-results-viewer.test.tsx`

**Interfaces:**
- Consumes: `FamilyTopologyExplorer` from Task 3 and versioned `BuildDetail.manifest` from Task 1.
- Produces: an additional `结构` tab only when `manifest.schema_version === "2.0"`.

- [ ] **Step 1: Write failing integration tests**

Add a V2 fixture by extending the existing manifest fixture with `schema_version`, tables, relations, and candidate refs. Assert:

```ts
expect(await screen.findByRole("tab", { name: "结构" })).toBeVisible();
fireEvent.click(screen.getByRole("tab", { name: "结构" }));
expect(await screen.findByRole("table", { name: "表关系" })).toBeVisible();
expect(screen.getByText("expression_samples")).toBeVisible();
```

Keep the existing V1 fixture and assert:

```ts
expect(screen.queryByRole("tab", { name: "结构" })).not.toBeInTheDocument();
```

- [ ] **Step 2: Run the BuildResultsViewer test and verify it fails**

Run:

```powershell
pnpm --filter @biomed/frontend test -- build-results-viewer.test.tsx
```

Expected: V2 test fails because the `结构` tab is absent; existing V1 tests remain green.

- [ ] **Step 3: Add the conditional tab**

Narrow with the discriminant once and reuse the result:

```ts
const topologyManifest = manifest.schema_version === "2.0" ? manifest : null;
```

Inside `TabsList`:

```tsx
{topologyManifest !== null && <TabsTrigger value="topology">结构</TabsTrigger>}
```

Inside the existing `ScrollArea`:

```tsx
{topologyManifest !== null && (
  <TabsContent value="topology" className="min-h-0">
    <FamilyTopologyExplorer manifest={topologyManifest} publication={detail.publication} />
  </TabsContent>
)}
```

Do not change the default `primary` tab or existing tab labels.

- [ ] **Step 4: Run the complete frontend test set**

Run:

```powershell
pnpm --filter @biomed/frontend test
pnpm --filter @biomed/frontend lint
pnpm --filter @biomed/frontend tsc
pnpm --filter @biomed/frontend build
```

Expected: all frontend tests and checks pass.

- [ ] **Step 5: Commit the integration slice**

```powershell
git add frontend/src/components/BuildResultsViewer.tsx frontend/src/test/build-results-viewer.test.tsx
git commit -m "feat(frontend): expose V2 structure tab"
```

---

### Task 5: Browser visual QA and final repository gates

**Files:**
- Modify only files from Tasks 1-4 when browser review finds a concrete defect.
- Do not add shared documentation changes.

**Interfaces:**
- Consumes: the integrated V2 explorer.
- Produces: verified browser evidence, a clean branch, and a pushed remote branch commit SHA.

- [ ] **Step 1: Start one task-scoped Host**

From the worktree root run `pnpm dev` in a managed terminal. Wait for:

```text
BioMed-QAgent ready
Local: http://127.0.0.1:5173/
```

Do not start a second Host on the same data root.

- [ ] **Step 2: Inspect the explorer in the browser**

Use the in-app browser against `http://127.0.0.1:5173/`. Open a V2 build fixture or locally produced V2 build through the normal UI/API. Verify:

- structure tab placement in the existing 1120px build dialog and bottom sheet;
- all three role lanes and relation edges;
- node/relation selection and Sheet close behavior;
- horizontal scrolling does not move the outer dialog;
- narrow viewport keeps the graph usable;
- keyboard focus is visible;
- dark and light semantic contrast remain readable;
- no browser console errors.

Capture desktop and narrow screenshots. If no V2 runtime build is available, use the focused component fixture through the existing test harness and report that limitation; do not fabricate a production build.

- [ ] **Step 3: Fix only observed visual defects and rerun focused tests**

For each browser-observed defect, add or strengthen a reproducing component test, verify it fails, make the smallest CSS/component correction, then rerun:

```powershell
pnpm --filter @biomed/frontend test -- family-host-topology-explorer.test.tsx build-results-viewer.test.tsx
```

Expected: focused tests pass after each correction.

- [ ] **Step 4: Stop the task-scoped Host**

Send Ctrl+C through the managed terminal and verify port 5173 no longer listens.

- [ ] **Step 5: Run all repository quality gates**

From the worktree root run:

```powershell
pnpm test
pnpm lint
pnpm typecheck
pnpm build
uv run python database/bridge.py --self-test
uv run pytest database/tests
uv run ruff check database
git diff --check
git status --short --branch
```

Expected: every command passes, Ruff has zero warnings, and only intended committed branch changes remain.

- [ ] **Step 6: Commit any browser-QA correction**

If Step 3 changed files:

```powershell
git add frontend/src/components/family-host/relations frontend/src/test
git commit -m "fix(frontend): refine topology explorer layout"
```

If Step 3 changed nothing, do not create an empty commit.

- [ ] **Step 7: Push the feature branch and report evidence**

```powershell
git push -u origin feat/family-host-topology-visual
git rev-parse HEAD
git status --short --branch
```

Expected: the remote feature branch points at the printed HEAD SHA and the worktree is clean. Do not merge into `main`; return the commit SHA and integration notes to the main integrator for `cherry-pick -x` on current `main`.
