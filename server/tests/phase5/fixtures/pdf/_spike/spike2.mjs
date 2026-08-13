// Spike 2b: operator list details using OPS numeric map
import { readFile, writeFile } from "node:fs/promises";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { PNG } from "pngjs";

const OPS = pdfjs.OPS;
const byNum = {};
for (const [k, v] of Object.entries(OPS)) byNum[v] = k;
console.log("image-related:", [85, 86, 87, 88].map((n) => `${n}:${byNum[n]}`).join(" "));
console.log("path-related:", Object.entries(byNum).filter(([n, k]) => /constructPath|endPath|stroke|moveTo|lineTo/.test(k)).map(([n, k]) => `${n}:${k}`).join(" "));

async function load(path) {
  const data = new Uint8Array(await readFile(path));
  return pdfjs.getDocument({ data }).promise;
}

const doc = await load(new URL("scanned_image.pdf", import.meta.url).pathname.slice(1));
const page = await doc.getPage(1);
const ops = await page.getOperatorList();
console.log("scanned fnArray:", ops.fnArray.map((f) => `${f}:${byNum[f]}`).join(","));
for (let i = 0; i < ops.fnArray.length; i++) {
  if (ops.fnArray[i] === OPS.paintImageXObject || ops.fnArray[i] === OPS.paintInlineImageXObject) {
    const name = ops.argsArray[i]?.[0];
    console.log("paintImageXObject name:", name);
    try {
      const img = await page.objs.get(name);
      console.log("objs.get keys:", Object.keys(img ?? {}), "data?", img?.data?.constructor?.name, img?.data?.length, img?.width, img?.height, "bitmaps:", img?.bitmaps);
      if (img?.data) {
        const png = new PNG({ width: img.width, height: img.height });
        PNG.bitblt(img.data, png.data, img.width * 4, img.height, 0, 0, 0, 0, img.width, img.height);
        const buf = PNG.sync.write(png, { colorType: 6 });
        await writeFile(new URL("scanned_extracted.png", import.meta.url).pathname.slice(1), buf);
        console.log("wrote scanned_extracted.png", buf.length, "bytes");
      }
    } catch (e) {
      console.log("objs.get error:", e.message);
    }
  }
}
// await doc.destroy();

const doc2 = await load(new URL("minimal_table.pdf", import.meta.url).pathname.slice(1));
const page2 = await doc2.getPage(1);
const ops2 = await page2.getOperatorList();
console.log("table fnArray:", ops2.fnArray.map((f) => `${f}:${byNum[f]}`).join(","));
for (let i = 0; i < ops2.fnArray.length; i++) {
  const n = byNum[ops2.fnArray[i]];
  if (n.includes("constructPath") || n === "endPath" || n === "stroke") {
    console.log("table op:", n, JSON.stringify(ops2.argsArray[i]).slice(0, 260));
  }
}
await doc2.destroy();
console.log("destroy() works on doc");
