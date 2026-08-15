/**
 * Declarative database API client (``/api/v1/databases``).
 */
import type { Http } from "@/api/http";
import { parseDatabaseDetail, parseDatabasesEnvelope } from "@/lib/apiEnvelopeParsers";
import type {
  DatabaseDetail,
  DatabaseItem,
  DatabaseUpdatePatch,
  DeclarativeSkillManifest,
} from "@/api/types";

export interface DatabasesApi {
  fetchDatabases: () => Promise<DatabaseItem[]>;
  fetchDatabase: (name: string) => Promise<DatabaseDetail>;
  setDatabaseEnabled: (name: string, enabled: boolean) => Promise<void>;
  createDatabase: (manifest: DeclarativeSkillManifest) => Promise<DatabaseDetail>;
  updateDatabase: (name: string, patch: DatabaseUpdatePatch) => Promise<DatabaseDetail>;
  deleteDatabase: (name: string) => Promise<void>;
}

export function createDatabasesApi(http: Http): DatabasesApi {
  return {
    fetchDatabases: () =>
      http.request(`${http.baseUrl}/databases`).then((b) => parseDatabasesEnvelope(b)).then(({ databases }) => databases),
    fetchDatabase: (name) =>
      http.request(`${http.baseUrl}/databases/${http.encodeId(name)}`).then((b) => parseDatabaseDetail(b)),
    setDatabaseEnabled: (name, enabled) =>
      http.requestVoid(`${http.baseUrl}/databases/${http.encodeId(name)}/${enabled ? "enable" : "disable"}`, { method: "POST" }),
    createDatabase: (manifest) =>
      http.request(`${http.baseUrl}/databases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(manifest),
      }).then((b) => parseDatabaseDetail(b)),
    updateDatabase: (name, manifest) =>
      http.request(`${http.baseUrl}/databases/${http.encodeId(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(manifest),
      }).then((b) => parseDatabaseDetail(b)),
    deleteDatabase: (name) =>
      http.requestVoid(`${http.baseUrl}/databases/${http.encodeId(name)}`, { method: "DELETE" }),
  };
}