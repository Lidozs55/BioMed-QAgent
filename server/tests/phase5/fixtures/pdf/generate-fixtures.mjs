// Regenerate the TS phase5 PDF fixtures (P5-08).
//
// Run from server/tests/phase5/fixtures/pdf/:
//   node generate-fixtures.mjs
//
// The generator only assembles bytes (zlib + offsets), no PDF library.
// Fixtures:
//   minimal_table.pdf       — copied from backend/tests/fixtures/pdf (golden parity)
//   scanned_image.pdf       — copied from backend/tests/fixtures/pdf (scanned detection)
//   cjk_blob.pdf            — Python-style no-xref blob: CJK hex + literal + tab row
//                             (pdfjs rejects it; the raw-regex tier recovers CJK)
//   multipage.pdf           — page 1: text + ruled table; page 2: text + second table
//   unruled_table.pdf       — position-clustered table (no ruled lines)
//   embedded_images.pdf     — 12 raster XObjects on one page (VLM cap = 10)
//   table_and_image.pdf     — ruled table + 1 embedded image (L1 fail -> L2 test)
//   captions_only.pdf       — text-only page with Figure/Table captions (L3)
//   no_content.pdf          — valid empty page (all-tiers-fail error)
//   malformed.pdf           — garbage bytes (error shape)

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const OUT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_FIXTURES = path.resolve(OUT_DIR, "..", "..", "..", "..", "..", "backend", "tests", "fixtures", "pdf");

mkdirSync(OUT_DIR, { recursive: true });

function buildPdf(objects) {
  const out = [];
  out.push(Buffer.from("%PDF-1.4\n"));
  const offsets = {};
  const objNums = [];
  objects.forEach((body, i) => {
    const num = i + 1;
    objNums.push(num);
    offsets[num] = out.reduce((sum, part) => sum + part.length, 0);
    out.push(Buffer.from(`${num} 0 obj\n`));
    out.push(body);
    out.push(Buffer.from("\nendobj\n"));
  });
  const xrefPos = out.reduce((sum, part) => sum + part.length, 0);
  const maxObj = Math.max(...objNums);
  out.push(Buffer.from(`xref\n0 ${maxObj + 1}\n`));
  out.push(Buffer.from("0000000000 65535 f \n"));
  for (const num of objNums) {
    out.push(Buffer.from(`${String(offsets[num]).padStart(10, "0")} 00000 n \n`));
  }
  out.push(Buffer.from(`trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`));
  return Buffer.concat(out);
}

function stream(content) {
  return Buffer.concat([
    Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
    content,
    Buffer.from("endstream"),
  ]);
}

function contentObject(contents) {
  return stream(contents);
}

const PAGE = (pageNum, kids, parentRef) =>
  `<< /Type /Page /Parent ${parentRef} /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents ${pageNum} 0 R >>`;

// ── cjk_blob.pdf: Python test-style no-xref blob (regex tier input) ────────
function cjkBlob() {
  const CJK = "基因表达分析";
  const cjkHex = Buffer.from(CJK, "utf16le").swap16().toString("hex").toUpperCase();
  const parts = [
    Buffer.from(`BT /F1 12 Tf 72 720 Td <${cjkHex}> Tj ET`),
    Buffer.from(`BT /F1 12 Tf 72 700 Td (${CJK}) Tj ET`),
    Buffer.from(`BT /F1 12 Tf 72 660 Td (${CJK}\tFC) Tj ET`),
    Buffer.from("BT /F1 12 Tf 72 680 Td (Gene) Tj ET"),
  ].map((c) =>
    Buffer.concat([
      Buffer.from("<< /Filter /FlateDecode >>\r\nstream\r\n"),
      zlib.deflateSync(c),
      Buffer.from("\r\nendstream"),
    ]),
  );
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n"),
    ...parts,
    Buffer.from("\ntrailer\n<< >>\n%%EOF"),
  ]);
}

