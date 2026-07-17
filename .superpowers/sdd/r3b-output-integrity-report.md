# R3b — Persisted output integrity report

## Status

- Result: implemented on `codex/agent-runtime-concurrency-merge` from base
  `f08503c`.
- Scope: versioned stage-output checkpoints, referenced-file integrity, and
  the approved reuse/publication lifecycle only. Publication locking,
  Pipeline Tool behavior, and `RunContext` ownership were not changed.

## Implementation

- Persisted every stage output in a required-version envelope bound to the
  task, stage, successful stage-attempt ID, semantic output digest, canonical
  serialized-output SHA-256, typed serialized output, and a sorted unique file
  manifest.
- Recovery selects the newest matching successful attempt, requires the
  `completed_stages` digest to match, validates the envelope and typed output,
  and treats all checkpoint parsing or integrity failures as cache misses.
- Each manifest file is resolved beneath the task root and must remain a
  non-symlink regular file with the recorded size and SHA-256.
- File enumeration is explicit by stage:
  - Discovery: no files.
  - Acquisition: every `SourceAsset`; `source_path` must alias one of them.
  - Processing: every `ParsedDataset.file_asset`.
  - Artifact Build: exact direct staging files plus durable source assets;
    staging contents must match `artifact_paths` exactly.
  - Validation: physical staging-or-artifacts manifest files, the physical
    `run_manifest.json`, and `logs/validation_report.json`. Publication marker
    files are intentionally excluded.
- Removed the unverified `_get_output` disk fallback. Downstream stages consume
  only outputs verified or produced in the current run.
- Added a run-local reuse barrier: after the first executed stage, later stages
  execute even if their prior digests still match.
- After normal publication, Discovery, Acquisition, and Processing can skip;
  Artifact Build and Validation rerun. Deferred runs never reuse Validation,
  reconstruct `_pending_publication`, and can publish from a recovered runner.

## TDD evidence

### Invalid or legacy output checkpoints

The first parameterized regression covered invalid JSON, legacy raw output,
wrong semantic output digest, and wrong canonical-output hash.

RED:

```text
FFFF
invalid JSON: expected COMPLETED, got FAILED
legacy raw / wrong output_digest / wrong output_sha256:
expected SUCCEEDED attempt 2, got SKIPPED
4 failed in 1.05s
```

GREEN after the envelope loader/save path:

```text
4 passed in 1.44s
```

A later strict-version regression proved that an omitted envelope version was
also being accepted through the inherited default.

RED:

```text
expected SUCCEEDED attempt 2, got SKIPPED
1 failed in 1.11s
```

GREEN after making the envelope version required, including wrong-version
coverage:

```text
6 passed in 2.45s
```

### Processing file integrity

The processing regression deleted the parsed file, appended one byte, and
changed one byte while preserving the exact original length. The equal-size
case can only be detected by SHA-256.

RED:

```text
expected SUCCEEDED attempt 2, got SKIPPED
3 failed in 0.98s
```

GREEN after file-manifest verification:

```text
3 passed in 0.83s
```

### Normal publication reuse barrier

RED before Artifact Build staging verification and the run-local barrier:

```text
expected skips [Discovery, Acquisition, Processing]
got five skipped stages
1 failed in 0.62s
```

GREEN:

```text
1 passed in 0.59s
```

The R3a monotonic-number and skipped-status assertions were updated without
changing their numbering guarantees: all stages remain attempts 1, 2, 3;
only the second Artifact Build and Validation attempts change from SKIPPED to
SUCCEEDED.

### Deferred publication recovery

The deferred lifecycle regression first found that Validation persisted no
physical file manifest.

RED:

```text
checkpoint files: []
expected 15 staging/report files
1 failed in 0.81s
```

After explicit Validation enumeration, the test was strengthened to begin with
an already published package. That exposed stale-artifact preference over the
current deferred staging package.

RED:

```text
expected deferred manifest COMPLETED, got FAILED
1 failed in 0.98s
```

GREEN after preferring the current staging package and falling back to
artifacts only when staging is absent:

```text
1 passed in 0.79s
```

The recovered deferred runner executes Validation again and successfully
calls `publish(run_id)` with the reconstructed pending staging directory.

## Verification

From `backend/`:

```text
uv run pytest tests/pipeline/test_pipeline_runner_recovery.py tests/pipeline/test_pipeline_runner_state_machine.py tests/pipeline/test_pipeline_runner_resilience.py tests/pipeline/test_pipeline_e2e.py tests/runtime/test_fixture_executor.py -q
55 passed in 19.23s
```

```text
uv run pytest tests/pipeline/test_pinned_pipeline.py tests/integration/test_gse178352_fixture.py -q
10 passed in 0.62s
```

The first full-suite run found one stale event-coverage expectation that still
assumed five skipped stages (`803 passed, 1 failed, 18 deselected`). After
updating it to expect Tool events only for Artifact Build and Validation, the
fresh full run was:

```text
uv run pytest -q
804 passed, 18 deselected in 76.92s
```

```text
uv run ruff check app/ tests/ launcher.py
All checks passed!
```

## Self-review and concerns

- Cache validation is fail-closed for reuse but fail-open for execution:
  malformed JSON, schema mismatches, unsafe paths, type errors, missing files,
  and checksum mismatches all return a cache miss rather than failing the task
  inside the loader.
- Artifact Build and Validation reruns after publication are intentional. The
  staging directory is either mutated by Validation or moved by publication,
  so its earlier checkpoint cannot prove the current package.
- Full file SHA-256 verification adds read cost on reuse. This is required by
  the approved integrity contract and is bounded by the explicit stage file
  manifests; no recursive path discovery was added.
- No known correctness blockers remain in the implemented R3b scope.

## Task-review follow-up: Validation semantic completeness

Task review found that the first R3b implementation treated the top-level
`ValidationOutput.artifacts` list as authoritative without proving it matched
the nested `RunManifest` or the physical `run_manifest.json`.

### Self-consistent envelope divergence

The first regression created schema-valid Artifact Build and Validation
envelopes whose hashes and file records were internally consistent. It removed
one top-level Validation artifact and its corresponding envelope file record,
while leaving both the nested manifest and physical manifest unchanged.

RED:

```text
expected Validation stage call count 1, got 0 (checkpoint was SKIPPED)
1 failed in 0.71s
```

GREEN after making the nested manifest authoritative and requiring exact
top-level artifact and validation-summary equality:

```text
1 passed in 4.99s
```

### Schema-valid physical manifest divergence

The second regression changed only the physical manifest's
`pipeline_version`, kept it schema-valid, and updated both relevant envelope
file records with its new size and SHA-256. This proved checksum verification
alone could not detect semantic divergence.

RED:

```text
expected Validation stage call count 1, got 0 (checkpoint was SKIPPED)
1 failed in 0.70s
```

GREEN after parsing the physical manifest and requiring exact typed equality
with `ValidationOutput.manifest`:

```text
2 passed in 0.88s
```

Validation reuse now also requires the physical package's direct entries to
equal the manifest artifact names plus `run_manifest.json`. The optional
`.runtime-publication.json` file is the only explicitly allowed non-stage
marker and is excluded from the checkpoint manifest.

Fresh follow-up verification from `backend/`:

```text
uv run pytest tests/pipeline/test_pipeline_runner_recovery.py tests/pipeline/test_pipeline_runner_resilience.py tests/pipeline/test_pipeline_e2e.py -q
39 passed in 14.80s
```

```text
uv run ruff check app/ tests/ launcher.py
All checks passed!
```

No additional correctness concerns were found in the reviewed R3b scope.
