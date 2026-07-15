import type { APIClient } from "@/hooks/useAPI";
import type {
  ContinueTaskInput,
  StartTaskInput,
  TaskRunAccepted,
} from "./contracts";
import {
  addAcceptedTask,
  mergeTaskArtifacts,
  useAgentStore,
} from "@/stores/agentStore";

const TASK_PAGE_SIZE = 30;

export interface EventTransport {
  connect(): Promise<void>;
  disconnect(): void;
  subscribe(taskId: string, afterSequence: number): void;
  isSubscribed(taskId: string): boolean;
  unsubscribeAndWait(taskId: string): Promise<void>;
}

interface RuntimeDependencies {
  api: APIClient;
  transport: EventTransport;
}

export function startRuntime({ api, transport }: RuntimeDependencies) {
  const databasePromise = api
    .fetchDatabases()
    .then((databases) => useAgentStore.getState().setDatabases(databases));
  const historyPromise = api.fetchTasks({ limit: TASK_PAGE_SIZE }).then((page) => {
    useAgentStore.getState().mergeTaskPage(page, false);
    for (const task of page.active_items) {
      const lastSequence =
        useAgentStore.getState().tasksById[task.task_id]?.lastSequence ??
        task.latest_sequence;
      transport.subscribe(task.task_id, lastSequence);
    }
  });
  const socketPromise = transport.connect();
  return Promise.allSettled([
    databasePromise,
    historyPromise,
    socketPromise,
  ]);
}

export class RuntimeController {
  constructor(
    private readonly api: APIClient,
    private readonly transport: EventTransport,
  ) {}

  async selectTask(taskId: string): Promise<void> {
    const wasSubscribed = this.transport.isSubscribed(taskId);
    try {
      if (wasSubscribed) {
        await this.transport.unsubscribeAndWait(taskId);
      }
      const snapshot = await this.api.fetchTask(taskId);
      useAgentStore.getState().hydrateTaskSnapshot(snapshot);
      useAgentStore.getState().setActiveTaskId(taskId);
      this.transport.subscribe(taskId, snapshot.task.latest_sequence);
      const artifacts = await this.api.fetchArtifacts(taskId);
      useAgentStore.setState((state) =>
        mergeTaskArtifacts(state, taskId, artifacts),
      );
    } catch (error) {
      if (wasSubscribed) {
        const lastSequence =
          useAgentStore.getState().tasksById[taskId]?.lastSequence ?? 0;
        this.transport.subscribe(taskId, lastSequence);
      }
      throw error;
    }
  }

  async startTask(input: StartTaskInput): Promise<TaskRunAccepted> {
    const accepted = await this.api.createTask(input);
    useAgentStore.setState((state) =>
      addAcceptedTask(
        state,
        {
          taskId: accepted.task_id,
          runId: accepted.run_id,
          requestId: accepted.request_id,
        },
        input.input,
        input.databases,
        input.mode,
      ),
    );
    this.transport.subscribe(accepted.task_id, 0);
    try {
      const snapshot = await this.api.fetchTask(accepted.task_id);
      useAgentStore.getState().hydrateTaskSnapshot(snapshot);
      useAgentStore.getState().setActiveTaskId(accepted.task_id);
      this.transport.subscribe(
        accepted.task_id,
        snapshot.task.latest_sequence,
      );
      const artifacts = await this.api.fetchArtifacts(accepted.task_id);
      useAgentStore.setState((state) =>
        mergeTaskArtifacts(state, accepted.task_id, artifacts),
      );
    } catch {
      return accepted;
    }
    return accepted;
  }

  continueTask(
    taskId: string,
    input: ContinueTaskInput,
  ): Promise<TaskRunAccepted> {
    return this.api.continueTask(taskId, input);
  }

  async loadMoreTasks(): Promise<void> {
    const cursor = useAgentStore.getState().nextCursor;
    if (cursor === null) return;
    const page = await this.api.fetchTasks({
      limit: TASK_PAGE_SIZE,
      cursor,
    });
    useAgentStore.getState().mergeTaskPage(page, true);
    for (const task of page.active_items) {
      const lastSequence =
        useAgentStore.getState().tasksById[task.task_id]?.lastSequence ??
        task.latest_sequence;
      this.transport.subscribe(task.task_id, lastSequence);
    }
  }

  showNewDraft(): void {
    useAgentStore.getState().showNewDraft();
  }
}
