import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  parseBrowserAcquisitionEvidence,
  type BrowserAcquisitionEvidence,
} from "@biomed/contracts";
import { canonicalJson } from "../dataset/adapters/identity.js";

const STORE_RELATIVE_PATH = "state/browser-acquisition-evidence.json";

export interface BrowserAcquisitionEvidenceStoreOptions {
  taskRoot: string;
}

function digestEvidence(evidence: BrowserAcquisitionEvidence): string {
  return createHash("sha256").update(canonicalJson(evidence), "utf8").digest("hex");
}

export class BrowserAcquisitionEvidenceStore {
  readonly #taskRoot: string;

  constructor(options: BrowserAcquisitionEvidenceStoreOptions) {
    this.#taskRoot = options.taskRoot;
  }

  #path(): string {
    return path.join(this.#taskRoot, STORE_RELATIVE_PATH);
  }

  async put(input: BrowserAcquisitionEvidence): Promise<{ evidence: BrowserAcquisitionEvidence; evidenceDigest: string }> {
    const evidence = parseBrowserAcquisitionEvidence(input);
    const evidenceDigest = digestEvidence(evidence);
    const storePath = this.#path();
    await mkdir(path.dirname(storePath), { recursive: true });
    const current = await this.#read();
    const existing = current.find((item) => item.evidence_id === evidence.evidence_id);
    if (existing !== undefined && digestEvidence(existing) !== evidenceDigest) {
      throw new Error(`browser evidence identity collision: ${evidence.evidence_id}`);
    }
    if (existing === undefined) {
      const temporary = `${storePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify([...current, evidence], null, 2), "utf8");
      await rename(temporary, storePath);
    }
    return { evidence, evidenceDigest };
  }

  async get(evidenceId: string): Promise<{ evidence: BrowserAcquisitionEvidence; evidenceDigest: string }> {
    const evidence = (await this.#read()).find((item) => item.evidence_id === evidenceId);
    if (evidence === undefined) throw new Error(`browser evidence not found: ${evidenceId}`);
    return { evidence, evidenceDigest: digestEvidence(evidence) };
  }

  async list(): Promise<Array<{ evidence: BrowserAcquisitionEvidence; evidenceDigest: string }>> {
    return (await this.#read()).map((evidence) => ({ evidence, evidenceDigest: digestEvidence(evidence) }));
  }

  async #read(): Promise<BrowserAcquisitionEvidence[]> {
    try {
      const text = await readFile(this.#path(), "utf8");
      const value: unknown = JSON.parse(text);
      if (!Array.isArray(value)) throw new Error("browser evidence store must be an array");
      return value.map((item, index) => parseBrowserAcquisitionEvidence(item, `evidence[${index}]`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
