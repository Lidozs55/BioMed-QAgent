---
name: uniprot
description: Search the UniProt knowledgebase for protein entries (research-only; findings never route into dataset builds).
---

# UniProt discovery

Query UniProt with `search_uniprot` using a free-text search string.

## When to use

- Finding protein entries (accession, protein name, gene, organism, reviewed
  flag) to ground gene/protein terminology during research planning.

## Constraints

- **Research-only source.** UniProt findings are for investigation and
  evidence only — never declare `uniprot` as a dataset build source, and never
  route its results into `execute_dataset_build`.
- Cite the UniProt accession or URL for every reported finding.
