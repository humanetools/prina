/**
 * CSS auto-scoping (T5.2): `.price {}` → `.hub-product .price {}`
 * Prevents collisions with host-page CSS in fragment (mode ②).
 * Lenient parser — @media/@supports recurse into the body, @keyframes/@font-face etc. pass through.
 */

const RECURSE_AT = /^@(media|supports|container|layer)\b/;
const PASSTHROUGH_AT = /^@/;

export function scopeCss(css: string, scopeSelector: string): string {
  return scopeBlock(stripComments(css), scopeSelector).trim();
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function scopeBlock(css: string, scope: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const braceOpen = css.indexOf("{", i);
    if (braceOpen === -1) {
      out += css.slice(i);
      break;
    }
    const selector = css.slice(i, braceOpen).trim();
    const bodyEnd = matchBrace(css, braceOpen);
    const body = css.slice(braceOpen + 1, bodyEnd);

    if (RECURSE_AT.test(selector)) {
      out += `${selector} {\n${scopeBlock(body, scope)}\n}\n`;
    } else if (PASSTHROUGH_AT.test(selector)) {
      // @keyframes, @font-face, @import, etc. — not subject to scoping
      out += `${selector} {${body}}\n`;
    } else if (selector) {
      const scoped = selector
        .split(",")
        .map((s) => scopeSelectorPart(s.trim(), scope))
        .join(", ");
      out += `${scoped} {${body}}\n`;
    }
    i = bodyEnd + 1;
  }
  return out;
}

function scopeSelectorPart(sel: string, scope: string): string {
  if (!sel) return sel;
  // Already scoped or targets the root — leave as is
  if (sel.startsWith(scope)) return sel;
  // :root/html/body → replace with the scope root itself
  if (/^(:root|html|body)\b/.test(sel)) {
    return sel.replace(/^(:root|html|body)\b/, scope);
  }
  return `${scope} ${sel}`;
}

/** Index of the closing brace matching the opening brace at openIdx */
function matchBrace(css: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return css.length;
}
