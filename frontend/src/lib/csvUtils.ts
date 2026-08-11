import Papa from "papaparse";

/** Preview byte cap: enough for the default 100-row preview plus header. */
const PREVIEW_BYTE_CAP = 8 * 1024 * 1024;

/** Parse a CSV text into trimmed headers/rows with a 100-row preview cap. */
export function parseCSV(text: string): {
  headers: string[];
  rows: string[][];
  truncated: boolean;
} {
  if (text.trim() === "") {
    return { headers: [], rows: [], truncated: false };
  }
  const parsed = Papa.parse<string[]>(text, {
    preview: 101,
    skipEmptyLines: "greedy",
  });
  if (parsed.errors.length > 0) throw new Error(parsed.errors[0].message);
  const [headers = [], ...rows] = parsed.data;
  return {
    headers: headers.map((header) => header.trim()),
    rows: rows.map((row) => row.map((cell) => cell.trim())),
    truncated: parsed.meta.truncated,
  };
}

/**
 * Fetch only the leading prefix of a CSV artifact URL.
 *
 * Main-data artifacts can reach >1 GB; the preview only needs ~100 rows, so
 * downloading the whole body (``response.text()``) crashes the tab. This reads
 * the response stream up to ``byteCap`` bytes, cancels the rest, and returns a
 * prefix cut at the last complete line so ``parseCSV`` never sees a torn row.
 */
export async function fetchPreviewText(
  url: string,
  byteCap: number = PREVIEW_BYTE_CAP,
): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("fetch failed");
  if (!response.body) {
    // Non-streaming fallback (mocked fetch in tests); callers must only rely
    // on this for small payloads.
    return response.text();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= byteCap) {
      await reader.cancel();
      break;
    }
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const decoded = new TextDecoder().decode(joined);
  const lastNewline = decoded.lastIndexOf("\n");
  return lastNewline >= 0 ? decoded.slice(0, lastNewline) : decoded;
}
