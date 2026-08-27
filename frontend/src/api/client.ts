/**
 * Composite API client — composes the per-endpoint clients into the full
 * surface (``APIClient`` + ``SettingsAPIClient``) used by ``useAPI()``.
 */
import { createPublicationsApi, type PublicationsApi } from "@/api/publications";
import { createDatabasesApi } from "@/api/databases";
import { createHttp, type HttpOptions } from "@/api/http";
import { createModelRegistryApi } from "@/api/modelRegistry";
import { createSettingsApi } from "@/api/settings";
import { createTasksApi, type TasksApi } from "@/api/tasks";
import type { SettingsAPIClient } from "@/api/types";
import type { DatabaseRecord } from "@biomed/contracts";

/**
 * Task/build/artifact surface — kept as a stable union type so partial
 * mocks in tests that target ``APIClient`` keep type-checking.
 */
export interface APIClient extends TasksApi, PublicationsApi {
  fetchDatabases: () => Promise<DatabaseRecord[]>;
}

export function createAPIClient(options: HttpOptions = {}): APIClient & SettingsAPIClient {
  const http = createHttp(options);
  return {
    ...createTasksApi(http),
    ...createPublicationsApi(http),
    ...createSettingsApi(http),
    ...createModelRegistryApi(http),
    ...createDatabasesApi(http),
  };
}