// ── multipage.pdf ───────────────────────────────────────────────────────────
function multipagePdf() {
  const page1Lines =
    b("1 w\n") +
    b("72 660 m 300 660 l S\n") +
    b("72 640 m 300 640 l S\n") +
    b("72 620 m 300 620 l S\n") +
    b("72 600 m 300 600 l S\n") +
    b("72 660 m 72 600 l S\n") +
    b("180 660 m 180 600 l S\n") +
    b("300 660 m 300 600 l S\n");
  const page1 = Buffer.concat([
    b("BT /F1 12 Tf 72 760 Td (Multi Page Study) Tj ET\n"),
    b("BT /F1 12 Tf 72 746 Td (Doe, J.) Tj ET\n"),
    b("BT /F1 12 Tf 72 732 Td (Abstract) Tj ET\n"),
    b("BT /F1 12 Tf 72 718 Td (A two page report.) Tj ET\n"),
    b("q " + page1Lines + "Q\n"),
    b("BT /F1 12 Tf 80 652 Td (Gene) Tj ET\n"),
    b("BT /F1 12 Tf 190 652 Td (FC) Tj ET\n"),
    b("BT /F1 12 Tf 80 632 Td (BRCA1) Tj ET\n"),
    b("BT /F1 12 Tf 190 632 Td (1.5) Tj ET\n"),
    b("BT /F1 12 Tf 80 612 Td (TP53) Tj ET\n"),
    b("BT /F1 12 Tf 190 612 Td (2.0) Tj ET\n"),
  ]);
  const page2 = Buffer.concat([
    b("BT /F1 12 Tf 72 700 Td (Second Page) Tj ET\n"),
    b("BT /F1 12 Tf 80 652 Td (Sample) Tj ET\n"),
    b("BT /F1 12 Tf 190 652 Td (Value) Tj ET\n"),
    b("BT /F1 12 Tf 80 632 Td (S1) Tj ET\n"),
    b("BT /F1 12 Tf 190 632 Td (9) Tj ET\n"),
  ]);
  return buildPdf([
    b("<< /Type /Catalog /Pages 2 0 R >>"),
    b("<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>"),
    b("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>"),
    b("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    b("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 8 0 R >>"),
    b("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"),
    contentObject(page1),
    contentObject(page2),
  ]);
}

function b(text) {
  return Buffer.from(text);
}

// ── unruled_table.pdf: position clustering (no lines) ───────────────────────
function unruledTablePdf() {
  const content = Buffer.concat([
    b("BT /F1 12 Tf 72 760 Td (Unruled Results) Tj ET\n"),
    b("BT /F1 12 Tf 80 700 Td (Sample) Tj ET\n"),
    b("BT /F1 12 Tf 190 700 Td (Value) Tj ET\n"),
    b("BT /F1 12 Tf 80 680 Td (A) Tj ET\n"),
    b("BT /F1 12 Tf 190 680 Td (1.2) Tj ET\n"),
    b("BT /F1 12 Tf 80 660 Td (B) Tj ET\n"),
    b("BT /F1 12 Tf 190 660 Td (3.4) Tj ET\n"),
  ]);
  return buildPdf([
    b("<< /Type /Catalog /Pages 2 0 R >>"),
    b("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    b("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"),
    b("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    contentObject(content),
  ]);
}

// ── embedded_images.pdf: 12 raster XObjects (cap at 10) ─────────────────────
function embeddedImagesPdf(count) {
  const names = Array.from({ length: count }, (_, i) => `/Im${i + 1}`);
  const resources = `<< /XObject << ${names.map((n) => `${n} ${5 + count} 0 R`).join(" ")} >> >>`;
  const draw = names.map((n) => `q 72 700 20 20 re W n ${n} Do Q`).join("\n");
  const content = b(draw);
  const objects = [
    b("<< /Type /Catalog /Pages 2 0 R >>"),
    b("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    b(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents 4 0 R >>`),
    contentObject(content),
  ];
  const img = Buffer.from([0x80, 0x40, 0xc0, 0x20]);
  for (let i = 0; i < count; i += 1) {
    objects.push(
      Buffer.concat([
        b("<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\n"),
        img,
        b("endstream"),
      ]),
    );
  }
  return buildPdf(objects);
}

// ── table_and_image.pdf: ruled table + 1 embedded image ─────────────────────
function tableAndImagePdf() {
  const content = Buffer.concat([
    b("BT /F1 12 Tf 72 760 Td (Table And Figure Study) Tj ET\n"),
    b("q 72 500 200 200 re W n /Im1 Do Q\n"),
    b("q 72 660 m 300 660 l S 72 640 m 300 640 l S 72 620 m 300 620 l S 72 600 m 300 600 l S 72 660 m 72 600 l S 180 660 m 180 600 l S 300 660 m 300 600 l S Q\n"),
    b("BT /F1 12 Tf 80 652 Td (Gene) Tj ET\n"),
    b("BT /F1 12 Tf 190 652 Td (FC) Tj ET\n"),
    b("BT /F1 12 Tf 80 632 Td (BRCA1) Tj ET\n"),
    b("BT /F1 12 Tf 190 632 Td (1.5) Tj ET\n"),
    b("BT /F1 12 Tf 80 612 Td (TP53) Tj ET\n"),
    b("BT /F1 12 Tf 190 612 Td (2.0) Tj ET\n"),
  ]);
  const img = Buffer.from([0x80, 0x40, 0xc0, 0x20]);
  return buildPdf([
    b("<< /Type /Catalog /Pages 2 0 R >>"),
    b("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    b("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 5 0 R >>"),
    b("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    contentObject(content),
    Buffer.concat([
      b("<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\n"),
      img,
      b("endstream"),
    ]),
  ]);
}

// ── captions_only.pdf ───────────────────────────────────────────────────────
function captionsOnlyPdf() {
  const content = Buffer.concat([
    b("BT /F1 12 Tf 72 760 Td (Caption Study) Tj ET\n"),
    b("BT /F1 12 Tf 72 740 Td (Figure 1: Gene expression heatmap of top genes) Tj ET\n"),
    b("BT /F1 12 Tf 72 720 Td (Figure 2: Volcano plot of differential expression) Tj ET\n"),
    b("BT /F1 12 Tf 72 700 Td (Table 1: Sample metadata summary) Tj ET\n"),
  ]);
  return buildPdf([
    b("<< /Type /Catalog /Pages 2 0 R >>"),
    b("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    b("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"),
    b("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    contentObject(content),
  ]);
}

// ── no_content.pdf ──────────────────────────────────────────────────────────
function noContentPdf() {
  return buildPdf([
    b("<< /Type /Catalog /Pages 2 0 R >>"),
    b("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    b("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>"),
  ]);
}

// ── write everything ────────────────────────────────────────────────────────
writeFileSync(path.join(OUT_DIR, "minimal_table.pdf"), readFileSync(path.join(BACKEND_FIXTURES, "minimal_table.pdf")));
writeFileSync(path.join(OUT_DIR, "scanned_image.pdf"), readFileSync(path.join(BACKEND_FIXTURES, "scanned_image.pdf")));
writeFileSync(path.join(OUT_DIR, "cjk_blob.pdf"), cjkBlob());
writeFileSync(path.join(OUT_DIR, "multipage.pdf"), multipagePdf());
writeFileSync(path.join(OUT_DIR, "unruled_table.pdf"), unruledTablePdf());
writeFileSync(path.join(OUT_DIR, "embedded_images.pdf"), embeddedImagesPdf(12));
writeFileSync(path.join(OUT_DIR, "table_and_image.pdf"), tableAndImagePdf());
writeFileSync(path.join(OUT_DIR, "captions_only.pdf"), captionsOnlyPdf());
writeFileSync(path.join(OUT_DIR, "no_content.pdf"), noContentPdf());
writeFileSync(path.join(OUT_DIR, "malformed.pdf"), Buffer.from("%PDF-1.4\nthis is not a real pdf at all\nno objects, no xref, garbage\n"));

console.log("wrote fixtures to", OUT_DIR);
console.log("NOTE: minimal_table.pdf / scanned_image.pdf are copies of the backend fixtures.");
