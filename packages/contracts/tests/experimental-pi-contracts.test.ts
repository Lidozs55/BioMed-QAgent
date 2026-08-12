import { describe, expectTypeOf, it } from "vitest";

import type {
  ExperimentalPiCancelAccepted,
  ExperimentalPiRunAccepted,
  ExperimentalPiRunCreateRequest,
  ExperimentalPiTaskAccepted,
  ExperimentalPiTaskCreateRequest,
  ExperimentalPiWebSocketCommand,
  ExperimentalPiWebSocketControlFrame,
  EventEnvelope,
} from "../src/index";

describe("experimental Pi shared wire contracts", () => {
  it("keeps HTTP and WebSocket DTOs in the shared package", () => {
    expectTypeOf<ExperimentalPiTaskCreateRequest>().toMatchTypeOf<{
      input: string;
      fixture_profile?: string | null;
    }>();
    expectTypeOf<ExperimentalPiRunCreateRequest>().toEqualTypeOf<{ input: string }>();
    expectTypeOf<ExperimentalPiTaskAccepted>().toMatchTypeOf<{
      task_id: string;
      run_id: string;
      session_id: string;
      status: "running";
    }>();
    expectTypeOf<ExperimentalPiRunAccepted>().toMatchTypeOf<{
      task_id: string;
      run_id: string;
      session_id: string;
      status: "running";
    }>();
    expectTypeOf<ExperimentalPiCancelAccepted>().toMatchTypeOf<{
      task_id: string;
      run_id: string;
      status: "cancel_requested";
    }>();
    expectTypeOf<ExperimentalPiWebSocketCommand>().toMatchTypeOf<
      | { type: "subscribe"; task_id: string }
      | { type: "unsubscribe"; task_id: string }
      | { type: "ping" }
    >();
    expectTypeOf<ExperimentalPiWebSocketControlFrame>().toMatchTypeOf<
      | { type: "pong" }
      | { type: "subscribed"; task_id: string }
      | { type: "unsubscribed"; task_id: string }
      | {
          type: "error";
          code: string;
          message: string;
          task_id?: string;
        }
    >();
    expectTypeOf<EventEnvelope>().not.toBeNever();
  });
});
