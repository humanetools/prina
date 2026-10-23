import { describe, expect, it } from "vitest";
import { isJpegXl } from "../src/lib/image-sniff.js";

describe("isJpegXl", () => {
  it("detects the bare codestream and the ISOBMFF container", () => {
    expect(isJpegXl(Buffer.from([0xff, 0x0a, 0x12, 0x34]))).toBe(true);
    expect(isJpegXl(Buffer.from([0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a, 1, 2]))).toBe(true);
  });
  it("leaves other formats alone (PNG, JPEG, WebP, truncated input)", () => {
    expect(isJpegXl(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(false);
    expect(isJpegXl(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
    expect(isJpegXl(Buffer.from("RIFF....WEBPVP8 "))).toBe(false);
    expect(isJpegXl(Buffer.alloc(0))).toBe(false);
    expect(isJpegXl(Buffer.from([0xff]))).toBe(false);
  });
});
