/**
 * Phase 4 step 10 (checkpoint/retry/cancel) parity checks: the fixed build
 * skeleton plan, digest-matched idempotent reuse, cooperative cancellation,
 * inflight recovery and append-only attempt-log validation (mirror
 * ``backend/tests/test_dataset_runtime.py``).  The TS port is synchronous
 * (Python asyncio is runtime infrastructure that lands with the TS Host
 * integration); rerun/resume and no-fake-success semantics mirror the Python
 * executor exactly.  Vitest-free so the same checks run under vitest and as
 * a plain Node script.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDatasetBuildSpec } from "../src/dataset/contracts/index.js";
import {
  buildOperationPlan,
  DatasetBuildExecutor,
  loadBuildState,
  makeOperationOutput,
  newBuildState,
  parseOperationAttempt,
  saveBuildState,
  validateAttemptLogPrefix,
  type OperationOutput,
  type OperationSpec,
} from "../src/dataset/runtime/index.js";

function check(issues: string[], condition: boolean, message: string): void {
  if (!condition) issues.push(message);
}

export function scratchOutputRoot(prefix = "runtime-parity-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function binding(bindingId: string, source: string): Record<string, unknown> {
  return {
    schema_version: "1.0",
    binding_id: bindingId,
    source,
    acquisition: {
      schema_version: "1.0",
      mode: "builtin",
      provider_id: `${source}.files.v1`,
    },
    adapter_id: `${source}.expression.v1`,
    accession: "ACC-1",
  };
}

function spec() {
  return parseDatasetBuildSpec({
    schema_version: "1.0",
    build_id: "build_test",
    objective: "compare expression",
    dataset_family: "gene_expression",
    row_granularity: "gene_sample_measurement",
    schema_ref: "gene_expression.long.v1",
    source_bindings: [binding("srcbind_gdc", "gdc"), binding("srcbind_xena", "xena")],
    validation_profile_ref: "gene_expression.release.v1",
  });
}

class CancelToken {
  private flag = false;
  set(): void {
    this.flag = true;
  }
  isSet(): boolean {
    return this.flag;
  }
}

/** Injectable operation runner that records calls and can fail or cancel. */
class RecordingRunner {
  readonly calls: string[] = [];
  private readonly failOn: string | null;
  private readonly cancelAfter: number | null;
  private readonly token: CancelToken | null;

  constructor(options: { failOn?: string; cancelAfter?: number; token?: CancelToken } = {}) {
    this.failOn = options.failOn ?? null;
    this.cancelAfter = options.cancelAfter ?? null;
    this.token = options.token ?? null;
  }


  run = (op: OperationSpec, upstream: Record<string, Record<string, unknown>>): OperationOutput => {
    this.calls.push(op.operation_id);
    if (this.failOn === op.operation_id) {
      throw new Error("boom");
    }
    if (this.cancelAfter !== null && this.calls.length >= this.cancelAfter && this.token !== null) {
      this.token.set();
    }
    return makeOperationOutput({
      operation_id: op.operation_id,
      kind: op.kind,
      upstream: Object.keys(upstream).sort(),
    });
  };
}

/** Re-runs of the target operation produce a different output digest. */
class ChangingRunner extends RecordingRunner {
  private readonly changeOn: string;
  private calls2 = 0;

  constructor(changeOn: string) {
    super();
    this.changeOn = changeOn;
  }

  override run = (
    op: OperationSpec,
    upstream: Record<string, Record<string, unknown>>,
  ): OperationOutput => {
    this.calls2 += 1;
    this.calls.push(op.operation_id);
    if (op.operation_id === this.changeOn) {
      return makeOperationOutput({
        operation_id: op.operation_id,
        change: this.calls2,
      });
    }
    return makeOperationOutput({
      operation_id: op.operation_id,
      upstream: Object.keys(upstream).sort(),
    });
  };
}

