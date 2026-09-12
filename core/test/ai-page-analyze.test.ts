/** Page analysis for schema design (06-IMPL P2) — pure guards and extraction, no network */
import { describe, expect, it } from "vitest";
import {
  assertPublicHttpUrl,
  extractPageSummary,
  isThinSummary,
  renderPageSummary,
} from "../src/modules/ai/page-analyze.js";
import { ValidationError } from "../src/lib/errors.js";

describe("assertPublicHttpUrl (SSRF guard)", () => {
  it("accepts public http(s) urls", () => {
    expect(assertPublicHttpUrl("https://example.com/products").hostname).toBe("example.com");
  });
  it.each([
    "http://localhost:4001/health",
    "http://127.0.0.1/x",
    "http://10.0.0.5/",
    "http://192.168.1.10/admin",
    "http://172.20.3.4/",
    "http://169.254.169.254/latest/meta-data",
    "ftp://example.com/file",
    "not a url",
  ])("rejects %s", (url) => {
    expect(() => assertPublicHttpUrl(url)).toThrow(ValidationError);
  });
});

describe("extractPageSummary", () => {
  const html = `<!doctype html><html><head>
    <title>Industrial Camera X200</title>
    <meta name="description" content="High-speed vision camera for factory lines">
    <meta property="og:type" content="product">
    <style>.x{color:red}</style><script>evil()</script>
  </head><body>
    <h1>Camera X200</h1><h2>Specifications</h2>
    <table><tr><td>fps</td><td>240</td></tr></table>
    <ul><li>Global shutter sensor with wide dynamic range support</li></ul>
    <p>The X200 is a high-speed industrial camera designed for production line inspection.</p>
    <img src="a.jpg" alt="Front view of the camera body">
  </body></html>`;

  it("collects title, meta, headings, structure signals — and skips script/style", () => {
    const s = extractPageSummary(html, "https://example.com/x200");
    expect(s.title).toBe("Industrial Camera X200");
    expect(s.metaDescription).toContain("vision camera");
    expect(s.ogType).toBe("product");
    expect(s.headings.map((h) => h.text)).toEqual(["Camera X200", "Specifications"]);
    expect(s.hasTables).toBe(true);
    expect(s.hasLists).toBe(true);
    expect(s.imageAlts[0]).toContain("Front view");
    expect(s.textBlocks.join(" ")).not.toContain("evil");
    const rendered = renderPageSummary(s);
    expect(rendered).toContain("og:type: product");
    expect(rendered).toContain("h1: Camera X200");
  });
});

describe("isThinSummary (SPA-shell detection)", () => {
  it("flags an app shell with no real content", () => {
    const shell = extractPageSummary(
      `<html><head><title>App</title></head><body><div id="app"></div>
       <p>We're sorry but this app doesn't work properly without JavaScript enabled.</p></body></html>`,
      "https://example.com",
    );
    expect(isThinSummary(shell)).toBe(true);
  });
  it("passes a page with substantial extracted content", () => {
    const rich = extractPageSummary(
      `<html><body><h1>Guide</h1>${"<p>A reasonably long paragraph about industrial cameras and calibration workflows for factories.</p>".repeat(5)}</body></html>`,
      "https://example.com",
    );
    expect(isThinSummary(rich)).toBe(false);
  });
});
