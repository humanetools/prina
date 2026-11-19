/**
 * ADMIN_EXTRA_SCRIPTS — extra `<script defer>` tags in the admin's index.html (2026-11-05).
 * A deployment can attach its own tooling to the admin (e.g. a sticky-note overlay) without a fork:
 * the env lists https URLs separated by commas or whitespace. Empty/unset = the page is untouched.
 * Only absolute https URLs are accepted; anything else is dropped (and logged by the caller).
 */

/** Parse the env value into valid https URLs (order kept, duplicates dropped) and the rejected entries */
export function parseExtraScripts(value: string | undefined): { urls: string[]; rejected: string[] } {
  const urls: string[] = [];
  const rejected: string[] = [];
  for (const raw of (value ?? "").split(/[\s,]+/)) {
    const item = raw.trim();
    if (!item) continue;
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      rejected.push(item);
      continue;
    }
    if (url.protocol !== "https:") {
      rejected.push(item);
      continue;
    }
    const href = url.toString();
    if (!urls.includes(href)) urls.push(href);
  }
  return { urls, rejected };
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Insert one `<script defer src>` per URL right before `</head>` (or at the end when there is no head) */
export function injectExtraScripts(html: string, urls: string[]): string {
  if (urls.length === 0) return html;
  const tags = urls.map((u) => `<script defer src="${escapeAttr(u)}"></script>`).join("\n");
  const at = html.search(/<\/head>/i);
  return at === -1 ? `${html}\n${tags}\n` : `${html.slice(0, at)}${tags}\n${html.slice(at)}`;
}
