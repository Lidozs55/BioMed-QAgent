/**
 * Shared test fixture: a fully wired permission broker (in-memory stores)
 * used by workspace tool tests. Mirrors the production wiring in
 * ``phase3-composition.ts`` without touching disk or the event repository.
 */
import {
  InMemoryPermissionAuditSink,
  InMemoryPermissionPolicyStore,
  PermissionBroker,
  PermissionEvaluator,
  ProtectedPaths,
  TemporaryGrantStore,
} from "../../src/agent/permissions/index.js";

export interface PermissionFixture {
  broker: PermissionBroker;
  grants: TemporaryGrantStore;
  policyStore: InMemoryPermissionPolicyStore;
  audit: InMemoryPermissionAuditSink;
  events: Array<{ type: string; request_id?: string }>;
}

export function createPermissionFixture(options: {
  taskId: string;
  runId: string;
  taskOutputRoot: string;
}): PermissionFixture {
  const policyStore = new InMemoryPermissionPolicyStore();
  const grants = new TemporaryGrantStore();
  const protectedPaths = new ProtectedPaths({ taskOutputRoot: options.taskOutputRoot });
  const evaluator = new PermissionEvaluator({ protectedPaths, grants, policyStore });
  const audit = new InMemoryPermissionAuditSink();
  const events: Array<{ type: string; request_id?: string }> = [];
  const broker = new PermissionBroker({
    taskId: options.taskId,
    runId: options.runId,
    evaluator,
    grants,
    policyStore,
    audit,
    recordRunEvent: async (payload) => {
      events.push(payload as { type: string; request_id?: string });
    },
  });
  return { broker, grants, policyStore, audit, events };
}
