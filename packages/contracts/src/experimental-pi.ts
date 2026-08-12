export interface ExperimentalPiTaskCreateRequest {
  input: string;
  fixture_profile?: string | null;
}

export interface ExperimentalPiRunCreateRequest {
  input: string;
}

export interface ExperimentalPiTaskAccepted {
  task_id: string;
  run_id: string;
  session_id: string;
  status: "running";
  durable: false;
}

export type ExperimentalPiRunAccepted = ExperimentalPiTaskAccepted;

export interface ExperimentalPiCancelAccepted {
  task_id: string;
  run_id: string;
  status: "cancel_requested";
}

export type ExperimentalPiWebSocketCommand =
  | { type: "subscribe"; task_id: string }
  | { type: "unsubscribe"; task_id: string }
  | { type: "ping" };

export type ExperimentalPiWebSocketErrorCode =
  | "experimental_replay_unavailable"
  | "invalid_command"
  | "task_not_found"
  | "slow_subscriber";

export type ExperimentalPiWebSocketControlFrame =
  | { type: "pong" }
  | { type: "subscribed"; task_id: string }
  | { type: "unsubscribed"; task_id: string }
  | {
      type: "error";
      code: ExperimentalPiWebSocketErrorCode;
      message: string;
      task_id?: string;
    };
