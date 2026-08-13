// Spike 3: failure modes — crafted CJK blobs (no xref), malformed, valid-xref CJK
import { readFile, writeFile } from "node:fs/promises";
import zlib from "node:zlib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const CJK = "基因表达分析";

function flate(data) { return zlib.deflateSync(data); }

// Python-style blob WITHOUT xref (as backend tests craft)
function cjkBlobNoXref() {
  const cjkHex = Buffer.from(CJK, "utf16le").swap16().toString("hex").toUpperCase();
  const streams = [
    Buffer.from(`BT /F1 12 Tf 72 720 Td <${cjkHex}> Tj ET`),
    Buffer.from(`BT /F1 12 Tf 72 700 Td (${CJK}) Tj ET`),
    Buffer.from(`BT /F1 12 Tf 72 660 Td (${CJK}\tFC) Tj ET`),
    Buffer.from("BT /F1 12 Tf 72 680 Td (Gene) Tj ET"),
  ].map((c) => Buffer.concat([Buffer.from("<< /Filter /FlateDecode >>\r\nstream\r\n"), flate(c), Buffer.from("\r\nendstream")]));
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n"),
    ...streams,
    Buffer.from("\ntrailer\n<< >>\n%%EOF"),
  ]);
}

// Same but with valid xref + catalog + pages (well-formed PDF)
function buildPdf(objects) {
  const out = [];
  out.push(Buffer.from("%PDF-1.4\n"));
  const offsets = {};
  const nums = [];
  objects.forEach((body, i) => {
    const num = i + 1;
    nums.push(num);
    offsets[num] = out.reduce((s, b) => s + b.length, 0);
    out.push(Buffer.from(`${num} 0 obj\n`));
    out.push(body);
    out.push(Buffer.from("\nendobj\n"));
  });
  const xref = out.reduce((s, b) => s + b.length, 0);
  const maxObj = Math.max(...nums);
  out.push(Buffer.from(`xref\n0 ${maxObj + 1}\n`));
  out.push(Buffer.from("0000000000 65535 f \n"));
  for (const n of nums) out.push(Buffer.from(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`));
  out.push(Buffer.from(`trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(out);
}

function cjkValidXref() {
  const cjkHex = Buffer.from(CJK, "utf16le").swap16().toString("hex").toUpperCase();
  const content = Buffer.concat([
    Buffer.from("BT /F1 12 Tf 72 720 Td (Gene) Tj ET\n"),
    Buffer.from(`BT /F1 12 Tf 72 700 Td (${CJK}) Tj ET\n`),
    Buffer.from(`BT /F1 12 Tf 72 680 Td <${cjkHex}> Tj ET\n`),
  ]);
  return buildPdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("endstream")]),
  ]);
}

async function tryOpen(name, data) {
  console.log("=== " + name + " ===");
  try {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
    console.log("OPENED, numPages:", doc.numPages);
    try {
      const page = await doc.getPage(1);
      const text = await page.getTextContent();
      console.log("text:", JSON.stringify(text.items.map((i) => i.str)));
    } catch (e) {
      console.log("text error:", e.message);
    }
  } catch (e) {
    console.log("OPEN ERROR:", e.name, "-", e.message);
  }
}

const base = new URL(".", import.meta.url).pathname.slice(1);
const blobs = [
  ["cjk_noxref.pdf", cjkBlobNoXref()],
  ["cjk_validxref.pdf", cjkValidXref()],
  ["malformed.pdf", Buffer.from("%PDF-1.4\nthis is not a real pdf at all\nno objects, no xref, garbage\n")],
  ["empty.pdf", Buffer.alloc(0)],
];
for (const [name, data] of blobs) {
  await writeFile(base + name, data);
  await tryOpen(name, data);
}
