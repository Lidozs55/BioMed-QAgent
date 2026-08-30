/**
 * Deterministic XLSX worksheet → UTF-8 CSV conversion for Core-owned carrier
 * extraction. Structural gate first: the buffer must parse as a ZIP central
 * directory containing `xl/workbook.xml` (SheetJS silently degrades arbitrary
 * bytes to plain-text sheets, which would fabricate rows). Reading then uses
 * the same SheetJS options as the registered adapters so parsed bytes stay
 * reproducible. Worksheet order is the workbook order; sheets beyond the
 * bound or over the CSV byte cap are skipped — conversion never fabricates
 * rows and never fails the acquisition.
 */

import * as XLSX from "xlsx";

import { readZipCentralDirectory, ZipFormatError } from "./zip-members.js";

export interface XlsxWorksheetCsv {
  sheetName: string;
  csv: Buffer;
}

function looksLikeOoxylWorkbook(bytes: Buffer): boolean {
  try {
    return readZipCentralDirectory(bytes).some((entry) => entry.name === "xl/workbook.xml");
  } catch (error) {
    if (error instanceof ZipFormatError) return false;
    throw error;
  }
}

export function xlsxWorksheetsToCsv(
  bytes: Buffer,
  limits: { maxWorksheets: number; maxCsvBytes: number },
): XlsxWorksheetCsv[] {
  if (!looksLikeOoxylWorkbook(bytes)) return [];
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, { type: "buffer", cellDates: false, cellNF: false, cellText: false });
  } catch {
    return [];
  }
  const sheets: XlsxWorksheetCsv[] = [];
  for (const sheetName of workbook.SheetNames) {
    if (sheets.length >= limits.maxWorksheets) break;
    const sheet = workbook.Sheets[sheetName];
    if (sheet === undefined) continue;
    const csv = Buffer.from(XLSX.utils.sheet_to_csv(sheet), "utf-8");
    if (csv.byteLength === 0 || csv.byteLength > limits.maxCsvBytes) continue;
    sheets.push({ sheetName, csv });
  }
  return sheets;
}
