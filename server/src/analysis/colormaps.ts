/**
 * Matplotlib colormap parity for the analysis plots (P5-09 analysis).
 *
 * Anchor tables are the exact matplotlib data (venv matplotlib,
 * ``_cm._RdBu_data`` / ``_cm._coolwarm_data`` — see
 * tests/phase5/fixtures/analysis/_cmap_dump.json). Linear interpolation in
 * RGB space matches matplotlib's LinearSegmentedColormap for these maps
 * (neither defines gamma segments). Channel values may exceed [0, 1] at the
 * extremes (coolwarm dips negative in the blue channel); callers clip when
 * writing bytes, exactly as matplotlib does at render time.
 *
 * "RdBu_r" is the reversed RdBu table — the default heatmap cmap of the
 * Python tool. "coolwarm" is the default correlation-matrix cmap.
 */

export type ColormapName = "RdBu_r" | "coolwarm";

interface ColormapAnchor {
  x: number;
  r: number;
  g: number;
  b: number;
}

const TABLE_RDBU: readonly ColormapAnchor[] = [
  { x: 0.0, r: 0.40392157, g: 0.0, b: 0.12156863 },
  { x: 0.1, r: 0.69803922, g: 0.09411765, b: 0.16862745 },
  { x: 0.2, r: 0.83921569, g: 0.37647059, b: 0.30196078 },
  { x: 0.3, r: 0.95686275, g: 0.64705882, b: 0.50980392 },
  { x: 0.4, r: 0.99215686, g: 0.85882353, b: 0.78039216 },
  { x: 0.5, r: 0.96862745, g: 0.96862745, b: 0.96862745 },
  { x: 0.6, r: 0.81960784, g: 0.89803922, b: 0.94117647 },
  { x: 0.7, r: 0.57254902, g: 0.77254902, b: 0.87058824 },
  { x: 0.8, r: 0.2627451, g: 0.57647059, b: 0.76470588 },
  { x: 0.9, r: 0.12941176, g: 0.4, b: 0.6745098 },
  { x: 1.0, r: 0.01960784, g: 0.18823529, b: 0.38039216 },
];

const TABLE_COOLWARM: readonly ColormapAnchor[] = [
  { x: 0.0, r: 0.2298057, g: 0.29871797, b: 0.75368315 },
  { x: 0.03125, r: 0.26623388, g: 0.35309484, b: 0.80146676 },
  { x: 0.0625, r: 0.30386891, g: 0.4065353, b: 0.84495867 },
  { x: 0.09375, r: 0.34280448, g: 0.45875762, b: 0.8837259 },
  { x: 0.125, r: 0.38301334, g: 0.50941904, b: 0.91738782 },
  { x: 0.15625, r: 0.42436961, g: 0.55814809, b: 0.94561959 },
  { x: 0.1875, r: 0.46666708, g: 0.60456257, b: 0.96815491 },
  { x: 0.21875, r: 0.5096352, g: 0.64828077, b: 0.98478814 },
  { x: 0.25, r: 0.55295316, g: 0.68892933, b: 0.99537561 },
  { x: 0.28125, r: 0.59626216, g: 0.72614911, b: 0.9998362 },
  { x: 0.3125, r: 0.63917621, g: 0.75959995, b: 0.99815118 },
  { x: 0.34375, r: 0.68129128, g: 0.78896471, b: 0.99036323 },
  { x: 0.375, r: 0.72219329, g: 0.81395274, b: 0.97657471 },
  { x: 0.40625, r: 0.76146495, g: 0.83430288, b: 0.95694527 },
  { x: 0.4375, r: 0.79869164, g: 0.84978614, b: 0.93168865 },
  { x: 0.46875, r: 0.83346656, g: 0.86020798, b: 0.90106884 },
  { x: 0.5, r: 0.8653952, g: 0.86541021, b: 0.86539556 },
  { x: 0.53125, r: 0.89778718, g: 0.84893705, b: 0.82088055 },
  { x: 0.5625, r: 0.92412759, g: 0.82738488, b: 0.77450847 },
  { x: 0.59375, r: 0.94446852, g: 0.80092744, b: 0.72673615 },
  { x: 0.625, r: 0.95885295, g: 0.76976775, b: 0.67800794 },
  { x: 0.65625, r: 0.96732803, g: 0.73413281, b: 0.62875176 },
  { x: 0.6875, r: 0.96995414, g: 0.69426668, b: 0.57937545 },
  { x: 0.71875, r: 0.96681118, g: 0.65042116, b: 0.53026376 },
  { x: 0.75, r: 0.95800306, g: 0.60284243, b: 0.48177591 },
  { x: 0.78125, r: 0.94366087, g: 0.55175097, b: 0.43424368 },
  { x: 0.8125, r: 0.92394492, g: 0.49730856, b: 0.38797023 },
  { x: 0.84375, r: 0.89904617, g: 0.43955947, b: 0.3432296 },
  { x: 0.875, r: 0.86918685, g: 0.37831309, b: 0.30026718 },
  { x: 0.90625, r: 0.83462054, g: 0.31287445, b: 0.2593012 },
  { x: 0.9375, r: 0.79563175, g: 0.24128379, b: 0.22052563 },
  { x: 0.96875, r: 0.75253493, g: 0.15724607, b: 0.18411512 },
  { x: 1.0, r: 0.70567316, g: 0.01555616, b: 0.15023281 },
];

// RdBu_r: reversed RdBu.
const TABLE_RDBU_R: readonly ColormapAnchor[] = [...TABLE_RDBU]
  .reverse()
  .map((anchor) => ({ x: 1 - anchor.x, r: anchor.r, g: anchor.g, b: anchor.b }));

const TABLES: Readonly<Record<ColormapName, readonly ColormapAnchor[]>> = {
  RdBu_r: TABLE_RDBU_R,
  coolwarm: TABLE_COOLWARM,
};

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Linear interpolation over the colormap anchors; t is clamped to [0, 1]. */
export function colormap(name: ColormapName, t: number): Rgb {
  const table = TABLES[name];
  const x = Math.min(1, Math.max(0, t));
  for (let i = 0; i < table.length - 1; i += 1) {
    const lo = table[i];
    const hi = table[i + 1];
    if (x <= hi.x) {
      const frac = (x - lo.x) / (hi.x - lo.x);
      return {
        r: lo.r + frac * (hi.r - lo.r),
        g: lo.g + frac * (hi.g - lo.g),
        b: lo.b + frac * (hi.b - lo.b),
      };
    }
  }
  const last = table[table.length - 1];
  return { r: last.r, g: last.g, b: last.b };
}

/** Colormap lookup mapped to 8-bit RGBA bytes (matplotlib render clipping). */
export function colormapBytes(name: ColormapName, t: number): [number, number, number, number] {
  const { r, g, b } = colormap(name, t);
  const toByte = (channel: number): number =>
    Math.round(Math.min(1, Math.max(0, channel)) * 255);
  return [toByte(r), toByte(g), toByte(b), 255];
}
