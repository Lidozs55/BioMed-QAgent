# Family Host Topology Visual Design

## Status

Approved on 2026-08-23 for implementation on
`feat/family-host-topology-visual`.

This design is limited to the existing `in_process_unisolated` Family Host/Core
publication baseline. It does not add sandbox, container, IPC, generic DAG, or
Gold-specific production behavior.

## Goal

Make an authoritative V2 multi-table publication understandable from the
existing build-result surface. A user must be able to identify table roles,
primary and foreign-key field mappings, relation cardinality, missing policies,
and the artifact/candidate provenance closure without reading raw JSON.

Record-level lineage is not in scope. The current stable wire contract exposes
manifest topology and candidate/artifact references, not a typed record-lineage
graph. The UI must not infer deeper lineage from filenames, CSV columns,
artifact ordering, or aggregate coverage.

## Product Placement

Add a V2-only `结构` tab to `BuildResultsViewer`.

- Keep the existing `主数据 / 来源 / 处理 / 警告` tabs unchanged.
- Do not modify `App.tsx`, conversation reducers/renderers, lifecycle, HIL, or
  ProductAssessment components.
- Reuse the same viewer inside the existing build dialog and artifact sheet.
- V1 and legacy builds retain their current behavior and do not show a topology
  tab.

The implementation lives primarily under:

```text
frontend/src/components/family-host/relations/
```

## Data Boundary

`GET /api/v1/builds/{build_id}` already returns the complete manifest object.
The server BuildStore preserves V2 fields, but the frontend parser currently
projects every manifest into the V1 shape and discards `tables`, `relations`,
and `candidate_refs`.

Implementation must:

1. Treat `schema_version: "2.0"` as `DatasetManifestV2`.
2. Preserve V1 parsing and rendering behavior.
3. Parse V2 tables, relations, and candidate references from the existing
   `@biomed/contracts` DTOs.
4. Reject malformed or cross-referenced topology rather than dropping or
   guessing data.
5. Use `TableDefinition.role` as the authority for
   `primary | supporting | derived`. `ArtifactRole` has no `derived` value and
   must not be used to infer a table's role.

No new backend endpoint or new lineage DTO is introduced in this lane.

## Interaction Design

### Structure summary

The top of the tab shows a compact summary of:

- table and relation counts;
- primary, supporting, and derived table counts;
- provenance coverage;
- publication identity when present.

All values come from the parsed V2 manifest and existing build detail.

### Deterministic topology map

The visual signature is a schema-blueprint map organized into three semantic
lanes:

```text
Primary tables  ->  Supporting tables  ->  Derived tables
```

The layout is deterministic, not a generic graph engine:

- tables are grouped by authoritative role and sorted by table ID;
- a table node shows table ID, role, schema ref, PK fields, field count,
  required state, and allow-empty state;
- non-key fields are collapsed in the map and available in the inspector;
- selecting a table highlights only its incident relations;
- selecting a relation highlights both endpoints;
- relation labels expose cardinality and missing policy.

The map may use a small custom SVG connection layer because the project has no
installed graph primitive. The SVG is presentational. The semantic source of
truth is the accessible relation table rendered with existing shadcn
primitives.

### Relation table

Always render a keyboard-accessible relation table below the map. Each row
contains:

- relation ID;
- source table and fields;
- target table and fields;
- cardinality;
- missing policy.

The paired source/target fields are labelled as a PK/FK-style mapping without
claiming that every relation is a database-enforced foreign key. Selecting a
row updates the same selection state as the map.

### Detail inspector

Selection opens a detail surface that composes existing shadcn components:

- desktop: `Sheet`;
- narrow/mobile layout: the existing responsive Sheet behavior, without adding
  a new drawer dependency;
- table detail: schema ref, role, required/allow-empty, PK, all field names, and
  connected relations;
- relation detail: endpoint field pairs, cardinality, and missing policy;
- evidence detail: candidate refs and manifest artifacts at their true
  candidate/artifact scope.

The inspector must explicitly label candidate-level provenance. It must not
attribute a global provenance ref to an individual row or table unless the
wire contract does so.

## Visual System

Match the existing shadcn `base-nova` preset, mist base, sky theme, Inter type,
small radius, Phosphor icon library, and semantic tokens.

- Role distinctions use Badge variants, border emphasis, iconography, and text;
  color is not the only signal.
- Avoid raw palette values and manual dark-mode overrides.
- Use spacing and layout classes through `gap-*`; do not introduce global theme
  changes.
- Spend visual emphasis on the topology map; surrounding cards remain compact
  and consistent with the existing build viewer.
- Respect keyboard focus and reduced-motion preferences. Do not add ambient or
  decorative animation.

## Empty and Failure States

- V1 manifests: retain the existing four-tab UI; no topology inference.
- Valid V2 manifest with no relations: show table roles and an informational
  empty relation state.
- Invalid V2 topology: reject at the API boundary and use the existing build
  load error path.
- Missing artifact/provenance detail: show a bounded informational state and
  preserve the topology view.
- Large field sets: collapse non-key fields in nodes; keep the complete list in
  the inspector.

## Accessibility

- The relation table is the full text alternative for the SVG map.
- Table/relation selection is reachable by keyboard and exposes pressed or
  selected state.
- SVG edges are hidden from assistive technology; no information exists only
  in an unlabeled path.
- Cards and badges include text labels for every role and policy.
- Horizontal overflow remains inside the topology surface, not the whole build
  dialog.

## Tests

### Contract and parser tests

- V1 manifests parse without behavior changes.
- V2 manifests preserve tables, relations, and candidate refs.
- Invalid roles, cardinalities, missing policies, duplicate IDs, orphan
  endpoints, mismatched field pairs, and candidate refs reject.

### Projection tests

- deterministic role ordering and counts;
- derived role comes from `TableDefinition`;
- PK and relation field mapping;
- connected-relation selection;
- candidate/artifact provenance stays globally scoped.

### Component tests

- V2 displays the `结构` tab; V1 does not;
- node and relation selection update the inspector;
- relation table exposes every edge and field mapping;
- no-relation and large-field states remain usable;
- existing BuildResultsViewer tests continue to pass.

### Visual verification

- inspect the existing build dialog and bottom-sheet placements in the browser;
- verify the topology tab at desktop and narrow widths;
- verify light/dark semantic contrast, keyboard focus, horizontal overflow, and
  reduced-motion behavior;
- capture browser screenshots for implementation review.

## Non-goals

- Record-level lineage or row tracing.
- Parsing unversioned provenance artifacts into a new implied contract.
- Generic DAG editing or layout.
- Family-specific branches or Gold-specific UI logic.
- Lifecycle, HIL, ProductAssessment, sandbox, container, or IPC changes.
- Shared README, AGENTS, TODO, ISSUES, or ADR edits.
