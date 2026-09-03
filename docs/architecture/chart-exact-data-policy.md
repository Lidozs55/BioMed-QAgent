# Exact-only chart data policy

> Current policy implementing [ADR-043](../adr/043-exact-only-chart-values.md).
> This chapter defines formal quantitative behavior. Code listed as deprecated
> below remains only during the migration window and is not current product
> authority.

## Product rule

A formal chart point must copy an explicit numeric source value with an
unambiguous semantic binding. A visible mark or curve is evidence that a chart
exists; it is not evidence of the author's exact numeric coordinates.

### Accepted exact sources

| Source | Admission condition |
| --- | --- |
| Article text/table | Numeric token and figure/panel/series/condition binding are explicit |
| Supplementary CSV/TSV/XLSX/JSON/table | Official paper supplement and row/column mapping are explicit |
| Publisher source-data file | Official publisher asset bound to the article and figure |
| Author-declared repository | Paper/author declares the accession; version and figure mapping are preserved |
| Embedded machine-readable data | Official asset contains semantic numeric values, not merely vector geometry |

The source must enter the normal Core-owned acquisition/registration,
provenance, validation and publication chain. A search-result page only discovers
an asset; it is not the value source.

### Never exact

- raster-pixel digitization;
- coordinates reconstructed from SVG/PDF drawing geometry;
- OCR of unlabeled marks or ticks;
- interpolation or fitted curves;
- points inferred from IC50/AUC/summary statistics;
- an unstated dilution series reconstructed from endpoints and point count;
- model memory or representative values;
- any of the above accepted by a human reviewer.

## Bounded search and stopping rule

For each target figure/panel:

1. inspect article text, captions and tables;
2. inspect every relevant supplementary member;
3. inspect official publisher source-data material;
4. inspect the Data Availability statement;
5. inspect repositories/accessions explicitly declared by the paper or authors;
6. perform one bounded discovery search by DOI/title plus figure identifier when
   the preceding sources expose no exact data, then admit only an official or
   author-declared result.

Stop when all applicable classes have status `found`, `not_found`,
`inaccessible`, or `not_applicable`. Do not enumerate speculative URLs or repeat
an unchanged query. Record source class, locator/query, outcome, and reason.

## Partial publication and user report

No exact point source means:

- retain paper/experiment/chart-series records and exact source locators when the
  profile allows them;
- leave the figure's `chart_points` empty;
- continue publishing independently exact measurements, such as table IC50;
- mark coverage as partial/no exact chart-point data;
- never insert placeholder or estimated rows.

The final report must state:

1. paper and figure/panel discovered;
2. requested point data omitted;
3. source classes actually searched;
4. whether values were absent or inaccessible;
5. exact records that were still published;
6. next action: provide the source-data file/access, or contact the paper authors.

Recommended wording:

> The requested chart was found at `<paper, figure/panel>`, but no explicit
> numeric source for its plotted coordinates was found in `<searched source
> classes>`. Pixel/vector digitization would yield estimates rather than author
> values, so chart points were skipped. Independently published exact values
> were retained. Provide the author source-data file or contact the authors to
> obtain the original coordinates.

## Migration status and deprecated inventory

The following behavior is superseded by ADR-043. It remains in code temporarily
for compatibility and must not be used as proof that estimated chart values are
an active product feature.

### Exact source-data acquisition and projection — implementation owner

Removing estimates is not sufficient. Add a positive formal path that:

- discovers publisher source-data and paper/author-declared repository assets;
- Core-acquires/registers the exact file with URL/accession, version, media type,
  bytes and SHA-256;
- uses registered CSV/TSV/XLSX/JSON/table parsers rather than VLM geometry;
- records an explicit paper/figure/panel/series/condition column mapping;
- emits `chart_points` whose source locator addresses the numeric cell/record,
  not a pixel bbox;
- rejects ambiguous figure/series joins and values available only through an
  inaccessible source;
- records bounded search audit and skipped/inaccessible status for reporting.

This work owns new provider/parser/contract/profile/evaluator files. Coordinate
schema changes with the contracts/validation removal owner and do not modify the
prompt/policy files in this branch.

### Runtime producer and review path — removal owner

- `server/src/processing/vlm/registered-paper-chart-extraction.ts`: VLM `points`
  schema, estimated point normalization, corrective retry for missing points,
  point candidate carrier, and review-closed estimated carrier.
