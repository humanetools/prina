/**
 * `Content-Disposition` value that makes a browser save the response under the asset's own
 * filename (RFC 6266 / RFC 5987). Filenames are user-supplied, so the quoted ASCII fallback is
 * sanitized and the full name travels percent-encoded in `filename*` — a Korean or quoted name
 * can neither break the header nor inject a second one.
 */
export function attachmentDisposition(filename: string): string {
  // ASCII fallback for parsers without RFC 5987: drop control / non-ASCII, neutralize quote and backslash
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_").trim() || "download";
  // encodeURIComponent leaves `'()*` alone but RFC 5987 attr-char does not allow them
  const utf8 = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
