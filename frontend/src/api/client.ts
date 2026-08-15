/**
 * Composite API client — composes the per-endpoint clients into the full
 * surface (``APIClient`` + ``SettingsAPIClient``) used by ``useAPI()``.
 */
import { createBuildsApi, type BuildsApi } from "@/api/builds";
import { createDatabasesApi, type DatabasesApi } from "@/api/databases";
import { createHttp, type HttpOptions } from "@/api/http";
import { createModelRegistryApi, type ModelRegistryApi } from "@/api/modelRegistry";
import { createSettingsApi, type SettingsApi } from "@/api/settings";
import { createTasksApi, type TasksApi } from "@/api/tasks";
import type { SettingsAPIClient } from "@/api/types";

export interface APIClient extends TasksApi, BuildsApi, SettingsApi, ModelRegistryApi, DatabasesApi {}

export function createAPIClient(options: HttpOptions = {}): APIClient & SettingsAPIClient {
  const http = createHttp(options);
  return {
    ...createTasksApi(http),
    ...createBuildsApi(http),
    ...createSettingsApi(http),
    ...createModelRegistryApi(http),
    ...createDatabasesApi(http),
  };
}