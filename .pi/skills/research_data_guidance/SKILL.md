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
