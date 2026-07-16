/** Database record returned by the API */
export interface DatabaseRecord {
  id: string;
  name: string;
  category: string;
  description: string;
}

/** Task status returned by the API */
export interface TaskStatus {
  task_id: string;
  status: string;
  current_stage: string | null;
  validation_status: string | null;
  artifact_count: number;
  mode: string | null;
  live_accepted: boolean | null;
}

export interface CreatedTask {
  task_id: string;
  status: string;
}

/** Artifact record returned by the API */
export interface ArtifactRecord {
  artifact_id: string;
  name: string;
  size: number;
  sha256: string;
  media_type: string;
}

/**
 * HTTP API hook for databases, tasks, and artifacts.
 * Complements the WebSocket hook (useAgentStream) with REST endpoints.
 */
export function useAPI() {
  const BASE = "/api/v1";

  const request = useCallback(async function request<T>(
    url: string,
    init?: RequestInit,
  ): Promise<T> {
    const res = await fetch(url, init);
    if (!res.ok) {
      throw new Error(`API error ${res.status}: ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  }, []);

  /** Fetch available databases */
  const fetchDatabases = useCallback((): Promise<DatabaseRecord[]> =>
    request<{ databases: DatabaseRecord[] }>(`${BASE}/databases`).then(
      (data) => data.databases,
    ), [request]);

  const createTask = useCallback(
    (topic: string, databases: string[]): Promise<CreatedTask> =>
      request<CreatedTask>(`${BASE}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, databases, mode: "fixture" }),
      }),
    [request],
  );

  /** Fetch task status by ID */
  const fetchTaskStatus = useCallback(
    (taskId: string): Promise<TaskStatus> =>
      request<TaskStatus>(`${BASE}/tasks/${encodeURIComponent(taskId)}`),
    [request],
  );

  /** Fetch artifacts for a task */
  const fetchArtifacts = useCallback(
    (taskId: string): Promise<ArtifactRecord[]> =>
      request<{ artifacts: ArtifactRecord[] }>(
        `${BASE}/tasks/${encodeURIComponent(taskId)}/artifacts`,
      ).then((data) => data.artifacts),
    [request],
  );

  /** Build the download URL for an artifact */
  const getArtifactUrl = useCallback(
    (taskId: string, artifactId: string): string =>
      `${BASE}/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`,
    [],
  );

  return {
    createTask,
    fetchDatabases,
    fetchTaskStatus,
    fetchArtifacts,
    getArtifactUrl,
  };
}
import { useCallback } from "react";
