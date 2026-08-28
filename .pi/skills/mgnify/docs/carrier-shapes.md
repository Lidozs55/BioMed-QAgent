# Carrier payload shapes (faithful transform decoding reference)

Transform authors must decode these EXACT shapes; never synthesize a field
value that the carrier does not contain. Leave a field empty/absent in the
output row when the carrier lacks it.

## mgnify.files.v1 — study metadata (accession MGYS########)

GET https://www.ebi.ac.uk/metagenomics/api/v1/studies/{MGYS} returns a
JSON:API envelope. The study fields live under `data.attributes`:

- `data.id` = MGYS accession; `data.attributes.accession` (same)
- `data.attributes.bioproject` (e.g. "PRJEB1786")
- `data.attributes["samples-count"]` (integer; note the dash and plural)
- `data.attributes["study-name"]` (title) — use verbatim as study_title
- `data.attributes["study-abstract"]` (summary text)
- `data.attributes["centre-name"]` may be present
Disease annotations are NOT in the payload; they come from spec.entities.

## gmrepo.files.v1 — taxon phenotype prevalence (accession = numeric NCBI taxid)

POST .../getPhenotypesAndAbundanceSummaryOfAAssociatedTaxon/ returns:

- `phenotypes_associated_with_taxon[]`: each entry has `disease` (MeSH id),
  `term` (label), `ncbi_taxon_id`, `taxon_rank_level`, `samples`,
  `all_samples`, `valid_runs`, `abus_mean`, `abus_median`, `abus_sd`,
  `pct_samples` (string percent).
- prevalence = samples / all_samples; reference_group = `gmrepo:{term} ({disease})`.
- Case/control role is a spec-level semantic filter (e.g. D003924 T2D case,
  D006262 Health control); the carrier covers every phenotype cohort.

## ncbi.taxonomy.files.v1 — name resolution (accession = scientific name)

ESearch JSON: `esearchresult.idlist[0]` = resolved numeric taxid,
`esearchresult.querytranslation` = the queried name. Rows produced from this
carrier are RESOLUTION REFERENCES (abundance 0), not abundance measurements.

## europepmc supplementary ZIP extraction (accession PMCID########)

acquire_core_carrier returns `extraction_assets[]`: xlsx members are already
converted to CSV text (`media_type text/csv`). Reference one member asset id
as a dynamic registered source; the transform receives UTF-8 CSV text.
