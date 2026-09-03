# Final Report Handoff

> Purpose: give the next agent a short, evidence-oriented route to the final paper/report for the Gold evaluation work. This is a navigation and usage document, not a replacement for the dated evidence reports.
>
> Current branch: `dev`  
> Last verified report merge: `9ca5b53b`  
> Main campaign product commit: `e5aadfe0c46dacddda9464656c551bea0e203ba3`

## 1. Start Here

Read these files in this order:

1. [`docs/evaluation/gold6-10-2026-09-03/report.md`](gold6-10-2026-09-03/report.md)
   - The primary six-run result.
   - Use it for the main table, terminal outcomes, event-derived wall times, token totals, tool counts, HIL counts, Publication IDs, and the Gold9 route discussion.
   - It links to six run-level reports with more detailed counters and evidence references.

2. [`docs/evaluation/gold6-10-2026-09-03/results.json`](gold6-10-2026-09-03/results.json)
   - The machine-readable source for numbers in the primary report.
   - Use fields under `primary_cohort`, `runs`, `gold9_cross_route`, `diagnostics_excluded_from_primary`, and `qoder_gold6_offline_2x2`.
   - Do not hand-copy numbers from raw logs when the same value is present here.

3. [`docs/evaluation/gold6-qoder-2x2/report.md`](gold6-qoder-2x2/report.md)
   - The independent Gold6 Qoder Flash/Max offline 2x2 analysis.
   - It is a separate evidence product, not a BioMed-QAgent Publication and not part of the six-run publication success rate.
   - Use it for the X/Y definitions, threshold policy, field crosswalk, measured limitations, and the Flash/Max placement.

4. [`docs/evaluation/gold6-qoder-2x2/report.json`](gold6-qoder-2x2/report.json)
   - The complete structured 2x2 analysis, including per-axis scores and supporting counts.
   - Use this instead of inventing scores from file counts or narrative impressions.

5. `docs/ARCHITECTURE.md` and the linked topic chapters
   - Use these to explain why Agent work is proposal/discovery while Dataset Core owns deterministic validation, B3, ProductAssessment, and Publication.
   - The architecture is the authority for current system behavior; dated evaluation reports are snapshots of observed runs.

6. `docs/FEATURES.md`
   - Use for product capability language and the current feature surface.
   - Do not use it as evidence for a particular Gold run unless it links to a dated evidence artifact.

## 2. What the Final Report Should Say

The final report should separate four layers:

1. **System contribution**
   - Natural-language request to Agent proposal, then to a deterministic Dataset Core pipeline.
   - Core-owned acquisition, parsing, canonicalization, compatibility checks, integration, validation, ProductAssessment, and atomic Publication.
   - Durable Task/Run/Event state and evidence-bound artifacts.
   - Explicit fail-closed behavior for invalid family, granularity, provenance, or publication conditions.

2. **Primary Gold results**
   - The six-run cohort is exactly:
     - Gold6 Flash
     - Gold7 Flash
     - Gold8 Flash
     - Gold9 Flash
     - Gold10 Flash
     - Gold6 Max v2
   - Five runs reached `succeeded_publication`; Gold10 reached valid `blocked_no_publication`.
   - State the 5/6 result as an observed outcome over heterogeneous requirements, not as a controlled model-quality benchmark.
   - Gold6 Max v2 is the corrected run with 1,000,000 context tokens and 32,768 maximum output. Gold6 Max v1 is not a primary result.

3. **Independent offline 2x2**
   - Qoder Flash: X=0.950, Y=0.808, Q1 high-coverage/high-auditability.
   - Qoder Max: X=0.500, Y=0.758, borderline on X and high on Y; do not force it into a quadrant.
   - Coverage must not be equated with credibility. The report's major caveats are missing raw payloads/scripts, Flash manifest weaknesses, and Max's coarse provenance granularity.

