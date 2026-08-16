export type WorkspaceOperation = "read" | "list" | "search" | "write" | "edit" | "exec";

export type WorkspaceErrorCode =
  | "INVALID_IDENTITY"
  | "INVALID_PATH"
  | "PATH_ESCAPE"
  | "PATH_NOT_ALLOWED"
  | "NOT_FOUND"
  | "NOT_TEXT"
  | "LIMIT_EXCEEDED"
  | "PRECONDITION_FAILED"
  | "EXEC_DISABLED"
  | "EXEC_POLICY_REJECTED"
  | "WORKSPACE_DISPOSED";

export class WorkspacePolicyError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspacePolicyError";
  }
}
export interface WorkspaceLimits {
  maxReadBytes: number;
  maxReadCharacters: number;
  maxListDepth: number;
  maxListEntries: number;
  maxSearchFileBytes: number;
  maxSearchFiles: number;
  maxSearchResults: number;
  maxSearchLineChars: number;
  maxSearchOutputChars: number;
  maxWriteBytes: number;
  maxExecOutputBytes: number;
  maxExecTimeoutMs: number;
}

export interface WorkspaceReadResult {
  path: string;
  text: string;
  offset: number;
  characters: number;
  truncated: boolean;
}

export interface WorkspaceListEntry {
  path: string;
  type: "file" | "directory" | "link";
  size?: number;
}

export interface WorkspaceListResult {
  path: string;
  entries: WorkspaceListEntry[];
  truncated: boolean;
}

export interface WorkspaceSearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface WorkspaceSearchResult {
  path: string;
  query: string;
  matches: WorkspaceSearchMatch[];
  filesScanned: number;
  truncated: boolean;
}

export interface WorkspaceWriteResult {
  path: string;
  bytes: number;
  created: boolean;
}

export interface WorkspaceEditResult {
  path: string;
  replacements: number;
  bytes: number;
}

export interface WorkspaceExecResult {
  command: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  policy: "allowed" | "disabled" | "rejected";
}
