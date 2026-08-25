import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserAcquisitionProposal } from "@biomed/contracts";
import { parseBrowserAcquisitionProposal } from "@biomed/contracts";
import { canonicalDigest } from "../dataset/adapters/identity.js";

const STORE_RELATIVE_PATH = "state/browser-acquisition-proposals.json";

export class BrowserAcquisitionProposalStore {
  readonly #taskRoot: string;

  constructor(taskRoot: string) {
    this.#taskRoot = taskRoot;
  }

  async put(proposal: BrowserAcquisitionProposal): Promise<BrowserAcquisitionProposal> {
    const parsed = parseBrowserAcquisitionProposal(proposal);
    const current = await this.#read();
    const existing = current.find((item) => item.proposal_id === parsed.proposal_id);
    if (existing !== undefined && canonicalDigest(existing) !== canonicalDigest(parsed)) {
      throw new Error(`browser proposal identity collision: ${parsed.proposal_id}`);
    }
    if (existing !== undefined) return existing;
    const file = path.join(this.#taskRoot, STORE_RELATIVE_PATH);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify([...current, parsed], null, 2), "utf8");
    await rename(temporary, file);
    return parsed;
  }

  async update(proposalId: string, patch: Partial<BrowserAcquisitionProposal>): Promise<BrowserAcquisitionProposal> {
    const current = await this.#read();
    const index = current.findIndex((item) => item.proposal_id === proposalId);
    if (index < 0) throw new Error(`browser proposal not found: ${proposalId}`);
    const next = parseBrowserAcquisitionProposal({ ...current[index], ...patch, updated_at: new Date().toISOString() });
    const file = path.join(this.#taskRoot, STORE_RELATIVE_PATH);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(current.map((item, i) => i === index ? next : item), null, 2), "utf8");
    await rename(temporary, file);
    return next;
  }

  async get(proposalId: string): Promise<BrowserAcquisitionProposal> {
    const proposal = (await this.#read()).find((item) => item.proposal_id === proposalId);
    if (proposal === undefined) throw new Error(`browser proposal not found: ${proposalId}`);
    return proposal;
  }

  async #read(): Promise<BrowserAcquisitionProposal[]> {
    try {
      const text = await readFile(path.join(this.#taskRoot, STORE_RELATIVE_PATH), "utf8");
      const value: unknown = JSON.parse(text);
      if (!Array.isArray(value)) throw new Error("browser proposal store must be an array");
      return value.map((item, index) => parseBrowserAcquisitionProposal(item, `proposals[${index}]`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
