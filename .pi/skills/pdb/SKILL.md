---
name: pdb
description: Search, describe, and download protein structures from RCSB PDB.
---

# PDB acquisition

Use `search_pdb` to find structures, `describe_pdb` to inspect metadata, and
`download_pdb` to retrieve PDB or mmCIF files.

## When to use

- Protein structure questions: 3D models, PDB IDs, structural biology data.

## Constraints

- `search_pdb`/`describe_pdb`/`download_pdb` outputs are discovery evidence
  and staging downloads, never themselves build carriers. For a formal Dynamic
  Family input, reacquire one verified PDB ID per binding through Core provider
  `pdb.files.v1` (protein structure carrier).
- Downloads go to the task raw directory and are tracked in provenance; cite
  the PDB ID for every reported structure finding.
