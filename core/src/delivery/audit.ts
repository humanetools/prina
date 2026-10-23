/**
 * Rendered-HTML accessibility/structure audit (§0.11 WA axis) — server side of the preview
 * audit engine. Pure function over a parse5 fragment AST; contrast (needs computed styles)
 * runs client-side in the admin, emitting the same AuditFinding shape.
 *
 * Fragment context matters: templates render into a host page, so "missing h1" is NOT a rule
 * here (the h1 usually belongs to the host) — only violations that are wrong in any host.
 */
import { parseFragment } from "parse5";
import type { AuditFinding } from "@prina/shared";

interface Parse5Node {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: Parse5Node[];
}

function attr(node: Parse5Node, name: string): string | null {
  const found = node.attrs?.find((a) => a.name === name);
  return found ? found.value : null;
}

function textContent(node: Parse5Node): string {
  if (node.nodeName === "#text") return node.value ?? "";
  return (node.childNodes ?? []).map(textContent).join("");
}

function hasDescribedImg(node: Parse5Node): boolean {
  if (node.tagName === "img" && (attr(node, "alt") ?? "") !== "") return true;
  return (node.childNodes ?? []).some(hasDescribedImg);
}

/** Opening-tag snippet for the finding list */
function snippetOf(node: Parse5Node): string {
  const attrs = (node.attrs ?? [])
    .slice(0, 3)
    .map((a) => `${a.name}="${a.value.length > 30 ? a.value.slice(0, 30) + "…" : a.value}"`)
    .join(" ");
  return `<${node.tagName}${attrs ? " " + attrs : ""}>`;
}

export function auditRenderedHtml(html: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const root = parseFragment(html) as unknown as Parse5Node;

  const headings: Array<{ level: number; path: string; snippet: string }> = [];

  const walk = (node: Parse5Node, path: string) => {
    let elementIndex = 0;
    for (const child of node.childNodes ?? []) {
      if (!child.tagName) continue;
      elementIndex++;
      const childPath = path
        ? `${path} > ${child.tagName}:nth-child(${elementIndex})`
        : `${child.tagName}:nth-child(${elementIndex})`;

      const tag = child.tagName;
      if (/^h[1-6]$/.test(tag)) {
        headings.push({ level: Number(tag[1]), path: childPath, snippet: snippetOf(child) });
      }
      if (tag === "img" && attr(child, "alt") === null) {
        findings.push({
          rule: "img-alt-missing",
          severity: "error",
          message: 'Image has no alt attribute (WCAG 1.1.1) — use alt="" only if decorative',
          selectorPath: childPath,
          snippet: snippetOf(child),
        });
      }
      if (
        tag === "a" &&
        textContent(child).trim() === "" &&
        !attr(child, "aria-label") &&
        !attr(child, "aria-labelledby") &&
        !hasDescribedImg(child)
      ) {
        findings.push({
          rule: "link-name-empty",
          severity: "error",
          message: "Link has no accessible name (WCAG 2.4.4)",
          selectorPath: childPath,
          snippet: snippetOf(child),
        });
      }
      if (
        tag === "button" &&
        textContent(child).trim() === "" &&
        !attr(child, "aria-label") &&
        !attr(child, "aria-labelledby") &&
        !hasDescribedImg(child)
      ) {
        findings.push({
          rule: "button-name-empty",
          severity: "error",
          message: "Button has no accessible name (WCAG 4.1.2)",
          selectorPath: childPath,
          snippet: snippetOf(child),
        });
      }
      if (tag === "iframe" && !attr(child, "title")) {
        findings.push({
          rule: "iframe-title-missing",
          severity: "error",
          message: "Iframe has no title (WCAG 4.1.2)",
          selectorPath: childPath,
          snippet: snippetOf(child),
        });
      }
      walk(child, childPath);
    }
  };
  walk(root, "");

  const h1s = headings.filter((h) => h.level === 1);
  if (h1s.length > 1) {
    findings.push({
      rule: "multiple-h1",
      severity: "warn",
      message: `Fragment contains ${h1s.length} <h1> elements — the host page usually owns the h1`,
      selectorPath: h1s[1]!.path,
      snippet: h1s[1]!.snippet,
    });
  }
  for (let i = 1; i < headings.length; i++) {
    const prev = headings[i - 1]!;
    const cur = headings[i]!;
    if (cur.level > prev.level + 1) {
      findings.push({
        rule: "heading-order",
        severity: "warn",
        message: `Heading level skips from h${prev.level} to h${cur.level} (WCAG 1.3.1)`,
        selectorPath: cur.path,
        snippet: cur.snippet,
      });
    }
  }

  return findings;
}
