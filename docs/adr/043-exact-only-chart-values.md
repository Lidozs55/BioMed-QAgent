# ADR-043: Formal chart coordinates require explicit numeric sources

## Status

Accepted — 2026-09-02.

## Context

BioMed-QAgent historically allowed a visual model to estimate chart coordinates
from rasterized or rendered paper figures. Those values remained marked
`estimated` and could enter a formal Publication after evidence-bound human
review. Gold6 exposed a scientific-validity gap in that design: a high-resolution
figure can support useful digitization, but it does not expose the author's
original numeric measurements. Human acceptance can confirm that a visual
estimate is reasonable; it cannot recover unpublished values or make the
estimate exact.

For example, PMC5355725 Figure 3C publicly exposes dose-response curves and exact
IC50 summaries in Tables II/III, but no per-dose viability source-data table.
The curve pixels therefore cannot support exact coordinate records. Treating a
non-empty estimated point table as success rewards unsupported precision and
conflicts with the competition's highest-weight requirement, scientific fact
accuracy.

The distinction is general rather than Gold-specific. A formal quantitative
product must separate figure/series discovery from numeric measurement evidence.

## Decision

1. Formal chart-coordinate publication is globally **exact-only**. A chart point
   is admissible only when an explicit numeric token is available and is
   unambiguously bound to the paper, figure, panel, series, dose or condition,
   and measured variable.
2. Admissible numeric sources are:
   - article text or tables;
   - supplementary numeric files;
   - official publisher source-data files;
   - a repository/accession explicitly declared by the paper or its authors;
   - machine-readable numeric payload embedded in an official source when its
     semantic binding is explicit.
3. Raster/vector digitization, chart geometry, unlabeled OCR, interpolation,
   curve fitting, values inferred from summary statistics, and unstated dose
   reconstruction are not exact sources. Human review cannot upgrade them.
4. Source search is bounded and auditable. Inspect article text/tables,
   supplementary files, publisher source-data material, the Data Availability
   statement, and author-declared repositories/accessions. Search tools may
   discover a location; formal values still require a registered official or
   author-declared asset.
5. If no exact point values are found, omit `chart_points` for that figure while
   retaining chart/series locators and the source-search audit. Continue to
   publish independently exact records, such as tabulated IC50 values, when the
   product profile otherwise permits partial coverage.
6. The final report names every skipped figure/panel, states which source classes
   were searched, explains that exact values were not published or found, and
   recommends providing author source data or contacting the authors. When exact
   data are known to exist but are inaccessible, request the specific upload,
   access, or registered carrier needed.
7. Empty chart points under this policy are an honest partial/no-exact-data
   result, not evidence that no chart exists and not an extraction failure.
8. The previous estimated-point publication path is deprecated immediately as a
   product capability. Its code may remain temporarily for compatibility while
   a separate removal migration deletes contracts, HIL behavior, validators,
   tests, and UI. During migration, new tasks may use the extractor only for
   figure/series discovery; they must reject/skip estimated-point review and
   must not bind or publish an estimated carrier.
9. Frozen Gold v1 inputs remain unchanged as historical evaluation evidence. A
   successor evaluation version must encode exact-only success semantics and
   include both a positive source-data case and a correct-abstention case.

## Consequences

### Positive

- Published numeric records mean what users reasonably expect: values explicitly
  supplied by a source, not measurements reverse-engineered from artwork.
- The system can still discover and audit figures without inventing missing data.
- Partial publication preserves exact table values instead of discarding an
  otherwise useful paper.
- Correct abstention becomes testable and reportable.

### Costs and risks

- Some chart-heavy papers will produce no coordinate rows even when their curves
  are visually digitizable.
- Publisher and repository source-data discovery must be supported and recorded;
  PMC-only source allowlists are insufficient for exact-data completeness.
- During the migration window, prompts/skills require any legacy
  estimated-point review to be rejected/skipped and its carrier left unbound,
  while legacy code can still produce it. A Core validation change is required
  to make the policy mechanically fail-closed.
- Existing Gold6 and chart-HIL fixtures encode superseded behavior and cannot be
  used as proof of the new policy.

## Rejected Alternatives

### Keep estimates after human review

Rejected because review can assess a digitization but cannot prove equality to
unpublished author measurements.

### Allow estimates when confidence is high

Rejected because model confidence and image resolution do not change source
semantics.

### Fail the entire paper when chart points are unavailable

Rejected because independently exact table values remain valid and useful.

### Modify frozen Gold v1 in place

Rejected because it destroys hash-based historical comparability. A new
versioned evaluation must supersede it.
