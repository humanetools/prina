/**
 * Client half of the preview audit (§0.11 WA axis): WCAG 1.4.3 contrast over the live
 * Shadow DOM — needs computed styles, so it cannot run server-side. Emits the same
 * AuditFinding shape as core's audit.ts, with the live element attached for highlighting.
 *
 * Honesty rule: text over a background-image/gradient is statically undecidable —
 * reported as severity "manual", never a fabricated ratio.
 */
import type { AuditFinding } from "../../api/types";
import { composite, contrastRatio, parseCssColor, requiredRatio, type Rgba } from "./contrast";

export interface ClientFinding extends AuditFinding {
  el?: Element;
}

export interface ShadowAuditResult {
  findings: ClientFinding[];
  /** Text elements measured (manual/unknown included) — “0 issues out of 0 checked” is not a pass */
  checked: number;
}

/** nth-child chain of element-only indexes — same scheme as core delivery/audit.ts */
function selectorPathOf(el: Element, stopAt: Node): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== stopAt) {
    const parent: Element | null = cur.parentElement;
    const siblings = parent
      ? Array.from(parent.children)
      : Array.from((stopAt as ParentNode).children ?? []);
    const idx = siblings.indexOf(cur) + 1;
    parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${idx})`);
    cur = parent;
  }
  return parts.join(" > ");
}

interface BgResolution {
  color?: Rgba;
  unknown?: boolean;
}

/** Effective backdrop: composite background-colors up the tree; bail on images/gradients */
function resolveBackground(el: Element, root: ShadowRoot): BgResolution {
  const layers: Rgba[] = [];
  let cur: Element | null = el;
  let opaque = false;
  while (cur) {
    const style = getComputedStyle(cur);
    if (style.backgroundImage && style.backgroundImage !== "none") return { unknown: true };
    const bg = parseCssColor(style.backgroundColor);
    if (bg && bg[3] > 0) {
      layers.push(bg);
      if (bg[3] >= 1) {
        opaque = true;
        break;
      }
    }
    // parentElement is null for direct children of the shadow root — natural stop
    cur = cur.parentElement;
  }
  // Never hit an opaque layer → assume the host page paints white behind the preview
  let acc: Rgba = opaque ? layers.pop()! : [255, 255, 255, 1];
  for (let i = layers.length - 1; i >= 0; i--) acc = composite(layers[i]!, acc);
  return { color: acc };
}

function hasDirectText(el: Element): boolean {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "") return true;
  }
  return false;
}

/** Scrolls to and briefly outlines a finding's element in the preview */
export function locateFinding(root: ShadowRoot, finding: ClientFinding): void {
  const el =
    (finding.el as HTMLElement | undefined) ??
    (finding.selectorPath
      ? (root.querySelector(finding.selectorPath) as HTMLElement | null)
      : null);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  const prev = el.style.outline;
  el.style.outline = "2px solid var(--danger, #e5484d)";
  setTimeout(() => {
    el.style.outline = prev;
  }, 1600);
}

export function runShadowAudit(root: ShadowRoot): ShadowAuditResult {
  const findings: ClientFinding[] = [];
  let checked = 0;
  const unknownReported = new Set<Element>();

  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (!hasDirectText(el)) continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const fontSize = parseFloat(style.fontSize);
    if (!fontSize) continue;
    checked++;

    const fg = parseCssColor(style.color);
    if (!fg) continue;
    const bg = resolveBackground(el, root);
    const text = (el.textContent ?? "").trim().slice(0, 40);

    if (bg.unknown) {
      if (!unknownReported.has(el)) {
        unknownReported.add(el);
        findings.push({
          rule: "contrast-unknown",
          severity: "manual",
          message: `Text over an image/gradient — contrast cannot be verified automatically ("${text}")`,
          selectorPath: selectorPathOf(el, root),
          el,
        });
      }
      continue;
    }

    const effectiveFg = fg[3] < 1 ? composite(fg, bg.color!) : fg;
    const ratio = contrastRatio(effectiveFg, bg.color!);
    const required = requiredRatio(fontSize, Number(style.fontWeight) || 400);
    if (ratio < required) {
      findings.push({
        rule: "contrast",
        severity: "error",
        message: `Contrast ${ratio.toFixed(2)}:1 — WCAG AA needs ${required}:1 ("${text}")`,
        selectorPath: selectorPathOf(el, root),
        snippet: `${style.color} on ${style.backgroundColor || "inherited"} @ ${Math.round(fontSize)}px`,
        el,
      });
    }
  }
  return { findings, checked };
}
