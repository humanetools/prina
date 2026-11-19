import { describe, expect, it } from "vitest";
import { attachmentDisposition } from "../src/lib/content-disposition.js";

describe("attachmentDisposition", () => {
  it("quotes a plain ASCII name and repeats it percent-encoded", () => {
    expect(attachmentDisposition("photo.png")).toBe(`attachment; filename="photo.png"; filename*=UTF-8''photo.png`);
  });
  it("keeps non-ASCII names in filename* and degrades the quoted fallback", () => {
    expect(attachmentDisposition("사진.png")).toBe(`attachment; filename="__.png"; filename*=UTF-8''%EC%82%AC%EC%A7%84.png`);
  });
  it("cannot break out of the quoted string or the header", () => {
    const value = attachmentDisposition('a".txt\r\nX-Injected: 1');
    expect(value).not.toMatch(/[\r\n]/);
    expect(value.startsWith('attachment; filename="a_.txt__X-Injected: 1"; filename*=')).toBe(true);
  });
  it("percent-encodes the characters encodeURIComponent leaves alone but RFC 5987 forbids", () => {
    expect(attachmentDisposition("it's (1)*.txt")).toContain(`filename*=UTF-8''it%27s%20%281%29%2A.txt`);
  });
  it("falls back to a placeholder when nothing printable is left", () => {
    expect(attachmentDisposition("한글")).toContain(`filename="__"`);
    expect(attachmentDisposition("   ")).toContain(`filename="download"`);
  });
});
