import type { APIClient } from "@/hooks/useAPI";
import {
  clearTaskProjection,
  loadTaskProjection,
  saveTaskProjection,
} from "@/runtime/hydrationCache";
import type {
  ContinueTaskInput,
  DownloadResumeAccepted,
  ResumeRunInput,
  StartTaskInput,
  TaskPage,
  TaskRunAccepted,
  TaskSnapshot,
} from "./contracts";
import type { DownloadResumeRequest } from "./types";
import { errorMessage } from "@/lib/utils";
import {
  addAcceptedTask,
  mergeTaskArtifacts,
  useAgentStore,
} from "@/stores/agentStore";

const TASK_PAGE_SIZE = 10;
const EVENT_REPLAY_PAGE_SIZE = 1000;
//: Cold hydration replays only the tail of the event log. Anything older than
//: the window is not re-reduced; earlier messages stay reachable through the
//: snapshot's ``older_messages_cursor`` pagination. Keeps opening a long
//: session bounded instead of re-applying every event since sequence 1.
const EVENT_REPLAY_WINDOW_SIZE = 3000;

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

  /** Refresh the enabled database list (task picker) from the thin store. */
  refreshDatabases(signal?: AbortSignal): Promise<void> {
    return this.api.fetchDatabases().then((databases) => {
      if (signal?.aborted) return;
      const state = useAgentStore.getState();
      const enabled = databases.filter((database) => database.enabled !== false);
      state.setDatabases(enabled);
      if (state.draft.selectedDatabaseIds.length === 0) {
        state.setDraftSelectedDatabaseIds(
          enabled.map((database) => database.id),
        );
      }
    });
  }

  start(signal?: AbortSignal) {
    const databasePromise = this.refreshDatabases(signal);
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
          .setHistoryState("error", errorMessage(error));
      }
      throw error;
    }
  }

  async selectTask(taskId: string): Promise<void> {
    const generation = ++this.foregroundIntentGeneration;
    const previousActiveTaskId = useAgentStore.getState().activeTaskId;
    const task = useAgentStore.getState().tasksById[taskId];
    if (task !== undefined && task.hydration !== "snapshot") {
      // Only a cold selection needs the loading screen; already-hydrated
      // tasks render instantly and must not flash a loading page.
      useAgentStore.getState().setHydratingTaskId(taskId);
    }
    if (!this.deletedTaskIds.has(taskId) && task !== undefined) {
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
    } finally {
      this.finishTaskHydration(taskId);
    }
  }

  private finishTaskHydration(taskId: string): void {
    if (useAgentStore.getState().hydratingTaskId === taskId) {
      useAgentStore.getState().setHydratingTaskId(null);
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
        const cached = loadTaskProjection(taskId);
        if (cached !== null) {
          useAgentStore.getState().restoreTaskProjection(taskId, cached);
        } else {
          useAgentStore.getState().prepareTaskSnapshotReplay(snapshot);
        }
      }
      await this.replayTaskEvents(taskId, snapshot.task.latest_sequence);
      if (!this.isCurrentTaskHandoff(taskId, generation)) return false;
      useAgentStore.getState().hydrateTaskSnapshot(snapshot);
      this.persistTaskProjection(taskId);
      // F1 (final review): resume the live subscription only while the task
      // is still active after hydration — the same shouldSubscribe check the
      // transport applies to live terminal events. Selecting a terminal
      // history task (or one that terminalized while the snapshot was being
      // fetched) must not leave a permanent desired subscription that is
      // never reconciled. continueTask explicitly re-subscribes when a new
      // run is accepted.
      if (useAgentStore.getState().activeItems.includes(taskId)) {
        const lastSequence =
          useAgentStore.getState().tasksById[taskId]?.lastSequence ??
          snapshot.task.latest_sequence;
        this.transport.subscribe(taskId, lastSequence);
      }
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

  private persistTaskProjection(taskId: string): void {
    const task = useAgentStore.getState().tasksById[taskId];
    if (task !== undefined && task.hydration === "snapshot") {
      saveTaskProjection(task);
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
    // Window the cold replay: only reduce the tail of the event log. Advance
    // lastSequence to the window lower edge so the reducer's contiguity check
    // (``sequence > lastSequence + 1``) does not misread the window's first
    // event as a dropped frame; the snapshot's ``older_messages_cursor`` then
    // backfills anything older on demand.
    const windowLow = Math.max(0, targetSequence - EVENT_REPLAY_WINDOW_SIZE + 1);
    if (afterSequence < windowLow) {
      useAgentStore.setState((state) => {
        const current = state.tasksById[taskId];
        if (current === undefined) return state;
        return {
          tasksById: {
            ...state.tasksById,
            [taskId]: { ...current, lastSequence: windowLow - 1 },
          },
        };
      });
      afterSequence = windowLow - 1;
    }
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
    this.persistTaskProjection(accepted.task_id);
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

  async startImportTask(
    files: File[],
    note?: string,
  ): Promise<TaskRunAccepted> {
    const foregroundIntentGeneration = ++this.foregroundIntentGeneration;
    const accepted = await this.api.startImportTask({ files, note });
    const importInput: StartTaskInput = {
      input:
        note && note.trim().length > 0
          ? note.trim()
          : `Import ${files.length} file(s) into local cache`,
      databases: [],
      mode: "import",
    };
    const { generation, hydrateArtifacts } = await this.enqueueTaskHandoff(
      accepted.task_id,
      async () => {
        const generation = this.advanceTaskHandoffGeneration(accepted.task_id);
        const hydrateArtifacts = await this.performAcceptedTaskHandoff(
          accepted,
          importInput,
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
      // A continued task may have been unsubscribed when its previous run
      // became terminal; restore the live subscription so the new run's
      // events keep flowing.
      const lastSequence =
        useAgentStore.getState().tasksById[accepted.task_id]?.lastSequence ?? 0;
      this.transport.subscribe(accepted.task_id, lastSequence);
    });
    return accepted;
  }

  /**
   * Authoritative REST fallback for a permanent sequence gap (F2, final
   * review): rebuild the task from its server snapshot — which clears the
   * recoverable gap marker and advances the cursor to the snapshot
   * watermark — then resume the live subscription after that watermark so
   * the undeliverable frame is skipped and later valid events apply. The
   * transport fires ``onPermanentGap`` at most once per gap position.
   */
  async hydrateTaskFromGap(taskId: string): Promise<void> {
    const snapshot = await this.api.fetchTask(taskId);
    useAgentStore.getState().hydrateTaskSnapshot(snapshot);
    const lastSequence =
      useAgentStore.getState().tasksById[taskId]?.lastSequence ??
      snapshot.task.latest_sequence;
    await this.transport.recoverSubscription(taskId, lastSequence);
  }

  /**
   * Resumes an interrupted download directly without an AI pass (the server
   * re-invokes the acquisition tool on its part file). The follow-up run's
   * events flow through the same subscription; the user then sends "继续" to
   * start a normal AI run for the remaining analysis.
   */
  async resumeDownload(
    taskId: string,
    input: DownloadResumeRequest,
  ): Promise<DownloadResumeAccepted> {
    const accepted = await this.api.resumeDownload(taskId, {
      run_id: input.runId,
      tool_call_id: input.toolCallId,
      tool_name: input.toolName,
      arguments: input.arguments ?? {},
    });
    // The download replays progress/completion onto the original run's event
    // stream, so no new run projection or user message is created. Make sure
    // the task keeps its live event subscription (it may have been dropped
    // when the host run went terminal).
    const existingTask = useAgentStore.getState().tasksById[accepted.task_id];
    const lastSequence = existingTask?.lastSequence ?? 0;
    this.transport.subscribe(accepted.task_id, lastSequence);
    return accepted;
  }

  /** Abort the task's in-flight standalone download (if any). */
  async cancelDownload(taskId: string): Promise<void> {
    await this.api.cancelDownload(taskId);
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

  async cancelSubagent(
    taskId: string,
    runId: string,
    subagentId: string,
  ): Promise<void> {
    await this.enqueueTaskHandoff(taskId, async () => {
      const generation = this.advanceTaskHandoffGeneration(taskId);
      const snapshot = await this.api.cancelSubagent(
        taskId,
        runId,
        subagentId,
      );
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

  /** Resolve a suspended permission request (plan §32). */
  async resolvePermission(
    taskId: string,
    runId: string,
    requestId: string,
    decision: "allow" | "deny",
    grantScope?: "once" | "run" | "task" | "persistent",
    scopeWide?: boolean,
  ): Promise<void> {
    await this.enqueueTaskHandoff(taskId, async () => {
      const generation = this.advanceTaskHandoffGeneration(taskId);
      await this.api.resolvePermission(taskId, runId, requestId, decision, grantScope, scopeWide);
      if (this.taskHandoffGenerations.get(taskId) !== generation) return;
      // The durable permission_resolved event (via WS) clears the pending
      // card; refetching the snapshot here would race the event ordering.
    });
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.api.deleteTask(taskId);
    clearTaskProjection(taskId);
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

  loadMoreTasks(): Promise<void> {
    const cursor = useAgentStore.getState().nextCursor;
    if (cursor === null) return Promise.resolve();
    if (this.taskHistoryExpansion !== null) return this.taskHistoryExpansion;

    const expansion = (async () => {
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
