/**
 * Escape closes the topmost popup — one rule for every dialog in the admin (2026-11-19).
 *
 * Every popup is a backdrop (`.modal-backdrop` / `.fm-backdrop`) whose click closes it, so Escape
 * clicks the last backdrop in the document: the one drawn on top. A control that uses Escape for
 * itself (a suggestion list inside a dialog) calls preventDefault and keeps the dialog open.
 */
const BACKDROPS = ".modal-backdrop, .fm-backdrop";

export function installEscapeClose(): void {
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
    const open = document.querySelectorAll<HTMLElement>(BACKDROPS);
    const top = open[open.length - 1];
    if (!top) return;
    e.preventDefault();
    top.click();
  });
}
