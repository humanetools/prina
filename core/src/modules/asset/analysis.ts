/**
 * DAM image analysis (§0.11 WA axis, Phase 4b) — dominant color + per-region luminance and
 * white/black text-overlay contrast, computed with sharp at upload confirm (or backfilled via
 * POST /api/assets/:id/analyze). Results merge into assets.metadata.analysis.
 *
 * sharp is a native module: loaded via dynamic import, and any load/decode failure degrades to
 * "no analysis" — asset confirm must never fail because of it.
 * Contrast math mirrors the admin's preview/contrast.ts (manual sync, like enums).
 */

export interface RegionStat {
  /** Average WCAG relative luminance 0–1 */
  luminance: number;
  /** Contrast ratio of white (#fff) text over this region */
  whiteContrast: number;
  /** Contrast ratio of black (#000) text over this region */
  blackContrast: number;
}

export interface AssetAnalysis {
  version: 1;
  /** Dominant color hex, e.g. "#1a2b3c" */
  dominant: string;
  overall: RegionStat;
  /** Thirds — text overlays usually sit in the top or bottom third */
  top: RegionStat;
  middle: RegionStat;
  bottom: RegionStat;
}

/** Max original size we are willing to decode (guard against decompression bombs) */
export const ANALYSIS_READ_BYTES = 32 * 1024 * 1024;

const SAMPLE = 64;

function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastOf(l1: number, l2: number): number {
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return round((hi + 0.05) / (lo + 0.05));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function regionStat(luminances: number[]): RegionStat {
  const avg = luminances.reduce((a, b) => a + b, 0) / Math.max(luminances.length, 1);
  return {
    luminance: round(avg),
    whiteContrast: contrastOf(1, avg),
    blackContrast: contrastOf(avg, 0),
  };
}

/** null when sharp is unavailable or the buffer cannot be decoded */
export async function tryAnalyzeImage(buffer: Buffer): Promise<AssetAnalysis | null> {
  let sharp: (typeof import("sharp"))["default"];
  try {
    sharp = (await import("sharp")).default;
  } catch {
    return null; // native module missing on this platform — analysis is optional
  }
  try {
    const { dominant } = await sharp(buffer, { limitInputPixels: 100_000_000 }).stats();
    const { data, info } = await sharp(buffer, { limitInputPixels: 100_000_000 })
      .resize(SAMPLE, SAMPLE, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const rows: number[][] = [];
    for (let y = 0; y < info.height; y++) {
      const row: number[] = [];
      for (let x = 0; x < info.width; x++) {
        const i = (y * info.width + x) * info.channels;
        row.push(relativeLuminance(data[i]!, data[i + 1]!, data[i + 2]!));
      }
      rows.push(row);
    }
    const third = Math.floor(info.height / 3);
    const flat = (r: number[][]) => r.flat();
    const hex = (n: number) => n.toString(16).padStart(2, "0");

    return {
      version: 1,
      dominant: `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`,
      overall: regionStat(flat(rows)),
      top: regionStat(flat(rows.slice(0, third))),
      middle: regionStat(flat(rows.slice(third, third * 2))),
      bottom: regionStat(flat(rows.slice(third * 2))),
    };
  } catch {
    return null; // undecodable image (corrupt/unsupported) — skip analysis, keep the asset
  }
}
