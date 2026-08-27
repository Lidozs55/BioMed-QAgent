---
name: research_data_guidance
description: Load topic-specific research-data strategy and SOP guidance (data-source selection, cleaning, analyzability, provenance).
---

# Research-data strategy guidance

When a research-data task requires strategy, data-source selection, cleaning,
or analyzability decisions, load the relevant topic with
`get_research_data_guidance`. Read **only** the topic(s) the current task
needs — do not load the whole set. When unsure, start with the strategy
(routing table) topic.

## Topics

- strategy — research question → data sources and study design (grouping /
  pairing adequacy, evidence paths).
- expression_omics — expression/omics acquisition (RNA-seq vs microarray,
  gene-level vs probe-level).
- clinical — clinical / EHR / trial data.
- structure_pathway_compound — PDB / Reactome / PubChem (research-only).
- cleaning — entity mapping, units/semantics/scale, analyzability judgment.
- reproducibility — provenance, multi-source integration consistency,
  publication/replication.

## Coverage gate

Querying only 1-2 data sources severely underestimates coverage. Before
building, state explicitly: sources queried, and topic-relevant sources not
queried (or "none").

## Formal-build gate (dataset requests)

When the request asks for an integrated dataset/tables, discovery research is
only phase one. As soon as `inspect_dataset_execution_routes` shows a static
family covering the product, switch to
`validate_dataset_execution` -> `execute_dataset_execution` with a spec whose
`entities` carry the phenotype/study context. Workspace CSVs, literature
summaries, and downloads are staging: the task is finished only by a Dataset
Core Publication or an explicit structured NO_DATA - never by staging files
alone.
