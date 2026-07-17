import type { APIClient } from "@/hooks/useAPI";
import type {
  ContinueTaskInput,
  ResumeRunInput,
  StartTaskInput,
  TaskRunAccepted,
  TaskSnapshot,
} from "./contracts";
import {
  addAcceptedTask,
  mergeTaskArtifacts,
  useAgentStore,
} from "@/stores/agentStore";

const TASK_PAGE_SIZE = 30;
const EVENT_REPLAY_PAGE_SIZE = 1000;

export interface EventTransport {
  connect(): Promise<void>;
  disconnect(): void;
  subscribe(taskId: string, afterSequence: number): void;
  isSubscribed(taskId: string): boolean;
  unsubscribeAndWait(taskId: string): Promise<void>;
  recoverSubscription(taskId: string, afterSequence: number): Promise<void>;
}

interface RuntimeDependencies {
  api: APIClient;
  transport: EventTransport;
  signal?: AbortSignal;
}

export function startRuntime({ api, transport, signal }: RuntimeDependencies) {
  const databasePromise = api
    .fetchDatabases()
    .then((databases) => {
      if (signal?.aborted) return;
      useAgentStore.getState().setDatabases(databases);
    });
  const historyPromise = api.fetchTasks({ limit: TASK_PAGE_SIZE }).then((page) => {
    if (signal?.aborted) return;
    useAgentStore.getState().mergeTaskPage(page, false);
    for (const task of page.active_items) {
      if (signal?.aborted) return;
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
  private foregroundIntentGeneration = 0;
  private readonly taskHandoffGenerations = new Map<string, number>();
  private readonly taskHandoffTails = new Map<string, Promise<void>>();
  private readonly selectionHandoffs = new Map<string, Promise<number>>();
  private readonly messageHydrations = new Map<string, Promise<void>>();
  private readonly artifactHydrations = new Map<
    string,
    { generation: number; promise: Promise<void> }
  >();

  constructor(
    private readonly api: APIClient,
    private readonly transport: EventTransport,
  ) {}

  async selectTask(taskId: string): Promise<void> {
    const generation = ++this.foregroundIntentGeneration;
    const handoffGeneration = await this.getSelectionHandoff(taskId);
    if (generation === this.foregroundIntentGeneration) {
      useAgentStore.getState().setActiveTaskId(taskId);
    }
    await this.getArtifactHydration(taskId, handoffGeneration);
  }

  private getSelectionHandoff(taskId: string): Promise<number> {
    const existing = this.selectionHandoffs.get(taskId);
    if (existing !== undefined) return existing;
    const handoff = this.enqueueTaskHandoff(taskId, async () => {
      const generation = this.advanceTaskHandoffGeneration(taskId);
      await this.performSelectionHandoff(taskId);
      return generation;
    });
    this.selectionHandoffs.set(taskId, handoff);
    const clear = () => {
      if (this.selectionHandoffs.get(taskId) === handoff) {
        this.selectionHandoffs.delete(taskId);
      }
    };
    void handoff.then(clear, clear);
    return handoff;
  }

  private enqueueTaskHandoff<T>(
    taskId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.taskHandoffTails.get(taskId) ?? Promise.resolve();
    const handoff = previous.then(operation, operation);
    const tail = handoff.then(
      () => undefined,
      () => undefined,
    );
    this.taskHandoffTails.set(taskId, tail);
    void tail.then(() => {
      if (this.taskHandoffTails.get(taskId) === tail) {
        this.taskHandoffTails.delete(taskId);
      }
    });
    return handoff;
  }

  private advanceTaskHandoffGeneration(taskId: string): number {
    const generation = (this.taskHandoffGenerations.get(taskId) ?? 0) + 1;
    this.taskHandoffGenerations.set(taskId, generation);
    return generation;
  }

  private async performSelectionHandoff(taskId: string): Promise<void> {
    const wasSubscribed = this.transport.isSubscribed(taskId);
    try {
      if (wasSubscribed) {
        await this.transport.unsubscribeAndWait(taskId);
      }
      const snapshot = await this.api.fetchTask(taskId);
      useAgentStore.getState().hydrateTaskSnapshot(snapshot);
      this.transport.subscribe(taskId, snapshot.task.latest_sequence);
    } catch (error) {
      if (wasSubscribed) {
        const lastSequence =
          useAgentStore.getState().tasksById[taskId]?.lastSequence ?? 0;
        this.transport.subscribe(taskId, lastSequence);
      }
      throw error;
    }
  }

  private getArtifactHydration(
    taskId: string,
    generation: number,
  ): Promise<void> {
    const existing = this.artifactHydrations.get(taskId);
    if (existing?.generation === generation) return existing.promise;
    const requestSequence =
      useAgentStore.getState().tasksById[taskId]?.lastSequence ?? 0;
    const hydration = this.api.fetchArtifacts(taskId).then((artifacts) => {
      if (this.taskHandoffGenerations.get(taskId) !== generation) return;
      useAgentStore.setState((state) =>
        mergeTaskArtifacts(state, taskId, artifacts, requestSequence),
      );
    });
    this.artifactHydrations.set(taskId, { generation, promise: hydration });
    const clear = () => {
      if (this.artifactHydrations.get(taskId)?.promise === hydration) {
        this.artifactHydrations.delete(taskId);
      }
    };
    void hydration.then(clear, clear);
    return hydration;
  }

  private async replayTaskEvents(
    taskId: string,
    targetSequence: number,
  ): Promise<void> {
    let afterSequence = 0;
    for (;;) {
      const events = await this.api.fetchEvents(taskId, {
        afterSequence,
        limit: EVENT_REPLAY_PAGE_SIZE,
      });
      if (events.length === 0) {
        const currentSequence =
          useAgentStore.getState().tasksById[taskId]?.lastSequence ?? 0;
        if (currentSequence < targetSequence) {
          throw new Error("Task event replay is incomplete");
        }
        return;
      }
      let nextSequence = afterSequence;
      for (const event of events) {
        useAgentStore.getState().applyEvent(event);
        nextSequence = Math.max(nextSequence, event.sequence);
      }
      const currentSequence =
        useAgentStore.getState().tasksById[taskId]?.lastSequence ?? 0;
      if (currentSequence >= targetSequence) {
        return;
      }
      if (nextSequence <= afterSequence) {
        throw new Error("Task event replay did not advance");
      }
      if (events.length < EVENT_REPLAY_PAGE_SIZE) {
        throw new Error("Task event replay is incomplete");
      }
      afterSequence = nextSequence;
    }
  }

  private async recoverAcceptedTask(
    taskId: string,
    snapshot: TaskSnapshot | null,
  ): Promise<void> {
    const lastSequence =
      useAgentStore.getState().tasksById[taskId]?.lastSequence ?? 0;
    try {
      await this.transport.recoverSubscription(taskId, lastSequence);
    } catch {
      return;
    }
    if (snapshot !== null) {
      useAgentStore.getState().hydrateTaskSnapshot(snapshot);
    }
  }

  private async performAcceptedTaskHandoff(
    accepted: TaskRunAccepted,
    input: StartTaskInput,
    foregroundIntentGeneration: number,
  ): Promise<boolean> {
    const existing = useAgentStore.getState().tasksById[accepted.task_id];
    const needsRestReplay = existing?.hydration === "summary";
    let minimumReplaySequence = existing?.lastSequence ?? 0;
    if (this.transport.isSubscribed(accepted.task_id)) {
      try {
        await this.transport.unsubscribeAndWait(accepted.task_id);
      } catch {
        // unsubscribeAndWait removes the desired subscription before awaiting pong.
      }
    }
    minimumReplaySequence = Math.max(
      minimumReplaySequence,
      useAgentStore.getState().tasksById[accepted.task_id]?.lastSequence ?? 0,
    );
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
        foregroundIntentGeneration === this.foregroundIntentGeneration,
      ),
    );
    let snapshot: TaskSnapshot;
    try {
      snapshot = await this.api.fetchTask(accepted.task_id);
    } catch {
      if (needsRestReplay) {
        try {
          await this.replayTaskEvents(
            accepted.task_id,
            minimumReplaySequence,
          );
        } catch {
          await this.recoverAcceptedTask(accepted.task_id, null);
          return false;
        }
      }
      const lastSequence =
        useAgentStore.getState().tasksById[accepted.task_id]?.lastSequence ?? 0;
      this.transport.subscribe(accepted.task_id, lastSequence);
      return false;
    }
    try {
      if (needsRestReplay) {
        await this.replayTaskEvents(
          accepted.task_id,
          Math.max(minimumReplaySequence, snapshot.task.latest_sequence),
        );
      } else {
        this.transport.subscribe(accepted.task_id, 0);
        await this.transport.unsubscribeAndWait(accepted.task_id);
      }
    } catch {
      if (needsRestReplay) {
        await this.recoverAcceptedTask(accepted.task_id, snapshot);
        return false;
      }
      const lastSequence =
        useAgentStore.getState().tasksById[accepted.task_id]?.lastSequence ?? 0;
      this.transport.subscribe(accepted.task_id, lastSequence);
      return false;
    }
    useAgentStore.getState().hydrateTaskSnapshot(snapshot);
    if (foregroundIntentGeneration === this.foregroundIntentGeneration) {
      useAgentStore.getState().setActiveTaskId(accepted.task_id);
    }
    const lastSequence =
      useAgentStore.getState().tasksById[accepted.task_id]?.lastSequence ?? 0;
    this.transport.subscribe(accepted.task_id, lastSequence);
    return true;
  }

  async startTask(input: StartTaskInput): Promise<TaskRunAccepted> {
    const foregroundIntentGeneration = ++this.foregroundIntentGeneration;
    const accepted = await this.api.createTask(input);
    const { generation, hydrateArtifacts } = await this.enqueueTaskHandoff(
      accepted.task_id,
      async () => {
        const generation = this.advanceTaskHandoffGeneration(accepted.task_id);
        const hydrateArtifacts = await this.performAcceptedTaskHandoff(
          accepted,
          input,
          foregroundIntentGeneration,
        );
        return { generation, hydrateArtifacts };
      },
    );
    if (hydrateArtifacts) {
      try {
        await this.getArtifactHydration(accepted.task_id, generation);
      } catch {
        return accepted;
      }
    }
    return accepted;
  }

  async continueTask(
    taskId: string,
    input: ContinueTaskInput,
  ): Promise<TaskRunAccepted> {
    const accepted = await this.api.continueTask(taskId, input);
    await this.enqueueTaskHandoff(taskId, async () => {
      this.advanceTaskHandoffGeneration(taskId);
      const task = useAgentStore.getState().tasksById[accepted.task_id];
      if (task === undefined) return;
      useAgentStore.setState((state) =>
        addAcceptedTask(
          state,
          {
            taskId: accepted.task_id,
            runId: accepted.run_id,
            requestId: accepted.request_id,
          },
          input.input,
          task.summary.databases,
          task.summary.mode,
          false,
        ),
      );
    });
    return accepted;
  }

  async cancelRun(taskId: string, runId: string): Promise<void> {
    await this.enqueueTaskHandoff(taskId, async () => {
      const generation = this.advanceTaskHandoffGeneration(taskId);
      const snapshot = await this.api.cancelRun(taskId, runId);
      if (this.taskHandoffGenerations.get(taskId) !== generation) return;
      useAgentStore.getState().hydrateTaskSnapshot(snapshot);
    });
  }

  async resumeRun(
    taskId: string,
    runId: string,
    input: ResumeRunInput,
  ): Promise<void> {
    await this.enqueueTaskHandoff(taskId, async () => {
      const generation = this.advanceTaskHandoffGeneration(taskId);
      const snapshot = await this.api.resumeRun(taskId, runId, input);
      if (this.taskHandoffGenerations.get(taskId) !== generation) return;
      useAgentStore.getState().hydrateTaskSnapshot(snapshot);
    });
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.api.deleteTask(taskId);
    if (this.transport.isSubscribed(taskId)) {
      try {
        await this.transport.unsubscribeAndWait(taskId);
      } catch {
        // The desired subscription is removed before the barrier settles.
      }
    }
    useAgentStore.getState().removeTask(taskId);
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

  loadOlderMessages(taskId: string): Promise<void> {
    const existing = this.messageHydrations.get(taskId);
    if (existing !== undefined) return existing;
    const cursor =
      useAgentStore.getState().tasksById[taskId]?.olderMessagesCursor;
    if (cursor === undefined || cursor === null) return Promise.resolve();

    const hydration = this.api
      .fetchMessages(taskId, { limit: 100, cursor })
      .then((page) => {
        useAgentStore
          .getState()
          .mergeOlderMessagePage(taskId, cursor, page);
      });
    this.messageHydrations.set(taskId, hydration);
    const clear = () => {
      if (this.messageHydrations.get(taskId) === hydration) {
        this.messageHydrations.delete(taskId);
      }
    };
    void hydration.then(clear, clear);
    return hydration;
  }

  showNewDraft(): void {
    this.foregroundIntentGeneration += 1;
    useAgentStore.getState().showNewDraft();
  }
}
