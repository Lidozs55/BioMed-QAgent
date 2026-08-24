import { afterEach, describe, expect, test, vi } from "vitest";

import { BioMedAgentError } from "../src/agent/contracts.js";
import {
  PiAgentAdapter,
  applyModelProfileToPayload,
  resolvePiCompactionOverrides,
  toPiCustomTools,
  type PiUpstreamEvent,
  type PiUpstreamSession,
} from "../src/agent/pi-adapter.js";
import { PHASE1_SYSTEM_PROMPT } from "../src/agent/phase1-prompt.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeUpstreamSession implements PiUpstreamSession {
  readonly sessionId = "pi-session-7";
  readonly prompts: string[] = [];
  readonly abort = vi.fn(async (): Promise<void> => undefined);
  readonly dispose = vi.fn();
  private readonly listeners = new Set<(event: PiUpstreamEvent) => void>();
  promptImplementation: (input: string) => Promise<void> = async () => undefined;
  continueAfterLengthImplementation: () => Promise<void> = async () => undefined;
  readonly continueAfterLength = vi.fn(
    async (): Promise<void> => this.continueAfterLengthImplementation(),
  );

  get listenerCount(): number {
    return this.listeners.size;
  }

  async prompt(input: string): Promise<void> {
    this.prompts.push(input);
    await this.promptImplementation(input);
  }

  subscribe(listener: (event: PiUpstreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: PiUpstreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

const sessionConfig = {
  taskId: "task-7",
  runId: "run-7",
  cwd: process.cwd(),
} as const;

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("Pi system prompt", () => {
  test("forbids synthetic replacement data and limits unavailable-source choices", () => {
    expect(PHASE1_SYSTEM_PROMPT).toMatch(/never fabricate, simulate, approximate, infer, or use representative values/i);
    expect(PHASE1_SYSTEM_PROMPT).toMatch(/stop and report the unavailable source/i);
    expect(PHASE1_SYSTEM_PROMPT).toMatch(/request concrete user help/i);
    expect(PHASE1_SYSTEM_PROMPT).toMatch(/continue researching a genuinely independent real source/i);
    expect(PHASE1_SYSTEM_PROMPT).toMatch(/do not create replacement rows or fill missing values from model memory/i);
    expect(PHASE1_SYSTEM_PROMPT).toMatch(/partial tool success verifies only the records returned as successful/i);
    expect(PHASE1_SYSTEM_PROMPT).toMatch(/never claim full-source or whole-dataset verification from a successful subset/i);
  });

  test("marks an approved max-turn continuation explicitly", () => {
    expect(PHASE1_SYSTEM_PROMPT).toContain("[MAX_TURNS_REACHED]");
    expect(PHASE1_SYSTEM_PROMPT).toMatch(/after an approved max-turn interruption/i);
  });

  test("delegates source-specific topology and evidence rules to skills", () => {
    expect(PHASE1_SYSTEM_PROMPT).toMatch(/matching skill/i);
    expect(PHASE1_SYSTEM_PROMPT).toMatch(/source-specific rules/i);
    expect(PHASE1_SYSTEM_PROMPT).toMatch(/Do not duplicate or improvise/i);
  });
});

describe("Pi model profile mapping", () => {
  test("maps portable and DashScope-specific parameters", () => {
    expect(applyModelProfileToPayload(
      { model: "qwen-plus", messages: [] },
      {
        provider: "dashscope",
        modelId: "qwen-plus",
        apiKey: "secret",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        topP: 0.8,
        repetitionPenalty: 1.1,
        enableSearch: true,
        thinkingMode: true,
      },
    )).toEqual({
      model: "qwen-plus",
      messages: [],
      top_p: 0.8,
      repetition_penalty: 1.1,
      enable_search: true,
      enable_thinking: true,
    });
  });

  test("does not leak DashScope-only parameters to custom providers", () => {
    expect(applyModelProfileToPayload(
      { model: "custom-chat" },
      {
        provider: "custom",
        modelId: "custom-chat",
        apiKey: "secret",
        baseUrl: "https://models.example/v1",
        topP: 0.75,
        repetitionPenalty: 1.2,
        enableSearch: true,
        thinkingMode: true,
      },
    )).toEqual({ model: "custom-chat", top_p: 0.75 });
  });
});
describe("PiAgentAdapter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("maps product compaction ratios onto Pi compaction settings", () => {
    expect(resolvePiCompactionOverrides(131_072, 0.85, 0.6)).toEqual({
      compaction: { enabled: true, reserveTokens: 19_661, keepRecentTokens: 78_643 },
    });
    expect(resolvePiCompactionOverrides(131_072, 0.95, 0.6).compaction.reserveTokens)
      .toBe(6_554);
  });

  test("projects a successful Pi compaction into the BioMed event stream", async () => {
    const upstream = new FakeUpstreamSession();
    upstream.promptImplementation = async () => {
      upstream.emit({ type: "compaction_start", reason: "threshold" });
      upstream.emit({
        type: "compaction_end",
        reason: "threshold",
        compactionResult: { summary: "compacted checkpoint summary" },
        aborted: false,
      });
    };
    const session = await new PiAgentAdapter({
      createUpstreamSession: async () => upstream,
    }).createSession(sessionConfig);

    const events = await collect(session.run("continue"));

    expect(events).toContainEqual({
      type: "context_compacted",
      summary: "compacted checkpoint summary",
    });
  });

  test("accepts a minimal input and publishes runtime context usage", async () => {
    const upstream = new FakeUpstreamSession();
    upstream.promptImplementation = async () => {
      upstream.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "OK" },
      });
      upstream.emit({
        type: "message_end",
        assistantStopReason: "stop",
        contextUsage: { tokens: 12_345, contextWindow: 131_072, percent: 9.41 },
      });
    };
    const session = await new PiAgentAdapter({
      createUpstreamSession: async () => upstream,
    }).createSession(sessionConfig);

    const events = await collect(session.run("请只回复 OK"));

    expect(events).toEqual([
      { type: "turn_started" },
      { type: "assistant_delta", delta: "OK" },
      {
        type: "context_usage",
        tokens: 12_345,
        contextWindow: 131_072,
        percent: 9.41,
        source: "runtime",
      },
      { type: "turn_completed" },
    ]);
  });

  test("continues a length-truncated Pi turn before reporting completion", async () => {
    const upstream = new FakeUpstreamSession();
    upstream.promptImplementation = async () => {
      const lengthEnd = {
        type: "message_end",
        assistantStopReason: "length",
      };
      upstream.emit(lengthEnd);
    };
    upstream.continueAfterLengthImplementation = async () => {
      const completedEnd = {
        type: "message_end",
        assistantStopReason: "stop",
      };
      upstream.emit(completedEnd);
    };
    const session = await new PiAgentAdapter({
      createUpstreamSession: async () => upstream,
    }).createSession(sessionConfig);

    const events = await collect(session.run("finish the dataset"));

    expect(upstream.continueAfterLength).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
  });

  test("fails the turn when Pi ends with an upstream error stop reason", async () => {
    const upstream = new FakeUpstreamSession();
    upstream.promptImplementation = async () => {
      upstream.emit({ type: "message_end", assistantStopReason: "error" });
    };
    const session = await new PiAgentAdapter({
      createUpstreamSession: async () => upstream,
    }).createSession(sessionConfig);

    await expect(collect(session.run("finish the dataset")))
      .rejects.toThrow("Agent runtime request failed");
  });

  test("ignores aborted or summary-less Pi compaction completions", async () => {
    const upstream = new FakeUpstreamSession();
    upstream.promptImplementation = async () => {
      upstream.emit({ type: "compaction_end", reason: "overflow", aborted: true });
      upstream.emit({
        type: "compaction_end",
        reason: "threshold",
        compactionResult: { summary: "" },
        aborted: false,
      });
    };
    const session = await new PiAgentAdapter({
      createUpstreamSession: async () => upstream,
    }).createSession(sessionConfig);

    const events = await collect(session.run("continue"));

    expect(events).not.toContainEqual(expect.objectContaining({ type: "context_compacted" }));
  });

  test("converts project tool descriptors only at the Pi boundary", async () => {
    const execute = vi.fn(async () => ({
      content: "bounded",
      details: { path: "parsed/data.txt" },
    }));
    const [tool] = toPiCustomTools([
      {
        name: "workspace_read",
        label: "Read Workspace text",
        description: "Read bounded text",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        execute,
      },
    ]);

    const result = await Reflect.apply(tool!.execute, undefined, [
      "call-1",
      { path: "parsed/data.txt" },
      undefined,
      undefined,
      undefined,
    ]);

    expect(execute).toHaveBeenCalledWith(
      { path: "parsed/data.txt" },
      undefined,
      { toolCallId: "call-1" },
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "bounded" }],
      details: { path: "parsed/data.txt" },
    });
  });

  test("streams assistant and tool events through the bounded BioMed union", async () => {
    const upstream = new FakeUpstreamSession();
    upstream.promptImplementation = async () => {
      upstream.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hello" },
      });
      upstream.emit({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "fixture_tool",
        args: { query: "TP53" },
      });
      upstream.emit({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "fixture_tool",
        result: { content: "done" },
        isError: false,
      });
    };
    const adapter = new PiAgentAdapter({
      createUpstreamSession: vi.fn(async () => upstream),
    });
    const session = await adapter.createSession(sessionConfig);

    const events = await collect(session.run("first turn"));

    expect(session.piSessionId).toBe("pi-session-7");
    expect(session.taskId).toBe("task-7");
    expect(session.runId).toBe("run-7");
    expect(events).toEqual([
      { type: "turn_started" },
      { type: "assistant_delta", delta: "hello" },
      {
        type: "tool_started",
        toolCallId: "call-1",
        toolName: "fixture_tool",
        arguments: { query: "TP53" },
      },
      {
        type: "tool_completed",
        toolCallId: "call-1",
        toolName: "fixture_tool",
        result: { content: "done" },
        isError: false,
      },
      { type: "turn_completed" },
    ]);
  });

  test("coalesces adjacent deltas while preserving type and tool boundaries", async () => {
    const upstream = new FakeUpstreamSession();
    upstream.promptImplementation = async () => {
      upstream.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hel" },
      });
      upstream.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "lo" },
      });
      upstream.emit({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "plan" },
      });
      upstream.emit({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: " first" },
      });
      upstream.emit({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "fixture_tool",
        args: { query: "TP53" },
      });
    };
    const session = await new PiAgentAdapter({
      createUpstreamSession: async () => upstream,
    }).createSession(sessionConfig);

    const events = await collect(session.run("coalesce"));

    expect(events).toEqual([
      { type: "turn_started" },
      { type: "assistant_delta", delta: "hello" },
      { type: "reasoning_delta", delta: "plan first" },
      {
        type: "tool_started",
        toolCallId: "call-1",
        toolName: "fixture_tool",
        arguments: { query: "TP53" },
      },
      { type: "turn_completed" },
    ]);
  });

  test("flushes a pending delta after the bounded streaming interval", async () => {
    vi.useFakeTimers();
    const upstream = new FakeUpstreamSession();
    const pending = deferred<void>();
    upstream.promptImplementation = () => pending.promise;
    const session = await new PiAgentAdapter({
      createUpstreamSession: async () => upstream,
    }).createSession(sessionConfig);
    const iterator = session.run("timed flush")[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "turn_started" },
    });

    const delta = iterator.next();
    upstream.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "a" },
    });
    upstream.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "b" },
    });
    await vi.advanceTimersByTimeAsync(32);

    await expect(delta).resolves.toEqual({
      done: false,
      value: { type: "assistant_delta", delta: "ab" },
    });
    pending.resolve();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "turn_completed" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test("starts a new delta event before the coalesced payload exceeds 4096 characters", async () => {
    const upstream = new FakeUpstreamSession();
    upstream.promptImplementation = async () => {
      upstream.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "a".repeat(4_090) },
      });
      upstream.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "b".repeat(10) },
      });
    };
    const session = await new PiAgentAdapter({
      createUpstreamSession: async () => upstream,
    }).createSession(sessionConfig);

    const events = await collect(session.run("bounded coalescing"));

    expect(events).toEqual([
      { type: "turn_started" },
      { type: "assistant_delta", delta: "a".repeat(4_090) },
      { type: "assistant_delta", delta: "b".repeat(10) },
      { type: "turn_completed" },
    ]);
  });

  test("preserves one upstream session across sequential turns", async () => {
    const upstream = new FakeUpstreamSession();
    const createUpstreamSession = vi.fn(async () => upstream);
    const session = await new PiAgentAdapter({ createUpstreamSession }).createSession(
      sessionConfig,
    );

    await collect(session.run("one"));
    await collect(session.run("two"));

    expect(createUpstreamSession).toHaveBeenCalledOnce();
    expect(upstream.prompts).toEqual(["one", "two"]);
  });

  test("rejects concurrent turns deterministically", async () => {
    const upstream = new FakeUpstreamSession();
    const pending = deferred<void>();
    upstream.promptImplementation = () => pending.promise;
    const session = await new PiAgentAdapter({
      createUpstreamSession: async () => upstream,
    }).createSession(sessionConfig);
    const firstIterator = session.run("one")[Symbol.asyncIterator]();
    await expect(firstIterator.next()).resolves.toEqual({
      done: false,
      value: { type: "turn_started" },
    });

    await expect(collect(session.run("two"))).rejects.toMatchObject({
      code: "SESSION_BUSY",
    });

    pending.resolve();
    await firstIterator.return?.();
  });

  test("translates upstream failures without leaking provider details", async () => {
    const upstream = new FakeUpstreamSession();
    upstream.promptImplementation = async () => {
      upstream.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "visible before failure" },
      });
      throw new Error("Bearer secret-token failed at provider stack");
    };
    const session = await new PiAgentAdapter({
      createUpstreamSession: async () => upstream,
    }).createSession(sessionConfig);
    const iterator = session.run("fail")[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "turn_started" },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "assistant_delta", delta: "visible before failure" },
    });
    const error = await iterator.next().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(BioMedAgentError);
    expect(error).toMatchObject({ code: "UPSTREAM_FAILURE" });
    expect((error as Error).message).toBe("Agent runtime request failed");
    expect((error as Error).message).not.toContain("secret-token");
  });

  test("cancels an active turn without reporting normal completion", async () => {
    const upstream = new FakeUpstreamSession();
    const pending = deferred<void>();
    upstream.promptImplementation = () => pending.promise;
    upstream.abort.mockImplementation(async () => pending.resolve());
    const session = await new PiAgentAdapter({
      createUpstreamSession: async () => upstream,
    }).createSession(sessionConfig);
    const eventsPromise = collect(session.run("cancel me"));
    await Promise.resolve();
    upstream.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "visible before cancel" },
    });

    await session.cancel("user requested");
    const events = await eventsPromise;

    expect(upstream.abort).toHaveBeenCalledOnce();
    expect(events).toEqual([
      { type: "turn_started" },
      { type: "assistant_delta", delta: "visible before cancel" },
      { type: "turn_cancelled", reason: "user requested" },
    ]);
    expect(events).not.toContainEqual({ type: "turn_completed" });
  });

  test("reports upstream abort rejection as failure instead of cancellation", async () => {
    const upstream = new FakeUpstreamSession();
    const pending = deferred<void>();
    upstream.promptImplementation = () => pending.promise;
    upstream.abort.mockRejectedValue(new Error("provider abort failed"));
    const session = await new PiAgentAdapter({
      createUpstreamSession: async () => upstream,
    }).createSession(sessionConfig);
    const eventsPromise = collect(session.run("cancel me")).catch(
      (reason: unknown) => reason,
    );
    await Promise.resolve();

    await expect(session.cancel("user requested")).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
    });
    const result = await eventsPromise;

    expect(result).toMatchObject({ code: "UPSTREAM_FAILURE" });
    expect(result).not.toEqual(
      expect.arrayContaining([{ type: "turn_cancelled", reason: "user requested" }]),
    );
  });

  test("aborts upstream work when the event consumer stops early", async () => {
    const upstream = new FakeUpstreamSession();
    const pending = deferred<void>();
    upstream.promptImplementation = () => pending.promise;
    upstream.abort.mockImplementation(async () => pending.resolve());
    const session = await new PiAgentAdapter({
      createUpstreamSession: async () => upstream,
    }).createSession(sessionConfig);
    const iterator = session.run("stop consuming")[Symbol.asyncIterator]();
    await iterator.next();

    await iterator.return?.();

    expect(upstream.abort).toHaveBeenCalledOnce();
  });

  test("dispose is idempotent and removes the upstream listener", async () => {
    const upstream = new FakeUpstreamSession();
    const session = await new PiAgentAdapter({
      createUpstreamSession: async () => upstream,
    }).createSession(sessionConfig);
    expect(upstream.listenerCount).toBe(1);

    await session.dispose();
    await session.dispose();

    expect(upstream.listenerCount).toBe(0);
    expect(upstream.dispose).toHaveBeenCalledOnce();
  });

  test("session disposal invokes the project lifecycle cleanup once", async () => {
    const upstream = new FakeUpstreamSession();
    const cleanup = vi.fn(async () => undefined);
    const session = await new PiAgentAdapter({
      createUpstreamSession: async () => upstream,
    }).createSession({ ...sessionConfig, cleanup });

    await session.dispose();
    await session.dispose();

    expect(cleanup).toHaveBeenCalledOnce();
  });

  test("invalid session configuration invokes project lifecycle cleanup", async () => {
    const cleanup = vi.fn(async () => undefined);
    const adapter = new PiAgentAdapter({
      createUpstreamSession: vi.fn(async () => new FakeUpstreamSession()),
    });

    await expect(
      adapter.createSession({ ...sessionConfig, cwd: "relative", cleanup }),
    ).rejects.toMatchObject({ code: "INVALID_SESSION_CONFIG" });

    expect(cleanup).toHaveBeenCalledOnce();
  });

  test("missing model credentials fail only when real session creation is requested", async () => {
    const adapter = new PiAgentAdapter({ environment: {} });

    await expect(adapter.createSession(sessionConfig)).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
    });
  });
});
