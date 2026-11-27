/** WCAG contrast math (§0.11 WA axis) — pure function tests, no DOM needed */
import { describe, expect, it } from "vitest";
import {
  composite,
  contrastRatio,
  parseCssColor,
  relativeLuminance,
  requiredRatio,
} from "./contrast";

describe("parseCssColor", () => {
  it("parses rgb/rgba/hex/transparent", () => {
    expect(parseCssColor("rgb(255, 0, 0)")).toEqual([255, 0, 0, 1]);
    expect(parseCssColor("rgba(0, 0, 0, 0.5)")).toEqual([0, 0, 0, 0.5]);
    expect(parseCssColor("#fff")).toEqual([255, 255, 255, 1]);
    expect(parseCssColor("#1a2b3c")).toEqual([26, 43, 60, 1]);
    expect(parseCssColor("transparent")).toEqual([0, 0, 0, 0]);
    expect(parseCssColor("not-a-color")).toBeNull();
  });
});

describe("relativeLuminance / contrastRatio", () => {
  it("matches the WCAG reference values", () => {
    expect(relativeLuminance([255, 255, 255, 1])).toBeCloseTo(1, 5);
    expect(relativeLuminance([0, 0, 0, 1])).toBeCloseTo(0, 5);
    // black on white = 21:1, the maximum
    expect(contrastRatio([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 1);
    // same color = 1:1
    expect(contrastRatio([128, 128, 128, 1], [128, 128, 128, 1])).toBeCloseTo(1, 5);
    // #767676 on white is the canonical "just passes 4.5:1" gray
    expect(contrastRatio(parseCssColor("#767676")!, [255, 255, 255, 1])).toBeGreaterThan(4.5);
    expect(contrastRatio(parseCssColor("#777777")!, [255, 255, 255, 1])).toBeLessThan(4.55);
  });

  it("is symmetric", () => {
    const a = parseCssColor("#123456")!;
    const b = parseCssColor("#fedcba")!;
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });
});

describe("composite", () => {
  it("alpha-composites top over bottom", () => {
    // 50% black over white = mid gray
    const [r, g, b, a] = composite([0, 0, 0, 0.5], [255, 255, 255, 1]);
    expect(a).toBe(1);
    expect(r).toBeCloseTo(127.5, 1);
    expect(g).toBeCloseTo(127.5, 1);
    expect(b).toBeCloseTo(127.5, 1);
    // fully transparent top leaves bottom untouched
    expect(composite([255, 0, 0, 0], [10, 20, 30, 1])).toEqual([10, 20, 30, 1]);
    // opaque top hides bottom
    expect(composite([1, 2, 3, 1], [200, 200, 200, 1])).toEqual([1, 2, 3, 1]);
  });
});

describe("requiredRatio (WCAG 1.4.3 AA)", () => {
  it("uses 3:1 for large text, 4.5:1 otherwise", () => {
    expect(requiredRatio(16, 400)).toBe(4.5);
    expect(requiredRatio(23.9, 400)).toBe(4.5);
    expect(requiredRatio(24, 400)).toBe(3);
    expect(requiredRatio(18.66, 700)).toBe(3);
    expect(requiredRatio(18.66, 400)).toBe(4.5);
    expect(requiredRatio(19, 700)).toBe(3);
  });
});
