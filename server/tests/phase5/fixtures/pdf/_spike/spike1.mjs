// Spike 1: basic pdfjs open + text + metadata + operator list on fixtures
import { readFile } from "node:fs/promises";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

async function load(path) {
  const data = new Uint8Array(await readFile(path));
  return pdfjs.getDocument({ data }).promise;
}

for (const name of ["minimal_table.pdf", "scanned_image.pdf"]) {
  console.log("=== " + name + " ===");
  try {
    const doc = await load(new URL(name, import.meta.url).pathname.slice(1));
    console.log("numPages:", doc.numPages);
    const meta = await doc.getMetadata().catch((e) => ({ err: String(e) }));
    console.log("metadata:", JSON.stringify(meta).slice(0, 500));
    const page = await doc.getPage(1);
    const text = await page.getTextContent();
    console.log("text items:", text.items.length);
    for (const it of text.items.slice(0, 12)) {
      console.log(
        "  item:",
        JSON.stringify({
          str: it.str,
          x: it.transform?.[4],
          y: it.transform?.[5],
          w: it.width,
          h: it.height,
          fontName: it.fontName,
        }),
      );
    }
    const ops = await page.getOperatorList();
    const names = ops.fnArray.map((f) => pdfjs.OPS[f]).filter((n) => n && !/^(set|save|restore|transform|beginText|endText|setFont|setLeading|setText|moveText|nextLine|showText|showSpacedText|setLineWidth|setDash|setGState|setFill|setStroke)/.test(n));
    console.log("interesting ops:", [...new Set(names)].join(","));
    console.log("ops count:", ops.fnArray.length);
    await doc.destroy();
  } catch (e) {
    console.log("ERROR:", e.message);
  }
}
