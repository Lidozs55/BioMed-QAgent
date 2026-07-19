import type { APIClient } from "@/hooks/useAPI";
import type {
  ContinueTaskInput,
  ResumeRunInput,
  StartTaskInput,
  TaskPage,
  TaskRunAccepted,
  TaskSnapshot,
} from "./contracts";
import {
  addAcceptedTask,
  mergeTaskArtifacts,
  useAgentStore,
} from "@/stores/agentStore";

const TASK_PAGE_SIZE = 10;
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

function errorDescription(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

function excludeDeletedTasks(
  page: TaskPage,
  excludedTaskIds: ReadonlySet<string>,
): TaskPage {
  if (excludedTaskIds.size === 0) return page;
  return {
    ...page,
    active_items: page.active_items.filter(
      (task) => !excludedTaskIds.has(task.task_id),
    ),
    items: page.items.filter((task) => !excludedTaskIds.has(task.task_id)),
  };
}

export function startRuntime({ api, transport, signal }: RuntimeDependencies) {
  return new RuntimeController(api, transport).start(signal);
}

export class RuntimeController {
  private foregroundIntentGeneration = 0;
  private readonly deletedTaskIds = new Set<string>();
  private readonly taskHandoffGenerations = new Map<string, number>();
  private readonly taskHandoffTails = new Map<string, Promise<void>>();
  private readonly selectionHandoffs = new Map<
    string,
    Promise<number | null>
  >();
  private readonly messageHydrations = new Map<string, Promise<void>>();
  private taskHistoryExpansion: Promise<void> | null = null;
  private readonly artifactHydrations = new Map<
    string,
    { generation: number; promise: Promise<void> }
  >();

  constructor(
    private readonly api: APIClient,
    private readonly transport: EventTransport,
  ) {}

  start(signal?: AbortSignal) {
    const databasePromise = this.api.fetchDatabases().then((databases) => {
      if (signal?.aborted) return;
      const state = useAgentStore.getState();
      state.setDatabases(databases);
      if (state.draft.selectedDatabaseIds.length === 0) {
        state.setDraftSelectedDatabaseIds(
          databases.map((database) => database.id),
        );
      }
    });
    const historyPromise = this.loadTaskHistory(signal);
    const socketPromise = this.transport.connect();
    return Promise.allSettled([
      databasePromise,
      historyPromise,
      socketPromise,
    ]);
  }

  private async loadTaskHistory(signal?: AbortSignal): Promise<void> {
    const tasksAtRequestStart = useAgentStore.getState().tasksById;
    useAgentStore.getState().setHistoryState("loading");
    try {
      const page = excludeDeletedTasks(
        await this.api.fetchTasks({ limit: TASK_PAGE_SIZE }),
        this.deletedTaskIds,
      );
      if (signal?.aborted) return;
      const currentTasks = useAgentStore.getState().tasksById;
      const changedTaskIds = new Set(
        Object.entries(currentTasks)
          .filter(
            ([taskId, task]) => tasksAtRequestStart[taskId] !== task,
          )
          .map(([taskId]) => taskId),
      );
      useAgentStore.getState().mergeTaskPage(page, false, changedTaskIds);
      for (const task of page.active_items) {
        if (signal?.aborted) return;
        const state = useAgentStore.getState();
        if (!state.activeItems.includes(task.task_id)) continue;
        const lastSequence =
          state.tasksById[task.task_id]?.lastSequence ?? task.latest_sequence;
        this.transport.subscribe(task.task_id, lastSequence);
      }
      useAgentStore.getState().setHistoryState("ready");
    } catch (error) {
      if (!signal?.aborted) {
        useAgentStore
          .getState()
          .setHistoryState("error", errorDescription(error));
      }
      throw error;
    }
  }

  async selectTask(taskId: string): Promise<void> {
    const generation = ++this.foregroundIntentGeneration;
    const previousActiveTaskId = useAgentStore.getState().activeTaskId;
    if (
      !this.deletedTaskIds.has(taskId) &&
      useAgentStore.getState().tasksById[taskId] !== undefined
    ) {
      useAgentStore.getState().setActiveTaskId(taskId);
    }
    try {
      const handoffGeneration = await this.getSelectionHandoff(taskId);
      if (
        handoffGeneration === null ||
        !this.isCurrentTaskHandoff(taskId, handoffGeneration)
      ) {
        this.restoreForegroundSelection(
          generation,
          taskId,
          previousActiveTaskId,
        );
        return;
      }
      await this.getArtifactHydration(taskId, handoffGeneration);
    } catch (error) {
      this.restoreForegroundSelection(
        generation,
        taskId,
        previousActiveTaskId,
      );
      throw error;
    }
  }

  private restoreForegroundSelection(
    generation: number,
    taskId: string,
    previousActiveTaskId: string | null,
  ): void {
    const state = useAgentStore.getState();
    if (
      generation !== this.foregroundIntentGeneration ||
      state.activeTaskId !== taskId
    ) {
      return;
    }
    state.setActiveTaskId(
      previousActiveTaskId !== null &&
        state.tasksById[previousActiveTaskId] !== undefined
        ? previousActiveTaskId
        : null,
    );
  }

  private getSelectionHandoff(taskId: string): Promise<number | null> {
    if (this.deletedTaskIds.has(taskId)) return Promise.resolve(null);
    const existing = this.selectionHandoffs.get(taskId);
    if (existing !== undefined) return existing;
    const handoff = this.enqueueTaskHandoff(taskId, async () => {
      const generation = this.advanceTaskHandoffGeneration(taskId);
      const selected = await this.performSelectionHandoff(taskId, generation);
      return selected ? generation : null;
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

  private isCurrentTaskHandoff(taskId: string, generation: number): boolean {
    return (
      !this.deletedTaskIds.has(taskId) &&
      this.taskHandoffGenerations.get(taskId) === generation &&
      useAgentStore.getState().tasksById[taskId] !== undefined
    );
  }

  private async performSelectionHandoff(
    taskId: string,
    generation: number,
  ): Promise<boolean> {
    const wasSubscribed = this.transport.isSubscribed(taskId);
    try {
      if (wasSubscribed) {
        await this.transport.unsubscribeAndWait(taskId);
      }
      if (!this.isCurrentTaskHandoff(taskId, generation)) return false;
      const snapshot = await this.api.fetchTask(taskId);
      if (!this.isCurrentTaskHandoff(taskId, generation)) return false;
      const needsFullReplay =
        useAgentStore.getState().tasksById[taskId]?.hydration === "summary";
      if (needsFullReplay) {
        useAgentStore.getState().prepareTaskSnapshotReplay(snapshot);
      }
      await this.replayTaskEvents(taskId, snapshot.task.latest_sequence);
      if (!this.isCurrentTaskHandoff(taskId, generation)) return false;
      useAgentStore.getState().hydrateTaskSnapshot(snapshot);
      const lastSequence =
        useAgentStore.getState().tasksById[taskId]?.lastSequence ??
        snapshot.task.latest_sequence;
      this.transport.subscribe(taskId, lastSequence);
      return true;
    } catch (error) {
      if (!this.isCurrentTaskHandoff(taskId, generation)) return false;
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
    let afterSequence =
      useAgentStore.getState().tasksById[taskId]?.lastSequence ?? 0;
    if (targetSequence <= afterSequence) return;
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
      try {
        await this.replayTaskEvents(taskId, snapshot.task.latest_sequence);
      } catch {
        // The backend cancellation already succeeded; the snapshot remains authoritative.
      }
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
    this.deletedTaskIds.add(taskId);
    this.advanceTaskHandoffGeneration(taskId);
    if (this.transport.isSubscribed(taskId)) {
      try {
        await this.transport.unsubscribeAndWait(taskId);
      } catch {
        // The desired subscription is removed before the barrier settles.
      }
    }
    useAgentStore.getState().removeTask(taskId);
  }

  loadAllTasks(): Promise<void> {
    if (useAgentStore.getState().nextCursor === null) return Promise.resolve();
    if (this.taskHistoryExpansion !== null) return this.taskHistoryExpansion;

    const expansion = (async () => {
      const seenCursors = new Set<string>();
      while (true) {
        const cursor = useAgentStore.getState().nextCursor;
        if (cursor === null) return;
        if (seenCursors.has(cursor)) {
          throw new Error("Task pagination cursor did not advance");
        }
        seenCursors.add(cursor);
        const page = excludeDeletedTasks(
          await this.api.fetchTasks({
            limit: TASK_PAGE_SIZE,
            cursor,
          }),
          this.deletedTaskIds,
        );
        if (page.next_cursor === cursor) {
          throw new Error("Task pagination cursor did not advance");
        }
        useAgentStore.getState().mergeTaskPage(page, true);
        for (const task of page.active_items) {
          const lastSequence =
            useAgentStore.getState().tasksById[task.task_id]?.lastSequence ??
            task.latest_sequence;
          this.transport.subscribe(task.task_id, lastSequence);
        }
      }
    })();

    this.taskHistoryExpansion = expansion;
    const clear = () => {
      if (this.taskHistoryExpansion === expansion) {
        this.taskHistoryExpansion = null;
      }
    };
    void expansion.then(clear, clear);
    return expansion;
  }

  refreshTaskHistory(): Promise<void> {
    return this.loadTaskHistory();
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