function makeExecutor(options: {
  outputRoot: string;
  runner: RecordingRunner;
  token?: CancelToken;
  scope?: Record<string, unknown>;
  resumeFrom?: string;
  implementationVersions?: Record<string, string>;
  plan?: OperationSpec[];
}): DatasetBuildExecutor {
  const buildSpec = spec();
  return new DatasetBuildExecutor({
    taskId: "task_1",
    buildId: buildSpec.build_id,
    stateDir: join(options.outputRoot, "state"),
    taskRoot: options.outputRoot,
    plan: options.plan ?? buildOperationPlan(buildSpec),
    runOperation: options.runner.run,
    cancellationRequested: options.token === undefined ? null : () => options.token!.isSet(),
    parameterScope: options.scope ?? null,
    implementationVersions: options.implementationVersions ?? null,
    resumeFrom: options.resumeFrom ?? null,
  });
}
export async function checkRuntimeParity(options: { outputRoot: string }): Promise<string[]> {
  const issues: string[] = [];
  const outputRoot = options.outputRoot;

  // test_operation_plan_fan_out_fan_in
  {
    const plan = buildOperationPlan(spec());
    const ids = plan.map((op) => op.operation_id);
    check(issues, plan.length === 11, "plan: 11 operations");
    checkDeepEqual(
      issues,
      ids,
      [
        "acquire:srcbind_gdc",
        "acquire:srcbind_xena",
        "parse:srcbind_gdc",
        "parse:srcbind_xena",
        "canonicalize:srcbind_gdc",
        "canonicalize:srcbind_xena",
        "compatibility_gate",
        "integrate",
        "assemble",
        "validate_profile",
        "publish",
      ],
      "plan: operation order",
    );
    const byId = new Map(plan.map((op) => [op.operation_id, op]));
    checkDeepEqual(issues, byId.get("acquire:srcbind_gdc")!.upstream, [], "plan: acquire upstream");
    checkDeepEqual(issues, byId.get("parse:srcbind_gdc")!.upstream, ["acquire:srcbind_gdc"], "plan: parse upstream");
    checkDeepEqual(
      issues,
      byId.get("compatibility_gate")!.upstream,
      ["canonicalize:srcbind_gdc", "canonicalize:srcbind_xena"],
      "plan: compatibility gate upstream",
    );
    checkDeepEqual(issues, byId.get("assemble")!.upstream, ["integrate"], "plan: assemble upstream");
    checkDeepEqual(issues, byId.get("validate_profile")!.upstream, ["assemble"], "plan: validate upstream");
    checkDeepEqual(issues, byId.get("publish")!.upstream, ["validate_profile"], "plan: publish upstream");
    check(issues, byId.get("publish")!.kind === "publish", "plan: publish kind");
  }

  // test_executor_runs_all_operations
  {
    const out = join(outputRoot, "runs-all");
    mkdirSync(out, { recursive: true });
    const runner = new RecordingRunner();
    const outcome = await makeExecutor({ outputRoot: out, runner }).run();
    check(issues, outcome.status === "completed", "runs all: completed");
    check(issues, outcome.error === null, "runs all: no error");
    check(issues, outcome.completedOperationIds.length === 11, "runs all: 11 completed ids");
    check(issues, runner.calls.length === 11, "runs all: 11 runner calls");
    const state = loadBuildState(join(out, "state"), "task_1", "build_test");
    const succeeded = state.operation_attempts.filter((attempt) => attempt.status === "succeeded");
    check(issues, succeeded.length === 11, "runs all: 11 succeeded attempts");
  }

  // test_executor_reuses_digest_matched_operations
  {
    const out = join(outputRoot, "reuse");
    mkdirSync(out, { recursive: true });
    const runner = new RecordingRunner();
    const first = await makeExecutor({ outputRoot: out, runner }).run();
    check(issues, first.status === "completed" && runner.calls.length === 11, "reuse: first run executes all");
    const runner2 = new RecordingRunner();
    const second = await makeExecutor({ outputRoot: out, runner: runner2 }).run();
    check(issues, second.status === "completed", "reuse: second run completed");
    checkDeepEqual(
      issues,
      runner2.calls,
      ["publish"],
      "reuse: publish is re-executed because generic publication shortcut is disabled",
    );
    const state = loadBuildState(join(out, "state"), "task_1", "build_test");
    const skipped = state.operation_attempts.filter((attempt) => attempt.status === "skipped");
    check(issues, skipped.length === 10, "reuse: 10 non-publication operations skipped");
  }

  // test_executor_reruns_when_parameters_change
  {
    const out = join(outputRoot, "params");
    mkdirSync(out, { recursive: true });
    const runner = new RecordingRunner();
    await makeExecutor({ outputRoot: out, runner, scope: { v: 1 } }).run();
    check(issues, runner.calls.length === 11, "params: first scope runs all");
    const runner2 = new RecordingRunner();
    await makeExecutor({ outputRoot: out, runner: runner2, scope: { v: 2 } }).run();
    check(issues, runner2.calls.length === 11, "params: scope change invalidates reuse");
  }

  // test_executor_per_binding_adapter_params_gate_reuse
  {
    const log2Scope = { srcbind_gdc: { value_scale: "log2" } };
    const linearScope = { srcbind_gdc: { value_scale: "linear" } };
    const out = join(outputRoot, "adapter-params");
    mkdirSync(out, { recursive: true });
    const runner = new RecordingRunner();
    await makeExecutor({ outputRoot: out, runner, scope: log2Scope }).run();
    check(issues, runner.calls.length === 11, "adapter params: first run executes all");
    const runner2 = new RecordingRunner();
    await makeExecutor({ outputRoot: out, runner: runner2, scope: log2Scope }).run();
    checkDeepEqual(
      issues,
      runner2.calls,
      ["publish"],
      "adapter params: non-publication operations reuse while publish re-executes",
    );
    const runner3 = new RecordingRunner();
    await makeExecutor({ outputRoot: out, runner: runner3, scope: linearScope }).run();
    check(issues, runner3.calls.length === 11, "adapter params: scale change invalidates every checkpoint");
  }

  // test_executor_reruns_when_implementation_version_changes
  {
    const out = join(outputRoot, "impl-version");
    mkdirSync(out, { recursive: true });
    const versions = { "parse:srcbind_gdc": "1.0.0", "parse:srcbind_xena": "1.0.0" };
    const runner = new RecordingRunner();
    await makeExecutor({ outputRoot: out, runner, implementationVersions: versions }).run();
    check(issues, runner.calls.length === 11, "impl version: first run executes all");
    const upgraded = { ...versions, "parse:srcbind_gdc": "1.1.0" };
    const runner2 = new RecordingRunner();
    await makeExecutor({ outputRoot: out, runner: runner2, implementationVersions: upgraded }).run();
    checkDeepEqual(issues, runner2.calls, ["parse:srcbind_gdc", "canonicalize:srcbind_gdc", "compatibility_gate", "integrate", "assemble", "validate_profile", "publish"], "impl version: upgraded parse invalidates downstream");
    const state = loadBuildState(join(out, "state"), "task_1", "build_test");
    const parseAttempts = state.operation_attempts.filter(
      (attempt) => attempt.operation_id === "parse:srcbind_gdc",
    );
    const versionsSeen = new Set(parseAttempts.map((attempt) => attempt.implementation_version));
    check(
      issues,
      versionsSeen.has("1.0.0") && versionsSeen.has("1.1.0"),
      "impl version: attempts carry producing versions",
    );
  }

  // test_executor_rerun_from_forces_target_and_reuses_upstream
  {
    const out = join(outputRoot, "resume-integrate");
    mkdirSync(out, { recursive: true });
    const runner = new RecordingRunner();
    await makeExecutor({ outputRoot: out, runner }).run();
    check(issues, runner.calls.length === 11, "resume: baseline run executes all");
    const runner2 = new RecordingRunner();
    const second = await makeExecutor({ outputRoot: out, runner: runner2, resumeFrom: "integrate" }).run();
    check(issues, second.status === "completed", "resume: completed");
    check(issues, second.completedOperationIds.length === 11, "resume: 11 completed ids");
    checkDeepEqual(issues, runner2.calls, ["integrate", "assemble", "validate_profile", "publish"], "resume: target and downstream re-execute");
    const state = loadBuildState(join(out, "state"), "task_1", "build_test");
    const integrate = state.operation_attempts.filter((attempt) => attempt.operation_id === "integrate");
    checkDeepEqual(
      issues,
      integrate.map((attempt) => attempt.status),
      ["succeeded", "succeeded"],
      "resume: integrate attempts succeeded",
    );
    checkDeepEqual(
      issues,
      integrate.map((attempt) => attempt.attempt),
      [1, 2],
      "resume: integrate attempt numbers increment",
    );
  }
  // test_executor_rerun_from_invalidates_downstream_when_output_changes
  {
    const out = join(outputRoot, "resume-invalidate");
    mkdirSync(out, { recursive: true });
    const runner = new RecordingRunner();
    await makeExecutor({ outputRoot: out, runner }).run();
    check(issues, runner.calls.length === 11, "invalidate: baseline run executes all");
    const runner2 = new ChangingRunner("canonicalize:srcbind_gdc");
    const second = await makeExecutor({ outputRoot: out, runner: runner2, resumeFrom: "canonicalize:srcbind_gdc" }).run();
    check(issues, second.status === "completed", "invalidate: completed");
    check(issues, second.completedOperationIds.length === 11, "invalidate: 11 completed ids");
    checkDeepEqual(
      issues,
      runner2.calls,
      ["canonicalize:srcbind_gdc", "compatibility_gate", "integrate", "assemble", "validate_profile", "publish"],
      "invalidate: downstream of changed digest re-executes",
    );
    const state = loadBuildState(join(out, "state"), "task_1", "build_test");
    const skipped = state.operation_attempts.filter((attempt) => attempt.status === "skipped");
    check(issues, skipped.length === 5, "invalidate: 5 reused upstream/sibling attempts");
  }

  // test_executor_rerun_from_rejects_unknown_operation
  {
    let threw = false;
    try {
      makeExecutor({ outputRoot: join(outputRoot, "resume-unknown"), runner: new RecordingRunner(), resumeFrom: "no_such_operation" });
    } catch (error) {
      threw = error instanceof Error && /resume_from/.test(error.message);
    }
    check(issues, threw, "resume: unknown operation rejected");
  }

  // test_executor_rerun_from_fresh_state_executes_everything
  {
    const out = join(outputRoot, "resume-fresh");
    mkdirSync(out, { recursive: true });
    const runner = new RecordingRunner();
    const outcome = await makeExecutor({ outputRoot: out, runner, resumeFrom: "integrate" }).run();
    check(issues, outcome.status === "completed", "resume fresh: completed");
    check(issues, runner.calls.length === 11, "resume fresh: no prior attempts to reuse");
  }

  // test_executor_cancel_stops_build
  {
    const out = join(outputRoot, "cancel");
    mkdirSync(out, { recursive: true });
    const token = new CancelToken();
    const runner = new RecordingRunner({ cancelAfter: 1, token });
    const outcome = await makeExecutor({ outputRoot: out, runner, token }).run();
    check(issues, outcome.status === "cancelled", "cancel: status cancelled");
    const state = loadBuildState(join(out, "state"), "task_1", "build_test");
    const cancelled = state.operation_attempts.filter((attempt) => attempt.status === "cancelled");
    check(issues, cancelled.length === 1, "cancel: completed-too-late attempt marked cancelled");
    checkDeepEqual(issues, outcome.completedOperationIds, [], "cancel: no completed operations");
  }

  // test_executor_recovers_inflight_on_restart
  {
    const out = join(outputRoot, "recover");
    mkdirSync(out, { recursive: true });
    const stateDir = join(out, "state");
    mkdirSync(stateDir, { recursive: true });
    const inflight = {
      operation_attempt_id: "operation_attempt_crashed",
      task_id: "task_1",
      build_id: "build_test",
      operation_id: "parse:srcbind_gdc",
      attempt: 1,
      input_digest: "a".repeat(64),
      parameter_digest: "b".repeat(64),
      output_digest: null,
      status: "running",
      implementation_version: null,
      started_at: "2026-08-07T00:00:00+00:00",
      finished_at: null,
      error: null,
      reused_operation_attempt_id: null,
    };
    const state = newBuildState("task_1", "build_test");
    state.inflight_attempt = parseOperationAttempt(inflight);
    saveBuildState(stateDir, state);
    const runner = new RecordingRunner();
    const outcome = await makeExecutor({ outputRoot: out, runner }).run();
    check(issues, outcome.status === "completed", "recover: completed");
    check(issues, runner.calls.length === 11, "recover: crashed op re-executed, everything ran");
    const reloaded = loadBuildState(stateDir, "task_1", "build_test");
    const statuses = reloaded.operation_attempts.map((attempt) => attempt.status);
    check(issues, statuses.includes("cancelled"), "recover: inflight attempt marked cancelled");
    check(issues, statuses.filter((status) => status === "succeeded").length === 11, "recover: 11 succeeded attempts");
  }

  // test_executor_reuses_by_digest_across_plan_shapes
  {
    const out = join(outputRoot, "rehydrate-stale");
    mkdirSync(out, { recursive: true });
    const runner = new RecordingRunner();
    const first = await makeExecutor({ outputRoot: out, runner }).run();
    check(issues, first.status === "completed", "stale digest: baseline (plan A) completes");

    // Plan B binds a source never seen by plan A, so its prefix differs:
    // acquire/parse/canonicalize/compatibility_gate (":srcbind_new") re-run
    // for real, and integrate re-runs because its upstream digest changed.
    // The integration result receipt identity changes, so assemble and its
    // validate/publish downstream re-run even when a synthetic output summary
    // happens to match. The ghost guard
    // still holds: integrate can only re-run with a real upstream after
    // canonicalization ("cannot integrate zero sources"), never empty.
    const planB = buildOperationPlan(
      parseDatasetBuildSpec({
        schema_version: "1.0",
        build_id: "build_test",
        objective: "compare expression",
        dataset_family: "gene_expression",
        row_granularity: "gene_sample_measurement",
        schema_ref: "gene_expression.long.v1",
        source_bindings: [binding("srcbind_new", "gdc")],
        validation_profile_ref: "gene_expression.release.v1",
      }),
    );
    class IntegrateGuardRunner extends RecordingRunner {
      override run = (
        op: OperationSpec,
        upstream: Record<string, Record<string, unknown>>,
      ): OperationOutput => {
        if (op.operation_id === "integrate" && Object.keys(upstream).length === 0) {
          throw new Error("cannot integrate zero sources");
        }
        this.calls.push(op.operation_id);
        return makeOperationOutput({
          operation_id: op.operation_id,
          kind: op.kind,
          upstream: Object.keys(upstream).sort(),
        });
      };
    }
    const runner2 = new IntegrateGuardRunner();
    const second = await makeExecutor({ outputRoot: out, plan: planB, runner: runner2 }).run();
    check(issues, second.status === "completed", "stale digest: plan B completes without ghost integrate");
    const state = loadBuildState(join(out, "state"), "task_1", "build_test");
    const succeeded = state.operation_attempts.filter((attempt) => attempt.status === "succeeded");
    const skipped = state.operation_attempts.filter((attempt) => attempt.status === "skipped");
    check(issues, succeeded.length === 19, "stale digest: plan A (11) + plan B re-executes 8");
    check(issues, skipped.length === 0, "stale digest: changed result receipts prevent downstream reuse");
    check(
      issues,
      skipped.every((attempt) => attempt.reused_operation_attempt_id !== null),
      "stale digest: skipped attempts carry reused_operation_attempt_id",
    );
    checkDeepEqual(
      issues,
      runner2.calls,
      [
        "acquire:srcbind_new",
        "parse:srcbind_new",
        "canonicalize:srcbind_new",
        "compatibility_gate",
        "integrate",
        "assemble",
        "validate_profile",
        "publish",
      ],
      "stale digest: plan B executes with committed receipt identity in plan order",
    );
  }

  // test_executor_failure_marks_attempt_failed
  {
    const out = join(outputRoot, "failure");
    mkdirSync(out, { recursive: true });
    const runner = new RecordingRunner({ failOn: "integrate" });
    const outcome = await makeExecutor({ outputRoot: out, runner }).run();
    check(issues, outcome.status === "failed", "failure: status failed");
    check(issues, outcome.error !== null, "failure: structured error");
    const state = loadBuildState(join(out, "state"), "task_1", "build_test");
    const failed = state.operation_attempts.filter((attempt) => attempt.status === "failed");
    check(issues, failed.length === 1 && failed[0].operation_id === "integrate", "failure: failed attempt recorded");
    check(issues, failed[0].error !== null, "failure: failed attempt carries error");
  }

  // test_operation_attempt_state_machine
  {
    const base = {
      operation_attempt_id: "operation_attempt_1",
      task_id: "task_1",
      build_id: "build_1",
      operation_id: "acquire:src",
      attempt: 1,
      input_digest: "a".repeat(64),
      parameter_digest: "b".repeat(64),
      output_digest: null,
      status: "",
      implementation_version: null,
      started_at: null,
      finished_at: null,
      error: null,
      reused_operation_attempt_id: null,
    };
    let threw = false;
    try {
      parseOperationAttempt({ ...base, status: "succeeded" });
    } catch (error) {
      threw = error instanceof TypeError && /output_digest/.test(String(error.message));
    }
    check(issues, threw, "state machine: succeeded requires output_digest");
    threw = false;
    try {
      parseOperationAttempt({ ...base, status: "failed" });
    } catch (error) {
      threw = error instanceof TypeError && /error/.test(String(error.message));
    }
    check(issues, threw, "state machine: failed requires error");
    threw = false;
    try {
      parseOperationAttempt({ ...base, status: "skipped", output_digest: "c".repeat(64) });
    } catch (error) {
      threw = error instanceof TypeError && /reused_operation_attempt_id/.test(String(error.message));
    }
    check(issues, threw, "state machine: skipped requires reused_operation_attempt_id");
  }

  // test_build_state_rejects_diverged_attempt_log
  {
    const out = join(outputRoot, "diverged-log");
    mkdirSync(out, { recursive: true });
    const stateDir = join(out, "state");
    mkdirSync(stateDir, { recursive: true });
    saveBuildState(stateDir, newBuildState("task_1", "build_1"));
    const record = {
      operation_attempt_id: "operation_attempt_x",
      task_id: "task_1",
      build_id: "build_1",
      operation_id: "acquire:src",
      attempt: 1,
      input_digest: "a".repeat(64),
      parameter_digest: "b".repeat(64),
      output_digest: null,
      status: "running",
      implementation_version: null,
      started_at: null,
      finished_at: null,
      error: null,
      reused_operation_attempt_id: null,
    };
    writeFileSync(join(stateDir, "operation_attempts.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
    const state = loadBuildState(stateDir, "task_1", "build_1");
    let threw = false;
    try {
      validateAttemptLogPrefix(state, join(stateDir, "operation_attempts.jsonl"));
    } catch (error) {
      threw = error instanceof Error && /ahead of durable state/.test(error.message);
    }
    check(issues, threw, "diverged log: prefix validation rejects");
  }

  // test_executor_corrupt_state_returns_failed_outcome
  {
    const out = join(outputRoot, "corrupt");
    mkdirSync(join(out, "state"), { recursive: true });
    writeFileSync(join(out, "state", "build_state.json"), "{not valid json", "utf8");
    const outcome = await makeExecutor({ outputRoot: out, runner: new RecordingRunner() }).run();
    check(issues, outcome.status === "failed", "corrupt: status failed");
    check(issues, outcome.error !== null && outcome.error.code === "internal_error", "corrupt: internal_error code");
    check(
      issues,
      outcome.error !== null && outcome.error.message.includes("could not be loaded or recovered"),
      "corrupt: recovery failure message",
    );
  }

  return issues;
}

function checkDeepEqual(
  issues: string[],
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    issues.push(`${message}: expected ${right}, got ${left}`);
  }
}