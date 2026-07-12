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
  directories?: string[];
}

/** Artifact record returned by the API */
export interface ArtifactRecord {
  name: string;
  size: number;
  path: string;
}

/**
 * HTTP API hook for databases, tasks, and artifacts.
 * Complements the WebSocket hook (useAgentStream) with REST endpoints.
 */
export function useAPI() {
  const BASE = "/api/v1";

  async function request<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`API error ${res.status}: ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  /** Fetch available databases */
  const fetchDatabases = (): Promise<DatabaseRecord[]> =>
    request<{ databases: DatabaseRecord[] }>(`${BASE}/databases`).then(
      (data) => data.databases,
    );

  /** Fetch task status by ID */
  const fetchTaskStatus = (taskId: string): Promise<TaskStatus> =>
    request<TaskStatus>(`${BASE}/tasks/${encodeURIComponent(taskId)}`);

  /** Fetch artifacts for a task */
  const fetchArtifacts = (taskId: string): Promise<ArtifactRecord[]> =>
    request<{ artifacts: ArtifactRecord[] }>(
      `${BASE}/tasks/${encodeURIComponent(taskId)}/artifacts`,
    ).then((data) => data.artifacts);

  /** Build the download URL for an artifact */
  const getArtifactUrl = (taskId: string, artifactName: string): string =>
    `${BASE}/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactName)}`;

  return { fetchDatabases, fetchTaskStatus, fetchArtifacts, getArtifactUrl };
}
