---
name: uniprot
description: Search the UniProt knowledgebase for protein entries (discovery evidence; formal input reacquires through Core provider uniprot.files.v1).
---

# UniProt discovery

Query UniProt with `search_uniprot` using a free-text search string.

## When to use

- Finding protein entries (accession, protein name, gene, organism, reviewed
  flag) to ground gene/protein terminology during research planning.

## Constraints

- `search_uniprot` output is discovery evidence only and is never itself a
  build carrier. For a formal Dynamic Family input, reacquire one verified
  accession per binding through Core provider `uniprot.files.v1` (target
  evidence).
- Cite the UniProt accession or URL for every reported finding.
