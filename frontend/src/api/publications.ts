/** Immutable Publication API client. */
import type { Http } from "@/api/http";
import { parsePublicationDetail, parsePublicationPage } from "@/lib/apiResponseParsers";
import type { PublicationDetail, PublicationPage } from "@/runtime/contracts";

export interface PublicationsApi {
  fetchPublications: (params?: { limit?: number; cursor?: string | null }) => Promise<PublicationPage>;
  fetchPublication: (publicationId: string, taskId?: string | null) => Promise<PublicationDetail>;
  getPublicationArtifactUrl: (publicationId: string, artifactId: string, taskId?: string | null) => string;
}

export function createPublicationsApi(http: Http): PublicationsApi {
  return {
    fetchPublications: (params = {}) =>
      http.request(http.withQuery(`${http.baseUrl}/publications`, [["limit", params.limit], ["cursor", params.cursor]])).then((body) => parsePublicationPage(body)),
    fetchPublication: (publicationId, taskId) =>
      http.request(
        http.withQuery(`${http.baseUrl}/publications/${http.encodeId(publicationId)}`, [
          ["task_id", taskId ?? undefined],
        ]),
      ).then((body) => parsePublicationDetail(body)),
    getPublicationArtifactUrl: (publicationId, artifactId, taskId) =>
      http.withQuery(
        `${http.baseUrl}/publications/${http.encodeId(publicationId)}/artifacts/${http.encodeId(artifactId)}`,
        [["task_id", taskId ?? undefined]],
      ),
  };
}
