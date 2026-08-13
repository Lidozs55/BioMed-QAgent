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

- **Research-only source.** PDB data is for investigation and evidence only —
  never declare `pdb` as a dataset build source.
- Downloads go to the task raw directory and are tracked in provenance; cite
  the PDB ID for every reported structure finding.
