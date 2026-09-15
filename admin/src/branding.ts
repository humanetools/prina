/**
 * White-label branding (T8.5) — reads window.__PRINA_BRANDING__ injected by
 * core when serving index.html. Prina defaults when not injected (Vite dev, unconfigured).
 * Theme tokens are injected directly by core as <style>, so only name/logo are handled here.
 */
interface InjectedBranding {
  name: string | null;
  logoUrl: string | null;
}

declare global {
  interface Window {
    __PRINA_BRANDING__?: InjectedBranding;
  }
}

const injected = typeof window !== "undefined" ? window.__PRINA_BRANDING__ : undefined;

export const branding = {
  /** Product/customer display name */
  name: injected?.name || "Prina",
  /** Logo image URL — if absent, each screen uses its default logo (initial/placeholder) */
  logoUrl: injected?.logoUrl || null,
  /** Initial logo letter for the icon bar and setup rail */
  initial: (injected?.name || "Prina").trim().charAt(0).toUpperCase() || "P",
};