4. **Limitations and diagnostic evidence**
   - Prompt provenance differs across Golds.
   - Gold6 Flash/Max share Gold6 lineage but Max v2 also changes context metadata and host conditions.
   - Gold7, Gold8, and Gold10 use reconstructed historical prompts.
   - Gold9 uses the exact original `run_queued.input` recovered from durable events.
   - Gold9 proxy and dynamic-first are causal diagnostics, not additional primary trials.
   - Invalid-profile runs and Max v1 diagnose infrastructure/configuration failures and must not enter success rates or aggregate totals.

## 3. Primary Evidence Map

### 3.1 Campaign-level inputs

Primary campaign root:

```text
data/gold-campaigns/2026-09-03-main-e5aadfe0-qwen38-six-run-corrected/
```

Use:

- `campaign.json`: campaign identity, product commit, model profile, and campaign-level provenance.
- `prompts/gold6.txt` through `prompts/gold10.txt`: corrected campaign prompt files. Gold6 is the exact-data lineage prompt; Gold7/8/10 are reconstructed historical prompts; Gold9's report must continue to use the exact durable-event input provenance stated in the derived report.
- `campaign/README.md`: campaign-specific operational notes and file organization.
- `preflight/`: creation order, model settings, health snapshots, task snapshots, concurrency plan, and other operational evidence. Use only when explaining setup or ordering; do not use a preflight snapshot to override a run's authoritative event/closure evidence.

The campaign data is local evidence input and is intentionally not committed. Do not add raw campaign files to the final report commit.

### 3.2 Per-run evidence

For each principal run, the normal evidence shape is:

```text
<run-root>/run.json
<run-root>/evidence/closure.json
<run-root>/evidence/detailed-metrics.json
<run-root>/evidence/events.jsonl
<run-root>/evidence/evidence-manifest.sha256
<run-root>/independent-audit.json          # when present
<run-root>/independent-audit.md            # when present
```

The run root is not always at the same depth. Gold6 Max v2 is under:

```text
.../proxy-rerun/runs/gold6-max-v2/
```

Important rules:

- `run.json` is at the run root, not normally under `evidence/`.
- Verify each evidence manifest from the base directory implied by that manifest. Do not assume one universal manifest layout.
- Use `closure.json` for terminal classification, Publication and formal artifact receipts.
- Use `detailed-metrics.json` for schema-specific supporting metrics and reconciliation notes.
- Use the authoritative event archive selected by the generator, not a monitor log, for lifecycle timing and event-derived counters.
- Do not embed raw event JSONL, assistant deltas, tool arguments, tool outputs, or raw error messages in the paper.

### 3.3 Authoritative event-source exceptions

The derived report generator handles the known exceptions:

- Gold6 Flash uses the archived authoritative event stream when available.
- Gold9 uses `evidence/archive/authoritative/task-events.jsonl` as the run-bounded authoritative archive. The runtime file contains one later `permission_resolved` event after `run_completed`; this suffix is recorded as an audit note and must not change the main run duration or counts.
- Gold6 Max v2 uses `evidence/events-api-refetch.jsonl`. It is compared with the durable runtime stream by canonical JSON object sequence. The supervisor journal can miss terminal-neighbor events because of polling/page races; this is why the API-refetch archive is preferred.
- Other principal runs use their evidence `events.jsonl` according to the explicit run specification in the generator.

## 4. Reproduce the Derived Six-Run Report

The generator is committed at:

```text
scripts/generate-gold6-10-session-report.mjs
```

Run it from the repository root:

```bash
node scripts/generate-gold6-10-session-report.mjs \
  --campaign-root /home/modenicheng/coding/BioMed-QAgent/data/gold-campaigns/2026-09-03-main-e5aadfe0-qwen38-six-run-corrected \
  --output-dir docs/evaluation/gold6-10-2026-09-03
```

The generator is standard-library-only and writes:

- `report.md`: campaign-level narrative and tables.
- `results.json`: structured results and diagnostics.
- `processed-log.jsonl`: normalized, redacted event summaries.
- `runs/*.md`: one report per principal run.
- `evidence-manifest.sha256`: SHA-256 list for the derived outputs.

The generator also checks:

- JSON and JSONL parsing.
- Evidence-manifest verification for each principal run.
- Event sequence contiguity.
- Event-derived lifecycle timing.
- Token totals against closure usage.
- Tool pairing and operation summaries.
- Formal artifact receipt hashes.
- Gold6 Max v2 API-refetch/runtime object-stream consistency.
- Credential-like patterns in generated outputs.

The generator is an evidence reader. It does not start a Host, create a Task, submit a Run, modify settings, or contact external providers.

After regeneration:

```bash
node --check scripts/generate-gold6-10-session-report.mjs
sha256sum -c docs/evaluation/gold6-10-2026-09-03/evidence-manifest.sha256
node -e "const fs=require('fs'); JSON.parse(fs.readFileSync('docs/evaluation/gold6-10-2026-09-03/results.json')); for (const line of fs.readFileSync('docs/evaluation/gold6-10-2026-09-03/processed-log.jsonl','utf8').split(/\\n/)) if (line) JSON.parse(line); console.log('JSON/JSONL OK')"
git diff --check
```

## 5. Diagnostic Evidence: Include as Appendix Only

Diagnostic roots are under the corrected campaign's `proxy-rerun/` and the neighboring invalid-profile campaign:

```text
.../2026-09-03-main-e5aadfe0-qwen38-six-run-corrected/proxy-rerun/
.../2026-09-03-main-e5aadfe0-qwen38-six-run/
```

Use the derived `results.json.diagnostics_excluded_from_primary` first. The intended interpretation is:

| Diagnostic | Use | Do not do |
| --- | --- | --- |
| Initial invalid-profile batch | Explain provider HTTP 400 caused by incoherent reasoning/thinking configuration; zero useful work | Do not count as failed scientific Gold output or add to the denominator |
| Gold6 Max v1 | Explain 100,000-token metadata and ineffective compaction; motivate v2 correction | Do not compare v1's failure against Flash as a model result |
| Gold9 frozen/proxy | Show that successful acquisition alone did not bypass static-family deterministic validation | Do not call it a replication of the direct run |
| Gold9 dynamic-first | Show that a prompt directive cannot create an unavailable registered dynamic profile | Do not treat it as a frozen prompt or like-for-like quality run |

For Gold9, distinguish evidence levels:

- **Proven:** durable route update after dynamic-family preparation, subsequent publication events, proxy static route, deterministic rejection codes, and dynamic profile scaffold rejection.
- **Strongly supported:** acquisition/network success was insufficient to produce a valid static publication.
- **Unproven:** a model-level causal explanation for why the original run selected the eventual dynamic route.

## 6. How to Use the Other Documentation

