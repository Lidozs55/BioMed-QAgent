/**
 * V2 builds API client (``/api/v1/builds``).
 */
import type { Http } from "@/api/http";
import { parseBuildDetail, parseBuildPage } from "@/lib/apiResponseParsers";
import type { BuildDetail, BuildPage } from "@/runtime/contracts";

export interface BuildsApi {
  fetchBuilds: (params?: { limit?: number; cursor?: string | null }) => Promise<BuildPage>;
  fetchBuild: (buildId: string, taskId?: string | null) => Promise<BuildDetail>;
  getBuildArtifactUrl: (buildId: string, artifactId: string, taskId?: string | null) => string;
}

export function createBuildsApi(http: Http): BuildsApi {
  return {
    fetchBuilds: (params = {}) =>
      http.request(http.withQuery(`${http.baseUrl}/builds`, [["limit", params.limit], ["cursor", params.cursor]])).then((b) => parseBuildPage(b)),
    fetchBuild: (buildId, taskId) =>
      http.request(
        http.withQuery(`${http.baseUrl}/builds/${http.encodeId(buildId)}`, [
          ["task_id", taskId ?? undefined],
        ]),
      ).then((b) => parseBuildDetail(b)),
    getBuildArtifactUrl: (buildId, artifactId, taskId) =>
      http.withQuery(
        `${http.baseUrl}/builds/${http.encodeId(buildId)}/artifacts/${http.encodeId(artifactId)}`,
        [["task_id", taskId ?? undefined]],
      ),
  };
}