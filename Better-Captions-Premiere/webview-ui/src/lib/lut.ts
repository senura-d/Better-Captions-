// .cube LUTs (Adobe/Resolve format): parsing, and applying them to image
// pixels with trilinear interpolation (3D) or per-channel interpolation (1D).

export interface Lut {
  kind: "3d" | "1d";
  size: number;
  data: Float32Array; // r,g,b triples; 3D order is red fastest, then green, then blue
  min: [number, number, number];
  max: [number, number, number];
  title?: string;
}

export function parseCube(text: string): Lut {
  let size3 = 0;
  let size1 = 0;
  let title: string | undefined;
  let min: [number, number, number] = [0, 0, 0];
  let max: [number, number, number] = [1, 1, 1];
  const values: number[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const first = line.charCodeAt(0);
    // Data lines start with a digit, sign or dot; everything else is a keyword.
    if ((first >= 48 && first <= 57) || first === 45 || first === 46 || first === 43) {
      const parts = line.split(/\s+/);
      if (parts.length >= 3) values.push(+parts[0], +parts[1], +parts[2]);
      continue;
    }
    const [key, ...rest] = line.split(/\s+/);
    const upper = key.toUpperCase();
    if (upper === "LUT_3D_SIZE") size3 = parseInt(rest[0], 10);
    else if (upper === "LUT_1D_SIZE") size1 = parseInt(rest[0], 10);
    else if (upper === "TITLE") title = rest.join(" ").replace(/^"|"$/g, "");
    else if (upper === "DOMAIN_MIN") min = [+rest[0], +rest[1], +rest[2]];
    else if (upper === "DOMAIN_MAX") max = [+rest[0], +rest[1], +rest[2]];
  }

  const kind = size3 ? "3d" : "1d";
  const size = size3 || size1;
  const expected = kind === "3d" ? size * size * size * 3 : size * 3;
  // 3D LUTs are rarely above 65 points per axis; 1D LUTs can have thousands of entries.
  if (!size || size < 2 || size > (kind === "3d" ? 256 : 65536)) {
    throw new Error("This doesn't look like a .cube LUT (no valid LUT size).");
  }
  if (values.length < expected) throw new Error(`This LUT is incomplete (${values.length / 3} of ${expected / 3} entries).`);
  return { kind, size, data: Float32Array.from(values.slice(0, expected)), min, max, title };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Applies `lut` to RGBA pixels in place. `intensity` blends with the original (0..1).
export function applyLut(pixels: Uint8ClampedArray, lut: Lut, intensity = 1) {
  const { size, data, min, max } = lut;
  const n = size - 1;
  const k = Math.max(0, Math.min(1, intensity));
  const scale = [n / (max[0] - min[0] || 1), n / (max[1] - min[1] || 1), n / (max[2] - min[2] || 1)];

  if (lut.kind === "1d") {
    for (let p = 0; p < pixels.length; p += 4) {
      for (let c = 0; c < 3; c++) {
        const v = pixels[p + c] / 255;
        const x = clamp01((v - min[c]) / (max[c] - min[c] || 1)) * n;
        const i = Math.min(Math.floor(x), n - 1);
        const f = x - i;
        const out = data[i * 3 + c] * (1 - f) + data[(i + 1) * 3 + c] * f;
        pixels[p + c] = Math.round((v + (out - v) * k) * 255);
      }
    }
    return;
  }

  const s2 = size * size;
  for (let p = 0; p < pixels.length; p += 4) {
    const r = pixels[p] / 255;
    const g = pixels[p + 1] / 255;
    const b = pixels[p + 2] / 255;
    const x = Math.min(Math.max((r - min[0]) * scale[0], 0), n);
    const y = Math.min(Math.max((g - min[1]) * scale[1], 0), n);
    const z = Math.min(Math.max((b - min[2]) * scale[2], 0), n);
    const x0 = Math.min(x | 0, n - 1), y0 = Math.min(y | 0, n - 1), z0 = Math.min(z | 0, n - 1);
    const fx = x - x0, fy = y - y0, fz = z - z0;
    const i000 = (x0 + y0 * size + z0 * s2) * 3;
    const i100 = i000 + 3;
    const i010 = i000 + size * 3;
    const i110 = i010 + 3;
    const i001 = i000 + s2 * 3;
    const i101 = i001 + 3;
    const i011 = i001 + size * 3;
    const i111 = i011 + 3;
    for (let c = 0; c < 3; c++) {
      const c00 = data[i000 + c] + (data[i100 + c] - data[i000 + c]) * fx;
      const c10 = data[i010 + c] + (data[i110 + c] - data[i010 + c]) * fx;
      const c01 = data[i001 + c] + (data[i101 + c] - data[i001 + c]) * fx;
      const c11 = data[i011 + c] + (data[i111 + c] - data[i011 + c]) * fx;
      const c0 = c00 + (c10 - c00) * fy;
      const c1 = c01 + (c11 - c01) * fy;
      const out = c0 + (c1 - c0) * fz;
      const orig = c === 0 ? r : c === 1 ? g : b;
      pixels[p + c] = Math.round(clamp01(orig + (out - orig) * k) * 255);
    }
  }
}
