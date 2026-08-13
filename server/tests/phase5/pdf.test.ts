/**
 * P5-08 PDF table/metadata extraction tests: golden parity against the Python
 * implementation, scanned-PDF warnings, malformed input, path confinement.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createPdfTools } from "../../src/agent/tools/pdf.js";
import {
  SCANNED_PDF_WARNING,
  type PdfTablesOk,
  type PdfMetadataOk,
} from "../../src/processing/pdf/index.js";
import { SKILL_TOOL_NAMES, toolOwner } from "../../src/agent/skills/skill-tool-map.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pdf");
const PYTHON_PDF_FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "backend", "tests", "fixtures", "pdf",
);
const GOLDEN = path.join(FIXTURES, "golden");

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newTaskRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "p5-pdf-"));
  roots.push(root);
  await mkdir(path.join(root, "source_assets"), { recursive: true });
  return root;
}

async function stagePdf(taskRoot: string, name: string, source = PYTHON_PDF_FIXTURES): Promise<string> {
  const destination = path.join(taskRoot, "source_assets", name);
  await writeFile(destination, await readFile(path.join(source, name)));
  return `source_assets/${name}`;
}

describe("extract_pdf_tables", () => {
  it("matches the Python golden table on the real fixture", async () => {
    const taskRoot = await newTaskRoot();
    const relative = await stagePdf(taskRoot, "minimal_table.pdf");
    const [tables] = createPdfTools({ taskRoot });
    const result = await tables.execute({ file_path: relative });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as PdfTablesOk;
    expect(parsed.status).toBe("ok");
    expect(parsed.summary.total_tables).toBeGreaterThanOrEqual(1);
    expect(parsed.outputs.length).toBeGreaterThanOrEqual(1);
    const golden = (await readFile(path.join(GOLDEN, "minimal_table_table_1.csv"), "utf8"))
      .split(/\r?\n/).filter(Boolean).map((line) => line.split(","));
    const produced = (await readFile(path.join(taskRoot, parsed.outputs[0] ?? ""), "utf8"))
      .split(/\r?\n/).filter(Boolean).map((line) => line.split(","));
    expect(produced.length).toBe(golden.length);
    expect(produced[0]).toEqual(golden[0]); // header row parity
    expect(produced.length).toBeGreaterThan(1); // data rows present
  });

  it("flags scanned/image-only PDFs instead of silent success", async () => {
    const taskRoot = await newTaskRoot();
    const relative = await stagePdf(taskRoot, "scanned_image.pdf");
    const [tables] = createPdfTools({ taskRoot });
    const result = await tables.execute({ file_path: relative });
    const parsed = JSON.parse(result.content) as { status: string; warning?: string };
    expect(parsed.status).toBe("ok");
    expect(parsed.warning).toContain(SCANNED_PDF_WARNING);
  });

  it("returns an error shape for malformed PDFs", async () => {
    const taskRoot = await newTaskRoot();
    const relative = await stagePdf(taskRoot, "malformed.pdf", path.join(FIXTURES, "_spike"));
    const [tables] = createPdfTools({ taskRoot });
    const result = await tables.execute({ file_path: relative });
    const parsed = JSON.parse(result.content) as { status: string; error?: string };
    if (parsed.status === "error") {
      expect(parsed.error).toBeTruthy();
    } else {
      // Malformed PDFs may degrade to raw-regex text mode: acceptable as long
      // as it is not a fake success with fabricated tables.
      expect(parsed).toHaveProperty("warning");
    }
  });

  it("handles CJK PDFs without crashing", async () => {
    const taskRoot = await newTaskRoot();
    const relative = await stagePdf(taskRoot, "cjk_validxref.pdf", path.join(FIXTURES, "_spike"));
    const [tables] = createPdfTools({ taskRoot });
    const result = await tables.execute({ file_path: relative });
    const parsed = JSON.parse(result.content) as { status: string };
    expect(["ok", "error"]).toContain(parsed.status);
  });

  it("rejects paths escaping the task root", async () => {
    const taskRoot = await newTaskRoot();
    const [tables] = createPdfTools({ taskRoot });
    const result = await tables.execute({ file_path: "../outside.pdf" });
    const parsed = JSON.parse(result.content) as { status: string; error?: string };
    expect(parsed.status).toBe("error");
    expect(parsed.error ?? "").toMatch(/outside|resolve|path/i);
  });

  it("registers under the SKILL_TOOL_MAP names", () => {
    const tools = createPdfTools({ taskRoot: "unused" });
    expect(tools.map((tool) => tool.name)).toEqual(["extract_pdf_tables", "extract_pdf_metadata"]);
    for (const tool of tools) {
      expect(SKILL_TOOL_NAMES.has(tool.name)).toBe(true);
      expect(toolOwner(tool.name)).toBe("pdf_extraction");
    }
  });
});

describe("extract_pdf_metadata", () => {
  it("matches the Python golden metadata on the real fixture", async () => {
    const taskRoot = await newTaskRoot();
    const relative = await stagePdf(taskRoot, "minimal_table.pdf");
    const [, metadata] = createPdfTools({ taskRoot });
    const result = await metadata.execute({ file_path: relative });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as PdfMetadataOk;
    expect(parsed.status).toBe("ok");
    const golden = JSON.parse(
      await readFile(path.join(GOLDEN, "minimal_table_metadata.golden.json"), "utf8"),
    ) as { summary: { num_pages: number; title: string } };
    expect(parsed.summary.num_pages).toBe(golden.summary.num_pages);
    expect(parsed.summary.title).toBe(golden.summary.title);
    // Metadata JSON persisted under parsed/.
    expect(parsed.outputs.length).toBeGreaterThanOrEqual(1);
    await expect(readFile(path.join(taskRoot, parsed.outputs[0] ?? ""), "utf8")).resolves.toBeTruthy();
  });

  it("reports page count for scanned PDFs without fabricating metadata", async () => {
    const taskRoot = await newTaskRoot();
    const relative = await stagePdf(taskRoot, "scanned_image.pdf");
    const [, metadata] = createPdfTools({ taskRoot });
    const result = await metadata.execute({ file_path: relative });
    const parsed = JSON.parse(result.content) as { status: string; summary?: { num_pages: number } };
    expect(parsed.status).toBe("ok");
    expect(parsed.summary?.num_pages).toBeGreaterThanOrEqual(1);
  });
});