- `server/src/processing/vlm/chart-extraction.ts`: exploratory point generation,
  `reviewLowConfidencePoints`, candidate/reviewed evidence manifests.
- `server/src/processing/vlm/chart-json.ts` and `chart-csv.ts`: visual point rows
  and estimated-point CSV projection.
- `server/src/agent/tools/extract-chart-data-vlm.ts` and
  `extract-registered-paper-chart-evidence.ts`: tool descriptions and formal
  estimated-point review registration.

Preserve figure/series discovery, axis/legend error detection, source locators,
and exact table/source-data parsing while removing estimated coordinate output.

### Contracts, validation and profiles — removal owner

- `server/src/dataset/families/bioactivity-measurement/chart-evidence/`:
  `estimated_or_exact`, estimated-point HIL closure, corrections and publication
  admission.
- `server/src/dataset/families/literature-experiment-chart/profile.ts` and
  `validation.ts`: estimated point fields and VLM-estimate acceptance.
- Any matching `@biomed/contracts` wire types discovered during implementation
  must be versioned before removal; do not silently mutate an existing wire
  shape.

The replacement gate must reject estimated coordinates regardless of review
state and permit empty `chart_points` when exact source search is audited.

### HIL contracts/runtime — removal owner

- `packages/contracts/src/hil.ts`: retain a VLM scope only if needed for
  figure/series semantic review; remove its point-estimate approval meaning and
  mandatory-point-review policy.
- `server/src/dataset/review/`, `server/src/runtime/hil-pre-review.ts`, and HIL
  policy tests: remove estimated-coordinate accept/correct routes without
  changing publication acceptance, field mapping, or exact source-data mapping
  review.
- `packages/contracts/src/derived-source-asset.ts`: retain `vlm_extraction` for
  figure/series discovery provenance; do not remove the operation kind merely
  because point estimates are retired.

### Frontend — removal owner

- `frontend/src/components/settings/sections/HilApprovalSettingsSection.tsx`:
  remove VLM point-review product wording, retaining only any future
  figure/series semantic-review scope.
- `frontend/src/components/HumanReviewBatch.tsx` and associated questionnaire/
  review-card behavior: remove estimated-coordinate accept/correct UI while
  preserving other review types.
- `frontend/src/test/hil-data-correction-e2e.test.tsx` and
  `frontend/src/test/settings-hil-approval.test.tsx`: replace estimated-point
  acceptance fixtures with exact source-data mapping or non-chart HIL cases.
- `frontend/src/lib/chartData.ts`, `TaskOutputCharts.tsx` and their tests require
  product review: retain rendering only if it can display exact source-data
  points or clearly non-formal legacy output; never imply visual estimates are
  formal values.

### Evaluations and tests — migration owner

- Keep `docs/evaluation/gold-v1/**` byte-frozen as historical evidence.
- Create a successor version whose success criteria allow audited empty points,
  require exact source provenance for non-empty points, and verify final-report
  disclosure.
- Superseded fixture expectations occur in:
  - `server/tests/registered-paper-chart-extraction.test.ts`;
  - `server/tests/phase5/vlm.test.ts`;
  - `server/tests/bioactivity-chart-evidence.test.ts`;
  - `server/tests/gold6-current-head-e2e.test.ts`;
  - `server/tests/literature-experiment-chart-e2e.test.ts`;
  - `server/tests/literature-experiment-chart-profile.test.ts`;
  - chart publication closure tests and fixtures.

The successor suite needs at least:

1. positive exact source-data publication;
2. raster chart with no numeric source -> zero points + partial publication;
3. exact data known but inaccessible -> structured user-help request;
4. hostile estimate labeled accepted/corrected -> deterministic rejection;
5. exact table measurements retained when chart points are skipped.

## Parallel ownership rule

The prompt/policy branch owns only:

- `server/src/agent/phase1-prompt.ts`;
- `.pi/skills/pubmed/SKILL.md`;
- `.pi/skills/extract_chart_data_vlm/SKILL.md`;
- ADR/current architecture/TODO documentation;
- prompt/skill manifest tests.

Parallel implementation/removal agents should own runtime/contracts/frontend/
evaluator files listed above and avoid the prompt/policy files until this branch
is integrated. Do not remove VLM figure/series discovery, locators, axis/legend
error detection, or its provenance kind. Rebase on the integrated policy commit
before final validation.
