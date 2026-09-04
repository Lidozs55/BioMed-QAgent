# Paper Evidence Audit

This audit records the evidence defects found while reconciling the current LaTeX paper with the local corrected Gold6--10 campaign. It is intentionally conservative: a file hash proves byte identity, not scientific truth; a Publication proves that its declared product passed the configured gate, not that every clause of the original research request was satisfied.

## P0 — Must Be Correct Before Submission

1. **The paper previously described all ten Gold cases as one uniform protocol and called 5/6 a case-level rate.**
   - Affected source: `docs/latex/chapters/ch05-experiments.tex` (experiment protocol and ten-case table).
   - Evidence: Gold1--5 are an earlier batch; the corrected six-run cohort is Gold6--10 Flash plus Gold6 Max v2. Gold6 and Gold9 have exact frozen lineage, while Gold7/8/10 use reconstructed historical prompts.
   - Required treatment: keep the ten-case table as a cross-batch index; calculate 5/6 only over the explicit corrected six-run cohort. It is a run-level rate: six runs cover five unique cases because Gold6 appears twice.

2. **The claimed Gold1/Gold6 2×2×2 “controlled factorial experiment” is not controlled.**
   - Confounders: Qoder receives extra prompt constraints, environments use different default reasoning settings and run drivers, outputs have different formal identities, and every cell is a single run without variance.
   - Required treatment: call these eight observation cells a layered comparison; prohibit causal attribution to “environment mechanisms.”

3. **Gold6 Qoder wall-time/token values lack a committed evidence anchor.**
   - Old paper values: Flash 175 min / 67.912M tokens; Max 46 min / 5.160M tokens.
   - Current committed Gold6 Qoder evidence: `docs/evaluation/gold6-qoder-2x2/` contains offline output zips' structured audit but no platform time/usage export.
   - Required treatment: omit those values unless a separate platform record is frozen, hashed and documented. The current offline audit supports only X/Y artifact analysis.

4. **“SHA-256 passes” was repeatedly equated with “truthfulness passes.”**
   - SHA-256/MD5 checks establish file integrity and receipt binding. They do not prove source values, scientific correctness, or complete coverage.
   - Required treatment: use “byte integrity,” “receipt match,” and “evidence auditability”; reserve truthfulness claims for source-level value verification with a bounded sampling protocol.

5. **Gold6 was mislabeled as a four-table product.**
   - Current Publication: six CSV tables (`activity_value_records`, `paper_records`, `experiment_records`, `supplementary_asset_records`, `chart_series`, `chart_points`) plus schema, provenance and ProductAssessment = nine formal artifacts.
   - Required treatment: use “six CSV tables / nine artifacts.”

6. **Gold7's current publication topology was wrong.**
   - Current corrected run: risk-loci and variant-gene-map are two independent Publications, five artifacts each. Both publication events have `supersedes_publication_id=null`.
   - Unsupported old claims: one three-table Publication; Gold7 v1→v2 supersedes chain; 11 reject/revise rounds in the corrected run.
   - Required treatment: describe two independent Publications. If historical 11-round behavior is retained, cite and label the separate historical run, not the corrected cohort.

7. **Gold9's current run was conflated with historical recovery narratives.**
   - Proven: durable semantic route changed from static to `dynamic_family` after successful dynamic preparation; v1 and v2 publication events followed; v2 became current.
   - Not proven by this run: a formal supersedes chain (both events have `supersedes_publication_id=null`); Dataset Core checkpoint replay after an interrupted computation; a model-level causal reason for route selection.
   - Required treatment: separate proven event order, strongly supported interpretation, and unproven causality.

8. **Gold8 success was presented as full multi-source task completion.**
   - Current formal Publication: openFDA FAERS assertion + study tables and metadata artifacts. The run report states that only one of three evidence dimensions was formally published; other integration tables remained staging.
   - Required treatment: retain `succeeded_publication` as the runtime terminal, but disclose partial scientific-request coverage.

