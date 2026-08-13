---
name: analysis
description: Statistical analysis and visualization for tabular biomedical data (differential expression, heatmaps, correlation).
---

# Statistical analysis

Use the analysis tools to perform statistical computations and generate
publication-quality visualizations on CSV datasets.

## Tools

- `run_differential_expression` — log2 fold-changes and Benjamini-Hochberg
  FDR-adjusted p-values between two sample groups, with a volcano plot.
- `generate_heatmap` — clustered heatmaps with optional z-score normalization.
- `basic_statistics` — per-column descriptive stats (mean/median/std/min/max/
  missing counts).
- `generate_correlation_matrix` — Pearson or Spearman correlation between
  numeric columns, rendered as a heatmap.

## Constraints

- Outputs (PNGs, CSVs) go to the task artifacts directory as analysis
  material; formal dataset publications still come only from
  `execute_dataset_build`.
- Verify input row counts and group assignments before running; report the
  statistical method and adjustment used with every result.
