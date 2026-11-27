/**
 * Copy text to the clipboard, everywhere the admin runs.
 *
 * Order matters (found 2026-09-11): the async Clipboard API can *resolve* while the platform
 * clipboard never receives the text — seen on Wayland/WSLg browsers, where a manual select +
 * Ctrl+C works but navigator.clipboard.writeText silently drops. The selection-based
 * execCommand("copy") rides the same path as Ctrl+C, so it goes first (we are inside a user
 * gesture); the async API is the fallback for browsers that removed execCommand.
 * Resolves true only when a copy path reported success.
 */
export async function copyText(text: string): Promise<boolean> {
  if (legacyCopy(text)) return true;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    console.warn("copy failed: clipboard API rejected —", e);
  }
  return false;
}

/** Select a hidden, real textarea and issue the same copy command Ctrl+C would */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) console.warn("copy: execCommand('copy') returned false — trying the async API", { secure: window.isSecureContext });
    return ok;
  } catch (e) {
    console.warn("copy: legacy path threw — trying the async API", e);
    return false;
  }
}