9. **Gold10 was rhetorically converted from task failure into success.**
   - Proven: `blocked_no_publication`, zero formal artifacts, two deterministic execution rejections caused by empty required tables, and the required differential-abundance supplement was not formally acquired/parsed.
   - Required treatment: call it task-level non-completion and a fail-closed safety observation. Keep it in the six-run outcome denominator; exclude it from Publication artifact-quality comparisons.

## P1 — Strongly Recommended

1. **Gold1--5 evidence is not at the same audit level as Gold6--10.**
   - Their row counts, timings, token totals, “no HIL” statement, and double-review quality scores currently live in paper/history rather than a committed generated report with manifest.
   - Before submission, freeze a structured Gold1--5 evidence report or visibly label those rows as historical summaries not re-audited by the current generator.

2. **The paper's Gold1 quality language remains stronger than its visible evidence.**
   - Statements such as “no fabricated values,” “every row has an asset hash,” and causal explanations for smaller study coverage need a committed reviewer checklist and source-level sampling record.
   - Until then, phrase these as bounded observations and distinguish hash verification from value verification.

3. **Static figures are not generated from the committed structured results.**
   - `fig-gold-cost-overview.pdf` and `fig-gold1-efficiency-comparison.pdf` have no committed generation script/data file.
   - The ten-case figure also mixes historical Gold1--5 with the corrected Gold6--10 cohort.
   - Add a deterministic plotting script or mark figures as manually derived snapshots; regenerate if table values or cohort framing change.

4. **The paper must cite local evidence anchors explicitly.**
   - The source currently mentions `results.json` only in comments. Add a report/evidence availability paragraph or appendix that names the generated report, run reports, campaign commit, and manifest verification method.

5. **Publication counts and artifact counts need consistent terminology.**
   - `artifact_produced` event counts include every Publication emitted during a run; the current Publication artifact count is a different quantity.
   - Use “Publication events / Artifact events” for run history and “current Publication artifacts” for the final package.

## P2 — Presentation and Maintenance

1. Remove stale “待填/框架” comments after the evidence rewrite stabilizes.
2. Prefer exact seconds in the six-run evidence table and rounded minutes only in narrative/figures.
3. Define English technical terms once (`closure`, `lineage`, `locator`, `staging`) or translate them consistently.
4. Keep `docs/evaluation/FINAL_REPORT_HANDOFF.md` synchronized with generator paths and paper-use boundaries.
5. Do not hand-edit files under `docs/evaluation/gold6-10-2026-09-03/`; edit `scripts/generate-gold6-10-session-report.mjs` and regenerate.

## Authoritative Chain

1. Local raw input: `data/gold-campaigns/2026-09-03-main-e5aadfe0-qwen38-six-run-corrected/` (read-only, ignored, never commit).
2. Generator: `scripts/generate-gold6-10-session-report.mjs`.
3. Structured output: `docs/evaluation/gold6-10-2026-09-03/results.json`.
4. Run-level paper boundaries: `docs/evaluation/gold6-10-2026-09-03/runs/*.md`, section `Paper-Use Boundary`.
5. Qoder Gold6 offline audit: `docs/evaluation/gold6-qoder-2x2/`.
6. Final writing guidance: `docs/evaluation/FINAL_REPORT_HANDOFF.md`.

## Verification

```bash
node --check scripts/generate-gold6-10-session-report.mjs
node scripts/generate-gold6-10-session-report.mjs \
  --campaign-root /home/modenicheng/coding/BioMed-QAgent/data/gold-campaigns/2026-09-03-main-e5aadfe0-qwen38-six-run-corrected \
  --output-dir docs/evaluation/gold6-10-2026-09-03
(cd docs/evaluation/gold6-10-2026-09-03 && sha256sum -c evidence-manifest.sha256)
pnpm docs:check
cd docs/latex && uv run python -B /home/modenicheng/.agents/skills/latex-paper-en/scripts/compile.py main.tex
```
