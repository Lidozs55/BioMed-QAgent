# R4a — Publication core implementation report

## Status

- Result: implemented on `codex/agent-runtime-concurrency-merge` from base
  `4737483`.
- Scope: one locked, rollback-safe publication core and run-specific Pipeline
  staging only.
- Explicitly deferred to R4b: Agent Tool managed-publication selection,
  `RunContext`/`RunExecution` completion ownership, and abort/discard handles.

## Implementation

- Consolidated production `publish_artifacts` and compatibility
  `_publish_artifacts` onto `_publish_artifacts_core`; the wrapper contains no
  filesystem mutation logic of its own.
- The OS-backed `TaskLock(state/publish.lock)` now encloses:
  - managed `.runtime-publication.json` construction and verification;
  - staging-file fsync;
  - prior `artifacts/` and `state/publish_completed.json` backup;
  - candidate rename into `artifacts/`;
  - post-rename cancellation check;
  - durable `publish_completed.json` write;
  - rollback and backup/temp cleanup.
- Managed runtime markers contain schema version, task ID, run ID, and the
  current `run_manifest.json` SHA-256. The marker is written, parsed back,
  compared with the expected payload, and checked against a second manifest
  hash while the lock is held; it then moves with the staging directory.
- Any pre-commit exception or cancellation moves the candidate back to its
  original staging path and restores the prior artifacts and state marker.
  The rollback regression checks every prior artifact byte, including the old
  runtime marker, and verifies that no `.previous-*` backup or `.json.part`
  file remains.
- Backup/temp cleanup is retried inside the lock and is non-fatal after the
  state marker commits, so a cleanup error cannot turn an already committed
  publication into a reported failure.
- `PipelineRunner` and `StageContext` now carry a workdir-validated safe
  `run_id`. Artifact Build writes `staging/<run_id>/`.
- Artifact Build and Validation parameter digests include `run_id`, preventing
  a recovered second Run from reusing an earlier Run's `ArtifactBuildOutput`
  or staging path.
- `PipelineRunner.publish(run_id)` requires the publish identity to equal the
  constructor identity before delegating to the shared core. This prevents
  `staging/run_A` from being committed with a `run_B` marker.
- `FixtureRunExecutor` passes `execution.run_id` into `PipelineRunner`.
  Standalone callers use the explicit safe ID `run_standalone`.
- Immediate Validation publication still calls the same core without a
  managed runtime marker.

## TDD evidence

### Real `PipelineRunner.publish` lock path

RED before production publication acquired `state/publish.lock`:

```text
FAILED test_pipeline_runner_publish_waits_for_publish_lock
AssertionError: PipelineRunner.publish() bypassed state/publish.lock
1 failed in 0.58s
```

GREEN after moving managed marker generation and publication into the shared
locked core:

```text
1 passed in 0.66s
```

### Post-rename marker-write rollback

RED with old artifacts/runtime marker and an injected
`publish_completed.json.part` write failure after the candidate rename:

```text
FAILED test_publish_marker_write_failure_restores_previous_package
assert restored_files == old_files
1 failed in 0.62s
```

GREEN after candidate restoration plus artifact/state-marker rollback:

```text
1 passed in 0.48s
```

### Run-specific staging and recovery cache isolation

RED before `PipelineRunner` accepted a run identity:

```text
TypeError: PipelineRunner.__init__() got an unexpected keyword argument 'run_id'
1 failed in 0.41s
```

GREEN after threading `run_id` through `StageContext` and adding it to the
Artifact Build/Validation parameter digests:

```text
1 passed in 0.61s
```

The regression runs two deferred runners for one task and requires both
`staging/run_distinct_staging_one/` and
`staging/run_distinct_staging_two/` to survive independently.

### Publish/staging identity consistency

RED before `publish(run_id)` checked the constructor identity:

```text
Failed: DID NOT RAISE ValueError
1 failed in 0.70s
```

GREEN:

```text
1 passed in 0.48s
```

### Fixture executor propagation

RED before `FixtureRunExecutor` passed `execution.run_id`:

```text
ValueError: publish run_id must match the PipelineRunner run_id
snapshot.task.status was failed instead of completed
1 failed in 2.45s
```

GREEN after the real fixture path recorded the accepted Run ID in the Artifact
Build checkpoint:

```text
1 passed in 2.18s
```

### Explicit standalone identity

RED while standalone staging still used the former pinned-fixture name:

```text
assert staging/run_standalone/run_manifest.json is_file()
1 failed in 0.61s
```

GREEN after introducing `STANDALONE_RUN_ID = "run_standalone"`:

```text
1 passed in 0.53s
```

### Post-commit cleanup failure

Review found that a transient backup cleanup error could raise after the new
package and state marker were already committed.

RED:

```text
OSError: transient backup cleanup failure
1 failed in 0.87s
```

GREEN after retrying cleanup and making post-commit cleanup non-fatal:

```text
1 passed in 1.27s
```

## Final verification

Requested focused suites:

```text
backend\.venv\Scripts\python.exe -m pytest \
  tests/pipeline/test_publish_lock.py \
  tests/pipeline/test_pipeline_runner_resilience.py \
  tests/pipeline/test_pipeline_runner_recovery.py \
  tests/pipeline/test_pipeline_e2e.py \
  tests/runtime/test_fixture_executor.py -q

69 passed in 26.31s
```

Full Ruff gate:

```text
backend\.venv\Scripts\python.exe -m ruff check app/ tests/ launcher.py
All checks passed!
```

Full non-live backend suite:

```text
backend\.venv\Scripts\python.exe -m pytest -q
812 passed, 18 deselected in 75.24s
```

## Self-review

- Every changed production line maps to the R4a brief; no Agent completion or
  abort ownership was introduced.
- The real deferred publication path, not only the compatibility helper, is
  lock-tested.
- Runtime marker creation occurs only after acquiring the shared lock.
- Immediate standalone publication remains marker-free and uses the same
  mutation core.
- A second managed Run cannot reuse or overwrite another Run's staging path,
  including checkpoint recovery.
- Successful rollback removes transient backups; a post-commit cleanup error
  cannot misreport an irreversible commit as failed.
