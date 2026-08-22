---
name: pubchem
description: Search and fetch chemical compound data from PubChem.
---

# PubChem acquisition

Use `search_pubchem` to find compounds by name (e.g. "aspirin", "curcumin"),
`get_compound` to fetch details by CID (e.g. 2244 for aspirin), and
`download_pubchem` to fetch the full SDF/MOL structure record for a CID.

## When to use

- Questions about compounds, chemical structures, SMILES, molecular formulas,
  or compound properties by CID.

## Failure handling

- API failures automatically fall back to a rendered page preview with bounded
  visible text; treat that preview as degraded evidence, not a full record.

## Constraints

- Search/detail responses are discovery evidence only and are never themselves build carriers.
- For a formal `bioactivity_measurement` compound-identity build, use one verified positive CID in a binding with `source="pubchem"`, `adapter_id="bioactivity.pubchem_identity.v1"`, and builtin `provider_id="pubchem.files.v1"`. Omit `source_files`: Dataset Core must refetch and register the immutable PubChem JSON response.
- PubChem identity is accepted only when its InChIKey exactly matches one ChEMBL compound in the same build; do not infer a crosswalk from names alone.
