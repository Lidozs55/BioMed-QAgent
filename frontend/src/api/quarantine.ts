import type {
  UntrustedArtifactMetadata,
  UntrustedArtifactReceipt,
} from "@biomed/contracts";

import type { Http } from "@/api/http";
import {
  parseQuarantineReceipt,
  parseQuarantineReceiptPage,
} from "@/lib/apiResponseParsers";

export type QuarantineReceipt = UntrustedArtifactReceipt;
export type QuarantineCoverageStatus = UntrustedArtifactMetadata["coverage_status"];

export interface QuarantineSubmissionInput {
  file: File;
  source_note?: string;
  coverage_status: QuarantineCoverageStatus;
  covered_scope: string[];
  missing_scope: string[];
}

export interface QuarantineApi {
  fetchQuarantine: (taskId: string) => Promise<QuarantineReceipt[]>;
  fetchQuarantineReceipt: (taskId: string, submissionId: string) => Promise<QuarantineReceipt>;
  submitQuarantine: (taskId: string, input: QuarantineSubmissionInput) => Promise<QuarantineReceipt>;
  getQuarantineContentUrl: (taskId: string, submissionId: string) => string;
}

export function createQuarantineApi(http: Http): QuarantineApi {
  const collectionUrl = (taskId: string): string =>
    `${http.baseUrl}/tasks/${http.encodeId(taskId)}/quarantine`;

  return {
    fetchQuarantine: (taskId) =>
      http.request(collectionUrl(taskId)).then((body) => parseQuarantineReceiptPage(body).items),
    fetchQuarantineReceipt: (taskId, submissionId) =>
      http.request(`${collectionUrl(taskId)}/${http.encodeId(submissionId)}`).then(parseQuarantineReceipt),
    submitQuarantine: async (taskId, input) => {
      const metadata: UntrustedArtifactMetadata = {
        schema_version: "1.0",
        name: input.file.name,
        media_type: input.file.type || "application/octet-stream",
        source_note: input.source_note?.trim() || null,
        coverage_status: input.coverage_status,
        covered_scope: input.covered_scope,
        missing_scope: input.missing_scope,
      };
      const form = new FormData();
      form.set("metadata", JSON.stringify(metadata));
      form.set("file", input.file);
      return http.request(collectionUrl(taskId), { method: "POST", body: form })
        .then(parseQuarantineReceipt);
    },
    getQuarantineContentUrl: (taskId, submissionId) =>
      `${collectionUrl(taskId)}/${http.encodeId(submissionId)}/content`,
  };
}
