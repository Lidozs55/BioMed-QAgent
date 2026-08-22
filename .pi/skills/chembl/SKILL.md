---
name: chembl
description: Search ChEMBL for controlled identifiers, then use the fixed Core provider for formal bioactivity builds.
---

# ChEMBL discovery

Query ChEMBL with `search_chembl` using a free-text search string.

## When to use

- Finding molecules (ChEMBL id, preferred name, molecule type, max phase) for
  research questions about compounds and drug discovery.

## Constraints

- `search_chembl` output is discovery evidence only and is never itself a build carrier.
- For a formal bioactivity measurement build, use discovered controlled IDs only. In a static build use a binding with `source="chembl"`, `adapter_id="bioactivity.chembl_json.v1"`, and builtin `provider_id="chembl.files.v1"`; omit `source_files`. In submit_dynamic_family_build, put the equivalent fixed provider and parameters under acquisition-requests. Dataset Core must refetch, register, and provenance-bind the immutable API response. Do not download/search the registered file from the Agent Workspace.
- The normalized dynamic bioactivity topology is generic, not case-specific: target-records, compound-records, assay-records, primary activity-records, and compound-crosswalk; relate each activity many-to-one to target, compound, and assay. Use machine row granularity activity-measurement (not prose). PubChem fixed acquisition accepts one CID per binding, so use one binding/request per compound CID.
- The Core provider requires exactly one real ChEMBL target ID, 1–32 real ChEMBL compound IDs, and controlled activity types (`IC50`, `EC50`, `Ki`, `Kd`) in spec entities. Never invent mutant target IDs; if ChEMBL does not establish a separate target, preserve the variant as context rather than a target identifier.
- Cite the ChEMBL ID or URL for every reported finding.