| Document | Use in the final report | Avoid |
| --- | --- | --- |
| `docs/ARCHITECTURE.md` | Current system boundary, Agent/Core split, durable runtime, publication ownership | Treating architecture prose as proof that a particular run succeeded |
| `docs/architecture/dataset-execution.md` | Deterministic operation sequence and Core execution constraints | Replacing run evidence with generic pipeline claims |
| `docs/architecture/canonical-evidence.md` | Publication/evidence product concepts, provenance and artifact roles | Calling workspace staging files formal outputs |
| `docs/architecture/runtime-events.md` | Event-sourcing, replay, lifecycle and durable evidence semantics | Assuming monitor output is authoritative when event archives disagree |
| `docs/architecture/chart-exact-data-policy.md` | Exact-only chart policy and why estimated image points cannot be promoted | Describing historical estimated-point compatibility tests as current production behavior |
| `docs/adr/043-exact-only-chart-values.md` | Decision authority for the exact-only chart boundary | Reviving the superseded image-estimate acceptance path |
| `docs/architecture/hil-approval-policy.md` | Human/LLM/auto approval policy language | Inferring HIL counts without the run evidence |
| `docs/FEATURES.md` | Product-facing capability summary | Using it as a dated benchmark record |
| `docs/TODO.md` | Open work, known gaps, and current priorities | Presenting open TODO items as completed capabilities |
| `docs/ISSUES.md` | Known unresolved defects and operational limitations | Treating old or closed issue text as current run evidence |
| `docs/reports/2026-08-30-gold6-live-analysis.md` | Gold6 repair/history context before the corrected campaign | Using R1-R4 historical blockers as the corrected Gold6 result |
| `docs/reports/2026-09-03-gold6-r7c3-artifact-inventory.md` | Historical Gold6 R7c3 artifact and exact-table extraction context | Merging R7c3 into the six-run corrected campaign statistics |
| `docs/reports/gold789-case-chapter.md` | Earlier case-study narrative and domain context | Overriding corrected campaign values without checking current evidence |
| `docs/reports/2026-08-29-gold-qwen-direct-validation-study.md` | Earlier model/route observations and limitations | Treating pre-campaign observations as the corrected six-run cohort |
| `docs/evaluation/model-blockers.md` | Categorizing model and interface failure modes | Counting blocker inventory as a run outcome |
| `docs/evaluation/triage.md` | Mapping known issues to product/prompt/interface causes | Treating triage labels as causal proof |
| `docs/audit/README.md` | How dated audit snapshots are organized | Assuming audit snapshots automatically update with `dev` |
| `docs/README.md` | Document lifecycle and authority rules | Adding another duplicate report index |

Historical material under `docs/archive/` and `docs/migration/` is for explicit history questions only. It is not current behavior evidence.

## 7. Writing Order for the Final Paper

Use this order to keep claims aligned with evidence:

1. State the research/evaluation question and the system contribution from the architecture documents.
2. Define the evidence boundary: durable events, closure, manifest, formal artifact receipts, and exact-only chart policy.
3. Describe the corrected six-run cohort and prompt provenance before showing any aggregate number.
4. Present the six-run primary table from `gold6-10-2026-09-03/report.md` and `results.json`.
5. Add per-run case subsections using the six linked run reports.
6. Explain Gold9's three-route diagnostic comparison with proven/strongly-supported/unproven labels.
7. Present the independent Qoder 2x2 with its own inputs, scores, and limitations.
8. Add diagnostic appendices for invalid profile, Max v1, proxy, and dynamic-first.
9. End with limitations, open TODO items, and the distinction between observed outcome, reproducible evidence, and causal interpretation.

Do not create a single model ranking from the six-run table. The runs differ in task, prompt provenance, route availability, host conditions, HIL exposure, and (for Max v2) corrected context metadata.

## 8. Final Integrity Checklist

Before merging the final paper/report:

- [ ] Every primary number appears in `results.json` or a cited run-level evidence file.
- [ ] The six-run denominator is exactly six and excludes diagnostics.
- [ ] Gold8 uses `2754.172 s`, not the inconsistent monitor value `2174.166 s`.
- [ ] Gold9's missing publication field in the final `run_completed` payload is not misread as no publication; closure/publication evidence confirms success.
- [ ] Gold6 Max v2 is used; Gold6 Max v1 is appendix-only.
- [ ] The Qoder 2x2 is labeled offline and non-Publication.
- [ ] Max's X=0.500 is labeled borderline, not forced into a quadrant.
- [ ] Exact-only chart policy is described as current; estimated-point compatibility paths are historical/superseded.
- [ ] No raw event log, assistant delta, tool argument, tool output, credential, or original campaign is committed.
- [ ] All report links resolve and all included SHA-256 manifests pass.
- [ ] `git diff --check` and credential-pattern scanning pass.
- [ ] The final report states what is observed, what is reproducible, what is only strongly supported, and what remains unproven.
