/**
 * WCAG contrast math (§0.11 WA axis) — pure functions, unit-tested.
 * Mirrors the formula used by core's DAM image analysis (manual sync, like enums).
 */
export type Rgba = [number, number, number, number];

/** getComputedStyle colors arrive as rgb()/rgba(); also accepts #hex and "transparent" */
export function parseCssColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  if (s === "transparent") return [0, 0, 0, 0];
  const fn = /^rgba?\(([^)]+)\)$/.exec(s);
  if (fn) {
    const parts = fn[1]!.split(/[,/]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 3) return null;
    const [r, g, b] = parts.slice(0, 3).map((p) => Number(p));
    const a = parts[3] !== undefined ? Number(parts[3]) : 1;
    if ([r, g, b, a].some((n) => Number.isNaN(n!))) return null;
    return [r!, g!, b!, a];
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    const h = hex[1]!;
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
      1,
    ];
  }
  return null;
}

/** Alpha compositing: top over bottom (bottom treated as the final backdrop) */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const [tr, tg, tb, ta] = top;
  const [br, bg, bb, ba] = bottom;
  const a = ta + ba * (1 - ta);
  if (a === 0) return [0, 0, 0, 0];
  return [
    (tr * ta + br * ba * (1 - ta)) / a,
    (tg * ta + bg * ba * (1 - ta)) / a,
    (tb * ta + bb * ba * (1 - ta)) / a,
    a,
  ];
}

/** WCAG relative luminance — expects an effectively opaque color */
export function relativeLuminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio (1–21) */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * WCAG 1.4.3 AA threshold — large text (≥24px, or ≥18.66px bold) needs 3:1, else 4.5:1.
 * (18.66px ≈ 14pt; 24px ≈ 18pt.)
 */
export function requiredRatio(fontSizePx: number, fontWeight: number): number {
  const large = fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
  return large ? 3 : 4.5;
}
