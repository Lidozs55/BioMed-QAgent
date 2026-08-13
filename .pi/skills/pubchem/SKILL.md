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

- **Research-only source.** PubChem data is for investigation and evidence
  only — never declare `pubchem` as a dataset build source.
