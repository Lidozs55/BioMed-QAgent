---
name: chembl
description: Search the ChEMBL database for molecules (research-only; findings never route into dataset builds).
---

# ChEMBL discovery

Query ChEMBL with `search_chembl` using a free-text search string.

## When to use

- Finding molecules (ChEMBL id, preferred name, molecule type, max phase) for
  research questions about compounds and drug discovery.

## Constraints

- **Research-only source.** ChEMBL findings are for investigation and evidence
  only — never declare `chembl` as a dataset build source, and never route its
  results into `execute_dataset_build`.
- Cite the ChEMBL id or URL for every reported finding.
