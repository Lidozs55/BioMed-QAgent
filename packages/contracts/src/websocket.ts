export type WebSocketCommand =
  | { type: "subscribe"; task_id: string; after_sequence: number }
  | { type: "unsubscribe"; task_id: string }
  | { type: "ping" };

export type WebSocketControlFrame =
  | { type: "pong" }
  | { type: "error"; code: string; message: string; task_id?: string };

export interface AssistantStreamDeltaFrame {
  type: "assistant_stream_delta";
  task_id: string;
  run_id: string;
  stream_id: string;
  chunk_index: number;
  delta: string;
}

export interface AssistantStreamEndFrame {
  type: "assistant_stream_end";
  task_id: string;
  run_id: string;
  stream_id: string;
  last_chunk_index: number | null;
  finish_reason: string;
}

export type AssistantStreamFrame =
  | AssistantStreamDeltaFrame
  | AssistantStreamEndFrame;
