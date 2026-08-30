/** Client-side quarantine DTOs until the shared contract exports them. */
import type { Http } from "@/api/http";
import {
  parseQuarantineReceipt,
  parseQuarantineReceiptPage,
} from "@/lib/apiResponseParsers";

export type QuarantineCoverageStatus = "complete" | "partial" | "unknown";

export interface QuarantineReceipt {
  schema_version: "1.0";
  submission_id: string;
  task_id: string;
  name: string;
  media_type: string;
  source_note: string | null;
  coverage_status: QuarantineCoverageStatus;
  covered_scope: string[];
  missing_scope: string[];
  size_bytes: number;
  sha256: string;
  submitted_at: string;
  authoritative: false;
  trust: "untrusted";
}

export interface QuarantineSubmissionInput {
  name: string;
  media_type: string;
  source_note?: string;
  coverage_status: QuarantineCoverageStatus;
  covered_scope: string[];
  missing_scope: string[];
  bytes_base64: string;
  idempotency_key?: string;
}

export interface QuarantineApi {
  fetchQuarantine: (taskId: string) => Promise<QuarantineReceipt[]>;
  fetchQuarantineReceipt: (taskId: string, submissionId: string) => Promise<QuarantineReceipt>;
  submitQuarantine: (
    taskId: string,
    input: QuarantineSubmissionInput,
  ) => Promise<QuarantineReceipt>;
  getQuarantineContentUrl: (taskId: string, submissionId: string) => string;
}

export function createQuarantineApi(http: Http): QuarantineApi {
  const collectionUrl = (taskId: string): string =>
    `${http.baseUrl}/tasks/${http.encodeId(taskId)}/quarantine`;

  return {
    fetchQuarantine: (taskId) =>
      http.request(collectionUrl(taskId)).then((body) => parseQuarantineReceiptPage(body).items),
    fetchQuarantineReceipt: (taskId, submissionId) =>
      http.request(`${collectionUrl(taskId)}/${http.encodeId(submissionId)}`).then((body) => parseQuarantineReceipt(body)),
    submitQuarantine: (taskId, input) =>
      http.request(collectionUrl(taskId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...input,
          idempotency_key: http.requestId(input.idempotency_key),
        }),
      }).then((body) => parseQuarantineReceipt(body)),
    getQuarantineContentUrl: (taskId, submissionId) =>
      `${collectionUrl(taskId)}/${http.encodeId(submissionId)}/content`,
  };
}
